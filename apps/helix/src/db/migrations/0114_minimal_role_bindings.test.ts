import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_SCOPES } from "../../platform/permissions/scope-catalog.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 1 });

describe("0114 minimal role bindings migration", () => {
  it("uses catalog-backed permissions, composite principals, and structural scopes", async () => {
    const migration = await readFile(
      new URL("./0114_minimal_role_bindings.sql", import.meta.url),
      "utf8",
    );
    const delegatedMigration = await readFile(
      new URL("./0116_delegated_administration.sql", import.meta.url),
      "utf8",
    );
    const mergeMigration = await readFile(
      new URL("./0178_merge_permission_catalog.sql", import.meta.url),
      "utf8",
    );
    for (const permission of ALL_SCOPES) {
      expect(`${migration}\n${delegatedMigration}\n${mergeMigration}`).toContain(
        `('${permission}',`,
      );
    }
    expect(migration).toContain("references organization_memberships(org_id, id)");
    expect(migration).toContain("references actors(org_id, id)");
    expect(migration).toContain("references admin_org_units(org_id, id)");
    expect(migration).toContain("references admin_groups(org_id, id)");
    expect(migration).toContain("helix_actor_role_bindings");
  });
});

describe.skipIf(sql === null)("0114 live two-tenant role enforcement", () => {
  const database = sql as postgres.Sql;
  const orgA = "9a2a5ed5-0000-4000-8000-000000000001";
  const orgB = "9a2a5ed5-0000-4000-8000-000000000002";
  const actorA = "9a2a5ed5-0000-4000-8000-000000000011";
  const actorB = "9a2a5ed5-0000-4000-8000-000000000012";
  const serviceA = "9a2a5ed5-0000-4000-8000-000000000013";
  const roleAllow = "9a2a5ed5-0000-4000-8000-000000000041";
  const roleDeny = "9a2a5ed5-0000-4000-8000-000000000042";
  const roleB = "9a2a5ed5-0000-4000-8000-000000000043";
  const unitA = "9a2a5ed5-0000-4000-8000-000000000051";
  const groupA = "9a2a5ed5-0000-4000-8000-000000000061";

  beforeAll(async () => {
    await database`
      insert into orgs (id, slug, display_name, status, tier, region)
      values
        (${orgA}, 'iam09-a', 'IAM 09 A', 'active', 'business', 'test'),
        (${orgB}, 'iam09-b', 'IAM 09 B', 'active', 'business', 'test')
      on conflict (id) do nothing
    `;
    await database`
      insert into actors (id, org_id, type, display_name)
      values
        (${actorA}, ${orgA}, 'user', 'IAM 09 A'),
        (${actorB}, ${orgB}, 'user', 'IAM 09 B'),
        (${serviceA}, ${orgA}, 'service_account', 'IAM 09 Service')
      on conflict (id) do nothing
    `;
    await database`
      insert into admin_org_units (id, org_id, name, path, created_by)
      values (${unitA}, ${orgA}, 'IAM 09 Unit', 'IAM 09 Unit', ${actorA})
      on conflict (id) do nothing
    `;
    await database`
      insert into admin_groups (id, org_id, name, org_unit_id, created_by)
      values (${groupA}, ${orgA}, 'IAM 09 Group', ${unitA}, ${actorA})
      on conflict (id) do nothing
    `;
    await database`
      insert into iam_roles (id, org_id, role_key, display_name, kind)
      values
        (${roleAllow}, ${orgA}, 'iam09_allow', 'IAM 09 allow', 'custom'),
        (${roleDeny}, ${orgA}, 'iam09_deny', 'IAM 09 deny', 'custom'),
        (${roleB}, ${orgB}, 'iam09_other', 'IAM 09 other', 'custom')
      on conflict (id) do nothing
    `;
    await database`
      insert into iam_role_permissions (org_id, role_id, permission, effect)
      values
        (${orgA}, ${roleAllow}, 'admin.audit', 'allow'),
        (${orgA}, ${roleAllow}, 'admin.users', 'allow'),
        (${orgA}, ${roleDeny}, 'admin.users', 'deny'),
        (${orgB}, ${roleB}, 'admin.audit', 'allow')
      on conflict do nothing
    `;
    await database`
      insert into iam_role_bindings (
        org_id, role_id, principal_type, membership_id, scope_type
      ) values
        (${orgA}, ${roleAllow}, 'membership',
          (select id from organization_memberships where actor_id = ${actorA}), 'org'),
        (${orgA}, ${roleDeny}, 'membership',
          (select id from organization_memberships where actor_id = ${actorA}), 'org')
    `;
    await database`
      insert into iam_role_bindings (
        org_id, role_id, principal_type, service_account_actor_id,
        scope_type, resource_type, resource_id
      ) values (
        ${orgA}, ${roleAllow}, 'service_account', ${serviceA},
        'resource', 'mailbox', 'mailbox-1'
      )
    `;
  });

  afterAll(async () => {
    await database`delete from orgs where id in (${orgA}, ${orgB})`;
    await database`delete from identity_subjects where id in (${actorA}, ${actorB})`;
    await database.end();
  });

  it("seeds a built-in role and returns only the actor's same-tenant bindings", async () => {
    const builtIns = await database<{ role_key: string }[]>`
      select role_key from iam_roles where org_id = ${orgA} and kind = 'built_in' and role_key = 'workspace_viewer'
    `;
    expect(builtIns).toEqual([{ role_key: "workspace_viewer" }]);

    const rows = await database<{ grants: unknown }[]>`
      select helix_actor_role_bindings(${orgA}, ${actorA}) as grants
    `;
    expect(rows[0]?.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleId: roleAllow, allow: ["admin.audit", "admin.users"] }),
        expect.objectContaining({ roleId: roleDeny, deny: ["admin.users"] }),
      ]),
    );
    const crossTenant = await database<{ grants: unknown }[]>`
      select helix_actor_role_bindings(${orgB}, ${actorA}) as grants
    `;
    expect(crossTenant[0]?.grants).toEqual([]);
  });

  it("returns exact resource grants for an active service account", async () => {
    const rows = await database<{ grants: unknown }[]>`
      select helix_actor_role_bindings(${orgA}, ${serviceA}) as grants
    `;
    expect(rows[0]?.grants).toEqual([
      expect.objectContaining({
        roleId: roleAllow,
        scopeType: "resource",
        scopeId: "mailbox-1",
        resourceType: "mailbox",
      }),
    ]);

    await database`update actors set disabled_at = now() where id = ${serviceA}`;
    const disabled = await database<{ grants: unknown }[]>`
      select helix_actor_role_bindings(${orgA}, ${serviceA}) as grants
    `;
    expect(disabled[0]?.grants).toEqual([]);
    await database`update actors set disabled_at = null where id = ${serviceA}`;
  });

  it("keeps role rows tenant-isolated for the restricted runtime role", async () => {
    const rows = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgA}, true)`;
      return tx<{ org_id: string }[]>`select distinct org_id from iam_roles`;
    });
    expect(rows).toEqual([{ org_id: orgA }]);

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`
          insert into iam_roles (org_id, role_key, display_name, kind)
          values (${orgB}, 'cross_tenant', 'Cross tenant', 'custom')
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects unknown permissions and cross-tenant principals, roles, and scopes", async () => {
    await expect(database`
      insert into iam_role_permissions (org_id, role_id, permission, effect)
      values (${orgA}, ${roleAllow}, 'admin.imaginary', 'allow')
    `).rejects.toMatchObject({ code: "23503" });
    await expect(database`
      insert into iam_role_bindings (org_id, role_id, principal_type, membership_id, scope_type)
      values (${orgA}, ${roleAllow}, 'membership',
        (select id from organization_memberships where actor_id = ${actorB}), 'org')
    `).rejects.toMatchObject({ code: "23503" });
    await expect(database`
      insert into iam_role_bindings (org_id, role_id, principal_type, membership_id, scope_type)
      values (${orgA}, ${roleB}, 'membership',
        (select id from organization_memberships where actor_id = ${actorA}), 'org')
    `).rejects.toMatchObject({ code: "23503" });
    await expect(database`
      insert into iam_role_bindings (
        org_id, role_id, principal_type, membership_id, scope_type, org_unit_id
      ) values (${orgB}, ${roleB}, 'membership',
        (select id from organization_memberships where actor_id = ${actorB}),
        'org_unit', ${unitA})
    `).rejects.toMatchObject({ code: "23503" });
    await expect(database`
      insert into iam_role_bindings (
        org_id, role_id, principal_type, service_account_actor_id, scope_type
      ) values (${orgA}, ${roleAllow}, 'service_account', ${actorA}, 'org')
    `).rejects.toMatchObject({ code: "23514" });
  });
});
