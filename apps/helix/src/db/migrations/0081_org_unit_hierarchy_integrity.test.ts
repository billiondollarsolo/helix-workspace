import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const orgA = "81000000-0000-4000-8000-000000000001";
const orgB = "81000000-0000-4000-8000-000000000002";
const root = "81000000-0000-4000-8000-000000000011";
const child = "81000000-0000-4000-8000-000000000012";
const grandchild = "81000000-0000-4000-8000-000000000013";
const destination = "81000000-0000-4000-8000-000000000014";
const foreignRoot = "81000000-0000-4000-8000-000000000021";
const unitIds = [grandchild, child, root, destination, foreignRoot] as const;

describe("org-unit hierarchy migration", () => {
  it("owns cycle rejection and recursive path maintenance in PostgreSQL", async () => {
    const migration = await readFile(
      new URL("./0081_org_unit_hierarchy_integrity.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("admin_org_units_no_self_parent");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("with recursive ancestors");
    expect(migration).toContain("with recursive descendants");
    expect(migration).toContain("admin_org_units_acyclic");
  });
});

describe("live org-unit hierarchy integrity", { skip: databaseUrl === undefined }, () => {
  let sql: postgres.Sql;
  let observer: postgres.Sql;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("Database URL is required.");
    sql = postgres(databaseUrl, { max: 1, prepare: false });
    observer = postgres(databaseUrl, { max: 1, prepare: false });
    const migrationReady = await sql<{ readonly ready: boolean }[]>`
      select to_regprocedure('admin_org_units_prepare_write()') is not null as ready
    `;
    if (migrationReady[0]?.ready !== true) {
      throw new Error("Run database migrations before the live org-unit hierarchy test.");
    }
    await clearFixtures(sql);
    await sql`
      insert into admin_org_units (id, org_id, name, path)
      values (${root}, ${orgA}, 'Engineering', 'forged')
    `;
    await sql`
      insert into admin_org_units (id, org_id, parent_id, name, path)
      values (${child}, ${orgA}, ${root}, 'Platform', 'forged')
    `;
    await sql`
      insert into admin_org_units (id, org_id, parent_id, name, path)
      values (${grandchild}, ${orgA}, ${child}, 'Runtime', 'forged')
    `;
    await sql`
      insert into admin_org_units (id, org_id, name, path)
      values (${destination}, ${orgA}, 'Product', 'forged')
    `;
    await sql`
      insert into admin_org_units (id, org_id, name, path)
      values (${foreignRoot}, ${orgB}, 'Foreign', 'forged')
    `;
  });

  afterAll(async () => {
    await clearFixtures(sql);
    await Promise.all([sql.end(), observer.end()]);
  });

  it("rejects cyclic/cross-tenant moves and publishes a whole subtree atomically", async () => {
    expect(await paths(sql)).toMatchObject({
      [root]: "Engineering",
      [child]: "Engineering > Platform",
      [grandchild]: "Engineering > Platform > Runtime",
    });

    await expect(
      sql`update admin_org_units set parent_id = ${grandchild} where id = ${root}`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "admin_org_units_acyclic" });
    await expect(
      sql`update admin_org_units set parent_id = ${foreignRoot} where id = ${child}`,
    ).rejects.toMatchObject({ code: "23503", constraint_name: "admin_org_units_parent_org_fk" });
    await expect(sql`delete from admin_org_units where id = ${root}`).rejects.toMatchObject({
      code: "23503",
      constraint_name: "admin_org_units_parent_org_fk",
    });

    await sql.begin(async (tx) => {
      await tx`
        update admin_org_units
        set parent_id = ${destination}, name = 'Infrastructure'
        where id = ${child}
      `;
      expect(await paths(tx)).toMatchObject({
        [child]: "Product > Infrastructure",
        [grandchild]: "Product > Infrastructure > Runtime",
      });
      expect(await paths(observer)).toMatchObject({
        [child]: "Engineering > Platform",
        [grandchild]: "Engineering > Platform > Runtime",
      });
    });

    expect(await paths(observer)).toMatchObject({
      [root]: "Engineering",
      [child]: "Product > Infrastructure",
      [grandchild]: "Product > Infrastructure > Runtime",
    });
  });
});

async function paths(sql: postgres.Sql | postgres.TransactionSql): Promise<Record<string, string>> {
  const rows = await sql<{ readonly id: string; readonly path: string }[]>`
    select id, path from admin_org_units where id in ${sql(unitIds)}
  `;
  return Object.fromEntries(rows.map((row) => [row.id, row.path]));
}

async function clearFixtures(sql: postgres.Sql): Promise<void> {
  await sql`update admin_org_units set parent_id = null where id in ${sql(unitIds)}`;
  await sql`delete from admin_org_units where id in ${sql(unitIds)}`;
}
