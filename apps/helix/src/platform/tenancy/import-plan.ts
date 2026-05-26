import type { TenantExportManifest } from "./export.js";
import {
  validateTenantExportPostgresDataChunks,
  type TenantExportValidationFiles,
  type TenantExportValidationIssue,
  type TenantExportValidationResult,
} from "./export-validation.js";

export type TenantImportPlanPostgresTable =
  | "admin_domains"
  | "admin_dns_records"
  | "resource_classifications";

export type TenantImportPlanObjectBytesMode = "included" | "metadata_only";

export type TenantImportPlanIssueSeverity = "error" | "warning";

export type TenantImportPlanIssueCode =
  | "export_validation_failed"
  | "org_id_remap_required"
  | "domain_id_remap_required"
  | "principal_remap_required"
  | "resource_reference_deferred"
  | "verified_state_requires_recheck"
  | "primary_domain_conflict_check_required";

export type TenantImportPlanOperationKind =
  | "upsert_admin_domain"
  | "upsert_admin_dns_record"
  | "upsert_resource_classification";

export interface BuildTenantImportPlanInput {
  readonly manifest: TenantExportManifest;
  readonly files: TenantExportValidationFiles;
  readonly targetOrgId?: string | undefined;
  readonly targetSlug?: string | undefined;
}

export interface TenantImportPlanIssue {
  readonly severity: TenantImportPlanIssueSeverity;
  readonly code: TenantImportPlanIssueCode;
  readonly message: string;
  readonly table?: TenantImportPlanPostgresTable | undefined;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  readonly sourceId?: string | undefined;
  readonly field?: string | undefined;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly validationIssues?: readonly TenantExportValidationIssue[] | undefined;
}

export interface TenantImportPlanOperation {
  readonly order: number;
  readonly kind: TenantImportPlanOperationKind;
  readonly table: TenantImportPlanPostgresTable;
  readonly path: string;
  readonly line: number;
  readonly sourceId: string;
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly naturalKey: readonly string[];
  readonly dependsOn: readonly string[];
  readonly row: Readonly<Record<string, unknown>>;
}

export interface TenantImportPlanStep {
  readonly order: number;
  readonly kind: "postgres_rows" | "storage_objects" | "tenant_config";
  readonly label: string;
  readonly table?: TenantImportPlanPostgresTable | undefined;
  readonly path?: string | undefined;
  readonly rowCount?: number | undefined;
}

export interface TenantImportPlan {
  readonly dryRun: true;
  readonly ok: boolean;
  readonly source: {
    readonly orgId: string;
    readonly slug: string;
    readonly generatedAt: string;
  };
  readonly target: {
    readonly orgId: string;
    readonly slug?: string | undefined;
    readonly rewritesOrgId: boolean;
  };
  readonly validation: TenantExportValidationResult;
  readonly objectBytes: {
    readonly mode: TenantImportPlanObjectBytesMode;
    readonly objectCount: number;
    readonly totalKnownBytes: number;
  };
  readonly summary: {
    readonly postgresRows: number;
    readonly adminDomainRows: number;
    readonly adminDnsRecordRows: number;
    readonly resourceClassificationRows: number;
    readonly operationCount: number;
  };
  readonly steps: readonly TenantImportPlanStep[];
  readonly issues: readonly TenantImportPlanIssue[];
  readonly operations: readonly TenantImportPlanOperation[];
}

type JsonRecord = Record<string, unknown>;

interface ChunkDefinition {
  readonly table: TenantImportPlanPostgresTable;
  readonly path: string;
  readonly operationKind: TenantImportPlanOperationKind;
  readonly label: string;
}

const chunkDefinitions: readonly ChunkDefinition[] = [
  {
    table: "admin_domains",
    path: "postgres/data/chunks/admin_domains/000000.jsonl",
    operationKind: "upsert_admin_domain",
    label: "Plan admin domain rows",
  },
  {
    table: "admin_dns_records",
    path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
    operationKind: "upsert_admin_dns_record",
    label: "Plan admin DNS record rows",
  },
  {
    table: "resource_classifications",
    path: "postgres/data/chunks/resource_classifications/000000.jsonl",
    operationKind: "upsert_resource_classification",
    label: "Plan resource classification rows",
  },
];

const chunkDefinitionsByTable = new Map(chunkDefinitions.map((chunk) => [chunk.table, chunk]));

