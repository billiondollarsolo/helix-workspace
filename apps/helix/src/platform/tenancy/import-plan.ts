import type { JsonObject, JsonValue } from "@helix/sdk-types";
import type { TenantExportManifest, TenantExportPostgresDataChunkManifest } from "./export.js";
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

export interface BuildTenantImportPlanFromArchiveInput {
  readonly archive: Uint8Array;
  readonly targetOrgId?: string | undefined;
  readonly targetSlug?: string | undefined;
}

export type TenantImportArchiveReadIssueCode =
  | "invalid_tar_archive"
  | "unsafe_archive_path"
  | "duplicate_archive_entry"
  | "missing_archive_entry"
  | "invalid_archive_json"
  | "invalid_archive_manifest";

export interface TenantImportArchiveReadIssue {
  readonly severity: "error";
  readonly code: TenantImportArchiveReadIssueCode;
  readonly message: string;
  readonly path?: string | undefined;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface TenantImportArchivePlanResult {
  readonly ok: boolean;
  readonly issues: readonly TenantImportArchiveReadIssue[];
  readonly plan?: TenantImportPlan | undefined;
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

export function buildTenantImportPlanFromArchive(
  input: BuildTenantImportPlanFromArchiveInput,
): TenantImportArchivePlanResult {
  const archive = readTenantExportArchive(input.archive);
  if (archive.issues.length > 0) {
    return {
      ok: false,
      issues: archive.issues,
    };
  }
  const manifestJson = readRequiredJsonRecord(archive.entries, "manifest.json");
  const configSnapshot = readRequiredJsonRecord(archive.entries, "config-snapshot.json");
  const objectInventory = readRequiredJsonRecord(archive.entries, "objects/inventory.json");
  const rowDataChunks = readRequiredJsonRecord(
    archive.entries,
    "postgres/data/chunks/manifest.json",
  );
  const issues = [
    ...manifestJson.issues,
    ...configSnapshot.issues,
    ...objectInventory.issues,
    ...rowDataChunks.issues,
  ];
  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  const manifest = tenantExportManifestFromArchiveEntries({
    manifest: manifestJson.value,
    configSnapshot: configSnapshot.value,
    objectInventory: objectInventory.value,
    rowDataChunks: rowDataChunks.value,
  });
  if (manifest.issues.length > 0) {
    return {
      ok: false,
      issues: manifest.issues,
    };
  }

  const files = tenantExportRowChunkFilesFromArchive(archive.entries);
  const plan = buildTenantImportPlan({
    manifest: manifest.value,
    files,
    ...(input.targetOrgId === undefined ? {} : { targetOrgId: input.targetOrgId }),
    ...(input.targetSlug === undefined ? {} : { targetSlug: input.targetSlug }),
  });
  return {
    ok: plan.ok,
    issues: [],
    plan,
  };
}

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

interface ParsedTenantExportArchive {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly issues: readonly TenantImportArchiveReadIssue[];
}

interface RequiredJsonRecordResult {
  readonly value: JsonRecord;
  readonly issues: readonly TenantImportArchiveReadIssue[];
}

interface TenantExportManifestFromArchiveEntriesResult {
  readonly value: TenantExportManifest;
  readonly issues: readonly TenantImportArchiveReadIssue[];
}

function readTenantExportArchive(archive: Uint8Array): ParsedTenantExportArchive {
  const buffer = Buffer.from(archive);
  const entries = new Map<string, Uint8Array>();
  const issues: TenantImportArchiveReadIssue[] = [];
  let sawEndMarker = false;

  for (let offset = 0; offset + 512 <= buffer.byteLength; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEndMarker = true;
      break;
    }

    const path = readTarString(header, 0, 100);
    if (!isSafeArchivePath(path)) {
      issues.push({
        severity: "error",
        code: "unsafe_archive_path",
        path,
        message: "Tenant export archive entry path must be relative and normalized.",
      });
      break;
    }
    if (entries.has(path)) {
      issues.push({
        severity: "error",
        code: "duplicate_archive_entry",
        path,
        message: "Tenant export archive contains a duplicate entry.",
      });
      break;
    }

    const typeflag = header.subarray(156, 157).toString("ascii");
    if (typeflag !== "0" && typeflag !== "\0") {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entries must be regular files.",
        actual: typeflag,
      });
      break;
    }

