import type postgres from "postgres";
import type { TenantStorageMigrationObject } from "./migration.js";

interface TenantStorageMigrationObjectRow {
  readonly storage_key: string | null;
  readonly byte_size: number | null;
  readonly sha256: string | null;
}

export async function listTenantStorageMigrationObjects(
  sql: postgres.Sql,
  orgId: string,
): Promise<readonly TenantStorageMigrationObject[]> {
  const rows = await sql<TenantStorageMigrationObjectRow[]>`
    select distinct on (stored.storage_key)
      stored.storage_key, stored.byte_size, stored.sha256
    from (
      select storage_key, byte_size, sha256, 0 as source_rank
      from objects
      where org_id = ${orgId}
        and storage_key <> ''

      union all

      select storage_key, byte_size, sha256, 0 as source_rank
      from mail_message_bodies where org_id = ${orgId}

      union all

      select v.storage_key, v.byte_size, v.sha256, 1 as source_rank
      from drive_versions v
      join objects o on o.id = v.object_id and o.org_id = v.org_id
      where v.org_id = ${orgId}
        and v.storage_key <> ''

      union all

      select
        metadata->'preview'->>'storageKey' as storage_key,
        null::integer as byte_size,
        null::text as sha256,
        2 as source_rank
      from objects
      where org_id = ${orgId}
        and metadata->'preview'->>'storageKey' is not null
        and metadata->'preview'->>'storageKey' <> ''
    ) stored
    where stored.storage_key is not null
    order by stored.storage_key, stored.source_rank
  `;

  return rows.flatMap((row) => {
    const storageKey = row.storage_key?.trim();
    if (storageKey === undefined || storageKey.length === 0) {
      return [];
    }
    return [
      {
        storageKey,
        ...(row.byte_size === null ? {} : { byteSize: row.byte_size }),
        ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
      },
    ];
  });
}
