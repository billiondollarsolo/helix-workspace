import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatMessageNotFoundError, ChatRoomAccessError } from "./errors.js";
import { InMemoryChatPresenceStore, InMemoryChatRoomBus } from "./realtime.js";
import { handleChatSocket } from "./routes.js";
import { PostgresChatStore } from "./store.js";
import {
  CHAT_WEBSOCKET_AUDIENCE,
  CHAT_WEBSOCKET_PATH,
  type ChatWebSocketTicketStore,
} from "./websocket-tickets.js";

const ORG_A = "fa100000-0000-4000-8000-000000000001";
const ORG_B = "fa100000-0000-4000-8000-000000000002";
const ACTOR_A = "fa100000-0000-4000-8000-000000000011";
const ACTOR_B = "fa100000-0000-4000-8000-000000000012";
const ROOM_A = "fa100000-0000-4000-8000-000000000021";
const ROOM_B = "fa100000-0000-4000-8000-000000000022";
const MAIL_THREAD = "fa100000-0000-4000-8000-000000000023";
const MESSAGE_A = "fa100000-0000-4000-8000-000000000031";
const actorA: Actor = { id: ACTOR_A, orgId: ORG_A, type: "user", displayName: "Actor A" };
const actorB: Actor = { id: ACTOR_B, orgId: ORG_B, type: "user", displayName: "Actor B" };

