import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresTenantImportJobStore } from "./import-jobs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const importJobId = "88888888-8888-4888-8888-888888888888";
const olderImportJobId = "99999999-9999-4999-8999-999999999999";

describe("PostgresTenantImportJobStore", () => {
  it("creates, lists, and reads persisted tenant import dry-run jobs", async () => {
    const recording = createRecordingSql([
      [
        importJobRow({
          id: importJobId,
          ok: false,
          error_code: "invalid_tar_archive",
          result_summary: invalidArchiveResultSummary(),
        }),
      ],
      [
        importJobRow({
          id: importJobId,
          created_at: new Date("2026-05-24T10:02:00.000Z"),
        }),
        importJobRow({
          id: olderImportJobId,
          created_at: new Date("2026-05-24T10:01:00.000Z"),
        }),
      ],
      [importJobRow({ id: importJobId })],
    ]);
    const store = new PostgresTenantImportJobStore(recording.sql);

    const created = await store.create({
      orgId,
      requestedByActorId: actorId,
      archiveByteSize: 2048,
      archiveSha256: "a".repeat(64),
      hasConflictPolicyInput: true,
      conflictPolicy: { rowIdConflicts: "preserve" },
      hasRemapInput: true,
      remapInputSummary: {
        principalCount: 1,
        resourceCount: 1,
        sha256: "b".repeat(64),
      },
      ok: false,
      sourceOrgId: orgId,
      sourceSlug: "acme",
      sourceGeneratedAt: new Date("2026-05-24T09:30:00.000Z"),
      objectBytesMode: "metadata_only",
      issueCount: 1,
      operationCount: 0,
      conflictCount: 0,
      remapCount: 0,
      errorCode: "invalid_tar_archive",
      errorMessage: "Tenant export archive is not a valid tar file.",
      resultSummary: {
        ok: false,
        archiveIssues: [
          {
            severity: "error",
            code: "invalid_tar_archive",
            message: "Tenant export archive is not a valid tar file.",
          },
        ],
        plan: null,
      },
    });
    const listed = await store.listForOrg({
      orgId,
      limit: 25,
      cursor: { createdAt: new Date("2026-05-24T10:10:00.000Z"), id: olderImportJobId },
      status: "succeeded",
    });
    const found = await store.findByIdForOrg({ id: importJobId, orgId });

    expect(created).toMatchObject({
      id: importJobId,
      status: "succeeded",
      dryRun: true,
      ok: false,
      sourceOrgId: orgId,
      sourceSlug: "acme",
      objectBytesMode: "metadata_only",
      errorCode: "invalid_tar_archive",
      hasRemapInput: true,
      remapInputSummary: {
        principalCount: 1,
        resourceCount: 1,
        sha256: "b".repeat(64),
      },
      resultSummary: {
        ok: false,
        archiveIssues: [expect.objectContaining({ code: "invalid_tar_archive" })],
      },
    });
    expect(listed.map((job) => job.id)).toEqual([importJobId, olderImportJobId]);
    expect(found?.id).toBe(importJobId);
    expect(recording.calls[0]?.text).toContain("insert into tenant_import_jobs");
    expect(recording.calls[1]?.text).toContain("from tenant_import_jobs");
    expect(recording.calls[1]?.values).toContain("succeeded");
  });
});

function invalidArchiveResultSummary() {
  return {
    ok: false,
    archiveIssues: [
      {
        severity: "error",
        code: "invalid_tar_archive",
        message: "Tenant export archive is not a valid tar file.",
      },
    ],
    plan: null,
  };
}

function importJobRow(overrides: Partial<TenantImportJobRow> = {}): TenantImportJobRow {
  const now = new Date("2026-05-24T10:00:00.000Z");
  return {
    id: importJobId,
    org_id: orgId,
    status: "succeeded",
    dry_run: true,
    requested_by_actor_id: actorId,
    archive_byte_size: "2048",
    archive_sha256: "a".repeat(64),
    has_conflict_policy_input: true,
    conflict_policy: { rowIdConflicts: "preserve" },
    has_remap_input: true,
    remap_input_summary: {
      principalCount: 1,
      resourceCount: 1,
      sha256: "b".repeat(64),
    },
    ok: true,
    source_org_id: orgId,
    source_slug: "acme",
    source_generated_at: new Date("2026-05-24T09:30:00.000Z"),
    object_bytes_mode: "metadata_only",
    issue_count: 0,
    operation_count: 3,
    conflict_count: 1,
    remap_count: 2,
    error_code: null,
    error_message: null,
    result_summary: {
      ok: true,
      archiveIssues: [],
      plan: {
        source: {
          orgId,
          slug: "acme",
          generatedAt: "2026-05-24T09:30:00.000Z",
        },
        target: {
          orgId,
          slug: "acme",
          rewritesOrgId: false,
        },
        objectBytes: {
          mode: "metadata_only",
          objectCount: 0,
          totalKnownBytes: 0,
        },
        summary: {
          postgresRows: 3,
          adminDomainRows: 1,
          adminDnsRecordRows: 1,
          resourceClassificationRows: 1,
          operationCount: 3,
          remapCount: 2,
          conflictCount: 1,
        },
        issueCount: 0,
        issues: [],
        conflictCount: 1,
        conflicts: [],
      },
    },
    completed_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

interface TenantImportJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly status: "succeeded" | "failed";
  readonly dry_run: boolean;
  readonly requested_by_actor_id: string | null;
  readonly archive_byte_size: number | string;
  readonly archive_sha256: string;
  readonly has_conflict_policy_input: boolean;
  readonly conflict_policy: unknown;
  readonly has_remap_input: boolean;
  readonly remap_input_summary: unknown;
  readonly ok: boolean;
  readonly source_org_id: string | null;
  readonly source_slug: string | null;
  readonly source_generated_at: Date | null;
  readonly object_bytes_mode: "included" | "metadata_only" | null;
  readonly issue_count: number | string;
  readonly operation_count: number | string;
  readonly conflict_count: number | string;
  readonly remap_count: number | string;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly result_summary: unknown;
  readonly completed_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function createRecordingSql(results: readonly unknown[][]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly { readonly text: string; readonly values: readonly unknown[] }[];
} {
  const calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  let index = 0;
  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    const result = results[index] ?? [];
    index += 1;
    return Promise.resolve(result);
  };
  const sql = Object.assign(query, { json: (value: unknown) => value }) as unknown as postgres.Sql;
  return { sql, calls };
}
