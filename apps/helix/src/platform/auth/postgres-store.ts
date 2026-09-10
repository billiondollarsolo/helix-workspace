import type postgres from "postgres";
import { sha256Hex } from "../crypto/index.js";
import { parseActorRoleBindings } from "../permissions/roles.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { AuthorizationCodeRecord, AuthorizationCodeStore } from "./authorization-code.js";
import type {
  AgentAutomationPolicy,
  AgentCredentialInventoryRecord,
  AgentCredentialLifecycleStore,
  AgentCredentialPolicy,
  AgentCredentialRecord,
  AgentCredentialType,
  AllowedHoursWindow,
  ConfirmationOverride,
  IssueAgentCredentialInput,
  RateLimitOverrides,
  RotateAgentCredentialInput,
} from "./credentials.js";
import { EMPTY_CREDENTIAL_POLICY } from "./credentials.js";
import type {
  AccessTokenRecord,
  OAuthClientCreateInput,
  OAuthClientListInput,
  OAuthClientRecord,
  OAuthClientStore,
  OAuthTokenStore,
  RefreshTokenRecord,
  RefreshTokenRotationResult,
  StoredAccessTokenRecord,
} from "./oauth.js";

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
  readonly revocation_epoch: number | string;
}

interface AccessTokenRow {
  readonly client_id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly actor_type: AccessTokenRecord["actorType"];
  readonly actor_display_name: string;
  readonly actor_email: string | null;
  readonly scopes: readonly string[];
  readonly role_bindings: unknown;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly client_epoch: number | string;
  readonly refresh_family_id: string | null;
}

interface RefreshTokenRow {
  readonly family_id: string;
  readonly client_id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly scopes: readonly string[];
  readonly client_epoch: number | string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly client_revocation_epoch: number | string;
  readonly client_revoked_at: Date | null;
  readonly client_expires_at: Date | null;
}

type OAuthClientInsertInput = OAuthClientCreateInput & {
  readonly clientId: string;
  readonly clientSecretHash: string;
};

