import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "./store.js";

const ORG_ID = "f1240000-0000-4000-8000-000000000001";
const ACTOR_ID = "f1240000-0000-4000-8000-000000000002";
const IDS = {
  alpha: "f1240000-0000-4000-8000-000000000010",
  bravo: "f1240000-0000-4000-8000-000000000011",
  charlie: "f1240000-0000-4000-8000-000000000012",
  delta: "f1240000-0000-4000-8000-000000000013",
  echo: "f1240000-0000-4000-8000-000000000014",
  foxtrot: "f1240000-0000-4000-8000-000000000015",
} as const;

describe.skipIf(process.env.DATABASE_URL === undefined)("Drive mixed-entry cursor", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const store = new PostgresDriveStore(sql);

  beforeAll(async () => {
    await sql`
      insert into orgs (id, slug, display_name)
      values (${ORG_ID}, 'drive-pagination-test', 'Drive Pagination Test')
      on conflict (id) do nothing
    `;
    await sql`
      insert into actors (id, org_id, type, display_name, scopes)
      values (${ACTOR_ID}, ${ORG_ID}, 'user', 'Drive Pagination Test', '{}')
      on conflict (id) do nothing
    `;
    await sql`
      insert into drive_folders (id, org_id, name, owner_actor_id, created_by_actor_id)
      values
        (${IDS.alpha}, ${ORG_ID}, 'Alpha', ${ACTOR_ID}, ${ACTOR_ID}),
        (${IDS.echo}, ${ORG_ID}, 'Echo', ${ACTOR_ID}, ${ACTOR_ID})
      on conflict (id) do nothing
    `;
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata)
      values
        (${IDS.bravo}, ${ORG_ID}, ${ACTOR_ID}, 'file', 'drive/test/bravo', 'text/plain', 1, ${sql.json({ name: "Bravo", status: "ready" })}),
        (${IDS.delta}, ${ORG_ID}, ${ACTOR_ID}, 'file', 'drive/test/delta', 'text/plain', 1, ${sql.json({ name: "Delta", status: "ready" })}),
        (${IDS.foxtrot}, ${ORG_ID}, ${ACTOR_ID}, 'file', 'drive/test/foxtrot', 'text/plain', 1, ${sql.json({ name: "Foxtrot", status: "ready" })})
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    await sql`delete from objects where org_id = ${ORG_ID}`;
    await sql`delete from drive_folders where org_id = ${ORG_ID}`;
    await sql`delete from resource_classifications where org_id = ${ORG_ID}`;
    await sql`delete from actors where id = ${ACTOR_ID}`;
    await sql`delete from orgs where id = ${ORG_ID}`;
    await sql.end();
  });

  it("lists folders and files once while later creates and soft deletes do not move the snapshot", async () => {
    const first = await store.list({ orgId: ORG_ID, actorId: ACTOR_ID, limit: 2 });
    expect(first.entries.map((entry) => entry.name)).toEqual(["Alpha", "Bravo"]);
    expect(first.nextCursor).not.toBeNull();

    await sql`select pg_sleep(0.01)`;
    await sql`
      insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata)
      values (${IDS.charlie}, ${ORG_ID}, ${ACTOR_ID}, 'file', 'drive/test/charlie', 'text/plain', 1, ${sql.json({ name: "Charlie", status: "ready" })})
    `;
    await sql`update objects set deleted_at = now() where id = ${IDS.delta}`;

    if (first.nextCursor === null) throw new Error("Expected a next page");
    const second = await store.list({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      limit: 2,
      cursor: first.nextCursor,
    });
    if (second.nextCursor === null) throw new Error("Expected a third page");
    const third = await store.list({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      limit: 2,
      cursor: second.nextCursor,
    });

    expect(
      [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.name),
    ).toEqual(["Alpha", "Bravo", "Delta", "Echo", "Foxtrot"]);
    expect(second.entries[0]?.deletedAt).toBeNull();
    expect(third.nextCursor).toBeNull();
  });

  it("rejects reusing a cursor with different filters", async () => {
    const first = await store.list({ orgId: ORG_ID, actorId: ACTOR_ID, limit: 1 });
    if (first.nextCursor === null) throw new Error("Expected a next page");
    await expect(
      store.list({
        orgId: ORG_ID,
        actorId: ACTOR_ID,
        includeTrashed: true,
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("Invalid Drive list cursor");
  });
});
