import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { TenantExportManifest } from "./export.js";
import {
  buildTenantImportAuditContinuityPlan,
  PostgresTenantImportAuditContinuityStore,
} from "./import-audit-continuity.js";

const sourceOrgId = "22222222-2222-4222-8222-222222222222";
const targetOrgId = "33333333-3333-4333-8333-333333333333";
const importJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("buildTenantImportAuditContinuityPlan", () => {
  it("produces a summary-only continuity marker without pretending replay is supported", () => {
    const chainHead = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      createdAt: "2026-05-24T09:45:00.000Z",
      thisHash: "b".repeat(64),
    };

    expect(
      buildTenantImportAuditContinuityPlan({
        manifest: manifestWithAudit({
          rowCount: 2,
          firstEntryAt: "2026-05-24T09:00:00.000Z",
          lastEntryAt: "2026-05-24T09:30:00.000Z",
        }),
        targetOrgId,
        targetSlug: "target-acme",
        targetChainHead: chainHead,
        importJobId,
        archiveSha256: "a".repeat(64),
      }),
    ).toEqual({
      mode: "summary_only",
      replaySupported: false,
      reason: "source_activity_rows_not_exported",
      source: {
        orgId: sourceOrgId,
        slug: "acme",
        generatedAt: "2026-05-24T10:00:00.000Z",
        auditLog: {
          rowCount: 2,
          firstEntryAt: "2026-05-24T09:00:00.000Z",
          lastEntryAt: "2026-05-24T09:30:00.000Z",
        },
      },
      target: {
        orgId: targetOrgId,
        slug: "target-acme",
        chainHead,
      },
      marker: {
        verb: "tenant.import.audit_continuity.recorded",
        objectType: "tenant",
        objectId: targetOrgId,
        metadata: {
          mode: "summary_only",
          replaySupported: false,
          reason: "source_activity_rows_not_exported",
          sourceOrgId,
          sourceSlug: "acme",
          sourceGeneratedAt: "2026-05-24T10:00:00.000Z",
          sourceAuditRowCount: 2,
          sourceFirstEntryAt: "2026-05-24T09:00:00.000Z",
          sourceLastEntryAt: "2026-05-24T09:30:00.000Z",
          targetOrgId,
          targetSlug: "target-acme",
          targetPreImportChainHead: chainHead,
          importJobId,
          archiveSha256: "a".repeat(64),
        },
      },
      blockers: [],
    });
  });

  it("keeps source payloads and remap values out of continuity metadata", () => {
    const plan = buildTenantImportAuditContinuityPlan({
      manifest: manifestWithAudit({
        rowCount: 1,
        firstEntryAt: "2026-05-24T09:00:00.000Z",
        lastEntryAt: "2026-05-24T09:00:00.000Z",
      }),
      targetOrgId,
    });

    const metadataText = JSON.stringify(plan.marker.metadata);
    expect(metadataText).not.toContain("payload");
    expect(metadataText).not.toContain("actorId");
    expect(metadataText).not.toContain("objectId");
    expect(metadataText).not.toContain("principal");
    expect(metadataText).not.toContain("remap");
  });

  it("blocks future raw activity chunks until a replay schema is defined", () => {
    const manifest = manifestWithAudit(
      {
        rowCount: 1,
        firstEntryAt: "2026-05-24T09:00:00.000Z",
        lastEntryAt: "2026-05-24T09:00:00.000Z",
      },
      {
        activityChunk: true,
      },
    );

    const plan = buildTenantImportAuditContinuityPlan({
      manifest,
      targetOrgId,
    });

    expect(plan.reason).toBe("source_activity_rows_unsupported");
    expect(plan.blockers).toEqual([
      {
        code: "source_activity_rows_unsupported",
        table: "activity",
        message:
          "Tenant import does not yet define a redacted, versioned activity-row replay schema.",
      },
    ]);
    expect(plan.marker.metadata).toMatchObject({
      replaySupported: false,
      reason: "source_activity_rows_unsupported",
    });
  });
});

describe("PostgresTenantImportAuditContinuityStore", () => {
  it("loads the current target audit chain head without reading payloads", async () => {
    const recording = createRecordingSql([
      [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          created_at: new Date("2026-05-24T09:45:00.000Z"),
          this_hash: "b".repeat(64),
        },
      ],
    ]);
    const store = new PostgresTenantImportAuditContinuityStore(recording.sql);

    await expect(store.getLatestAuditChainHead(targetOrgId)).resolves.toEqual({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      createdAt: "2026-05-24T09:45:00.000Z",
      thisHash: "b".repeat(64),
    });
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("from activity");
    expect(recording.calls[0]?.text).toContain("where org_id = ?");
    expect(recording.calls[0]?.text).toContain("order by created_at desc, id desc");
    expect(recording.calls[0]?.text).not.toContain("payload");
    expect(recording.calls[0]?.values).toEqual([targetOrgId]);
  });

  it("returns null when the target audit chain has no current head", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresTenantImportAuditContinuityStore(recording.sql);

    await expect(store.getLatestAuditChainHead(targetOrgId)).resolves.toBeNull();
  });
});

function manifestWithAudit(
  auditLog: TenantExportManifest["auditLog"],
  options: { readonly activityChunk?: boolean } = {},
): TenantExportManifest {
  return {
    version: 1,
    generatedAt: "2026-05-24T10:00:00.000Z",
    org: {
      id: sourceOrgId,
      slug: "acme",
      displayName: "Acme",
      status: "active",
      tier: "enterprise",
      planId: "enterprise",
      region: "us-east-1",
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
        chunks:
          options.activityChunk === true
            ? [
                {
                  table: "activity",
                  path: "postgres/data/chunks/activity/000000.jsonl",
                  rowCount: 1,
                  byteSize: 2,
                  sha256: "a".repeat(64),
                  orderBy: ["created_at", "id"],
                },
              ]
            : [],
        includedTables: options.activityChunk === true ? ["activity"] : [],
        excludedTables: [],
        notes: [],
      },
    },
    auditLog,
  };
}

function createRecordingSql(results: readonly unknown[][]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly { readonly text: string; readonly values: readonly unknown[] }[];
} {
  const calls: { readonly text: string; readonly values: readonly unknown[] }[] = [];
  let index = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    const result = results[index] ?? [];
    index += 1;
    return Promise.resolve(result);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
