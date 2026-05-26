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
import type { OrgRecord, OrgStore } from "./orgs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const targetDomainId = "77777777-7777-4777-8777-777777777777";
const actorId = "11111111-1111-4111-8111-111111111111";
const domainId = "44444444-4444-4444-8444-444444444444";
const dnsRecordId = "55555555-5555-4555-8555-555555555555";
const resourceClassificationId = "66666666-6666-4666-8666-666666666666";

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