    const magic = header.subarray(257, 263).toString("ascii");
    const version = header.subarray(263, 265).toString("ascii");
    if (magic !== "ustar\0" || version !== "00") {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry must use the ustar format.",
        expected: { magic: "ustar\\0", version: "00" },
        actual: { magic, version },
      });
      break;
    }

    if (!tarHeaderChecksumMatches(header)) {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry checksum is invalid.",
      });
      break;
    }

    const size = readTarOctal(header, 124, 12);
    if (size === null) {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry has an invalid size.",
      });
      break;
    }
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buffer.byteLength) {
      issues.push({
        severity: "error",
        code: "invalid_tar_archive",
        path,
        message: "Tenant export archive entry body is truncated.",
      });
      break;
    }

    entries.set(path, buffer.subarray(bodyStart, bodyEnd));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }

  if (!sawEndMarker && issues.length === 0) {
    issues.push({
      severity: "error",
      code: "invalid_tar_archive",
      message: "Tenant export archive is missing the tar end marker.",
    });
  }

  return {
    entries,
    issues,
  };
}

function readRequiredJsonRecord(
  entries: ReadonlyMap<string, Uint8Array>,
  path: string,
): RequiredJsonRecordResult {
  const body = entries.get(path);
  if (body === undefined) {
    return {
      value: {},
      issues: [
        {
          severity: "error",
          code: "missing_archive_entry",
          path,
          message: "Tenant export archive is missing a required metadata entry.",
        },
      ],
    };
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    if (!isJsonRecord(value)) {
      return {
        value: {},
        issues: [
          {
            severity: "error",
            code: "invalid_archive_json",
            path,
            message: "Tenant export archive metadata entry must be a JSON object.",
          },
        ],
      };
    }
    return {
      value,
      issues: [],
    };
  } catch (error) {
    return {
      value: {},
      issues: [
        {
          severity: "error",
          code: "invalid_archive_json",
          path,
          message: `Tenant export archive metadata entry is not valid JSON: ${errorMessage(
            error,
          )}.`,
        },
      ],
    };
  }
}

function tenantExportManifestFromArchiveEntries(input: {
  readonly manifest: JsonRecord;
  readonly configSnapshot: JsonRecord;
  readonly objectInventory: JsonRecord;
  readonly rowDataChunks: JsonRecord;
}): TenantExportManifestFromArchiveEntriesResult {
  const issues: TenantImportArchiveReadIssue[] = [];
  if (input.manifest.version !== 1) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest must use version 1.",
      expected: 1,
      actual: input.manifest.version,
    });
  }
  if (!isJsonRecord(input.manifest.org)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest is missing org metadata.",
    });
  }
  if (!isJsonRecord(input.manifest.postgres)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest is missing postgres metadata.",
    });
  }
  if (!isJsonRecord(input.manifest.auditLog)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "manifest.json",
      message: "Tenant export archive manifest is missing audit summary metadata.",
    });
  }
  if (!isTenantExportObjectInventory(input.objectInventory)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "objects/inventory.json",
      message: "Tenant export object inventory has an invalid shape.",
    });
  }
  if (!isTenantExportPostgresDataChunkManifest(input.rowDataChunks)) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "postgres/data/chunks/manifest.json",
      message: "Tenant export row chunk manifest has an invalid shape.",
    });
  }
  if (
    isJsonRecord(input.manifest.postgres) &&
    isJsonRecord(input.manifest.postgres.rowDataChunks) &&
    JSON.stringify(input.manifest.postgres.rowDataChunks) !== JSON.stringify(input.rowDataChunks)
  ) {
    issues.push({
      severity: "error",
      code: "invalid_archive_manifest",
      path: "postgres/data/chunks/manifest.json",
      message: "Tenant export row chunk manifest entry must match manifest.json metadata.",
    });
  }
  if (issues.length > 0) {
    return {
      value: emptyTenantExportManifest(),
      issues,
    };
  }

  const org = input.manifest.org as JsonRecord;
  const postgres = input.manifest.postgres as JsonRecord;
  const auditLog = input.manifest.auditLog as JsonRecord;
  return {
    value: {
      version: 1,
      generatedAt: stringValue(input.manifest.generatedAt),
      org: {
        id: stringValue(org.id),
        slug: stringValue(org.slug),
        displayName: stringValue(org.displayName),
        status: stringValue(org.status),
        tier: stringValue(org.tier),
        planId: stringValue(org.planId),
        region: stringValue(org.region),
      },
      configSnapshot: {
        byoConfig: jsonObjectValue(input.configSnapshot.byoConfig),
        featureFlags: jsonObjectValue(input.configSnapshot.featureFlags),
        quotas: jsonObjectValue(input.configSnapshot.quotas),
        branding: jsonObjectValue(input.configSnapshot.branding),
      },
      objectInventory: {
        bytesIncluded: input.objectInventory.bytesIncluded === true,
        objectCount: numberValue(input.objectInventory.objectCount),
        totalKnownBytes: numberValue(input.objectInventory.totalKnownBytes),
        objects: arrayValue(input.objectInventory.objects).map((object) => ({
          storageKey: stringValue(object.storageKey),
          ...(object.byteSize === undefined ? {} : { byteSize: numberValue(object.byteSize) }),
          ...(object.sha256 === undefined ? {} : { sha256: stringValue(object.sha256) }),
        })),
      },
      postgres: {
        rowCounts: arrayValue(postgres.rowCounts).map((row) => ({
          table: stringValue(row.table),
          rowCount: numberValue(row.rowCount),
        })),
        rowDataChunks: input.rowDataChunks as unknown as TenantExportPostgresDataChunkManifest,
      },
      auditLog: {
        rowCount: numberValue(auditLog.rowCount),
        firstEntryAt: nullableStringValue(auditLog.firstEntryAt),
        lastEntryAt: nullableStringValue(auditLog.lastEntryAt),
      },
    },
    issues,
  };
}

