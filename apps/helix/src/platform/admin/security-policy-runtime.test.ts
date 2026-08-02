import { describe, expect, it } from "vitest";
import {
  SECURITY_POLICY_RUNTIME_CAPABILITIES,
  evaluateExternalEmailSharePolicy,
  evaluateOrgAdminMfa,
  evaluatePublicShareLinkPolicy,
  parseExternalSharingPolicy,
  policyRuntimeCapability,
  policyRuntimeStatus,
  sessionExpiresInSecondsFromPolicy,
  validateRecordedOnlyRequiredEnforcement,
  validateSsoEnforcementRequest,
} from "./security-policy-runtime.js";
import type { SecurityPolicyType } from "./security-policy-runtime.js";
import { SECURITY_POLICY_TYPES } from "./security-policies.js";

const orgId = "22222222-2222-4222-8222-222222222222";

function policy(
  policyType: SecurityPolicyType,
  overrides: Partial<{
    enabled: boolean;
    enforcement: "disabled" | "optional" | "required";
    settings: Record<string, unknown>;
  }> = {},
) {
  return {
    id: `p-${policyType}`,
    orgId,
    policyType,
    enabled: true as boolean,
    enforcement: "required" as const,
    settings: {} as Record<string, unknown>,
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SECURITY_POLICY_RUNTIME_CAPABILITIES inventory (ADM.1)", () => {
  it("covers every security policy type exactly once", () => {
    expect(SECURITY_POLICY_RUNTIME_CAPABILITIES.map((entry) => entry.policyType).sort()).toEqual(
      [...SECURITY_POLICY_TYPES].sort(),
    );
  });

  it("marks external_sharing as enforced and SSO/DLP/device_trust as recorded_only", () => {
    expect(policyRuntimeCapability("external_sharing").mode).toBe("enforced");
    expect(policyRuntimeCapability("sso").mode).toBe("recorded_only");
    expect(policyRuntimeCapability("dlp").mode).toBe("recorded_only");
    expect(policyRuntimeCapability("device_trust").mode).toBe("recorded_only");
    expect(policyRuntimeCapability("mfa").mode).toBe("partial");
    expect(policyRuntimeCapability("session").mode).toBe("partial");
  });
});

describe("policyRuntimeStatus honest chips", () => {
  it("never labels recorded-only policies as Required when enabled", () => {
    for (const type of ["sso", "dlp", "device_trust"] as const) {
      const status = policyRuntimeStatus(policy(type, { enabled: true, enforcement: "required" }));
      expect(status.displayLevel).toBe("recorded");
      expect(status.displayLevelOn).toBe(false);
      expect(status.mode).toBe("recorded_only");
    }
  });

  it("labels enforced external_sharing required as Required", () => {
    const status = policyRuntimeStatus(
      policy("external_sharing", { enabled: true, enforcement: "required" }),
    );
    expect(status.displayLevel).toBe("required");
    expect(status.displayLevelOn).toBe(true);
  });

  it("labels partial MFA required as Active not Required", () => {
    const status = policyRuntimeStatus(policy("mfa", { enabled: true, enforcement: "required" }));
    expect(status.displayLevel).toBe("active");
    expect(status.mode).toBe("partial");
  });

  it("labels disabled policies Off", () => {
    expect(
      policyRuntimeStatus(policy("external_sharing", { enabled: false, enforcement: "required" }))
        .displayLevel,
    ).toBe("off");
  });
});

