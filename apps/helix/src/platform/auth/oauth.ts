import { scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { getCryptoProvider } from "../crypto/index.js";

const scrypt = promisify(scryptCallback);
const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const SECRET_KEY_LENGTH = 64;
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;

export type OAuthGrantType = "client_credentials" | "authorization_code";
export type OAuthTokenType = "Bearer";

export interface OAuthClientRecord {
  readonly clientId: string;
  readonly clientSecretHash: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  /**
   * Per-client redirect-URI allowlist (CRITICAL-3, REVIEW.md). The
   * `/oauth/authorize` endpoint MUST require an exact-string match against
   * one of these entries; an empty list denies authorization by default
   * until an admin registers a redirect URI for the client. No prefix
   * matching, no wildcards.
   */
  readonly redirectUris: readonly string[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface OAuthClientCreateInput {
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  /** Human owner allowed to approve this credential's queued actions. */
  readonly approvalOwnerActorId?: string;
  /**
   * Per-client redirect-URI allowlist (CRITICAL-3). When omitted, the client
   * is created with no registered redirect URIs and `/oauth/authorize` will
   * refuse to issue codes for it until an admin adds at least one.
   */
  readonly redirectUris?: readonly string[];
  readonly expiresAt?: Date | null;
}

export interface OAuthClientListInput {
  readonly orgId: string;
  readonly actorId?: string;
  readonly includeRevoked?: boolean;
}

export interface OAuthClientRegistration {
  readonly client: OAuthClientRecord;
  readonly clientSecret: string;
}

export interface OAuthClientStore {
  findClient(clientId: string): Promise<OAuthClientRecord | null>;
  listClients(input: OAuthClientListInput): Promise<readonly OAuthClientRecord[]>;
  createClient(
    input: OAuthClientCreateInput & {
      readonly clientId: string;
      readonly clientSecretHash: string;
    },
  ): Promise<OAuthClientRecord>;
  revokeClient(clientId: string, revokedAt: Date): Promise<OAuthClientRecord | null>;
  rotateClientSecret(
    clientId: string,
    clientSecretHash: string,
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null>;
  /**
   * Replace a client's registered redirect URIs with the supplied allowlist
   * (CRITICAL-3). The implementation MUST persist the exact strings; no
   * normalization, glob, or prefix expansion is permitted.
   */
  setRedirectUris?(
    clientId: string,
    redirectUris: readonly string[],
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null>;
}

export interface AccessTokenRecord {
  readonly token: string;
  readonly clientId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly actorType?: "user" | "agent" | "service_account" | "system";
  readonly actorDisplayName?: string;
  readonly actorEmail?: string;
  readonly scopes: readonly string[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface AccessTokenStore {
  saveToken(token: AccessTokenRecord): Promise<void>;
  findToken(token: string): Promise<AccessTokenRecord | null>;
  /**
   * Revoke a previously issued access token (RFC 7009). Optional for backward
   * compatibility with stores that predate token revocation; when absent, the
   * revocation endpoint still responds successfully per RFC 7009 §2.2.
   */
  revokeToken?(token: string, revokedAt: Date): Promise<void>;
}

export interface OAuthTokenRequest {
  readonly grantType: OAuthGrantType;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: OAuthTokenType;
  readonly expires_in: number;
  readonly scope: string;
}

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "unsupported_grant_type";

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface OAuthAuthorizationCodeRedeemer {
  redeemCode(input: {
    readonly code: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  }): Promise<{
    readonly clientId: string;
    readonly actorId: string;
    readonly orgId: string;
    readonly scopes: readonly string[];
  }>;
}

export interface OAuthAuthorizationCodeTokenRequest {
  readonly grantType: "authorization_code";
  /** Public clients omit `client_secret`; the PKCE verifier authenticates them. */
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export interface OAuthTokenServiceOptions {
  readonly clientStore: OAuthClientStore;
  readonly tokenStore?: AccessTokenStore;
  readonly tokenTtlSeconds?: number;
  /**
   * Authorization-code redeemer (PRD §13.6). When provided, the service can
   * mint access tokens for the `authorization_code` grant.
   */
  readonly authorizationCodeService?: OAuthAuthorizationCodeRedeemer;
}

export class OAuthTokenService {
  readonly #tokenTtlSeconds: number;

  constructor(private readonly options: OAuthTokenServiceOptions) {
    this.#tokenTtlSeconds = options.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  }

  async issueClientCredentialsToken(input: OAuthTokenRequest): Promise<OAuthTokenResponse> {
    const client = await this.options.clientStore.findClient(input.clientId);
    if (client === null) {
      throw new OAuthError("invalid_client", "Unknown OAuth client.", 401);
    }
    if (client.revokedAt !== null) {
      throw new OAuthError("invalid_client", "OAuth client has been revoked.", 401);
    }
    const now = new Date();
    if (client.expiresAt !== null && client.expiresAt <= now) {
      throw new OAuthError("invalid_client", "OAuth client has expired.", 401);
    }
    const verification = await verifySecretWithRehash(input.clientSecret, client.clientSecretHash);
    if (!verification.valid) {
      throw new OAuthError("invalid_client", "Invalid OAuth client credentials.", 401);
    }
    if (verification.rehashedSecretHash !== null) {
      // Transparently upgrade a legacy scrypt hash to argon2id (PRD §9.2).
      try {
        await this.options.clientStore.rotateClientSecret(
          client.clientId,
          verification.rehashedSecretHash,
          now,
        );
      } catch {
        // A failed re-hash upgrade must not fail an otherwise valid token request.
      }
    }

    const requestedScopes = parseScope(input.scope);
    const grantedScopes = requestedScopes.length === 0 ? [...client.scopes] : requestedScopes;
    const unauthorizedScope = grantedScopes.find((scope) => !client.scopes.includes(scope));
    if (unauthorizedScope !== undefined) {
      throw new OAuthError(
        "invalid_scope",
        `Client is not allowed to request scope: ${unauthorizedScope}`,
        400,
      );
    }

    const issuedAt = now;
    const expiresAt = new Date(issuedAt.getTime() + this.#tokenTtlSeconds * 1000);
    const accessToken: AccessTokenRecord = {
      token: `helix_at_${randomToken(32)}`,
      clientId: client.clientId,
      actorId: client.actorId,
      orgId: client.orgId,
      scopes: grantedScopes,
      issuedAt,
      expiresAt,
    };
    await this.options.tokenStore?.saveToken(accessToken);

    return {
      access_token: accessToken.token,
      token_type: "Bearer",
      expires_in: this.#tokenTtlSeconds,
      scope: grantedScopes.join(" "),
    };
  }

  /**
   * Exchange an OAuth 2.1 authorization code (with its PKCE `code_verifier`)
   * for an access token (PRD §13.6). The code's bound scopes, actor, and org
   * are authoritative; the client is re-validated for revocation/expiry. When
   * the client has a stored secret it must also be supplied (confidential
   * client); public clients are authenticated solely by PKCE.
   */
  async issueAuthorizationCodeToken(
    input: OAuthAuthorizationCodeTokenRequest,
  ): Promise<OAuthTokenResponse> {
    const redeemer = this.options.authorizationCodeService;
    if (redeemer === undefined) {
      throw new OAuthError(
        "unsupported_grant_type",
        "Authorization code grant is not enabled.",
        400,
      );
    }
    const client = await this.options.clientStore.findClient(input.clientId);
    if (client === null) {
      throw new OAuthError("invalid_client", "Unknown OAuth client.", 401);
    }
    if (client.revokedAt !== null) {
      throw new OAuthError("invalid_client", "OAuth client has been revoked.", 401);
    }
    const now = new Date();
    if (client.expiresAt !== null && client.expiresAt <= now) {
      throw new OAuthError("invalid_client", "OAuth client has expired.", 401);
    }
    // Confidential clients (those with a stored secret) must authenticate; a
    // public client carries the placeholder hash and authenticates via PKCE.
    if (client.clientSecretHash.length > 0) {
      if (input.clientSecret === undefined || input.clientSecret.length === 0) {
        throw new OAuthError("invalid_client", "Client secret is required for this client.", 401);
      }
      const verification = await verifySecretWithRehash(
        input.clientSecret,
        client.clientSecretHash,
      );
      if (!verification.valid) {
        throw new OAuthError("invalid_client", "Invalid OAuth client credentials.", 401);
      }
      if (verification.rehashedSecretHash !== null) {
        try {
          await this.options.clientStore.rotateClientSecret(
            client.clientId,
            verification.rehashedSecretHash,
            now,
          );
        } catch {
          // A failed re-hash upgrade must not fail an otherwise valid request.
        }
      }
    }

    const redeemed = await redeemer.redeemCode({
      code: input.code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });
    // The code's scopes must remain a subset of what the client is allowed.
    const unauthorizedScope = redeemed.scopes.find((scope) => !client.scopes.includes(scope));
    if (unauthorizedScope !== undefined) {
      throw new OAuthError(
        "invalid_scope",
        `Client is not allowed to request scope: ${unauthorizedScope}`,
        400,
      );
    }

    const issuedAt = now;
    const expiresAt = new Date(issuedAt.getTime() + this.#tokenTtlSeconds * 1000);
    const grantedScopes = [...new Set(redeemed.scopes)];
    const accessToken: AccessTokenRecord = {
      token: `helix_at_${randomToken(32)}`,
      clientId: client.clientId,
      actorId: redeemed.actorId,
      orgId: redeemed.orgId,
      scopes: grantedScopes,
      issuedAt,
      expiresAt,
    };
    await this.options.tokenStore?.saveToken(accessToken);

    return {
      access_token: accessToken.token,
      token_type: "Bearer",
      expires_in: this.#tokenTtlSeconds,
      scope: grantedScopes.join(" "),
    };
  }

  /**
   * Authenticate an OAuth client by id and secret. Throws {@link OAuthError}
   * (`invalid_client`) when authentication fails. Used by the RFC 7009 / 7662
   * token-management endpoints, which require client authentication.
   */
  async authenticateClient(clientId: string, clientSecret: string): Promise<OAuthClientRecord> {
    const client = await this.options.clientStore.findClient(clientId);
    if (client === null) {
      throw new OAuthError("invalid_client", "Unknown OAuth client.", 401);
    }
    if (client.revokedAt !== null) {
      throw new OAuthError("invalid_client", "OAuth client has been revoked.", 401);
    }
    const verification = await verifySecretWithRehash(clientSecret, client.clientSecretHash);
    if (!verification.valid) {
      throw new OAuthError("invalid_client", "Invalid OAuth client credentials.", 401);
    }
    if (verification.rehashedSecretHash !== null) {
      try {
        await this.options.clientStore.rotateClientSecret(
          client.clientId,
          verification.rehashedSecretHash,
          new Date(),
        );
      } catch {
        // A failed re-hash upgrade must not fail an otherwise valid request.
      }
    }
    return client;
  }

  /**
   * Revoke an access token (RFC 7009). Revocation is idempotent: revoking an
   * unknown, expired, or already-revoked token is treated as a success.
   */
  async revokeToken(token: string): Promise<void> {
    const tokenStore = this.options.tokenStore;
    if (tokenStore?.revokeToken === undefined) {
      return;
    }
    await tokenStore.revokeToken(token, new Date());
  }

  /**
   * Introspect an access token (RFC 7662). Returns the token's metadata when
   * it is currently active, or `{ active: false }` otherwise.
   */
  async introspectToken(token: string): Promise<OAuthIntrospectionResponse> {
    const tokenStore = this.options.tokenStore;
    if (tokenStore === undefined || token.length === 0) {
      return { active: false };
    }
    const record = await tokenStore.findToken(token);
    if (record === null || record.expiresAt <= new Date()) {
      return { active: false };
    }
    return {
      active: true,
      scope: record.scopes.join(" "),
      client_id: record.clientId,
      token_type: "Bearer",
      exp: Math.floor(record.expiresAt.getTime() / 1000),
      iat: Math.floor(record.issuedAt.getTime() / 1000),
      sub: record.actorId,
      ...(record.actorEmail === undefined ? {} : { username: record.actorEmail }),
    };
  }
}

export interface OAuthIntrospectionResponse {
  readonly active: boolean;
  readonly scope?: string;
  readonly client_id?: string;
  readonly token_type?: OAuthTokenType;
  readonly exp?: number;
  readonly iat?: number;
  readonly sub?: string;
  readonly username?: string;
}

export interface OAuthClientManagerOptions {
  readonly clientStore: OAuthClientStore;
}

export class OAuthClientManager {
  constructor(private readonly options: OAuthClientManagerOptions) {}

  async createClient(input: OAuthClientCreateInput): Promise<OAuthClientRegistration> {
    const clientSecret = `helix_cs_${randomToken(32)}`;
    const client = await this.options.clientStore.createClient({
      ...input,
      clientId: `helix_client_${randomToken(18)}`,
      clientSecretHash: await hashSecret(clientSecret),
    });
    return { client, clientSecret };
  }

  /**
   * Replace a client's registered redirect-URI allowlist (CRITICAL-3).
   * Returns `null` when the client does not exist or the underlying store does
   * not support redirect-URI management.
   */
  async setRedirectUris(
    clientId: string,
    redirectUris: readonly string[],
  ): Promise<OAuthClientRecord | null> {
    const store = this.options.clientStore;
    if (store.setRedirectUris === undefined) {
      return null;
    }
    return store.setRedirectUris(clientId, redirectUris, new Date());
  }

  async revokeClient(clientId: string, revokedAt = new Date()): Promise<OAuthClientRecord | null> {
    return this.options.clientStore.revokeClient(clientId, revokedAt);
  }

  async listClients(input: OAuthClientListInput): Promise<readonly OAuthClientRecord[]> {
    return this.options.clientStore.listClients(input);
  }

  async rotateClientSecret(clientId: string): Promise<OAuthClientRegistration | null> {
    const clientSecret = `helix_cs_${randomToken(32)}`;
    const client = await this.options.clientStore.rotateClientSecret(
      clientId,
      await hashSecret(clientSecret),
      new Date(),
    );
    return client === null ? null : { client, clientSecret };
  }
}

export class InMemoryOAuthClientStore implements OAuthClientStore, AccessTokenStore {
  readonly #clients = new Map<string, OAuthClientRecord>();
  readonly #tokens = new Map<string, AccessTokenRecord>();

  async findClient(clientId: string): Promise<OAuthClientRecord | null> {
    return this.#clients.get(clientId) ?? null;
  }

  async listClients(input: OAuthClientListInput): Promise<readonly OAuthClientRecord[]> {
    return [...this.#clients.values()]
      .filter((client) => client.orgId === input.orgId)
      .filter((client) => input.actorId === undefined || client.actorId === input.actorId)
      .filter((client) => input.includeRevoked === true || client.revokedAt === null)
      .sort((left, right) => left.clientId.localeCompare(right.clientId));
  }

  async createClient(
    input: OAuthClientCreateInput & {
      readonly clientId: string;
      readonly clientSecretHash: string;
    },
  ): Promise<OAuthClientRecord> {
    const client: OAuthClientRecord = {
      clientId: input.clientId,
      clientSecretHash: input.clientSecretHash,
      actorId: input.actorId,
      orgId: input.orgId,
      scopes: [...new Set(input.scopes)],
      redirectUris: [...new Set(input.redirectUris ?? [])],
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    };
    this.#clients.set(client.clientId, client);
    return client;
  }

  async revokeClient(clientId: string, revokedAt: Date): Promise<OAuthClientRecord | null> {
    const client = this.#clients.get(clientId);
    if (client === undefined || client.revokedAt !== null) {
      return null;
    }
    const revoked = { ...client, revokedAt };
    this.#clients.set(clientId, revoked);
    return revoked;
  }

  async rotateClientSecret(
    clientId: string,
    clientSecretHash: string,
  ): Promise<OAuthClientRecord | null> {
    const client = this.#clients.get(clientId);
    if (client === undefined) {
      return null;
    }
    const rotated = { ...client, clientSecretHash };
    this.#clients.set(clientId, rotated);
    return rotated;
  }

  async setRedirectUris(
    clientId: string,
    redirectUris: readonly string[],
  ): Promise<OAuthClientRecord | null> {
    const client = this.#clients.get(clientId);
    if (client === undefined) {
      return null;
    }
    const updated: OAuthClientRecord = {
      ...client,
      redirectUris: [...new Set(redirectUris)],
    };
    this.#clients.set(clientId, updated);
    return updated;
  }

  readonly #revokedTokens = new Set<string>();

  async saveToken(token: AccessTokenRecord): Promise<void> {
    this.#tokens.set(token.token, token);
  }

  async findToken(token: string): Promise<AccessTokenRecord | null> {
    if (this.#revokedTokens.has(token)) {
      return null;
    }
    return this.#tokens.get(token) ?? null;
  }

  async revokeToken(token: string): Promise<void> {
    this.#revokedTokens.add(token);
  }
}

export function createOAuthTokenService(options: OAuthTokenServiceOptions): OAuthTokenService {
  return new OAuthTokenService(options);
}

export function createOAuthClientManager(options: OAuthClientManagerOptions): OAuthClientManager {
  return new OAuthClientManager(options);
}

export function parseScope(scope: string | undefined): string[] {
  if (scope === undefined || scope.trim().length === 0) {
    return [];
  }
  const tokens = scope.split(" ").filter((token) => token.length > 0);
  for (const token of tokens) {
    if (!SCOPE_TOKEN_PATTERN.test(token)) {
      throw new OAuthError("invalid_scope", `Invalid scope token: ${token}`, 400);
    }
  }
  return [...new Set(tokens)];
}

/**
 * `@node-rs/argon2` `Algorithm.Argon2id`. Inlined as a numeric literal because
 * the package exports it as an ambient const enum, which cannot be imported
 * under `verbatimModuleSyntax`.
 */
const ARGON2ID_ALGORITHM = 2;

/**
 * Argon2id parameters (PRD §9.2). These follow the OWASP-recommended minimum
 * for argon2id: 19 MiB memory, 2 iterations, 1 degree of parallelism.
 */
const ARGON2ID_OPTIONS = {
  algorithm: ARGON2ID_ALGORITHM,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash a client secret. New credentials are hashed with argon2id (PRD §9.2).
 * The returned value is a PHC-format string beginning with `$argon2id$`.
 */
export async function hashSecret(secret: string): Promise<string> {
  return argon2Hash(secret, ARGON2ID_OPTIONS);
}

/**
 * Legacy scrypt hashing. Retained only for tests and migration fixtures;
 * production code must use {@link hashSecret} (argon2id).
 */
export async function hashSecretScrypt(secret: string): Promise<string> {
  const salt = getCryptoProvider().randomBytes(16).toString("base64url");
  const derived = (await scrypt(secret, salt, SECRET_KEY_LENGTH)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

/**
 * Detect the hashing algorithm used to produce a stored secret hash.
 */
export function detectHashAlgorithm(hash: string): "argon2id" | "scrypt" | "unknown" {
  if (
    hash.startsWith("$argon2id$") ||
    hash.startsWith("$argon2i$") ||
    hash.startsWith("$argon2d$")
  ) {
    return "argon2id";
  }
  if (hash.startsWith("scrypt$")) {
    return "scrypt";
  }
  return "unknown";
}

async function verifyScryptSecret(secret: string, hash: string): Promise<boolean> {
  const [scheme, salt, expectedHash] = hash.split("$");
  if (scheme !== "scrypt" || salt === undefined || expectedHash === undefined) {
    return false;
  }
  const expected = Buffer.from(expectedHash, "base64url");
  const actual = (await scrypt(secret, salt, expected.length)) as Buffer;
  return getCryptoProvider().timingSafeEqual(actual, expected);
}

/**
 * Verify a client secret against a stored hash. Accepts both argon2id (current)
 * and legacy scrypt hashes, detecting the algorithm by the hash format.
 */
export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  const algorithm = detectHashAlgorithm(hash);
  if (algorithm === "argon2id") {
    try {
      return await argon2Verify(hash, secret);
    } catch {
      return false;
    }
  }
  if (algorithm === "scrypt") {
    return verifyScryptSecret(secret, hash);
  }
  return false;
}

export interface SecretVerificationResult {
  /** Whether the supplied secret matches the stored hash. */
  readonly valid: boolean;
  /**
   * When `valid` is true and the stored hash used a legacy algorithm (scrypt),
   * this holds a freshly computed argon2id hash so the caller can transparently
   * upgrade the stored credential. `null` when no rehash is needed.
   */
  readonly rehashedSecretHash: string | null;
}

/**
 * Verify a client secret and, on success, transparently upgrade legacy scrypt
 * hashes to argon2id. The caller is responsible for persisting
 * `rehashedSecretHash` when it is non-null.
 */
export async function verifySecretWithRehash(
  secret: string,
  hash: string,
): Promise<SecretVerificationResult> {
  const algorithm = detectHashAlgorithm(hash);
  const valid = await verifySecret(secret, hash);
  if (!valid || algorithm === "argon2id") {
    return { valid, rehashedSecretHash: null };
  }
  return { valid, rehashedSecretHash: await hashSecret(secret) };
}

function randomToken(bytes: number): string {
  return getCryptoProvider().randomBytes(bytes).toString("base64url");
}
