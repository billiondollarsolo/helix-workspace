import { describe, expect, it } from "vitest";
import { OPT_IN_TENANT_FEATURE_FLAGS } from "@helix/contracts";
import type { OrgRecord } from "./orgs.js";
import { buildEffectiveTenantConfig } from "./effective-config.js";

describe("buildEffectiveTenantConfig", () => {
  it("gives a new org the default flags and unlimited quotas", () => {
    const effective = buildEffectiveTenantConfig({ org: org({}) });

    for (const [key, value] of Object.entries(effective.features)) {
      const expected = !OPT_IN_TENANT_FEATURE_FLAGS.includes(key);
      expect({ key, value }).toEqual({ key, value: expected });
    }
    expect(Object.keys(effective.quotas).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(effective.quotas)) {
      expect({ key, value }).toEqual({ key, value: null });
    }
  });

  it("merges system defaults and tenant overrides in precedence order", () => {
    const effective = buildEffectiveTenantConfig({
      org: org({
        featureFlags: {
          calendar_import_invitations: true,
          assistant_retrieval: false,
        },
        quotas: {
          actors_limit: 50,
        },
        branding: {
          accent_color_hex: "#2f6fed",
        },
      }),
    });

    expect(effective.features.assistant_retrieval).toBe(false);
    expect(effective.features.calendar_import_invitations).toBe(true);
    expect(effective.features.mail_outbound).toBe(true);
    expect(effective.quotas.storage_bytes_limit).toBeNull();
    expect(effective.quotas.actors_limit).toBe(50);
    expect(effective.branding.accent_color_hex).toBe("#2f6fed");
  });

  it("applies per-request overrides above tenant config", () => {
    const effective = buildEffectiveTenantConfig({
      org: org({
        featureFlags: { assistant_retrieval: false },
        quotas: { export_jobs_per_hour: 10 },
      }),
      override: {
        features: { assistant_retrieval: true },
        quotas: { export_jobs_per_hour: 1 },
      },
    });

    expect(effective.features.assistant_retrieval).toBe(true);
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
