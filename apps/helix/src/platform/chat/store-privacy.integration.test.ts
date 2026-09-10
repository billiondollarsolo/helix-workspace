import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { ChatRoomAccessError } from "./errors.js";
import { PostgresChatStore } from "./store.js";

const ORG_ID = "fa140000-0000-4000-8000-000000000001";
const OWNER_ID = "fa140000-0000-4000-8000-000000000011";
const MEMBER_ID = "fa140000-0000-4000-8000-000000000012";
const VIEWER_ID = "fa140000-0000-4000-8000-000000000013";

describe("Chat room privacy", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresChatStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 4, prepare: false });
    store = new PostgresChatStore(sql);
    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name)
      values (${ORG_ID}, 'chat-privacy-proof', 'Chat Privacy Proof')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name)
      values
        (${OWNER_ID}, ${ORG_ID}, 'user', 'Owner'),
        (${MEMBER_ID}, ${ORG_ID}, 'user', 'Member'),
        (${VIEWER_ID}, ${ORG_ID}, 'user', 'Viewer')
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("enforces discovery, self-join, and canonical direct-message identity", async () => {
    const discoverable = await store.createRoom({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      subject: "Public",
      privacy: "discoverable",
    });
    const restricted = await store.createRoom({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      subject: "Invite only",
      privacy: "restricted",
    });
    const privateRoom = await store.createRoom({
      orgId: ORG_ID,
      actorId: OWNER_ID,
      subject: "Hidden",
      privacy: "private",
    });

    await expect(store.discoverRooms({ orgId: ORG_ID, actorId: VIEWER_ID })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: discoverable.id, members: [] }),
        expect.objectContaining({ id: restricted.id, members: [] }),
      ]),
    );
    expect(
      (await store.discoverRooms({ orgId: ORG_ID, actorId: VIEWER_ID })).map(({ id }) => id),
    ).not.toContain(privateRoom.id);
    await expect(
      store.joinRoom({ orgId: ORG_ID, actorId: VIEWER_ID, roomId: restricted.id }),
    ).resolves.toBeNull();
    await expect(
      store.joinRoom({ orgId: ORG_ID, actorId: VIEWER_ID, roomId: privateRoom.id }),
    ).resolves.toBeNull();
    await expect(
      store.joinRoom({ orgId: ORG_ID, actorId: VIEWER_ID, roomId: discoverable.id }),
    ).resolves.toMatchObject({ id: discoverable.id });

    const [first, second] = await Promise.all([
      store.createRoom({
        orgId: ORG_ID,
        actorId: OWNER_ID,
        kind: "chat_dm",
        memberActorIds: [MEMBER_ID],
      }),
      store.createRoom({
        orgId: ORG_ID,
        actorId: MEMBER_ID,
        kind: "chat_dm",
        memberActorIds: [OWNER_ID],
      }),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.settings?.privacy).toBe("private");
    await expect(
      store.invite({
        orgId: ORG_ID,
        actorId: OWNER_ID,
        roomId: first.id,
        actorIds: [VIEWER_ID],
      }),
    ).rejects.toBeInstanceOf(ChatRoomAccessError);
    await expect(sql`
      select count(*)::int as count
      from chat_room_settings
      where org_id = ${ORG_ID} and participant_key is not null
    `).resolves.toEqual([{ count: 1 }]);
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await cleanupTestTenants(sql, [ORG_ID]);
}
