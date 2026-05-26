import fastify from "fastify";
import type postgres from "postgres";
import type { Actor, StorageObject } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTenantHourlyQuotaLimiter } from "../limits/index.js";
import type { TenantStorageClient, TenantStorageResolver } from "../storage/index.js";
import {
  buildTenantExportArchive,
  buildTenantExportManifest,
  countTenantExportRows,
  summarizeTenantExportAudit,
  type TenantExportManifest,
} from "./export.js";
import { registerTenantExportRoutes } from "./export-routes.js";
import type { OrgRecord, OrgStore } from "./orgs.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const actorId = "11111111-1111-4111-8111-111111111111";

describe("tenant export archive", () => {
  it("builds a portable metadata archive without object bytes by default", async () => {
    const manifest = tenantExportManifest();

    const archive = await buildTenantExportArchive(manifest);
    const entries = parseTarEntries(archive.bytes);

    expect(archive).toMatchObject({
      filename: "helix-export-acme-20260524T100000Z.tar",
      contentType: "application/x-tar",
    });
    expect(Object.keys(entries).sort()).toEqual([
      "README.md",
      "audit-log/summary.json",
      "config-snapshot.json",
      "manifest.json",
      "objects/inventory.json",
      "postgres/data/row-counts.json",
      "postgres/schema.sql",
      "secrets-public.json",
    ]);
    expect(JSON.parse(entries["manifest.json"] ?? "{}")).toMatchObject({
      version: 1,
      org: { slug: "acme" },
      objectInventory: { bytesIncluded: false, objectCount: 2 },
    });
    expect(entries["README.md"]).toContain("does not include object bytes");
    const serialized = archive.bytes.toString("utf8");
    expect(serialized).not.toContain("plaintext-secret");
    expect(serialized).not.toContain("report bytes");
  });

  it("packs object bytes from tenant-resolved storage when explicitly requested", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: asyncBytes("deck bytes") },
    ]);

    const archive = await buildTenantExportArchive(tenantExportManifest(), {
      includeObjectBytes: true,
      storageResolver: storageResolverFor(storage),
    });
    const entries = parseTarEntries(archive.bytes);

    expect(JSON.parse(entries["manifest.json"] ?? "{}")).toMatchObject({
      objectInventory: { bytesIncluded: true, objectCount: 2 },
    });
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes");
  });

  it("emits a self-fetch manifest with presigned object URLs when requested", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);

    const archive = await buildTenantExportArchive(tenantExportManifest(), {
      includeObjectBytes: true,
      objectByteDelivery: "self-fetch",
      presignedUrlExpiresSeconds: 600,
      storageResolver: storageResolverFor(storage),
      now: () => new Date("2026-05-24T10:30:00.000Z"),
    });
    const entries = parseTarEntries(archive.bytes);
    const manifest = JSON.parse(entries["objects/self-fetch-manifest.json"] ?? "{}") as {
      readonly delivery: string;
      readonly expiresAt: string;
      readonly expiresSeconds: number;
      readonly objects: readonly {
        readonly storageKey: string;
        readonly byteSize?: number;
        readonly sha256?: string;
        readonly url: string;
        readonly expiresAt: string;
      }[];
    };

    expect(JSON.parse(entries["manifest.json"] ?? "{}")).toMatchObject({
      objectInventory: { bytesIncluded: false, objectCount: 2 },
    });
    expect(entries["objects/drive/report.txt"]).toBeUndefined();
    expect(manifest).toMatchObject({
      delivery: "self-fetch",
      expiresAt: "2026-05-24T10:40:00.000Z",
      expiresSeconds: 600,
      objects: [
        {
          storageKey: "drive/report.txt",
          byteSize: 12,
          sha256: "abc",
          url: "https://storage.example/drive%2Freport.txt?expires=600",
          expiresAt: "2026-05-24T10:40:00.000Z",
        },
        {
          storageKey: "slides/deck-1/versions/2",
          byteSize: 23,
          sha256: "def",
          url: "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=600",
          expiresAt: "2026-05-24T10:40:00.000Z",
        },
      ],
    });
    expect(storage.gets).toEqual([]);
    expect(storage.presignedGets).toEqual([
      { key: "drive/report.txt", expiresSeconds: 600 },
      { key: "slides/deck-1/versions/2", expiresSeconds: 600 },
    ]);
  });
});

