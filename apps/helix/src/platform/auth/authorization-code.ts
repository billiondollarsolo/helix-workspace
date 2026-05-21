import { getCryptoProvider } from "../crypto/index.js";
import { OAuthError } from "./oauth.js";

/**
 * OAuth 2.1 Authorization Code flow with PKCE (PRD §13.6).
 *
 * Authorization codes are short-lived and single-use. Only the SHA-256 hash of
 * a code is persisted, mirroring how access tokens are stored, so a database
 * read cannot recover a live code.
 */

export const DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS = 60;

export type CodeChallengeMethod = "S256" | "plain";

const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/u;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/u;

export interface AuthorizationCodeRecord {
  /** SHA-256 hex hash of the issued authorization code. */
  readonly codeHash: string;
  readonly clientId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
  readonly state: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface AuthorizationCodeStore {
  saveCode(record: AuthorizationCodeRecord): Promise<void>;
  /**
   * Atomically consume a code: returns the record only if it exists, is
   * unexpired, and was not already consumed. Implementations MUST mark the
   * code consumed in the same operation to guarantee single use.
   */
  consumeCode(codeHash: string, consumedAt: Date): Promise<AuthorizationCodeRecord | null>;
}

export interface AuthorizationCodeIssueInput {
  readonly clientId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
  readonly state?: string | null;
}

export interface AuthorizationCodeIssueResult {
  readonly code: string;
  readonly record: AuthorizationCodeRecord;
}

export interface AuthorizationCodeRedeemInput {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface AuthorizationCodeServiceOptions {
  readonly codeStore: AuthorizationCodeStore;
  readonly codeTtlSeconds?: number;
}

export class AuthorizationCodeService {
  readonly #ttlSeconds: number;

  constructor(private readonly options: AuthorizationCodeServiceOptions) {
    this.#ttlSeconds = options.codeTtlSeconds ?? DEFAULT_AUTHORIZATION_CODE_TTL_SECONDS;
  }

  /** Issue a single-use authorization code bound to a PKCE challenge. */
  async issueCode(input: AuthorizationCodeIssueInput): Promise<AuthorizationCodeIssueResult> {
    if (!isValidCodeChallenge(input.codeChallenge)) {
      throw new OAuthError("invalid_request", "Invalid code_challenge.", 400);
    }
    const code = `helix_ac_${getCryptoProvider().randomBytes(32).toString("base64url")}`;
    const issuedAt = new Date();
    const record: AuthorizationCodeRecord = {
      codeHash: hashAuthorizationCode(code),
      clientId: input.clientId,
      actorId: input.actorId,
      orgId: input.orgId,
      redirectUri: input.redirectUri,
      scopes: [...new Set(input.scopes)],
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      state: input.state ?? null,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + this.#ttlSeconds * 1000),
      consumedAt: null,
    };
    await this.options.codeStore.saveCode(record);
    return { code, record };
  }

  /**
   * Redeem an authorization code at the token endpoint. Verifies single-use,
   * expiry, the bound `client_id` and `redirect_uri`, and the PKCE
   * `code_verifier`. Throws {@link OAuthError} (`invalid_grant`) on any
   * mismatch, including a tampered code or verifier.
   */
  async redeemCode(input: AuthorizationCodeRedeemInput): Promise<AuthorizationCodeRecord> {
    if (!CODE_VERIFIER_PATTERN.test(input.codeVerifier)) {
      throw new OAuthError("invalid_grant", "Invalid PKCE code_verifier.", 400);
    }
    const record = await this.options.codeStore.consumeCode(
      hashAuthorizationCode(input.code),
      new Date(),
    );
    if (record === null) {
      throw new OAuthError(
        "invalid_grant",
        "Authorization code is unknown, expired, or already used.",
        400,
      );
    }
    if (!constantTimeEquals(record.clientId, input.clientId)) {
      throw new OAuthError("invalid_grant", "Authorization code was issued to another client.", 400);
    }
    if (!constantTimeEquals(record.redirectUri, input.redirectUri)) {
      throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.", 400);
    }
    if (!verifyPkce(record.codeChallenge, record.codeChallengeMethod, input.codeVerifier)) {
      throw new OAuthError("invalid_grant", "PKCE verification failed.", 400);
    }
    return record;
  }
}

export class InMemoryAuthorizationCodeStore implements AuthorizationCodeStore {
  readonly #codes = new Map<string, AuthorizationCodeRecord>();

  async saveCode(record: AuthorizationCodeRecord): Promise<void> {
    this.#codes.set(record.codeHash, record);
  }

  async consumeCode(codeHash: string, consumedAt: Date): Promise<AuthorizationCodeRecord | null> {
    const record = this.#codes.get(codeHash);
    if (record === undefined || record.consumedAt !== null) {
      return null;
    }
    if (record.expiresAt <= consumedAt) {
      return null;
    }
    const consumed = { ...record, consumedAt };
    this.#codes.set(codeHash, consumed);
    return consumed;
  }
}

export function createAuthorizationCodeService(
  options: AuthorizationCodeServiceOptions,
): AuthorizationCodeService {
  return new AuthorizationCodeService(options);
}

export function hashAuthorizationCode(code: string): string {
  return getCryptoProvider().hash("sha256", code, "hex");
}

export function isValidCodeChallenge(challenge: string): boolean {
  return CODE_CHALLENGE_PATTERN.test(challenge);
}

export function isValidCodeChallengeMethod(method: string): method is CodeChallengeMethod {
  return method === "S256" || method === "plain";
}

/**
 * Verify a PKCE `code_verifier` against the stored `code_challenge`
 * (RFC 7636). For `S256` the verifier is SHA-256 hashed and base64url-encoded;
 * for `plain` it is compared directly. Comparison is constant-time.
 */
export function verifyPkce(
  codeChallenge: string,
  method: CodeChallengeMethod,
  codeVerifier: string,
): boolean {
  if (method === "plain") {
    return constantTimeEquals(codeChallenge, codeVerifier);
  }
  const derived = getCryptoProvider().hash("sha256", codeVerifier, "base64url");
  return constantTimeEquals(codeChallenge, derived);
}

function constantTimeEquals(left: string, right: string): boolean {
  return getCryptoProvider().timingSafeEqual(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  );
}
