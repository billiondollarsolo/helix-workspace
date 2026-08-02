/**
 * Runtime status + enforcement helpers for Admin security policies (ADM.2–ADM.6).
 *
 * Admin can persist intent for every policy type. Only some types are consumed
 * by live request paths. This module is the single source of truth for:
 *
 * - which policies are runtime-enforced vs recorded-only (honest UI chips)
 * - pure evaluators used by Drive share links, admin MFA hooks, and session TTL
 *
 * Rule: never surface "Required" as an enforced chip when `mode` is
 * `recorded_only`. Operators may still save intent for future enforcement.
 */

import type { Actor, SecurityTier } from "@helix/sdk-types";
import { actorHasAdminScope, evaluateAdminMfa, type AdminMfaDecision } from "../auth/mfa.js";

/** Local copies of policy types to avoid a circular import with security-policies.ts. */
export type PolicyEnforcement = "disabled" | "optional" | "required";
export type SecurityPolicyType =
  "mfa" | "sso" | "session" | "external_sharing" | "dlp" | "device_trust";

export interface SecurityPolicyLike {
  readonly policyType?: SecurityPolicyType;
  readonly enabled: boolean;
  readonly enforcement: PolicyEnforcement;
  readonly settings: Record<string, unknown>;
}

/** How the platform currently treats a policy type at runtime. */
export type PolicyRuntimeMode = "enforced" | "partial" | "recorded_only";

export interface PolicyRuntimeCapability {
  readonly policyType: SecurityPolicyType;
  readonly mode: PolicyRuntimeMode;
  /** Short operator-facing summary (API + admin chips). */
  readonly summary: string;
  /** Where enforcement is applied when mode is enforced/partial. */
  readonly enforcementPoints: readonly string[];
}

/**
 * Inventory of the six security-policy controls and their live runtime status.
 * Keep in sync with real call sites; tests pin this table.
 */
export const SECURITY_POLICY_RUNTIME_CAPABILITIES: readonly PolicyRuntimeCapability[] = [
  {
    policyType: "mfa",
    mode: "partial",
    summary:
      "Enforced for admin-scoped requests when the org policy is enabled+required, or when the security tier already requires admin MFA. End-user MFA at sign-in is not yet platform-gated.",
    enforcementPoints: ["preHandler /api/admin/* (evaluateOrgAdminMfa)"],
  },
  {
    policyType: "sso",
    mode: "recorded_only",
    summary:
      "IdP config and test-login status are recorded. SAML SP metadata is published; full SSO login enforcement (including disabling local login) is not connected.",
    enforcementPoints: [],
  },
  {
    policyType: "session",
    mode: "partial",
    summary:
      "Absolute session lifetime can be derived from inactivityTimeoutDays for session issue helpers. Idle-timeout reaping and concurrent-session caps are not yet enforced.",
    enforcementPoints: ["sessionExpiresInSecondsFromPolicy"],
  },
  {
    policyType: "external_sharing",
    mode: "enforced",
    summary:
      "Public/anonymous Drive share links honor mode=blocked (deny) and requireExpiry. Allowlist domains apply to email-based share targets when provided.",
    enforcementPoints: ["drive.link.create", "drive.share (email targets)"],
  },
  {
    policyType: "dlp",
    mode: "recorded_only",
    summary:
      "Detector settings are stored and audited only. Outbound mail/doc content is not scanned against this policy yet.",
    enforcementPoints: [],
  },
  {
    policyType: "device_trust",
    mode: "recorded_only",
    summary:
      "Device-trust settings are stored and audited only. Managed-device signals are not checked at request time.",
    enforcementPoints: [],
  },
] as const;

const capabilityByType = new Map(
  SECURITY_POLICY_RUNTIME_CAPABILITIES.map((entry) => [entry.policyType, entry]),
);

export function policyRuntimeCapability(policyType: SecurityPolicyType): PolicyRuntimeCapability {
  const found = capabilityByType.get(policyType);
  if (found === undefined) {
    throw new Error(`Unknown security policy type: ${policyType}`);
  }
  return found;
}

export interface PolicyRuntimeStatusView {
  readonly mode: PolicyRuntimeMode;
  readonly summary: string;
  readonly enforcementPoints: readonly string[];
  /**
   * Chip-safe label for the admin console. Never returns "Required" when the
   * platform does not enforce the control.
   */
  readonly displayLevel: "off" | "recorded" | "active" | "required";
  readonly displayLevelOn: boolean;
}