describe("tenant export SQL helpers", () => {
  it("counts tenant rows through committed org-scoped tables only", async () => {
    const recording = createRecordingSql([
      [
        { table_name: "activity", row_count: 4 },
        { table_name: "objects", row_count: 2 },
      ],
    ]);

    await expect(countTenantExportRows(recording.sql, orgId)).resolves.toEqual([
      { table: "activity", rowCount: 4 },
      { table: "objects", rowCount: 2 },
    ]);
    expect(recording.calls[0]?.text).toContain("from objects where org_id = ?");
    expect(recording.calls[0]?.text).toContain("from activity where org_id = ?");
    expect(recording.calls[0]?.text).toContain(
      "from tenant_storage_migration_jobs where org_id = ?",
    );
    expect(recording.calls[0]?.text).not.toContain("signup_email_verifications");
    expect(recording.calls[0]?.text).not.toContain("metering_events");
    expect(recording.calls[0]?.values.every((value) => value === orgId)).toBe(true);
  });

  it("summarizes tenant audit range without exposing activity payloads", async () => {
    const recording = createRecordingSql([
      [
        {
          row_count: 2,
          first_entry_at: new Date("2026-05-24T09:00:00.000Z"),
          last_entry_at: new Date("2026-05-24T09:30:00.000Z"),
        },
      ],
    ]);

    await expect(summarizeTenantExportAudit(recording.sql, orgId)).resolves.toEqual({
      rowCount: 2,
      firstEntryAt: "2026-05-24T09:00:00.000Z",
      lastEntryAt: "2026-05-24T09:30:00.000Z",
    });
    expect(recording.calls[0]?.text).toContain("from activity");
    expect(recording.calls[0]?.text).not.toContain("payload");
  });
});

describe("registerTenantExportRoutes", () => {
  it("returns a tenant export manifest and audits the planning event", async () => {
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
      headers: { "user-agent": "test-agent" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ manifest: tenantExportManifest() });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.export.planned",
        objectType: "tenant",
        objectId: orgId,
        metadata: expect.objectContaining({
          slug: "acme",
          objectCount: 2,
          totalKnownBytes: 35,
          tableCount: 1,
          auditRowCount: 2,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("returns a tenant export manifest with presigned self-fetch object delivery", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest?objectByteDelivery=self-fetch&presignedUrlExpiresSeconds=300",
      headers: { "user-agent": "test-agent" },
    });
    const body: {
      readonly manifest: TenantExportManifest;
      readonly delivery: {
        readonly delivery: string;
        readonly expiresSeconds: number;
        readonly objects: readonly { readonly storageKey: string; readonly url: string }[];
      };
    } = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.manifest).toEqual(tenantExportManifest());
    expect(body.delivery).toMatchObject({
      delivery: "self-fetch",
      expiresSeconds: 300,
      objects: [
        {
          storageKey: "drive/report.txt",
          url: "https://storage.example/drive%2Freport.txt?expires=300",
        },
        {
          storageKey: "slides/deck-1/versions/2",
          url: "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=300",
        },
      ],
    });
    expect(storage.gets).toEqual([]);
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.export.planned",
        metadata: expect.objectContaining({
          objectByteDelivery: "self-fetch",
          objectCount: 2,
          totalKnownBytes: 35,
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("returns a clear service error when self-fetch delivery cannot be presigned", async () => {
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(new NoPresignStorageClient()),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest?objectByteDelivery=self-fetch",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Tenant export storage does not support presigned object fetch.",
      code: "tenant_export_delivery_unavailable",
    });
    expect(auditRecords).toEqual([]);
    await app.close();
  });

  it("returns a tenant export tar archive with BYO/default object bytes when requested", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export?includeObjectBytes=true",
    });
    const entries = parseTarEntries(rawPayload(response));

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-tar");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="helix-export-acme-20260524T100000Z.tar"',
    );
    expect(entries["objects/drive/report.txt"]).toBe("report bytes");
    expect(entries["objects/slides/deck-1/versions/2"]).toBe("deck bytes");
    await app.close();
  });

  it("returns a tenant export tar archive with a presigned self-fetch object manifest", async () => {
    const storage = new MemoryStorageClient([
      { key: "drive/report.txt", body: Buffer.from("report bytes", "utf8") },
      { key: "slides/deck-1/versions/2", body: Buffer.from("deck bytes", "utf8") },
    ]);
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      storageResolver: storageResolverFor(storage),
      auditSink: auditSink(auditRecords),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export?includeObjectBytes=true&objectByteDelivery=self-fetch&presignedUrlExpiresSeconds=120",
    });
    const entries = parseTarEntries(rawPayload(response));
    const manifest = JSON.parse(entries["objects/self-fetch-manifest.json"] ?? "{}") as {
      readonly delivery: string;
      readonly expiresSeconds: number;
      readonly objects: readonly { readonly url: string }[];
    };

    expect(response.statusCode).toBe(200);
    expect(entries["objects/drive/report.txt"]).toBeUndefined();
    expect(manifest).toMatchObject({
      delivery: "self-fetch",
      expiresSeconds: 120,
    });
    expect(manifest.objects.map((object) => object.url)).toEqual([
      "https://storage.example/drive%2Freport.txt?expires=120",
      "https://storage.example/slides%2Fdeck-1%2Fversions%2F2?expires=120",
    ]);
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.exported",
        metadata: expect.objectContaining({
          bytesIncluded: false,
          objectByteDelivery: "self-fetch",
          filename: "helix-export-acme-20260524T100000Z.tar",
        }) as unknown,
      }),
    );
    await app.close();
  });

  it("rejects cross-tenant and non-admin export requests", async () => {
    const crossTenant = fastify();
    await registerTenantExportRoutes(crossTenant, {
      orgs: new InMemoryOrgStore([orgRecord({ id: otherOrgId })]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
    });
    const forbiddenCrossTenant = await crossTenant.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });
    await crossTenant.close();

    const nonAdmin = fastify();
    await registerTenantExportRoutes(nonAdmin, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor({ scopes: [] }),
      exportPlanner: () => tenantExportManifest(),
    });
    const forbiddenScope = await nonAdmin.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });

    expect(forbiddenCrossTenant.statusCode).toBe(403);
    expect(forbiddenScope.statusCode).toBe(403);
    await nonAdmin.close();
  });

  it("enforces export job quota before planning or reading storage", async () => {
    const publish = vi.fn(async () => undefined);
    const planner = vi.fn(() => tenantExportManifest());
    const storage = new MemoryStorageClient([]);
    const app = fastify();
    await registerTenantExportRoutes(app, {
      orgs: new InMemoryOrgStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: planner,
      storageResolver: storageResolverFor(storage),
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 0,
      events: { publish },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export?includeObjectBytes=true",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.json()).toMatchObject({
      code: "quota_exceeded",
      quota: "export_jobs_per_hour",
      limit: 0,
    });
    expect(planner).not.toHaveBeenCalled();
    expect(storage.gets).toEqual([]);
    expect(publish).toHaveBeenCalledWith(
      "quota.export_jobs.exceeded",
      expect.objectContaining({
        orgId,
        surface: "tenant.export.archive",
        metadata: { slug: "acme" },
      }),
      undefined,
    );
    await app.close();
  });
});

