import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantPostgresContext } from "../../platform/tenancy/postgres-roles.js";

const ORG_A = "f1000000-0000-4000-8000-000000000001";
const ORG_B = "f1000000-0000-4000-8000-000000000002";
const ACTOR_A = "f1000000-0000-4000-8000-000000000011";
const ACTOR_B = "f1000000-0000-4000-8000-000000000012";
const DISABLED_ACTOR_A = "f1000000-0000-4000-8000-000000000013";
const DELETED_ACTOR_A = "f1000000-0000-4000-8000-000000000014";
const GROUP_A = "f1000000-0000-4000-8000-000000000021";
const GROUP_B = "f1000000-0000-4000-8000-000000000022";
const UNIT_A = "f1000000-0000-4000-8000-000000000031";
const UNIT_B = "f1000000-0000-4000-8000-000000000032";
const CHILD_A = "f1000000-0000-4000-8000-000000000033";

describe("group membership tenant integrity", { skip: !process.env.DATABASE_URL }, () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) {
      throw new Error("DATABASE_URL is required for the live tenant-integrity test.");
    }
    sql = postgres(databaseUrl, { max: 2, prepare: false });
    await sql.unsafe(
      await readFile(
        new URL("./0075_group_membership_tenant_integrity.sql", import.meta.url),
        "utf8",
      ),
    );
    await withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
      await tx`
          insert into actors (id, org_id, type, display_name, disabled_at)
          values
            (${ACTOR_A}, ${ORG_A}, 'user', 'Tenant A actor', null),
            (${DISABLED_ACTOR_A}, ${ORG_A}, 'user', 'Disabled tenant A actor', now()),
            (${DELETED_ACTOR_A}, ${ORG_A}, 'user', 'Deleted tenant A actor', null)
          on conflict (id) do nothing
        `;
      await tx`
          insert into admin_org_units (id, org_id, name, path)
          values (${UNIT_A}, ${ORG_A}, 'Tenant A unit', 'Tenant A unit')
          on conflict (id) do nothing
        `;
      await tx`
          insert into admin_groups (id, org_id, name, org_unit_id)
          values (${GROUP_A}, ${ORG_A}, 'Tenant A group', ${UNIT_A})
          on conflict (id) do nothing
        `;
      await tx`delete from actors where id = ${DELETED_ACTOR_A}`;
    });
    await withTenantPostgresContext(sql, { orgId: ORG_B }, async (tx) => {
      await tx`
          insert into actors (id, org_id, type, display_name)
          values (${ACTOR_B}, ${ORG_B}, 'user', 'Tenant B actor')
          on conflict (id) do nothing
        `;
      await tx`
          insert into admin_org_units (id, org_id, name, path)
          values (${UNIT_B}, ${ORG_B}, 'Tenant B unit', 'Tenant B unit')
          on conflict (id) do nothing
        `;
      await tx`
          insert into admin_groups (id, org_id, name, org_unit_id)
          values (${GROUP_B}, ${ORG_B}, 'Tenant B group', ${UNIT_B})
          on conflict (id) do nothing
        `;
    });
  });

  afterAll(async () => {
    await withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
      await tx`delete from admin_groups where id = ${GROUP_A}`;
      await tx`delete from admin_org_units where id = ${CHILD_A}`;
      await tx`delete from admin_org_units where id = ${UNIT_A}`;
      await tx`delete from actors where id in (${ACTOR_A}, ${DISABLED_ACTOR_A})`;
    });
    await withTenantPostgresContext(sql, { orgId: ORG_B }, async (tx) => {
      await tx`delete from admin_groups where id = ${GROUP_B}`;
      await tx`delete from admin_org_units where id = ${UNIT_B}`;
      await tx`delete from actors where id = ${ACTOR_B}`;
    });
    await sql.end();
  });

  it("rejects a direct SQL membership referencing another tenant's actor", async () => {
    await expect(
      withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
        await tx`
            insert into admin_group_members (org_id, group_id, actor_id)
            values (${ORG_A}, ${GROUP_A}, ${ACTOR_B})
          `;
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects direct SQL membership for disabled and deleted actors", async () => {
    for (const actorId of [DISABLED_ACTOR_A, DELETED_ACTOR_A]) {
      await expect(
        withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
          await tx`
              insert into admin_group_members (org_id, group_id, actor_id)
              values (${ORG_A}, ${GROUP_A}, ${actorId})
            `;
        }),
      ).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("rejects a direct SQL membership referencing another tenant's group", async () => {
    await expect(
      withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
        await tx`
            insert into admin_group_members (org_id, group_id, actor_id)
            values (${ORG_A}, ${GROUP_B}, ${ACTOR_A})
          `;
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects cross-tenant org-unit parenting and group assignment", async () => {
    await expect(
      withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
        await tx`
            insert into admin_org_units (id, org_id, parent_id, name, path)
            values (${CHILD_A}, ${ORG_A}, ${UNIT_B}, 'Injected child', 'Injected child')
          `;
      }),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
        await tx`
            update admin_groups set org_unit_id = ${UNIT_B}
            where org_id = ${ORG_A} and id = ${GROUP_A}
          `;
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("allows a direct SQL membership when actor and group share the tenant", async () => {
    await expect(
      withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
        await tx`
            insert into admin_group_members (org_id, group_id, actor_id)
            values (${ORG_A}, ${GROUP_A}, ${ACTOR_A})
            on conflict (group_id, actor_id) do nothing
          `;
      }),
    ).resolves.toBeUndefined();
  });

  it("allows same-tenant org-unit parenting and group assignment", async () => {
    await expect(
      withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
        await tx`
            insert into admin_org_units (id, org_id, parent_id, name, path)
            values (${CHILD_A}, ${ORG_A}, ${UNIT_A}, 'Tenant A child', 'Tenant A unit > child')
            on conflict (id) do nothing
          `;
        await tx`
            update admin_groups set org_unit_id = ${CHILD_A}
            where org_id = ${ORG_A} and id = ${GROUP_A}
          `;
      }),
    ).resolves.toBeUndefined();
  });
});
