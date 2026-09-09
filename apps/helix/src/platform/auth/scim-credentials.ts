import type postgres from "postgres";
import { randomBytes, randomUuid } from "../crypto/index.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { hashSecret, verifySecret } from "./oauth.js";

export const SCIM_CREDENTIAL_SCOPES = [
  "scim.users.read",
  "scim.users.write",
  "scim.groups.read",
  "scim.groups.write",
] as const;

export type ScimCredentialScope = (typeof SCIM_CREDENTIAL_SCOPES)[number];

export class ScimCredentialConflictError extends Error {
  constructor() {
    super("A SCIM credential with that name already exists.");
    this.name = "ScimCredentialConflictError";
  }
}

export interface TenantScimCredentialRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly tokenHint: string;
  readonly scopes: readonly ScimCredentialScope[];
  readonly sourceCidrs: readonly string[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedByActorId: string | null;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly createdByActorId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateTenantScimCredentialInput {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly tokenHint: string;
  readonly scopes: readonly ScimCredentialScope[];
  readonly sourceCidrs: readonly string[];
  readonly expiresAt: Date;
  readonly createdByActorId: string;
}

export interface TenantScimCredentialStore {
  list(orgId: string): Promise<readonly TenantScimCredentialRecord[]>;
  findById(orgId: string, id: string): Promise<TenantScimCredentialRecord | null>;
  create(input: CreateTenantScimCredentialInput): Promise<TenantScimCredentialRecord>;
  revoke(
    orgId: string,
    id: string,
    revokedByActorId: string,
  ): Promise<TenantScimCredentialRecord | null>;
  markUsed(orgId: string, id: string, at: Date, ip: string): Promise<boolean>;
}

interface TenantScimCredentialRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly token_hash: string;
  readonly token_hint: string;
  readonly scopes: readonly string[];
  readonly source_cidrs: readonly string[];
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_by_actor_id: string | null;
  readonly last_used_at: Date | null;
  readonly last_used_ip: string | null;
  readonly created_by_actor_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const CREDENTIAL_COLUMNS = `
  id, org_id, name, token_hash, token_hint, scopes, source_cidrs::text[],
  expires_at, revoked_at, revoked_by_actor_id, last_used_at,
  last_used_ip::text, created_by_actor_id, created_at, updated_at
`;

export class PostgresTenantScimCredentialStore implements TenantScimCredentialStore {
  constructor(private readonly sql: postgres.Sql) {}

  async list(orgId: string): Promise<readonly TenantScimCredentialRecord[]> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx.unsafe<TenantScimCredentialRow[]>(
        `select ${CREDENTIAL_COLUMNS}
         from tenant_scim_credentials
         where org_id = $1
         order by revoked_at nulls first, created_at desc, id`,
        [orgId],
      );
      return rows.map(mapRow);
    });
  }

  async findById(orgId: string, id: string): Promise<TenantScimCredentialRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx.unsafe<TenantScimCredentialRow[]>(
        `select ${CREDENTIAL_COLUMNS}
         from tenant_scim_credentials
         where org_id = $1 and id = $2
         limit 1`,
        [orgId, id],
      );
      return rows[0] === undefined ? null : mapRow(rows[0]);
    });
  }

  async create(input: CreateTenantScimCredentialInput): Promise<TenantScimCredentialRecord> {
    try {
      return await withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
        const rows = await tx<TenantScimCredentialRow[]>`
          insert into tenant_scim_credentials (
            id, org_id, name, token_hash, token_hint, scopes, source_cidrs,
            expires_at, created_by_actor_id
          )
          values (
            ${input.id}, ${input.orgId}, ${input.name}, ${input.tokenHash}, ${input.tokenHint},
            ${tx.array([...input.scopes])}, ${tx.array([...input.sourceCidrs])}::inet[], ${input.expiresAt},
            ${input.createdByActorId}
          )
          returning id, org_id, name, token_hash, token_hint, scopes,
                    source_cidrs::text[], expires_at, revoked_at, revoked_by_actor_id,
                    last_used_at, last_used_ip::text, created_by_actor_id, created_at, updated_at
        `;
        const row = rows[0];
        if (row === undefined) throw new Error("Failed to create SCIM credential.");
        return mapRow(row);
      });
    } catch (error) {
      if (postgresErrorCode(error) === "23505") throw new ScimCredentialConflictError();
      throw error;
    }
  }

  async revoke(
    orgId: string,
    id: string,
    revokedByActorId: string,
  ): Promise<TenantScimCredentialRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<TenantScimCredentialRow[]>`
        update tenant_scim_credentials
        set revoked_at = coalesce(revoked_at, now()),
            revoked_by_actor_id = coalesce(revoked_by_actor_id, ${revokedByActorId}),
            updated_at = now()
        where org_id = ${orgId} and id = ${id}
        returning id, org_id, name, token_hash, token_hint, scopes,
                  source_cidrs::text[], expires_at, revoked_at, revoked_by_actor_id,
                  last_used_at, last_used_ip::text, created_by_actor_id, created_at, updated_at
      `;
      return rows[0] === undefined ? null : mapRow(rows[0]);
    });
  }

  async markUsed(orgId: string, id: string, at: Date, ip: string): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx`
        update tenant_scim_credentials
        set last_used_at = ${at}, last_used_ip = ${ip}::inet, updated_at = now()
        where org_id = ${orgId} and id = ${id}
          and revoked_at is null and expires_at > ${at}
        returning id
      `;
      return rows.length === 1;
    });
  }
}

