import type postgres from "postgres";
import { sha256Hex } from "../crypto/index.js";
import type {
  AccessTokenRecord,
  AccessTokenStore,
  OAuthClientCreateInput,
  OAuthClientListInput,
  OAuthClientRecord,
  OAuthClientStore,
} from "./oauth.js";
import type {
  AuthorizationCodeRecord,
  AuthorizationCodeStore,
  CodeChallengeMethod,
} from "./authorization-code.js";
import type {
  AgentAutomationPolicy,
  AgentCredentialPolicy,
  AgentCredentialRecord,
  AgentCredentialStore,
  AgentCredentialType,
  AllowedHoursWindow,
  ConfirmationOverride,
  RateLimitOverrides,
} from "./credentials.js";
import { EMPTY_CREDENTIAL_POLICY } from "./credentials.js";

interface OAuthClientRow {
  readonly client_id: string;
  readonly secret_hash: string | null;
  readonly actor_id: string;
  readonly org_id: string;
  readonly scopes: readonly string[];
  readonly redirect_uris: readonly string[] | null;
  readonly last_used_at?: Date | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
}

interface AccessTokenRow {
  readonly client_id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly actor_type: AccessTokenRecord["actorType"];
  readonly actor_display_name: string;
  readonly actor_email: string | null;
  readonly scopes: readonly string[];
  readonly issued_at: Date;
  readonly expires_at: Date;
}

type OAuthClientInsertInput = OAuthClientCreateInput & {
  readonly clientId: string;
  readonly clientSecretHash: string;
};

