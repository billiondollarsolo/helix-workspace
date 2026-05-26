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
  | "missing_domain_reference"
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

type TenantExportSupportedPostgresDataChunkTable = "admin_domains" | "admin_dns_records";

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
];

const supportedChunksByTable = new Map(supportedChunks.map((chunk) => [chunk.table, chunk]));
const supportedChunksByPath = new Map(supportedChunks.map((chunk) => [chunk.path, chunk]));
const supportedChunkTables = new Set(supportedChunks.map((chunk) => chunk.table));
const supportedChunkPaths = new Set(supportedChunks.map((chunk) => chunk.path));
const verificationStatuses = new Set(["verified", "pending", "failed"]);
const dnsRecordTypes = new Set(["MX", "SPF", "DKIM", "DMARC", "TXT", "CNAME", "A"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues,
    summary: {
      adminDomainRows: rowsByTable.get("admin_domains")?.length ?? 0,
      adminDnsRecordRows: rowsByTable.get("admin_dns_records")?.length ?? 0,
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
    const comparison =
      definition.table === "admin_domains"
        ? compareDomainRows(previous, current)
        : compareDnsRows(previous, current);
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

function lowerString(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
