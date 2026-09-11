import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { InMemorySecurityPoliciesStore } from "../admin/security-policies.js";
import {
  buildPlatformReadinessReport,
  PlatformConfigAdminService,
  PostgresPlatformConfigStore,
} from "./admin.js";

const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  scopes: ["admin.config.write"],
};

describe("operator MFA readiness", () => {
  it("retains tier defaults but reports explicit optional MFA honestly", () => {
    const config = { security: { tier: "enterprise" as const } };
    expect(
      buildPlatformReadinessReport(config).requirements.find((item) => item.key === "mfa"),
    ).toMatchObject({ required: true, expected: { scope: "org", source: "tier" } });
    const policy = {
      enabled: true,
      enforcement: "required" as const,
      settings: { adminMfa: "optional" },
    };
    const report = buildPlatformReadinessReport(config, undefined, policy);
    expect(report.requirements.find((item) => item.key === "mfa")).toMatchObject({
      required: false,
      status: "not_required",
      expected: { scope: "none", source: "policy" },
    });
    expect(report.requirements.find((item) => item.key === "encryptedBackups")?.required).toBe(
      true,
    );
  });
  it("uses the authenticated tenant's live operator choice for status and upgrade gates", async () => {
    const policies = new InMemorySecurityPoliciesStore();
    await policies.upsert({
      orgId: actor.orgId,
      policyType: "mfa",
      enabled: false,
      enforcement: "optional",
      settings: { adminMfa: "optional" },
      updatedBy: actor.id,
    });
    const store = new PostgresPlatformConfigStore(createRecordingSql([[], [], []], "$").sql);
    const service = new PlatformConfigAdminService(store, {}, undefined, policies);
    await expect(service.update({ security: { tier: "business" } }, actor)).rejects.toMatchObject({
      missingRequirements: ["encryptedBackups", "auditDestinations"],
    });
    const enterpriseService = new PlatformConfigAdminService(
      store,
      { HELIX_SECURITY_TIER: "enterprise" },
      undefined,
      policies,
    );
    expect(
      (await enterpriseService.getStatus(actor)).readiness.requirements.find(
        (item) => item.key === "mfa",
      )?.required,
    ).toBe(false);
    expect(
      (
        await enterpriseService.getStatus({
          ...actor,
          orgId: "33333333-3333-4333-8333-333333333333",
        })
      ).readiness.requirements.find((item) => item.key === "mfa")?.required,
    ).toBe(true);
  });
});
