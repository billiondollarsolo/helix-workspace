import { describe, expect, it } from "vitest";
import {
  tenantConfigSchema,
  SYSTEM_TENANT_FEATURE_FLAGS,
  SYSTEM_TENANT_CONFIG,
  SYSTEM_TENANT_QUOTAS,
} from "./tenant-config.js";

describe("tenant-config contract", () => {
  it("turns features on by default and leaves calendar invitation import opt-in", () => {
    for (const [key, value] of Object.entries(SYSTEM_TENANT_FEATURE_FLAGS)) {
      const expected = key !== "calendar_import_invitations";
      expect({ key, value }).toEqual({ key, value: expected });
    }
  });

  it("leaves every quota unlimited by default", () => {
    for (const value of Object.values(SYSTEM_TENANT_QUOTAS)) {
      expect(value).toBeNull();
    }
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