export class PostgresOAuthClientStore implements OAuthClientStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findClient(clientId: string): Promise<OAuthClientRecord | null> {
    const rows = await this.sql<OAuthClientRow[]>`
      select
        c.client_id,
        c.secret_hash,
        c.actor_id,
        a.org_id,
        c.scopes,
        c.redirect_uris,
        c.last_used_at,
        c.expires_at,
        c.revoked_at,
        c.revocation_epoch
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.client_id = ${clientId}
        and c.credential_type = 'oauth_client'
        and helix_credential_principal_is_active(c.actor_id, a.org_id)
      limit 1
    `;
    return rowToClient(rows[0]);
  }

  async listClients(input: OAuthClientListInput): Promise<readonly OAuthClientRecord[]> {
    const rows = await this.sql<OAuthClientRow[]>`
      select
        c.client_id,
        c.secret_hash,
        c.actor_id,
        a.org_id,
        c.scopes,
        c.redirect_uris,
        c.last_used_at,
        c.expires_at,
        c.revoked_at,
        c.revocation_epoch
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where a.org_id = ${input.orgId}
        and c.credential_type = 'oauth_client'
        and (${input.actorId ?? null}::uuid is null or c.actor_id = ${input.actorId ?? null}::uuid)
        and (${input.includeRevoked === true}::boolean or c.revoked_at is null)
      order by c.created_at desc, c.client_id asc
    `;
    return rows.flatMap((row) => {
      const client = rowToClient(row);
      return client === null ? [] : [client];
    });
  }

  async createClient(input: OAuthClientInsertInput): Promise<OAuthClientRecord> {
    const scopes = uniqueScopes(input.scopes);
    const redirectUris = uniqueScopes(input.redirectUris ?? []);
    const rows = await this.sql<OAuthClientRow[]>`
      with selected_actor as (
        select id, org_id
        from actors
        where id = ${input.actorId}
          and org_id = ${input.orgId}
          and helix_credential_principal_is_active(id, org_id)
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
        returning
          client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at,
          revocation_epoch
      )
      select
        inserted.client_id,
        inserted.secret_hash,
        inserted.actor_id,
        selected_actor.org_id,
        inserted.scopes,
        inserted.redirect_uris,
        inserted.expires_at,
        inserted.revoked_at,
        inserted.revocation_epoch
      from inserted
      join selected_actor on selected_actor.id = inserted.actor_id
    `;
    const client = rowToClient(rows[0]);
    if (client === null) {
      throw new Error("Failed to create OAuth client for actor in org.");
    }
    return client;
  }

  async revokeClient(clientId: string, revokedAt: Date): Promise<OAuthClientRecord | null> {
    const rows = await this.sql<OAuthClientRow[]>`
      with updated as (
        update agent_credentials
        set revoked_at = ${revokedAt},
            revocation_epoch = revocation_epoch + 1
        where client_id = ${clientId}
          and credential_type = 'oauth_client'
          and revoked_at is null
        returning
          client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at,
          revocation_epoch
      )
      select
        updated.client_id,
        updated.secret_hash,
        updated.actor_id,
        actors.org_id,
        updated.scopes,
        updated.redirect_uris,
        updated.expires_at,
        updated.revoked_at,
        updated.revocation_epoch
      from updated
      join actors on actors.id = updated.actor_id
    `;
    return rowToClient(rows[0]);
  }

  async rotateClientSecret(
    clientId: string,
    clientSecretHash: string,
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null> {
    void updatedAt;
    const rows = await this.sql<OAuthClientRow[]>`
      with updated as (
        update agent_credentials
        set secret_hash = ${clientSecretHash},
            revocation_epoch = revocation_epoch + 1
        where client_id = ${clientId}
          and credential_type = 'oauth_client'
          and revoked_at is null
        returning
          client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at,
          revocation_epoch
      )
      select
        updated.client_id,
        updated.secret_hash,
        updated.actor_id,
        actors.org_id,
        updated.scopes,
        updated.redirect_uris,
        updated.expires_at,
        updated.revoked_at,
        updated.revocation_epoch
      from updated
      join actors on actors.id = updated.actor_id
    `;
    return rowToClient(rows[0]);
  }

  async setRedirectUris(
    clientId: string,
    redirectUris: readonly string[],
    updatedAt: Date,
  ): Promise<OAuthClientRecord | null> {
    void updatedAt;
    const allowlist = uniqueScopes(redirectUris);
    const rows = await this.sql<OAuthClientRow[]>`
      with updated as (
        update agent_credentials
        set redirect_uris = ${this.sql.array(allowlist)}
        where client_id = ${clientId}
          and credential_type = 'oauth_client'
          and revoked_at is null
        returning
          client_id, secret_hash, actor_id, scopes, redirect_uris, expires_at, revoked_at,
          revocation_epoch
      )
      select
        updated.client_id,
        updated.secret_hash,
        updated.actor_id,
        actors.org_id,
        updated.scopes,
        updated.redirect_uris,
        updated.expires_at,
        updated.revoked_at,
        updated.revocation_epoch
      from updated
      join actors on actors.id = updated.actor_id
    `;
    return rowToClient(rows[0]);
  }
}