/** Map stored policy + runtime capability to an honest operator-facing status. */
export function policyRuntimeStatus(
  policy: Pick<SecurityPolicyLike, "enabled" | "enforcement"> & {
    readonly policyType: SecurityPolicyType;
  },
): PolicyRuntimeStatusView {
  const capability = policyRuntimeCapability(policy.policyType);
  if (!policy.enabled || policy.enforcement === "disabled") {
    return {
      mode: capability.mode,
      summary: capability.summary,
      enforcementPoints: capability.enforcementPoints,
      displayLevel: "off",
      displayLevelOn: false,
    };
  }

  if (capability.mode === "recorded_only") {
    return {
      mode: capability.mode,
      summary: capability.summary,
      enforcementPoints: capability.enforcementPoints,
      displayLevel: "recorded",
      displayLevelOn: false,
    };
  }

  if (policy.enforcement === "required" && capability.mode === "enforced") {
    return {
      mode: capability.mode,
      summary: capability.summary,
      enforcementPoints: capability.enforcementPoints,
      displayLevel: "required",
      displayLevelOn: true,
    };
  }

  if (policy.enforcement === "required" && capability.mode === "partial") {
    return {
      mode: capability.mode,
      summary: capability.summary,
      enforcementPoints: capability.enforcementPoints,
      // Partial enforcement must not claim full "Required".
      displayLevel: "active",
      displayLevelOn: true,
    };
  }

  return {
    mode: capability.mode,
    summary: capability.summary,
    enforcementPoints: capability.enforcementPoints,
    displayLevel: "active",
    displayLevelOn: true,
  };
}

// --------------------------------------------------------------------------
// External sharing (ADM.6)
// --------------------------------------------------------------------------

export type ExternalSharingMode = "blocked" | "allowlist" | "anyone";

export interface ExternalSharingPolicyView {
  readonly enabled: boolean;
  readonly enforcement: PolicyEnforcement;
  readonly mode: ExternalSharingMode;
  readonly allowedDomains: readonly string[];
  readonly requireExpiry: boolean;
}

export type ExternalSharingDecision =
  | { readonly allowed: true; readonly requireExpiry: boolean }
  | {
      readonly allowed: false;
      readonly code:
        | "external_sharing_blocked"
        | "external_sharing_domain_denied"
        | "external_sharing_expiry_required";
      readonly message: string;
    };

export function parseExternalSharingPolicy(
  policy: Pick<SecurityPolicyLike, "enabled" | "enforcement" | "settings"> | null | undefined,
): ExternalSharingPolicyView {
  if (policy === null || policy === undefined) {
    return {
      enabled: false,
      enforcement: "optional",
      mode: "anyone",
      allowedDomains: [],
      requireExpiry: false,
    };
  }
  const settings = policy.settings;
  const mode =
    settings.mode === "blocked" || settings.mode === "allowlist" || settings.mode === "anyone"
      ? settings.mode
      : "anyone";
  const allowedDomains = Array.isArray(settings.allowedDomains)
    ? settings.allowedDomains
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeDomain(value))
        .filter((value) => value.length > 0)
    : [];
  return {
    enabled: policy.enabled,
    enforcement: policy.enforcement,
    mode,
    allowedDomains,
    requireExpiry: settings.requireExpiry === true,
  };
}

/**
 * Decide whether a public/anonymous Drive share link may be created.
 * Public links are treated as external sharing to "anyone"; when mode is
 * allowlist they are denied because a link has no domain-bound recipient.
 */
export function evaluatePublicShareLinkPolicy(
  policy: Pick<SecurityPolicyLike, "enabled" | "enforcement" | "settings"> | null | undefined,
  input: { readonly expiresAt: Date | null | undefined } = { expiresAt: null },
): ExternalSharingDecision {
  const view = parseExternalSharingPolicy(policy);
  if (!view.enabled || view.enforcement === "disabled") {
    return { allowed: true, requireExpiry: false };
  }
  if (view.mode === "blocked") {
    return {
      allowed: false,
      code: "external_sharing_blocked",
      message:
        "External sharing is blocked by the organization security policy. Public share links cannot be created.",
    };
  }
  if (view.mode === "allowlist") {
    return {
      allowed: false,
      code: "external_sharing_domain_denied",
      message:
        "Public share links are not allowed when external sharing is restricted to an allowlist. Share with specific workspace users or domains instead.",
    };
  }
  if (view.requireExpiry && (input.expiresAt === null || input.expiresAt === undefined)) {
    return {
      allowed: false,
      code: "external_sharing_expiry_required",
      message: "Organization policy requires an expiry on external share links.",
    };
  }
  return { allowed: true, requireExpiry: view.requireExpiry };
}

