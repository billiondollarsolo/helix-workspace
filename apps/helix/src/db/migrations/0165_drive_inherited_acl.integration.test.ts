import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(process.env.DATABASE_URL === undefined)("inherited Drive ACL matrix", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const org = "f1650000-0000-4000-8000-000000000001";
  const owner = "f1650000-0000-4000-8000-000000000011";
  const member = "f1650000-0000-4000-8000-000000000012";
  const guest = "f1650000-0000-4000-8000-000000000013";
  const group = "f1650000-0000-4000-8000-000000000021";
  const root = "f1650000-0000-4000-8000-000000000031";
  const child = "f1650000-0000-4000-8000-000000000032";
  const sharedRoot = "f1650000-0000-4000-8000-000000000033";
  const object = "f1650000-0000-4000-8000-000000000041";
  const sharedObject = "f1650000-0000-4000-8000-000000000042";
  const sharedDrive = "f1650000-0000-4000-8000-000000000051";

  const role = async (actor: string, resource: string) => {
    const rows = await sql<{ readonly role: string | null }[]>`
      select helix_drive_effective_role(${org}, ${actor}, 'object', ${resource}) as role
    `;
    return rows[0]?.role ?? null;
  };

  async function cleanup() {
    await cleanupTestTenants(sql, [org]);
  }

  beforeAll(async () => {
    const ready = await sql<{ readonly ready: boolean }[]>`
      select to_regprocedure('helix_drive_effective_role(uuid,uuid,text,uuid)') is not null as ready
    `;
    if (ready[0]?.ready !== true) throw new Error("Run migration 0165 before this test.");
    await cleanup();
    await sql`insert into orgs(id, slug, display_name) values (${org}, 'drive-acl-165', 'Drive ACL')`;
    await sql`insert into actors(id, org_id, type, email, display_name) values
      (${owner}, ${org}, 'user', 'owner@helix.test', 'Owner'),
      (${member}, ${org}, 'user', 'member@helix.test', 'Member'),
      (${guest}, ${org}, 'user', 'guest@partner.test', 'Guest')`;
    await sql`update organization_memberships set guest_type = 'external' where actor_id = ${guest}`;
    await sql`insert into admin_groups(id, org_id, name, kind, created_by)
      values (${group}, ${org}, 'Editors', 'security', ${owner})`;
    await sql`insert into admin_group_members(org_id, group_id, actor_id, added_by)
      values (${org}, ${group}, ${member}, ${owner})`;
    await sql`insert into drive_folders(id, org_id, name, parent_folder_id, owner_actor_id, created_by_actor_id) values
      (${root}, ${org}, 'Root', null, ${owner}, ${owner}),
      (${child}, ${org}, 'Child', ${root}, ${owner}, ${owner}),
      (${sharedRoot}, ${org}, 'Team', null, ${owner}, ${owner})`;
    await sql`insert into objects(id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata) values
      (${object}, ${org}, ${owner}, 'file', 'acl/object', 'text/plain', 1,
        ${sql.json({ name: "object.txt", folderId: child, status: "ready" })}),
      (${sharedObject}, ${org}, ${owner}, 'file', 'acl/shared', 'text/plain', 1,
        ${sql.json({ name: "shared.txt", folderId: sharedRoot, status: "ready" })})`;
    await sql`insert into admin_security_policies(org_id, policy_type, enabled, enforcement, settings, updated_by)
      values (${org}, 'external_sharing', true, 'required',
        ${sql.json({ mode: "allowlist", allowedDomains: ["partner.test"], requireExpiry: false })}, ${owner})`;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("denies a domain grant when the caller has no effective resource role", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${guest}, true)`;
        await tx`select helix_set_drive_domain_grant(
        ${org}, ${guest}, 'drive_folder', ${root}, 'partner.test', 'reader', null
      )`;
      }),
    ).rejects.toThrow("domain grant requires resource ownership");
  });

  it("handles nested group/domain grants, explicit exceptions, moves, and transfer atomically", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
      await tx`select helix_grant_directory_group_resource(
        ${org}, ${owner}, ${group}, 'drive_folder', ${root}, 'commenter', null
      )`;
      await tx`select helix_set_drive_domain_grant(
        ${org}, ${owner}, 'drive_folder', ${root}, 'partner.test', 'reader', null
      )`;
    });
    await expect(role(member, object)).resolves.toBe("commenter");
    await expect(role(guest, object)).resolves.toBe("reader");

    await sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
      await tx`select helix_set_drive_acl_exception(
        ${org}, ${owner}, 'drive_folder', ${child}, 'group', ${group}, null, true
      )`;
    });
    await expect(role(member, object)).resolves.toBeNull();
    await sql`insert into permissions(org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values (${org}, ${member}, 'object', ${object}, 'reader', ${owner})`;
    await expect(role(member, object)).resolves.toBe("reader");
    await sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
      await tx`select helix_set_drive_acl_exception(
        ${org}, ${owner}, 'drive_folder', ${child}, 'group', ${group}, null, false
      )`;
    });
    await expect(role(member, object)).resolves.toBe("commenter");
    await sql`delete from admin_group_members where org_id = ${org} and group_id = ${group} and actor_id = ${member}`;
    await expect(role(member, object)).resolves.toBe("reader");

    await sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
      await tx`select helix_drive_create_shared_drive(${org}, ${owner}, ${sharedDrive}, ${sharedRoot}, 'Team')`;
      await tx`select helix_drive_move_folder(${org}, ${owner}, ${child}, ${sharedRoot})`;
    });
    const moved = await sql<{ readonly owner_actor_id: string | null }[]>`
      select owner_actor_id from objects where id = ${object}
    `;
    expect(moved[0]?.owner_actor_id).toBeNull();
    await expect(role(owner, object)).resolves.toBe("owner");

    await sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${owner}, true)`;
      await tx`select helix_drive_move_folder(${org}, ${owner}, ${child}, ${root})`;
    });
    const restored = await sql<{ readonly owner_actor_id: string | null }[]>`
      select owner_actor_id from objects where id = ${object}
    `;
    expect(restored[0]?.owner_actor_id).toBe(owner);

    await sql`insert into drive_workflows(
      id, org_id, kind, resource_type, resource_id, requested_by_actor_id,
      assigned_to_actor_id, state, payload, policy_snapshot
    ) values (
      gen_random_uuid(), ${org}, 'ownership_transfer', 'object', ${sharedObject},
      ${owner}, ${member}, 'open', '{}', '{}'
    )`;
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('helix.org_id', ${org}, true), set_config('helix.actor_id', ${member}, true)`;
        await tx`select helix_drive_apply_ownership_transfer(${org}, id)
        from drive_workflows where org_id = ${org} and resource_id = ${sharedObject}`;
      }),
    ).rejects.toThrow(/organization-owned shared Drive/u);
  });
});