export class PostgresAccessTokenStore implements OAuthTokenStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly issuer: string,
  ) {}

  async saveToken(token: StoredAccessTokenRecord): Promise<void> {
    assertTokenIssuer(token, this.issuer);
    await this.sql.begin(async (tx) => {
      await lockIssuingClient(tx, token);
      await insertAccessToken(tx, token);
      await touchOAuthClient(tx, token.clientId, token.issuedAt);
    });
  }

  async saveAuthorizationCodeTokens(
    accessToken: StoredAccessTokenRecord,
    refreshToken: RefreshTokenRecord,
  ): Promise<void> {
    assertTokenPair(accessToken, refreshToken);
    assertTokenIssuer(accessToken, this.issuer);
    await this.sql.begin(async (tx) => {
      await lockIssuingClient(tx, accessToken);
      await insertAccessToken(tx, accessToken);
      await insertRefreshToken(tx, refreshToken);
      await touchOAuthClient(tx, accessToken.clientId, accessToken.issuedAt);
    });
  }

  async findToken(token: string): Promise<AccessTokenRecord | null> {
    return this.#findAccessToken(token, null);
  }

  async findAccessTokenForClient(
    token: string,
    clientId: string,
  ): Promise<AccessTokenRecord | null> {
    return this.#findAccessToken(token, clientId);
  }

  async #findAccessToken(
    token: string,
    clientId: string | null,
  ): Promise<AccessTokenRecord | null> {
    const rows = await this.sql<AccessTokenRow[]>`
      select
        t.client_id,
        t.actor_id,
        t.org_id,
        a.type as actor_type,
        a.display_name as actor_display_name,
        a.email as actor_email,
        t.scopes,
        helix_actor_role_bindings(t.org_id, t.actor_id) as role_bindings,
        t.issued_at,
        t.expires_at,
        t.client_epoch,
        t.refresh_family_id
      from oauth_access_tokens t
      join agent_credentials c
        on c.client_id = t.client_id
       and c.credential_type = 'oauth_client'
      join actors client_actor on client_actor.id = c.actor_id and client_actor.org_id = t.org_id
      join actors a on a.id = t.actor_id and a.org_id = t.org_id
      where t.token_hash = ${hashAccessToken(token, this.issuer)}
        and (${clientId}::text is null or t.client_id = ${clientId})
        and t.revoked_at is null
        and t.expires_at > now()
        and t.client_epoch = c.revocation_epoch
        and c.revoked_at is null
        and (c.expires_at is null or c.expires_at > now())
        and helix_credential_principal_is_active(client_actor.id, t.org_id)
        and helix_credential_principal_is_active(a.id, t.org_id)
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const roleBindings = parseActorRoleBindings(row.role_bindings);
    return {
      token,
      clientId: row.client_id,
      actorId: row.actor_id,
      orgId: row.org_id,
      ...(row.actor_type === undefined ? {} : { actorType: row.actor_type }),
      actorDisplayName: row.actor_display_name,
      ...(row.actor_email === null ? {} : { actorEmail: row.actor_email }),
      scopes: [...row.scopes],
      ...(roleBindings.length === 0 ? {} : { roleBindings }),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }

  async findRefreshTokenForClient(
    token: string,
    clientId: string,
  ): Promise<RefreshTokenRecord | null> {
    const rows = await this.sql<RefreshTokenRow[]>`
      select
        r.family_id,
        r.client_id,
        r.actor_id,
        r.org_id,
        r.scopes,
        r.client_epoch,
        r.issued_at,
        r.expires_at,
        r.consumed_at,
        r.revoked_at
      from oauth_refresh_tokens r
      join agent_credentials c
        on c.client_id = r.client_id
       and c.credential_type = 'oauth_client'
      join actors client_actor on client_actor.id = c.actor_id and client_actor.org_id = r.org_id
      join actors a on a.id = r.actor_id and a.org_id = r.org_id
      where r.token_hash = ${hashAccessToken(token, this.issuer)}
        and r.client_id = ${clientId}
        and r.consumed_at is null
        and r.revoked_at is null
        and r.expires_at > now()
        and r.client_epoch = c.revocation_epoch
        and c.revoked_at is null
        and (c.expires_at is null or c.expires_at > now())
        and helix_credential_principal_is_active(client_actor.id, r.org_id)
        and helix_credential_principal_is_active(a.id, r.org_id)
      limit 1
    `;
    return rowToRefreshToken(rows[0], token, this.issuer);
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
    return this.sql.begin(async (tx) => {
      const rows = await tx<RefreshTokenRow[]>`
        select
          r.family_id,
          r.client_id,
          r.actor_id,
          r.org_id,
          r.scopes,
          r.client_epoch,
          r.issued_at,
          r.expires_at,
          r.consumed_at,
          r.revoked_at,
          c.revocation_epoch as client_revocation_epoch,
          c.revoked_at as client_revoked_at,
          c.expires_at as client_expires_at
        from oauth_refresh_tokens r
        join agent_credentials c
          on c.client_id = r.client_id
         and c.credential_type = 'oauth_client'
        join actors client_actor on client_actor.id = c.actor_id and client_actor.org_id = r.org_id
        join actors a on a.id = r.actor_id and a.org_id = r.org_id
        where r.token_hash = ${hashAccessToken(input.token, this.issuer)}
          and r.client_id = ${input.clientId}
          and helix_credential_principal_is_active(client_actor.id, r.org_id)
          and helix_credential_principal_is_active(a.id, r.org_id)
        for update of r, c
      `;
      const current = rows[0];
      if (current === undefined) {
        return { status: "invalid" };
      }
      if (current.consumed_at !== null) {
        await revokeRefreshFamily(tx, current.family_id, current.client_id, input.rotatedAt);
        return { status: "reused" };
      }
      if (
        current.revoked_at !== null ||
        current.expires_at <= input.rotatedAt ||
        current.client_revoked_at !== null ||
        (current.client_expires_at !== null && current.client_expires_at <= input.rotatedAt) ||
        Number(current.client_epoch) !== Number(current.client_revocation_epoch)
      ) {
        return { status: "invalid" };
      }
      const scopes =
        input.requestedScopes.length === 0
          ? [...current.scopes]
          : uniqueScopes(input.requestedScopes);
      if (scopes.some((scope) => !current.scopes.includes(scope))) {
        return { status: "invalid_scope" };
      }
      const accessToken: StoredAccessTokenRecord = {
        token: input.nextAccessToken,
        clientId: current.client_id,
        actorId: current.actor_id,
        orgId: current.org_id,
        issuer: this.issuer,
        scopes,
        clientEpoch: Number(current.client_epoch),
        refreshFamilyId: current.family_id,
        issuedAt: input.rotatedAt,
        expiresAt: input.accessExpiresAt,
      };
      const refreshToken: RefreshTokenRecord = {
        token: input.nextRefreshToken,
        familyId: current.family_id,
        clientId: current.client_id,
        actorId: current.actor_id,
        orgId: current.org_id,
        issuer: this.issuer,
        scopes,
        clientEpoch: Number(current.client_epoch),
        issuedAt: input.rotatedAt,
        expiresAt: current.expires_at,
      };
      await tx`
        update oauth_refresh_tokens
        set consumed_at = ${input.rotatedAt},
            replaced_by_hash = ${hashAccessToken(input.nextRefreshToken, this.issuer)}
        where token_hash = ${hashAccessToken(input.token, this.issuer)}
          and client_id = ${input.clientId}
          and consumed_at is null
      `;
      await insertAccessToken(tx, accessToken);
      await insertRefreshToken(tx, refreshToken);
      await touchOAuthClient(tx, current.client_id, input.rotatedAt);
      return { status: "rotated", accessToken, refreshToken };
    });
  }

  async revokeAccessTokenForClient(
    token: string,
    clientId: string,
    revokedAt: Date,
  ): Promise<void> {
    await this.sql`
      update oauth_access_tokens
      set revoked_at = ${revokedAt}
      where token_hash = ${hashAccessToken(token, this.issuer)}
        and client_id = ${clientId}
        and revoked_at is null
    `;
  }

  async revokeRefreshTokenForClient(
    token: string,
    clientId: string,
    revokedAt: Date,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ readonly family_id: string }[]>`
        select family_id
        from oauth_refresh_tokens
        where token_hash = ${hashAccessToken(token, this.issuer)}
          and client_id = ${clientId}
        limit 1
        for update
      `;
      const row = rows[0];
      if (row !== undefined) {
        await revokeRefreshFamily(tx, row.family_id, clientId, revokedAt);
      }
    });
  }
}

export class PostgresOAuthStore implements OAuthClientStore, OAuthTokenStore {
  readonly #clientStore: PostgresOAuthClientStore;
  readonly #tokenStore: PostgresAccessTokenStore;

  constructor(sql: postgres.Sql, issuer: string) {
    this.#clientStore = new PostgresOAuthClientStore(sql);
    this.#tokenStore = new PostgresAccessTokenStore(sql, issuer);
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

  saveToken(token: StoredAccessTokenRecord): Promise<void> {
    return this.#tokenStore.saveToken(token);
  }

  saveAuthorizationCodeTokens(
    accessToken: StoredAccessTokenRecord,
    refreshToken: RefreshTokenRecord,
  ): Promise<void> {
    return this.#tokenStore.saveAuthorizationCodeTokens(accessToken, refreshToken);
  }

  findToken(token: string): Promise<AccessTokenRecord | null> {
    return this.#tokenStore.findToken(token);
  }

  findAccessTokenForClient(token: string, clientId: string): Promise<AccessTokenRecord | null> {
    return this.#tokenStore.findAccessTokenForClient(token, clientId);
  }

  findRefreshTokenForClient(token: string, clientId: string): Promise<RefreshTokenRecord | null> {
    return this.#tokenStore.findRefreshTokenForClient(token, clientId);
  }

  rotateRefreshToken(
    input: Parameters<OAuthTokenStore["rotateRefreshToken"]>[0],
  ): Promise<RefreshTokenRotationResult> {
    return this.#tokenStore.rotateRefreshToken(input);
  }

  revokeAccessTokenForClient(token: string, clientId: string, revokedAt: Date): Promise<void> {
    return this.#tokenStore.revokeAccessTokenForClient(token, clientId, revokedAt);
  }

  revokeRefreshTokenForClient(token: string, clientId: string, revokedAt: Date): Promise<void> {
    return this.#tokenStore.revokeRefreshTokenForClient(token, clientId, revokedAt);
  }
}

async function lockIssuingClient(
  sql: postgres.TransactionSql,
  token: StoredAccessTokenRecord,
): Promise<void> {
  const rows = await sql`
    select c.client_id
    from agent_credentials c
    join actors client_actor on client_actor.id = c.actor_id and client_actor.org_id = ${token.orgId}
    join actors subject on subject.id = ${token.actorId} and subject.org_id = ${token.orgId}
    where c.client_id = ${token.clientId}
      and c.credential_type = 'oauth_client'
      and c.revoked_at is null
      and (c.expires_at is null or c.expires_at > ${token.issuedAt})
      and c.revocation_epoch = ${token.clientEpoch}
      and helix_credential_principal_is_active(client_actor.id, ${token.orgId})
      and helix_credential_principal_is_active(subject.id, ${token.orgId})
    for share of c
  `;
  if (rows.length !== 1) {
    throw new Error("OAuth client changed before token persistence.");
  }
}

async function insertAccessToken(
  sql: postgres.TransactionSql,
  token: StoredAccessTokenRecord,
): Promise<void> {
  await sql`
    insert into oauth_access_tokens (
      token_hash,
      client_id,
      actor_id,
      org_id,
      scopes,
      client_epoch,
      refresh_family_id,
      issued_at,
      expires_at
    )
    values (
      ${hashAccessToken(token.token, token.issuer)},
      ${token.clientId},
      ${token.actorId},
      ${token.orgId},
      ${sql.array(uniqueScopes(token.scopes))},
      ${token.clientEpoch},
      ${token.refreshFamilyId},
      ${token.issuedAt},
      ${token.expiresAt}
    )
  `;
}

async function insertRefreshToken(
  sql: postgres.TransactionSql,
  token: RefreshTokenRecord,
): Promise<void> {
  await sql`
    insert into oauth_refresh_tokens (
      token_hash,
      family_id,
      client_id,
      actor_id,
      org_id,
      scopes,
      client_epoch,
      issued_at,
      expires_at
    )
    values (
      ${hashAccessToken(token.token, token.issuer)},
      ${token.familyId},
      ${token.clientId},
      ${token.actorId},
      ${token.orgId},
      ${sql.array(uniqueScopes(token.scopes))},
      ${token.clientEpoch},
      ${token.issuedAt},
      ${token.expiresAt}
    )
  `;
}

async function touchOAuthClient(
  sql: postgres.TransactionSql,
  clientId: string,
  usedAt: Date,
): Promise<void> {
  await sql`
    update agent_credentials
    set last_used_at = ${usedAt}
    where client_id = ${clientId}
      and credential_type = 'oauth_client'
  `;
}

async function revokeRefreshFamily(
  sql: postgres.TransactionSql,
  familyId: string,
  clientId: string,
  revokedAt: Date,
): Promise<void> {
  await sql`
    with revoked_refresh_tokens as (
      update oauth_refresh_tokens
      set revoked_at = ${revokedAt}
      where family_id = ${familyId}
        and client_id = ${clientId}
        and revoked_at is null
      returning family_id
    )
    update oauth_access_tokens
    set revoked_at = ${revokedAt}
    where refresh_family_id = ${familyId}
      and client_id = ${clientId}
      and revoked_at is null
  `;
}

function assertTokenPair(
  accessToken: StoredAccessTokenRecord,
  refreshToken: RefreshTokenRecord,
): void {
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
}

function assertTokenIssuer(
  token: StoredAccessTokenRecord | RefreshTokenRecord,
  issuer: string,
): void {
  if (token.issuer !== issuer) {
    throw new Error("OAuth token issuer does not match this authorization server.");
  }
}

export function hashAccessToken(token: string, issuer: string): string {
  // Routed through the crypto adapter (PRD §14.4). SHA-256 is FIPS-approved,
  // so the FIPS provider produces a byte-identical token-lookup hash.
  return sha256Hex(`${issuer}\0${token}`);
}

interface AuthorizationCodeRow {
  readonly code_hash: string;
  readonly client_id: string;
  readonly actor_id: string;
  readonly org_id: string;
  readonly redirect_uri: string;
  readonly scopes: readonly string[];
  readonly code_challenge: string;
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
        ${record.state},
        ${record.issuedAt},
        ${record.expiresAt}
      )
    `;
  }

  async consumeCode(codeHash: string, consumedAt: Date): Promise<AuthorizationCodeRecord | null> {
    const rows = await this.sql<AuthorizationCodeRow[]>`
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
        state,
        issued_at,
        expires_at,
        consumed_at
    `;
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
  readonly role_bindings: unknown;
  readonly client_id: string | null;
  readonly secret_hash: string | null;
  readonly api_key_hash: string | null;
  readonly cert_fingerprint: string | null;
  readonly label: string | null;
  readonly principal_type: "agent" | "service_account";
  readonly owner_actor_id: string;
  readonly purpose: string;
  readonly approval_owner_actor_id: string | null;
  readonly ip_allowlist: readonly string[] | null;
  readonly allowed_hours: unknown;
  readonly confirmation_override: unknown;
  readonly rate_limit_overrides: unknown;
  readonly automation_policy: unknown;
  readonly policy_version: string;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
  readonly rotated_at: Date | null;
  readonly last_used_at: Date | null;
}

