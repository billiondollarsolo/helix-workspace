import { createHash } from "node:crypto";
import type {
  TenantExportManifest,
  TenantExportPostgresDataChunk,
  TenantExportPostgresDataChunkManifest,
} from "./export.js";

export type TenantExportValidationIssueSeverity = "error" | "warning";

export type TenantExportValidationIssueCode =
  | "unsupported_manifest_version"
  | "unsupported_chunk_format"
  | "unexpected_table"
  | "missing_chunk_file"
  | "unexpected_chunk_file"
  | "chunk_digest_mismatch"
  | "chunk_size_mismatch"
  | "chunk_row_count_mismatch"
  | "invalid_jsonl"
  | "invalid_row_shape"
  | "org_id_mismatch"
  | "invalid_timestamp"
  | "duplicate_primary_domain"
  | "duplicate_domain"
  | "duplicate_drive_folder"
  | "duplicate_object_storage_key"
  | "duplicate_permission"
  | "duplicate_drive_version"
  | "duplicate_resource_classification"
  | "missing_domain_reference"
  | "missing_folder_reference"
  | "missing_object_reference"
  | "invalid_chunk_order";

export interface TenantExportValidationIssue {
  readonly severity: TenantExportValidationIssueSeverity;
  readonly code: TenantExportValidationIssueCode;
  readonly path: string;
  readonly message: string;
  readonly table?: TenantExportSupportedPostgresDataChunkTable | undefined;
  readonly line?: number | undefined;
  readonly field?: string | undefined;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface TenantExportValidationResult {
  readonly ok: boolean;
  readonly issues: readonly TenantExportValidationIssue[];
  readonly summary: {
    readonly adminDomainRows: number;
    readonly adminDnsRecordRows: number;
    readonly driveFolderRows: number;
    readonly objectRows: number;
    readonly permissionRows: number;
    readonly driveVersionRows: number;
    readonly resourceClassificationRows: number;
  };
}

export type TenantExportValidationFiles =
  | ReadonlyMap<string, Uint8Array | string>
  | Record<string, Uint8Array | string>;

export interface ValidateTenantExportPostgresDataChunksInput {
  readonly manifest: TenantExportManifest | TenantExportPostgresDataChunkManifest;
  readonly files: TenantExportValidationFiles;
  readonly expectedOrgId?: string | undefined;
}

type TenantExportSupportedPostgresDataChunkTable =
  | "admin_domains"
  | "admin_dns_records"
  | "drive_folders"
  | "objects"
  | "permissions"
  | "drive_versions"
  | "resource_classifications";

type JsonRecord = Record<string, unknown>;

interface SupportedChunkDefinition {
  readonly table: TenantExportSupportedPostgresDataChunkTable;
  readonly path: string;
  readonly orderBy: readonly string[];
  readonly fields: readonly string[];
}

const supportedChunks: readonly SupportedChunkDefinition[] = [
  {
    table: "admin_domains",
    path: "postgres/data/chunks/admin_domains/000000.jsonl",
    orderBy: ["lower(domain)", "created_at", "id"],
    fields: [
      "id",
      "orgId",
      "domain",
      "isPrimary",
      "verificationStatus",
      "verifiedAt",
      "createdBy",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    table: "admin_dns_records",
    path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
    orderBy: ["domain_id", "record_type", "host", "id"],
    fields: [
      "id",
      "orgId",
      "domainId",
      "recordType",
      "host",
      "expectedValue",
      "observedValue",
      "status",
      "lastCheckedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    table: "drive_folders",
    path: "postgres/data/chunks/drive_folders/000000.jsonl",
    orderBy: ["path(name,id)"],
    fields: [
      "id",
      "orgId",
      "name",
      "parentFolderId",
      "ownerActorId",
      "createdByActorId",
      "metadata",
      "deletedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    table: "objects",
    path: "postgres/data/chunks/objects/000000.jsonl",
    orderBy: ["kind", "storage_key", "id"],
    fields: [
      "id",
      "orgId",
      "ownerActorId",
      "kind",
      "storageKey",
      "mimeType",
      "byteSize",
      "sha256",
      "classification",
      "metadata",
      "deletedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    table: "permissions",
    path: "postgres/data/chunks/permissions/000000.jsonl",
    orderBy: ["resource_type", "resource_id", "actor_id", "role", "id"],
    fields: [
      "id",
      "orgId",
      "actorId",
      "resourceType",
      "resourceId",
      "role",
      "grantedByActorId",
      "expiresAt",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    table: "drive_versions",
    path: "postgres/data/chunks/drive_versions/000000.jsonl",
    orderBy: ["object_id", "version_number", "id"],
    fields: [
      "id",
      "orgId",
      "objectId",
      "versionNumber",
      "storageKey",
      "mimeType",
      "byteSize",
      "sha256",
      "metadata",
      "createdByActorId",
      "createdAt",
    ],
  },
  {
    table: "resource_classifications",
    path: "postgres/data/chunks/resource_classifications/000000.jsonl",
    orderBy: ["resource_type", "resource_id", "id"],
    fields: [
      "id",
      "orgId",
      "resourceType",
      "resourceId",
      "classification",
      "source",
      "reason",
      "actorId",
      "createdAt",
      "updatedAt",
    ],
  },
];

const supportedChunksByTable = new Map(supportedChunks.map((chunk) => [chunk.table, chunk]));
const supportedChunksByPath = new Map(supportedChunks.map((chunk) => [chunk.path, chunk]));
const supportedChunkTables = new Set(supportedChunks.map((chunk) => chunk.table));
const supportedChunkPaths = new Set(supportedChunks.map((chunk) => chunk.path));
const verificationStatuses = new Set(["verified", "pending", "failed"]);
const dnsRecordTypes = new Set(["MX", "SPF", "DKIM", "DMARC", "TXT", "CNAME", "A"]);
const objectKinds = new Set(["file", "mail_attachment", "document", "recording", "other"]);
const dataClassifications = new Set(["public", "standard", "confidential", "restricted"]);
const classificationSources = new Set(["default", "explicit", "label", "folder", "heuristic"]);
const permissionResourceTypes = new Set(["object", "drive_folder"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/iu;
const domainPattern = /^[a-z0-9.-]+$/iu;

export function validateTenantExportPostgresDataChunks(
  input: ValidateTenantExportPostgresDataChunksInput,
): TenantExportValidationResult {
  const issues: TenantExportValidationIssue[] = [];
  const manifest = extractChunkManifest(input.manifest);
  const expectedOrgId = input.expectedOrgId ?? extractManifestOrgId(input.manifest);
  const files = normalizeFiles(input.files);
  const declaredPaths = new Set<string>();
  const rowsByTable = new Map<TenantExportSupportedPostgresDataChunkTable, JsonRecord[]>();

  if ((manifest as { readonly version?: unknown }).version !== 1) {
    issues.push({
      severity: "error",
      code: "unsupported_manifest_version",
      path: "postgres/data/chunks/manifest.json",
      message: "Tenant export row chunk manifest must use version 1.",
      expected: 1,
      actual: (manifest as { readonly version?: unknown }).version,
    });
  }
  if ((manifest as { readonly format?: unknown }).format !== "jsonl") {
    issues.push({
      severity: "error",
      code: "unsupported_chunk_format",
      path: "postgres/data/chunks/manifest.json",
      message: "Tenant export row chunks must use jsonl format.",
      expected: "jsonl",
      actual: (manifest as { readonly format?: unknown }).format,
    });
  }

  validateIncludedTables(manifest, issues);

  for (const chunk of manifest.chunks) {
    const definition = supportedChunksByTable.get(
      chunk.table as TenantExportSupportedPostgresDataChunkTable,
    );
    if (definition === undefined) {
      issues.push({
        severity: "error",
        code: "unexpected_table",
        path: chunk.path,
        message: `Unsupported tenant export row chunk table: ${chunk.table}.`,
        actual: chunk.table,
      });
      continue;
    }

    if (chunk.path !== definition.path) {
      issues.push({
        severity: "error",
        code: "unexpected_chunk_file",
        path: chunk.path,
        table: definition.table,
        message: `Unexpected chunk path for ${definition.table}.`,
        expected: definition.path,
        actual: chunk.path,
      });
    }

    if (!arraysEqual(chunk.orderBy, definition.orderBy)) {
      issues.push({
        severity: "error",
        code: "invalid_chunk_order",
        path: chunk.path,
        table: definition.table,
        message: `Unexpected orderBy metadata for ${definition.table}.`,
        expected: definition.orderBy,
        actual: chunk.orderBy,
      });
    }

    if (declaredPaths.has(chunk.path)) {
      issues.push({
        severity: "error",
        code: "unexpected_chunk_file",
        path: chunk.path,
        table: definition.table,
        message: "Duplicate row chunk path in manifest.",
      });
    }
    declaredPaths.add(chunk.path);

    const body = files.get(chunk.path);
    if (body === undefined) {
      issues.push({
        severity: "error",
        code: "missing_chunk_file",
        path: chunk.path,
        table: definition.table,
        message: "Manifest declares a row chunk file that is missing from the archive.",
      });
      continue;
    }

    validateChunkBytes(chunk, body, issues, definition);
    const rows = parseJsonlRows(body, chunk.path, definition.table, issues);
    rowsByTable.set(definition.table, rows);
    validateRowCount(chunk, rows, issues, definition);
    validateRowShapes(rows, definition, expectedOrgId, issues);
    validateDeterministicRowOrder(rows, definition, chunk.path, issues);
  }

  for (const path of files.keys()) {
    if (path.startsWith("postgres/data/chunks/") && path.endsWith(".jsonl")) {
      const definition = supportedChunksByPath.get(path);
      if (!declaredPaths.has(path) || definition === undefined || !supportedChunkPaths.has(path)) {
        issues.push({
          severity: "error",
          code: "unexpected_chunk_file",
          path,
          ...(definition === undefined ? {} : { table: definition.table }),
          message: "Archive contains an undeclared or unsupported tenant export row chunk file.",
        });
      }
    }
  }

  validateDomainRows(rowsByTable.get("admin_domains") ?? [], expectedOrgId, issues);
  validateDnsRows(rowsByTable, expectedOrgId, issues);
  validateDriveFolderRows(rowsByTable.get("drive_folders") ?? [], issues);
  validateObjectRows(rowsByTable, issues);
  validatePermissionRows(rowsByTable, issues);
  validateDriveVersionRows(rowsByTable, issues);
  validateResourceClassificationRows(rowsByTable.get("resource_classifications") ?? [], issues);

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
    summary: {
      adminDomainRows: rowsByTable.get("admin_domains")?.length ?? 0,
      adminDnsRecordRows: rowsByTable.get("admin_dns_records")?.length ?? 0,
      driveFolderRows: rowsByTable.get("drive_folders")?.length ?? 0,
      objectRows: rowsByTable.get("objects")?.length ?? 0,
      permissionRows: rowsByTable.get("permissions")?.length ?? 0,
      driveVersionRows: rowsByTable.get("drive_versions")?.length ?? 0,
      resourceClassificationRows: rowsByTable.get("resource_classifications")?.length ?? 0,
    },
  };
}

function extractChunkManifest(
  manifest: TenantExportManifest | TenantExportPostgresDataChunkManifest,
): TenantExportPostgresDataChunkManifest {
  if ("postgres" in manifest) {
    return manifest.postgres.rowDataChunks;
  }
  return manifest;
}

function extractManifestOrgId(
  manifest: TenantExportManifest | TenantExportPostgresDataChunkManifest,
): string | undefined {
  if ("org" in manifest) {
    return manifest.org.id;
  }
  return undefined;
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

function validateIncludedTables(
  manifest: TenantExportPostgresDataChunkManifest,
  issues: TenantExportValidationIssue[],
): void {
  const chunkTables = manifest.chunks.map((chunk) => chunk.table);
  const includedTables = manifest.includedTables;

  for (const table of includedTables) {
    if (!supportedChunkTables.has(table as TenantExportSupportedPostgresDataChunkTable)) {
      issues.push({
        severity: "error",
        code: "unexpected_table",
        path: "postgres/data/chunks/manifest.json",
        message: `Unsupported tenant export row chunk table: ${table}.`,
        actual: table,
      });
    }
  }

  if (!arraysEqual(includedTables, chunkTables)) {
    issues.push({
      severity: "error",
      code: "unexpected_table",
      path: "postgres/data/chunks/manifest.json",
      message: "includedTables must match the row chunk table order exactly.",
      expected: chunkTables,
      actual: includedTables,
    });
  }

  if (new Set(includedTables).size !== includedTables.length) {
    issues.push({
      severity: "error",
      code: "unexpected_table",
      path: "postgres/data/chunks/manifest.json",
      message: "includedTables contains duplicate table names.",
      actual: includedTables,
    });
  }
}

function validateChunkBytes(
  chunk: TenantExportPostgresDataChunk,
  body: Uint8Array,
  issues: TenantExportValidationIssue[],
  definition: SupportedChunkDefinition,
): void {
  if (chunk.byteSize !== body.byteLength) {
    issues.push({
      severity: "error",
      code: "chunk_size_mismatch",
      path: chunk.path,
      table: definition.table,
      message: "Row chunk byte size does not match the manifest.",
      expected: chunk.byteSize,
      actual: body.byteLength,
    });
  }

  const sha256 = createHash("sha256").update(body).digest("hex");
  if (chunk.sha256 !== sha256) {
    issues.push({
      severity: "error",
      code: "chunk_digest_mismatch",
      path: chunk.path,
      table: definition.table,
      message: "Row chunk SHA-256 digest does not match the manifest.",
      expected: chunk.sha256,
      actual: sha256,
    });
  }
}

function parseJsonlRows(
  body: Uint8Array,
  path: string,
  table: TenantExportSupportedPostgresDataChunkTable,
  issues: TenantExportValidationIssue[],
): JsonRecord[] {
  const text = decodeUtf8(body, path, table, issues);
  if (text === null || text.length === 0) {
    return [];
  }

  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const rows: JsonRecord[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.length === 0) {
      issues.push({
        severity: "error",
        code: "invalid_jsonl",
        path,
        table,
        line: lineNumber,
        message: "Row chunk JSONL must not contain blank lines.",
      });
      return;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isJsonRecord(parsed)) {
        issues.push({
          severity: "error",
          code: "invalid_jsonl",
          path,
          table,
          line: lineNumber,
          message: "Row chunk JSONL lines must be JSON objects.",
        });
        return;
      }
      rows.push(parsed);
    } catch (error) {
      issues.push({
        severity: "error",
        code: "invalid_jsonl",
        path,
        table,
        line: lineNumber,
        message: `Row chunk JSONL line is not valid JSON: ${errorMessage(error)}.`,
      });
    }
  });
  return rows;
}

function decodeUtf8(
  body: Uint8Array,
  path: string,
  table: TenantExportSupportedPostgresDataChunkTable,
  issues: TenantExportValidationIssue[],
): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    issues.push({
      severity: "error",
      code: "invalid_jsonl",
      path,
      table,
      message: "Row chunk file must be valid UTF-8.",
    });
    return null;
  }
}

function validateRowCount(
  chunk: TenantExportPostgresDataChunk,
  rows: readonly JsonRecord[],
  issues: TenantExportValidationIssue[],
  definition: SupportedChunkDefinition,
): void {
  if (chunk.rowCount !== rows.length) {
    issues.push({
      severity: "error",
      code: "chunk_row_count_mismatch",
      path: chunk.path,
      table: definition.table,
      message: "Row chunk row count does not match parsed JSONL rows.",
      expected: chunk.rowCount,
      actual: rows.length,
    });
  }
}

function validateRowShapes(
  rows: readonly JsonRecord[],
  definition: SupportedChunkDefinition,
  expectedOrgId: string | undefined,
  issues: TenantExportValidationIssue[],
): void {
  const expectedFields = new Set(definition.fields);
  rows.forEach((row, index) => {
    const actualFields = Object.keys(row).sort();
    const sortedExpectedFields = [...definition.fields].sort();
    if (!arraysEqual(actualFields, sortedExpectedFields)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: definition.path,
        table: definition.table,
        line: index + 1,
        message: `Unexpected row shape for ${definition.table}.`,
        expected: sortedExpectedFields,
        actual: actualFields,
      });
    }

    for (const field of Object.keys(row)) {
      if (!expectedFields.has(field)) {
        issues.push({
          severity: "error",
          code: "invalid_row_shape",
          path: definition.path,
          table: definition.table,
          line: index + 1,
          field,
          message: `Unsupported field in ${definition.table} row.`,
        });
      }
    }

    const orgId = row.orgId;
    if (typeof orgId !== "string" || !isUuid(orgId)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: definition.path,
        table: definition.table,
        line: index + 1,
        field: "orgId",
        message: "Row orgId must be a UUID string.",
        actual: orgId,
      });
    } else if (expectedOrgId !== undefined && orgId !== expectedOrgId) {
      issues.push({
        severity: "error",
        code: "org_id_mismatch",
        path: definition.path,
        table: definition.table,
        line: index + 1,
        field: "orgId",
        message: "Row orgId does not match the exported org.",
        expected: expectedOrgId,
        actual: orgId,
      });
    }
  });
}

