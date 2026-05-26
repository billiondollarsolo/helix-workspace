import { createHash } from "node:crypto";
import type { Actor, StorageObject } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  buildTenantExportArchive,
  buildTenantExportManifest,
  type TenantExportPostgresDataChunkFile,
} from "./export.js";
import { registerTenantImportRoutes } from "./import-routes.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import type { TenantImportAuditContinuityStore } from "./import-audit-continuity.js";
import type {
  CreateTenantImportJobInput,
  ListTenantImportJobsInput,
  TenantImportJobRecord,
  TenantImportJobStore,
} from "./import-jobs.js";
import type {
  TenantImportRowApplyOperationInput,
  TenantImportRowApplyOperationResult,
  TenantImportRowApplyStore,
} from "./import-row-apply.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const targetDomainId = "77777777-7777-4777-8777-777777777777";
const actorId = "11111111-1111-4111-8111-111111111111";
const domainId = "44444444-4444-4444-8444-444444444444";
const dnsRecordId = "55555555-5555-4555-8555-555555555555";
const resourceClassificationId = "66666666-6666-4666-8666-666666666666";
const importJobId = "88888888-8888-4888-8888-888888888888";
const olderImportJobId = "99999999-9999-4999-8999-999999999999";
const targetActorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("registerTenantImportRoutes", () => {
  it("builds a no-write import dry-run plan from an export archive and live target facts", async () => {
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [
          {
            table: "admin_domains",
            naturalKey: ["example.com"],
            targetId: targetDomainId,
          },
        ],
        primaryDomain: "other.example.com",
      }),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/dry-run",
      headers: { "content-type": "application/x-tar", "user-agent": "test-agent" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      plan: {
        dryRun: true,
        target: {
          orgId,
          slug: "acme",
        },
        summary: {
          operationCount: 3,
          conflictCount: 2,
        },
        operations: [
          expect.objectContaining({
            table: "admin_domains",
            action: "update",
            targetId: targetDomainId,
          }),
          expect.objectContaining({
            table: "admin_dns_records",
            dependsOn: [`admin_domains:${targetDomainId}`],
          }),
          expect.objectContaining({
            table: "resource_classifications",
            action: "blocked",
          }),
        ],
      },
    });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.import.dry_run.planned",
        objectType: "tenant",
        objectId: orgId,
        metadata: expect.objectContaining({
          slug: "acme",
          archiveByteSize: archive.byteSize,
          ok: true,
          operationCount: 3,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("persists import dry-run job history without storing archive bytes", async () => {
    const archive = Buffer.from("not-a-real-tar", "utf8");
    const importJobs = new InMemoryTenantImportJobStore([]);
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/dry-run?rowIdConflicts=preserve",
      headers: { "content-type": "application/x-tar" },
      payload: archive,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      ok: false,
      importJob: {
        id: importJobId,
        status: "succeeded",
        dryRun: true,
        ok: false,
        archiveByteSize: archive.byteLength,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
        hasConflictPolicyInput: true,
        conflictPolicy: { rowIdConflicts: "preserve" },
        errorCode: "invalid_tar_archive",
        resultSummary: {
          ok: false,
          archiveIssues: [expect.objectContaining({ code: "invalid_tar_archive" })],
          plan: null,
        },
      },
    });
    expect(importJobs.jobs[0]).toMatchObject({
      status: "succeeded",
      ok: false,
      errorCode: "invalid_tar_archive",
    });
    expect(JSON.stringify(importJobs.jobs[0])).not.toContain("not-a-real-tar");
    await app.close();
  });

  it("lists and reads persisted import dry-run job history", async () => {
    const importJobs = new InMemoryTenantImportJobStore([
      importJobRecord({
        id: importJobId,
        createdAt: new Date("2026-05-24T10:02:00.000Z"),
        updatedAt: new Date("2026-05-24T10:02:00.000Z"),
        completedAt: new Date("2026-05-24T10:02:00.000Z"),
      }),
      importJobRecord({
        id: olderImportJobId,
        status: "blocked",
        ok: false,
        createdAt: new Date("2026-05-24T10:01:00.000Z"),
        updatedAt: new Date("2026-05-24T10:01:00.000Z"),
        completedAt: new Date("2026-05-24T10:01:00.000Z"),
      }),
    ]);
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/import/jobs?status=succeeded&limit=1",
    });
    const statusResponse = await app.inject({
      method: "GET",
      url: `/api/admin/tenants/acme/import/jobs/${importJobId}`,
    });
    const blockedListResponse = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/import/jobs?status=blocked",
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      importJobs: [
        {
          id: importJobId,
          status: "succeeded",
          dryRun: true,
          sourceOrgId: orgId,
          sourceSlug: "acme",
          objectBytesMode: "metadata_only",
        },
      ],
      nextCursor: null,
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toMatchObject({
      importJob: {
        id: importJobId,
        resultSummary: {
          ok: true,
          plan: {
            source: { orgId, slug: "acme" },
          },
        },
      },
    });
    expect(blockedListResponse.statusCode).toBe(200);
    expect(blockedListResponse.json()).toMatchObject({
      importJobs: [
        {
          id: olderImportJobId,
          status: "blocked",
        },
      ],
    });
    await app.close();
  });

  it("rejects missing archive bodies before loading target state", async () => {
    let loadedTargetState = false;
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => {
        loadedTargetState = true;
        return { existingRowIds: [], existingNaturalKeys: [], primaryDomain: null };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/dry-run",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Tenant import dry-run requires a non-empty tar archive body.",
      code: "invalid_request",
    });
    expect(loadedTargetState).toBe(false);
    await app.close();
  });

  it("accepts dry-run conflict-policy query input", async () => {
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/dry-run?principalReferences=null&verifiedState=preserve&resourceReferences=preserve",
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(200);
    const body: ImportDryRunResponseBody = response.json();
    expect(body.ok).toBe(true);
    expect(body.plan.operations[0]).toMatchObject({
      table: "admin_domains",
      conflictPolicy: {
        rowId: "preserve",
        references: {
          createdBy: "null",
        },
        state: {
          verificationStatus: "preserve",
          verifiedAt: "preserve",
        },
      },
    });
    expect(body.plan.operations[2]).toMatchObject({
      table: "resource_classifications",
      conflictPolicy: {
        references: {
          actorId: "null",
        },
      },
    });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          hasConflictPolicyInput: true,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("accepts base64url remap query input while preserving the raw archive body", async () => {
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const auditRecords: unknown[] = [];
    const importJobs = new InMemoryTenantImportJobStore([]);
    const remaps = {
      principals: {
        [actorId]: targetActorId,
      },
      resources: {
        "mail.message:msg-1": "target-msg-1",
      },
    };
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tenants/acme/import/dry-run?remaps=${encodeQueryJson(remaps)}`,
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(200);
    const body: ImportDryRunResponseBody = response.json();
    expect(body.plan.operations[0]).toMatchObject({
      table: "admin_domains",
      remappedFields: {
        createdBy: targetActorId,
      },
    });
    expect(body.plan.operations[2]).toMatchObject({
      table: "resource_classifications",
      remappedFields: {
        actorId: targetActorId,
        resourceId: "target-msg-1",
      },
      action: "insert",
    });
    expect(body.importJob).toMatchObject({
      hasRemapInput: true,
      remapInputSummary: {
        principalCount: 1,
        resourceCount: 1,
      },
    });
    expect(String(body.importJob?.remapInputSummary?.["sha256"])).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(body.importJob)).not.toContain(targetActorId);
    expect(JSON.stringify(body.importJob)).not.toContain("target-msg-1");
    expect(importJobs.jobs[0]).toMatchObject({
      hasRemapInput: true,
      remapInputSummary: {
        principalCount: 1,
        resourceCount: 1,
      },
    });
    expect(importJobs.jobs[0]?.remapInputSummary.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(importJobs.jobs[0])).not.toContain(targetActorId);
    const auditJson = JSON.stringify(auditRecords);
    expect(auditJson).not.toContain(targetActorId);
    expect(auditJson).toMatch(/"remapInputSha256":"[a-f0-9]{64}"/u);
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          hasRemapInput: true,
          remapInputPrincipalCount: 1,
          remapInputResourceCount: 1,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("executes a gated tenant import and persists terminal execution history", async () => {
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const auditRecords: unknown[] = [];
    const importJobs = new InMemoryTenantImportJobStore([]);
    const rowApplyStore = new RecordingRowApplyStore();
    const objectStorage = new RecordingStorageClient();
    const remaps = {
      principals: {
        [actorId]: targetActorId,
      },
      resources: {
        "mail.message:msg-1": "target-msg-1",
      },
    };
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
      rowApplyStore,
      storageResolver: async () => ({
        client: objectStorage,
        managedBy: "helix-default",
        prefix: "tenants/acme/",
      }),
      auditContinuityStore: new InMemoryTenantImportAuditContinuityStore(),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tenants/acme/import/execute?confirm=EXECUTE_INTERNAL_TENANT_IMPORT&verifiedState=preserve&remaps=${encodeQueryJson(
        remaps,
      )}`,
      headers: { "content-type": "application/x-tar", "user-agent": "test-agent" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(200);
    expect(rowApplyStore.operations).toHaveLength(3);
    expect(objectStorage.puts).toEqual([]);
    expect(response.json()).toMatchObject({
      ok: true,
      execution: {
        status: "succeeded",
        stoppedAt: null,
        blockers: [],
        rowApply: {
          summary: {
            total: 3,
            inserted: 3,
          },
        },
        objectRestore: {
          summary: {
            total: 0,
          },
        },
        auditContinuity: {
          ok: true,
          markerAuditId: "audit-1",
          markerHash: "hash-1",
        },
      },
      importJob: {
        id: importJobId,
        status: "succeeded",
        dryRun: false,
        ok: true,
        hasRemapInput: true,
        resultSummary: {
          ok: true,
          execution: {
            status: "succeeded",
          },
        },
      },
    });
    expect(importJobs.jobs[0]).toMatchObject({
      dryRun: false,
      status: "succeeded",
      ok: true,
      resultSummary: {
        execution: {
          status: "succeeded",
        },
      },
    });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.import.audit_continuity.recorded",
        objectType: "tenant",
        objectId: orgId,
      }),
    );
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.import.execution.completed",
        objectType: "tenant",
        objectId: orgId,
        metadata: expect.objectContaining({
          slug: "acme",
          status: "succeeded",
          importJobId,
          hasRemapInput: true,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("roundtrips included export object bytes through gated import execute", async () => {
    const reportBytes = Buffer.from("report bytes", "utf8");
    const deckBytes = Buffer.from("deck bytes", "utf8");
    const sourceStorage = new RecordingStorageClient([
      {
        key: "drive/report.txt",
        body: reportBytes,
        contentType: "text/plain",
        metadata: { source: "drive" },
      },
      {
        key: "slides/deck-1/versions/2",
        body: deckBytes,
        contentType: "application/octet-stream",
      },
    ]);
    const archive = await buildTenantExportArchive(
      tenantExportManifest({
        objects: [
          {
            storageKey: "drive/report.txt",
            byteSize: reportBytes.byteLength,
            sha256: sha256Hex(reportBytes),
          },
          {
            storageKey: "slides/deck-1/versions/2",
            byteSize: deckBytes.byteLength,
            sha256: sha256Hex(deckBytes),
          },
        ],
      }),
      {
        includeObjectBytes: true,
        storageResolver: async () => ({
          client: sourceStorage,
          managedBy: "helix-default",
          prefix: "tenants/source/",
        }),
      },
    );
    const importJobs = new InMemoryTenantImportJobStore([]);
    const targetStorage = new RecordingStorageClient();
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
      rowApplyStore: new RecordingRowApplyStore(),
      storageResolver: async () => ({
        client: targetStorage,
        managedBy: "helix-default",
        prefix: "tenants/acme/",
      }),
      auditContinuityStore: new InMemoryTenantImportAuditContinuityStore(),
      auditSink: auditSink([]),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tenants/acme/import/execute?confirm=EXECUTE_INTERNAL_TENANT_IMPORT&verifiedState=preserve&remaps=${encodeQueryJson(
        executableRemaps(),
      )}`,
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(200);
    expect(sourceStorage.gets).toEqual(["drive/report.txt", "slides/deck-1/versions/2"]);
    expect(targetStorage.puts).toHaveLength(2);
    expect(targetStorage.puts).toEqual([
      expect.objectContaining({
        key: "drive/report.txt",
        contentType: "application/octet-stream",
        metadata: expect.objectContaining({
          "helix-import-source": "included-archive-bytes",
          "helix-import-source-key": "drive/report.txt",
          "helix-import-sha256": sha256Hex(reportBytes),
        }) as unknown,
      }),
      expect.objectContaining({
        key: "slides/deck-1/versions/2",
        contentType: "application/octet-stream",
        metadata: expect.objectContaining({
          "helix-import-source": "included-archive-bytes",
          "helix-import-source-key": "slides/deck-1/versions/2",
          "helix-import-sha256": sha256Hex(deckBytes),
        }) as unknown,
      }),
    ]);
    expect(Buffer.from(targetStorage.puts[0]?.body as Uint8Array).toString("utf8")).toBe(
      "report bytes",
    );
    expect(Buffer.from(targetStorage.puts[1]?.body as Uint8Array).toString("utf8")).toBe(
      "deck bytes",
    );
    expect(response.json()).toMatchObject({
      ok: true,
      plan: {
        objectBytes: {
          mode: "included",
          objectCount: 2,
          totalKnownBytes: reportBytes.byteLength + deckBytes.byteLength,
        },
      },
      execution: {
        status: "succeeded",
        objectRestore: {
          summary: {
            total: 2,
            restorable: 2,
            blocked: 0,
          },
        },
      },
      importJob: {
        dryRun: false,
        status: "succeeded",
        objectBytesMode: "included",
        resultSummary: {
          execution: {
            objectRestore: {
              summary: {
                total: 2,
                restorable: 2,
              },
            },
          },
        },
      },
    });
    expect(importJobs.jobs[0]).toMatchObject({
      dryRun: false,
      status: "succeeded",
      objectBytesMode: "included",
      resultSummary: {
        execution: {
          objectRestore: {
            summary: {
              total: 2,
              restorable: 2,
            },
          },
        },
      },
    });
    await app.close();
  });

  it("roundtrips self-fetch export object bytes through gated import execute", async () => {
    const reportBytes = Buffer.from("report bytes", "utf8");
    const deckBytes = Buffer.from("deck bytes", "utf8");
    const sourceStorage = new RecordingStorageClient();
    const archive = await buildTenantExportArchive(
      tenantExportManifest({
        objects: [
          {
            storageKey: "drive/report.txt",
            byteSize: reportBytes.byteLength,
            sha256: sha256Hex(reportBytes),
          },
          {
            storageKey: "slides/deck-1/versions/2",
            byteSize: deckBytes.byteLength,
            sha256: sha256Hex(deckBytes),
          },
        ],
      }),
      {
        includeObjectBytes: true,
        objectByteDelivery: "self-fetch",
        presignedUrlExpiresSeconds: 600,
        storageResolver: async () => ({
          client: sourceStorage,
          managedBy: "helix-default",
          prefix: "tenants/source/",
        }),
        now: () => new Date("2026-05-24T10:30:00.000Z"),
      },
    );
    const importJobs = new InMemoryTenantImportJobStore([]);
    const targetStorage = new RecordingStorageClient();
    const downloads: unknown[] = [];
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
      rowApplyStore: new RecordingRowApplyStore(),
      storageResolver: async () => ({
        client: targetStorage,
        managedBy: "helix-default",
        prefix: "tenants/acme/",
      }),
      auditContinuityStore: new InMemoryTenantImportAuditContinuityStore(),
      selfFetchDownloader: async (download) => {
        downloads.push(download);
        const body =
          download.storageKey === "drive/report.txt"
            ? reportBytes
            : download.storageKey === "slides/deck-1/versions/2"
              ? deckBytes
              : undefined;
        if (body === undefined) {
          throw new Error(`Unexpected self-fetch storage key: ${download.storageKey}.`);
        }
        return {
          body,
          contentType: "text/plain",
          metadata: {
            "helix-import-self-fetch-test": "ok",
          },
        };
      },
      auditSink: auditSink([]),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tenants/acme/import/execute?confirm=EXECUTE_INTERNAL_TENANT_IMPORT&verifiedState=preserve&remaps=${encodeQueryJson(
        executableRemaps(),
      )}`,
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(200);
    expect(sourceStorage.presignedGets).toEqual([
      { key: "drive/report.txt", expiresSeconds: 600 },
      { key: "slides/deck-1/versions/2", expiresSeconds: 600 },
    ]);
    expect(sourceStorage.gets).toEqual([]);
    expect(downloads).toEqual([
      {
        storageKey: "drive/report.txt",
        targetStorageKey: "drive/report.txt",
        url: "https://storage.example/drive%2Freport.txt?expires=600",
        expectedByteSize: reportBytes.byteLength,
        expectedSha256: sha256Hex(reportBytes),
      },
      {
        storageKey: "slides/deck-1/versions/2",
        targetStorageKey: "slides/deck-1/versions/2",
        url: "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=600",
        expectedByteSize: deckBytes.byteLength,
        expectedSha256: sha256Hex(deckBytes),
      },
    ]);
    expect(targetStorage.puts).toHaveLength(2);
    expect(targetStorage.puts).toEqual([
      expect.objectContaining({
        key: "drive/report.txt",
        contentType: "text/plain",
        metadata: expect.objectContaining({
          "helix-import-source": "self-fetch",
          "helix-import-source-key": "drive/report.txt",
          "helix-import-sha256": sha256Hex(reportBytes),
          "helix-import-self-fetch-test": "ok",
        }) as unknown,
      }),
      expect.objectContaining({
        key: "slides/deck-1/versions/2",
        contentType: "text/plain",
        metadata: expect.objectContaining({
          "helix-import-source": "self-fetch",
          "helix-import-source-key": "slides/deck-1/versions/2",
          "helix-import-sha256": sha256Hex(deckBytes),
          "helix-import-self-fetch-test": "ok",
        }) as unknown,
      }),
    ]);
    expect(Buffer.from(targetStorage.puts[0]?.body as Uint8Array).toString("utf8")).toBe(
      "report bytes",
    );
    expect(Buffer.from(targetStorage.puts[1]?.body as Uint8Array).toString("utf8")).toBe(
      "deck bytes",
    );
    expect(targetStorage.puts[0]?.metadata).not.toHaveProperty("helix-import-self-fetch-url");
    expect(targetStorage.puts[1]?.metadata).not.toHaveProperty("helix-import-self-fetch-url");
    expect(response.json()).toMatchObject({
      ok: true,
      plan: {
        objectBytes: {
          mode: "metadata_only",
          objectCount: 2,
          totalKnownBytes: reportBytes.byteLength + deckBytes.byteLength,
        },
      },
      execution: {
        status: "succeeded",
        objectRestore: {
          summary: {
            total: 2,
            restorable: 2,
            blocked: 0,
          },
          operations: expect.arrayContaining([
            expect.objectContaining({
              source: "self_fetch",
              action: "restore",
              storageKey: "drive/report.txt",
              selfFetchUrl: "https://storage.example/drive%2Freport.txt?expires=600",
            }),
            expect.objectContaining({
              source: "self_fetch",
              action: "restore",
              storageKey: "slides/deck-1/versions/2",
              selfFetchUrl: "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=600",
            }),
          ]) as unknown,
        },
      },
      importJob: {
        dryRun: false,
        status: "succeeded",
        objectBytesMode: "metadata_only",
        resultSummary: {
          execution: {
            objectRestore: {
              summary: {
                total: 2,
                restorable: 2,
              },
            },
          },
        },
      },
    });
    expect(importJobs.jobs[0]).toMatchObject({
      dryRun: false,
      status: "succeeded",
      objectBytesMode: "metadata_only",
      resultSummary: {
        execution: {
          objectRestore: {
            summary: {
              total: 2,
              restorable: 2,
            },
          },
        },
      },
    });
    await app.close();
  });

  it("blocks self-fetch import execute before writes when downloader is missing", async () => {
    const reportBytes = Buffer.from("report bytes", "utf8");
    const sourceStorage = new RecordingStorageClient();
    const archive = await buildTenantExportArchive(
      tenantExportManifest({
        objects: [
          {
            storageKey: "drive/report.txt",
            byteSize: reportBytes.byteLength,
            sha256: sha256Hex(reportBytes),
          },
        ],
      }),
      {
        includeObjectBytes: true,
        objectByteDelivery: "self-fetch",
        presignedUrlExpiresSeconds: 600,
        storageResolver: async () => ({
          client: sourceStorage,
          managedBy: "helix-default",
          prefix: "tenants/source/",
        }),
      },
    );
    const auditRecords: unknown[] = [];
    const importJobs = new InMemoryTenantImportJobStore([]);
    const rowApplyStore = new RecordingRowApplyStore();
    const targetStorage = new RecordingStorageClient();
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
      rowApplyStore,
      storageResolver: async () => ({
        client: targetStorage,
        managedBy: "helix-default",
        prefix: "tenants/acme/",
      }),
      auditContinuityStore: new InMemoryTenantImportAuditContinuityStore(),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tenants/acme/import/execute?confirm=EXECUTE_INTERNAL_TENANT_IMPORT&verifiedState=preserve&remaps=${encodeQueryJson(
        executableRemaps(),
      )}`,
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(422);
    expect(targetStorage.puts).toEqual([]);
    expect(rowApplyStore.operations).toEqual([]);
    expect(response.json()).toMatchObject({
      ok: false,
      execution: {
        status: "blocked",
        stoppedAt: "preflight",
        blockers: [
          expect.objectContaining({
            code: "self_fetch_downloader_required",
          }),
        ],
        rowApply: null,
        objectRestore: null,
        auditContinuity: null,
      },
      importJob: {
        dryRun: false,
        status: "blocked",
        ok: false,
        errorCode: "self_fetch_downloader_required",
        resultSummary: {
          execution: {
            status: "blocked",
            stoppedAt: "preflight",
          },
        },
      },
    });
    expect(importJobs.jobs[0]).toMatchObject({
      dryRun: false,
      status: "blocked",
      ok: false,
      errorCode: "self_fetch_downloader_required",
    });
    expect(auditRecords).not.toContainEqual(
      expect.objectContaining({
        verb: "tenant.import.audit_continuity.recorded",
      }),
    );
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.import.execution.completed",
        metadata: expect.objectContaining({
          status: "blocked",
          importJobId,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("rejects tenant import execute without confirmation before reading target state", async () => {
    let loadedTargetState = false;
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const importJobs = new InMemoryTenantImportJobStore([]);
    const rowApplyStore = new RecordingRowApplyStore();
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => {
        loadedTargetState = true;
        return { existingRowIds: [], existingNaturalKeys: [], primaryDomain: null };
      },
      importJobs,
      rowApplyStore,
      storageResolver: async () => ({
        client: new RecordingStorageClient(),
        managedBy: "helix-default",
        prefix: "tenants/acme/",
      }),
      auditContinuityStore: new InMemoryTenantImportAuditContinuityStore(),
      auditSink: auditSink([]),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/execute",
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Invalid tenant import execution query.",
      code: "invalid_request",
    });
    expect(loadedTargetState).toBe(false);
    expect(rowApplyStore.operations).toEqual([]);
    expect(importJobs.jobs).toEqual([]);
    await app.close();
  });

  it("fails execute configuration closed before target state or mutation work", async () => {
    let loadedTargetState = false;
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => {
        loadedTargetState = true;
        return { existingRowIds: [], existingNaturalKeys: [], primaryDomain: null };
      },
      importJobs: new InMemoryTenantImportJobStore([]),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/execute?confirm=EXECUTE_INTERNAL_TENANT_IMPORT",
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "Tenant import execution is not configured: audit sink is missing.",
      code: "invalid_request",
    });
    expect(loadedTargetState).toBe(false);
    await app.close();
  });

  it("persists blocked execute attempts without writing audit continuity markers", async () => {
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const auditRecords: unknown[] = [];
    const importJobs = new InMemoryTenantImportJobStore([]);
    const rowApplyStore = new RecordingRowApplyStore();
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
      importJobs,
      rowApplyStore,
      storageResolver: async () => ({
        client: new RecordingStorageClient(),
        managedBy: "helix-default",
        prefix: "tenants/acme/",
      }),
      auditContinuityStore: new InMemoryTenantImportAuditContinuityStore(),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/execute?confirm=EXECUTE_INTERNAL_TENANT_IMPORT",
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(422);
    expect(rowApplyStore.operations).toHaveLength(3);
    expect(response.json()).toMatchObject({
      ok: false,
      execution: {
        status: "blocked",
        stoppedAt: "row_apply",
        blockers: [
          expect.objectContaining({
            code: "row_apply_blocked",
          }),
        ],
      },
      importJob: {
        status: "blocked",
        dryRun: false,
        ok: false,
        errorCode: "row_apply_blocked",
        resultSummary: {
          ok: false,
          execution: {
            status: "blocked",
            stoppedAt: "row_apply",
          },
        },
      },
    });
    expect(importJobs.jobs[0]).toMatchObject({
      dryRun: false,
      status: "blocked",
      ok: false,
      errorCode: "row_apply_blocked",
    });
    expect(auditRecords).not.toContainEqual(
      expect.objectContaining({
        verb: "tenant.import.audit_continuity.recorded",
      }),
    );
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.import.execution.completed",
        metadata: expect.objectContaining({
          status: "blocked",
          importJobId,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("rejects invalid remap query input before loading target state", async () => {
    let loadedTargetState = false;
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => {
        loadedTargetState = true;
        return { existingRowIds: [], existingNaturalKeys: [], primaryDomain: null };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/tenants/acme/import/dry-run?remaps=${encodeQueryJson({ actors: {} })}`,
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Invalid tenant import remaps query.",
      code: "invalid_request",
    });
    expect(loadedTargetState).toBe(false);
    await app.close();
  });

  it("rejects invalid conflict-policy query before loading target state", async () => {
    let loadedTargetState = false;
    const archive = await buildTenantExportArchive(tenantExportManifest());
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import"),
      targetStateLoader: async () => {
        loadedTargetState = true;
        return { existingRowIds: [], existingNaturalKeys: [], primaryDomain: null };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/dry-run?principalReferences=delete",
      headers: { "content-type": "application/x-tar" },
      payload: archive.bytes,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Invalid tenant import conflict-policy query.",
      code: "invalid_request",
    });
    expect(loadedTargetState).toBe(false);
    await app.close();
  });

  it("forbids actors without tenant import scope or same-tenant access", async () => {
    const app = fastify();
    await registerTenantImportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor("admin.tenants.import", "99999999-9999-4999-8999-999999999999"),
      targetStateLoader: async () => ({
        existingRowIds: [],
        existingNaturalKeys: [],
        primaryDomain: null,
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/import/dry-run",
      headers: { "content-type": "application/x-tar" },
      payload: Buffer.from("not-a-real-tar"),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Tenant import permission denied.",
      code: "forbidden",
      requiredScope: "admin.tenants.import",
    });
    await app.close();
  });
});

