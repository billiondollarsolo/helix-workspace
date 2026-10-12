import type postgres from "postgres";
import { purgeTenantSearch } from "../../platform/tenancy/tenant-deletion.js";
import { PostgresSearchDurabilityStore } from "../../platform/search/durable.js";
import type { MeilisearchSearchEngine } from "../../platform/search/meilisearch.js";
import type { TenantStorageResolver } from "../../platform/storage/index.js";

/**
 * Drops the demo tenant completely so it can be seeded from scratch.
 *
 * Production tenant deletion (`TenantDeletionWorkflow`) keeps a tombstone, the
 * audit chain and a signed proof, so a deleted org id can never be reused. A
 * local demo reset must reuse the configured default org id, so this removes
 * everything for the org: its object namespace, its search documents and every
 * row, including the audit chain. It needs the privileged migration role and
 * refuses to run against non-loopback databases (see `assertLocalSeedTarget`).
 */
export async function resetDemoTenant(input: {
  readonly privilegedSql: postgres.Sql;
  readonly orgId: string;
  readonly storageResolver: TenantStorageResolver;
  readonly search: MeilisearchSearchEngine | undefined;
  readonly log: (message: string) => void;
}): Promise<void> {
  const org = await input.privilegedSql<{ readonly id: string }[]>`
    select id from orgs where id = ${input.orgId}
  `;
  if (org.length === 0) {
    input.log("no existing demo tenant to reset");
    return;
  }
  const storage = await input.storageResolver({ orgId: input.orgId, refresh: true });
  let deletedObjects = 0;
  if (storage?.client.listKeys !== undefined) {
    const keys: string[] = [];
    for await (const key of storage.client.listKeys("")) keys.push(key);
    for (let start = 0; start < keys.length; start += 32) {
      await Promise.all(keys.slice(start, start + 32).map((key) => storage.client.delete(key)));
    }
    deletedObjects = keys.length;
  }
  const deletedDocuments =
    input.search === undefined ? 0 : await purgeTenantSearch(input.search, input.orgId);
  const rows = await input.privilegedSql.begin(async (tx) => {
    // Bypass product triggers (audit immutability, projections) for a whole-tenant drop.
    await tx`set local session_replication_role = replica`;
    const subjects = await tx<{ readonly subject_id: string; readonly user_id: string | null }[]>`
      select membership.subject_id, provider.provider_subject as user_id
      from organization_memberships membership
      left join identity_provider_subjects provider
        on provider.subject_id = membership.subject_id and provider.provider = 'better-auth'
      where membership.org_id = ${input.orgId}
    `;
    const tables = await tx<{ readonly table_name: string }[]>`
      select distinct table_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id' and table_name <> 'orgs'
        and table_name in (
          select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
        )
    `;
    let deleted = 0;
    for (const { table_name: table } of tables) {
      const result = await tx.unsafe(`delete from public."${table}" where org_id = $1`, [
        input.orgId,
      ]);
      deleted += result.count;
    }
    const userIds = subjects.flatMap((subject) =>
      subject.user_id === null ? [] : [subject.user_id],
    );
    const subjectIds = subjects.map((subject) => subject.subject_id);
    if (userIds.length > 0) {
      await tx`delete from session where "userId" in ${tx(userIds)}`;
      await tx`delete from account where "userId" in ${tx(userIds)}`;
      await tx`delete from "user" where id in ${tx(userIds)}`;
    }
    if (subjectIds.length > 0) {
      await tx`delete from identity_provider_subjects where subject_id in ${tx(subjectIds)}`;
      await tx`
        delete from identity_subjects subject
        where subject.id in ${tx(subjectIds)}
          and not exists (
            select 1 from organization_memberships membership where membership.subject_id = subject.id
          )
      `;
    }
    // Undelivered events of the dropped tenant would otherwise replay into the new one.
    await tx`delete from outbox where payload->>'orgId' = ${input.orgId}`;
    await tx`delete from orgs where id = ${input.orgId}`;
    return deleted;
  });
  // The reset removed the tenant's reindex jobs; their shadow indexes would otherwise stay.
  const deletedShadowIndexes =
    input.search === undefined
      ? 0
      : await new PostgresSearchDurabilityStore(input.privilegedSql).deleteOrphanedShadowIndexes(
          input.search,
        );
  input.log(
    `reset removed ${String(rows)} rows, ${String(deletedObjects)} stored objects, ${String(deletedDocuments)} search documents and ${String(deletedShadowIndexes)} orphaned shadow indexes`,
  );
}