function validateDomainRows(
  rows: readonly JsonRecord[],
  expectedOrgId: string | undefined,
  issues: TenantExportValidationIssue[],
): void {
  const domains = new Set<string>();
  let primaryCount = 0;
  rows.forEach((row, index) => {
    const line = index + 1;
    validateUuidField(row, "id", "admin_domains", line, issues);
    validateUuidField(row, "createdBy", "admin_domains", line, issues, { nullable: true });
    validateTimestampField(row, "createdAt", "admin_domains", line, issues);
    validateTimestampField(row, "updatedAt", "admin_domains", line, issues);
    validateTimestampField(row, "verifiedAt", "admin_domains", line, issues, { nullable: true });

    if (typeof row.domain !== "string" || !isDomain(row.domain)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("admin_domains")?.path ?? "",
        table: "admin_domains",
        line,
        field: "domain",
        message: "Domain row domain must be a valid domain string.",
        actual: row.domain,
      });
    } else {
      const normalized = row.domain.toLowerCase();
      if (domains.has(normalized)) {
        issues.push({
          severity: "error",
          code: "duplicate_domain",
          path: supportedChunksByTable.get("admin_domains")?.path ?? "",
          table: "admin_domains",
          line,
          field: "domain",
          message: "Domain rows must not contain duplicate domains for the same org.",
          actual: row.domain,
        });
      }
      domains.add(normalized);
    }

    if (typeof row.isPrimary !== "boolean") {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("admin_domains")?.path ?? "",
        table: "admin_domains",
        line,
        field: "isPrimary",
        message: "Domain row isPrimary must be boolean.",
        actual: row.isPrimary,
      });
    } else if (row.isPrimary) {
      primaryCount += 1;
    }

    if (
      typeof row.verificationStatus !== "string" ||
      !verificationStatuses.has(row.verificationStatus)
    ) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("admin_domains")?.path ?? "",
        table: "admin_domains",
        line,
        field: "verificationStatus",
        message: "Domain row verificationStatus is not supported.",
        actual: row.verificationStatus,
      });
    }

    if (expectedOrgId !== undefined && row.orgId !== expectedOrgId) {
      return;
    }
  });

  if (primaryCount > 1) {
    issues.push({
      severity: "error",
      code: "duplicate_primary_domain",
      path: supportedChunksByTable.get("admin_domains")?.path ?? "",
      table: "admin_domains",
      message: "At most one admin domain may be primary in an import set.",
      actual: primaryCount,
    });
  }
}

