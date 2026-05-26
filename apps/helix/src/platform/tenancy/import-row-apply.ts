import type postgres from "postgres";
import type {
  TenantImportPlan,
  TenantImportPlanOperation,
  TenantImportPlanOperationKind,
  TenantImportPlanPostgresTable,
} from "./import-plan.js";

export type TenantImportRowApplyAction = "inserted" | "updated" | "blocked" | "noop";

export interface TenantImportRowApplyOperationInput {
  readonly operation: TenantImportPlanOperation;
  readonly rowIdRemaps?: ReadonlyMap<string, string> | undefined;
}

export interface TenantImportRowApplyOperationResult {
  readonly order: number;
  readonly kind: TenantImportPlanOperationKind;
  readonly table: TenantImportPlanPostgresTable;
  readonly sourceId: string;
  readonly targetId: string | null;
  readonly action: TenantImportRowApplyAction;
  readonly blockedReason?: string | undefined;
}

export interface TenantImportRowApplyResult {
  readonly ok: boolean;
  readonly summary: {
    readonly total: number;
    readonly inserted: number;
    readonly updated: number;
    readonly blocked: number;
    readonly noop: number;
  };
  readonly operations: readonly TenantImportRowApplyOperationResult[];
}

export interface TenantImportRowApplyStore {
  applyOperation(
    input: TenantImportRowApplyOperationInput,
  ): Promise<TenantImportRowApplyOperationResult>;
}

export async function applyTenantImportPlanRows(input: {
  readonly plan: Pick<TenantImportPlan, "operations">;
  readonly store: TenantImportRowApplyStore;
}): Promise<TenantImportRowApplyResult> {
  const rowIdRemaps = new Map<string, string>();
  const results: TenantImportRowApplyOperationResult[] = [];
  const operations = [...input.plan.operations].sort((left, right) => left.order - right.order);

  for (const operation of operations) {
    const result = await input.store.applyOperation({ operation, rowIdRemaps });
    results.push(result);
    if (result.targetId !== null && result.action !== "blocked") {
      rowIdRemaps.set(result.sourceId, result.targetId);
    }
  }

  return {
    ok: results.every((result) => result.action !== "blocked"),
    summary: {
      total: results.length,
      inserted: results.filter((result) => result.action === "inserted").length,
      updated: results.filter((result) => result.action === "updated").length,
      blocked: results.filter((result) => result.action === "blocked").length,
      noop: results.filter((result) => result.action === "noop").length,
    },
    operations: results,
  };
}

export class PostgresTenantImportRowApplyStore implements TenantImportRowApplyStore {
  constructor(private readonly sql: postgres.Sql) {}

  async applyOperation(
    input: TenantImportRowApplyOperationInput,
  ): Promise<TenantImportRowApplyOperationResult> {
    const { operation } = input;
    if (operation.action === "blocked") {
      return blocked(operation, "planned_operation_blocked");
    }
    if (!isSupportedOperation(operation)) {
      return blocked(operation, "unsupported_operation");
    }

    switch (operation.table) {
      case "admin_domains":
        return this.applyAdminDomain(operation);
      case "admin_dns_records":
        return this.applyAdminDnsRecord(operation, input.rowIdRemaps);
      case "resource_classifications":
        return this.applyResourceClassification(operation);
    }
  }

