import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatMessageNotFoundError } from "./errors.js";
import { PostgresChatStore } from "./store.js";

const ORG_A = "f8500000-0000-4000-8000-000000000001";
const ORG_B = "f8500000-0000-4000-8000-000000000002";
const ACTOR_A = "f8500000-0000-4000-8000-000000000011";
const MEMBER_A = "f8500000-0000-4000-8000-000000000012";
const ACTOR_B = "f8500000-0000-4000-8000-000000000013";
const ROOM_A = "f8500000-0000-4000-8000-000000000021";
const ROOM_A_OTHER = "f8500000-0000-4000-8000-000000000022";
const ROOM_B = "f8500000-0000-4000-8000-000000000023";
const MESSAGE_OLD = "f8500000-0000-4000-8000-000000000031";
const MESSAGE_NEW = "f8500000-0000-4000-8000-000000000032";
const MESSAGE_OTHER_ROOM = "f8500000-0000-4000-8000-000000000033";
const MESSAGE_OTHER_ORG = "f8500000-0000-4000-8000-000000000034";

describe("PostgresChatStore read-receipt isolation", { skip: !process.env.DATABASE_URL }, () => {
  let sql: postgres.Sql;
  let store: PostgresChatStore;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(databaseUrl, { max: 4, prepare: false });
    store = new PostgresChatStore(sql);

    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name)
      values
        (${ORG_A}, 'chat-read-receipts-a', 'Chat Receipts A'),
        (${ORG_B}, 'chat-read-receipts-b', 'Chat Receipts B')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name)
      values
        (${ACTOR_A}, ${ORG_A}, 'user', 'Actor A'),
        (${MEMBER_A}, ${ORG_A}, 'user', 'Member A'),
        (${ACTOR_B}, ${ORG_B}, 'user', 'Actor B')
    `;
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values
        (${ROOM_A}, ${ORG_A}, 'chat_room', 'A', ${ACTOR_A}),
        (${ROOM_A_OTHER}, ${ORG_A}, 'chat_room', 'A other', ${ACTOR_A}),
        (${ROOM_B}, ${ORG_B}, 'chat_room', 'B', ${ACTOR_B})
    `;
    await sql`
      insert into chat_room_settings (thread_id, org_id, name)
      values (${ROOM_A}, ${ORG_A}, 'A'), (${ROOM_A_OTHER}, ${ORG_A}, 'A other'), (${ROOM_B}, ${ORG_B}, 'B')
    `;
    await sql`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      )
      values
        (${ORG_A}, ${ACTOR_A}, 'thread', ${ROOM_A}, 'owner', ${ACTOR_A}),
        (${ORG_A}, ${MEMBER_A}, 'thread', ${ROOM_A}, 'member', ${ACTOR_A}),
        (${ORG_A}, ${ACTOR_A}, 'thread', ${ROOM_A_OTHER}, 'owner', ${ACTOR_A}),
        (${ORG_B}, ${ACTOR_B}, 'thread', ${ROOM_B}, 'owner', ${ACTOR_B})
    `;
    await sql`
      insert into messages (id, org_id, thread_id, actor_id, kind, body, sent_at)
      values
        (${MESSAGE_OLD}, ${ORG_A}, ${ROOM_A}, ${ACTOR_A}, 'chat', 'old', '2026-09-02T10:00:00Z'),
        (${MESSAGE_NEW}, ${ORG_A}, ${ROOM_A}, ${ACTOR_A}, 'chat', 'new', '2026-09-02T11:00:00Z'),
        (${MESSAGE_OTHER_ROOM}, ${ORG_A}, ${ROOM_A_OTHER}, ${ACTOR_A}, 'chat', 'other', '2026-09-02T12:00:00Z'),
        (${MESSAGE_OTHER_ORG}, ${ORG_B}, ${ROOM_B}, ${ACTOR_B}, 'chat', 'foreign', '2026-09-02T13:00:00Z')
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("assigns stable increasing positions and never regresses under concurrent devices", async () => {
    const positions = await sql<{ readonly id: string; readonly chat_room_sequence: string }[]>`
      select id, chat_room_sequence
      from messages
      where thread_id = ${ROOM_A}
      order by chat_room_sequence
    `;
    expect(positions.map((row) => row.id)).toEqual([MESSAGE_OLD, MESSAGE_NEW]);

    await Promise.all([
      store.markRead({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A, messageId: MESSAGE_NEW }),
      store.markRead({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A, messageId: MESSAGE_OLD }),
    ]);
    await expect(
      store.markRead({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A, messageId: MESSAGE_OLD }),
    ).resolves.toMatchObject({ lastReadMessageId: MESSAGE_NEW });
  });

  it("rejects same-tenant cross-room and cross-tenant message ids without changing progress", async () => {
    for (const messageId of [MESSAGE_OTHER_ROOM, MESSAGE_OTHER_ORG]) {
      await expect(
        store.markRead({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A, messageId }),
      ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
    }
    const rows = await sql<{ readonly last_read_message_id: string }[]>`
      select last_read_message_id
      from chat_read_receipts
      where thread_id = ${ROOM_A} and actor_id = ${ACTOR_A}
    `;
    expect(rows[0]?.last_read_message_id).toBe(MESSAGE_NEW);
  });

  it("fails after membership revocation and suppresses peer receipts when sharing is disabled", async () => {
    await sql`
      update chat_room_settings
      set read_receipts_enabled = false
      where thread_id = ${ROOM_A} and org_id = ${ORG_A}
    `;
    await expect(
      store.markRead({ orgId: ORG_A, actorId: MEMBER_A, roomId: ROOM_A, messageId: MESSAGE_NEW }),
    ).resolves.toMatchObject({ isShared: false });
    await expect(
      store.listReadReceipts({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
    ).resolves.toEqual([expect.objectContaining({ actorId: ACTOR_A })]);

    await sql`
      delete from permissions
      where org_id = ${ORG_A} and actor_id = ${MEMBER_A} and resource_id = ${ROOM_A}
    `;
    await expect(
      store.markRead({ orgId: ORG_A, actorId: MEMBER_A, roomId: ROOM_A, messageId: MESSAGE_NEW }),
    ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from outbox where payload->>'orgId' in (${ORG_A}, ${ORG_B})`;
  await sql`delete from chat_read_receipts where actor_id in (${ACTOR_A}, ${MEMBER_A})`;
  await sql`delete from messages where id in (${MESSAGE_OLD}, ${MESSAGE_NEW}, ${MESSAGE_OTHER_ROOM}, ${MESSAGE_OTHER_ORG})`;
  await sql`delete from permissions where actor_id in (${ACTOR_A}, ${MEMBER_A}, ${ACTOR_B})`;
  await sql`delete from threads where id in (${ROOM_A}, ${ROOM_A_OTHER}, ${ROOM_B})`;
  await sql`delete from actors where id in (${ACTOR_A}, ${MEMBER_A}, ${ACTOR_B})`;
  await sql`delete from orgs where id in (${ORG_A}, ${ORG_B})`;
  await sql`delete from identity_subjects where id in (${ACTOR_A}, ${MEMBER_A}, ${ACTOR_B})`;
}