function validateDnsRows(
  rowsByTable: ReadonlyMap<TenantExportSupportedPostgresDataChunkTable, readonly JsonRecord[]>,
  _expectedOrgId: string | undefined,
  issues: TenantExportValidationIssue[],
): void {
  const domains = rowsByTable.get("admin_domains") ?? [];
  const dnsRows = rowsByTable.get("admin_dns_records") ?? [];
  const domainIds = new Set(
    domains.map((row) => row.id).filter((id): id is string => typeof id === "string"),
  );
  const dnsKeys = new Set<string>();

  dnsRows.forEach((row, index) => {
    const line = index + 1;
    validateUuidField(row, "id", "admin_dns_records", line, issues);
    validateUuidField(row, "domainId", "admin_dns_records", line, issues);
    validateTimestampField(row, "createdAt", "admin_dns_records", line, issues);
    validateTimestampField(row, "updatedAt", "admin_dns_records", line, issues);
    validateTimestampField(row, "lastCheckedAt", "admin_dns_records", line, issues, {
      nullable: true,
    });

    if (typeof row.domainId === "string" && !domainIds.has(row.domainId)) {
      issues.push({
        severity: "error",
        code: "missing_domain_reference",
        path: supportedChunksByTable.get("admin_dns_records")?.path ?? "",
        table: "admin_dns_records",
        line,
        field: "domainId",
        message: "DNS row domainId must reference an exported admin_domains row.",
        actual: row.domainId,
      });
    }

    if (typeof row.recordType !== "string" || !dnsRecordTypes.has(row.recordType)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("admin_dns_records")?.path ?? "",
        table: "admin_dns_records",
        line,
        field: "recordType",
        message: "DNS row recordType is not supported.",
        actual: row.recordType,
      });
    }

    if (typeof row.status !== "string" || !verificationStatuses.has(row.status)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("admin_dns_records")?.path ?? "",
        table: "admin_dns_records",
        line,
        field: "status",
        message: "DNS row status is not supported.",
        actual: row.status,
      });
    }

    validateNonEmptyString(row, "host", 253, "admin_dns_records", line, issues);
    validateNonEmptyString(row, "expectedValue", 4000, "admin_dns_records", line, issues);
    validateNullableString(row, "observedValue", "admin_dns_records", line, issues);

    if (
      typeof row.domainId === "string" &&
      typeof row.recordType === "string" &&
      typeof row.host === "string"
    ) {
      const key = `${row.domainId}\u0000${row.recordType}\u0000${row.host}`;
      if (dnsKeys.has(key)) {
        issues.push({
          severity: "error",
          code: "invalid_row_shape",
          path: supportedChunksByTable.get("admin_dns_records")?.path ?? "",
          table: "admin_dns_records",
          line,
          message: "DNS rows must not duplicate domainId, recordType, and host.",
          actual: { domainId: row.domainId, recordType: row.recordType, host: row.host },
        });
      }
      dnsKeys.add(key);
    }
  });
}