  private async applyAdminDomain(
    operation: TenantImportPlanOperation,
  ): Promise<TenantImportRowApplyOperationResult> {
    const row = operation.row;
    const idMode = operation.conflictPolicy.rowId;
    const isPrimary = domainIsPrimary(operation);
    const verificationStatus =
      stateMode(operation, "verificationStatus") === "preserve"
        ? stringField(row, "verificationStatus")
        : "pending";
    const verifiedAt =
      stateMode(operation, "verifiedAt") === "preserve"
        ? nullableStringField(row, "verifiedAt")
        : null;
    const createdBy = referenceValue(operation, "createdBy");

    if (operation.action === "update") {
      if (operation.targetId === null) {
        return blocked(operation, "missing_update_target_id");
      }
      const rows = (await this.sql`
        update admin_domains
        set domain = ${stringField(row, "domain")},
            is_primary = ${isPrimary},
            verification_status = ${verificationStatus},
            verified_at = ${verifiedAt},
            created_by = ${createdBy},
            updated_at = ${stringField(row, "updatedAt")}
        where org_id = ${operation.targetOrgId} and id = ${operation.targetId}
        returning id
      `) as unknown as readonly ReturnedIdRow[];
      const targetId = rows[0]?.id;
      if (targetId === undefined) {
        return blocked(operation, "update_target_missing");
      }
      if (isPrimary) {
        await this.sql`
          update admin_domains set is_primary = false, updated_at = now()
          where org_id = ${operation.targetOrgId} and id <> ${targetId}
        `;
      }
      return applied(operation, "updated", targetId);
    }

    const rows =
      idMode === "regenerate"
        ? ((await this.sql`
            insert into admin_domains
              (org_id, domain, is_primary, verification_status, verified_at, created_by,
               created_at, updated_at)
            values
              (${operation.targetOrgId}, ${stringField(row, "domain")}, ${isPrimary},
               ${verificationStatus}, ${verifiedAt}, ${createdBy}, ${stringField(row, "createdAt")},
               ${stringField(row, "updatedAt")})
            on conflict do nothing
            returning id
          `) as unknown as readonly ReturnedIdRow[])
        : ((await this.sql`
            insert into admin_domains
              (id, org_id, domain, is_primary, verification_status, verified_at, created_by,
               created_at, updated_at)
            values
              (${stringField(row, "id")}, ${operation.targetOrgId}, ${stringField(row, "domain")},
               ${isPrimary}, ${verificationStatus}, ${verifiedAt}, ${createdBy},
               ${stringField(row, "createdAt")}, ${stringField(row, "updatedAt")})
            on conflict do nothing
            returning id
          `) as unknown as readonly ReturnedIdRow[]);
    const targetId = rows[0]?.id;
    if (targetId === undefined) {
      return blocked(operation, "insert_conflict");
    }
    if (isPrimary) {
      await this.sql`
        update admin_domains set is_primary = false, updated_at = now()
        where org_id = ${operation.targetOrgId} and id <> ${targetId}
      `;
    }
    return applied(operation, "inserted", targetId);
  }

