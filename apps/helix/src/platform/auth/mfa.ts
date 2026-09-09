import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt, type SecretConfig } from "better-auth/crypto";
import type { Actor, SecurityTier } from "@helix/sdk-types";
import type { BetterAuthSessionVerifier } from "./better-auth.js";

/**
 * MFA enforcement for admin-scoped requests (PRD §9, P2-1).
 *
 * The tier engine *declares* that Tier 2+ (`business`, `enterprise`,
 * `sovereign`) requires MFA for administrators, but nothing enforced it. This
 * module makes that control real: admin-scoped requests from an actor without
 * a verified MFA factor are rejected on tiers that require admin MFA.
 *
 * Better Auth's maintained passkey and TOTP plugins establish a server-side
 * assurance marker; policy checks fail closed when that marker is absent.
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

/** Resolves whether the authenticated server session has recent MFA assurance. */
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

export interface MfaAssuranceMarker {
  markVerifiedSession(sessionToken: string, verifiedAt?: Date): Promise<boolean>;
}

export interface RecoveryCodeBroker {
  replace(userId: string, bridgeCodes: readonly string[]): Promise<readonly string[]>;
  consume(code: string): Promise<string | null>;
  clear(userId: string): Promise<void>;
  invalidateOtherSessions(userId: string, keepToken: string | null): Promise<void>;
  isRecentSession(token: string, now?: Date): Promise<boolean>;
}

/**
 * Keeps user-visible recovery codes as SHA-256 digests while adapting Better
 * Auth's encrypted backup-code protocol. The random bridge value is not shown
 * to users and every digest is consumed atomically before authentication.
 */
export class PostgresRecoveryCodeBroker implements RecoveryCodeBroker {
  readonly #key: SecretConfig;

  constructor(
    private readonly sql: postgres.Sql,
    secret: string,
  ) {
    this.#key = { currentVersion: 1, keys: new Map([[1, secret]]), legacySecret: secret };
  }

