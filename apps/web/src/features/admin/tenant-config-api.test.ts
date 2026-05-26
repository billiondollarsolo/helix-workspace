import { describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import { fetchTenantConfig, testByoStorage, updateTenantConfig } from "./tenant-config-api";

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
