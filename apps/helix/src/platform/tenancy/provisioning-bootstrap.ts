import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { computeAuditHash } from "../audit/hash.js";

export const tenantBootstrapSeedStepName = "tenant_bootstrap_seeded";

export interface TenantBootstrapSeedRecord {
  readonly orgId: string;
  readonly ownerActorId: string;
  readonly permissionSeeded: boolean;
  readonly activitySeeded: boolean;
}

export interface TenantBootstrapSeedStore {
  ensureTenantBootstrapSeed(input: {
    readonly orgId: string;
    readonly ownerEmail: string;
  }): Promise<TenantBootstrapSeedRecord>;
}

interface OwnerActorRow {
  readonly id: string;
}

interface InsertedRow {
  readonly id: string;
}

type ProvisioningSql = postgres.Sql | postgres.TransactionSql;

export class PostgresTenantBootstrapSeedStore implements TenantBootstrapSeedStore {
  constructor(private readonly sql: postgres.Sql) {}

  async ensureTenantBootstrapSeed(input: {
    readonly orgId: string;
    readonly ownerEmail: string;
  }): Promise<TenantBootstrapSeedRecord> {
    return this.sql.begin((tx) => seedTenantBootstrap(tx, input));
  }
}

async function seedTenantBootstrap(
  sql: ProvisioningSql,
  input: {
    readonly orgId: string;
    readonly ownerEmail: string;
  },
): Promise<TenantBootstrapSeedRecord> {
  const owner = await findOwnerActor(sql, input);
  const permissionRows = (await sql`
    insert into permissions (
      org_id,
      actor_id,
      resource_type,
      resource_id,
      role,
      granted_by_actor_id
    )
    select
      ${input.orgId},
      ${owner.id},
      'org',
      ${input.orgId},
      'owner',
      ${owner.id}
    where not exists (
      select 1
      from permissions
      where org_id = ${input.orgId}
        and actor_id = ${owner.id}
        and resource_type = 'org'
        and resource_id = ${input.orgId}
        and role = 'owner'
    )
    returning id
  `) as unknown as readonly InsertedRow[];

  const activitySeeded = await ensureBootstrapActivity(sql, {
    orgId: input.orgId,
    ownerActorId: owner.id,
  });

  return {
    orgId: input.orgId,
    ownerActorId: owner.id,
    permissionSeeded: permissionRows.length > 0,
    activitySeeded,
  };
}

async function findOwnerActor(
  sql: ProvisioningSql,
  input: {
    readonly orgId: string;
    readonly ownerEmail: string;
  },
): Promise<OwnerActorRow> {
  const rows = (await sql`
    select id
    from actors
    where org_id = ${input.orgId}
      and lower(email) = ${normalizeOwnerEmail(input.ownerEmail)}
      and disabled_at is null
    order by created_at asc
    limit 1
  `) as unknown as readonly OwnerActorRow[];
  const owner = rows[0];
  if (owner === undefined) {
    throw new Error("tenant bootstrap seed requires an existing owner actor");
  }
  return owner;
}

async function ensureBootstrapActivity(
  sql: ProvisioningSql,
  input: {
    readonly orgId: string;
    readonly ownerActorId: string;
  },
): Promise<boolean> {
  const existingRows = (await sql`
    select id
    from activity
    where org_id = ${input.orgId}
      and verb = 'tenant.bootstrap.seeded'
      and object_type = 'tenant'
      and object_id = ${input.orgId}
    limit 1
  `) as unknown as readonly InsertedRow[];
  if (existingRows.length > 0) {
    return false;
  }

  const previousRows = (await sql`
    select this_hash from activity
    where org_id = ${input.orgId}
    order by created_at desc, id desc
    limit 1
    for update
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const createdAt = new Date();
  const payload = bootstrapActivityPayload();
  const { thisHash } = computeAuditHash(
    {
      actorId: input.ownerActorId,
      verb: "tenant.bootstrap.seeded",
      objectType: "tenant",
      objectId: input.orgId,
      metadata: payload,
      createdAt: createdAt.toISOString(),
    },
    prevHash,
  );
  await sql`
    insert into activity (
      org_id,
      actor_id,
      verb,
      object_type,
      object_id,
      payload,
      prev_hash,
      this_hash,
      created_at
    )
    values (
      ${input.orgId},
      ${input.ownerActorId},
      'tenant.bootstrap.seeded',
      'tenant',
      ${input.orgId},
      ${sql.json(payload)},
      ${prevHash},
      ${thisHash},
      ${createdAt}
    )
  `;
  return true;
}

function bootstrapActivityPayload(): JsonObject {
  return {
    source: "tenant-provisioning",
    defaultPermissions: ["org.owner"],
  };
}

function normalizeOwnerEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("tenant bootstrap owner email is required");
  }
  return normalized;
}
