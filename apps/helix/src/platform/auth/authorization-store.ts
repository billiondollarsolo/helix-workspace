import type postgres from "postgres";

export interface OAuthConsentNonce {
  readonly nonceHash: string;
  readonly clientId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly expiresAt: Date;
}

export interface OAuthGrant {
  readonly clientId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
}

export interface OAuthAuthorizationStore {
  isClientApproved(orgId: string, clientId: string): Promise<boolean>;
  saveConsentNonce(nonce: OAuthConsentNonce): Promise<void>;
  consumeConsentNonce(nonce: OAuthConsentNonce, consumedAt: Date): Promise<boolean>;
  recordGrant(grant: OAuthGrant): Promise<void>;
}

export class PostgresOAuthAuthorizationStore implements OAuthAuthorizationStore {
  constructor(private readonly sql: postgres.Sql) {}

  async isClientApproved(orgId: string, clientId: string): Promise<boolean> {
    const rows = await this.sql<{ readonly approved: boolean }[]>`
      select exists (
        select 1 from admin_oauth_apps
        where org_id = ${orgId}
          and client_id = ${clientId}
          and status = 'approved'
      ) as approved
    `;
    return rows[0]?.approved === true;
  }

  async saveConsentNonce(nonce: OAuthConsentNonce): Promise<void> {
    await this.sql`
      insert into oauth_consent_nonces
        (nonce_hash, client_id, actor_id, org_id, expires_at)
      values
        (${nonce.nonceHash}, ${nonce.clientId}, ${nonce.actorId}, ${nonce.orgId}, ${nonce.expiresAt})
    `;
  }

  async consumeConsentNonce(nonce: OAuthConsentNonce, consumedAt: Date): Promise<boolean> {
    const rows = await this.sql`
      update oauth_consent_nonces
      set consumed_at = ${consumedAt}
      where nonce_hash = ${nonce.nonceHash}
        and client_id = ${nonce.clientId}
        and actor_id = ${nonce.actorId}
        and org_id = ${nonce.orgId}
        and consumed_at is null
        and expires_at > ${consumedAt}
      returning nonce_hash
    `;
    return rows.length === 1;
  }

  async recordGrant(grant: OAuthGrant): Promise<void> {
    await this.sql`
      insert into oauth_grants (client_id, actor_id, org_id, scopes)
      values (
        ${grant.clientId},
        ${grant.actorId},
        ${grant.orgId},
        ${this.sql.array([...new Set(grant.scopes)])}
      )
      on conflict (org_id, actor_id, client_id) do update
      set scopes = excluded.scopes, revoked_at = null, updated_at = now()
    `;
  }
}

export class InMemoryOAuthAuthorizationStore implements OAuthAuthorizationStore {
  readonly #approved = new Set<string>();
  readonly #nonces = new Map<string, OAuthConsentNonce>();
  readonly #grants = new Map<string, OAuthGrant>();

  approveClient(orgId: string, clientId: string): void {
    this.#approved.add(key(orgId, clientId));
  }

  isClientApproved(orgId: string, clientId: string): Promise<boolean> {
    return Promise.resolve(this.#approved.has(key(orgId, clientId)));
  }

  saveConsentNonce(nonce: OAuthConsentNonce): Promise<void> {
    this.#nonces.set(nonce.nonceHash, nonce);
    return Promise.resolve();
  }

  consumeConsentNonce(nonce: OAuthConsentNonce, consumedAt: Date): Promise<boolean> {
    const stored = this.#nonces.get(nonce.nonceHash);
    const matches =
      stored !== undefined &&
      stored.clientId === nonce.clientId &&
      stored.actorId === nonce.actorId &&
      stored.orgId === nonce.orgId &&
      stored.expiresAt > consumedAt;
    if (matches) {
      this.#nonces.delete(nonce.nonceHash);
    }
    return Promise.resolve(matches);
  }

  recordGrant(grant: OAuthGrant): Promise<void> {
    this.#grants.set(key(grant.orgId, grant.actorId, grant.clientId), {
      ...grant,
      scopes: [...new Set(grant.scopes)],
    });
    return Promise.resolve();
  }

  findGrant(orgId: string, actorId: string, clientId: string): OAuthGrant | null {
    return this.#grants.get(key(orgId, actorId, clientId)) ?? null;
  }
}

function key(...parts: readonly string[]): string {
  return parts.join("\0");
}