  async replace(userId: string, bridgeCodes: readonly string[]): Promise<readonly string[]> {
    const codes = bridgeCodes.map(() => newRecoveryCode());
    const rows = await Promise.all(
      codes.map(async (code, index) => ({
        digest: recoveryCodeDigest(code),
        bridge: await symmetricEncrypt({ key: this.#key, data: bridgeCodes[index] ?? "" }),
      })),
    );
    await this.sql.begin(async (tx) => {
      await tx`delete from auth_recovery_codes where auth_user_id = ${userId}`;
      for (const row of rows) {
        await tx`
          insert into auth_recovery_codes (auth_user_id, code_digest, bridge_ciphertext)
          values (${userId}, ${row.digest}, ${row.bridge})
        `;
      }
    });
    return codes;
  }

  async consume(code: string): Promise<string | null> {
    const rows = await this.sql<{ readonly bridge_ciphertext: string }[]>`
      update auth_recovery_codes
      set consumed_at = now()
      where code_digest = ${recoveryCodeDigest(code)}
        and consumed_at is null
      returning bridge_ciphertext
    `;
    const bridge = rows[0]?.bridge_ciphertext;
    return bridge === undefined ? null : symmetricDecrypt({ key: this.#key, data: bridge });
  }

  async clear(userId: string): Promise<void> {
    await this.sql`delete from auth_recovery_codes where auth_user_id = ${userId}`;
  }

  async invalidateOtherSessions(userId: string, keepToken: string | null): Promise<void> {
    if (keepToken === null) {
      await this.sql`delete from "session" where "userId" = ${userId}`;
      return;
    }
    await this.sql`delete from "session" where "userId" = ${userId} and token <> ${keepToken}`;
  }

  async isRecentSession(token: string, now = new Date()): Promise<boolean> {
    const recentAfter = new Date(now.getTime() - 10 * 60_000);
    const rows = await this.sql`
      select 1 from "session"
      where token = ${token}
        and "expiresAt" > ${now}
        and greatest("createdAt", coalesce(mfa_verified_at, '-infinity')) > ${recentAfter}
      limit 1
    `;
    return rows.length === 1;
  }
}

export function recoveryCodeDigest(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex");
}

export function newRecoveryCode(): string {
  const value = randomBytes(10).toString("hex").toUpperCase();
  return `${value.slice(0, 5)}-${value.slice(5, 10)}-${value.slice(10, 15)}-${value.slice(15)}`;
}

/** Recent server-side MFA assurance bound to one session and one issuer. */
export class PostgresSessionMfaAssurance implements MfaVerificationResolver, MfaAssuranceMarker {
  readonly #maxAgeMs: number;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly verifier: BetterAuthSessionVerifier,
    private readonly audience: string,
    maxAgeSeconds = 600,
  ) {
    this.#maxAgeMs = maxAgeSeconds * 1000;
  }

  async markVerifiedSession(sessionToken: string, verifiedAt = new Date()): Promise<boolean> {
    const rows = await this.sql`
      update "session" s
      set mfa_verified_at = ${verifiedAt},
          mfa_audience = ${this.audience},
          "updatedAt" = ${verifiedAt}
      from "user" u
      where s.token = ${sessionToken}
        and s."expiresAt" > ${verifiedAt}
        and u.id = s."userId"
        and (
          u."twoFactorEnabled" = true
          or exists (select 1 from passkey p where p."userId" = u.id)
        )
      returning s.id
    `;
    return rows.length === 1;
  }

  async isMfaVerified(request: FastifyRequest): Promise<boolean> {
    const sessionToken = await this.verifier.getSessionToken?.({ headers: request.headers });
    if (sessionToken === undefined || sessionToken === null) {
      return false;
    }
    const now = new Date();
    const freshAfter = new Date(now.getTime() - this.#maxAgeMs);
    const rows = await this.sql`
      select 1
      from "session" s
      join "user" u on u.id = s."userId"
      where s.token = ${sessionToken}
        and s."expiresAt" > ${now}
        and s.mfa_verified_at > ${freshAfter}
        and s.mfa_verified_at <= ${now}
        and s.mfa_audience = ${this.audience}
        and (
          u."twoFactorEnabled" = true
          or exists (select 1 from passkey p where p."userId" = u.id)
        )
      limit 1
    `;
    return rows.length === 1;
  }
}

const MFA_VERIFICATION_PATHS = new Set([
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/passkey/verify-authentication",
]);

/** Extract a session token only from a successful maintained 2FA endpoint response. */
export function verifiedMfaSessionToken(
  requestUrl: string,
  statusCode: number,
  responseBody: string | null,
  setCookieHeader?: string | null,
): string | null {
  const path = requestUrl.split("?")[0];
  if (
    !MFA_VERIFICATION_PATHS.has(path ?? "") ||
    statusCode < 200 ||
    statusCode >= 300 ||
    responseBody === null
  ) {
    return null;
  }
  const cookieToken = sessionTokenFromSetCookie(setCookieHeader);
  if (cookieToken !== null) {
    return cookieToken;
  }
  try {
    const body: unknown = JSON.parse(responseBody);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return null;
    }
    const token = (body as Record<string, unknown>).token;
    return typeof token === "string" && token.length > 0 && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}

/** Session token newly issued by an auth response, if present. */
export function authResponseSessionToken(
  responseBody: string | null,
  setCookieHeader?: string | null,
): string | null {
  const cookie = sessionTokenFromSetCookie(setCookieHeader);
  if (cookie !== null) return cookie;
  const payload = parseJsonRecord(responseBody);
  const direct = payload?.token;
  if (typeof direct === "string" && direct.length > 0 && direct.length <= 512) return direct;
  const nested = payload?.session;
  return typeof nested === "object" &&
    nested !== null &&
    !Array.isArray(nested) &&
    typeof (nested as Record<string, unknown>).token === "string"
    ? ((nested as Record<string, unknown>).token as string)
    : null;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sessionTokenFromSetCookie(header: string | null | undefined): string | null {
  const encoded = header?.match(/(?:^|,\s*)(?:__Secure-)?helix_session=([^;,\s]+)/u)?.[1];
  if (encoded === undefined) {
    return null;
  }
  try {
    const token = decodeURIComponent(encoded).split(".")[0];
    return token !== undefined && token.length > 0 && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}

/** Fail-closed default until MFA assurance is stored on authenticated sessions. */
export const unverifiedMfaResolver: MfaVerificationResolver = {
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
    return unverifiedMfaResolver;
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
    typeof record.iat !== "number" ||
    !Number.isSafeInteger(record.iat) ||
    typeof record.exp !== "number" ||
    !Number.isSafeInteger(record.exp)
  ) {
    return null;
  }

  return {
    v: record.v,
    amr: record.amr,
    iss: record.iss,
    aud: record.aud,
    sub: record.sub,
    org: record.org,
    iat: record.iat,
    exp: record.exp,
  };
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