function tenantExportManifest(): TenantExportManifest {
  return buildTenantExportManifest({
    org: orgRecord(),
    generatedAt: new Date("2026-05-24T10:00:00.000Z"),
    objects: [
      { storageKey: "drive/report.txt", byteSize: 12, sha256: "abc" },
      { storageKey: "slides/deck-1/versions/2", byteSize: 23, sha256: "def" },
    ],
    rowCounts: [{ table: "activity", rowCount: 4 }],
    auditSummary: {
      rowCount: 2,
      firstEntryAt: "2026-05-24T09:00:00.000Z",
      lastEntryAt: "2026-05-24T09:30:00.000Z",
    },
  });
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

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    id: actorId,
    orgId,
    type: "user",
    scopes: ["admin.tenants.export"],
    ...overrides,
  };
}

class InMemoryOrgStore implements Pick<OrgStore, "findBySlug"> {
  constructor(private readonly orgs: readonly OrgRecord[]) {}

  async findBySlug(slug: string): Promise<OrgRecord | null> {
    return this.orgs.find((org) => org.slug === slug) ?? null;
  }
}

class MemoryStorageClient implements TenantStorageClient {
  readonly gets: string[] = [];
  readonly presignedGets: { readonly key: string; readonly expiresSeconds: number | undefined }[] =
    [];
  readonly objects: Map<string, StorageObject>;

  constructor(objects: readonly StorageObject[]) {
    this.objects = new Map(objects.map((object) => [object.key, object]));
  }

  async put(object: StorageObject): Promise<void> {
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

class NoPresignStorageClient implements TenantStorageClient {
  async put(): Promise<void> {
    return undefined;
  }

  async get(): Promise<StorageObject | null> {
    return null;
  }

  async delete(): Promise<void> {
    return undefined;
  }
}

function storageResolverFor(storage: TenantStorageClient): TenantStorageResolver {
  return () => ({
    client: storage,
    managedBy: "helix-default",
    prefix: `tenants/${orgId}/`,
  });
}

function auditSink(records: unknown[]) {
  return {
    async append(record: unknown): Promise<{ readonly id: string; readonly thisHash: string }> {
      records.push(record);
      return { id: "audit-1", thisHash: "hash-1" };
    },
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

async function* asyncBytes(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

function rawPayload(response: { readonly rawPayload?: Buffer; readonly payload: string }): Buffer {
  return response.rawPayload ?? Buffer.from(response.payload, "binary");
}

function parseTarEntries(buffer: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= buffer.byteLength; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeOctal = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeOctal, 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    entries[name] = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}
