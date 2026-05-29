import fastify from "fastify";
import type postgres from "postgres";
import type {
  Actor,
  MeteringClient,
  MeteringEmitInput,
  MeteringEvent,
  TraceContext,
} from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { InMemoryTenantHourlyQuotaLimiter } from "../limits/index.js";
import type { CreateOrgInput, DefaultOrgInput, OrgRecord, OrgStore } from "./orgs.js";
import { TenantResolutionError, resolveTenantContext } from "./context.js";
import {
  buildTenantExportArchive,
  buildTenantExportManifest,
  countTenantExportRows,
  summarizeTenantExportAudit,
  type TenantExportManifest,
} from "./export.js";
import { registerTenantLifecycleRoutes, type TenantLifecycleStore } from "./lifecycle-routes.js";
import { installTenantContextHook } from "./middleware.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const otherOrgId = "33333333-3333-4333-8333-333333333333";
const actorId = "11111111-1111-4111-8111-111111111111";

describe("buildTenantExportManifest", () => {
  it("builds the portable manifest plan without row data or secrets", () => {
    const manifest = buildTenantExportManifest({
      org: orgRecord(),
      generatedAt: new Date("2026-05-24T10:00:00.000Z"),
      objects: [
        { storageKey: "drive/report.txt", byteSize: 12, sha256: "abc" },
        { storageKey: "previews/report.pdf" },
      ],
      rowCounts: [
        { table: "activity", rowCount: 4 },
        { table: "objects", rowCount: 2 },
      ],
      auditSummary: {
        rowCount: 4,
        firstEntryAt: "2026-05-24T09:00:00.000Z",
        lastEntryAt: "2026-05-24T09:30:00.000Z",
      },
    });

    expect(manifest).toEqual({
      version: 1,
      generatedAt: "2026-05-24T10:00:00.000Z",
      org: {
        id: orgId,
        slug: "acme",
        displayName: "Acme",
        status: "active",
        tier: "business",
        planId: "business",
        region: "us-east-1",
      },
      configSnapshot: {
        byoConfig: { storage: { kind: "helix-default" } },
        featureFlags: { byo_storage: true },
        quotas: { export_jobs_per_hour: 1 },
        branding: { display_name_override: "Acme" },
      },
      objectInventory: {
        includeBytesAvailable: true,
        objectCount: 2,
        totalKnownBytes: 12,
        objects: [
          { storageKey: "drive/report.txt", byteSize: 12, sha256: "abc" },
          { storageKey: "previews/report.pdf" },
        ],
      },
      postgres: {
        rowCounts: [
          { table: "activity", rowCount: 4 },
          { table: "objects", rowCount: 2 },
        ],
      },
      auditLog: {
        rowCount: 4,
        firstEntryAt: "2026-05-24T09:00:00.000Z",
        lastEntryAt: "2026-05-24T09:30:00.000Z",
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("secret");
  });
});

describe("buildTenantExportArchive", () => {
  it("packs the bounded export metadata as a tar archive without private data", () => {
    const manifest = tenantExportManifest();

    const archive = buildTenantExportArchive(manifest);
    const entries = parseTarEntries(archive.bytes);

    expect(archive).toMatchObject({
      filename: "helix-export-acme-20260524T100000Z.tar",
      contentType: "application/x-tar",
    });
    expect(archive.byteSize).toBe(archive.bytes.byteLength);
    expect(archive.byteSize % 512).toBe(0);
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
      objectInventory: { objectCount: 1 },
    });
    expect(entries["objects/inventory.json"]).toContain("drive/report.txt");
    expect(entries["README.md"]).toContain("does not include object bytes");
    const serialized = archive.bytes.toString("utf8");
    expect(serialized).not.toContain("token_hash");
    expect(serialized).not.toContain("private_key");
    expect(serialized).not.toContain("plaintext-secret");
  });
});

describe("tenant export SQL helpers", () => {
  it("counts tenant rows through an explicit org-scoped allowlist", async () => {
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
    expect(recording.calls[0]?.text).toContain("from admin_org_units where org_id = ?");
    expect(recording.calls[0]?.text).toContain("from notifications where org_id = ?");
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
    expect(recording.calls[0]?.text).toContain("where org_id = ?");
    expect(recording.calls[0]?.text).not.toContain("payload");
  });
});

describe("registerTenantLifecycleRoutes", () => {
  it("returns a bounded tenant export tar archive and audits the export event", async () => {
    const manifest = tenantExportManifest();
    const auditRecords: unknown[] = [];
    const metering = new RecordingMeteringClient();
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => manifest,
      auditSink: {
        async append(record) {
          auditRecords.push(record);
          return { id: "audit-1", thisHash: "hash-1" };
        },
      },
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 1,
      metering,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export",
      headers: {
        "user-agent": "test-agent",
        "x-forwarded-for": "203.0.113.10",
      },
    });
    const archiveBytes = rawPayload(response);
    const entries = parseTarEntries(archiveBytes);

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-tar");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="helix-export-acme-20260524T100000Z.tar"',
    );
    expect(response.headers["content-length"]).toBe(String(archiveBytes.byteLength));
    expect(JSON.parse(entries["manifest.json"] ?? "{}")).toMatchObject({
      version: 1,
      org: { slug: "acme" },
    });
    expect(JSON.parse(entries["config-snapshot.json"] ?? "{}")).toMatchObject({
      byoConfig: { storage: { kind: "helix-default" } },
    });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "tenant.exported",
        objectType: "tenant",
        objectId: orgId,
        metadata: expect.objectContaining({
          slug: "acme",
          filename: "helix-export-acme-20260524T100000Z.tar",
          byteSize: archiveBytes.byteLength,
        }) as unknown,
      }),
    );
    expect(metering.records).toEqual([
      {
        orgId,
        event: {
          type: "export.completed",
          quantity: 1,
          metadata: {
            surface: "tenant.export.archive",
            format: "tar",
            object_count: 1,
            total_known_bytes: 12,
            table_count: 1,
            audit_row_count: 2,
          },
        },
        trace: undefined,
      },
    ]);
    const serializedMetering = JSON.stringify(metering.records);
    expect(serializedMetering).not.toContain(actorId);
    expect(serializedMetering).not.toContain("test-agent");
    await app.close();
  });

  it("returns a tenant export manifest plan and audits the planning event", async () => {
    const manifest = tenantExportManifest();
    const auditRecords: unknown[] = [];
    const metering = new RecordingMeteringClient();
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: async (org) => {
        expect(org.id).toBe(orgId);
        return manifest;
      },
      auditSink: {
        async append(record) {
          auditRecords.push(record);
          return { id: "audit-1", thisHash: "hash-1" };
        },
      },
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 1,
      metering,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
      headers: {
        "user-agent": "test-agent",
        "x-forwarded-for": "203.0.113.10",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ manifest });
    expect(auditRecords).toHaveLength(1);
    const auditRecord = auditRecords[0] as {
      readonly orgId: string;
      readonly actorId: string;
      readonly verb: string;
      readonly objectType: string;
      readonly objectId: string;
      readonly metadata: Record<string, unknown>;
    };
    expect(auditRecord).toMatchObject({
      orgId,
      actorId,
      verb: "tenant.export.planned",
      objectType: "tenant",
      objectId: orgId,
    });
    expect(auditRecord.metadata).toMatchObject({
      slug: "acme",
      objectCount: 1,
      totalKnownBytes: 12,
      tableCount: 1,
      auditRowCount: 2,
    });
    expect(metering.records).toEqual([
      {
        orgId,
        event: {
          type: "export.completed",
          quantity: 1,
          metadata: {
            surface: "tenant.export.manifest",
            format: "manifest",
            object_count: 1,
            total_known_bytes: 12,
            table_count: 1,
            audit_row_count: 2,
          },
        },
        trace: undefined,
      },
    ]);
    const serializedMetering = JSON.stringify(metering.records);
    expect(serializedMetering).not.toContain(actorId);
    expect(serializedMetering).not.toContain("acme");
    expect(serializedMetering).not.toContain("Acme");
    expect(serializedMetering).not.toContain("drive/report.txt");
    expect(serializedMetering).not.toContain("business");
    expect(serializedMetering).not.toContain("us-east-1");
    expect(serializedMetering).not.toContain("203.0.113.10");
    expect(serializedMetering).not.toContain("test-agent");
    await app.close();
  });

  it("does not fail tenant export manifest planning when metering emission fails", async () => {
    const errors: unknown[] = [];
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: () => tenantExportManifest(),
      metering: new RecordingMeteringClient({ reject: true }),
      onMeteringError(error) {
        errors.push(error);
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });
    await Promise.resolve();

    expect(response.statusCode).toBe(200);
    expect(errors).toHaveLength(1);
    await app.close();
  });

  it("allows export manifest planning for soft-deleted tenants during grace", async () => {
    const manifest = tenantExportManifest({
      org: orgRecord({ status: "soft_deleted" }),
    });
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord({ status: "soft_deleted" })]),
      actorFromRequest: () => actor(),
      exportPlanner: async (org) => {
        expect(org.status).toBe("soft_deleted");
        return manifest;
      },
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 1,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ manifest });
    await app.close();
  });

  it("keeps suspended tenants exportable behind the tenant context hook", async () => {
    const store = new InMemoryTenantLifecycleStore([orgRecord({ status: "suspended" })]);
    const app = fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof TenantResolutionError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      throw error;
    });
    installTenantContextHook(app, {
      resolveTenantContext: (request) =>
        resolveTenantContext({
          config: { mode: "multi-tenant-saas" },
          orgs: store,
          request,
        }),
    });
    await registerTenantLifecycleRoutes(app, {
      orgs: store,
      actorFromRequest: () => actor(),
      exportPlanner: async (org) => {
        expect(org.status).toBe("suspended");
        return tenantExportManifest({ org });
      },
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 1,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
      headers: { host: "acme.helix.app" },
    });

    const body: {
      readonly manifest: { readonly org: { readonly status: string } };
    } = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.manifest.org.status).toBe("suspended");
    await app.close();
  });

  it("rejects cross-tenant and non-admin manifest requests", async () => {
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord({ id: otherOrgId })]),
      actorFromRequest: () => actor({ scopes: ["admin.tenants.export"] }),
      exportPlanner: () => tenantExportManifest(),
    });
    const forbiddenCrossTenant = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });
    await app.close();

    const nonAdmin = fastify();
    await registerTenantLifecycleRoutes(nonAdmin, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord()]),
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

  it("enforces export job quota before planning", async () => {
    const publish = vi.fn(async () => undefined);
    const planner = vi.fn(() => tenantExportManifest());
    const metering = new RecordingMeteringClient();
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: planner,
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 0,
      events: { publish },
      metering,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export/manifest",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.json()).toMatchObject({
      code: "quota_exceeded",
      quota: "export_jobs_per_hour",
      limit: 0,
    });
    expect(planner).not.toHaveBeenCalled();
    expect(metering.records).toEqual([]);
    expect(publish).toHaveBeenCalledWith(
      "quota.export_jobs.exceeded",
      expect.objectContaining({
        orgId,
        surface: "tenant.export.manifest",
        metadata: { slug: "acme" },
      }),
      undefined,
    );
    await app.close();
  });

  it("enforces export job quota before archive generation", async () => {
    const publish = vi.fn(async () => undefined);
    const planner = vi.fn(() => tenantExportManifest());
    const metering = new RecordingMeteringClient();
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord()]),
      actorFromRequest: () => actor(),
      exportPlanner: planner,
      exportJobLimiter: new InMemoryTenantHourlyQuotaLimiter(),
      exportJobLimit: () => 0,
      events: { publish },
      metering,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenants/acme/export",
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(response.json()).toMatchObject({
      code: "quota_exceeded",
      quota: "export_jobs_per_hour",
      limit: 0,
    });
    expect(planner).not.toHaveBeenCalled();
    expect(metering.records).toEqual([]);
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

  it("applies tenant lifecycle state transitions and audits the change", async () => {
    const store = new InMemoryTenantLifecycleStore([orgRecord()]);
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantLifecycleRoutes(app, {
      orgs: store,
      actorFromRequest: () => actor({ scopes: ["admin.tenants.write"] }),
      exportPlanner: () => tenantExportManifest(),
      auditSink: {
        async append(record) {
          auditRecords.push(record);
          return { id: "audit-1", thisHash: "hash-1" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/suspend",
      payload: { reason: "payment failed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tenant: {
        id: orgId,
        slug: "acme",
        status: "suspended",
      },
    });
    expect(store.actions).toEqual([{ slug: "acme", action: "suspend" }]);
    expect(auditRecords).toEqual([
      expect.objectContaining({
        verb: "tenant.lifecycle.suspended",
        objectType: "tenant",
        objectId: orgId,
        metadata: expect.objectContaining({
          previousStatus: "active",
          nextStatus: "suspended",
          reason: "payment failed",
        }) as unknown,
      }),
    ]);
    await app.close();
  });

  it("requires dedicated lifecycle scopes and reports invalid transitions", async () => {
    const readOnly = fastify();
    await registerTenantLifecycleRoutes(readOnly, {
      orgs: new InMemoryTenantLifecycleStore([orgRecord()]),
      actorFromRequest: () => actor({ scopes: ["admin.tenants.read"] }),
      exportPlanner: () => tenantExportManifest(),
    });
    const forbidden = await readOnly.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/suspend",
    });
    await readOnly.close();

    const invalidStore = new InMemoryTenantLifecycleStore([orgRecord({ status: "provisioning" })]);
    const invalid = fastify();
    await registerTenantLifecycleRoutes(invalid, {
      orgs: invalidStore,
      actorFromRequest: () => actor({ scopes: ["admin.tenants.write"] }),
      exportPlanner: () => tenantExportManifest(),
    });
    const conflictResponse = await invalid.inject({
      method: "POST",
      url: "/api/admin/tenants/acme/suspend",
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      code: "forbidden",
      requiredScope: "admin.tenants.write",
    });
    expect(conflictResponse.statusCode).toBe(409);
    await invalid.close();
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  return {
    sql: Object.assign(tag, {
      json: (value: unknown) => value,
      array: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
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

function tenantExportManifest(
  overrides: Partial<Parameters<typeof buildTenantExportManifest>[0]> = {},
): TenantExportManifest {
  return buildTenantExportManifest({
    org: orgRecord(),
    generatedAt: new Date("2026-05-24T10:00:00.000Z"),
    objects: [{ storageKey: "drive/report.txt", byteSize: 12 }],
    rowCounts: [{ table: "objects", rowCount: 1 }],
    auditSummary: {
      rowCount: 2,
      firstEntryAt: "2026-05-24T09:00:00.000Z",
      lastEntryAt: "2026-05-24T09:30:00.000Z",
    },
    ...overrides,
  });
}

function rawPayload(response: { readonly body: string; readonly rawPayload?: Buffer }): Buffer {
  return response.rawPayload ?? Buffer.from(response.body, "binary");
}

function parseTarEntries(bytes: Buffer): Record<string, string> {
  const entries: Record<string, string> = {};
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const name = bytes.toString("utf8", offset, offset + 100).replace(/\0.*$/u, "");
    if (name.length === 0) {
      break;
    }
    const sizeText = bytes
      .toString("ascii", offset + 124, offset + 136)
      .replace(/\0.*$/u, "")
      .trim();
    const size = Number.parseInt(sizeText, 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    entries[name] = bytes.toString("utf8", bodyStart, bodyEnd);
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

class InMemoryTenantLifecycleStore implements TenantLifecycleStore, OrgStore {
  readonly actions: { readonly slug: string; readonly action: string }[] = [];
  readonly #orgs = new Map<string, OrgRecord>();

  constructor(orgs: readonly OrgRecord[]) {
    for (const org of orgs) {
      this.#orgs.set(org.slug, org);
    }
  }

  async findBySlug(slug: string): Promise<OrgRecord | null> {
    return this.#orgs.get(slug) ?? null;
  }

  async createOrg(input: CreateOrgInput): Promise<OrgRecord> {
    const org = orgRecord({
      ...(input.id === undefined ? {} : { id: input.id }),
      slug: input.slug,
      displayName: input.displayName,
      status: input.status ?? "provisioning",
    });
    this.#orgs.set(org.slug, org);
    return org;
  }

  async getOrCreateDefaultOrg(input: DefaultOrgInput = {}): Promise<OrgRecord> {
    const existing = [...this.#orgs.values()][0];
    if (existing !== undefined) {
      return existing;
    }
    const org = orgRecord({
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.slug === undefined ? {} : { slug: input.slug }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.region === undefined ? {} : { region: input.region }),
    });
    this.#orgs.set(org.slug, org);
    return org;
  }

  async activateProvisionedOrg(id: string): Promise<OrgRecord | null> {
    const org = await this.findById(id);
    if (org === null) {
      return null;
    }
    const updated = orgRecord({ ...org, status: "active" });
    this.#orgs.set(updated.slug, updated);
    return updated;
  }

  async findById(id: string): Promise<OrgRecord | null> {
    return [...this.#orgs.values()].find((org) => org.id === id) ?? null;
  }

  async applyTenantLifecycleAction(input: {
    readonly slug: string;
    readonly action: "suspend" | "unsuspend" | "soft-delete" | "restore";
  }): Promise<OrgRecord | null> {
    this.actions.push(input);
    const org = this.#orgs.get(input.slug);
    if (org === undefined) {
      return null;
    }
    const nextStatus = nextStatusFor(input.action, org.status);
    if (nextStatus === null) {
      return null;
    }
    const updated = orgRecord({ ...org, status: nextStatus });
    this.#orgs.set(input.slug, updated);
    return updated;
  }
}

class RecordingMeteringClient implements MeteringClient {
  readonly records: Array<{
    readonly orgId: string;
    readonly event: MeteringEvent;
    readonly trace: TraceContext | undefined;
  }> = [];

  constructor(private readonly options: { readonly reject?: boolean } = {}) {}

  async emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void> {
    this.records.push({ orgId, event, trace });
    if (this.options.reject === true) {
      throw new Error("metering unavailable");
    }
  }

  async emitBatch(inputs: readonly MeteringEmitInput[]): Promise<void> {
    for (const input of inputs) {
      await this.emit(input.orgId, input.event, input.trace);
    }
  }
}

function nextStatusFor(
  action: "suspend" | "unsuspend" | "soft-delete" | "restore",
  status: OrgRecord["status"],
): OrgRecord["status"] | null {
  if (action === "suspend" && status === "active") {
    return "suspended";
  }
  if (action === "unsuspend" && status === "suspended") {
    return "active";
  }
  if (action === "soft-delete" && (status === "active" || status === "suspended")) {
    return "soft_deleted";
  }
  if (action === "restore" && status === "soft_deleted") {
    return "active";
  }
  return null;
}
