import { describe, expect, it } from "vitest";
import type { OrgRecord } from "./orgs.js";
import { buildEffectiveTenantConfig } from "./effective-config.js";

describe("buildEffectiveTenantConfig", () => {
  it("gives a new org every feature and unlimited quotas", () => {
    const effective = buildEffectiveTenantConfig({ org: org({}) });

    for (const [key, value] of Object.entries(effective.features)) {
      if (typeof value === "boolean") {
        expect({ key, value }).toEqual({ key, value: true });
      }
    }
    expect(effective.features.dlp_enforcement).toBe("off");
    expect(effective.features.watermark).toBe("off");
    expect(Object.keys(effective.quotas).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(effective.quotas)) {
      expect({ key, value }).toEqual({ key, value: null });
    }
  });

  it("merges system defaults and tenant overrides in precedence order", () => {
    const effective = buildEffectiveTenantConfig({
      org: org({
        featureFlags: {
          dlp_enforcement: "block",
          ai_smart_compose: false,
        },
        quotas: {
          actors_limit: 50,
        },
        branding: {
          accent_color_hex: "#2f6fed",
        },
      }),
    });

    expect(effective.features.ai_smart_compose).toBe(false);
    expect(effective.features.dlp_enforcement).toBe("block");
    expect(effective.features.assistant_retrieval).toBe(true);
    expect(effective.quotas.storage_bytes_limit).toBeNull();
    expect(effective.quotas.actors_limit).toBe(50);
    expect(effective.branding.accent_color_hex).toBe("#2f6fed");
  });

  it("applies per-request overrides above tenant config", () => {
    const effective = buildEffectiveTenantConfig({
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
