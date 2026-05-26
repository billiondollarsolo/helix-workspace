import { createHash } from "node:crypto";
import type { StorageObject } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { AdminConsoleAuditSink } from "../admin/console-shared.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import { buildTenantImportAuditContinuityPlan } from "./import-audit-continuity.js";
import { buildTenantImportObjectRestorePlan } from "./import-object-restore.js";
import type { TenantImportPlan, TenantImportPlanOperation } from "./import-plan.js";
import {
  executeTenantImportPreparedPlan,
  tenantImportExecutionConfirmation,
} from "./import-execution.js";
import type {
  TenantImportRowApplyOperationInput,
  TenantImportRowApplyOperationResult,
  TenantImportRowApplyStore,
} from "./import-row-apply.js";

const sourceOrgId = "22222222-2222-4222-8222-222222222222";
const targetOrgId = "33333333-3333-4333-8333-333333333333";
const actorId = "11111111-1111-4111-8111-111111111111";
const domainId = "44444444-4444-4444-8444-444444444444";
const targetDomainId = "77777777-7777-4777-8777-777777777777";

describe("executeTenantImportPreparedPlan", () => {
  it("preflights all prepared plans before mutating rows, objects, or audit", async () => {
    const rowApplyStore = new RecordingRowApplyStore();
    const objectStorage = new RecordingStorageClient();
    const auditSink = new RecordingAuditSink();
    const objectRestorePlan = await buildTenantImportObjectRestorePlan({
      manifest: manifestWithObject({
        bytesIncluded: false,
      }),
    });

    const result = await executeTenantImportPreparedPlan({
      confirmation: tenantImportExecutionConfirmation,
      plan: importPlan({ ok: false }),
      rowApplyStore,
      objectRestorePlan,
      objectArchiveEntries: new Map(),
      objectStorage,
      auditContinuityPlan: auditContinuityPlan(),
      auditSink,
      actorId,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      stoppedAt: "preflight",
    });
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      "plan_not_ok",
      "object_restore_plan_blocked",
    ]);
    expect(rowApplyStore.calls).toEqual([]);
    expect(objectStorage.puts).toEqual([]);
    expect(auditSink.records).toEqual([]);
  });

  it("applies rows, restores included object bytes, and writes audit continuity marker in order", async () => {
    const body = Buffer.from("hello world", "utf8");
    const archiveEntries = new Map([["objects/docs/doc-1", body]]);
    const rowApplyStore = new RecordingRowApplyStore([
      {
        order: 1,
        kind: "upsert_admin_domain",
        table: "admin_domains",
        sourceId: domainId,
        targetId: targetDomainId,
        action: "inserted",
      },
    ]);
    const objectStorage = new RecordingStorageClient();
    const auditSink = new RecordingAuditSink();
    const objectRestorePlan = await buildTenantImportObjectRestorePlan({
      manifest: manifestWithObject({
        bytesIncluded: true,
        byteSize: body.byteLength,
        sha256: sha256Hex(body),
      }),
      archiveEntries,
    });

    await expect(
      executeTenantImportPreparedPlan({
        confirmation: tenantImportExecutionConfirmation,
        plan: importPlan(),
        rowApplyStore,
        objectRestorePlan,
        objectArchiveEntries: archiveEntries,
        objectStorage,
        auditContinuityPlan: auditContinuityPlan(),
        auditSink,
        actorId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "succeeded",
      stoppedAt: null,
      rowApply: {
        ok: true,
        summary: {
          total: 1,
          inserted: 1,
          updated: 0,
          blocked: 0,
          noop: 0,
        },
      },
      objectRestore: {
        ok: true,
        summary: {
          total: 1,
          restorable: 1,
          blocked: 0,
          noop: 0,
          totalKnownBytes: body.byteLength,
        },
      },
      auditContinuity: {
        ok: true,
        markerAuditId: "audit-1",
        markerHash: "1".repeat(64),
      },
    });

    expect(rowApplyStore.calls.map((call) => call.operation.sourceId)).toEqual([domainId]);
    expect(objectStorage.puts).toEqual([
      {
        key: "docs/doc-1",
        body,
        contentType: "application/octet-stream",
        metadata: {
          "helix-import-source-key": "docs/doc-1",
          "helix-import-source": "included-archive-bytes",
          "helix-import-sha256": sha256Hex(body),
        },
      },
    ]);
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]).toEqual({
      orgId: targetOrgId,
      actorId,
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
        targetPreImportChainHead: null,
        rowApplySummary: {
          total: 1,
          inserted: 1,
          updated: 0,
          blocked: 0,
          noop: 0,
        },
        objectRestoreSummary: {
          total: 1,
          restorable: 1,
          blocked: 0,
          noop: 0,
          totalKnownBytes: body.byteLength,
        },
      },
    });
  });

  it("stops before object restore and audit when row apply blocks", async () => {
    const body = Buffer.from("hello world", "utf8");
    const archiveEntries = new Map([["objects/docs/doc-1", body]]);
    const rowApplyStore = new RecordingRowApplyStore([
      {
        order: 1,
        kind: "upsert_admin_domain",
        table: "admin_domains",
        sourceId: domainId,
        targetId: null,
        action: "blocked",
        blockedReason: "insert_conflict",
      },
    ]);
    const objectStorage = new RecordingStorageClient();
    const auditSink = new RecordingAuditSink();

    const result = await executeTenantImportPreparedPlan({
      confirmation: tenantImportExecutionConfirmation,
      plan: importPlan(),
      rowApplyStore,
      objectRestorePlan: await buildTenantImportObjectRestorePlan({
        manifest: manifestWithObject({
          bytesIncluded: true,
          byteSize: body.byteLength,
          sha256: sha256Hex(body),
        }),
        archiveEntries,
      }),
      objectArchiveEntries: archiveEntries,
      objectStorage,
      auditContinuityPlan: auditContinuityPlan(),
      auditSink,
      actorId,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      stoppedAt: "row_apply",
      blockers: [
        {
          stage: "row_apply",
          code: "row_apply_blocked",
          message: "One or more tenant import row operations were blocked.",
        },
      ],
    });
    expect(rowApplyStore.calls).toHaveLength(1);
    expect(objectStorage.puts).toHaveLength(1);
    expect(auditSink.records).toEqual([]);
  });

  it("preflights self-fetch object restore plans until a downloader is provided", async () => {
    const rowApplyStore = new RecordingRowApplyStore();
    const objectStorage = new RecordingStorageClient();
    const auditSink = new RecordingAuditSink();

    await expect(
      executeTenantImportPreparedPlan({
        confirmation: tenantImportExecutionConfirmation,
        plan: importPlan(),
        rowApplyStore,
        objectRestorePlan: await buildTenantImportObjectRestorePlan({
          manifest: manifestWithObject({
            bytesIncluded: false,
          }),
          selfFetchManifest: {
            version: 1,
            generatedAt: "2026-05-24T10:00:00.000Z",
            org: {
              id: sourceOrgId,
              slug: "acme",
            },
            delivery: "self-fetch",
            expiresAt: "2026-05-24T11:00:00.000Z",
            expiresSeconds: 3600,
            objects: [
              {
                storageKey: "docs/doc-1",
                url: "https://example.test/docs/doc-1",
                expiresAt: "2026-05-24T11:00:00.000Z",
              },
            ],
          },
        }),
        objectArchiveEntries: new Map(),
        objectStorage,
        auditContinuityPlan: auditContinuityPlan(),
        auditSink,
        actorId,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "blocked",
      stoppedAt: "preflight",
      blockers: [
        {
          stage: "preflight",
          code: "self_fetch_downloader_required",
          message:
            "Tenant import execution requires a self-fetch downloader for self-fetch objects.",
        },
      ],
    });
    expect(rowApplyStore.calls).toEqual([]);
    expect(objectStorage.puts).toEqual([]);
    expect(auditSink.records).toEqual([]);
  });

  it("restores self-fetch object bytes when a downloader is provided", async () => {
    const body = Buffer.from("hello world", "utf8");
    const rowApplyStore = new RecordingRowApplyStore();
    const objectStorage = new RecordingStorageClient();
    const auditSink = new RecordingAuditSink();

    await expect(
      executeTenantImportPreparedPlan({
        confirmation: tenantImportExecutionConfirmation,
        plan: importPlan(),
        rowApplyStore,
        objectRestorePlan: await buildTenantImportObjectRestorePlan({
          manifest: manifestWithObject({
            bytesIncluded: false,
            byteSize: body.byteLength,
            sha256: sha256Hex(body),
          }),
          selfFetchManifest: {
            version: 1,
            generatedAt: "2026-05-24T10:00:00.000Z",
            org: {
              id: sourceOrgId,
              slug: "acme",
            },
            delivery: "self-fetch",
            expiresAt: "2026-05-24T11:00:00.000Z",
            expiresSeconds: 3600,
            objects: [
              {
                storageKey: "docs/doc-1",
                byteSize: body.byteLength,
                sha256: sha256Hex(body),
                url: "https://example.test/docs/doc-1",
                expiresAt: "2026-05-24T11:00:00.000Z",
              },
            ],
          },
        }),
        objectArchiveEntries: new Map(),
        objectStorage,
        selfFetchDownloader: async (download) => {
          expect(download).toMatchObject({
            storageKey: "docs/doc-1",
            targetStorageKey: "docs/doc-1",
            url: "https://example.test/docs/doc-1",
            expectedByteSize: body.byteLength,
            expectedSha256: sha256Hex(body),
          });
          return { body, contentType: "text/plain" };
        },
        auditContinuityPlan: auditContinuityPlan(),
        auditSink,
        actorId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "succeeded",
      objectRestore: {
        ok: true,
        summary: {
          total: 1,
          restorable: 1,
          blocked: 0,
          totalKnownBytes: body.byteLength,
        },
      },
    });

    expect(rowApplyStore.calls).toHaveLength(1);
    expect(objectStorage.puts).toEqual([
      {
        key: "docs/doc-1",
        body,
        contentType: "text/plain",
        metadata: {
          "helix-import-source-key": "docs/doc-1",
          "helix-import-source": "self-fetch",
          "helix-import-sha256": sha256Hex(body),
        },
      },
    ]);
    expect(auditSink.records).toHaveLength(1);
  });

  it("fails execution when mandatory audit continuity append fails", async () => {
    const body = Buffer.from("hello world", "utf8");
    const archiveEntries = new Map([["objects/docs/doc-1", body]]);
    const auditSink = new FailingAuditSink();

    await expect(
      executeTenantImportPreparedPlan({
        confirmation: tenantImportExecutionConfirmation,
        plan: importPlan(),
        rowApplyStore: new RecordingRowApplyStore(),
        objectRestorePlan: await buildTenantImportObjectRestorePlan({
          manifest: manifestWithObject({
            bytesIncluded: true,
            byteSize: body.byteLength,
            sha256: sha256Hex(body),
          }),
          archiveEntries,
        }),
        objectArchiveEntries: archiveEntries,
        objectStorage: new RecordingStorageClient(),
        auditContinuityPlan: auditContinuityPlan(),
        auditSink,
        actorId,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "failed",
      stoppedAt: "audit_continuity",
      blockers: [
        {
          stage: "audit_continuity",
          code: "audit_continuity_failed",
          message: "audit unavailable",
        },
      ],
    });
  });
});

function importPlan(
  input: { readonly ok?: boolean } = {},
): Pick<TenantImportPlan, "ok" | "issues" | "operations"> {
  return {
    ok: input.ok ?? true,
    issues: [],
    operations: [domainOperation()],
  };
}

function domainOperation(): TenantImportPlanOperation {
  return {
    order: 1,
    kind: "upsert_admin_domain",
    table: "admin_domains",
    path: "postgres/data/chunks/admin_domains/000000.jsonl",
    line: 1,
    action: "insert",
    sourceId: domainId,
    targetId: null,
    sourceOrgId,
    targetOrgId,
    naturalKey: ["example.com"],
    dependsOn: [],
    remappedFields: {
      orgId: targetOrgId,
    },
    conflictPolicy: {
      rowId: "regenerate",
      references: {},
      state: {},
    },
    row: {
      id: domainId,
      orgId: targetOrgId,
      domain: "example.com",
      isPrimary: false,
      verificationStatus: "pending",
      verifiedAt: null,
      createdBy: null,
      createdAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:00:00.000Z",
    },
  };
}

function manifestWithObject(input: {
  readonly bytesIncluded: boolean;
  readonly byteSize?: number | undefined;
  readonly sha256?: string | undefined;
}) {
  return {
    version: 1 as const,
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
      bytesIncluded: input.bytesIncluded,
      objectCount: 1,
      totalKnownBytes: input.byteSize ?? 0,
      objects: [
        {
          storageKey: "docs/doc-1",
          ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
          ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
        },
      ],
    },
    postgres: {
      rowCounts: [],
      rowDataChunks: {
        version: 1 as const,
        format: "jsonl" as const,
        chunks: [],
        includedTables: [],
        excludedTables: [],
        notes: [],
      },
    },
    auditLog: {
      rowCount: 2,
      firstEntryAt: "2026-05-24T09:00:00.000Z",
      lastEntryAt: "2026-05-24T09:30:00.000Z",
    },
  };
}