export class PostgresOAuthClientStore implements OAuthClientStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findClient(clientId: string): Promise<OAuthClientRecord | null> {
    const selectedRows = await this.sql`
      select
        c.client_id,
        c.secret_hash,
        c.actor_id,
        a.org_id,
        c.scopes,
        c.redirect_uris,
        c.last_used_at,
        c.expires_at,
        c.revoked_at
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.client_id = ${clientId}
        and c.credential_type = 'oauth_client'
      limit 1
    `;
    const rows = selectedRows as unknown as readonly OAuthClientRow[];
    return rowToClient(rows[0]);
  }

  async listClients(input: OAuthClientListInput): Promise<readonly OAuthClientRecord[]> {
    const selectedRows = await this.sql`
      select
        c.client_id,
        c.secret_hash,
        c.actor_id,
        a.org_id,
        c.scopes,
        c.redirect_uris,
        c.last_used_at,
        c.expires_at,
        c.revoked_at
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where a.org_id = ${input.orgId}
        and c.credential_type = 'oauth_client'
        and (${input.actorId ?? null}::uuid is null or c.actor_id = ${input.actorId ?? null}::uuid)
        and (${input.includeRevoked === true}::boolean or c.revoked_at is null)
      order by c.created_at desc, c.client_id asc
    `;
    const rows = selectedRows as unknown as readonly OAuthClientRow[];
    return rows.flatMap((row) => {
      const client = rowToClient(row);
      return client === null ? [] : [client];
    });
  }

  async createClient(input: OAuthClientInsertInput): Promise<OAuthClientRecord> {
    const scopes = uniqueScopes(input.scopes);
    const redirectUris = uniqueScopes(input.redirectUris ?? []);
    const insertedRows = await this.sql`
      with selected_actor as (
        select id, org_id
        from actors
        where id = ${input.actorId}
          and org_id = ${input.orgId}
          and (
            ${input.approvalOwnerActorId ?? null}::uuid is null
            or exists (
              select 1 from actors owner
              where owner.id = ${input.approvalOwnerActorId ?? null}::uuid
                and owner.org_id = ${input.orgId}
                and owner.type = 'user'
            )
          )
      ),
      inserted as (
        insert into agent_credentials (
          actor_id,
          credential_type,
          client_id,
          secret_hash,
          scopes,
          redirect_uris,
          created_by,
          approval_owner_actor_id,
          expires_at
        )
        select
          selected_actor.id,
          ${"oauth_client"},
          ${input.clientId},
          ${input.clientSecretHash},
          ${this.sql.array(scopes)},
          ${this.sql.array(redirectUris)},
          ${input.approvalOwnerActorId ?? null},
          ${input.approvalOwnerActorId ?? null},
          ${input.expiresAt ?? null}
        from selected_actor
        returning client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at
      )
      select
        inserted.client_id,
        inserted.secret_hash,
        inserted.actor_id,
        selected_actor.org_id,
        inserted.scopes,
        inserted.redirect_uris,
        inserted.expires_at,
        inserted.revoked_at
      from inserted
      join selected_actor on selected_actor.id = inserted.actor_id
    `;
    const rows = insertedRows as unknown as readonly OAuthClientRow[];
    const client = rowToClient(rows[0]);
    if (client === null) {
      throw new Error("Failed to create OAuth client for actor in org.");
    }
    return client;
  }

  async revokeClient(clientId: string, revokedAt: Date): Promise<OAuthClientRecord | null> {
    const updatedRows = await this.sql`
      with updated as (
        update agent_credentials
        set revoked_at = ${revokedAt}
        where client_id = ${clientId}
          and credential_type = 'oauth_client'
          and revoked_at is null
        returning client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at
      )
      select
        updated.client_id,
        updated.secret_hash,
        updated.actor_id,
        actors.org_id,
        updated.scopes,
        updated.redirect_uris,
        updated.expires_at,
        updated.revoked_at
      from updated
      join actors on actors.id = updated.actor_id
    `;
    const rows = updatedRows as unknown as readonly OAuthClientRow[];
    return rowToClient(rows[0]);
  }

  async rotateClientSecret(
    clientId: string,
    clientSecretHash: string,
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null> {
    void updatedAt;
    const updatedRows = await this.sql`
      with updated as (
        update agent_credentials
        set secret_hash = ${clientSecretHash}
        where client_id = ${clientId}
          and credential_type = 'oauth_client'
          and revoked_at is null
        returning client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at
      )
      select
        updated.client_id,
        updated.secret_hash,
        updated.actor_id,
        actors.org_id,
        updated.scopes,
        updated.redirect_uris,
        updated.expires_at,
        updated.revoked_at
      from updated
      join actors on actors.id = updated.actor_id
    `;
    const rows = updatedRows as unknown as readonly OAuthClientRow[];
    return rowToClient(rows[0]);
  }

  async setRedirectUris(
    clientId: string,
    redirectUris: readonly string[],
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null> {
    void updatedAt;
    const allowlist = uniqueScopes(redirectUris);
    const updatedRows = await this.sql`
      with updated as (
        update agent_credentials
        set redirect_uris = ${this.sql.array(allowlist)}
        where client_id = ${clientId}
          and credential_type = 'oauth_client'
          and revoked_at is null
        returning client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at
      )
      select
        updated.client_id,
        updated.secret_hash,
        updated.actor_id,
        actors.org_id,
        updated.scopes,
        updated.redirect_uris,
        updated.expires_at,
        updated.revoked_at
      from updated
      join actors on actors.id = updated.actor_id
    `;
    const rows = updatedRows as unknown as readonly OAuthClientRow[];
    return rowToClient(rows[0]);
  }
}

export class PostgresAccessTokenStore implements AccessTokenStore {
  constructor(private readonly sql: postgres.Sql) {}

  async saveToken(token: AccessTokenRecord): Promise<void> {
    await this.sql`
      insert into oauth_access_tokens (
        token_hash,
        client_id,
        actor_id,
        org_id,
        scopes,
        issued_at,
        expires_at
      )
      values (
        ${hashAccessToken(token.token)},
        ${token.clientId},
        ${token.actorId},
        ${token.orgId},
        ${this.sql.array(uniqueScopes(token.scopes))},
        ${token.issuedAt},
        ${token.expiresAt}
      )
    `;
    await this.sql`
      update agent_credentials
      set last_used_at = ${token.issuedAt}
      where client_id = ${token.clientId}
        and credential_type = 'oauth_client'
    `;
  }

  async findToken(token: string): Promise<AccessTokenRecord | null> {
    const selectedRows = await this.sql`
      select
        t.client_id,
        t.actor_id,
        t.org_id,
        a.type as actor_type,
        a.display_name as actor_display_name,
        a.email as actor_email,
        t.scopes,
        t.issued_at,
        t.expires_at
      from oauth_access_tokens t
      join actors a on a.id = t.actor_id and a.org_id = t.org_id
      where t.token_hash = ${hashAccessToken(token)}
        and t.revoked_at is null
        and t.expires_at > now()
        and a.disabled_at is null
      limit 1
    `;
    const rows = selectedRows as unknown as readonly AccessTokenRow[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      token,
      clientId: row.client_id,
      actorId: row.actor_id,
      orgId: row.org_id,
      ...(row.actor_type === undefined ? {} : { actorType: row.actor_type }),
      actorDisplayName: row.actor_display_name,
      ...(row.actor_email === null ? {} : { actorEmail: row.actor_email }),
      scopes: [...row.scopes],
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }

  async revokeToken(token: string, revokedAt: Date): Promise<void> {
    await this.sql`
      update oauth_access_tokens
      set revoked_at = ${revokedAt}
      where token_hash = ${hashAccessToken(token)}
        and revoked_at is null
    `;
  }
}

export class PostgresOAuthStore implements OAuthClientStore, AccessTokenStore {
  readonly #clientStore: PostgresOAuthClientStore;
  readonly #tokenStore: PostgresAccessTokenStore;

  constructor(sql: postgres.Sql) {
    this.#clientStore = new PostgresOAuthClientStore(sql);
    this.#tokenStore = new PostgresAccessTokenStore(sql);
  }

  findClient(clientId: string): Promise<OAuthClientRecord | null> {
    return this.#clientStore.findClient(clientId);
  }

  listClients(input: OAuthClientListInput): Promise<readonly OAuthClientRecord[]> {
    return this.#clientStore.listClients(input);
  }

  createClient(input: OAuthClientInsertInput): Promise<OAuthClientRecord> {
    return this.#clientStore.createClient(input);
  }

  revokeClient(clientId: string, revokedAt: Date): Promise<OAuthClientRecord | null> {
    return this.#clientStore.revokeClient(clientId, revokedAt);
  }

  rotateClientSecret(
    clientId: string,
    clientSecretHash: string,
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null> {
    return this.#clientStore.rotateClientSecret(clientId, clientSecretHash, updatedAt);
  }

  setRedirectUris(
    clientId: string,
    redirectUris: readonly string[],
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null> {
    return this.#clientStore.setRedirectUris(clientId, redirectUris, updatedAt);
  }

  saveToken(token: AccessTokenRecord): Promise<void> {
    return this.#tokenStore.saveToken(token);
  }

  findToken(token: string): Promise<AccessTokenRecord | null> {
    return this.#tokenStore.findToken(token);
  }

  revokeToken(token: string, revokedAt: Date): Promise<void> {
    return this.#tokenStore.revokeToken(token, revokedAt);
  }
}

export function hashAccessToken(token: string): string {
  // Routed through the crypto adapter (PRD §14.4). SHA-256 is FIPS-approved,
  // so the FIPS provider produces a byte-identical token-lookup hash.
  return sha256Hex(token);
}

interface AuthorizationCodeRow {
  readonly code_hash: string;
  readonly client_id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly redirect_uri: string;
  readonly scopes: readonly string[];
  readonly code_challenge: string;
  readonly code_challenge_method: CodeChallengeMethod;
  readonly state: string | null;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

/**
 * Postgres-backed authorization-code store (PRD §13.6). Codes are
 * single-use: {@link consumeCode} marks the row consumed in the same
 * statement that returns it, so concurrent redemptions cannot both succeed.
 */
export class PostgresAuthorizationCodeStore implements AuthorizationCodeStore {
  constructor(private readonly sql: postgres.Sql) {}

  async saveCode(record: AuthorizationCodeRecord): Promise<void> {
    await this.sql`
      insert into oauth_authorization_codes (
        code_hash,
        client_id,
        actor_id,
        org_id,
        redirect_uri,
        scopes,
        code_challenge,
        code_challenge_method,
        state,
        issued_at,
        expires_at
      )
      values (
        ${record.codeHash},
        ${record.clientId},
        ${record.actorId},
        ${record.orgId},
        ${record.redirectUri},
        ${this.sql.array([...new Set(record.scopes)])},
        ${record.codeChallenge},
        ${record.codeChallengeMethod},
        ${record.state},
        ${record.issuedAt},
        ${record.expiresAt}
      )
    `;
  }

  async consumeCode(codeHash: string, consumedAt: Date): Promise<AuthorizationCodeRecord | null> {
    const updatedRows = await this.sql`
      update oauth_authorization_codes
      set consumed_at = ${consumedAt}
      where code_hash = ${codeHash}
        and consumed_at is null
        and expires_at > ${consumedAt}
      returning
        code_hash,
        client_id,
        actor_id,
        org_id,
        redirect_uri,
        scopes,
        code_challenge,
        code_challenge_method,
        state,
        issued_at,
        expires_at,
        consumed_at
    `;
    const rows = updatedRows as unknown as readonly AuthorizationCodeRow[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      codeHash: row.code_hash,
      clientId: row.client_id,
      actorId: row.actor_id,
      orgId: row.org_id,
      redirectUri: row.redirect_uri,
      scopes: [...row.scopes],
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      state: row.state,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }
}

interface AgentCredentialRow {
  readonly id: string;
  readonly credential_type: AgentCredentialType;
  readonly actor_id: string;
  readonly org_id: string;
  readonly scopes: readonly string[];
  readonly client_id: string | null;
  readonly secret_hash: string | null;
  readonly api_key_hash: string | null;
  readonly cert_fingerprint: string | null;
  readonly label: string | null;
  readonly approval_owner_actor_id: string | null;
  readonly ip_allowlist: readonly string[] | null;
  readonly allowed_hours: unknown;
  readonly confirmation_override: unknown;
  readonly rate_limit_overrides: unknown;
  readonly automation_policy: unknown;
  readonly policy_version: string;
  readonly last_used_at: Date | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
}

const AGENT_CREDENTIAL_COLUMNS = `
  c.id,
  c.credential_type,
  c.actor_id,
  a.org_id,
  c.scopes,
  c.client_id,
  c.secret_hash,
  c.api_key_hash,
  c.cert_fingerprint,
  c.label,
  c.approval_owner_actor_id,
  c.ip_allowlist,
  c.allowed_hours,
  c.confirmation_override,
  c.rate_limit_overrides,
  c.automation_policy,
  c.policy_version,
  c.last_used_at,
  c.expires_at,
  c.revoked_at
`;

/**
 * Postgres-backed store for the expanded agent credential model (PRD §9.2).
 * Resolves `api_key` and `mtls_cert` credentials together with their
 * per-credential policy fields for request-path enforcement.
 */
export class PostgresAgentCredentialStore implements AgentCredentialStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findByApiKeyHash(apiKeyHash: string): Promise<AgentCredentialRecord | null> {
    const rows = (await this.sql`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.api_key_hash = ${apiKeyHash}
        and c.credential_type = 'api_key'
        and c.revoked_at is null
        and a.disabled_at is null
      limit 1
    `) as unknown as readonly AgentCredentialRow[];
    return rowToCredential(rows[0]);
  }

  async findByCertFingerprint(fingerprint: string): Promise<AgentCredentialRecord | null> {
    const rows = (await this.sql`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.cert_fingerprint = ${fingerprint}
        and c.credential_type = 'mtls_cert'
        and c.revoked_at is null
        and a.disabled_at is null
      limit 1
    `) as unknown as readonly AgentCredentialRow[];
    return rowToCredential(rows[0]);
  }

  async findByClientId(clientId: string): Promise<AgentCredentialRecord | null> {
    const rows = (await this.sql`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.client_id = ${clientId}
        and c.credential_type = 'oauth_client'
        and a.disabled_at is null
      limit 1
    `) as unknown as readonly AgentCredentialRow[];
    return rowToCredential(rows[0]);
  }

  async findById(credentialId: string): Promise<AgentCredentialRecord | null> {
    const rows = (await this.sql`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.id = ${credentialId}
        and a.disabled_at is null
      limit 1
    `) as unknown as readonly AgentCredentialRow[];
    return rowToCredential(rows[0]);
  }
}

function rowToCredential(row: AgentCredentialRow | undefined): AgentCredentialRecord | null {
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    credentialType: row.credential_type,
    actorId: row.actor_id,
    orgId: row.org_id,
    scopes: [...row.scopes],
    clientId: row.client_id,
    secretHash: row.secret_hash,
    apiKeyHash: row.api_key_hash,
    certFingerprint: row.cert_fingerprint,
    label: row.label,
    approvalOwnerActorId: row.approval_owner_actor_id,
    policy: rowToPolicy(row),
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function rowToPolicy(row: AgentCredentialRow): AgentCredentialPolicy {
  return {
    ipAllowlist: row.ip_allowlist === null ? [] : [...row.ip_allowlist],
    allowedHours: parseAllowedHours(row.allowed_hours),
    confirmationOverride: parseConfirmationOverride(row.confirmation_override),
    rateLimitOverrides: parseRateLimitOverrides(row.rate_limit_overrides),
    automationPolicy: parseAutomationPolicy(row.automation_policy),
    version: row.policy_version,
  };
}

function parseAutomationPolicy(value: unknown): AgentAutomationPolicy | null {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    !Array.isArray((value as { readonly rules?: unknown }).rules)
  ) {
    return null;
  }
  return value as AgentAutomationPolicy;
}

function parseAllowedHours(value: unknown): AllowedHoursWindow | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.startHour !== "number" || typeof record.endHour !== "number") {
    return null;
  }
  return {
    startHour: record.startHour,
    endHour: record.endHour,
    ...(typeof record.timeZone === "string" ? { timeZone: record.timeZone } : {}),
    ...(Array.isArray(record.days)
      ? { days: record.days.filter((day): day is number => typeof day === "number") }
      : {}),
  };
}

function parseConfirmationOverride(value: unknown): ConfirmationOverride {
  if (value === "always" || value === "never" || value === "inherit") {
    return value;
  }
  if (value !== null && typeof value === "object") {
    const mode = (value as Record<string, unknown>).mode;
    if (mode === "always" || mode === "never" || mode === "inherit") {
      return mode;
    }
  }
  return EMPTY_CREDENTIAL_POLICY.confirmationOverride;
}

function parseRateLimitOverrides(value: unknown): RateLimitOverrides {
  if (value === null || value === undefined || typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  const result: { -readonly [K in keyof RateLimitOverrides]?: number | null } = {};
  for (const key of ["requestsPerMinute", "requestsPerDay", "costPerDayUsdMicros"] as const) {
    const entry = record[key];
    if (entry === null || typeof entry === "number") {
      result[key] = entry;
    }
  }
  return result;
}

function rowToClient(row: OAuthClientRow | undefined): OAuthClientRecord | null {
  if (row === undefined || row.secret_hash === null) {
    return null;
  }
  return {
    clientId: row.client_id,
    clientSecretHash: row.secret_hash,
    actorId: row.actor_id,
    orgId: row.org_id,
    scopes: [...row.scopes],
    redirectUris: row.redirect_uris === null ? [] : [...row.redirect_uris],
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)];
}
