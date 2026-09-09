import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTenantRlsCoverage, assertTenantSafeDatabaseRole } from "../../db/client.js";
import { withTenantPostgresContext } from "./postgres-roles.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const workerUrl = process.env.HELIX_RLS_WORKER_DATABASE_URL;
const readonlyUrl = process.env.HELIX_RLS_READONLY_DATABASE_URL;
const enabled =
  adminUrl !== undefined &&
  appUrl !== undefined &&
  workerUrl !== undefined &&
  readonlyUrl !== undefined;
const orgA = "a1030000-0000-4000-8000-000000000001";
const orgB = "a1030000-0000-4000-8000-000000000002";
const provisionedOrg = "a1030000-0000-4000-8000-000000000003";
const actorA = "a1030000-0000-4000-8000-000000000011";
const actorB = "a1030000-0000-4000-8000-000000000012";

describe("forced tenant RLS roles and schema gate", { skip: !enabled }, () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;
  let worker: postgres.Sql;
  let readonly: postgres.Sql;

  beforeAll(async () => {
    if (!enabled) throw new Error("Dedicated tenant-RLS database URLs are required.");
    admin = postgres(adminUrl, { max: 1, prepare: false });
    app = postgres(appUrl, { max: 1, prepare: false });
    worker = postgres(workerUrl, { max: 1, prepare: false });
    readonly = postgres(readonlyUrl, { max: 1, prepare: false });
    await cleanup();
    await admin`
      insert into orgs (id, slug, display_name, status)
      values
        (${orgA}, 'iam-03-a', 'IAM 03 A', 'active'),
        (${orgB}, 'iam-03-b', 'IAM 03 B', 'active')
    `;
    await admin`
      insert into actors (id, org_id, type, display_name)
      values
        (${actorA}, ${orgA}, 'user', 'Tenant A actor'),
        (${actorB}, ${orgB}, 'user', 'Tenant B actor')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([admin.end(), app.end(), worker.end(), readonly.end()]);
  });

  it("uses separate constrained identities owned only by the migration role", async () => {
    const roles = await admin<
      {
        readonly rolname: string;
        readonly rolcanlogin: boolean;
        readonly rolsuper: boolean;
        readonly rolbypassrls: boolean;
        readonly owns_tenant_table: boolean;
        readonly can_assume_owner: boolean;
      }[]
    >`
      select
        role.rolname,
        role.rolcanlogin,
        role.rolsuper,
        role.rolbypassrls,
        exists (
          select 1 from pg_class table_class
          join pg_attribute column_def on column_def.attrelid = table_class.oid
          where table_class.relkind = 'r'
            and column_def.attname = 'org_id'
            and not column_def.attisdropped
            and table_class.relowner = role.oid
        ) as owns_tenant_table,
        pg_has_role(role.rolname, 'helix_migration_owner', 'MEMBER') as can_assume_owner
      from pg_roles role
      where role.rolname in ('helix_app', 'helix_worker', 'helix_readonly')
      order by role.rolname
    `;
    expect(roles).toHaveLength(3);
    expect(roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rolname: "helix_app", rolcanlogin: true }),
        expect.objectContaining({ rolname: "helix_worker", rolcanlogin: true }),
        expect.objectContaining({ rolname: "helix_readonly", rolcanlogin: true }),
      ]),
    );
    for (const role of roles) {
      expect(role).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        owns_tenant_table: false,
        can_assume_owner: false,
      });
    }
    const tableOwners = await admin<{ readonly owner: string }[]>`
      select distinct pg_get_userbyid(table_class.relowner) as owner
      from pg_class table_class
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relkind in ('r', 'p')
    `;
    expect(tableOwners).toEqual([{ owner: "helix_migration_owner" }]);
    await expect(assertTenantSafeDatabaseRole(app)).resolves.toBeUndefined();
    await expect(assertTenantSafeDatabaseRole(worker)).resolves.toBeUndefined();
    await expect(app`set role helix_migration_owner`).rejects.toMatchObject({ code: "42501" });
    await expect(worker`set role helix_migration_owner`).rejects.toMatchObject({ code: "42501" });
  });

  it("isolates unfiltered request and job queries with transaction-local org and actor context", async () => {
    const requestRows = await withTenantPostgresContext(
      app,
      { orgId: orgA, actorId: actorA },
      async (tx) => {
        const context = await tx<{ readonly org_id: string; readonly actor_id: string }[]>`
          select helix_current_org_id() as org_id, helix_current_actor_id() as actor_id
        `;
        expect(context).toEqual([{ org_id: orgA, actor_id: actorA }]);
        return tx<{ readonly id: string }[]>`select id from actors order by id`;
      },
    );
    expect(requestRows.map((row) => row.id)).toEqual([actorA]);

    const jobRows = await withTenantPostgresContext(
      worker,
      { orgId: orgB },
      (tx) => tx<{ readonly id: string }[]>`select id from actors order by id`,
    );
    expect(jobRows.map((row) => row.id)).toEqual([actorB]);
    await expect(app<{ readonly id: string }[]>`select id from actors`).resolves.toEqual([]);
    await expect(worker<{ readonly id: string }[]>`select id from actors`).resolves.toEqual([]);

    await expect(
      withTenantPostgresContext(
        app,
        { orgId: orgA },
        (tx) =>
          tx`insert into actors (org_id, type, display_name) values (${orgB}, 'user', 'forged')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("lets the constrained app role create an org while its derived audit rows stay tenant-bound", async () => {
    await app`
      insert into orgs (id, slug, display_name, status)
      values (${provisionedOrg}, 'iam-03-provisioned', 'IAM 03 provisioned', 'provisioning')
    `;
    const auditRows = await withTenantPostgresContext(
      app,
      { orgId: provisionedOrg },
      (tx) =>
        tx<{ readonly count: number }[]>`
        select count(*)::integer as count
        from tenant_config_audit
      `,
    );
    expect(auditRows).toEqual([{ count: 4 }]);
  });

  it("cannot disable forced RLS and keeps the read-only role read-only", async () => {
    await expect(app`alter table actors disable row level security`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(worker`alter table actors disable row level security`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      app.begin(async (tx) => {
        await tx`set local row_security = off`;
        await tx`select id from actors`;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    const rows = await withTenantPostgresContext(
      readonly,
      { orgId: orgB },
      (tx) => tx<{ readonly id: string }[]>`select id from actors`,
    );
    expect(rows.map((row) => row.id)).toEqual([actorB]);
    await expect(
      withTenantPostgresContext(
        readonly,
        { orgId: orgB },
        (tx) => tx`update actors set display_name = 'changed' where id = ${actorB}`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      readonly`select helix_complete_meet_recording_upload(${actorB}::uuid)`,
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("discovers every protected org_id table and rejects a newly uncovered table", async () => {
    await expect(assertTenantRlsCoverage(app)).resolves.toBeUndefined();
    await admin`create table helix_uncovered_tenant_test (org_id uuid not null)`;
    try {
      await expect(assertTenantRlsCoverage(admin)).rejects.toThrow("helix_uncovered_tenant_test");
    } finally {
      await admin`drop table helix_uncovered_tenant_test`;
    }
  });

  async function cleanup(): Promise<void> {
    await admin`delete from actors where id in (${actorA}, ${actorB})`;
    await admin`delete from orgs where id in (${orgA}, ${orgB}, ${provisionedOrg})`;
  }
});