function validateDeterministicRowOrder(
  rows: readonly JsonRecord[],
  definition: SupportedChunkDefinition,
  path: string,
  issues: TenantExportValidationIssue[],
): void {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const comparison = compareRowsForDefinition(definition.table, previous, current);
    if (comparison > 0) {
      issues.push({
        severity: "error",
        code: "invalid_chunk_order",
        path,
        table: definition.table,
        line: index + 1,
        message: `Rows in ${definition.table} must match the manifest order.`,
        expected: definition.orderBy,
      });
      return;
    }
  }
}

function compareRowsForDefinition(
  table: TenantExportSupportedPostgresDataChunkTable,
  previous: JsonRecord,
  current: JsonRecord,
): number {
  switch (table) {
    case "admin_domains":
      return compareDomainRows(previous, current);
    case "admin_dns_records":
      return compareDnsRows(previous, current);
    case "drive_folders":
      return compareDriveFolderRows(previous, current);
    case "objects":
      return compareObjectRows(previous, current);
    case "permissions":
      return comparePermissionRows(previous, current);
    case "drive_versions":
      return compareDriveVersionRows(previous, current);
    case "resource_classifications":
      return compareResourceClassificationRows(previous, current);
  }
}

function compareDomainRows(a: JsonRecord, b: JsonRecord): number {
  return (
    compareStrings(lowerString(a.domain), lowerString(b.domain)) ||
    compareStrings(stringValue(a.createdAt), stringValue(b.createdAt)) ||
    compareStrings(stringValue(a.id), stringValue(b.id))
  );
}