describe("Chat grant validity", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let store: PostgresChatStore;

  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false });
    store = new PostgresChatStore(sql);
    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name)
      values
        (${ORG_A}, 'chat-grant-validity-a', 'Chat Grant A'),
        (${ORG_B}, 'chat-grant-validity-b', 'Chat Grant B')
    `;
    await sql`
      insert into actors (id, org_id, type, display_name)
      values
        (${ACTOR_A}, ${ORG_A}, 'user', 'Actor A'),
        (${ACTOR_B}, ${ORG_B}, 'user', 'Actor B')
    `;
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values
        (${ROOM_A}, ${ORG_A}, 'chat_room', 'Room A', ${ACTOR_A}),
        (${ROOM_B}, ${ORG_B}, 'chat_room', 'Room B', ${ACTOR_B}),
        (${MAIL_THREAD}, ${ORG_A}, 'mail', 'Mail', ${ACTOR_A})
    `;
    await sql`
      insert into chat_room_settings (thread_id, org_id, name)
      values (${ROOM_A}, ${ORG_A}, 'Room A'), (${ROOM_B}, ${ORG_B}, 'Room B')
    `;
    await sql`
      insert into messages (id, org_id, thread_id, actor_id, kind, body)
      values (${MESSAGE_A}, ${ORG_A}, ${ROOM_A}, ${ACTOR_A}, 'chat', 'known secret')
    `;
  });

  afterAll(async () => {
    await cleanup(sql);
    await sql.end();
  });

  it("accepts a current, tenant-correct Chat grant", async () => {
    await installGrant(sql, "valid");

    await expect(
      store.getRoomForActor({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
    ).resolves.toMatchObject({ id: ROOM_A });
    await expect(
      store.listMessages({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
    ).resolves.toEqual([expect.objectContaining({ id: MESSAGE_A })]);
    await expect(store.search({ orgId: ORG_A, actorId: ACTOR_A, query: "known" })).resolves.toEqual(
      [expect.objectContaining({ messageId: MESSAGE_A })],
    );
  });

  it("paginates equal-timestamp messages completely without duplicates", async () => {
    await installGrant(sql, "valid");
    const timestamp = new Date("2030-01-01T00:00:00.000Z");
    const ids = {
      newest: "fa100000-0000-4000-8000-000000000044",
      cursor: "fa100000-0000-4000-8000-000000000043",
      concurrent: "fa100000-0000-4000-8000-000000000042",
      oldest: "fa100000-0000-4000-8000-000000000041",
    } as const;
    try {
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, sent_at)
        values
          (${ids.newest}, ${ORG_A}, ${ROOM_A}, ${ACTOR_A}, 'chat', 'same 44', ${timestamp}),
          (${ids.cursor}, ${ORG_A}, ${ROOM_A}, ${ACTOR_A}, 'chat', 'same 43', ${timestamp}),
          (${ids.oldest}, ${ORG_A}, ${ROOM_A}, ${ACTOR_A}, 'chat', 'same 41', ${timestamp})
      `;

      const first = await store.listMessages({
        orgId: ORG_A,
        actorId: ACTOR_A,
        roomId: ROOM_A,
        limit: 2,
      });
      const oldest = first.at(-1);
      if (oldest === undefined) throw new Error("Expected first page.");
      await sql`delete from messages where id = ${ids.cursor}`;
      await sql`
        insert into messages (id, org_id, thread_id, actor_id, kind, body, sent_at)
        values (${ids.concurrent}, ${ORG_A}, ${ROOM_A}, ${ACTOR_A}, 'chat', 'same 42', ${timestamp})
      `;
      const second = await store.listMessages({
        orgId: ORG_A,
        actorId: ACTOR_A,
        roomId: ROOM_A,
        before: { sentAt: oldest.sentAt, id: oldest.id },
        limit: 2,
      });

      expect(first.map(({ id }) => id)).toEqual([ids.newest, ids.cursor]);
      expect(second.map(({ id }) => id)).toEqual([ids.concurrent, ids.oldest]);
      expect(new Set([...first, ...second].map(({ id }) => id)).size).toBe(
        first.length + second.length,
      );
      await expect(
        store.listMessages({
          orgId: ORG_A,
          actorId: ACTOR_A,
          roomId: ROOM_A,
          before: { sentAt: timestamp, id: ids.oldest },
          direction: "newer",
          limit: 3,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ id: ids.concurrent }),
        expect.objectContaining({ id: ids.newest }),
      ]);
    } finally {
      await sql`delete from messages where id in ${sql(Object.values(ids))}`;
    }
  });

  it.each(["expired", "future", "revoked"] as const)(
    "denies every known-id and discovery path for a %s grant",
    async (mode) => {
      await installGrant(sql, mode);

      await expect(
        store.getRoomForActor({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
      ).resolves.toBeNull();
      await expect(store.listRooms({ orgId: ORG_A, actorId: ACTOR_A })).resolves.toEqual([]);
      await expect(
        store.search({ orgId: ORG_A, actorId: ACTOR_A, query: "known", roomId: ROOM_A }),
      ).resolves.toEqual([]);
      await expect(
        store.listMessages({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(
        store.listThreadReplies({
          orgId: ORG_A,
          actorId: ACTOR_A,
          roomId: ROOM_A,
          parentMessageId: MESSAGE_A,
        }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(
        store.listPins({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(
        store.sendMessage({
          orgId: ORG_A,
          actorId: ACTOR_A,
          roomId: ROOM_A,
          body: "must not write",
        }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(
        store.editMessage({
          orgId: ORG_A,
          actorId: ACTOR_A,
          messageId: MESSAGE_A,
          body: "must not edit",
        }),
      ).resolves.toBeNull();
      await expect(
        store.deleteMessage({ orgId: ORG_A, actorId: ACTOR_A, messageId: MESSAGE_A }),
      ).resolves.toBeNull();
      await expect(
        store.pinMessage({
          orgId: ORG_A,
          actorId: ACTOR_A,
          roomId: ROOM_A,
          messageId: MESSAGE_A,
        }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(
        store.unpinMessage({
          orgId: ORG_A,
          actorId: ACTOR_A,
          roomId: ROOM_A,
          messageId: MESSAGE_A,
        }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(
        store.react({
          orgId: ORG_A,
          actorId: ACTOR_A,
          messageId: MESSAGE_A,
          emoji: "x",
          op: "add",
        }),
      ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
      await expect(
        store.markRead({
          orgId: ORG_A,
          actorId: ACTOR_A,
          roomId: ROOM_A,
          messageId: MESSAGE_A,
        }),
      ).rejects.toBeInstanceOf(ChatMessageNotFoundError);
      await expect(
        store.listReadReceipts({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(
        store.invite({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A, actorIds: [] }),
      ).rejects.toBeInstanceOf(ChatRoomAccessError);
      await expect(realtimeClose(store, actorA)).resolves.toEqual({
        code: 1008,
        reason: "access denied",
      });
    },
  );

  it("rejects foreign subjects, objects, and grantors before they can authorize known IDs", async () => {
    await sql`delete from permissions where resource_id in (${ROOM_A}, ${ROOM_B})`;
    const insert = (orgId: string, actorId: string, roomId: string, grantorId: string) => sql`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${orgId}, ${actorId}, 'thread', ${roomId}, 'member', ${grantorId})
    `;

    await expect(insert(ORG_A, ACTOR_B, ROOM_A, ACTOR_A)).rejects.toMatchObject({ code: "23503" });
    await expect(insert(ORG_A, ACTOR_A, ROOM_B, ACTOR_A)).rejects.toMatchObject({ code: "23503" });
    await expect(insert(ORG_A, ACTOR_A, ROOM_A, ACTOR_B)).rejects.toMatchObject({ code: "23503" });
    await expect(
      store.listMessages({ orgId: ORG_A, actorId: ACTOR_B, roomId: ROOM_A }),
    ).rejects.toBeInstanceOf(ChatRoomAccessError);
    await expect(realtimeClose(store, actorB, ROOM_A)).resolves.toEqual({
      code: 1008,
      reason: "access denied",
    });
  });

  it("requires the exact Chat resource scope without hijacking non-Chat thread roles", async () => {
    await sql`delete from permissions where actor_id = ${ACTOR_A}`;
    await expect(sql`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${ORG_A}, ${ACTOR_A}, 'object', ${ROOM_A}, 'owner', ${ACTOR_A})
    `).rejects.toBeDefined();
    await expect(
      store.getRoomForActor({ orgId: ORG_A, actorId: ACTOR_A, roomId: ROOM_A }),
    ).resolves.toBeNull();

    await expect(sql`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${ORG_A}, ${ACTOR_A}, 'thread', ${ROOM_A}, 'reader', ${ACTOR_A})
    `).rejects.toMatchObject({ code: "23514" });
    await expect(sql`
      insert into permissions (org_id, actor_id, resource_type, resource_id, role)
      values (${ORG_A}, ${ACTOR_A}, 'thread', ${MAIL_THREAD}, 'reader')
      returning id
    `).resolves.toHaveLength(1);
  });
});

type GrantMode = "valid" | "expired" | "future" | "revoked";

async function installGrant(sql: postgres.Sql, mode: GrantMode): Promise<void> {
  const now = Date.now();
  const revoked = mode === "revoked";
  await sql`delete from permissions where resource_id = ${ROOM_A}`;
  await sql`
    insert into permissions (
      org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id,
      status, valid_from, expires_at, revoked_at, revocation_epoch
    ) values (
      ${ORG_A},
      ${ACTOR_A},
      'thread',
      ${ROOM_A},
      'owner',
      ${ACTOR_A},
      ${revoked ? "revoked" : "active"},
      ${new Date(mode === "future" ? now + 60_000 : now - 120_000)},
      ${mode === "expired" ? new Date(now - 60_000) : null},
      ${revoked ? new Date(now - 30_000) : null},
      ${revoked ? 1 : 0}
    )
  `;
}

async function realtimeClose(
  store: PostgresChatStore,
  actor: Actor,
  roomId = ROOM_A,
): Promise<{ readonly code?: number; readonly reason?: string } | null> {
  const socket = new RecordingSocket();
  await handleChatSocket(
    socket,
    {
      headers: { "sec-websocket-protocol": `helix.chat.v1, helix.ticket.${"t".repeat(43)}` },
    } as unknown as FastifyRequest,
    {
      store,
      tickets: new BoundTicketStore(actor, roomId),
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore(),
    },
  );
  return socket.closed;
}

class BoundTicketStore implements ChatWebSocketTicketStore {
  constructor(
    private readonly actor: Actor,
    private readonly roomId: string,
  ) {}

  async issue(): Promise<{ readonly ticket: string; readonly expiresAt: Date }> {
    return { ticket: "t".repeat(43), expiresAt: new Date(Date.now() + 30_000) };
  }

  async consume(input: {
    readonly audience: string;
    readonly path: string;
  }): Promise<{ readonly actor: Actor; readonly roomId: string } | null> {
    return input.audience === CHAT_WEBSOCKET_AUDIENCE && input.path === CHAT_WEBSOCKET_PATH
      ? { actor: this.actor, roomId: this.roomId }
      : null;
  }
}

class RecordingSocket {
  closed: { readonly code?: number; readonly reason?: string } | null = null;

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  on(): void {}
}

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from chat_read_receipts where thread_id in (${ROOM_A}, ${ROOM_B})`;
  await sql`delete from chat_reactions where message_id = ${MESSAGE_A}`;
  await sql`delete from chat_pins where thread_id in (${ROOM_A}, ${ROOM_B})`;
  await sql`delete from messages where id = ${MESSAGE_A}`;
  await sql`delete from permissions where resource_id in (${ROOM_A}, ${ROOM_B}, ${MAIL_THREAD})`;
  await sql`delete from chat_room_settings where thread_id in (${ROOM_A}, ${ROOM_B})`;
  await sql`delete from threads where id in (${ROOM_A}, ${ROOM_B}, ${MAIL_THREAD})`;
  await sql`delete from actors where id in (${ACTOR_A}, ${ACTOR_B})`;
  await sql`delete from orgs where id in (${ORG_A}, ${ORG_B})`;
}