describe("evaluatePublicShareLinkPolicy (ADM.6)", () => {
  it("allows public links when policy is off", () => {
    expect(
      evaluatePublicShareLinkPolicy(policy("external_sharing", { enabled: false })),
    ).toEqual({ allowed: true, requireExpiry: false });
  });

  it("blocks public links when mode is blocked", () => {
    const decision = evaluatePublicShareLinkPolicy(
      policy("external_sharing", {
        settings: { mode: "blocked", allowedDomains: [], requireExpiry: false },
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("external_sharing_blocked");
    }
  });

  it("denies public links under allowlist mode", () => {
    const decision = evaluatePublicShareLinkPolicy(
      policy("external_sharing", {
        settings: {
          mode: "allowlist",
          allowedDomains: ["partner.example"],
          requireExpiry: false,
        },
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("external_sharing_domain_denied");
    }
  });

  it("requires expiry when anyone mode demands it", () => {
    const denied = evaluatePublicShareLinkPolicy(
      policy("external_sharing", {
        settings: { mode: "anyone", allowedDomains: [], requireExpiry: true },
      }),
      { expiresAt: null },
    );
    expect(denied.allowed).toBe(false);
    const allowed = evaluatePublicShareLinkPolicy(
      policy("external_sharing", {
        settings: { mode: "anyone", allowedDomains: [], requireExpiry: true },
      }),
      { expiresAt: new Date("2026-06-01T00:00:00.000Z") },
    );
    expect(allowed).toEqual({ allowed: true, requireExpiry: true });
  });
});

describe("evaluateExternalEmailSharePolicy", () => {
  it("denies email domains outside the allowlist", () => {
    const decision = evaluateExternalEmailSharePolicy(
      policy("external_sharing", {
        settings: {
          mode: "allowlist",
          allowedDomains: ["helix.example"],
          requireExpiry: false,
        },
      }),
      ["ok@helix.example", "no@evil.example"],
    );
    expect(decision.allowed).toBe(false);
  });

  it("allows emails on allowlisted domains including subdomains", () => {
    const decision = evaluateExternalEmailSharePolicy(
      policy("external_sharing", {
        settings: {
          mode: "allowlist",
          allowedDomains: ["helix.example"],
          requireExpiry: false,
        },
      }),
      ["a@helix.example", "b@mail.helix.example"],
    );
    expect(decision).toEqual({ allowed: true, requireExpiry: false });
  });

  it("parses defaults for missing policy", () => {
    expect(parseExternalSharingPolicy(null)).toMatchObject({
      enabled: false,
      mode: "anyone",
    });
  });
});

describe("evaluateOrgAdminMfa (ADM.2)", () => {
  const admin = {
    id: "a1",
    orgId,
    type: "user" as const,
    displayName: "Admin",
    scopes: ["admin.console.write"],
  };
  const user = {
    id: "u1",
    orgId,
    type: "user" as const,
    displayName: "User",
    scopes: ["mail.read"],
  };

  it("requires MFA on personal tier when org policy is required", () => {
    const decision = evaluateOrgAdminMfa({
      tier: "personal",
      actor: admin,
      mfaVerified: false,
      orgMfaPolicy: policy("mfa", { enabled: true, enforcement: "required" }),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("admin_mfa_required");
    }
  });

  it("still requires tier MFA on enterprise even without org policy", () => {
    const decision = evaluateOrgAdminMfa({
      tier: "enterprise",
      actor: admin,
      mfaVerified: false,
      orgMfaPolicy: null,
    });
    expect(decision.allowed).toBe(false);
  });

  it("does not apply org MFA required to non-admin actors", () => {
    expect(
      evaluateOrgAdminMfa({
        tier: "personal",
        actor: user,
        mfaVerified: false,
        orgMfaPolicy: policy("mfa", { enabled: true, enforcement: "required" }),
      }).allowed,
    ).toBe(true);
  });

  it("allows admins with verified MFA under org required policy", () => {
    expect(
      evaluateOrgAdminMfa({
        tier: "personal",
        actor: admin,
        mfaVerified: true,
        orgMfaPolicy: policy("mfa", { enabled: true, enforcement: "required" }),
      }).allowed,
    ).toBe(true);
  });
});

describe("sessionExpiresInSecondsFromPolicy (ADM.3)", () => {
  it("uses fallback when policy is off (clamped to at least one day)", () => {
    expect(sessionExpiresInSecondsFromPolicy(null, 2 * 24 * 60 * 60)).toBe(2 * 24 * 60 * 60);
    // Sub-day fallbacks are raised so cookies never get an accidental 1-hour prod TTL.
    expect(sessionExpiresInSecondsFromPolicy(null, 3600)).toBe(24 * 60 * 60);
  });

  it("maps inactivityTimeoutDays to absolute max-age seconds when enabled", () => {
    expect(
      sessionExpiresInSecondsFromPolicy(
        policy("session", {
          enabled: true,
          enforcement: "optional",
          settings: { inactivityTimeoutDays: 3, reauthForAdminActions: true, maxConcurrentSessions: 5 },
        }),
      ),
    ).toBe(3 * 24 * 60 * 60);
  });
});

describe("SSO / recorded-only required validation (ADM.4/ADM.5/ID.4)", () => {
  it("refuses SSO enforcement=required", () => {
    const decision = validateSsoEnforcementRequest("required");
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("policy_enforcement_unavailable");
    }
  });

  it("allows SSO optional", () => {
    expect(validateSsoEnforcementRequest("optional")).toEqual({
      ok: true,
      enforcement: "optional",
    });
  });

  it("refuses required for DLP and device_trust", () => {
    expect(validateRecordedOnlyRequiredEnforcement("dlp", "required").ok).toBe(false);
    expect(validateRecordedOnlyRequiredEnforcement("device_trust", "required").ok).toBe(false);
    expect(validateRecordedOnlyRequiredEnforcement("external_sharing", "required").ok).toBe(true);
  });
});