export function buildTenantImportPlan(input: BuildTenantImportPlanInput): TenantImportPlan {
  const sourceOrgId = input.manifest.org.id;
  const targetOrgId = input.targetOrgId ?? sourceOrgId;
  const validation = validateTenantExportPostgresDataChunks({
    manifest: input.manifest,
    files: input.files,
  });
  const objectBytes = {
    mode: input.manifest.objectInventory.bytesIncluded
      ? ("included" as const)
      : ("metadata_only" as const),
    objectCount: input.manifest.objectInventory.objectCount,
    totalKnownBytes: input.manifest.objectInventory.totalKnownBytes,
  };
  const base = {
    dryRun: true as const,
    source: {
      orgId: sourceOrgId,
      slug: input.manifest.org.slug,
      generatedAt: input.manifest.generatedAt,
    },
    target: {
      orgId: targetOrgId,
      ...(input.targetSlug === undefined ? {} : { slug: input.targetSlug }),
      rewritesOrgId: targetOrgId !== sourceOrgId,
    },
    validation,
    objectBytes,
  };

  if (!validation.ok) {
    const validationErrors = validation.issues.filter((issue) => issue.severity === "error");
    return {
      ...base,
      ok: false,
      summary: planSummary(validation, 0),
      steps: [],
      issues: [
        {
          severity: "error",
          code: "export_validation_failed",
          message: "Tenant export row data failed import preflight validation.",
          validationIssues: validationErrors,
        },
      ],
      operations: [],
    };
  }

  const files = normalizeFiles(input.files);
  const rowsByTable = readRowsByTable(input.manifest, files);
  const issues = buildPlanIssues({
    sourceOrgId,
    targetOrgId,
    rowsByTable,
  });
  const operations = buildOperations({
    sourceOrgId,
    targetOrgId,
    rowsByTable,
  });

  return {
    ...base,
    ok: issues.every((issue) => issue.severity !== "error"),
    summary: planSummary(validation, operations.length),
    steps: buildSteps(input.manifest, validation),
    issues,
    operations,
  };
}

export const buildTenantExportImportPlan = buildTenantImportPlan;

function planSummary(
  validation: TenantExportValidationResult,
  operationCount: number,
): TenantImportPlan["summary"] {
  const { adminDomainRows, adminDnsRecordRows, resourceClassificationRows } = validation.summary;
  return {
    postgresRows: adminDomainRows + adminDnsRecordRows + resourceClassificationRows,
    adminDomainRows,
    adminDnsRecordRows,
    resourceClassificationRows,
    operationCount,
  };
}

function buildSteps(
  manifest: TenantExportManifest,
  validation: TenantExportValidationResult,
): readonly TenantImportPlanStep[] {
  const steps: TenantImportPlanStep[] = [
    {
      order: 1,
      kind: "tenant_config",
      label: "Review tenant config snapshot for target org policy compatibility",
    },
    {
      order: 2,
      kind: "storage_objects",
      label: manifest.objectInventory.bytesIncluded
        ? "Plan object restore from included archive bytes"
        : "Plan object restore from metadata or self-fetch inventory",
    },
  ];
  let order = steps.length + 1;
  for (const chunk of manifest.postgres.rowDataChunks.chunks) {
    const definition = chunkDefinitionsByTable.get(chunk.table as TenantImportPlanPostgresTable);
    if (definition === undefined) {
      continue;
    }
    steps.push({
      order,
      kind: "postgres_rows",
      label: definition.label,
      table: definition.table,
      path: definition.path,
      rowCount: rowCountForTable(validation, definition.table),
    });
    order += 1;
  }
  return steps;
}

function rowCountForTable(
  validation: TenantExportValidationResult,
  table: TenantImportPlanPostgresTable,
): number {
  switch (table) {
    case "admin_domains":
      return validation.summary.adminDomainRows;
    case "admin_dns_records":
      return validation.summary.adminDnsRecordRows;
    case "resource_classifications":
      return validation.summary.resourceClassificationRows;
  }
}

function buildPlanIssues(input: {
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>;
}): readonly TenantImportPlanIssue[] {
  const issues: TenantImportPlanIssue[] = [];
  const domainRows = input.rowsByTable.get("admin_domains") ?? [];
  const dnsRows = input.rowsByTable.get("admin_dns_records") ?? [];
  const classificationRows = input.rowsByTable.get("resource_classifications") ?? [];

  if (input.targetOrgId !== input.sourceOrgId) {
    issues.push({
      severity: "warning",
      code: "org_id_remap_required",
      message: "Dry-run will rewrite exported row orgId values to the target org ID.",
      expected: input.targetOrgId,
      actual: input.sourceOrgId,
    });
  }

  if (dnsRows.length > 0) {
    issues.push({
      severity: "warning",
      code: "domain_id_remap_required",
      table: "admin_dns_records",
      path: tablePath("admin_dns_records"),
      field: "domainId",
      message: "DNS rows depend on admin domain ID mapping before import can apply.",
    });
  }

  if (
    domainRows.some((row) => row.createdBy !== null) ||
    classificationRows.some((row) => row.actorId !== null)
  ) {
    issues.push({
      severity: "warning",
      code: "principal_remap_required",
      message:
        "Actor references need an explicit principal remap, preserve, null, or reject policy.",
    });
  }

  if (classificationRows.length > 0) {
    issues.push({
      severity: "warning",
      code: "resource_reference_deferred",
      table: "resource_classifications",
      path: tablePath("resource_classifications"),
      message:
        "Resource classifications should apply after referenced tenant resources and resource ID remaps exist.",
    });
  }

  if (domainRows.some(hasVerifiedDomainState) || dnsRows.some(hasVerifiedDnsState)) {
    issues.push({
      severity: "warning",
      code: "verified_state_requires_recheck",
      message:
        "Verified domain and DNS state is environment-sensitive and should be rechecked or explicitly preserved.",
    });
  }

  if (domainRows.some((row) => row.isPrimary === true)) {
    issues.push({
      severity: "warning",
      code: "primary_domain_conflict_check_required",
      table: "admin_domains",
      path: tablePath("admin_domains"),
      field: "isPrimary",
      message:
        "Primary domain imports must check whether the target org already has a primary domain.",
    });
  }

  return issues;
}