function compareDnsRows(a: JsonRecord, b: JsonRecord): number {
  return (
    compareStrings(stringValue(a.domainId), stringValue(b.domainId)) ||
    compareStrings(stringValue(a.recordType), stringValue(b.recordType)) ||
    compareStrings(stringValue(a.host), stringValue(b.host)) ||
    compareStrings(stringValue(a.id), stringValue(b.id))
  );
}

function compareDriveFolderRows(a: JsonRecord, b: JsonRecord): number {
  void a;
  void b;
  return 0;
}

function compareObjectRows(a: JsonRecord, b: JsonRecord): number {
  return (
    compareStrings(stringValue(a.kind), stringValue(b.kind)) ||
    compareStrings(stringValue(a.storageKey), stringValue(b.storageKey)) ||
    compareStrings(stringValue(a.id), stringValue(b.id))
  );
}

function comparePermissionRows(a: JsonRecord, b: JsonRecord): number {
  return (
    compareStrings(stringValue(a.resourceType), stringValue(b.resourceType)) ||
    compareStrings(stringValue(a.resourceId), stringValue(b.resourceId)) ||
    compareStrings(stringValue(a.actorId), stringValue(b.actorId)) ||
    compareStrings(stringValue(a.role), stringValue(b.role)) ||
    compareStrings(stringValue(a.id), stringValue(b.id))
  );
}

function compareDriveVersionRows(a: JsonRecord, b: JsonRecord): number {
  return (
    compareStrings(stringValue(a.objectId), stringValue(b.objectId)) ||
    compareNumbers(numberValue(a.versionNumber), numberValue(b.versionNumber)) ||
    compareStrings(stringValue(a.id), stringValue(b.id))
  );
}

function compareResourceClassificationRows(a: JsonRecord, b: JsonRecord): number {
  return (
    compareStrings(stringValue(a.resourceType), stringValue(b.resourceType)) ||
    compareStrings(stringValue(a.resourceId), stringValue(b.resourceId)) ||
    compareStrings(stringValue(a.id), stringValue(b.id))
  );
}

