import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { insertAuditActivity } from "../audit/append.js";
import { withTenantPostgresContext } from "./postgres-roles.js";

export const tenantBootstrapSeedStepName = "tenant_bootstrap_seeded";

export interface TenantBootstrapSeedRecord {
  readonly orgId: string;
  readonly ownerActorId: string;
  readonly permissionSeeded: boolean;
  readonly activitySeeded: boolean;
}

interface TenantBootstrapSeedStore {
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
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
      seedTenantBootstrap(tx, input),
    );
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
  const permissionRows = await sql<InsertedRow[]>`
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
  `;

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
  const rows = await sql<OwnerActorRow[]>`
    select id
    from actors
    where org_id = ${input.orgId}
      and lower(email) = ${normalizeOwnerEmail(input.ownerEmail)}
      and disabled_at is null
    order by created_at asc
    limit 1
  `;
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
  const existingRows = await sql<InsertedRow[]>`
    select id
    from activity
    where org_id = ${input.orgId}
      and verb = 'tenant.bootstrap.seeded'
      and object_type = 'tenant'
      and object_id = ${input.orgId}
    limit 1
  `;
  if (existingRows.length > 0) {
    return false;
  }

  await insertAuditActivity(sql, {
    orgId: input.orgId,
    actorId: input.ownerActorId,
    verb: "tenant.bootstrap.seeded",
    objectType: "tenant",
    objectId: input.orgId,
    traceId: null,
    metadata: bootstrapActivityPayload(),
  });
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
