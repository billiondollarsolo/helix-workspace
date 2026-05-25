import { describe, expect, it } from "vitest";
import type { OrgRecord } from "./orgs.js";
import { buildEffectiveTenantConfig, type PlanRecord } from "./plans.js";

describe("buildEffectiveTenantConfig", () => {
  it("merges system defaults, plan defaults, and tenant overrides in precedence order", () => {
    const effective = buildEffectiveTenantConfig({
      plan: plan({
        featureFlagsDefault: {
          ai_smart_compose: true,
          dlp_enforcement: "warn",
        },
        quotasDefault: {
          actors_limit: 25,
          storage_bytes_limit: 50_000_000_000,
        },
      }),
      org: org({
        featureFlags: {
          dlp_enforcement: "block",
          byo_storage: true,
        },
        quotas: {
          actors_limit: 50,
        },
        branding: {
          accent_color_hex: "#2f6fed",
        },
      }),
    });

    expect(effective.features.ai_smart_compose).toBe(true);
    expect(effective.features.dlp_enforcement).toBe("block");
    expect(effective.features.byo_storage).toBe(true);
    expect(effective.quotas.storage_bytes_limit).toBe(50_000_000_000);
    expect(effective.quotas.actors_limit).toBe(50);
    expect(effective.branding.accent_color_hex).toBe("#2f6fed");
  });

  it("applies per-request overrides above tenant config", () => {
    const effective = buildEffectiveTenantConfig({
      plan: null,
      org: org({
        featureFlags: { ai_smart_compose: false },
        quotas: { export_jobs_per_hour: 10 },
      }),
      override: {
        features: { ai_smart_compose: true },
        quotas: { export_jobs_per_hour: 1 },
      },
    });

    expect(effective.features.ai_smart_compose).toBe(true);
    expect(effective.quotas.export_jobs_per_hour).toBe(1);
  });
});

function org(overrides: Partial<OrgRecord>): OrgRecord {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    slug: "default",
    displayName: "Default",
    status: "active",
    tier: "personal",
    planId: "personal",
    region: "default",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanRecord>): PlanRecord {
  return {
    id: "pro",
    displayName: "Pro",
    featureFlagsDefault: {},
    quotasDefault: {},
    ...overrides,
  };
}
