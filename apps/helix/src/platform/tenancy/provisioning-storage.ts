import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";

export const objectStorePrefixStepName = "object_store_prefix";

export interface TenantStorageNamespaceRecord {
  readonly orgId: string;
  readonly storage: JsonObject;
}

export interface TenantStorageNamespaceStore {
  ensureDefaultObjectStorePrefix(input: { readonly orgId: string }): Promise<TenantStorageNamespaceRecord>;
}

interface TenantStorageNamespaceRow {
  readonly id: string;
  readonly storage: JsonObject;
  readonly had_storage: boolean;
}

type ProvisioningSql = postgres.Sql | postgres.TransactionSql;

export class PostgresTenantStorageNamespaceStore implements TenantStorageNamespaceStore {
  constructor(private readonly sql: postgres.Sql) {}

  async ensureDefaultObjectStorePrefix(input: {
    readonly orgId: string;
  }): Promise<TenantStorageNamespaceRecord> {
    return this.sql.begin((tx) => seedDefaultObjectStorePrefix(tx, input.orgId));
  }
}

export function defaultObjectStorePrefix(orgId: string): string {
  return `tenants/${orgId}/`;
}

export function defaultObjectStoreConfig(orgId: string): JsonObject {
  return {
    kind: "helix-default",
    managedBy: "helix",
    prefix: defaultObjectStorePrefix(orgId),
    status: "configured",
    version: 1,
  };
}

async function seedDefaultObjectStorePrefix(
  sql: ProvisioningSql,
  orgId: string,
): Promise<TenantStorageNamespaceRecord> {
  const storageConfig = defaultObjectStoreConfig(orgId);
  const rows = (await sql`
    with target as (
      select id, byo_config, byo_config ? 'storage' as had_storage
      from orgs
      where id = ${orgId}
      for update
    )
    update orgs
    set
      byo_config = jsonb_set(
        target.byo_config,
        '{storage}',
        coalesce(target.byo_config -> 'storage', ${sql.json(storageConfig)}::jsonb),
        true
      ),
      updated_at = now()
    from target
    where orgs.id = target.id
    returning orgs.id, orgs.byo_config -> 'storage' as storage, target.had_storage
  `) as unknown as readonly TenantStorageNamespaceRow[];
  const record = mapTenantStorageNamespaceRow(rows[0]);

  if (rows[0]?.had_storage === false) {
    await sql`
      insert into tenant_config_audit (
        org_id,
        key,
        old_value,
        new_value,
        changed_by,
        reason
      )
      values (
        ${orgId},
        'byo_config.storage',
        null,
        ${sql.json(storageConfig)},
        null,
        'tenant-provisioning:default-object-store-prefix'
      )
      on conflict do nothing
    `;
  }

  return record;
}

function mapTenantStorageNamespaceRow(
  row: TenantStorageNamespaceRow | undefined,
): TenantStorageNamespaceRecord {
  if (row === undefined) {
    throw new Error("tenant object-store prefix query returned no rows");
  }
  return {
    orgId: row.id,
    storage: row.storage,
  };
}
