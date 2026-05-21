import type { FastifyRequest } from "fastify";
import type { Actor, SecurityTier } from "@helix/sdk-types";

/**
 * MFA enforcement for admin-scoped requests (PRD §9, P2-1).
 *
 * The tier engine *declares* that Tier 2+ (`business`, `enterprise`,
 * `sovereign`) requires MFA for administrators, but nothing enforced it. This
 * module makes that control real: admin-scoped requests from an actor without
 * a verified MFA factor are rejected on tiers that require admin MFA.
 *
 * BetterAuth's `twoFactor` plugin is not enabled in this deployment, so a
 * verified factor is signalled to the application by the authenticating layer
 * (BetterAuth, or the upstream auth proxy after a factor challenge) via the
 * `x-helix-mfa-verified` request header. When BetterAuth's twoFactor plugin is
 * later enabled, its session `twoFactorEnabled`/AAL signal can be threaded into
 * {@link MfaVerificationResolver} without changing the enforcement path.
 */

/** Tiers on which administrators must present a verified MFA factor. */
const TIERS_REQUIRING_ADMIN_MFA: ReadonlySet<SecurityTier> = new Set<SecurityTier>([
  "business",
  "enterprise",
  "sovereign",
]);

/** Whether the configured tier requires a verified MFA factor for admins. */
export function tierRequiresAdminMfa(tier: SecurityTier): boolean {
  return TIERS_REQUIRING_ADMIN_MFA.has(tier);
}

/**
 * Whether an actor holds an admin scope. Admin scopes are namespaced `admin.*`
 * (e.g. `admin.users`, `admin.platform-config`); the `admin.*` wildcard also
 * counts. Non-admin actors are never subject to admin-MFA enforcement.
 */
export function actorHasAdminScope(actor: Actor): boolean {
  return (actor.scopes ?? []).some(
    (scope) => scope === "admin.*" || scope.startsWith("admin."),
  );
}

/** Resolves whether the request presented a verified MFA factor. */
export interface MfaVerificationResolver {
  isMfaVerified(request: FastifyRequest): boolean | Promise<boolean>;
}

/**
 * Default resolver: reads the `x-helix-mfa-verified` header. The header is set
 * to `true` by the authenticating layer only after a factor challenge has been
 * satisfied for the current session, so a client cannot self-assert it past
 * the trusted auth boundary.
 */
export const headerMfaVerificationResolver: MfaVerificationResolver = {
  isMfaVerified(request: FastifyRequest): boolean {
    const header = request.headers["x-helix-mfa-verified"];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === "string" && value.trim().toLowerCase() === "true";
  },
};

/** Outcome of an admin-MFA enforcement check. */
export type AdminMfaDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly statusCode: number;
      readonly code: string;
      readonly message: string;
    };

const ADMIN_MFA_ALLOWED: AdminMfaDecision = { allowed: true };

/**
 * Decide whether an admin-scoped request may proceed under the configured
 * tier's MFA policy.
 *
 * - When the tier does not require admin MFA, the request is always allowed.
 * - When the actor holds no admin scope, the request is allowed (the route's
 *   own scope check still applies).
 * - Otherwise the actor must have presented a verified MFA factor.
 */
export function evaluateAdminMfa(input: {
  readonly tier: SecurityTier;
  readonly actor: Actor;
  readonly mfaVerified: boolean;
}): AdminMfaDecision {
  if (!tierRequiresAdminMfa(input.tier)) {
    return ADMIN_MFA_ALLOWED;
  }
  if (!actorHasAdminScope(input.actor)) {
    return ADMIN_MFA_ALLOWED;
  }
  if (input.mfaVerified) {
    return ADMIN_MFA_ALLOWED;
  }
  return {
    allowed: false,
    statusCode: 403,
    code: "admin_mfa_required",
    message: `Tier '${input.tier}' requires a verified MFA factor for admin-scoped requests.`,
  };
}
