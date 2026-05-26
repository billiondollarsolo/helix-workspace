import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTenantExportManifest,
  type TenantExportManifest,
  type TenantExportPostgresDataChunk,
  type TenantExportPostgresDataChunkFile,
  type TenantExportPostgresDataChunkManifest,
} from "./export.js";
import {
  validateTenantExportPostgresDataChunks,
  type TenantExportValidationFiles,
} from "./export-validation.js";
import type { OrgRecord } from "./orgs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const actorId = "11111111-1111-4111-8111-111111111111";
const domainId = "44444444-4444-4444-8444-444444444444";
const dnsRecordId = "55555555-5555-4555-8555-555555555555";
const resourceClassificationId = "66666666-6666-4666-8666-666666666666";

describe("validateTenantExportPostgresDataChunks", () => {
  it("accepts the current admin domain and DNS chunk contract", () => {
    const input = validValidationInput();

    const result = validateTenantExportPostgresDataChunks(input);

    expect(result).toEqual({
      ok: true,
      issues: [],
      summary: { adminDomainRows: 1, adminDnsRecordRows: 1, resourceClassificationRows: 1 },
    });
  });

  it("accepts an export with no row chunks yet", () => {
    const manifest = tenantExportManifest();

    const result = validateTenantExportPostgresDataChunks({ manifest, files: {} });

    expect(result).toMatchObject({
      ok: true,
      issues: [],
      summary: { adminDomainRows: 0, adminDnsRecordRows: 0, resourceClassificationRows: 0 },
    });
  });

  it("accepts declared empty chunk files when metadata matches", () => {
    const input = validValidationInput({
      domainRows: [],
      dnsRows: [],
      resourceClassificationRows: [],
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(result).toMatchObject({
      ok: true,
      issues: [],
      summary: { adminDomainRows: 0, adminDnsRecordRows: 0, resourceClassificationRows: 0 },
    });
  });

  it("rejects missing declared chunk files", () => {
    const input = validValidationInput();
    const files = new Map(input.files);
    files.delete("postgres/data/chunks/admin_dns_records/000000.jsonl");

    const result = validateTenantExportPostgresDataChunks({
      manifest: input.manifest,
      files,
    });

    expect(issueCodes(result)).toContain("missing_chunk_file");
    expect(result.ok).toBe(false);
  });

  it("rejects chunk digest, byte-size, and row-count mismatches", () => {
    const input = mutateChunk(validValidationInput(), "admin_domains", (chunk) => ({
      ...chunk,
      byteSize: chunk.byteSize + 1,
      rowCount: chunk.rowCount + 1,
      sha256: "0".repeat(64),
    }));

    const result = validateTenantExportPostgresDataChunks(input);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "chunk_digest_mismatch",
        "chunk_size_mismatch",
        "chunk_row_count_mismatch",
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unsupported manifest version, format, table, path, and order metadata", () => {
    const input = validValidationInput();
    const rowDataChunks: TenantExportPostgresDataChunkManifest = {
      ...input.manifest.postgres.rowDataChunks,
      version: 2 as 1,
      format: "csv" as "jsonl",
      includedTables: ["admin_domains", "oauth_access_tokens"],
      chunks: [
        {
          ...input.manifest.postgres.rowDataChunks.chunks[0],
          path: "../admin_domains.jsonl",
          orderBy: ["created_at"],
        } as TenantExportPostgresDataChunk,
        {
          table: "oauth_access_tokens",
          path: "postgres/data/chunks/oauth_access_tokens/000000.jsonl",
          rowCount: 0,
          byteSize: 0,
          sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
          orderBy: ["id"],
        },
      ],
    };

    const result = validateTenantExportPostgresDataChunks({
      manifest: withChunkManifest(input.manifest, rowDataChunks),
      files: input.files,
    });

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "unsupported_manifest_version",
        "unsupported_chunk_format",
        "unexpected_table",
        "unexpected_chunk_file",
        "invalid_chunk_order",
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects undeclared admin chunk files in the archive", () => {
    const input = validValidationInput();
    const files = new Map(input.files);
    files.set("postgres/data/chunks/admin_domains/000001.jsonl", Buffer.alloc(0));

    const result = validateTenantExportPostgresDataChunks({
      manifest: input.manifest,
      files,
    });

    expect(issueCodes(result)).toContain("unexpected_chunk_file");
    expect(result.ok).toBe(false);
  });

  it("rejects malformed JSONL with file and line context", () => {
    const input = replaceChunkBody(validValidationInput(), "admin_domains", "{not-json\n", {
      rowCount: 1,
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_jsonl",
        path: "postgres/data/chunks/admin_domains/000000.jsonl",
        line: 1,
      }),
    );
  });

  it("rejects invalid domain row shape, timestamps, duplicates, and primary conflicts", () => {
    const input = validValidationInput({
      domainRows: [
        adminDomainRow({ domain: "Example.com", isPrimary: true }),
        adminDomainRow({
          id: "66666666-6666-4666-8666-666666666666",
          domain: "example.com",
          isPrimary: true,
          createdAt: "not-a-date",
        }),
      ],
      dnsRows: [],
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["duplicate_domain", "duplicate_primary_domain", "invalid_timestamp"]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects DNS rows with missing domain references, invalid enums, org mismatch, and duplicates", () => {
    const input = validValidationInput({
      dnsRows: [
        adminDnsRecordRow({
          domainId: "66666666-6666-4666-8666-666666666666",
          recordType: "BAD",
          status: "unknown",
          orgId: otherOrgId,
        }),
        adminDnsRecordRow({
          id: "77777777-7777-4777-8777-777777777777",
        }),
      ],
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["missing_domain_reference", "invalid_row_shape", "org_id_mismatch"]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate DNS record identity rows", () => {
    const input = validValidationInput({
      dnsRows: [
        adminDnsRecordRow(),
        adminDnsRecordRow({
          id: "66666666-6666-4666-8666-666666666666",
        }),
      ],
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_row_shape",
        message: "DNS rows must not duplicate domainId, recordType, and host.",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects rows that do not match deterministic chunk order", () => {
    const input = validValidationInput({
      domainRows: [
        adminDomainRow({
          id: "66666666-6666-4666-8666-666666666666",
          domain: "z.example.com",
          isPrimary: false,
        }),
        adminDomainRow({ domain: "a.example.com" }),
      ],
      dnsRows: [],
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(issueCodes(result)).toContain("invalid_chunk_order");
    expect(result.ok).toBe(false);
  });

  it("rejects invalid resource classification rows and duplicate identities", () => {
    const input = validValidationInput({
      resourceClassificationRows: [
        resourceClassificationRow({
          classification: "secret",
          source: "manual",
          actorId: "not-a-uuid",
        }),
        resourceClassificationRow({
          id: "77777777-7777-4777-8777-777777777777",
        }),
      ],
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["invalid_row_shape", "duplicate_resource_classification"]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects resource classification rows that do not match deterministic chunk order", () => {
    const input = validValidationInput({
      resourceClassificationRows: [
        resourceClassificationRow({
          resourceType: "mail.message",
          resourceId: "z-message",
        }),
        resourceClassificationRow({
          id: "77777777-7777-4777-8777-777777777777",
          resourceType: "drive.object",
          resourceId: "a-object",
        }),
      ],
    });

    const result = validateTenantExportPostgresDataChunks(input);

    expect(issueCodes(result)).toContain("invalid_chunk_order");
    expect(result.ok).toBe(false);
  });
});

function validValidationInput(
  input: {
    readonly domainRows?: readonly Record<string, unknown>[];
    readonly dnsRows?: readonly Record<string, unknown>[];
    readonly resourceClassificationRows?: readonly Record<string, unknown>[];
  } = {},
): {
  readonly manifest: TenantExportManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
} {
  const chunks = [
    chunkFile({
      table: "admin_domains",
      path: "postgres/data/chunks/admin_domains/000000.jsonl",
      orderBy: ["lower(domain)", "created_at", "id"],
      rows: input.domainRows ?? [adminDomainRow()],
    }),
    chunkFile({
      table: "admin_dns_records",
      path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
      orderBy: ["domain_id", "record_type", "host", "id"],
      rows: input.dnsRows ?? [adminDnsRecordRow()],
    }),
    chunkFile({
      table: "resource_classifications",
      path: "postgres/data/chunks/resource_classifications/000000.jsonl",
      orderBy: ["resource_type", "resource_id", "id"],
      rows: input.resourceClassificationRows ?? [resourceClassificationRow()],
    }),
  ];

  return {
    manifest: tenantExportManifest({ rowDataChunkFiles: chunks }),
    files: new Map(chunks.map((chunk) => [chunk.metadata.path, chunk.body] as const)),
  };
}

function tenantExportManifest(
  input: {
    readonly rowDataChunkFiles?: readonly TenantExportPostgresDataChunkFile[] | undefined;
  } = {},
): TenantExportManifest {
  return buildTenantExportManifest({
    org: orgRecord(),
    generatedAt: new Date("2026-05-24T10:00:00.000Z"),
    objects: [],
    rowCounts: [],
    auditSummary: {
      rowCount: 0,
      firstEntryAt: null,
      lastEntryAt: null,
    },
    ...(input.rowDataChunkFiles === undefined
      ? {}
      : { rowDataChunkFiles: input.rowDataChunkFiles }),
  });
}

function chunkFile(input: {
  readonly table: string;
  readonly path: string;
  readonly orderBy: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
}): TenantExportPostgresDataChunkFile {
  const body = Buffer.from(
    input.rows.map((row) => JSON.stringify(row)).join("\n") + (input.rows.length > 0 ? "\n" : ""),
    "utf8",
  );
  return {
    metadata: {
      table: input.table,
      path: input.path,
      rowCount: input.rows.length,
      byteSize: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      orderBy: input.orderBy,
    },
    body,
  };
}

function adminDomainRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: domainId,
    orgId,
    domain: "example.com",
    isPrimary: true,
    verificationStatus: "verified",
    verifiedAt: "2026-05-24T09:30:00.000Z",
    createdBy: actorId,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function adminDnsRecordRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: dnsRecordId,
    orgId,
    domainId,
    recordType: "TXT",
    host: "_helix.example.com",
    expectedValue: "helix-verification=abc",
    observedValue: "helix-verification=abc",
    status: "verified",
    lastCheckedAt: "2026-05-24T09:25:00.000Z",
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:25:00.000Z",
    ...overrides,
  };
}

function resourceClassificationRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: resourceClassificationId,
    orgId,
    resourceType: "mail.message",
    resourceId: "msg-1",
    classification: "confidential",
    source: "label",
    reason: "label:HR",
    actorId: actorId,
    createdAt: "2026-05-24T09:00:00.000Z",
    updatedAt: "2026-05-24T09:30:00.000Z",
    ...overrides,
  };
}

function mutateChunk(
  input: {
    readonly manifest: TenantExportManifest;
    readonly files: TenantExportValidationFiles;
  },
  table: string,
  mutate: (chunk: TenantExportPostgresDataChunk) => TenantExportPostgresDataChunk,
): {
  readonly manifest: TenantExportManifest;
  readonly files: TenantExportValidationFiles;
} {
  return {
    ...input,
    manifest: withChunkManifest(input.manifest, {
      ...input.manifest.postgres.rowDataChunks,
      chunks: input.manifest.postgres.rowDataChunks.chunks.map((chunk) =>
        chunk.table === table ? mutate(chunk) : chunk,
      ),
    }),
  };
}

function replaceChunkBody(
  input: {
    readonly manifest: TenantExportManifest;
    readonly files: ReadonlyMap<string, Uint8Array>;
  },
  table: string,
  bodyText: string,
  metadata: Partial<Pick<TenantExportPostgresDataChunk, "byteSize" | "rowCount" | "sha256">> = {},
): {
  readonly manifest: TenantExportManifest;
  readonly files: ReadonlyMap<string, Uint8Array>;
} {
  const chunk = input.manifest.postgres.rowDataChunks.chunks.find((entry) => entry.table === table);
  if (chunk === undefined) {
    throw new Error(`Missing chunk for table ${table}.`);
  }
  const body = Buffer.from(bodyText, "utf8");
  const files = new Map(input.files);
  files.set(chunk.path, body);
  return {
    manifest: withChunkManifest(input.manifest, {
      ...input.manifest.postgres.rowDataChunks,
      chunks: input.manifest.postgres.rowDataChunks.chunks.map((entry) =>
        entry.table === table
          ? {
              ...entry,
              byteSize: metadata.byteSize ?? body.byteLength,
              rowCount: metadata.rowCount ?? entry.rowCount,
              sha256: metadata.sha256 ?? createHash("sha256").update(body).digest("hex"),
            }
          : entry,
      ),
    }),
    files,
  };
}

function withChunkManifest(
  manifest: TenantExportManifest,
  rowDataChunks: TenantExportPostgresDataChunkManifest,
): TenantExportManifest {
  return {
    ...manifest,
    postgres: {
      ...manifest.postgres,
      rowDataChunks,
    },
  };
}

function issueCodes(result: {
  readonly issues: readonly {
    readonly code: string;
  }[];
}): readonly string[] {
  return result.issues.map((issue) => issue.code);
}

function orgRecord(overrides: Partial<OrgRecord> = {}): OrgRecord {
  return {
    id: orgId,
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "business",
    planId: "business",
    region: "us-east-1",
    byoConfig: { storage: { kind: "helix-default" } },
    featureFlags: { byo_storage: true },
    quotas: { export_jobs_per_hour: 1 },
    branding: { display_name_override: "Acme" },
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    ...overrides,
  };
}
