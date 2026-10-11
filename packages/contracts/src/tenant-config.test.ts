import { describe, expect, it } from "vitest";
import {
  tenantConfigSchema,
  SYSTEM_TENANT_FEATURE_FLAGS,
  SYSTEM_TENANT_CONFIG,
  SYSTEM_TENANT_QUOTAS,
} from "./tenant-config.js";

describe("tenant-config contract", () => {
  it("turns every boolean feature on by default", () => {
    for (const [key, value] of Object.entries(SYSTEM_TENANT_FEATURE_FLAGS)) {
      // Calendar invitation import is an admin opt-in policy, not an entitlement.
      if (typeof value === "boolean" && key !== "calendar_import_invitations") {
        expect({ key, value }).toEqual({ key, value: true });
      }
    }
    expect(SYSTEM_TENANT_FEATURE_FLAGS.dlp_enforcement).toBe("off");
    expect(SYSTEM_TENANT_FEATURE_FLAGS.watermark).toBe("off");
    expect(SYSTEM_TENANT_FEATURE_FLAGS.calendar_import_invitations).toBe(false);
  });

  it("leaves every quota unlimited by default", () => {
    for (const value of Object.values(SYSTEM_TENANT_QUOTAS)) {
      expect(value).toBeNull();
    }
  });

  it("still parses stored configs that carry retired plan-era keys", () => {
    const parsed = tenantConfigSchema.parse({
      ...SYSTEM_TENANT_CONFIG,
      features: { ...SYSTEM_TENANT_FEATURE_FLAGS, b2b_sharing: false, support_tier: "community" },
    });
    expect(parsed.features.mail_outbound).toBe(true);
  });

  it("parses a full tenant config object", () => {
    const parsed = tenantConfigSchema.parse(SYSTEM_TENANT_CONFIG);
    expect(parsed.quotas.storage_bytes_limit).toBe(SYSTEM_TENANT_QUOTAS.storage_bytes_limit);
  });

  it("rejects missing required feature flags", () => {
    expect(() =>
      tenantConfigSchema.parse({
        byo: {},
        features: {},
        quotas: SYSTEM_TENANT_QUOTAS,
        branding: {},
      }),
    ).toThrow();
  });
});
