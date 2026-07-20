import { describe, expect, it } from "vitest";
import {
  tenantConfigSchema,
  SYSTEM_TENANT_FEATURE_FLAGS,
  SYSTEM_TENANT_CONFIG,
  SYSTEM_TENANT_QUOTAS,
} from "./tenant-config.js";

describe("tenant-config contract", () => {
  it("defaults every editors flag with sdk-types parity", () => {
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_document).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_spreadsheet).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_presentation).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_native_pdf).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.editors_ai_rag).toBe(false);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.mail_outbound).toBe(true);
    expect(SYSTEM_TENANT_FEATURE_FLAGS.support_tier).toBe("community");
  });

  it("parses a full tenant config object", () => {
    const parsed = tenantConfigSchema.parse(SYSTEM_TENANT_CONFIG);
    expect(parsed.features.editors_native_document).toBe(true);
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
