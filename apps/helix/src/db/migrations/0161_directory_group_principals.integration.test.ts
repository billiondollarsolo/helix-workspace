import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.env.DATABASE_URL === undefined)(
  "Postgres directory group principals",
  () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
    const orgId = "f1610000-0000-4000-8000-000000000001";
    const otherOrgId = "f1610000-0000-4000-8000-000000000002";
    const ownerId = "f1610000-0000-4000-8000-000000000011";
    const memberId = "f1610000-0000-4000-8000-000000000012";
    const groupId = "f1610000-0000-4000-8000-000000000021";
    const otherGroupId = "f1610000-0000-4000-8000-000000000022";
    const objectId = "f1610000-0000-4000-8000-000000000031";
    const threadId = "f1610000-0000-4000-8000-000000000032";
    const calendarId = "f1610000-0000-4000-8000-000000000033";

    beforeAll(async () => {
      await cleanup();
      await sql`insert into orgs (id, slug, display_name) values
      (${orgId}, 'iam17-test', 'IAM 17'),
      (${otherOrgId}, 'iam17-other', 'IAM 17 Other')`;
      await sql`insert into actors (id, org_id, type, email, display_name) values
      (${ownerId}, ${orgId}, 'user', 'owner@iam17.example', 'Owner'),
      (${memberId}, ${orgId}, 'user', 'member@iam17.example', 'Member')`;
      await sql`insert into admin_groups (id, org_id, name, kind, created_by) values
      (${groupId}, ${orgId}, 'Engineering', 'security', ${ownerId}),
      (${otherGroupId}, ${otherOrgId}, 'Foreign', 'security', null)`;
      await sql`insert into admin_group_members (org_id, group_id, actor_id, added_by)
      values (${orgId}, ${groupId}, ${memberId}, ${ownerId})`;
      // Isolate this fixture from unrelated Drive workflow projection triggers.
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size
      ) values (${objectId}, ${orgId}, ${ownerId}, 'file', 'iam17/object', 'text/plain', 1)`;
      });
      await sql`insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${threadId}, ${orgId}, 'chat_room', 'IAM 17', ${ownerId})`;
      await sql`insert into chat_room_settings (thread_id, org_id, name)
      values (${threadId}, ${orgId}, 'IAM 17')`;
      await sql`insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
    ) values (${orgId}, ${ownerId}, 'thread', ${threadId}, 'owner', ${ownerId})`;
      await sql`insert into cal_calendars (id, org_id, owner_actor_id, name)
      values (${calendarId}, ${orgId}, ${ownerId}, 'IAM 17')`;
      await sql`insert into cal_calendar_memberships (
      org_id, calendar_id, actor_id, role, sort_order
    ) values (${orgId}, ${calendarId}, ${ownerId}, 'owner', 0)
      on conflict (actor_id, calendar_id) do nothing`;
    });

    afterAll(async () => {
      await cleanup();
      await sql.end();
    });

    it("propagates one group to Drive, Chat, Calendar, and RBAC in the membership transaction", async () => {
      await grant("object", objectId, "editor");
      await grant("thread", threadId, "member");
      await grant("calendar", calendarId, "writer");

      const roles = await sql<{ readonly id: string }[]>`
      select id from iam_roles where org_id = ${orgId} and role_key = 'workspace_viewer'
      `;
      const roleId = roles[0]?.id;
      if (roleId === undefined) throw new Error("Workspace viewer role was not seeded.");
      const rootBindings = await sql<{ readonly id: string }[]>`
      insert into iam_role_bindings (
        org_id, role_id, principal_type, membership_id, scope_type, can_delegate
      )
      select ${orgId}, ${roleId}, 'membership', membership.id, 'org', true
      from organization_memberships membership
      where membership.org_id = ${orgId} and membership.actor_id = ${ownerId}
      returning id
    `;
      const rootBindingId = rootBindings[0]?.id;
      if (rootBindingId === undefined) throw new Error("Root IAM binding was not created.");
      await sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${orgId}, true),
        set_config('helix.actor_id', ${ownerId}, true)`;
        await tx`select helix_grant_delegated_iam_binding(
        ${orgId}, ${ownerId}, ${rootBindingId}, ${roleId},
        'group', null, null, ${groupId}, 'org', null, null, null, null, false
      )`;
      });

      await expect(effectiveProducts()).resolves.toEqual(["calendar", "object", "thread"]);
      const bindings = await sql<{ readonly bindings: unknown }[]>`
      select helix_actor_role_bindings(${orgId}, ${memberId}) as bindings
    `;
      expect(bindings[0]?.bindings).toEqual([
        expect.objectContaining({
          allow: expect.arrayContaining(["platform.read"]),
          scopeType: "org",
        }),
      ]);

      await sql`delete from admin_group_members
      where org_id = ${orgId} and group_id = ${groupId} and actor_id = ${memberId}`;
      await expect(effectiveProducts()).resolves.toEqual([]);
      const removed = await sql<{ readonly bindings: unknown }[]>`
      select helix_actor_role_bindings(${orgId}, ${memberId}) as bindings
    `;
      expect(removed[0]?.bindings).toEqual([]);

      await sql`insert into admin_group_members (org_id, group_id, actor_id, added_by)
      values (${orgId}, ${groupId}, ${memberId}, ${ownerId})`;
      await expect(effectiveProducts()).resolves.toEqual(["calendar", "object", "thread"]);
    });

    it("repairs derived access and rejects cross-tenant group confusion", async () => {
      await sql`delete from permissions
      where org_id = ${orgId} and actor_id = ${memberId}
        and resource_type = 'object' and resource_id = ${objectId}`;
      await expect(effectiveProducts()).resolves.toContain("object");

      const grants = await sql<{ readonly id: string }[]>`
      select id from directory_group_resource_grants
      where org_id = ${orgId} and group_id = ${groupId}
        and resource_type = 'object' and resource_id = ${objectId}
    `;
      const grantId = grants[0]?.id;
      if (grantId === undefined) throw new Error("Object group grant was not created.");
      await sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${orgId}, true),
        set_config('helix.actor_id', ${ownerId}, true)`;
        const revoked = await tx<{ readonly revoked: boolean }[]>`
        select helix_revoke_directory_group_resource(
          ${orgId}, ${ownerId}, ${grantId}
        ) as revoked
      `;
        expect(revoked[0]?.revoked).toBe(true);
      });
      await expect(effectiveProducts()).resolves.not.toContain("object");
      await grant("object", objectId, "editor");

      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('helix.org_id', ${orgId}, true),
          set_config('helix.actor_id', ${ownerId}, true)`;
          await tx`select helix_grant_directory_group_resource(
          ${orgId}, ${ownerId}, ${otherGroupId}, 'object', ${objectId}, 'viewer', null
        )`;
        }),
      ).rejects.toThrow(/group is not in this organization/u);
    });

    async function grant(resourceType: string, resourceId: string, role: string): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${orgId}, true),
        set_config('helix.actor_id', ${ownerId}, true)`;
        await tx`select helix_grant_directory_group_resource(
        ${orgId}, ${ownerId}, ${groupId}, ${resourceType}, ${resourceId}, ${role}, null
      )`;
      });
    }

    async function effectiveProducts(): Promise<readonly string[]> {
      const rows = await sql<{ readonly product: string }[]>`
      select case resource_type when 'object' then 'object' else 'thread' end as product
      from permissions
      where org_id = ${orgId} and actor_id = ${memberId}
        and source_group_grant_id is not null
      union all
      select 'calendar'
      from cal_calendar_memberships
      where org_id = ${orgId} and actor_id = ${memberId}
        and source_group_grant_id is not null
      order by product
    `;
      return rows.map((row) => row.product);
    }

    async function cleanup(): Promise<void> {
      await sql`delete from directory_group_resource_grants where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from iam_role_bindings where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from cal_calendar_memberships where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from cal_calendars where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from permissions where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from chat_room_settings where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from threads where org_id in (${orgId}, ${otherOrgId})`;
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from objects where org_id in (${orgId}, ${otherOrgId})`;
      });
      await sql`delete from admin_group_members where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from admin_groups where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from organization_memberships where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from actors where org_id in (${orgId}, ${otherOrgId})`;
      await sql`delete from identity_subjects
      where canonical_email in ('owner@iam17.example', 'member@iam17.example')`;
      await sql`delete from orgs where id in (${orgId}, ${otherOrgId})`;
    }
  },
);
