import type postgres from "postgres";

/** Remove only fixture tenants, including immutable evidence and generated rows. */
export async function cleanupTestTenants(
  sql: postgres.Sql,
  orgIds: readonly string[],
): Promise<void> {
  if (orgIds.length === 0) throw new Error("Fixture tenant IDs are required");
  await sql.begin(async (tx) => {
    // Only cleanup bypasses retention/triggers; the assertions use real policy.
    await tx.unsafe("set local session_replication_role = replica");
    const tables = await tx<{ tablename: string }[]>`
      select table_name as tablename from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id'
    `;
    for (const { tablename } of tables) {
      await tx`delete from public.${tx(tablename)} where org_id in ${tx([...orgIds])}`;
    }
    await tx`delete from orgs where id in ${tx([...orgIds])}`;
  });
}
