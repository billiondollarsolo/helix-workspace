import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizeChatSearchHit } from "../search/authorized.js";
import { createChatSearchIndexer } from "./search/indexer.js";
import { PostgresChatStore } from "./store.js";

const ORG_ID = "fa110000-0000-4000-8000-000000000001";
const ACTOR_ID = "fa110000-0000-4000-8000-000000000011";
const MEMBER_ID = "fa110000-0000-4000-8000-000000000012";

describe("Chat search synchronization", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresChatStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresChatStore(sql);
    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name)
      values (${ORG_ID}, 'chat-search-sync', 'Chat Search Sync')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name)
      values
        (${ACTOR_ID}, ${ORG_ID}, 'user', 'Search Author'),
        (${MEMBER_ID}, ${ORG_ID}, 'user', 'Search Member')
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("atomically preserves revisions and emits replayable update/delete projections", async () => {
    const room = await store.createRoom({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      subject: "Search",
      memberActorIds: [MEMBER_ID],
    });
    const sent = await store.sendMessage({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      roomId: room.id,
      body: "original secret phrase",
    });
    const edited = await store.editMessage({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      messageId: sent.id,
      body: "replacement phrase",
    });
    expect(edited?.revision).toBe(2);

    const indexer = createChatSearchIndexer(store);
    await expect(
      indexer.route({
        subject: "activity.chat.message.updated",
        payload: { orgId: ORG_ID, roomId: room.id, messageId: sent.id, aclVersion: 1 },
        occurredAt: new Date().toISOString(),
      }),
    ).resolves.toMatchObject({
      upsert: [
        {
          id: `chat:${sent.id}`,
          body: expect.stringContaining("replacement phrase"),
          attributes: {
            orgId: ORG_ID,
            roomId: room.id,
            aclVersion: 2,
            allowedActorIds: [ACTOR_ID, MEMBER_ID],
          },
        },
      ],
    });

    await sql`
      update permissions
      set status = 'revoked', revoked_at = now(), revocation_epoch = revocation_epoch + 1
      where org_id = ${ORG_ID}
        and actor_id = ${MEMBER_ID}
        and resource_type = 'thread'
        and resource_id = ${room.id}
    `;
    await expect(
      authorizeChatSearchHit(
        store,
        { query: "replacement", forActorId: MEMBER_ID },
        {
          id: `chat:${sent.id}`,
          type: "chat",
          attributes: {
            orgId: ORG_ID,
            roomId: room.id,
            allowedActorIds: [ACTOR_ID, MEMBER_ID],
          },
        },
      ),
    ).resolves.toBe(false);

    const deleted = await store.deleteMessage({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      messageId: sent.id,
    });
    expect(deleted?.revision).toBe(3);
    await expect(
      indexer.route({
        subject: "activity.chat.message.deleted",
        payload: { orgId: ORG_ID, roomId: room.id, messageId: sent.id, aclVersion: 1 },
        occurredAt: new Date().toISOString(),
      }),
    ).resolves.toEqual({ delete: [`chat:${sent.id}`] });

    await expect(sql`
      select revision::int, body, deleted_at
      from chat_message_revisions
      where message_id = ${sent.id}
      order by revision
    `).resolves.toEqual([
      { revision: 1, body: "original secret phrase", deleted_at: null },
      { revision: 2, body: "replacement phrase", deleted_at: null },
    ]);
    await expect(sql`
      select subject, payload->>'aclVersion' as acl_version
      from outbox
      where payload->>'messageId' = ${sent.id}
        and subject in ('activity.chat.message.updated', 'activity.chat.message.deleted')
      order by created_at
    `).resolves.toEqual([
      { subject: "activity.chat.message.updated", acl_version: "2" },
      { subject: "activity.chat.message.deleted", acl_version: "3" },
    ]);
    await expect(sql`
      select event->>'type' as type, event->>'version' as version
      from chat_room_events
      where room_id = ${room.id}
        and event->>'type' like 'message.%'
      order by sequence
    `).resolves.toEqual([
      { type: "message.created", version: "1" },
      { type: "message.updated", version: "1" },
      { type: "message.deleted", version: "1" },
    ]);
  });
});

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from outbox where payload->>'orgId' = ${ORG_ID}`;
  await sql`delete from permissions where org_id = ${ORG_ID}`;
  await sql`delete from messages where org_id = ${ORG_ID}`;
  await sql`delete from threads where org_id = ${ORG_ID}`;
  await sql`delete from actors where org_id = ${ORG_ID}`;
  await sql`delete from orgs where id = ${ORG_ID}`;
}