/**
 * Decide whether sharing with email targets is allowed under allowlist mode.
 * Empty emailTargets skips domain checks (actor-id-only shares stay internal).
 */
export function evaluateExternalEmailSharePolicy(
  policy: Pick<SecurityPolicyLike, "enabled" | "enforcement" | "settings"> | null | undefined,
  emailTargets: readonly string[],
): ExternalSharingDecision {
  const view = parseExternalSharingPolicy(policy);
  if (!view.enabled || view.enforcement === "disabled") {
    return { allowed: true, requireExpiry: false };
  }
  if (view.mode === "blocked") {
    return {
      allowed: false,
      code: "external_sharing_blocked",
      message: "External sharing is blocked by the organization security policy.",
    };
  }
  if (view.mode !== "allowlist" || emailTargets.length === 0) {
    return { allowed: true, requireExpiry: view.requireExpiry };
  }
  const denied = emailTargets.filter((email) => {
    const domain = domainFromEmail(email);
    if (domain === null) {
      return true;
    }
    return !view.allowedDomains.some(
      (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
    );
  });
  if (denied.length > 0) {
    return {
      allowed: false,
      code: "external_sharing_domain_denied",
      message: `External sharing policy denies recipient domain(s): ${denied.join(", ")}.`,
    };
  }
  return { allowed: true, requireExpiry: view.requireExpiry };
}

function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    return null;
  }
  return normalizeDomain(email.slice(at + 1));
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, "");
}

// --------------------------------------------------------------------------
// MFA (ADM.2) — org policy + tier
// --------------------------------------------------------------------------

export interface OrgMfaPolicyView {
  readonly enabled: boolean;
  readonly enforcement: PolicyEnforcement;
  readonly allowedMethods: readonly string[];
  readonly rememberDeviceDays: number;
}

export function parseOrgMfaPolicy(
  policy: Pick<SecurityPolicyLike, "enabled" | "enforcement" | "settings"> | null | undefined,
): OrgMfaPolicyView {
  if (policy === null || policy === undefined) {
    return {
      enabled: false,
      enforcement: "optional",
      allowedMethods: ["hardware_key", "totp"],
      rememberDeviceDays: 0,
    };
  }
  const settings = policy.settings;
  const allowedMethods = Array.isArray(settings.allowedMethods)
    ? settings.allowedMethods.filter((value): value is string => typeof value === "string")
    : ["hardware_key", "totp"];
  return {
    enabled: policy.enabled,
    enforcement: policy.enforcement,
    allowedMethods,
    rememberDeviceDays:
      typeof settings.rememberDeviceDays === "number" ? settings.rememberDeviceDays : 0,
  };
}

/**
 * Admin MFA: require a verified factor when either the security tier demands
 * it (Tier 2+) or the org MFA policy is enabled with enforcement=required.
 */
export function evaluateOrgAdminMfa(input: {
  readonly tier: SecurityTier;
  readonly actor: Actor;
  readonly mfaVerified: boolean;
  readonly orgMfaPolicy?:
    Pick<SecurityPolicyLike, "enabled" | "enforcement" | "settings"> | null | undefined;
}): AdminMfaDecision {
  const tierDecision = evaluateAdminMfa({
    tier: input.tier,
    actor: input.actor,
    mfaVerified: input.mfaVerified,
  });
  if (!tierDecision.allowed) {
    return tierDecision;
  }

  const orgPolicy = parseOrgMfaPolicy(input.orgMfaPolicy);
  if (!orgPolicy.enabled || orgPolicy.enforcement !== "required") {
    return { allowed: true };
  }
  if (!actorHasAdminScope(input.actor)) {
    return { allowed: true };
  }
  if (input.mfaVerified) {
    return { allowed: true };
  }
  return {
    allowed: false,
    statusCode: 403,
    code: "admin_mfa_required",
    message: "Organization MFA policy requires a verified MFA factor for admin-scoped requests.",
  };
}

// --------------------------------------------------------------------------
// Session (ADM.3 / ID.1 helpers)
// --------------------------------------------------------------------------