function tenantExportRowChunkFilesFromArchive(
  entries: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, body] of entries) {
    if (path.startsWith("postgres/data/chunks/") && path.endsWith(".jsonl")) {
      files.set(path, body);
    }
  }
  return files;
}

function isTenantExportObjectInventory(value: JsonRecord): boolean {
  return (
    typeof value.bytesIncluded === "boolean" &&
    typeof value.objectCount === "number" &&
    typeof value.totalKnownBytes === "number" &&
    Array.isArray(value.objects) &&
    value.objects.every(
      (object) =>
        isJsonRecord(object) &&
        typeof object.storageKey === "string" &&
        (object.byteSize === undefined || typeof object.byteSize === "number") &&
        (object.sha256 === undefined || typeof object.sha256 === "string"),
    )
  );
}

function isTenantExportPostgresDataChunkManifest(value: JsonRecord): boolean {
  return (
    value.version === 1 &&
    value.format === "jsonl" &&
    Array.isArray(value.chunks) &&
    Array.isArray(value.includedTables) &&
    Array.isArray(value.excludedTables) &&
    Array.isArray(value.notes)
  );
}

function isSafeArchivePath(path: string): boolean {
  return (
    path.length > 0 &&
    !containsControlCharacter(path) &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0 && code <= 31) {
      return true;
    }
  }
  return false;
}

function readTarString(header: Buffer, offset: number, length: number): string {
  return header
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/u, "");
}

function readTarOctal(header: Buffer, offset: number, length: number): number | null {
  const value = header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/u, "")
    .trim();
  if (value.length === 0 || !/^[0-7]+$/u.test(value)) {
    return null;
  }
  return Number.parseInt(value, 8);
}

function tarHeaderChecksumMatches(header: Buffer): boolean {
  const expected = readTarOctal(header, 148, 8);
  if (expected === null) {
    return false;
  }
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return actual === expected;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jsonObjectValue(value: unknown): JsonObject {
  return isJsonRecord(value) && isJsonValue(value) ? value : {};
}

function arrayValue(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter(isJsonRecord) : [];
}

function emptyTenantExportManifest(): TenantExportManifest {
  return {
    version: 1,
    generatedAt: "",
    org: {
      id: "",
      slug: "",
      displayName: "",
      status: "",
      tier: "",
      planId: "",
      region: "",
    },
    configSnapshot: {
      byoConfig: {},
      featureFlags: {},
      quotas: {},
      branding: {},
    },
    objectInventory: {
      bytesIncluded: false,
      objectCount: 0,
      totalKnownBytes: 0,
      objects: [],
    },
    postgres: {
      rowCounts: [],
      rowDataChunks: {
        version: 1,
        format: "jsonl",
        chunks: [],
        includedTables: [],
        excludedTables: [],
        notes: [],
      },
    },
    auditLog: {
      rowCount: 0,
      firstEntryAt: null,
      lastEntryAt: null,
    },
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isJsonRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
