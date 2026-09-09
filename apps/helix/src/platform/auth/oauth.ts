import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { ActorRoleBinding } from "@helix/sdk-types";
import { getCryptoProvider } from "../crypto/index.js";

const DEFAULT_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;

export type OAuthGrantType = "client_credentials" | "authorization_code" | "refresh_token";
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
  /** Latest successful token issuance, when known by the backing store. */
  readonly lastUsedAt?: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  /** Epoch copied into issued tokens; revoke/secret rotation increments it. */
  readonly revocationEpoch?: number;
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
  readonly roleBindings?: readonly ActorRoleBinding[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface AccessTokenStore {
  saveToken(token: AccessTokenRecord): Promise<void>;
  findToken(token: string): Promise<AccessTokenRecord | null>;
}

export interface StoredAccessTokenRecord extends AccessTokenRecord {
  /** Canonical authorization-server origin this opaque token belongs to. */
  readonly issuer: string;
  readonly clientEpoch: number;
  readonly refreshFamilyId: string | null;
}

export interface RefreshTokenRecord {
  readonly token: string;
  readonly familyId: string;
  readonly clientId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly issuer: string;
  readonly scopes: readonly string[];
  readonly clientEpoch: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type RefreshTokenRotationResult =
  | {
      readonly status: "rotated";
      readonly accessToken: StoredAccessTokenRecord;
      readonly refreshToken: RefreshTokenRecord;
    }
  | { readonly status: "invalid" | "invalid_scope" | "reused" };

export interface OAuthTokenStore extends AccessTokenStore {
  saveToken(token: StoredAccessTokenRecord): Promise<void>;
  saveAuthorizationCodeTokens(
    accessToken: StoredAccessTokenRecord,
    refreshToken: RefreshTokenRecord,
  ): Promise<void>;
  findAccessTokenForClient(token: string, clientId: string): Promise<AccessTokenRecord | null>;
  findRefreshTokenForClient(token: string, clientId: string): Promise<RefreshTokenRecord | null>;
  rotateRefreshToken(input: {
    readonly token: string;
    readonly clientId: string;
    readonly nextAccessToken: string;
    readonly nextRefreshToken: string;
    readonly requestedScopes: readonly string[];
    readonly rotatedAt: Date;
    readonly accessExpiresAt: Date;
  }): Promise<RefreshTokenRotationResult>;
  revokeAccessTokenForClient(token: string, clientId: string, revokedAt: Date): Promise<void>;
  revokeRefreshTokenForClient(token: string, clientId: string, revokedAt: Date): Promise<void>;
}

export interface OAuthTokenRequest {
  readonly grantType: "client_credentials";
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
}

export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
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

export interface OAuthRefreshTokenRequest {
  readonly grantType: "refresh_token";
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly scope?: string;
}

export interface OAuthTokenServiceOptions {
  readonly clientStore: OAuthClientStore;
  readonly tokenStore: OAuthTokenStore;
  /** Canonical authorization-server origin used to bind durable token hashes. */
  readonly issuer: string;
  readonly tokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  /**
   * Authorization-code redeemer (PRD §13.6). When provided, the service can
   * mint access tokens for the `authorization_code` grant.
   */
  readonly authorizationCodeService?: OAuthAuthorizationCodeRedeemer;
}

export class OAuthTokenService {
  readonly #tokenTtlSeconds: number;
  readonly #refreshTokenTtlSeconds: number;
  readonly #issuer: string;

  constructor(private readonly options: OAuthTokenServiceOptions) {
    this.#issuer = options.issuer;
    this.#tokenTtlSeconds = options.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    this.#refreshTokenTtlSeconds =
      options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
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
    if (!(await verifySecret(input.clientSecret, client.clientSecretHash))) {
      throw new OAuthError("invalid_client", "Invalid OAuth client credentials.", 401);
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
    const accessToken: StoredAccessTokenRecord = {
      token: `helix_at_${randomToken(32)}`,
      clientId: client.clientId,
      actorId: client.actorId,
      orgId: client.orgId,
      issuer: this.#issuer,
      scopes: grantedScopes,
      clientEpoch: client.revocationEpoch ?? 0,
      refreshFamilyId: null,
      issuedAt,
      expiresAt,
    };
    await this.options.tokenStore.saveToken(accessToken);

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
      if (!(await verifySecret(input.clientSecret, client.clientSecretHash))) {
        throw new OAuthError("invalid_client", "Invalid OAuth client credentials.", 401);
      }
    }

    const redeemed = await redeemer.redeemCode({
      code: input.code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });
    if (redeemed.orgId !== client.orgId) {
      throw new OAuthError(
        "invalid_grant",
        "Authorization code tenant does not match the OAuth client installation.",
        400,
      );
    }
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
    const familyId = getCryptoProvider().randomUuid();
    const accessToken: StoredAccessTokenRecord = {
      token: `helix_at_${randomToken(32)}`,
      clientId: client.clientId,
      actorId: redeemed.actorId,
      orgId: redeemed.orgId,
      issuer: this.#issuer,
      scopes: grantedScopes,
      clientEpoch: client.revocationEpoch ?? 0,
      refreshFamilyId: familyId,
      issuedAt,
      expiresAt,
    };
    const refreshToken: RefreshTokenRecord = {
      token: `helix_rt_${randomToken(32)}`,
      familyId,
      clientId: client.clientId,
      actorId: redeemed.actorId,
      orgId: redeemed.orgId,
      issuer: this.#issuer,
      scopes: grantedScopes,
      clientEpoch: client.revocationEpoch ?? 0,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + this.#refreshTokenTtlSeconds * 1000),
    };
    await this.options.tokenStore.saveAuthorizationCodeTokens(accessToken, refreshToken);

    return {
      access_token: accessToken.token,
      refresh_token: refreshToken.token,
      token_type: "Bearer",
      expires_in: this.#tokenTtlSeconds,
      scope: grantedScopes.join(" "),
    };
  }

  async issueRefreshToken(input: OAuthRefreshTokenRequest): Promise<OAuthTokenResponse> {
    const client = await this.options.clientStore.findClient(input.clientId);
    if (client === null || client.revokedAt !== null) {
      throw new OAuthError("invalid_client", "Unknown or revoked OAuth client.", 401);
    }
    const now = new Date();
    if (client.expiresAt !== null && client.expiresAt <= now) {
      throw new OAuthError("invalid_client", "OAuth client has expired.", 401);
    }
    if (client.clientSecretHash.length > 0) {
      if (input.clientSecret === undefined || input.clientSecret.length === 0) {
        throw new OAuthError("invalid_client", "Client secret is required for this client.", 401);
      }
      if (!(await verifySecret(input.clientSecret, client.clientSecretHash))) {
        throw new OAuthError("invalid_client", "Invalid OAuth client credentials.", 401);
      }
    }

    const requestedScopes = parseScope(input.scope);
    const result = await this.options.tokenStore.rotateRefreshToken({
      token: input.refreshToken,
      clientId: client.clientId,
      nextAccessToken: `helix_at_${randomToken(32)}`,
      nextRefreshToken: `helix_rt_${randomToken(32)}`,
      requestedScopes,
      rotatedAt: now,
      accessExpiresAt: new Date(now.getTime() + this.#tokenTtlSeconds * 1000),
    });
    if (result.status === "invalid_scope") {
      throw new OAuthError("invalid_scope", "Requested scope exceeds the refresh grant.", 400);
    }
    if (result.status !== "rotated") {
      throw new OAuthError("invalid_grant", "Refresh token is invalid or has been reused.", 400);
    }
    return {
      access_token: result.accessToken.token,
      refresh_token: result.refreshToken.token,
      token_type: "Bearer",
      expires_in: this.#tokenTtlSeconds,
      scope: result.accessToken.scopes.join(" "),
    };
  }

  /**
   * Authenticate an OAuth client by id and secret. Throws {@link OAuthError}
   * (`invalid_client`) when authentication fails. Used by the RFC 7009 / 7662
   * token-management endpoints, which require client authentication.
   */
  async authenticateClient(clientId: string, clientSecret?: string): Promise<OAuthClientRecord> {
    const client = await this.options.clientStore.findClient(clientId);
    if (client === null) {
      throw new OAuthError("invalid_client", "Unknown OAuth client.", 401);
    }
    if (client.revokedAt !== null) {
      throw new OAuthError("invalid_client", "OAuth client has been revoked.", 401);
    }
    if (client.clientSecretHash.length > 0) {
      if (clientSecret === undefined || clientSecret.length === 0) {
        throw new OAuthError("invalid_client", "Client secret is required for this client.", 401);
      }
      if (!(await verifySecret(clientSecret, client.clientSecretHash))) {
        throw new OAuthError("invalid_client", "Invalid OAuth client credentials.", 401);
      }
    }
    return client;
  }

  /** RFC 7009 revocation, bound to the authenticated issuing client. */
  async revokeToken(input: {
    readonly token: string;
    readonly clientId: string;
    readonly tokenTypeHint?: "access_token" | "refresh_token";
  }): Promise<void> {
    const now = new Date();
    if (input.tokenTypeHint === "refresh_token") {
      await this.options.tokenStore.revokeRefreshTokenForClient(input.token, input.clientId, now);
      await this.options.tokenStore.revokeAccessTokenForClient(input.token, input.clientId, now);
      return;
    }
    await this.options.tokenStore.revokeAccessTokenForClient(input.token, input.clientId, now);
    await this.options.tokenStore.revokeRefreshTokenForClient(input.token, input.clientId, now);
  }

  /**
   * Introspect an access token (RFC 7662). Returns the token's metadata when
   * it is currently active, or `{ active: false }` otherwise.
   */
  async introspectToken(input: {
    readonly token: string;
    readonly clientId: string;
  }): Promise<OAuthIntrospectionResponse> {
    if (input.token.length === 0) {
      return { active: false };
    }
    const accessToken = await this.options.tokenStore.findAccessTokenForClient(
      input.token,
      input.clientId,
    );
    if (accessToken !== null) {
      return introspectionForToken(accessToken, "Bearer");
    }
    const refreshToken = await this.options.tokenStore.findRefreshTokenForClient(
      input.token,
      input.clientId,
    );
    return refreshToken === null
      ? { active: false }
      : introspectionForToken(refreshToken, "refresh_token");
  }
}

export interface OAuthIntrospectionResponse {
  readonly active: boolean;
  readonly scope?: string;
  readonly client_id?: string;
  readonly token_type?: OAuthTokenType | "refresh_token";
  readonly exp?: number;
  readonly iat?: number;
  readonly sub?: string;
  readonly username?: string;
}

function introspectionForToken(
  record: AccessTokenRecord | RefreshTokenRecord,
  tokenType: OAuthTokenType | "refresh_token",
): OAuthIntrospectionResponse {
  return {
    active: true,
    scope: record.scopes.join(" "),
    client_id: record.clientId,
    token_type: tokenType,
    exp: Math.floor(record.expiresAt.getTime() / 1000),
    iat: Math.floor(record.issuedAt.getTime() / 1000),
    sub: record.actorId,
    ...("actorEmail" in record ? { username: record.actorEmail } : {}),
  };
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

export class InMemoryOAuthClientStore implements OAuthClientStore, OAuthTokenStore {
  readonly #clients = new Map<string, OAuthClientRecord>();
  readonly #tokens = new Map<string, StoredAccessTokenRecord>();
  readonly #refreshTokens = new Map<string, RefreshTokenRecord>();
  readonly #consumedRefreshTokens = new Set<string>();
  readonly #revokedRefreshTokens = new Set<string>();

  constructor(private readonly issuer = "urn:helix:test") {}

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
      revocationEpoch: 0,
    };
    this.#clients.set(client.clientId, client);
    return client;
  }

  async revokeClient(clientId: string, revokedAt: Date): Promise<OAuthClientRecord | null> {
    const client = this.#clients.get(clientId);
    if (client === undefined || client.revokedAt !== null) {
      return null;
    }
    const revoked = {
      ...client,
      revokedAt,
      revocationEpoch: (client.revocationEpoch ?? 0) + 1,
    };
    this.#clients.set(clientId, revoked);
    return revoked;
  }

  async rotateClientSecret(
    clientId: string,
    clientSecretHash: string,
  ): Promise<OAuthClientRecord | null> {
    const client = this.#clients.get(clientId);
    if (client === undefined || client.revokedAt !== null) {
      return null;
    }
    const rotated = {
      ...client,
      clientSecretHash,
      revocationEpoch: (client.revocationEpoch ?? 0) + 1,
    };
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
    const client = this.#clients.get(token.clientId);
    const issuer =
      "issuer" in token && typeof token.issuer === "string" ? token.issuer : this.issuer;
    if (issuer !== this.issuer) {
      throw new Error("OAuth token issuer does not match this authorization server.");
    }
    this.#tokens.set(token.token, {
      ...token,
      issuer,
      clientEpoch:
        "clientEpoch" in token && typeof token.clientEpoch === "number"
          ? token.clientEpoch
          : (client?.revocationEpoch ?? 0),
      refreshFamilyId:
        "refreshFamilyId" in token && typeof token.refreshFamilyId === "string"
          ? token.refreshFamilyId
          : null,
    });
  }

  async findToken(token: string): Promise<AccessTokenRecord | null> {
    const record = this.#tokens.get(token);
    if (record === undefined || this.#revokedTokens.has(token) || record.expiresAt <= new Date()) {
      return null;
    }
    const client = this.#clients.get(record.clientId);
    // `AccessTokenStore.saveToken` is also used directly by route/session
    // tests and adapters that do not own an OAuth client registry. Tokens
    // issued by this store always have a client and take the stricter path.
    if (client === undefined) {
      return record;
    }
    if (
      record.issuer !== this.issuer ||
      client.revokedAt !== null ||
      (client.expiresAt !== null && client.expiresAt <= new Date()) ||
      record.clientEpoch !== (client.revocationEpoch ?? 0)
    ) {
      return null;
    }
    return record;
  }

  async saveAuthorizationCodeTokens(
    accessToken: StoredAccessTokenRecord,
    refreshToken: RefreshTokenRecord,
  ): Promise<void> {
    if (
      accessToken.refreshFamilyId !== refreshToken.familyId ||
      accessToken.clientId !== refreshToken.clientId ||
      accessToken.actorId !== refreshToken.actorId ||
      accessToken.orgId !== refreshToken.orgId ||
      accessToken.issuer !== refreshToken.issuer ||
      accessToken.clientEpoch !== refreshToken.clientEpoch
    ) {
      throw new Error("OAuth authorization token pair is inconsistent.");
    }
    if (accessToken.issuer !== this.issuer) {
      throw new Error("OAuth token issuer does not match this authorization server.");
    }
    this.#tokens.set(accessToken.token, accessToken);
    this.#refreshTokens.set(refreshToken.token, refreshToken);
  }

  async findAccessTokenForClient(
    token: string,
    clientId: string,
  ): Promise<AccessTokenRecord | null> {
    const record = await this.findToken(token);
    return record?.clientId === clientId ? record : null;
  }

  async findRefreshTokenForClient(
    token: string,
    clientId: string,
  ): Promise<RefreshTokenRecord | null> {
    const record = this.#refreshTokens.get(token);
    if (
      record === undefined ||
      record.clientId !== clientId ||
      record.issuer !== this.issuer ||
      record.expiresAt <= new Date() ||
      this.#consumedRefreshTokens.has(token) ||
      this.#revokedRefreshTokens.has(token)
    ) {
      return null;
    }
    const client = this.#clients.get(clientId);
    return client !== undefined &&
      client.revokedAt === null &&
      (client.expiresAt === null || client.expiresAt > new Date()) &&
      record.clientEpoch === (client.revocationEpoch ?? 0)
      ? record
      : null;
  }

  async rotateRefreshToken(input: {
    readonly token: string;
    readonly clientId: string;
    readonly nextAccessToken: string;
    readonly nextRefreshToken: string;
    readonly requestedScopes: readonly string[];
    readonly rotatedAt: Date;
    readonly accessExpiresAt: Date;
  }): Promise<RefreshTokenRotationResult> {
    const current = this.#refreshTokens.get(input.token);
    if (current === undefined || current.clientId !== input.clientId) {
      return { status: "invalid" };
    }
    if (this.#consumedRefreshTokens.has(input.token)) {
      this.#revokeFamily(current.familyId, current.clientId);
      return { status: "reused" };
    }
    const client = this.#clients.get(input.clientId);
    if (
      this.#revokedRefreshTokens.has(input.token) ||
      current.expiresAt <= input.rotatedAt ||
      client === undefined ||
      client.revokedAt !== null ||
      (client.expiresAt !== null && client.expiresAt <= input.rotatedAt) ||
      current.clientEpoch !== (client.revocationEpoch ?? 0)
    ) {
      return { status: "invalid" };
    }
    const scopes =
      input.requestedScopes.length === 0 ? [...current.scopes] : [...input.requestedScopes];
    if (scopes.some((scope) => !current.scopes.includes(scope))) {
      return { status: "invalid_scope" };
    }
    const accessToken: StoredAccessTokenRecord = {
      token: input.nextAccessToken,
      clientId: current.clientId,
      actorId: current.actorId,
      orgId: current.orgId,
      issuer: current.issuer,
      scopes,
      clientEpoch: current.clientEpoch,
      refreshFamilyId: current.familyId,
      issuedAt: input.rotatedAt,
      expiresAt: input.accessExpiresAt,
    };
    const refreshToken: RefreshTokenRecord = {
      ...current,
      token: input.nextRefreshToken,
      scopes,
      issuedAt: input.rotatedAt,
      expiresAt: current.expiresAt,
    };
    this.#consumedRefreshTokens.add(input.token);
    this.#tokens.set(accessToken.token, accessToken);
    this.#refreshTokens.set(refreshToken.token, refreshToken);
    return { status: "rotated", accessToken, refreshToken };
  }

  async revokeAccessTokenForClient(token: string, clientId: string): Promise<void> {
    if (this.#tokens.get(token)?.clientId === clientId) {
      this.#revokedTokens.add(token);
    }
  }

  async revokeRefreshTokenForClient(token: string, clientId: string): Promise<void> {
    const record = this.#refreshTokens.get(token);
    if (record?.clientId === clientId) {
      this.#revokeFamily(record.familyId, clientId);
    }
  }

  #revokeFamily(familyId: string, clientId: string): void {
    for (const [token, record] of this.#refreshTokens) {
      if (record.familyId === familyId && record.clientId === clientId) {
        this.#revokedRefreshTokens.add(token);
      }
    }
    for (const [token, record] of this.#tokens) {
      if (record.refreshFamilyId === familyId && record.clientId === clientId) {
        this.#revokedTokens.add(token);
      }
    }
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

/** Verify a client secret against the sole supported Argon2id format. */
export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  if (!hash.startsWith("$argon2id$")) return false;
  try {
    return await argon2Verify(hash, secret);
  } catch {
    return false;
  }
}

function randomToken(bytes: number): string {
  return getCryptoProvider().randomBytes(bytes).toString("base64url");
}
