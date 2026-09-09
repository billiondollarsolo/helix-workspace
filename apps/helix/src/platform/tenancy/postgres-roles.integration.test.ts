import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { assertTenantSafeDatabaseRole } from "../../db/client.js";
import { withTenantPostgresContext } from "./postgres-roles.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const appRole = "helix_iam05_integration_app";
const ownerRole = "helix_iam05_integration_owner";
const appPassword = "helix_iam05_integration_password";
const orgA = "a5000000-0000-4000-8000-000000000001";
const orgB = "a5000000-0000-4000-8000-000000000002";

describe("restricted PostgreSQL tenant context", { skip: databaseUrl === undefined }, () => {
  it("enters transaction-local RLS context without an owner-role escape", async () => {
    if (databaseUrl === undefined) throw new Error("Database URL is required.");
    const adminSql = postgres(databaseUrl, { max: 1, prepare: false });
    let appSql: postgres.Sql | undefined;

    try {
      await adminSql.unsafe("drop table if exists helix_iam05_tenant_rows");
      await adminSql.unsafe(`drop role if exists ${appRole}`);
      await adminSql.unsafe(`drop role if exists ${ownerRole}`);
      await adminSql.unsafe(`create role ${ownerRole} nologin nosuperuser nobypassrls`);
      await adminSql.unsafe(`
        create role ${appRole}
        login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
        password '${appPassword}'
      `);
      await adminSql.unsafe(`
        create table helix_iam05_tenant_rows (org_id uuid not null, value text not null);
        alter table helix_iam05_tenant_rows owner to ${ownerRole};
        alter table helix_iam05_tenant_rows enable row level security;
        alter table helix_iam05_tenant_rows force row level security;
        create policy helix_iam05_tenant_isolation on helix_iam05_tenant_rows
          using (org_id = nullif(current_setting('helix.org_id', true), '')::uuid)
          with check (org_id = nullif(current_setting('helix.org_id', true), '')::uuid);
        grant select, insert on helix_iam05_tenant_rows to ${appRole};
        insert into helix_iam05_tenant_rows (org_id, value)
        values ('${orgA}', 'tenant-a'), ('${orgB}', 'tenant-b');
      `);

      const appUrl = new URL(databaseUrl);
      appUrl.username = appRole;
      appUrl.password = appPassword;
      appSql = postgres(appUrl.toString(), { max: 1, prepare: false });

      await adminSql`set role ${adminSql(appRole)}`;
      try {
        await expect(assertTenantSafeDatabaseRole(adminSql)).rejects.toThrow(
          "Unsafe runtime database role",
        );
      } finally {
        await adminSql`reset role`;
      }

      await adminSql.unsafe(`grant ${ownerRole} to ${appRole}`);
      await expect(assertTenantSafeDatabaseRole(appSql)).rejects.toThrow(
        "Unsafe runtime database role",
      );
      await adminSql.unsafe(`revoke ${ownerRole} from ${appRole}`);
      await expect(assertTenantSafeDatabaseRole(appSql)).resolves.toBeUndefined();
      const rows = await withTenantPostgresContext(
        appSql,
        { orgId: orgA },
        (tx) => tx<{ value: string }[]>`select value from helix_iam05_tenant_rows order by value`,
      );
      expect(rows.map((row) => row.value)).toEqual(["tenant-a"]);
      await expect(
        withTenantPostgresContext(appSql, { orgId: orgA }, async (tx) => {
          await tx`
            insert into helix_iam05_tenant_rows (org_id, value) values (${orgB}, 'forged')
          `;
        }),
      ).rejects.toMatchObject({ code: "42501" });

      const contextAfterCommit = await appSql<{ org_id: string | null }[]>`
        select current_setting('helix.org_id', true) as org_id
      `;
      expect([null, ""]).toContain(contextAfterCommit[0]?.org_id ?? null);

      await expect(appSql`set role ${appSql(ownerRole)}`).rejects.toMatchObject({ code: "42501" });
      await appSql`reset role`;
      await expect(appSql<{ current_user: string }[]>`select current_user`).resolves.toMatchObject([
        { current_user: appRole },
      ]);
    } finally {
      await appSql?.end();
      await adminSql.unsafe("drop table if exists helix_iam05_tenant_rows");
      await adminSql.unsafe(`drop role if exists ${appRole}`);
      await adminSql.unsafe(`drop role if exists ${ownerRole}`);
      await adminSql.end();
    }
  });
});