function validateDriveFolderRows(
  rows: readonly JsonRecord[],
  issues: TenantExportValidationIssue[],
): void {
  const folderIds = new Set(
    rows.map((row) => row.id).filter((id): id is string => typeof id === "string"),
  );
  const seenFolderIds = new Set<string>();
  const siblingKeys = new Set<string>();
  rows.forEach((row, index) => {
    const line = index + 1;
    validateUuidField(row, "id", "drive_folders", line, issues);
    validateUuidField(row, "parentFolderId", "drive_folders", line, issues, { nullable: true });
    validateUuidField(row, "ownerActorId", "drive_folders", line, issues, { nullable: true });
    validateUuidField(row, "createdByActorId", "drive_folders", line, issues, {
      nullable: true,
    });
    validateTimestampField(row, "createdAt", "drive_folders", line, issues);
    validateTimestampField(row, "updatedAt", "drive_folders", line, issues);
    validateTimestampField(row, "deletedAt", "drive_folders", line, issues, { nullable: true });
    validateNonEmptyString(row, "name", 255, "drive_folders", line, issues);

    if (!isJsonRecord(row.metadata)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("drive_folders")?.path ?? "",
        table: "drive_folders",
        line,
        field: "metadata",
        message: "Drive folder row metadata must be a JSON object.",
        actual: row.metadata,
      });
    }

    if (typeof row.id === "string") {
      if (seenFolderIds.has(row.id)) {
        issues.push({
          severity: "error",
          code: "duplicate_drive_folder",
          path: supportedChunksByTable.get("drive_folders")?.path ?? "",
          table: "drive_folders",
          line,
          field: "id",
          message: "Drive folder rows must not duplicate id values.",
          actual: row.id,
        });
      }
      seenFolderIds.add(row.id);
    }

    if (typeof row.parentFolderId === "string") {
      if (!folderIds.has(row.parentFolderId)) {
        issues.push({
          severity: "error",
          code: "missing_folder_reference",
          path: supportedChunksByTable.get("drive_folders")?.path ?? "",
          table: "drive_folders",
          line,
          field: "parentFolderId",
          message: "Drive folder parentFolderId must reference an exported drive_folders row.",
          actual: row.parentFolderId,
        });
      }
      if (!seenFolderIds.has(row.parentFolderId)) {
        issues.push({
          severity: "error",
          code: "invalid_chunk_order",
          path: supportedChunksByTable.get("drive_folders")?.path ?? "",
          table: "drive_folders",
          line,
          field: "parentFolderId",
          message: "Drive folder rows must list parent folders before child folders.",
          actual: row.parentFolderId,
        });
      }
    }

    if (
      (row.parentFolderId === null || typeof row.parentFolderId === "string") &&
      typeof row.name === "string"
    ) {
      const key = `${row.parentFolderId ?? ""}\u0000${row.name.toLowerCase()}`;
      if (siblingKeys.has(key)) {
        issues.push({
          severity: "error",
          code: "duplicate_drive_folder",
          path: supportedChunksByTable.get("drive_folders")?.path ?? "",
          table: "drive_folders",
          line,
          message: "Drive folder rows must not duplicate names under the same parent folder.",
          actual: { parentFolderId: row.parentFolderId, name: row.name },
        });
      }
      siblingKeys.add(key);
    }
  });
}

function validateObjectRows(
  rowsByTable: ReadonlyMap<TenantExportSupportedPostgresDataChunkTable, readonly JsonRecord[]>,
  issues: TenantExportValidationIssue[],
): void {
  const rows = rowsByTable.get("objects") ?? [];
  const folderIds = new Set(
    (rowsByTable.get("drive_folders") ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const storageKeys = new Set<string>();
  rows.forEach((row, index) => {
    const line = index + 1;
    validateUuidField(row, "id", "objects", line, issues);
    validateUuidField(row, "ownerActorId", "objects", line, issues, { nullable: true });
    validateTimestampField(row, "createdAt", "objects", line, issues);
    validateTimestampField(row, "updatedAt", "objects", line, issues);
    validateTimestampField(row, "deletedAt", "objects", line, issues, { nullable: true });
    validateStorageKey(row, "objects", line, issues);
    validateNonEmptyString(row, "mimeType", 255, "objects", line, issues);
    validateNullableString(row, "sha256", "objects", line, issues);
    validateNonEmptyString(row, "classification", 100, "objects", line, issues);

    if (typeof row.kind !== "string" || !objectKinds.has(row.kind)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("objects")?.path ?? "",
        table: "objects",
        line,
        field: "kind",
        message: "Object row kind is not supported.",
        actual: row.kind,
      });
    }

    if (typeof row.byteSize !== "number" || !Number.isInteger(row.byteSize) || row.byteSize < 0) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("objects")?.path ?? "",
        table: "objects",
        line,
        field: "byteSize",
        message: "Object row byteSize must be a non-negative integer.",
        actual: row.byteSize,
      });
    }

    if (!isJsonRecord(row.metadata)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("objects")?.path ?? "",
        table: "objects",
        line,
        field: "metadata",
        message: "Object row metadata must be a JSON object.",
        actual: row.metadata,
      });
    } else {
      const folderId = row.metadata.folderId;
      if (typeof folderId === "string" && !folderIds.has(folderId)) {
        issues.push({
          severity: "error",
          code: "missing_folder_reference",
          path: supportedChunksByTable.get("objects")?.path ?? "",
          table: "objects",
          line,
          field: "metadata.folderId",
          message: "Object row metadata.folderId must reference an exported drive_folders row.",
          actual: folderId,
        });
      }
    }

    if (typeof row.sha256 === "string" && !sha256Pattern.test(row.sha256)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("objects")?.path ?? "",
        table: "objects",
        line,
        field: "sha256",
        message: "Object row sha256 must be null or a 64-character hex digest.",
        actual: row.sha256,
      });
    }

    if (typeof row.storageKey === "string") {
      if (storageKeys.has(row.storageKey)) {
        issues.push({
          severity: "error",
          code: "duplicate_object_storage_key",
          path: supportedChunksByTable.get("objects")?.path ?? "",
          table: "objects",
          line,
          field: "storageKey",
          message: "Object rows must not duplicate storageKey values.",
          actual: row.storageKey,
        });
      }
      storageKeys.add(row.storageKey);
    }
  });
}

