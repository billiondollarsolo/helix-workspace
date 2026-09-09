import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "../../platform/drive/store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 1 });

describe("0115 member Drive preferences migration", () => {
  it("moves stars out of object metadata into composite-FK, self-RLS rows", async () => {
    const migration = await readFile(
      new URL("./0115_drive_member_preferences.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("primary key (org_id, membership_id, object_id)");
    expect(migration).toContain("references organization_memberships (org_id, id)");
    expect(migration).toContain("references objects (org_id, id)");
    expect(migration).toContain("metadata = metadata - 'starred'");
    expect(migration).toContain("objects_metadata_no_starred");
    expect(migration).not.toContain("starred boolean");
    expect(migration).toContain("alter table drive_member_stars force row level security");
    expect(migration).toContain(
      "alter table workspace_member_preferences force row level security",
    );
    expect(migration).toContain("membership.actor_id = helix_current_actor_id()");
    expect(migration).toContain("membership.status = 'active'");
  });
});

describe.skipIf(sql === null)("0115 live two-member Drive preference isolation", () => {
  const database = sql as postgres.Sql;
  const orgId = "d7160000-0000-4000-8000-000000000001";
  const actorA = "d7160000-0000-4000-8000-000000000011";
  const actorB = "d7160000-0000-4000-8000-000000000012";
  const objectId = "d7160000-0000-4000-8000-000000000021";
  let membershipA = "";
  let membershipB = "";

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name, status, tier, region)
      values (${orgId}, 'drv16-members', 'DRV 16 members', 'active', 'business', 'test')
    `;
    await database`
      insert into actors (id, org_id, type, display_name)
      values
        (${actorA}, ${orgId}, 'user', 'DRV 16 A'),
        (${actorB}, ${orgId}, 'user', 'DRV 16 B')
    `;
    const memberships = await database<{ id: string; actor_id: string }[]>`
      select id, actor_id
      from organization_memberships
      where org_id = ${orgId} and actor_id in (${actorA}, ${actorB})
    `;
    membershipA = memberships.find((row) => row.actor_id === actorA)?.id ?? "";
    membershipB = memberships.find((row) => row.actor_id === actorB)?.id ?? "";
    if (membershipA.length === 0 || membershipB.length === 0) {
      throw new Error("Expected active memberships for both DRV-16 actors.");
    }
    await database`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata
      ) values (
        ${objectId}, ${orgId}, ${actorA}, 'file', 'drv16/shared.txt', 'text/plain', 1,
        ${database.json({ name: "shared.txt" })}
      )
    `;
    await database`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${orgId}, ${actorB}, 'object', ${objectId}, 'reader', ${actorA})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  async function cleanup(): Promise<void> {
    await database`delete from activity where org_id = ${orgId}`;
    await database`delete from permissions where org_id = ${orgId}`;
    await database`delete from objects where org_id = ${orgId}`;
    await database`delete from organization_memberships where org_id = ${orgId}`;
    await database`delete from actors where id in (${actorA}, ${actorB})`;
    await database`delete from orgs where id = ${orgId}`;
    await database`delete from identity_subjects where id in (${actorA}, ${actorB})`;
  }

  it("keeps the same readable object's star and layout isolated by membership", async () => {
    const store = new PostgresDriveStore(database);

    await expect(
      store.setStarred({ orgId, actorId: actorA, objectId, starred: true }),
    ).resolves.toMatchObject({ metadata: { starred: true } });
    await expect(
      store.setDocumentSurfaceView({ orgId, actorId: actorB, view: "list" }),
    ).resolves.toBe("list");

    const [listA, listB, viewA, viewB] = await Promise.all([
      store.list({ orgId, actorId: actorA, acrossFolders: true }),
      store.list({ orgId, actorId: actorB, acrossFolders: true }),
      store.getDocumentSurfaceView({ orgId, actorId: actorA }),
      store.getDocumentSurfaceView({ orgId, actorId: actorB }),
    ]);

    expect(listA.entries[0]?.metadata.starred).toBe(true);
    expect(listB.entries[0]?.metadata).not.toHaveProperty("starred");
    expect(viewA).toBe("grid");
    expect(viewB).toBe("list");
    const objectRows = await database<{ metadata: Record<string, unknown> }[]>`
      select metadata from objects where id = ${objectId}
    `;
    expect(objectRows[0]?.metadata).not.toHaveProperty("starred");
    await expect(
      database`
        update objects set metadata = metadata || '{"starred": true}'::jsonb
        where id = ${objectId}
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the restricted runtime role see and mutate only its active membership", async () => {
    const visibleStars = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgId}, true)`;
      await tx`select set_config('helix.actor_id', ${actorA}, true)`;
      return tx<{ membership_id: string }[]>`
        select membership_id from drive_member_stars where org_id = ${orgId}
      `;
    });
    expect(visibleStars).toEqual([{ membership_id: membershipA }]);

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actorA}, true)`;
        await tx`
          insert into drive_member_stars (org_id, membership_id, object_id)
          values (${orgId}, ${membershipB}, ${objectId})
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    const forgedPreference = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgId}, true)`;
      await tx`select set_config('helix.actor_id', ${actorA}, true)`;
      return tx`
        update workspace_member_preferences
        set document_surface_view = 'grid'
        where org_id = ${orgId} and membership_id = ${membershipB}
        returning membership_id
      `;
    });
    expect(forgedPreference).toEqual([]);
  });
});