function tenantExportManifest(
  input: {
    readonly objects?:
      | readonly {
          readonly storageKey: string;
          readonly byteSize?: number | undefined;
          readonly sha256?: string | undefined;
        }[]
      | undefined;
  } = {},
) {
  const chunks = [
    chunkFile({
      table: "admin_domains",
      path: "postgres/data/chunks/admin_domains/000000.jsonl",
      orderBy: ["lower(domain)", "created_at", "id"],
      rows: [
        {
          id: domainId,
          orgId,
          domain: "example.com",
          isPrimary: true,
          verificationStatus: "verified",
          verifiedAt: "2026-05-24T09:30:00.000Z",
          createdBy: actorId,
          createdAt: "2026-05-24T09:00:00.000Z",
          updatedAt: "2026-05-24T09:30:00.000Z",
        },
      ],
    }),
    chunkFile({
      table: "admin_dns_records",
      path: "postgres/data/chunks/admin_dns_records/000000.jsonl",
      orderBy: ["domain_id", "record_type", "host", "id"],
      rows: [
        {
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
        },
      ],
    }),
    chunkFile({
      table: "resource_classifications",
      path: "postgres/data/chunks/resource_classifications/000000.jsonl",
      orderBy: ["resource_type", "resource_id", "id"],
      rows: [
        {
          id: resourceClassificationId,
          orgId,
          resourceType: "mail.message",
          resourceId: "msg-1",
          classification: "confidential",
          source: "label",
          reason: "label:HR",
          actorId,
          createdAt: "2026-05-24T09:00:00.000Z",
          updatedAt: "2026-05-24T09:30:00.000Z",
        },
      ],
    }),
  ];
  return buildTenantExportManifest({
    org: orgRecord(),
    generatedAt: new Date("2026-05-24T10:00:00.000Z"),
    objects: input.objects ?? [],
    rowCounts: [],
    rowDataChunkFiles: chunks,
    auditSummary: {
      rowCount: 0,
      firstEntryAt: null,
      lastEntryAt: null,
    },
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

interface ImportDryRunResponseBody {
  readonly ok: boolean;
  readonly plan: {
    readonly operations: readonly Record<string, unknown>[];
  };
  readonly importJob?: {
    readonly remapInputSummary?: {
      readonly sha256?: string | null;
    };
  } & Record<string, unknown>;
}

function encodeQueryJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function executableRemaps() {
  return {
    principals: {
      [actorId]: targetActorId,
    },
    resources: {
      "mail.message:msg-1": "target-msg-1",
    },
  };
}

function importJobRecord(overrides: Partial<TenantImportJobRecord> = {}): TenantImportJobRecord {
  const createdAt = new Date("2026-05-24T10:00:00.000Z");
  return {
    id: importJobId,
    orgId,
    status: "succeeded",
    dryRun: true,
    requestedByActorId: actorId,
    archiveByteSize: 1024,
    archiveSha256: "a".repeat(64),
    hasConflictPolicyInput: false,
    conflictPolicy: {},
    hasRemapInput: false,
    remapInputSummary: { principalCount: 0, resourceCount: 0, sha256: null },
    ok: true,
    sourceOrgId: orgId,
    sourceSlug: "acme",
    sourceGeneratedAt: new Date("2026-05-24T09:30:00.000Z"),
    objectBytesMode: "metadata_only",
    issueCount: 0,
    operationCount: 3,
    conflictCount: 0,
    remapCount: 1,
    errorCode: null,
    errorMessage: null,
    resultSummary: {
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
          objectRows: 0,
          driveVersionRows: 0,
          resourceClassificationRows: 1,
          operationCount: 3,
          remapCount: 1,
          conflictCount: 0,
        },
        issueCount: 0,
        issues: [],
        conflictCount: 0,
        conflicts: [],
      },
    },
    completedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function orgRecord(): OrgRecord {
  return {
    id: orgId,
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "business",
    planId: "business",
    region: "us-east-1",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  };
}

class InMemoryOrgStore implements Pick<OrgStore, "findBySlug"> {
  readonly #orgs: readonly OrgRecord[];

  constructor(orgs: readonly OrgRecord[]) {
    this.#orgs = orgs;
  }

  async findBySlug(slug: string): Promise<OrgRecord | null> {
    return this.#orgs.find((org) => org.slug === slug) ?? null;
  }
}

class InMemoryTenantImportJobStore implements TenantImportJobStore {
  readonly jobs: TenantImportJobRecord[];

  constructor(jobs: readonly TenantImportJobRecord[]) {
    this.jobs = [...jobs];
  }

  async create(input: CreateTenantImportJobInput): Promise<TenantImportJobRecord> {
    const now = new Date("2026-05-24T10:05:00.000Z");
    const job = importJobRecord({
      id: importJobId,
      orgId: input.orgId,
      status: input.status ?? "succeeded",
      dryRun: input.dryRun ?? true,
      requestedByActorId: input.requestedByActorId ?? null,
      archiveByteSize: input.archiveByteSize,
      archiveSha256: input.archiveSha256,
      hasConflictPolicyInput: input.hasConflictPolicyInput,
      conflictPolicy: input.conflictPolicy,
      hasRemapInput: input.hasRemapInput ?? false,
      remapInputSummary: input.remapInputSummary ?? {
        principalCount: 0,
        resourceCount: 0,
        sha256: null,
      },
      ok: input.ok,
      sourceOrgId: input.sourceOrgId ?? null,
      sourceSlug: input.sourceSlug ?? null,
      sourceGeneratedAt: input.sourceGeneratedAt ?? null,
      objectBytesMode: input.objectBytesMode ?? null,
      issueCount: input.issueCount,
      operationCount: input.operationCount,
      conflictCount: input.conflictCount,
      remapCount: input.remapCount,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      resultSummary: input.resultSummary,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    this.jobs.unshift(job);
    return job;
  }

  async findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantImportJobRecord | null> {
    return this.jobs.find((job) => job.id === input.id && job.orgId === input.orgId) ?? null;
  }

  async listForOrg(input: ListTenantImportJobsInput): Promise<readonly TenantImportJobRecord[]> {
    return this.jobs
      .filter((job) => job.orgId === input.orgId)
      .filter((job) => input.status === undefined || job.status === input.status)
      .filter((job) => {
        if (input.cursor === undefined) {
          return true;
        }
        return (
          job.createdAt.getTime() < input.cursor.createdAt.getTime() ||
          (job.createdAt.getTime() === input.cursor.createdAt.getTime() && job.id < input.cursor.id)
        );
      })
      .sort((left, right) => {
        const byTime = right.createdAt.getTime() - left.createdAt.getTime();
        return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
      })
      .slice(0, input.limit ?? 50);
  }
}

class RecordingRowApplyStore implements TenantImportRowApplyStore {
  readonly operations: TenantImportRowApplyOperationInput[] = [];

  async applyOperation(
    input: TenantImportRowApplyOperationInput,
  ): Promise<TenantImportRowApplyOperationResult> {
    this.operations.push(input);
    const { operation } = input;
    if (operation.action === "blocked") {
      return {
        order: operation.order,
        kind: operation.kind,
        table: operation.table,
        sourceId: operation.sourceId,
        targetId: operation.targetId,
        action: "blocked",
        blockedReason: "planned_operation_blocked",
      };
    }
    return {
      order: operation.order,
      kind: operation.kind,
      table: operation.table,
      sourceId: operation.sourceId,
      targetId: operation.targetId ?? `target-${operation.sourceId}`,
      action: operation.action === "update" ? "updated" : "inserted",
    };
  }
}

class RecordingStorageClient implements TenantStorageClient {
  readonly gets: string[] = [];
  readonly presignedGets: { readonly key: string; readonly expiresSeconds: number | undefined }[] =
    [];
  readonly puts: StorageObject[] = [];
  readonly objects: Map<string, StorageObject>;

  constructor(objects: readonly StorageObject[] = []) {
    this.objects = new Map(objects.map((object) => [object.key, object]));
  }

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
    this.objects.set(object.key, object);
  }

  async get(key: string): Promise<StorageObject | null> {
    this.gets.push(key);
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignGetUrl(
    key: string,
    options?: { readonly expiresSeconds?: number | undefined },
  ): Promise<string> {
    this.presignedGets.push({ key, expiresSeconds: options?.expiresSeconds });
    return `https://storage.example/${encodeURIComponent(key)}?expires=${String(
      options?.expiresSeconds ?? "",
    )}`;
  }
}

class InMemoryTenantImportAuditContinuityStore implements TenantImportAuditContinuityStore {
  async getLatestAuditChainHead(): Promise<null> {
    return null;
  }
}

function actor(scope: string, actorOrgId = orgId): Actor {
  return {
    id: actorId,
    orgId: actorOrgId,
    type: "user",
    displayName: "Admin",
    scopes: [scope],
  };
}

function auditSink(records: unknown[]) {
  return {
    async append(record: unknown): Promise<{ readonly id: string; readonly thisHash: string }> {
      records.push(record);
      return { id: "audit-1", thisHash: "hash-1" };
    },
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