const AGENT_CREDENTIAL_COLUMNS = `
  c.id,
  c.credential_type,
  c.actor_id,
  a.org_id,
  c.scopes,
  helix_actor_role_bindings(a.org_id, c.actor_id) as role_bindings,
  c.client_id,
  c.secret_hash,
  c.api_key_hash,
  c.cert_fingerprint,
  c.label,
  a.type as principal_type,
  c.owner_actor_id,
  c.purpose,
  c.approval_owner_actor_id,
  c.ip_allowlist,
  c.allowed_hours,
  c.confirmation_override,
  c.rate_limit_overrides,
  c.automation_policy,
  c.policy_version,
  c.last_used_at,
  c.expires_at,
  c.revoked_at,
  c.created_at,
  c.rotated_at,
  c.last_used_at
`;

/**
 * Postgres-backed store for the expanded agent credential model (PRD §9.2).
 * Resolves `api_key` and `mtls_cert` credentials together with their
 * per-credential policy fields for request-path enforcement.
 */
export class PostgresAgentCredentialStore implements AgentCredentialLifecycleStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findByApiKeyHash(apiKeyHash: string): Promise<AgentCredentialRecord | null> {
    const rows = await this.sql<AgentCredentialRow[]>`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.api_key_hash = ${apiKeyHash}
        and c.credential_type = 'api_key'
        and c.revoked_at is null
        and helix_credential_principal_is_active(c.actor_id, a.org_id)
        and a.disabled_at is null
      limit 1
    `;
    return rowToCredential(rows[0]);
  }

  async findByCertFingerprint(fingerprint: string): Promise<AgentCredentialRecord | null> {
    const rows = await this.sql<readonly AgentCredentialRow[]>`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.cert_fingerprint = ${fingerprint}
        and c.credential_type = 'mtls_cert'
        and c.revoked_at is null
        and a.disabled_at is null
        and helix_credential_principal_is_active(c.actor_id, a.org_id)
      limit 1
    `;
    return rowToCredential(rows[0]);
  }

  async findByClientId(clientId: string): Promise<AgentCredentialRecord | null> {
    const rows = await this.sql<readonly AgentCredentialRow[]>`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.client_id = ${clientId}
        and c.credential_type = 'oauth_client'
        and a.disabled_at is null
        and helix_credential_principal_is_active(c.actor_id, a.org_id)
      limit 1
    `;
    return rowToCredential(rows[0]);
  }

  async findById(credentialId: string): Promise<AgentCredentialRecord | null> {
    const rows = await this.sql<readonly AgentCredentialRow[]>`
      select ${this.sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
      from agent_credentials c
      join actors a on a.id = c.actor_id
      where c.id = ${credentialId}
        and a.disabled_at is null
        and helix_credential_principal_is_active(c.actor_id, a.org_id)
      limit 1
    `;
    return rowToCredential(rows[0]);
  }

  async markUsed(credentialId: string, usedAt: Date): Promise<void> {
    await this.sql`
      update agent_credentials set last_used_at = ${usedAt}, updated_at = ${usedAt}
      where id = ${credentialId} and revoked_at is null and expires_at > ${usedAt}
    `;
  }

  async issue(input: IssueAgentCredentialInput): Promise<AgentCredentialInventoryRecord> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.operatorActorId },
      async (tx) => {
        const rows = await tx<{ readonly id: string }[]>`
          select helix_issue_nonhuman_credential(
            ${input.orgId}, ${input.operatorActorId}, ${input.principalActorId},
            ${input.credentialType}, ${input.label}, ${input.purpose},
            ${tx.array([...new Set(input.scopes)])}, ${input.expiresAt},
            ${input.clientId ?? null}, ${input.secretHash ?? null},
            ${input.apiKeyHash ?? null}, ${input.certFingerprint ?? null}
          ) as id
        `;
        const credential = await selectAgentCredentialInventory(tx, rows[0]?.id);
        if (credential === null) throw new Error("Issued credential was not readable.");
        return credential;
      },
    );
  }

  async list(input: {
    readonly orgId: string;
    readonly principalActorId?: string;
    readonly includeRevoked: boolean;
  }): Promise<readonly AgentCredentialInventoryRecord[]> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx<AgentCredentialRow[]>`
        select ${tx.unsafe(AGENT_CREDENTIAL_COLUMNS)}
        from agent_credentials c
        join actors a on a.org_id = c.org_id and a.id = c.actor_id
        where c.org_id = ${input.orgId}
          and (${input.principalActorId ?? null}::uuid is null
            or c.actor_id = ${input.principalActorId ?? null}::uuid)
          and (${input.includeRevoked} or c.revoked_at is null)
        order by c.created_at desc, c.id
      `;
      return rows.map(rowToInventoryCredential);
    });
  }

  async rotate(input: RotateAgentCredentialInput): Promise<AgentCredentialInventoryRecord | null> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.operatorActorId },
      async (tx) => {
        const rows = await tx<{ readonly rotated: boolean }[]>`
          select helix_rotate_nonhuman_credential(
            ${input.orgId}, ${input.operatorActorId}, ${input.credentialId},
            ${input.expiresAt}, ${input.secretHash ?? null},
            ${input.apiKeyHash ?? null}, ${input.certFingerprint ?? null}
          ) as rotated
        `;
        return rows[0]?.rotated === true
          ? selectAgentCredentialInventory(tx, input.credentialId)
          : null;
      },
    );
  }

  async revoke(input: {
    readonly orgId: string;
    readonly operatorActorId: string;
    readonly credentialId: string;
  }): Promise<AgentCredentialInventoryRecord | null> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.operatorActorId },
      async (tx) => {
        const rows = await tx<{ readonly revoked: boolean }[]>`
          select helix_revoke_nonhuman_credential(
            ${input.orgId}, ${input.operatorActorId}, ${input.credentialId}
          ) as revoked
        `;
        return rows[0]?.revoked === true
          ? selectAgentCredentialInventory(tx, input.credentialId)
          : null;
      },
    );
  }
}

