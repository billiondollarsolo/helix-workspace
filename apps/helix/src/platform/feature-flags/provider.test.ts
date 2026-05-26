import type { JsonObject, TenantConfig } from "@helix/sdk-types";
import { SYSTEM_TENANT_CONFIG } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { TenantConfigFeatureFlagProvider, readTenantFlag } from "./provider.js";

describe("TenantConfigFeatureFlagProvider", () => {
  it("reads flags from request effective tenant config", async () => {
    const provider = new TenantConfigFeatureFlagProvider({
      loadTenantConfig: async () => {
        throw new Error("loader should not run when request config is present");
      },
    });
    const tenantConfig = config({
      features: {
        ...SYSTEM_TENANT_CONFIG.features,
        ai_smart_compose: true,
        support_tier: "premium-4h",
      },
    });

    expect(provider.get("ai_smart_compose", false, { tenantConfig })).toBe(true);
    await expect(provider.getAsync("support_tier", "community", { tenantConfig })).resolves.toBe(
      "premium-4h",
    );
  });

  it("loads tenant config by org for async evaluation", async () => {
    const loadTenantConfig = vi.fn().mockResolvedValue(
      config({
        features: {
          ...SYSTEM_TENANT_CONFIG.features,
          editors_ai_rag: true,
        },
      }),
    );
    const provider = new TenantConfigFeatureFlagProvider({
      environment: "test",
      loadTenantConfig,
    });

    await expect(
      provider.getAsync("editors_ai_rag", false, { orgId: "org-1", actorId: "actor-1" }),
    ).resolves.toBe(true);
    expect(loadTenantConfig).toHaveBeenCalledWith({
      orgId: "org-1",
      context: { orgId: "org-1", actorId: "actor-1", environment: "test" },
    });
  });

  it("falls back to defaults for missing org context, missing flags, and type mismatches", async () => {
    const provider = new TenantConfigFeatureFlagProvider();

    expect(provider.get("ai_smart_compose", false)).toBe(false);
    await expect(provider.getAsync("ai_smart_compose", false)).resolves.toBe(false);
    expect(
      readTenantFlag(config({ features: { ai_smart_compose: "yes" } }), "ai_smart_compose", false),
    ).toBe(false);
  });
});

interface ConfigOverrides {
  readonly byo?: JsonObject;
  readonly features?: JsonObject;
  readonly quotas?: JsonObject;
  readonly branding?: JsonObject;
}

function config(overrides: ConfigOverrides): TenantConfig {
  return {
    ...SYSTEM_TENANT_CONFIG,
    features: {
      ...SYSTEM_TENANT_CONFIG.features,
      ...(overrides.features ?? {}),
    },
    quotas: {
      ...SYSTEM_TENANT_CONFIG.quotas,
      ...(overrides.quotas ?? {}),
    },
    branding: {
      ...SYSTEM_TENANT_CONFIG.branding,
      ...(overrides.branding ?? {}),
    },
    byo: {
      ...SYSTEM_TENANT_CONFIG.byo,
      ...(overrides.byo ?? {}),
    },
  };
}
