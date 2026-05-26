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
      case "drive_folders":
        return this.applyDriveFolder(operation, input.rowIdRemaps);
      case "objects":
        return this.applyObject(operation, input.rowIdRemaps);
      case "permissions":
        return this.applyPermission(operation, input.rowIdRemaps);
      case "drive_versions":
        return this.applyDriveVersion(operation, input.rowIdRemaps);
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

  private async applyDriveVersion(
    operation: TenantImportPlanOperation,
    rowIdRemaps: ReadonlyMap<string, string> | undefined,
  ): Promise<TenantImportRowApplyOperationResult> {
    const row = operation.row;
    const rowObjectId = stringField(row, "objectId");
    const remappedObjectId = rowIdRemaps?.get(rowObjectId);
    if (
      remappedObjectId === undefined &&
      operation.conflictPolicy.references.objectId === "preserve"
    ) {
      return blocked(operation, "object_id_remap_missing");
    }
    const objectId = remappedObjectId ?? rowObjectId;
    if (objectId.length === 0) {
      return blocked(operation, "object_id_remap_missing");
    }
    const createdByActorId = referenceValue(operation, "createdByActorId");

    if (operation.action === "update") {
      if (operation.targetId === null) {
        return blocked(operation, "missing_update_target_id");
      }
      const rows = (await this.sql`
        update drive_versions
        set object_id = ${objectId},
            version_number = ${numberField(row, "versionNumber")},
            storage_key = ${stringField(row, "storageKey")},
            mime_type = ${stringField(row, "mimeType")},
            byte_size = ${numberField(row, "byteSize")},
            sha256 = ${stringField(row, "sha256")},
            metadata = ${this.sql.json(jsonValueField(row, "metadata"))},
            created_by_actor_id = ${createdByActorId},
            created_at = ${stringField(row, "createdAt")}
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
      from drive_versions
      where org_id = ${operation.targetOrgId}
        and object_id = ${objectId}
        and version_number = ${numberField(row, "versionNumber")}
      for update
    `) as unknown as readonly ReturnedIdRow[];
    if (existing.length > 0) {
      return blocked(operation, "target_natural_key_conflict");
    }

    const rows =
      operation.conflictPolicy.rowId === "regenerate"
        ? ((await this.sql`
            insert into drive_versions
              (org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256,
               metadata, created_by_actor_id, created_at)
            values
              (${operation.targetOrgId}, ${objectId}, ${numberField(row, "versionNumber")},
               ${stringField(row, "storageKey")}, ${stringField(row, "mimeType")},
               ${numberField(row, "byteSize")}, ${stringField(row, "sha256")},
               ${this.sql.json(jsonValueField(row, "metadata"))}, ${createdByActorId},
               ${stringField(row, "createdAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[])
        : ((await this.sql`
            insert into drive_versions
              (id, org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256,
               metadata, created_by_actor_id, created_at)
            values
              (${stringField(row, "id")}, ${operation.targetOrgId}, ${objectId},
               ${numberField(row, "versionNumber")}, ${stringField(row, "storageKey")},
               ${stringField(row, "mimeType")}, ${numberField(row, "byteSize")},
               ${stringField(row, "sha256")}, ${this.sql.json(jsonValueField(row, "metadata"))},
               ${createdByActorId}, ${stringField(row, "createdAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[]);
    const targetId = rows[0]?.id;
    if (targetId === undefined) {
      return blocked(operation, "insert_failed");
    }
    return applied(operation, "inserted", targetId);
  }

  private async applyPermission(
    operation: TenantImportPlanOperation,
    rowIdRemaps: ReadonlyMap<string, string> | undefined,
  ): Promise<TenantImportRowApplyOperationResult> {
    const row = operation.row;
    const rowResourceId = stringField(row, "resourceId");
    const remappedResourceId = rowIdRemaps?.get(rowResourceId);
    if (
      remappedResourceId === undefined &&
      operation.conflictPolicy.references.resourceId === "preserve"
    ) {
      return blocked(operation, "resource_id_remap_missing");
    }
    const resourceId = remappedResourceId ?? rowResourceId;
    if (resourceId.length === 0) {
      return blocked(operation, "resource_id_remap_missing");
    }
    const actorId = referenceValue(operation, "actorId");
    if (actorId === null) {
      return blocked(operation, "actor_id_remap_missing");
    }
    const grantedByActorId = referenceValue(operation, "grantedByActorId");

    if (operation.action === "update") {
      if (operation.targetId === null) {
        return blocked(operation, "missing_update_target_id");
      }
      const rows = (await this.sql`
        update permissions
        set actor_id = ${actorId},
            resource_type = ${stringField(row, "resourceType")},
            resource_id = ${resourceId},
            role = ${stringField(row, "role")},
            granted_by_actor_id = ${grantedByActorId},
            expires_at = ${nullableStringField(row, "expiresAt")},
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
      from permissions
      where org_id = ${operation.targetOrgId}
        and resource_type = ${stringField(row, "resourceType")}
        and resource_id = ${resourceId}
        and actor_id = ${actorId}
        and role = ${stringField(row, "role")}
      for update
    `) as unknown as readonly ReturnedIdRow[];
    if (existing.length > 0) {
      return blocked(operation, "target_natural_key_conflict");
    }

    const rows =
      operation.conflictPolicy.rowId === "regenerate"
        ? ((await this.sql`
            insert into permissions
              (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id, expires_at,
               created_at, updated_at)
            values
              (${operation.targetOrgId}, ${actorId}, ${stringField(row, "resourceType")},
               ${resourceId}, ${stringField(row, "role")}, ${grantedByActorId},
               ${nullableStringField(row, "expiresAt")}, ${stringField(row, "createdAt")},
               ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[])
        : ((await this.sql`
            insert into permissions
              (id, org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id,
               expires_at, created_at, updated_at)
            values
              (${stringField(row, "id")}, ${operation.targetOrgId}, ${actorId},
               ${stringField(row, "resourceType")}, ${resourceId}, ${stringField(row, "role")},
               ${grantedByActorId}, ${nullableStringField(row, "expiresAt")},
               ${stringField(row, "createdAt")}, ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[]);
    const targetId = rows[0]?.id;
    if (targetId === undefined) {
      return blocked(operation, "insert_failed");
    }
    return applied(operation, "inserted", targetId);
  }

  private async applyDriveFolder(
    operation: TenantImportPlanOperation,
    rowIdRemaps: ReadonlyMap<string, string> | undefined,
  ): Promise<TenantImportRowApplyOperationResult> {
    const row = operation.row;
    const rowParentFolderId = nullableStringField(row, "parentFolderId");
    const remappedParentFolderId =
      rowParentFolderId === null ? null : rowIdRemaps?.get(rowParentFolderId);
    if (
      rowParentFolderId !== null &&
      remappedParentFolderId === undefined &&
      operation.conflictPolicy.references.folderId === "preserve"
    ) {
      return blocked(operation, "folder_id_remap_missing");
    }
    const parentFolderId = remappedParentFolderId ?? rowParentFolderId;
    const ownerActorId = referenceValue(operation, "ownerActorId");
    const createdByActorId = referenceValue(operation, "createdByActorId");

    if (operation.action === "update") {
      if (operation.targetId === null) {
        return blocked(operation, "missing_update_target_id");
      }
      const rows = (await this.sql`
        update drive_folders
        set name = ${stringField(row, "name")},
            parent_folder_id = ${parentFolderId},
            owner_actor_id = ${ownerActorId},
            created_by_actor_id = ${createdByActorId},
            metadata = ${this.sql.json(jsonValueField(row, "metadata"))},
            deleted_at = ${nullableStringField(row, "deletedAt")},
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
      from drive_folders
      where org_id = ${operation.targetOrgId}
        and coalesce(parent_folder_id::text, '') = coalesce(${parentFolderId}::text, '')
        and lower(name) = lower(${stringField(row, "name")})
      for update
    `) as unknown as readonly ReturnedIdRow[];
    if (existing.length > 0) {
      return blocked(operation, "target_natural_key_conflict");
    }

    const rows =
      operation.conflictPolicy.rowId === "regenerate"
        ? ((await this.sql`
            insert into drive_folders
              (org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id, metadata,
               deleted_at, created_at, updated_at)
            values
              (${operation.targetOrgId}, ${stringField(row, "name")}, ${parentFolderId},
               ${ownerActorId}, ${createdByActorId}, ${this.sql.json(jsonValueField(row, "metadata"))},
               ${nullableStringField(row, "deletedAt")}, ${stringField(row, "createdAt")},
               ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[])
        : ((await this.sql`
            insert into drive_folders
              (id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id, metadata,
               deleted_at, created_at, updated_at)
            values
              (${stringField(row, "id")}, ${operation.targetOrgId}, ${stringField(row, "name")},
               ${parentFolderId}, ${ownerActorId}, ${createdByActorId},
               ${this.sql.json(jsonValueField(row, "metadata"))},
               ${nullableStringField(row, "deletedAt")},
               ${stringField(row, "createdAt")}, ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[]);
    const targetId = rows[0]?.id;
    if (targetId === undefined) {
      return blocked(operation, "insert_failed");
    }
    return applied(operation, "inserted", targetId);
  }

  private async applyObject(
    operation: TenantImportPlanOperation,
    rowIdRemaps: ReadonlyMap<string, string> | undefined,
  ): Promise<TenantImportRowApplyOperationResult> {
    const row = operation.row;
    const ownerActorId = referenceValue(operation, "ownerActorId");
    const metadata = objectMetadataValue(operation, rowIdRemaps);
    if (metadata === null) {
      return blocked(operation, "folder_id_remap_missing");
    }

    if (operation.action === "update") {
      if (operation.targetId === null) {
        return blocked(operation, "missing_update_target_id");
      }
      const rows = (await this.sql`
        update objects
        set owner_actor_id = ${ownerActorId},
            kind = ${stringField(row, "kind")},
            storage_key = ${stringField(row, "storageKey")},
            mime_type = ${stringField(row, "mimeType")},
            byte_size = ${numberField(row, "byteSize")},
            sha256 = ${nullableStringField(row, "sha256")},
            classification = ${stringField(row, "classification")},
            metadata = ${this.sql.json(metadata)},
            deleted_at = ${nullableStringField(row, "deletedAt")},
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
      from objects
      where org_id = ${operation.targetOrgId}
        and storage_key = ${stringField(row, "storageKey")}
      for update
    `) as unknown as readonly ReturnedIdRow[];
    if (existing.length > 0) {
      return blocked(operation, "target_natural_key_conflict");
    }

    const rows =
      operation.conflictPolicy.rowId === "regenerate"
        ? ((await this.sql`
            insert into objects
              (org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256,
               classification, metadata, deleted_at, created_at, updated_at)
            values
              (${operation.targetOrgId}, ${ownerActorId}, ${stringField(row, "kind")},
               ${stringField(row, "storageKey")}, ${stringField(row, "mimeType")},
               ${numberField(row, "byteSize")}, ${nullableStringField(row, "sha256")},
               ${stringField(row, "classification")},
               ${this.sql.json(metadata)},
               ${nullableStringField(row, "deletedAt")}, ${stringField(row, "createdAt")},
               ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[])
        : ((await this.sql`
            insert into objects
              (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256,
               classification, metadata, deleted_at, created_at, updated_at)
            values
              (${stringField(row, "id")}, ${operation.targetOrgId}, ${ownerActorId},
               ${stringField(row, "kind")}, ${stringField(row, "storageKey")},
               ${stringField(row, "mimeType")}, ${numberField(row, "byteSize")},
               ${nullableStringField(row, "sha256")}, ${stringField(row, "classification")},
               ${this.sql.json(metadata)},
               ${nullableStringField(row, "deletedAt")},
               ${stringField(row, "createdAt")}, ${stringField(row, "updatedAt")})
            returning id
          `) as unknown as readonly ReturnedIdRow[]);
    const targetId = rows[0]?.id;
    if (targetId === undefined) {
      return blocked(operation, "insert_failed");
    }
    return applied(operation, "inserted", targetId);
  }
}

interface ReturnedIdRow {
  readonly id: string;
}

function isSupportedOperation(operation: TenantImportPlanOperation): boolean {
  return (
    (operation.table === "admin_domains" && operation.kind === "upsert_admin_domain") ||
    (operation.table === "admin_dns_records" && operation.kind === "upsert_admin_dns_record") ||
    (operation.table === "drive_folders" && operation.kind === "upsert_drive_folder") ||
    (operation.table === "objects" && operation.kind === "upsert_object") ||
    (operation.table === "permissions" && operation.kind === "upsert_permission") ||
    (operation.table === "drive_versions" && operation.kind === "upsert_drive_version") ||
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

function objectMetadataValue(
  operation: TenantImportPlanOperation,
  rowIdRemaps: ReadonlyMap<string, string> | undefined,
): postgres.JSONValue | null {
  const metadata = jsonRecordField(operation.row, "metadata");
  const folderId = metadata.folderId;
  if (typeof folderId !== "string" || folderId.length === 0) {
    return metadata as postgres.JSONValue;
  }
  const remappedFolderId = rowIdRemaps?.get(folderId);
  if (
    remappedFolderId === undefined &&
    operation.conflictPolicy.references.folderId === "preserve"
  ) {
    return null;
  }
  return {
    ...metadata,
    folderId: remappedFolderId ?? folderId,
  };
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

function numberField(row: Readonly<Record<string, unknown>>, field: string): number {
  const value = row[field];
  if (typeof value !== "number") {
    throw new Error(`Expected import row field ${field} to be a number.`);
  }
  return value;
}

function jsonValueField(row: Readonly<Record<string, unknown>>, field: string): postgres.JSONValue {
  const value = row[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected import row field ${field} to be a JSON object.`);
  }
  return value as postgres.JSONValue;
}

function jsonRecordField(
  row: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  const value = row[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected import row field ${field} to be a JSON object.`);
  }
  return value as Record<string, unknown>;
}