function hasVerifiedDomainState(row: JsonRecord): boolean {
  return row.verificationStatus === "verified" || row.verifiedAt !== null;
}

function hasVerifiedDnsState(row: JsonRecord): boolean {
  return row.status === "verified" || row.observedValue !== null || row.lastCheckedAt !== null;
}

function buildOperations(input: {
  readonly sourceOrgId: string;
  readonly targetOrgId: string;
  readonly rowsByTable: ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]>;
}): readonly TenantImportPlanOperation[] {
  const operations: TenantImportPlanOperation[] = [];
  for (const definition of chunkDefinitions) {
    const rows = input.rowsByTable.get(definition.table) ?? [];
    rows.forEach((row, index) => {
      operations.push({
        order: operations.length + 1,
        kind: definition.operationKind,
        table: definition.table,
        path: definition.path,
        line: index + 1,
        sourceId: stringField(row, "id"),
        sourceOrgId: input.sourceOrgId,
        targetOrgId: input.targetOrgId,
        naturalKey: naturalKeyForRow(definition.table, row),
        dependsOn: dependsOnForRow(definition.table, row),
        row: {
          ...row,
          orgId: input.targetOrgId,
        },
      });
    });
  }
  return operations;
}

function naturalKeyForRow(
  table: TenantImportPlanPostgresTable,
  row: JsonRecord,
): readonly string[] {
  switch (table) {
    case "admin_domains":
      return [stringField(row, "domain").toLowerCase()];
    case "admin_dns_records":
      return [
        stringField(row, "domainId"),
        stringField(row, "recordType"),
        stringField(row, "host"),
      ];
    case "resource_classifications":
      return [stringField(row, "resourceType"), stringField(row, "resourceId")];
  }
}

function dependsOnForRow(table: TenantImportPlanPostgresTable, row: JsonRecord): readonly string[] {
  if (table === "admin_dns_records") {
    return [`admin_domains:${stringField(row, "domainId")}`];
  }
  return [];
}

function readRowsByTable(
  manifest: TenantExportManifest,
  files: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<TenantImportPlanPostgresTable, readonly JsonRecord[]> {
  const rowsByTable = new Map<TenantImportPlanPostgresTable, readonly JsonRecord[]>();
  for (const chunk of manifest.postgres.rowDataChunks.chunks) {
    const definition = chunkDefinitionsByTable.get(chunk.table as TenantImportPlanPostgresTable);
    if (definition === undefined) {
      continue;
    }
    const body = files.get(definition.path);
    if (body === undefined) {
      rowsByTable.set(definition.table, []);
      continue;
    }
    rowsByTable.set(definition.table, parseJsonl(body));
  }
  return rowsByTable;
}

function parseJsonl(body: Uint8Array): readonly JsonRecord[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (text.length === 0) {
    return [];
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return lines.map((line) => JSON.parse(line) as JsonRecord);
}

function normalizeFiles(files: TenantExportValidationFiles): ReadonlyMap<string, Uint8Array> {
  if (files instanceof Map) {
    const normalized = new Map<string, Uint8Array>();
    const mapFiles = files as ReadonlyMap<string, Uint8Array | string>;
    for (const [path, body] of mapFiles.entries()) {
      normalized.set(path, normalizeFileBody(body));
    }
    return normalized;
  }
  const normalized = new Map<string, Uint8Array>();
  for (const [path, body] of Object.entries(files) as [string, Uint8Array | string][]) {
    normalized.set(path, normalizeFileBody(body));
  }
  return normalized;
}

function normalizeFileBody(body: Uint8Array | string): Uint8Array {
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  return body;
}

function tablePath(table: TenantImportPlanPostgresTable): string {
  const definition = chunkDefinitionsByTable.get(table);
  if (definition === undefined) {
    throw new Error(`Unsupported import plan table: ${table}.`);
  }
  return definition.path;
}

function stringField(row: JsonRecord, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string after validation.`);
  }
  return value;
}
