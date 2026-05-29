import type postgres from "postgres";
import { hashSecret, verifySecret } from "./oauth.js";

/**
 * A per-tenant SCIM bearer-token credential. Only the hash is persisted; the
 * plaintext token is only known to whoever rotated it last. `tokenHint` is a
 * short non-secret prefix (e.g. last 4 characters) so admin UIs can display
 * "Bearer …ab12" without exposing the secret.
 */
export interface TenantScimCredentialRecord {
  readonly orgId: string;
  readonly tokenHash: string;
  readonly tokenHint: string | null;
  readonly rotatedAt: Date;
  readonly rotatedByActorId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertTenantScimCredentialInput {
  readonly orgId: string;
  readonly tokenHash: string;
  readonly tokenHint?: string | null | undefined;
  readonly rotatedByActorId?: string | null | undefined;
}

export interface TenantScimCredentialStore {
  findByOrgId(orgId: string): Promise<TenantScimCredentialRecord | null>;
  upsert(input: UpsertTenantScimCredentialInput): Promise<TenantScimCredentialRecord>;
  delete(orgId: string): Promise<TenantScimCredentialRecord | null>;
}

interface TenantScimCredentialRow {
  readonly org_id: string;
  readonly token_hash: string;
  readonly token_hint: string | null;
  readonly rotated_at: Date;
  readonly rotated_by_actor_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresTenantScimCredentialStore implements TenantScimCredentialStore {
  constructor(private readonly sql: postgres.Sql) {}

  async findByOrgId(orgId: string): Promise<TenantScimCredentialRecord | null> {
    const selectedRows = await this.sql`
      select org_id, token_hash, token_hint, rotated_at, rotated_by_actor_id,
             created_at, updated_at
      from tenant_scim_credentials
      where org_id = ${orgId}
      limit 1
    `;
    const rows = selectedRows as unknown as readonly TenantScimCredentialRow[];
    return rows.length === 0 ? null : mapRow(rows[0]!);
  }

  async upsert(input: UpsertTenantScimCredentialInput): Promise<TenantScimCredentialRecord> {
    const insertedRows = await this.sql`
      insert into tenant_scim_credentials (
        org_id, token_hash, token_hint, rotated_by_actor_id
      )
      values (
        ${input.orgId},
        ${input.tokenHash},
        ${input.tokenHint ?? null},
        ${input.rotatedByActorId ?? null}
      )
      on conflict (org_id) do update set
        token_hash = excluded.token_hash,
        token_hint = excluded.token_hint,
        rotated_by_actor_id = excluded.rotated_by_actor_id,
        rotated_at = now(),
        updated_at = now()
      returning org_id, token_hash, token_hint, rotated_at, rotated_by_actor_id,
                created_at, updated_at
    `;
    const rows = insertedRows as unknown as readonly TenantScimCredentialRow[];
    return mapRow(rows[0]!);
  }

  async delete(orgId: string): Promise<TenantScimCredentialRecord | null> {
    const deletedRows = await this.sql`
      delete from tenant_scim_credentials
      where org_id = ${orgId}
      returning org_id, token_hash, token_hint, rotated_at, rotated_by_actor_id,
                created_at, updated_at
    `;
    const rows = deletedRows as unknown as readonly TenantScimCredentialRow[];
    return rows.length === 0 ? null : mapRow(rows[0]!);
  }
}

/**
 * In-memory implementation used by tests and single-tenant local dev. Keeps the
 * same upsert semantics (one row per tenant) as the Postgres store.
 */
export class InMemoryTenantScimCredentialStore implements TenantScimCredentialStore {
  private readonly records = new Map<string, TenantScimCredentialRecord>();

  async findByOrgId(orgId: string): Promise<TenantScimCredentialRecord | null> {
    return this.records.get(orgId) ?? null;
  }

  async upsert(input: UpsertTenantScimCredentialInput): Promise<TenantScimCredentialRecord> {
    const now = new Date();
    const existing = this.records.get(input.orgId);
    const record: TenantScimCredentialRecord = {
      orgId: input.orgId,
      tokenHash: input.tokenHash,
      tokenHint: input.tokenHint ?? null,
      rotatedAt: now,
      rotatedByActorId: input.rotatedByActorId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(input.orgId, record);
    return record;
  }

  async delete(orgId: string): Promise<TenantScimCredentialRecord | null> {
    const record = this.records.get(orgId);
    if (record === undefined) {
      return null;
    }
    this.records.delete(orgId);
    return record;
  }
}

/**
 * Hash a SCIM bearer token for storage. Uses the platform's standard secret
 * hash (argon2id) so SCIM tokens are stored with the same strength as OAuth
 * client secrets.
 */
export async function hashScimBearerToken(token: string): Promise<string> {
  return hashSecret(token);
}

/**
 * Verify a presented SCIM bearer token against a stored argon2id/scrypt hash.
 * Delegates to {@link verifySecret} which is constant-time relative to the
 * hash algorithm. Returns `false` when the hash is malformed.
 */
export async function verifyScimBearerToken(token: string, hash: string): Promise<boolean> {
  return verifySecret(token, hash);
}

/**
 * Derive a non-secret hint (last 4 characters) for displaying a SCIM token in
 * an admin UI without leaking the secret. Tokens shorter than 4 characters are
 * masked entirely.
 */
export function deriveScimTokenHint(token: string): string {
  if (token.length <= 4) {
    return "****";
  }
  return `…${token.slice(-4)}`;
}

function mapRow(row: TenantScimCredentialRow): TenantScimCredentialRecord {
  return {
    orgId: row.org_id,
    tokenHash: row.token_hash,
    tokenHint: row.token_hint,
    rotatedAt: row.rotated_at,
    rotatedByActorId: row.rotated_by_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