function validatePermissionRows(
  rowsByTable: ReadonlyMap<TenantExportSupportedPostgresDataChunkTable, readonly JsonRecord[]>,
  issues: TenantExportValidationIssue[],
): void {
  const objectIds = new Set(
    (rowsByTable.get("objects") ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const folderIds = new Set(
    (rowsByTable.get("drive_folders") ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const permissionKeys = new Set<string>();
  const rows = rowsByTable.get("permissions") ?? [];

  rows.forEach((row, index) => {
    const line = index + 1;
    validateUuidField(row, "id", "permissions", line, issues);
    validateUuidField(row, "actorId", "permissions", line, issues);
    validateUuidField(row, "resourceId", "permissions", line, issues);
    validateUuidField(row, "grantedByActorId", "permissions", line, issues, {
      nullable: true,
    });
    validateTimestampField(row, "expiresAt", "permissions", line, issues, { nullable: true });
    validateTimestampField(row, "createdAt", "permissions", line, issues);
    validateTimestampField(row, "updatedAt", "permissions", line, issues);
    validateNonEmptyString(row, "role", 200, "permissions", line, issues);

    if (typeof row.resourceType !== "string" || !permissionResourceTypes.has(row.resourceType)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("permissions")?.path ?? "",
        table: "permissions",
        line,
        field: "resourceType",
        message: "Permission row resourceType is not supported.",
        actual: row.resourceType,
      });
    }

    if (typeof row.resourceType === "string" && typeof row.resourceId === "string") {
      if (row.resourceType === "object" && !objectIds.has(row.resourceId)) {
        issues.push({
          severity: "error",
          code: "missing_object_reference",
          path: supportedChunksByTable.get("permissions")?.path ?? "",
          table: "permissions",
          line,
          field: "resourceId",
          message: "Permission row resourceId must reference an exported objects row.",
          actual: row.resourceId,
        });
      }
      if (row.resourceType === "drive_folder" && !folderIds.has(row.resourceId)) {
        issues.push({
          severity: "error",
          code: "missing_folder_reference",
          path: supportedChunksByTable.get("permissions")?.path ?? "",
          table: "permissions",
          line,
          field: "resourceId",
          message: "Permission row resourceId must reference an exported drive_folders row.",
          actual: row.resourceId,
        });
      }
    }

    if (
      typeof row.resourceType === "string" &&
      typeof row.resourceId === "string" &&
      typeof row.actorId === "string" &&
      typeof row.role === "string"
    ) {
      const key = `${row.resourceType}\u0000${row.resourceId}\u0000${row.actorId}\u0000${row.role}`;
      if (permissionKeys.has(key)) {
        issues.push({
          severity: "error",
          code: "duplicate_permission",
          path: supportedChunksByTable.get("permissions")?.path ?? "",
          table: "permissions",
          line,
          message:
            "Permission rows must not duplicate resourceType, resourceId, actorId, and role.",
          actual: {
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            actorId: row.actorId,
            role: row.role,
          },
        });
      }
      permissionKeys.add(key);
    }
  });
}

function validateDriveVersionRows(
  rowsByTable: ReadonlyMap<TenantExportSupportedPostgresDataChunkTable, readonly JsonRecord[]>,
  issues: TenantExportValidationIssue[],
): void {
  const objects = rowsByTable.get("objects") ?? [];
  const objectIds = new Set(
    objects.map((row) => row.id).filter((id): id is string => typeof id === "string"),
  );
  const versionKeys = new Set<string>();
  const rows = rowsByTable.get("drive_versions") ?? [];

  rows.forEach((row, index) => {
    const line = index + 1;
    validateUuidField(row, "id", "drive_versions", line, issues);
    validateUuidField(row, "objectId", "drive_versions", line, issues);
    validateUuidField(row, "createdByActorId", "drive_versions", line, issues, {
      nullable: true,
    });
    validateTimestampField(row, "createdAt", "drive_versions", line, issues);
    validateStorageKey(row, "drive_versions", line, issues);
    validateNonEmptyString(row, "mimeType", 255, "drive_versions", line, issues);

    if (typeof row.objectId === "string" && !objectIds.has(row.objectId)) {
      issues.push({
        severity: "error",
        code: "missing_object_reference",
        path: supportedChunksByTable.get("drive_versions")?.path ?? "",
        table: "drive_versions",
        line,
        field: "objectId",
        message: "Drive version row objectId must reference an exported objects row.",
        actual: row.objectId,
      });
    }

    if (
      typeof row.versionNumber !== "number" ||
      !Number.isInteger(row.versionNumber) ||
      row.versionNumber <= 0
    ) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("drive_versions")?.path ?? "",
        table: "drive_versions",
        line,
        field: "versionNumber",
        message: "Drive version row versionNumber must be a positive integer.",
        actual: row.versionNumber,
      });
    }

    if (typeof row.byteSize !== "number" || !Number.isInteger(row.byteSize) || row.byteSize < 0) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("drive_versions")?.path ?? "",
        table: "drive_versions",
        line,
        field: "byteSize",
        message: "Drive version row byteSize must be a non-negative integer.",
        actual: row.byteSize,
      });
    }

    if (typeof row.sha256 !== "string" || !sha256Pattern.test(row.sha256)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("drive_versions")?.path ?? "",
        table: "drive_versions",
        line,
        field: "sha256",
        message: "Drive version row sha256 must be a 64-character hex digest.",
        actual: row.sha256,
      });
    }

    if (!isJsonRecord(row.metadata)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("drive_versions")?.path ?? "",
        table: "drive_versions",
        line,
        field: "metadata",
        message: "Drive version row metadata must be a JSON object.",
        actual: row.metadata,
      });
    }

    if (typeof row.objectId === "string" && typeof row.versionNumber === "number") {
      const key = `${row.objectId}\u0000${String(row.versionNumber)}`;
      if (versionKeys.has(key)) {
        issues.push({
          severity: "error",
          code: "duplicate_drive_version",
          path: supportedChunksByTable.get("drive_versions")?.path ?? "",
          table: "drive_versions",
          line,
          message: "Drive version rows must not duplicate objectId and versionNumber.",
          actual: { objectId: row.objectId, versionNumber: row.versionNumber },
        });
      }
      versionKeys.add(key);
    }
  });
}