async function selectAgentCredentialInventory(
  sql: postgres.Sql | postgres.TransactionSql,
  credentialId: string | undefined,
): Promise<AgentCredentialInventoryRecord | null> {
  if (credentialId === undefined) return null;
  const rows = await sql<AgentCredentialRow[]>`
    select ${sql.unsafe(AGENT_CREDENTIAL_COLUMNS)}
    from agent_credentials c
    join actors a on a.org_id = c.org_id and a.id = c.actor_id
    where c.id = ${credentialId}
    limit 1
  `;
  return rows[0] === undefined ? null : rowToInventoryCredential(rows[0]);
}

function rowToInventoryCredential(row: AgentCredentialRow): AgentCredentialInventoryRecord {
  const credential = rowToCredential(row);
  if (credential === null) throw new Error("Credential row is required.");
  return {
    ...credential,
    principalType: row.principal_type,
    ownerActorId: row.owner_actor_id,
    purpose: row.purpose,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    lastUsedAt: row.last_used_at,
  };
}

function rowToCredential(row: AgentCredentialRow | undefined): AgentCredentialRecord | null {
  if (row === undefined) {
    return null;
  }
  const roleBindings = parseActorRoleBindings(row.role_bindings);
  return {
    id: row.id,
    credentialType: row.credential_type,
    actorId: row.actor_id,
    orgId: row.org_id,
    scopes: [...row.scopes],
    ...(roleBindings.length === 0 ? {} : { roleBindings }),
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
    revocationEpoch: Number(row.revocation_epoch),
  };
}

function rowToRefreshToken(
  row: RefreshTokenRow | undefined,
  token: string,
  issuer: string,
): RefreshTokenRecord | null {
  if (row === undefined) {
    return null;
  }
  return {
    token,
    familyId: row.family_id,
    clientId: row.client_id,
    actorId: row.actor_id,
    orgId: row.org_id,
    issuer,
    scopes: [...row.scopes],
    clientEpoch: Number(row.client_epoch),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

function uniqueScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)];
}
