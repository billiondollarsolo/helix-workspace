import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import type {
  CreateTenantStorageMigrationJobInput,
  TenantStorageMigrationJobRecord,
  TenantStorageMigrationJobStore,
} from "../storage/index.js";
import type { OrgRecord, UpdateTenantConfigInput } from "../tenancy/orgs.js";
import type { PlanRecord, PlanStore } from "../tenancy/plans.js";
import { registerTenantConfigAdminRoutes, type TenantConfigAdminStore } from "./tenant-config.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

function headers(scopes: string): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}

function body(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

describe("tenant config admin routes", () => {
  it("returns the actor org tenant config", async () => {
    const store = new InMemoryTenantConfigAdminStore();
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      plans: new InMemoryPlanStore(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/tenant-config",
      headers: headers("admin.console.read"),
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      tenantConfig: {
        orgId,
        byo: {},
        features: { ai_smart_compose: false },
        quotas: { api_rps_limit: 5 },
        branding: {},
        plan: {
          id: "business",
          displayName: "Business",
          featureFlagsDefault: { ai_smart_compose: true, byo_storage: true },
          quotasDefault: { api_rps_limit: 25, actors_limit: 500 },
        },
        effective: {
          byo: {},
          features: { ai_smart_compose: false, byo_storage: true },
          quotas: { api_rps_limit: 5, actors_limit: 500 },
          branding: {},
        },
      },
    });
    await app.close();
  });

  it("validates and updates tenant config sections through the audited store method", async () => {
    const store = new InMemoryTenantConfigAdminStore();
    const auditRecords: unknown[] = [];
    const featureFlagEvents: unknown[] = [];
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      auditSink: {
        async append(record) {
          auditRecords.push(record);
          return { id: "audit-1", thisHash: "hash-1" };
        },
      },
      featureFlagEvents: {
        async publish(subject, payload) {
          featureFlagEvents.push({ subject, payload });
        },
      },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/tenant-config",
      headers: headers("admin.console.write"),
      payload: {
        // The feature flag can arrive in the same PATCH as the config so
        // onboarding can enable BYO storage atomically.
        features: { ai_smart_compose: true, dlp_enforcement: "warn", byo_storage: true },
        byo: {
          storage: {
            kind: "byo",
            provider: "s3-compatible",
            endpoint: "https://storage.example.com",
            region: "us-east-1",
            bucket: "acme-helix-data",
            prefix: "helix/",
            credentials_vault_path: "tenants/acme/byo-storage/s3",
            encryption: {
              sse_kms_key_arn: "arn:aws:kms:us-east-1:123456789012:key/acme",
            },
          },
        },
        quotas: { api_rps_limit: 10, actors_limit: null },
        branding: { accent_color_hex: "#2f6fed", display_name_override: "Acme" },
        reason: "admin settings update",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(store.updates).toEqual([
      {
        orgId,
        byoConfig: {
          storage: {
            kind: "byo",
            provider: "s3-compatible",
            endpoint: "https://storage.example.com",
            region: "us-east-1",
            bucket: "acme-helix-data",
            prefix: "helix/",
            credentials_vault_path: "tenants/acme/byo-storage/s3",
            encryption: {
              sse_kms_key_arn: "arn:aws:kms:us-east-1:123456789012:key/acme",
            },
          },
        },
        featureFlags: { ai_smart_compose: true, dlp_enforcement: "warn", byo_storage: true },
        quotas: { api_rps_limit: 10, actors_limit: null },
        branding: { accent_color_hex: "#2f6fed", display_name_override: "Acme" },
        changedByActorId: actorId,
        reason: "admin settings update",
      },
    ]);
    expect(body(response)).toMatchObject({
      tenantConfig: {
        byo: {
          storage: {
            kind: "byo",
            provider: "s3-compatible",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/s3",
          },
        },
        features: { ai_smart_compose: true, dlp_enforcement: "warn", byo_storage: true },
        quotas: { api_rps_limit: 10, actors_limit: null },
        branding: { accent_color_hex: "#2f6fed", display_name_override: "Acme" },
      },
    });
    expect(auditRecords).toEqual([
      expect.objectContaining({
        verb: "admin.tenant_config.updated",
        objectType: "tenant_config",
        objectId: orgId,
        metadata: { sections: ["byo", "features", "quotas", "branding"] },
      }),
    ]);
    expect(featureFlagEvents).toEqual([
      {
        subject: `flags.changed.${orgId}`,
        payload: {
          orgId,
          changedByActorId: actorId,
          reason: "admin settings update",
          keys: ["ai_smart_compose", "byo_storage", "dlp_enforcement"],
        },
      },
    ]);
    await app.close();
  });

  it("rejects plaintext BYO storage credentials in tenant config updates", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/tenant-config",
      headers: headers("admin.console.write"),
      payload: {
        byo: {
          storage: {
            kind: "byo",
            provider: "s3-compatible",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/s3",
            accessKeyId: "plaintext-access-key",
            secretAccessKey: "plaintext-secret-key",
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(body(response).code).toBe("invalid_request");
    expect(JSON.stringify(body(response))).toContain("Unrecognized key");
    await app.close();
  });

  it("requires the BYO storage feature before accepting BYO storage config", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/tenant-config",
      headers: headers("admin.console.write"),
      payload: {
        byo: {
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(body(response).error).toBe("BYO storage is not enabled for this tenant.");
    await app.close();
  });

  it("rejects unsupported BYO storage providers and unsafe prefixes", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/tenant-config",
      headers: headers("admin.console.write"),
      payload: {
        features: { byo_storage: true },
        byo: {
          storage: {
            kind: "byo",
            provider: "azure-blob",
            bucket: "acme-helix-data",
            prefix: "../escape",
            credentials_vault_path: "platform/root",
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    const serialized = JSON.stringify(body(response));
    expect(serialized).toContain("Invalid enum value");
    expect(serialized).toContain("Storage prefix must not contain");
    expect(serialized).toContain("credentials_vault_path");
    await app.close();
  });

  it("rejects invalid tenant config updates", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/tenant-config",
      headers: headers("admin.console.write"),
      payload: {
        quotas: { api_rps_limit: -1 },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(body(response).code).toBe("invalid_request");
    await app.close();
  });

  it("requires write scope to update tenant config", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/tenant-config",
      headers: headers("admin.console.read"),
      payload: { features: { ai_smart_compose: true } },
    });

    expect(response.statusCode).toBe(403);
    expect(body(response).requiredScope).toBe("admin.console.write");
    await app.close();
  });

  it("tests configured tenant storage with a write-read-delete probe", async () => {
    const store = new InMemoryTenantConfigAdminStore();
    const storage = new RecordingStorageClient();
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageResolver: async ({ orgId: resolvedOrgId }) => {
        expect(resolvedOrgId).toBe(orgId);
        return {
          client: storage,
          managedBy: "byo",
          prefix: "helix/",
        };
      },
      auditSink: {
        async append(record) {
          auditRecords.push(record);
          return { id: "audit-storage-test", thisHash: "hash-storage-test" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/test",
      headers: headers("admin.console.write"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      health: {
        status: "healthy",
        message: "Tenant object storage write/read/delete probe succeeded.",
        managedBy: "byo",
        prefix: "helix/",
      },
    });
    expect(storage.calls.map((call) => call.split(":")[0])).toEqual(["put", "get", "delete"]);
    expect(auditRecords).toEqual([
      expect.objectContaining({
        verb: "admin.tenant_config.byo_storage_tested",
        objectType: "tenant_config",
        objectId: orgId,
        metadata: { status: "healthy", managedBy: "byo" },
      }),
    ]);
    await app.close();
  });

  it("returns degraded storage health when tenant storage is unavailable", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
      storageResolver: async () => undefined,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/test",
      headers: headers("admin.console.write"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      health: {
        status: "degraded",
        message: "Tenant object storage is not configured.",
      },
    });
    await app.close();
  });

  it("requires write scope to test BYO storage", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
      storageResolver: async () => ({
        client: new RecordingStorageClient(),
        managedBy: "helix-default",
        prefix: "",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/test",
      headers: headers("admin.console.read"),
    });

    expect(response.statusCode).toBe(403);
    expect(body(response).requiredScope).toBe("admin.console.write");
    await app.close();
  });

  it("queues a tenant storage migration job and exposes status", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const auditRecords: unknown[] = [];
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
      storageMigrationJobs,
      auditSink: {
        async append(record) {
          auditRecords.push(record);
          return { id: "audit-migration", thisHash: "hash-migration" };
        },
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.write"),
      payload: { target: "byo", dryRun: true },
    });
    const jobId = storageMigrationJobs.jobs[0]?.id ?? "";
    const status = await app.inject({
      method: "GET",
      url: `/api/admin/tenant-config/byo-storage/migrations/${jobId}`,
      headers: headers("admin.console.read"),
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({
      migration: {
        id: jobId,
        orgId,
        target: "byo",
        status: "queued",
        dryRun: true,
        sourceStorage: {
          managedBy: "helix-default",
          storage: null,
        },
        targetStorage: {
          managedBy: "byo",
          storage: null,
        },
      },
    });
    expect(storageMigrationJobs.creates).toEqual([
      {
        orgId,
        target: "byo",
        dryRun: true,
        requestedByActorId: actorId,
        sourceStorage: {
          managedBy: "helix-default",
          storage: null,
        },
        targetStorage: {
          managedBy: "byo",
          storage: null,
        },
      },
    ]);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      migration: {
        id: jobId,
        status: "queued",
        targetStorage: {
          managedBy: "byo",
          storage: null,
        },
      },
    });
    expect(auditRecords).toEqual([
      expect.objectContaining({
        verb: "admin.tenant_config.byo_storage_migration_requested",
        objectType: "tenant_storage_migration_job",
        objectId: jobId,
        metadata: { target: "byo", dryRun: true },
      }),
    ]);
    await app.close();
  });

  it("captures staged target storage on dry-run migration jobs without changing tenant config", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const store = new InMemoryTenantConfigAdminStore();
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageMigrationJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.write"),
      payload: {
        target: "byo",
        dryRun: true,
        targetStorage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-helix-data",
          credentials_vault_path: "tenants/acme/byo-storage/aws",
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(storageMigrationJobs.creates[0]).toMatchObject({
      targetStorage: {
        managedBy: "byo",
        storage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-helix-data",
          credentials_vault_path: "tenants/acme/byo-storage/aws",
        },
      },
    });
    expect(response.json()).toMatchObject({
      migration: {
        targetStorage: {
          managedBy: "byo",
          storage: {
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
      },
    });
    expect(store.updates).toEqual([]);
    await app.close();
  });

  it("creates live BYO migration jobs when the BYO target snapshot is staged", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const store = new InMemoryTenantConfigAdminStore();
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageMigrationJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.write"),
      payload: {
        target: "byo",
        dryRun: false,
        targetStorage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-helix-data",
          credentials_vault_path: "tenants/acme/byo-storage/aws",
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      migration: {
        target: "byo",
        dryRun: false,
        sourceStorage: {
          managedBy: "helix-default",
          storage: null,
        },
        targetStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
      },
    });
    expect(storageMigrationJobs.creates).toMatchObject([
      {
        dryRun: false,
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
      },
    ]);
    expect(store.updates).toEqual([]);
    await app.close();
  });

  it("rejects live BYO migration jobs without a staged BYO target snapshot", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
      storageMigrationJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.write"),
      payload: { target: "byo", dryRun: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "conflict",
      error: "Live migration to BYO requires a staged BYO target storage config.",
    });
    expect(storageMigrationJobs.creates).toEqual([]);
    await app.close();
  });

  it("creates live rollback jobs when the BYO source snapshot is staged", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const store = new InMemoryTenantConfigAdminStore();
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageMigrationJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.write"),
      payload: {
        target: "helix-default",
        dryRun: false,
        sourceStorage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-helix-data",
          credentials_vault_path: "tenants/acme/byo-storage/aws",
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      migration: {
        target: "helix-default",
        dryRun: false,
        sourceStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
        targetStorage: {
          managedBy: "helix-default",
          storage: null,
        },
      },
    });
    expect(storageMigrationJobs.creates).toMatchObject([
      {
        dryRun: false,
        sourceStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
        targetStorage: { managedBy: "helix-default", storage: null },
      },
    ]);
    expect(store.updates).toEqual([]);
    await app.close();
  });

  it("rejects live rollback jobs without a staged BYO source snapshot", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
      storageMigrationJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.write"),
      payload: { target: "helix-default", dryRun: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "conflict",
      error:
        "Live migration to helix-default requires BYO source and helix-default target snapshots.",
    });
    expect(storageMigrationJobs.creates).toEqual([]);
    await app.close();
  });

  it("requires admin scopes and configured store for tenant storage migration jobs", async () => {
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store: new InMemoryTenantConfigAdminStore(),
      actorFromRequest,
    });

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.read"),
      payload: { target: "byo" },
    });
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations",
      headers: headers("admin.console.write"),
      payload: { target: "byo" },
    });

    expect(forbidden.statusCode).toBe(403);
    expect(unavailable.statusCode).toBe(503);
    await app.close();
  });

  it("cuts over a succeeded BYO storage migration into tenant config", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const store = new InMemoryTenantConfigAdminStore();
    const auditRecords: unknown[] = [];
    const featureFlagEvents: unknown[] = [];
    const targetStorage = {
      kind: "byo",
      provider: "aws-s3",
      bucket: "acme-helix-data",
      credentials_vault_path: "tenants/acme/byo-storage/aws",
    } as const;
    storageMigrationJobs.jobs.push(
      migrationJob({
        target: "byo",
        status: "succeeded",
        dryRun: false,
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: { managedBy: "byo", storage: targetStorage },
        plannedCount: 3,
        copiedCount: 3,
        verifiedCount: 3,
        completedAt: new Date("2026-05-24T10:05:00.000Z"),
      }),
    );
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageMigrationJobs,
      auditSink: {
        async append(record) {
          auditRecords.push(record);
          return { id: "audit-cutover", thisHash: "hash-cutover" };
        },
      },
      featureFlagEvents: {
        async publish(subject, payload) {
          featureFlagEvents.push({ subject, payload });
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations/33333333-3333-4333-8333-333333333333/cutover",
      headers: headers("admin.console.write"),
      payload: { confirm: "CUTOVER" },
    });

    expect(response.statusCode).toBe(200);
    expect(store.updates).toEqual([
      {
        orgId,
        byoConfig: { storage: targetStorage },
        featureFlags: { ai_smart_compose: false, byo_storage: true },
        changedByActorId: actorId,
        reason: "tenant storage migration cutover: 33333333-3333-4333-8333-333333333333",
      },
    ]);
    expect(response.json()).toMatchObject({
      migration: { status: "succeeded", target: "byo" },
      tenantConfig: {
        byo: { storage: targetStorage },
        features: { ai_smart_compose: false, byo_storage: true },
      },
    });
    expect(auditRecords).toEqual([
      expect.objectContaining({
        verb: "admin.tenant_config.byo_storage_migration_cutover",
        objectType: "tenant_storage_migration_job",
        objectId: "33333333-3333-4333-8333-333333333333",
        metadata: { target: "byo", dryRun: false, status: "succeeded" },
      }),
    ]);
    expect(featureFlagEvents).toEqual([
      {
        subject: `flags.changed.${orgId}`,
        payload: {
          orgId,
          changedByActorId: actorId,
          reason: "tenant storage migration cutover: 33333333-3333-4333-8333-333333333333",
          keys: ["byo_storage"],
        },
      },
    ]);
    await app.close();
  });

  it("cuts over a rollback to Helix default storage with the tenant prefix", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore();
    const sourceStorage = {
      kind: "byo",
      provider: "aws-s3",
      bucket: "acme-helix-data",
      credentials_vault_path: "tenants/acme/byo-storage/aws",
    } as const;
    const store = new InMemoryTenantConfigAdminStore({
      byoConfig: { storage: sourceStorage },
      featureFlags: { ai_smart_compose: false, byo_storage: true },
    });
    storageMigrationJobs.jobs.push(
      migrationJob({
        target: "helix-default",
        status: "succeeded",
        dryRun: false,
        sourceStorage: { managedBy: "byo", storage: sourceStorage },
        targetStorage: { managedBy: "helix-default", storage: null },
        plannedCount: 2,
        copiedCount: 2,
        verifiedCount: 2,
        completedAt: new Date("2026-05-24T10:05:00.000Z"),
      }),
    );
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageMigrationJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations/33333333-3333-4333-8333-333333333333/cutover",
      headers: headers("admin.console.write"),
      payload: { confirm: "CUTOVER" },
    });

    expect(response.statusCode).toBe(200);
    expect(store.updates).toEqual([
      {
        orgId,
        byoConfig: { storage: { kind: "helix-default", prefix: `tenants/${orgId}/` } },
        changedByActorId: actorId,
        reason: "tenant storage migration cutover: 33333333-3333-4333-8333-333333333333",
      },
    ]);
    expect(response.json()).toMatchObject({
      tenantConfig: {
        byo: { storage: { kind: "helix-default", prefix: `tenants/${orgId}/` } },
      },
    });
    await app.close();
  });

  it("rejects storage migration cutover before the job is safe to cut over", async () => {
    const rejectedJobs = [
      migrationJob({
        id: "33333333-3333-4333-8333-333333333331",
        target: "byo",
        status: "dry_run",
        dryRun: true,
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
        plannedCount: 1,
        copiedCount: 1,
        verifiedCount: 1,
        completedAt: new Date("2026-05-24T10:05:00.000Z"),
      }),
      migrationJob({
        id: "33333333-3333-4333-8333-333333333332",
        target: "byo",
        status: "succeeded_with_errors",
        dryRun: false,
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
        plannedCount: 2,
        copiedCount: 2,
        verifiedCount: 1,
        failures: [{ storageKey: "docs/1", reason: "checksum mismatch" }],
        completedAt: new Date("2026-05-24T10:05:00.000Z"),
      }),
      migrationJob({
        id: "33333333-3333-4333-8333-333333333334",
        target: "byo",
        status: "succeeded",
        dryRun: false,
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-helix-data",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
        plannedCount: 2,
        copiedCount: 2,
        verifiedCount: 1,
        completedAt: new Date("2026-05-24T10:05:00.000Z"),
      }),
    ];
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore(rejectedJobs);
    const store = new InMemoryTenantConfigAdminStore();
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageMigrationJobs,
    });

    for (const job of rejectedJobs) {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/tenant-config/byo-storage/migrations/${job.id}/cutover`,
        headers: headers("admin.console.write"),
        payload: { confirm: "CUTOVER" },
      });
      expect(response.statusCode).toBe(409);
    }
    expect(store.updates).toEqual([]);
    await app.close();
  });

  it("rejects storage migration cutover when the source snapshot is stale", async () => {
    const storageMigrationJobs = new InMemoryTenantStorageMigrationJobStore([
      migrationJob({
        target: "helix-default",
        status: "succeeded",
        dryRun: false,
        sourceStorage: {
          managedBy: "byo",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "old-bucket",
            credentials_vault_path: "tenants/acme/byo-storage/old",
          },
        },
        targetStorage: { managedBy: "helix-default", storage: null },
        plannedCount: 1,
        copiedCount: 1,
        verifiedCount: 1,
        completedAt: new Date("2026-05-24T10:05:00.000Z"),
      }),
    ]);
    const store = new InMemoryTenantConfigAdminStore({
      byoConfig: {
        storage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "new-bucket",
          credentials_vault_path: "tenants/acme/byo-storage/new",
        },
      },
    });
    const app = fastify();
    await registerTenantConfigAdminRoutes(app, {
      store,
      actorFromRequest,
      storageMigrationJobs,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/tenant-config/byo-storage/migrations/33333333-3333-4333-8333-333333333333/cutover",
      headers: headers("admin.console.write"),
      payload: { confirm: "CUTOVER" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "conflict",
      error: "Tenant storage config changed after the migration job was created.",
    });
    expect(store.updates).toEqual([]);
    await app.close();
  });
});

class InMemoryTenantConfigAdminStore implements TenantConfigAdminStore {
  readonly updates: UpdateTenantConfigInput[] = [];
  #org: OrgRecord | null;

  constructor(overrides: Partial<OrgRecord> = {}) {
    this.#org = {
      id: orgId,
      slug: "acme",
      displayName: "Acme",
      status: "active",
      tier: "business",
      planId: "business",
      region: "us-east-1",
      byoConfig: {},
      featureFlags: { ai_smart_compose: false },
      quotas: { api_rps_limit: 5 },
      branding: {},
      suspendedAt: null,
      softDeletedAt: null,
      hardDeletedAt: null,
      ...overrides,
    };
  }

  async findById(id: string): Promise<OrgRecord | null> {
    return id === this.#org?.id ? this.#org : null;
  }

  async updateTenantConfig(input: UpdateTenantConfigInput): Promise<OrgRecord | null> {
    this.updates.push(input);
    if (this.#org === null || input.orgId !== this.#org.id) {
      return null;
    }
    this.#org = {
      ...this.#org,
      ...(input.byoConfig === undefined ? {} : { byoConfig: input.byoConfig }),
      ...(input.featureFlags === undefined ? {} : { featureFlags: input.featureFlags }),
      ...(input.quotas === undefined ? {} : { quotas: input.quotas }),
      ...(input.branding === undefined ? {} : { branding: input.branding }),
    };
    return this.#org;
  }
}

class InMemoryPlanStore implements Pick<PlanStore, "findById"> {
  async findById(id: string): Promise<PlanRecord | null> {
    if (id !== "business") {
      return null;
    }
    return {
      id,
      displayName: "Business",
      featureFlagsDefault: { ai_smart_compose: true, byo_storage: true },
      quotasDefault: { api_rps_limit: 25, actors_limit: 500 },
    };
  }
}

class RecordingStorageClient {
  readonly calls: string[] = [];
  #objects = new Map<string, Uint8Array>();

  async put(object: { readonly key: string; readonly body: Uint8Array }): Promise<void> {
    this.calls.push(`put:${object.key}`);
    this.#objects.set(object.key, object.body);
  }

  async get(key: string): Promise<{ readonly key: string; readonly body: Uint8Array } | null> {
    this.calls.push(`get:${key}`);
    const body = this.#objects.get(key);
    return body === undefined ? null : { key, body };
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    this.#objects.delete(key);
  }
}

class InMemoryTenantStorageMigrationJobStore implements Pick<
  TenantStorageMigrationJobStore,
  "create" | "findByIdForOrg"
> {
  readonly creates: CreateTenantStorageMigrationJobInput[] = [];
  readonly jobs: TenantStorageMigrationJobRecord[];

  constructor(jobs: readonly TenantStorageMigrationJobRecord[] = []) {
    this.jobs = [...jobs];
  }

  async create(
    input: CreateTenantStorageMigrationJobInput,
  ): Promise<TenantStorageMigrationJobRecord> {
    this.creates.push(input);
    const job = migrationJob({
      id: "33333333-3333-4333-8333-333333333333",
      orgId: input.orgId,
      target: input.target,
      dryRun: input.dryRun === true,
      requestedByActorId: input.requestedByActorId ?? null,
      sourceStorage: input.sourceStorage ?? null,
      targetStorage: input.targetStorage ?? null,
    });
    this.jobs.push(job);
    return job;
  }

  async findByIdForOrg(input: {
    readonly id: string;
    readonly orgId: string;
  }): Promise<TenantStorageMigrationJobRecord | null> {
    return this.jobs.find((job) => job.id === input.id && job.orgId === input.orgId) ?? null;
  }
}

function migrationJob(
  overrides: Partial<TenantStorageMigrationJobRecord>,
): TenantStorageMigrationJobRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    orgId,
    target: "byo",
    status: "queued",
    dryRun: false,
    requestedByActorId: null,
    sourceStorage: null,
    targetStorage: null,
    plannedCount: 0,
    copiedCount: 0,
    verifiedCount: 0,
    failures: [],
    lastError: null,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-24T10:00:00.000Z"),
    updatedAt: new Date("2026-05-24T10:00:00.000Z"),
    ...overrides,
  };
}
