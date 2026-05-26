import { createHash } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  buildTenantExportArchive,
  buildTenantExportManifest,
  type TenantExportPostgresDataChunkFile,
} from "./export.js";
import { registerTenantImportRoutes } from "./import-routes.js";
import type {
  CreateTenantImportJobInput,
  ListTenantImportJobsInput,
  TenantImportJobRecord,
  TenantImportJobStore,
} from "./import-jobs.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const targetDomainId = "77777777-7777-4777-8777-777777777777";
const actorId = "11111111-1111-4111-8111-111111111111";
const domainId = "44444444-4444-4444-8444-444444444444";
const dnsRecordId = "55555555-5555-4555-8555-555555555555";
const resourceClassificationId = "66666666-6666-4666-8666-666666666666";
const importJobId = "88888888-8888-4888-8888-888888888888";
const olderImportJobId = "99999999-9999-4999-8999-999999999999";

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
        status: "failed",
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

function tenantExportManifest() {
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
    objects: [],
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
      requestedByActorId: input.requestedByActorId ?? null,
      archiveByteSize: input.archiveByteSize,
      archiveSha256: input.archiveSha256,
      hasConflictPolicyInput: input.hasConflictPolicyInput,
      conflictPolicy: input.conflictPolicy,
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
