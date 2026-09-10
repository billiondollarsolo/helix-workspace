import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELEGATED_ADMIN_ROLE_PERMISSIONS } from "../../platform/permissions/roles.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 1 });

describe("0116 delegated administration migration", () => {
  it("uses explicit ceilings, immutable state, checked functions, and WORM events", async () => {
    const migration = await readFile(
      new URL("./0116_delegated_administration.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("helix_iam_role_within_ceiling");
    expect(migration).toContain("helix_iam_scope_within_ceiling");
    expect(migration).toContain("helix_grant_delegated_iam_binding");
    expect(migration).toContain("helix_revoke_delegated_iam_binding");
    expect(migration).toContain("helix_current_actor_id() is distinct from input_grantor_actor_id");
    expect(migration).toContain("iam_delegation_events is append-only");
    expect(migration).toContain("revoke insert, update, delete on iam_roles");
  });
});

describe.skipIf(sql === null)("0116 live delegated administration boundaries", () => {
  const database = sql as postgres.Sql;
  const orgA = "a1100000-0000-4000-8000-000000000001";
  const orgB = "a1100000-0000-4000-8000-000000000002";
  const root = "a1100000-0000-4000-8000-000000000011";
  const delegate = "a1100000-0000-4000-8000-000000000012";
  const peer = "a1100000-0000-4000-8000-000000000013";
  const target = "a1100000-0000-4000-8000-000000000014";
  const outsider = "a1100000-0000-4000-8000-000000000015";
  const ouParent = "a1100000-0000-4000-8000-000000000021";
  const ouChild = "a1100000-0000-4000-8000-000000000022";
  const ouPeer = "a1100000-0000-4000-8000-000000000023";
  const groupA = "a1100000-0000-4000-8000-000000000031";
  const groupB = "a1100000-0000-4000-8000-000000000032";
  const rootDomainBinding = "a1100000-0000-4000-8000-000000000041";
  const rootOuBinding = "a1100000-0000-4000-8000-000000000042";
  const rootGroupBinding = "a1100000-0000-4000-8000-000000000043";
  const rootProductBinding = "a1100000-0000-4000-8000-000000000044";
  const domainA = "a1100000-0000-4000-8000-000000000051";
  const domainB = "a1100000-0000-4000-8000-000000000052";
  const denyRole = "a1100000-0000-4000-8000-000000000061";
  const denyBinding = "a1100000-0000-4000-8000-000000000062";
  let domainRole = "";
  let userRole = "";
  let groupRole = "";
  let mailRole = "";
  let delegateBinding = "";
  let peerBinding = "";
  let childBinding = "";

  beforeAll(async () => {
    await database`
      insert into orgs (id, slug, display_name, status, tier, region)
      values
        (${orgA}, 'iam10-a', 'IAM 10 A', 'active', 'business', 'test'),
        (${orgB}, 'iam10-b', 'IAM 10 B', 'active', 'business', 'test')
    `;
    await database`
      insert into actors (id, org_id, type, display_name)
      values
        (${root}, ${orgA}, 'user', 'Root'),
        (${delegate}, ${orgA}, 'user', 'Delegate'),
        (${peer}, ${orgA}, 'user', 'Peer'),
        (${target}, ${orgA}, 'user', 'Target'),
        (${outsider}, ${orgB}, 'user', 'Outsider')
    `;
    await database`
      insert into admin_org_units (id, org_id, parent_id, name, path, created_by)
      values
        (${ouParent}, ${orgA}, null, 'Parent', 'Parent', ${root}),
        (${ouChild}, ${orgA}, ${ouParent}, 'Child', 'Parent > Child', ${root}),
        (${ouPeer}, ${orgA}, ${ouParent}, 'Peer', 'Parent > Peer', ${root})
    `;
    await database`
      insert into admin_groups (id, org_id, name, org_unit_id, created_by)
      values
        (${groupA}, ${orgA}, 'Group A', ${ouChild}, ${root}),
        (${groupB}, ${orgA}, 'Group B', ${ouPeer}, ${root})
    `;
    const roles = await database<{ id: string; role_key: string }[]>`
      select id, role_key from iam_roles where org_id = ${orgA}
    `;
    domainRole = roles.find((role) => role.role_key === "domain_admin")?.id ?? "";
    userRole = roles.find((role) => role.role_key === "user_admin")?.id ?? "";
    groupRole = roles.find((role) => role.role_key === "group_admin")?.id ?? "";
    mailRole = roles.find((role) => role.role_key === "mail_admin")?.id ?? "";
    if ([domainRole, userRole, groupRole, mailRole].some((id) => id === "")) {
      throw new Error("Expected delegated built-in roles.");
    }

    await database`
      insert into iam_role_bindings (
        id, org_id, role_id, principal_type, membership_id, scope_type,
        org_unit_id, group_id, resource_type, resource_id, can_delegate
      ) values
        (${rootDomainBinding}, ${orgA}, ${domainRole}, 'membership',
          (select id from organization_memberships where actor_id = ${root}),
          'resource', null, null, 'domain', ${domainA}, true),
        (${rootOuBinding}, ${orgA}, ${groupRole}, 'membership',
          (select id from organization_memberships where actor_id = ${root}),
          'org_unit', ${ouChild}, null, null, null, true),
        (${rootGroupBinding}, ${orgA}, ${groupRole}, 'membership',
          (select id from organization_memberships where actor_id = ${root}),
          'group', null, ${groupA}, null, null, true),
        (${rootProductBinding}, ${orgA}, ${mailRole}, 'membership',
          (select id from organization_memberships where actor_id = ${root}),
          'resource', null, null, 'product', 'mail', true)
    `;
    const [rootGrants, peerGrants] = await database.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${orgA}, true)`;
      await tx`select set_config('helix.actor_id', ${root}, true)`;
      const rootGrant = await tx<{ id: string }[]>`
        select helix_grant_delegated_iam_binding(
          ${orgA}, ${root}, ${rootDomainBinding}, ${domainRole}, 'membership',
          (select id from organization_memberships where actor_id = ${delegate}),
          null, null, 'resource', null, null, 'domain', ${domainA}, true
        ) as id
      `;
      const peerGrant = await tx<{ id: string }[]>`
        select helix_grant_delegated_iam_binding(
          ${orgA}, ${root}, ${rootDomainBinding}, ${domainRole}, 'membership',
          (select id from organization_memberships where actor_id = ${peer}),
          null, null, 'resource', null, null, 'domain', ${domainA}, false
        ) as id
      `;
      return [rootGrant, peerGrant] as const;
    });
    delegateBinding = rootGrants[0]?.id ?? "";
    peerBinding = peerGrants[0]?.id ?? "";
  });

  afterAll(async () => {
    await database`delete from iam_role_bindings where org_id in (${orgA}, ${orgB})`;
    await database`delete from iam_roles where org_id in (${orgA}, ${orgB})`;
    await database`delete from admin_groups where org_id in (${orgA}, ${orgB})`;
    await database`delete from admin_org_units where org_id in (${orgA}, ${orgB})`;
    await database`delete from actors where id in (${root}, ${delegate}, ${peer}, ${target}, ${outsider})`;
    await database`delete from orgs where id in (${orgA}, ${orgB})`;
    await database`delete from identity_subjects where id in (${root}, ${delegate}, ${peer}, ${target}, ${outsider})`;
    await database.end();
  });

  it("seeds one exact built-in role for every documented delegate", async () => {
    const roles = await database<{ role_key: string; permission: string }[]>`
      select role.role_key, permission.permission
      from iam_roles role
      join iam_role_permissions permission
        on permission.org_id = role.org_id and permission.role_id = role.id
      where role.org_id = ${orgA}
        and role.role_key in ${database(Object.keys(DELEGATED_ADMIN_ROLE_PERMISSIONS))}
      order by role.role_key
    `;
    expect(Object.fromEntries(roles.map((role) => [role.role_key, role.permission]))).toEqual(
      DELEGATED_ADMIN_ROLE_PERMISSIONS,
    );
  });

  it("grants only the exact domain held by the delegate", async () => {
    const rows = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgA}, true)`;
      await tx`select set_config('helix.actor_id', ${delegate}, true)`;
      return tx<{ id: string }[]>`
        select helix_grant_delegated_iam_binding(
          ${orgA}, ${delegate}, ${delegateBinding}, ${domainRole}, 'membership',
          (select id from organization_memberships where actor_id = ${target}),
          null, null, 'resource', null, null, 'domain', ${domainA}, false
        ) as id
      `;
    });
    childBinding = rows[0]?.id ?? "";
    const grants = await database<{ grants: unknown }[]>`
      select helix_actor_role_bindings(${orgA}, ${target}) as grants
    `;
    expect(grants[0]?.grants).toEqual([
      expect.objectContaining({
        roleId: domainRole,
        resourceType: "domain",
        scopeId: domainA,
      }),
    ]);
  });

  it("rejects permission widening, parent/peer/domain/product escape, and cross-tenant targets", async () => {
    const attacks = [
      { role: userRole, scopeType: "resource", resourceType: "domain", resourceId: domainA },
      { role: domainRole, scopeType: "org", resourceType: null, resourceId: null },
      { role: domainRole, scopeType: "resource", resourceType: "domain", resourceId: domainB },
      { role: domainRole, scopeType: "resource", resourceType: "product", resourceId: "mail" },
    ] as const;
    for (const attack of attacks) {
      await expect(
        database.begin(async (tx) => {
          await tx.unsafe("set local role helix_app");
          await tx`select set_config('helix.org_id', ${orgA}, true)`;
          await tx`select set_config('helix.actor_id', ${delegate}, true)`;
          await tx`
          select helix_grant_delegated_iam_binding(
            ${orgA}, ${delegate}, ${delegateBinding}, ${attack.role}, 'membership',
            (select id from organization_memberships where actor_id = ${target}),
            null, null, ${attack.scopeType}, null, null, ${attack.resourceType},
            ${attack.resourceId}, false
          )
        `;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }

    await expect(
      database.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`select set_config('helix.actor_id', ${delegate}, true)`;
        await tx`
          select helix_grant_delegated_iam_binding(
            ${orgA}, ${delegate}, ${delegateBinding}, ${domainRole}, 'membership',
            (select id from organization_memberships where actor_id = ${outsider}),
            null, null, 'resource', null, null, 'domain', ${domainA}, false
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`select set_config('helix.actor_id', ${delegate}, true)`;
        await tx`
          select helix_grant_delegated_iam_binding(
            ${orgA}, ${root}, ${rootDomainBinding}, ${domainRole}, 'membership',
            (select id from organization_memberships where actor_id = ${target}),
            null, null, 'resource', null, null, 'domain', ${domainA}, false
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("does not infer OU, group, domain, or product ancestry", async () => {
    const boundaries = await database<
      {
        ou_exact: boolean;
        ou_parent: boolean;
        ou_peer: boolean;
        group_exact: boolean;
        group_peer: boolean;
        product_exact: boolean;
        product_peer: boolean;
      }[]
    >`
      select
        helix_iam_scope_within_ceiling(${orgA}, ${rootOuBinding}, 'org_unit', ${ouChild}, null, null, null) as ou_exact,
        helix_iam_scope_within_ceiling(${orgA}, ${rootOuBinding}, 'org_unit', ${ouParent}, null, null, null) as ou_parent,
        helix_iam_scope_within_ceiling(${orgA}, ${rootOuBinding}, 'org_unit', ${ouPeer}, null, null, null) as ou_peer,
        helix_iam_scope_within_ceiling(${orgA}, ${rootGroupBinding}, 'group', null, ${groupA}, null, null) as group_exact,
        helix_iam_scope_within_ceiling(${orgA}, ${rootGroupBinding}, 'group', null, ${groupB}, null, null) as group_peer,
        helix_iam_scope_within_ceiling(${orgA}, ${rootProductBinding}, 'resource', null, null, 'product', 'mail') as product_exact,
        helix_iam_scope_within_ceiling(${orgA}, ${rootProductBinding}, 'resource', null, null, 'product', 'drive') as product_peer
    `;
    expect(boundaries[0]).toEqual({
      ou_exact: true,
      ou_parent: false,
      ou_peer: false,
      group_exact: true,
      group_peer: false,
      product_exact: true,
      product_peer: false,
    });
  });

  it("cannot delegate a permission denied by another matching role", async () => {
    await database`
      insert into iam_roles (id, org_id, role_key, display_name, kind)
      values (${denyRole}, ${orgA}, 'domain_deny', 'Domain deny', 'custom')
    `;
    await database`
      insert into iam_role_permissions (org_id, role_id, permission, effect)
      values (${orgA}, ${denyRole}, 'admin.domains', 'deny')
    `;
    await database`
      insert into iam_role_bindings (
        id, org_id, role_id, principal_type, membership_id, scope_type
      ) values (
        ${denyBinding}, ${orgA}, ${denyRole}, 'membership',
        (select id from organization_memberships where actor_id = ${delegate}), 'org'
      )
    `;
    await expect(
      database.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`select set_config('helix.actor_id', ${delegate}, true)`;
        await tx`
          select helix_grant_delegated_iam_binding(
            ${orgA}, ${delegate}, ${delegateBinding}, ${domainRole}, 'membership',
            (select id from organization_memberships where actor_id = ${target}),
            null, null, 'resource', null, null, 'domain', ${domainA}, false
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await database`delete from iam_role_bindings where id = ${denyBinding}`;
    await database`delete from iam_roles where id = ${denyRole}`;
  });

  it("permits only ceiling-bounded custom roles and blocks direct runtime mutation", async () => {
    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`select set_config('helix.actor_id', ${delegate}, true)`;
        await tx`
        select helix_create_custom_iam_role(
          ${orgA}, ${delegate}, ${delegateBinding}, 'domain_reader', 'Domain reader', '',
          array['admin.domains']::text[], array[]::text[]
        )
      `;
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`select set_config('helix.actor_id', ${delegate}, true)`;
        await tx`
          select helix_create_custom_iam_role(
            ${orgA}, ${delegate}, ${delegateBinding}, 'self_escalation', 'Self escalation', '',
            array['admin.users']::text[], array[]::text[]
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`
        insert into iam_role_permissions (org_id, role_id, permission, effect)
        values (${orgA}, ${domainRole}, 'admin.users', 'allow')
      `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`
        insert into iam_role_bindings (
          org_id, role_id, principal_type, membership_id, scope_type
        ) values (
          ${orgA}, ${userRole}, 'membership',
          (select id from organization_memberships where actor_id = ${delegate}), 'org'
        )
      `;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot revoke a parent or peer, but revokes its own child with immutable audit", async () => {
    for (const bindingId of [rootDomainBinding, peerBinding]) {
      await expect(
        database.begin(async (tx) => {
          await tx`select set_config('helix.org_id', ${orgA}, true)`;
          await tx`select set_config('helix.actor_id', ${delegate}, true)`;
          await tx`
            select helix_revoke_delegated_iam_binding(${orgA}, ${delegate}, ${bindingId})
          `;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await database.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${orgA}, true)`;
      await tx`select set_config('helix.actor_id', ${delegate}, true)`;
      await tx`
        select helix_revoke_delegated_iam_binding(${orgA}, ${delegate}, ${childBinding})
      `;
    });

    const events = await database<{ event_type: string }[]>`
      select event_type from iam_delegation_events
      where org_id = ${orgA} and binding_id = ${childBinding}
      order by created_at
    `;
    expect(events.map((event) => event.event_type)).toEqual(["granted", "revoked"]);
    const grants = await database<{ grants: unknown }[]>`
      select helix_actor_role_bindings(${orgA}, ${target}) as grants
    `;
    expect(grants[0]?.grants).toEqual([]);

    await expect(database`
      update iam_delegation_events set event_type = 'granted'
      where org_id = ${orgA} and binding_id = ${childBinding}
    `).rejects.toMatchObject({ code: "23000" });
    await expect(database`
      delete from iam_delegation_events
      where org_id = ${orgA} and binding_id = ${childBinding}
    `).rejects.toMatchObject({ code: "23000" });
  });
});
