import { describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import {
  cutoverTenantStorageMigration,
  fetchTenantConfig,
  fetchTenantStorageMigration,
  fetchTenantStorageMigrations,
  requestTenantStorageMigration,
  testByoStorage,
  updateTenantConfig,
} from "./tenant-config-api";

const tenantConfigPayload = {
  tenantConfig: {
    orgId: "org-1",
    byo: {},
    features: { ai_smart_compose: true },
    quotas: { api_rps_limit: 10 },
    branding: { display_name_override: "Acme" },
    plan: {
      id: "business",
      displayName: "Business",
      featureFlagsDefault: { ai_smart_compose: true },
      quotasDefault: { api_rps_limit: 25 },
    },
    effective: {
      byo: {},
      features: { ai_smart_compose: true },
      quotas: { api_rps_limit: 10 },
      branding: { display_name_override: "Acme" },
    },
  },
};

const migrationPayload = {
  migration: {
    id: "5f0951a7-8e65-4634-a6a4-af2f2b4797da",
    orgId: "org-1",
    target: "byo",
    status: "queued",
    dryRun: true,
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
        credentials_vault_path: "tenants/org-1/byo-storage/aws",
      },
    },
    plannedCount: 0,
    copiedCount: 0,
    verifiedCount: 0,
    failures: [],
    lastError: null,
    attemptCount: 0,
    requestedByActorId: "actor-1",
    startedAt: null,
    completedAt: null,
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T10:00:00.000Z",
  },
};

describe("tenant-config-api", () => {
  it("fetches tenant config from the admin endpoint", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json(tenantConfigPayload));

    const result = await fetchTenantConfig(fetchImpl);

    expect(result.orgId).toBe("org-1");
    expect(result.features.ai_smart_compose).toBe(true);
    expect(result.plan?.displayName).toBe("Business");
    expect(result.effective.quotas.api_rps_limit).toBe(10);
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/tenant-config", { method: "GET" });
  });

  it("updates only the provided tenant config sections", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json(tenantConfigPayload));

    await updateTenantConfig(
      {
        features: { ai_smart_compose: false },
        quotas: { api_rps_limit: 5 },
        reason: "test update",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/tenant-config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        features: { ai_smart_compose: false },
        quotas: { api_rps_limit: 5 },
        reason: "test update",
      }),
    });
  });

  it("tests BYO storage through the admin endpoint", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        health: {
          status: "healthy",
          checked_at: "2026-05-24T09:00:00.000Z",
          message: "Tenant object storage write/read/delete probe succeeded.",
          managedBy: "byo",
          prefix: "helix/",
        },
      }),
    );

    const result = await testByoStorage(fetchImpl);

    expect(result.status).toBe("healthy");
    expect(result.managedBy).toBe("byo");
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/tenant-config/byo-storage/test", {
      method: "POST",
    });
  });

  it("requests tenant storage migration jobs through the admin endpoint", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json(migrationPayload));

    const result = await requestTenantStorageMigration(
      {
        target: "byo",
        dryRun: true,
        targetStorage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-helix-data",
          credentials_vault_path: "tenants/org-1/byo-storage/aws",
        },
      },
      fetchImpl,
    );

    expect(result.id).toBe("5f0951a7-8e65-4634-a6a4-af2f2b4797da");
    expect(result.targetStorage?.managedBy).toBe("byo");
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/tenant-config/byo-storage/migrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: "byo",
        dryRun: true,
        targetStorage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-helix-data",
          credentials_vault_path: "tenants/org-1/byo-storage/aws",
        },
      }),
    });
  });

  it("fetches tenant storage migration status by id", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json(migrationPayload));

    const result = await fetchTenantStorageMigration(
      "5f0951a7-8e65-4634-a6a4-af2f2b4797da",
      fetchImpl,
    );

    expect(result.status).toBe("queued");
    expect(result.dryRun).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/admin/tenant-config/byo-storage/migrations/5f0951a7-8e65-4634-a6a4-af2f2b4797da",
      { method: "GET" },
    );
  });

  it("fetches tenant storage migration history", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        migrations: [
          migrationPayload.migration,
          {
            ...migrationPayload.migration,
            id: "6f0951a7-8e65-4634-a6a4-af2f2b4797db",
            status: "dry_run",
          },
        ],
        nextCursor: "cursor-2",
      }),
    );

    const result = await fetchTenantStorageMigrations(
      { limit: 10, cursor: " cursor-1 " },
      fetchImpl,
    );

    expect(result.migrations).toHaveLength(2);
    expect(result.nextCursor).toBe("cursor-2");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/admin/tenant-config/byo-storage/migrations?limit=10&cursor=cursor-1",
      { method: "GET" },
    );
  });

  it("cuts over tenant storage migration jobs through the admin endpoint", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        ...migrationPayload,
        tenantConfig: tenantConfigPayload.tenantConfig,
      }),
    );

    const result = await cutoverTenantStorageMigration(
      "5f0951a7-8e65-4634-a6a4-af2f2b4797da",
      fetchImpl,
    );

    expect(result.migration.id).toBe("5f0951a7-8e65-4634-a6a4-af2f2b4797da");
    expect(result.tenantConfig.orgId).toBe("org-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/admin/tenant-config/byo-storage/migrations/5f0951a7-8e65-4634-a6a4-af2f2b4797da/cutover",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "CUTOVER" }),
      },
    );
  });

  it("surfaces backend errors", async () => {
    const fetchImpl = vi
      .fn<AuthFetch>()
      .mockResolvedValue(
        Response.json({ error: "Invalid tenant config update." }, { status: 400 }),
      );

    await expect(fetchTenantConfig(fetchImpl)).rejects.toThrow("Invalid tenant config update.");
  });

  it("rejects malformed OK responses at the trust boundary", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json({ tenantConfig: {} }));

    await expect(fetchTenantConfig(fetchImpl)).rejects.toThrow("malformed response");
  });
});