function auditContinuityPlan() {
  return buildTenantImportAuditContinuityPlan({
    manifest: manifestWithObject({
      bytesIncluded: false,
    }),
    targetOrgId,
  });
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

class RecordingRowApplyStore implements TenantImportRowApplyStore {
  readonly calls: TenantImportRowApplyOperationInput[] = [];

  constructor(
    private readonly results: readonly TenantImportRowApplyOperationResult[] = [
      {
        order: 1,
        kind: "upsert_admin_domain",
        table: "admin_domains",
        sourceId: domainId,
        targetId: targetDomainId,
        action: "inserted",
      },
    ],
  ) {}

  async applyOperation(
    input: TenantImportRowApplyOperationInput,
  ): Promise<TenantImportRowApplyOperationResult> {
    this.calls.push(input);
    const result = this.results[this.calls.length - 1] ?? this.results.at(-1);
    if (result === undefined) {
      throw new Error("No row apply result configured.");
    }
    return result;
  }
}

class RecordingStorageClient implements TenantStorageClient {
  readonly puts: StorageObject[] = [];

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<StorageObject | null> {
    return null;
  }

  async delete(): Promise<void> {}
}

class RecordingAuditSink implements AdminConsoleAuditSink {
  readonly records: Parameters<AdminConsoleAuditSink["append"]>[0][] = [];

  async append(record: Parameters<AdminConsoleAuditSink["append"]>[0]) {
    this.records.push(record);
    return {
      id: `audit-${String(this.records.length)}`,
      thisHash: String(this.records.length).repeat(64).slice(0, 64),
    };
  }
}

class FailingAuditSink implements AdminConsoleAuditSink {
  async append(): Promise<{ readonly id: string; readonly thisHash: string }> {
    throw new Error("audit unavailable");
  }
}
