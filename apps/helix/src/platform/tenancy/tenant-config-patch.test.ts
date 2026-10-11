import { describe, expect, it } from "vitest";
import {
  applyTenantConfigPatch,
  FEATURE_FLAGS_PATCH,
  QUOTAS_PATCH,
  tenantConfigPatchParts,
} from "./tenant-config-patch.js";

describe("tenant config patches", () => {
  it("keeps unsubmitted flags and removes flags submitted as null", () => {
    const current = { mail_outbound: false, dlp_enforcement: "warn", ai_smart_compose: true };
    expect(
      applyTenantConfigPatch(current, { ai_smart_compose: false }, FEATURE_FLAGS_PATCH),
    ).toEqual({ mail_outbound: false, dlp_enforcement: "warn", ai_smart_compose: false });
    expect(applyTenantConfigPatch(current, { dlp_enforcement: null }, FEATURE_FLAGS_PATCH)).toEqual(
      { mail_outbound: false, ai_smart_compose: true },
    );
  });

  it("stores null quotas because null means unlimited", () => {
    expect(tenantConfigPatchParts({ actors_limit: null }, QUOTAS_PATCH)).toEqual({
      merge: { actors_limit: null },
      remove: [],
    });
    expect(
      applyTenantConfigPatch({ api_rps_limit: 5 }, { actors_limit: null }, QUOTAS_PATCH),
    ).toEqual({ api_rps_limit: 5, actors_limit: null });
  });
});