  private async applyAdminDnsRecord(
    operation: TenantImportPlanOperation,
    rowIdRemaps: ReadonlyMap<string, string> | undefined,
  ): Promise<TenantImportRowApplyOperationResult> {
    const row = operation.row;
    const sourceDomainId = stringField(row, "domainId");
    const remappedDomainId = rowIdRemaps?.get(sourceDomainId);
    if (
      remappedDomainId === undefined &&
      operation.conflictPolicy.references.domainId === "preserve"
    ) {
      return blocked(operation, "domain_id_remap_missing");
    }
    const domainId = remappedDomainId ?? sourceDomainId;
    if (domainId.length === 0) {
      return blocked(operation, "domain_id_remap_missing");
    }
    const status =
      stateMode(operation, "status") === "preserve" ? stringField(row, "status") : "pending";
    const observedValue =
      stateMode(operation, "observedValue") === "preserve"
        ? nullableStringField(row, "observedValue")
        : null;
    const lastCheckedAt =
      stateMode(operation, "lastCheckedAt") === "preserve"
        ? nullableStringField(row, "lastCheckedAt")
        : null;

    if (operation.action === "update") {
      if (operation.targetId === null) {
        return blocked(operation, "missing_update_target_id");
      }
      const rows = (await this.sql`
        update admin_dns_records
        set domain_id = ${domainId},
            record_type = ${stringField(row, "recordType")},
            host = ${stringField(row, "host")},
            expected_value = ${stringField(row, "expectedValue")},
            observed_value = ${observedValue},
            status = ${status},
            last_checked_at = ${lastCheckedAt},
            updated_at = ${stringField(row, "updatedAt")}
        where org_id = ${operation.targetOrgId} and id = ${operation.targetId}
        returning id
      `) as unknown as readonly ReturnedIdRow[];
      const targetId = rows[0]?.id;
      if (targetId === undefined) {
        return blocked(operation, "update_target_missing");
      }
      return applied(operation, "updated", targetId);
    }

    const existing = (await this.sql`
      select id
      from admin_dns_records
      where org_id = ${operation.targetOrgId}
        and domain_id = ${domainId}
        and record_type = ${stringField(row, "recordType")}
        and host = ${stringField(row, "host")}
      for update
    `) as unknown as readonly ReturnedIdRow[];
    if (existing.length > 0) {
      return blocked(operation, "target_natural_key_conflict");
    }

    const rows =
      operation.conflictPolicy.rowId === "regenerate"
        ? ((await this.sql`
            insert into admin_dns_records
              (org_id, domain_id, record_type, host, expected_value, observed_value, status,
               last_checked_at, created_at, updated_at)
            values
              (${operation.targetOrgId}, ${domainId}, ${stringField(row, "recordType")},
               ${stringField(row, "host")}, ${stringField(row, "expectedValue")},
               ${observedValue}, ${status}, ${lastCheckedAt}, ${stringField(row, "createdAt")},
               ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[])
        : ((await this.sql`
            insert into admin_dns_records
              (id, org_id, domain_id, record_type, host, expected_value, observed_value, status,
               last_checked_at, created_at, updated_at)
            values
              (${stringField(row, "id")}, ${operation.targetOrgId}, ${domainId},
               ${stringField(row, "recordType")}, ${stringField(row, "host")},
               ${stringField(row, "expectedValue")}, ${observedValue}, ${status},
               ${lastCheckedAt}, ${stringField(row, "createdAt")}, ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[]);
    const targetId = rows[0]?.id;
    if (targetId === undefined) {
      return blocked(operation, "insert_failed");
    }
    return applied(operation, "inserted", targetId);
  }

  private async applyResourceClassification(
    operation: TenantImportPlanOperation,
  ): Promise<TenantImportRowApplyOperationResult> {
    const row = operation.row;
    const actorId = referenceValue(operation, "actorId");
    const rows =
      operation.conflictPolicy.rowId === "regenerate"
        ? ((await this.sql`
            insert into resource_classifications
              (org_id, resource_type, resource_id, classification, source, reason, actor_id,
               created_at, updated_at)
            values
              (${operation.targetOrgId}, ${stringField(row, "resourceType")},
               ${stringField(row, "resourceId")}, ${stringField(row, "classification")},
               ${stringField(row, "source")}, ${stringField(row, "reason")}, ${actorId},
               ${stringField(row, "createdAt")}, ${stringField(row, "updatedAt")})
            on conflict (org_id, resource_type, resource_id) do update
            set classification = excluded.classification,
                source = excluded.source,
                reason = excluded.reason,
                actor_id = excluded.actor_id,
                updated_at = excluded.updated_at
            returning id
          `) as unknown as readonly ReturnedIdRow[])
        : ((await this.sql`
            insert into resource_classifications
              (id, org_id, resource_type, resource_id, classification, source, reason, actor_id,
               created_at, updated_at)
            values
              (${stringField(row, "id")}, ${operation.targetOrgId},
               ${stringField(row, "resourceType")}, ${stringField(row, "resourceId")},
               ${stringField(row, "classification")}, ${stringField(row, "source")},
               ${stringField(row, "reason")}, ${actorId}, ${stringField(row, "createdAt")},
               ${stringField(row, "updatedAt")})
            on conflict (org_id, resource_type, resource_id) do update
            set classification = excluded.classification,
                source = excluded.source,
                reason = excluded.reason,
                actor_id = excluded.actor_id,
                updated_at = excluded.updated_at
            returning id
          `) as unknown as readonly ReturnedIdRow[]);
    const targetId = rows[0]?.id;
    if (targetId === undefined) {
      return blocked(operation, "upsert_failed");
    }
    return applied(operation, operation.action === "update" ? "updated" : "inserted", targetId);
  }
}

interface ReturnedIdRow {
  readonly id: string;
}

function isSupportedOperation(operation: TenantImportPlanOperation): boolean {
  return (
    (operation.table === "admin_domains" && operation.kind === "upsert_admin_domain") ||
    (operation.table === "admin_dns_records" && operation.kind === "upsert_admin_dns_record") ||
    (operation.table === "resource_classifications" &&
      operation.kind === "upsert_resource_classification")
  );
}

function domainIsPrimary(operation: TenantImportPlanOperation): boolean {
  if (stateMode(operation, "isPrimary") === "null") {
    return false;
  }
  return operation.row.isPrimary === true;
}

function stateMode(operation: TenantImportPlanOperation, field: string): string | undefined {
  return operation.conflictPolicy.state[field];
}

function referenceValue(operation: TenantImportPlanOperation, field: string): string | null {
  if (operation.conflictPolicy.references[field] === "null") {
    return null;
  }
  return nullableStringField(operation.row, field);
}

function applied(
  operation: TenantImportPlanOperation,
  action: Exclude<TenantImportRowApplyAction, "blocked">,
  targetId: string,
): TenantImportRowApplyOperationResult {
  return {
    order: operation.order,
    kind: operation.kind,
    table: operation.table,
    sourceId: operation.sourceId,
    targetId,
    action,
  };
}

function blocked(
  operation: TenantImportPlanOperation,
  blockedReason: string,
): TenantImportRowApplyOperationResult {
  return {
    order: operation.order,
    kind: operation.kind,
    table: operation.table,
    sourceId: operation.sourceId,
    targetId: operation.targetId,
    action: "blocked",
    blockedReason,
  };
}

function stringField(row: Readonly<Record<string, unknown>>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Expected import row field ${field} to be a string.`);
  }
  return value;
}

function nullableStringField(row: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected import row field ${field} to be a nullable string.`);
  }
  return value;
}