function validateResourceClassificationRows(
  rows: readonly JsonRecord[],
  issues: TenantExportValidationIssue[],
): void {
  const resourceKeys = new Set<string>();
  rows.forEach((row, index) => {
    const line = index + 1;
    validateUuidField(row, "id", "resource_classifications", line, issues);
    validateUuidField(row, "actorId", "resource_classifications", line, issues, {
      nullable: true,
    });
    validateTimestampField(row, "createdAt", "resource_classifications", line, issues);
    validateTimestampField(row, "updatedAt", "resource_classifications", line, issues);
    validateNonEmptyString(row, "resourceType", 200, "resource_classifications", line, issues);
    validateNonEmptyString(row, "resourceId", 500, "resource_classifications", line, issues);
    validateNonEmptyString(row, "reason", 2000, "resource_classifications", line, issues);

    if (typeof row.classification !== "string" || !dataClassifications.has(row.classification)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("resource_classifications")?.path ?? "",
        table: "resource_classifications",
        line,
        field: "classification",
        message: "Resource classification row classification is not supported.",
        actual: row.classification,
      });
    }

    if (typeof row.source !== "string" || !classificationSources.has(row.source)) {
      issues.push({
        severity: "error",
        code: "invalid_row_shape",
        path: supportedChunksByTable.get("resource_classifications")?.path ?? "",
        table: "resource_classifications",
        line,
        field: "source",
        message: "Resource classification row source is not supported.",
        actual: row.source,
      });
    }

    if (typeof row.resourceType === "string" && typeof row.resourceId === "string") {
      const resourceKey = `${row.resourceType}\u0000${row.resourceId}`;
      if (resourceKeys.has(resourceKey)) {
        issues.push({
          severity: "error",
          code: "duplicate_resource_classification",
          path: supportedChunksByTable.get("resource_classifications")?.path ?? "",
          table: "resource_classifications",
          line,
          message: "Resource classification rows must not duplicate resourceType and resourceId.",
          actual: { resourceType: row.resourceType, resourceId: row.resourceId },
        });
      }
      resourceKeys.add(resourceKey);
    }
  });
}

function validateUuidField(
  row: JsonRecord,
  field: string,
  table: TenantExportSupportedPostgresDataChunkTable,
  line: number,
  issues: TenantExportValidationIssue[],
  options: { readonly nullable?: boolean } = {},
): void {
  const value = row[field];
  if (options.nullable === true && value === null) {
    return;
  }
  if (typeof value !== "string" || !isUuid(value)) {
    issues.push({
      severity: "error",
      code: "invalid_row_shape",
      path: supportedChunksByTable.get(table)?.path ?? "",
      table,
      line,
      field,
      message: `${field} must be a UUID string${options.nullable === true ? " or null" : ""}.`,
      actual: value,
    });
  }
}

function validateTimestampField(
  row: JsonRecord,
  field: string,
  table: TenantExportSupportedPostgresDataChunkTable,
  line: number,
  issues: TenantExportValidationIssue[],
  options: { readonly nullable?: boolean } = {},
): void {
  const value = row[field];
  if (options.nullable === true && value === null) {
    return;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issues.push({
      severity: "error",
      code: "invalid_timestamp",
      path: supportedChunksByTable.get(table)?.path ?? "",
      table,
      line,
      field,
      message: `${field} must be a valid timestamp string${options.nullable === true ? " or null" : ""}.`,
      actual: value,
    });
  }
}

function validateNonEmptyString(
  row: JsonRecord,
  field: string,
  maxLength: number,
  table: TenantExportSupportedPostgresDataChunkTable,
  line: number,
  issues: TenantExportValidationIssue[],
): void {
  const value = row[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    issues.push({
      severity: "error",
      code: "invalid_row_shape",
      path: supportedChunksByTable.get(table)?.path ?? "",
      table,
      line,
      field,
      message: `${field} must be a non-empty string up to ${String(maxLength)} characters.`,
      actual: value,
    });
  }
}

function validateStorageKey(
  row: JsonRecord,
  table: TenantExportSupportedPostgresDataChunkTable,
  line: number,
  issues: TenantExportValidationIssue[],
): void {
  const value = row.storageKey;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2000 ||
    value.startsWith("/") ||
    value.split("/").includes("..") ||
    hasControlCharacter(value)
  ) {
    issues.push({
      severity: "error",
      code: "invalid_row_shape",
      path: supportedChunksByTable.get(table)?.path ?? "",
      table,
      line,
      field: "storageKey",
      message:
        "Row storageKey must be a relative non-empty key without parent segments or control characters.",
      actual: value,
    });
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) {
      return true;
    }
  }
  return false;
}

function validateNullableString(
  row: JsonRecord,
  field: string,
  table: TenantExportSupportedPostgresDataChunkTable,
  line: number,
  issues: TenantExportValidationIssue[],
): void {
  const value = row[field];
  if (value !== null && typeof value !== "string") {
    issues.push({
      severity: "error",
      code: "invalid_row_shape",
      path: supportedChunksByTable.get(table)?.path ?? "",
      table,
      line,
      field,
      message: `${field} must be a string or null.`,
      actual: value,
    });
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function isDomain(value: string): boolean {
  return value.length >= 1 && value.length <= 253 && domainPattern.test(value);
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

function lowerString(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