const SECONDS_PER_DAY = 24 * 60 * 60;
const DEFAULT_SESSION_EXPIRES_IN_SECONDS = 7 * SECONDS_PER_DAY;
const MIN_SESSION_EXPIRES_IN_SECONDS = SECONDS_PER_DAY;
const MAX_SESSION_EXPIRES_IN_SECONDS = 90 * SECONDS_PER_DAY;

export function parseSessionPolicy(
  policy: Pick<SecurityPolicyLike, "enabled" | "enforcement" | "settings"> | null | undefined,
): {
  readonly enabled: boolean;
  readonly enforcement: PolicyEnforcement;
  readonly inactivityTimeoutDays: number;
  readonly reauthForAdminActions: boolean;
  readonly maxConcurrentSessions: number;
} {
  if (policy === null || policy === undefined) {
    return {
      enabled: false,
      enforcement: "optional",
      inactivityTimeoutDays: 14,
      reauthForAdminActions: true,
      maxConcurrentSessions: 10,
    };
  }
  const settings = policy.settings;
  return {
    enabled: policy.enabled,
    enforcement: policy.enforcement,
    inactivityTimeoutDays:
      typeof settings.inactivityTimeoutDays === "number" ? settings.inactivityTimeoutDays : 14,
    reauthForAdminActions: settings.reauthForAdminActions !== false,
    maxConcurrentSessions:
      typeof settings.maxConcurrentSessions === "number" ? settings.maxConcurrentSessions : 10,
  };
}

/**
 * Absolute session lifetime used when the org session policy is enabled.
 * Helix maps `inactivityTimeoutDays` to Max-Age / expiresAt until idle
 * reaping exists — callers must not claim idle-timeout enforcement beyond this.
 */
export function sessionExpiresInSecondsFromPolicy(
  policy: Pick<SecurityPolicyLike, "enabled" | "enforcement" | "settings"> | null | undefined,
  fallbackSeconds: number = DEFAULT_SESSION_EXPIRES_IN_SECONDS,
): number {
  const view = parseSessionPolicy(policy);
  if (!view.enabled || view.enforcement === "disabled") {
    return clampSessionSeconds(fallbackSeconds);
  }
  return clampSessionSeconds(view.inactivityTimeoutDays * SECONDS_PER_DAY);
}

function clampSessionSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SESSION_EXPIRES_IN_SECONDS;
  }
  return Math.min(
    MAX_SESSION_EXPIRES_IN_SECONDS,
    Math.max(MIN_SESSION_EXPIRES_IN_SECONDS, Math.floor(value)),
  );
}

// --------------------------------------------------------------------------
// SSO (ADM.4 / ID.4) — honest rejection of unenforceable "required"
// --------------------------------------------------------------------------

export type PolicyEnforcementValidation =
  | { readonly ok: true; readonly enforcement: PolicyEnforcement }
  | {
      readonly ok: false;
      readonly code: "policy_enforcement_unavailable";
      readonly message: string;
    };

/**
 * SSO login runtime is not fully connected (ACS/OIDC). Allow optional/disabled
 * intent, but refuse enforcement=required so operators cannot believe local
 * login is blocked when it is not.
 */
export function validateSsoEnforcementRequest(
  enforcement: PolicyEnforcement | undefined,
): PolicyEnforcementValidation {
  if (enforcement === undefined || enforcement === "disabled" || enforcement === "optional") {
    return { ok: true, enforcement: enforcement ?? "optional" };
  }
  return {
    ok: false,
    code: "policy_enforcement_unavailable",
    message:
      "SSO enforcement level 'required' is not available until SAML/OIDC runtime login is connected. Keep SSO optional (additive) or configure your identity provider to require SSO outside Helix.",
  };
}

/**
 * DLP/device_trust cannot be required while they are recorded-only.
 * Optional remains allowed so intent can be saved without a false claim.
 */
export function validateRecordedOnlyRequiredEnforcement(
  policyType: SecurityPolicyType,
  enforcement: PolicyEnforcement | undefined,
): PolicyEnforcementValidation {
  if (policyType === "sso") {
    return validateSsoEnforcementRequest(enforcement);
  }
  if (enforcement !== "required") {
    return { ok: true, enforcement: enforcement ?? "optional" };
  }
  const capability = policyRuntimeCapability(policyType);
  if (capability.mode !== "recorded_only") {
    return { ok: true, enforcement };
  }
  return {
    ok: false,
    code: "policy_enforcement_unavailable",
    message: `${policyType} cannot be set to 'required' because Helix does not enforce this control yet. Save as optional to record intent, or apply the control at your gateway until enforcement ships.`,
  };
}
