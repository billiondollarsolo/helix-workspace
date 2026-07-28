import { createHmac, timingSafeEqual } from "node:crypto";
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
 * BetterAuth's `twoFactor` plugin is not enabled in this deployment. A trusted
 * upstream authenticator therefore signals a completed factor challenge with
 * a short-lived, HMAC-signed assertion that is bound to the actor Helix has
 * independently authenticated. A bare client-controlled boolean is never a
 * valid MFA signal.
 */

export const MFA_ASSERTION_HEADER = "x-helix-mfa-assertion";
export const MAX_MFA_ASSERTION_LIFETIME_SECONDS = 300;
const MAX_MFA_ASSERTION_BYTES = 4096;
const HMAC_SHA256_BYTES = 32;
const MIN_MFA_ASSERTION_SECRET_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const SIGNATURE_BASE64URL_LENGTH = 43;

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
  return (actor.scopes ?? []).some((scope) => scope === "admin.*" || scope.startsWith("admin."));
}

/** Resolves whether the request presented a verified MFA factor. */
export interface MfaVerificationResolver {
  isMfaVerified(request: FastifyRequest, actor: Actor): boolean | Promise<boolean>;
}

export interface MfaAssertionVerificationConfig {
  readonly secret?: string | undefined;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  /** Unix seconds. Injected only for deterministic verification tests. */
  readonly now?: (() => number) | undefined;
}

interface MfaAssertionClaims {
  readonly v: 1;
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly org: string;
  readonly amr: "mfa";
  readonly iat: number;
  readonly exp: number;
}

const disabledMfaVerificationResolver: MfaVerificationResolver = {
  isMfaVerified(): boolean {
    return false;
  },
};

/**
 * Create the default fail-closed MFA resolver.
 *
 * The assertion wire format is:
 *
 *     base64url(UTF8(JSON claims)) + "." + base64url(HMAC-SHA256(first segment))
 *
 * Omitting all three producer settings leaves MFA unverified. This preserves
 * Personal-tier behavior while ensuring a partially configured or weak
 * verifier cannot start. Business production separately requires all three
 * settings at startup.
 */
export function createMfaAssertionVerificationResolver(
  config: MfaAssertionVerificationConfig,
): MfaVerificationResolver {
  const configuredValues = [config.secret, config.issuer, config.audience];
  if (configuredValues.every((value) => value === undefined || value.length === 0)) {
    return disabledMfaVerificationResolver;
  }
  if (configuredValues.some((value) => value === undefined || value.length === 0)) {
    throw new TypeError(
      "HELIX_MFA_ASSERTION_SECRET, HELIX_MFA_ASSERTION_ISSUER, and HELIX_MFA_ASSERTION_AUDIENCE must be configured together",
    );
  }

  const secret = config.secret as string;
  const issuer = config.issuer as string;
  const audience = config.audience as string;
  if (Buffer.byteLength(secret, "utf8") < MIN_MFA_ASSERTION_SECRET_BYTES) {
    throw new TypeError("HELIX_MFA_ASSERTION_SECRET must contain at least 32 bytes");
  }
  if (!boundedClaimString(issuer) || !boundedClaimString(audience)) {
    throw new TypeError(
      "MFA assertion issuer and audience must be 1-512 characters without surrounding whitespace",
    );
  }

  const secretKey = Buffer.from(secret, "utf8");
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    isMfaVerified(request: FastifyRequest, actor: Actor): boolean {
      const assertion = request.headers[MFA_ASSERTION_HEADER];
      if (
        typeof assertion !== "string" ||
        assertion.length === 0 ||
        Buffer.byteLength(assertion, "utf8") > MAX_MFA_ASSERTION_BYTES
      ) {
        return false;
      }

      const segments = assertion.split(".");
      if (segments.length !== 2) {
        return false;
      }
      const encodedClaims = segments[0];
      const encodedSignature = segments[1];
      if (
        encodedClaims === undefined ||
        encodedSignature === undefined ||
        !BASE64URL_PATTERN.test(encodedClaims) ||
        encodedSignature.length !== SIGNATURE_BASE64URL_LENGTH ||
        !BASE64URL_PATTERN.test(encodedSignature)
      ) {
        return false;
      }

      const providedSignature = strictBase64urlDecode(encodedSignature);
      if (providedSignature === null || providedSignature.byteLength !== HMAC_SHA256_BYTES) {
        return false;
      }
      const expectedSignature = createHmac("sha256", secretKey).update(encodedClaims).digest();
      if (!timingSafeEqual(expectedSignature, providedSignature)) {
        return false;
      }

      const claimsBytes = strictBase64urlDecode(encodedClaims);
      if (claimsBytes === null || claimsBytes.byteLength === 0) {
        return false;
      }
      const claims = parseMfaAssertionClaims(claimsBytes);
      if (claims === null) {
        return false;
      }

      const currentTime = now();
      return (
        Number.isSafeInteger(currentTime) &&
        claims.iss === issuer &&
        claims.aud === audience &&
        claims.sub === actor.id &&
        claims.org === actor.orgId &&
        claims.iat <= currentTime &&
        claims.exp > currentTime &&
        claims.exp > claims.iat &&
        claims.exp - claims.iat <= MAX_MFA_ASSERTION_LIFETIME_SECONDS
      );
    },
  };
}

function strictBase64urlDecode(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function parseMfaAssertionClaims(encoded: Buffer): MfaAssertionClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(encoded.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const expectedKeys = ["amr", "aud", "exp", "iat", "iss", "org", "sub", "v"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(record, key))
  ) {
    return null;
  }
  if (
    record.v !== 1 ||
    record.amr !== "mfa" ||
    !boundedClaimString(record.iss) ||
    !boundedClaimString(record.aud) ||
    !boundedClaimString(record.sub) ||
    !boundedClaimString(record.org) ||
    !Number.isSafeInteger(record.iat) ||
    !Number.isSafeInteger(record.exp)
  ) {
    return null;
  }

  return record as unknown as MfaAssertionClaims;
}

function boundedClaimString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim()
  );
}

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