export class InMemoryTenantScimCredentialStore implements TenantScimCredentialStore {
  private readonly records = new Map<string, TenantScimCredentialRecord>();

  async list(orgId: string): Promise<readonly TenantScimCredentialRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.orgId === orgId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findById(orgId: string, id: string): Promise<TenantScimCredentialRecord | null> {
    const record = this.records.get(id);
    return record?.orgId === orgId ? record : null;
  }

  async create(input: CreateTenantScimCredentialInput): Promise<TenantScimCredentialRecord> {
    if (
      this.records.has(input.id) ||
      [...this.records.values()].some(
        (record) =>
          record.orgId === input.orgId && record.name.toLowerCase() === input.name.toLowerCase(),
      )
    ) {
      throw new ScimCredentialConflictError();
    }
    const now = new Date();
    const record: TenantScimCredentialRecord = {
      ...input,
      scopes: [...input.scopes],
      sourceCidrs: [...input.sourceCidrs],
      revokedAt: null,
      revokedByActorId: null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(input.id, record);
    return record;
  }

  async revoke(
    orgId: string,
    id: string,
    revokedByActorId: string,
  ): Promise<TenantScimCredentialRecord | null> {
    const existing = await this.findById(orgId, id);
    if (existing === null) return null;
    const updated: TenantScimCredentialRecord = {
      ...existing,
      revokedAt: existing.revokedAt ?? new Date(),
      revokedByActorId: existing.revokedByActorId ?? revokedByActorId,
      updatedAt: new Date(),
    };
    this.records.set(id, updated);
    return updated;
  }

  async markUsed(orgId: string, id: string, at: Date, ip: string): Promise<boolean> {
    const existing = await this.findById(orgId, id);
    if (existing === null || existing.revokedAt !== null || existing.expiresAt <= at) return false;
    this.records.set(id, { ...existing, lastUsedAt: at, lastUsedIp: ip, updatedAt: at });
    return true;
  }
}

export interface IssuedScimBearerToken {
  readonly id: string;
  readonly token: string;
  readonly tokenHash: string;
  readonly tokenHint: string;
}

const SCIM_TOKEN_PATTERN =
  /^helix_scim_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export async function issueScimBearerToken(): Promise<IssuedScimBearerToken> {
  const id = randomUuid();
  const token = `helix_scim_${id}.${randomBytes(32).toString("base64url")}`;
  return {
    id,
    token,
    tokenHash: await hashScimBearerToken(token),
    tokenHint: deriveScimTokenHint(token),
  };
}

export function scimCredentialIdFromToken(token: string): string | null {
  return SCIM_TOKEN_PATTERN.exec(token)?.[1] ?? null;
}

export async function hashScimBearerToken(token: string): Promise<string> {
  return hashSecret(token);
}

export async function verifyScimBearerToken(token: string, hash: string): Promise<boolean> {
  return verifySecret(token, hash);
}

export function deriveScimTokenHint(token: string): string {
  return token.length <= 4 ? "****" : `…${token.slice(-4)}`;
}

function mapRow(row: TenantScimCredentialRow): TenantScimCredentialRecord {
  const scopes = row.scopes.filter((scope): scope is ScimCredentialScope =>
    SCIM_CREDENTIAL_SCOPES.includes(scope as ScimCredentialScope),
  );
  if (scopes.length !== row.scopes.length) throw new Error("Stored SCIM scope is invalid.");
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenHint: row.token_hint,
    scopes,
    sourceCidrs: [...row.source_cidrs],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByActorId: row.revoked_by_actor_id,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
