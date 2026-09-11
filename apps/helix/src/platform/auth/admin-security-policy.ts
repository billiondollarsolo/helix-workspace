import type { SecurityTier } from "@helix/sdk-types";
import { internalApiUrl } from "../../api/version.js";
import type { SecurityPolicyLike } from "../admin/security-policy-runtime.js";
import { tierRequiresAdminMfa } from "./mfa.js";

export interface AdminSecurityControls {
  readonly adminMfaRequired: boolean;
  readonly adminMfaSource: "tier" | "policy";
  readonly sensitiveActionMfaRequired: boolean;
  readonly secondAdminApprovalRequired: boolean;
}

/** Missing fields retain the existing defaults; explicit operator choices win. */
export function resolveAdminSecurityControls(
  tier: SecurityTier,
  policy?: SecurityPolicyLike | null,
): AdminSecurityControls {
  const settings = policy?.settings;
  const choice = settings?.adminMfa;
  const legacyRequired =
    choice === undefined && policy?.enabled === true && policy.enforcement === "required";
  return {
    adminMfaRequired:
      choice === "optional"
        ? false
        : choice === "required" || legacyRequired || tierRequiresAdminMfa(tier),
    adminMfaSource:
      choice === "optional" || choice === "required" || legacyRequired ? "policy" : "tier",
    sensitiveActionMfaRequired: settings?.sensitiveActionMfaRequired !== false,
    secondAdminApprovalRequired: settings?.secondAdminApprovalRequired !== false,
  };
}

/** Authenticated recovery surface; mutations separately require fresh real login. */
export function isSecurityPolicyRecoveryRequest(method: string | undefined, url: string): boolean {
  const path = decodeURIComponent(internalApiUrl(url).split("?", 1)[0] ?? "");
  return (
    (method === "GET" && path === "/api/admin/security-policies") ||
    ((method === "GET" || method === "PUT") &&
      (path === "/api/admin/security-policies/mfa" ||
        path === "/api/admin/security-policies/session"))
  );
}

/** First setup can replace inherited defaults; later explicit protection protects itself. */
export function securityPolicyChangeRequirements(policy?: SecurityPolicyLike | null) {
  return {
    mfaRequired:
      policy?.settings.adminMfa === "required" ||
      policy?.settings.sensitiveActionMfaRequired === true ||
      (policy?.settings.adminMfa === undefined &&
        policy?.enabled === true &&
        policy.enforcement === "required"),
    approvalRequired: policy?.settings.secondAdminApprovalRequired === true,
  };
}
