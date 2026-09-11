import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import { AsyncResource } from "node:async_hooks";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboxWorker } from "../outbox/outbox.js";
import { PostgresOutboxStore } from "../outbox/postgres-store.js";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { createToolRegistry } from "../tool-registry.js";
import { PostgresChatRoomEventLog } from "./realtime-event-store.js";
import { EventBusChatRoomBus, InMemoryChatPresenceStore, roomSubject } from "./realtime.js";
import { handleChatSocket } from "./routes.js";
import { PostgresChatStore } from "./store.js";
import { registerChatTools } from "./tools.js";
import {
  CHAT_WEBSOCKET_AUDIENCE,
  CHAT_WEBSOCKET_PATH,
  type ChatWebSocketTicketStore,
} from "./websocket-tickets.js";

const ORG = "fc100000-0000-4000-8000-000000000001";
const FOREIGN_ORG = "fc100000-0000-4000-8000-000000000002";
const OWNER = "fc100000-0000-4000-8000-000000000011";
const ROOM = "fc100000-0000-4000-8000-000000000021";
const EMAIL = "chat-realtime-events@helix.test";
const APP_ROLE = "helix_chat_0708_app";
const APP_PASSWORD = "helix_chat_0708_password";

describe("Chat durable realtime events", { skip: process.env.DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let appSql: postgres.Sql;
  let events: PostgresChatRoomEventLog;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(databaseUrl, { max: 12, prepare: false });
    events = new PostgresChatRoomEventLog(sql);
    await cleanup(sql);
    await sql`
      insert into orgs (id, slug, display_name)
      values
        (${ORG}, 'chat-realtime-events', 'Chat Events'),
        (${FOREIGN_ORG}, 'chat-realtime-events-foreign', 'Chat Events Foreign')
    `;
    await sql`
      insert into actors (id, org_id, type, email, display_name)
      values (${OWNER}, ${ORG}, 'user', ${EMAIL}, 'Realtime Owner')
    `;
    await sql`
      insert into threads (id, org_id, kind, subject, created_by_actor_id)
      values (${ROOM}, ${ORG}, 'chat_room', 'Realtime', ${OWNER})
    `;
    await sql`
      insert into chat_room_settings (thread_id, org_id, name)
      values (${ROOM}, ${ORG}, 'Realtime')
    `;
    await sql`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${ORG}, ${OWNER}, 'thread', ${ROOM}, 'owner', ${OWNER})
    `;
    await dropAppRole(sql);
    await sql.unsafe(`
      create role ${APP_ROLE}
        login password '${APP_PASSWORD}' nosuperuser nobypassrls noinherit;
      grant usage on schema public to ${APP_ROLE};
      grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
      grant usage, select, update on all sequences in schema public to ${APP_ROLE};
      grant execute on all functions in schema public to ${APP_ROLE};
    `);
    const appUrl = new URL(databaseUrl);
    appUrl.username = APP_ROLE;
    appUrl.password = APP_PASSWORD;
    appSql = tenantAwarePostgresSql(postgres(appUrl.toString(), { max: 4, prepare: false }));
  });

  afterAll(async () => {
    await appSql.end();
    await cleanup(sql);
    await dropAppRole(sql);
    await sql.end();
  });

  it("allocates one strictly ordered cursor under concurrent publishers", async () => {
    const before = await currentCursor(sql);
    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        events.append({
          type: "message.created",
          orgId: ORG,
          roomId: ROOM,
          actorId: OWNER,
          message: { id: `concurrent-${String(index)}` },
        }),
      ),
    );
    const cursors = appended.map((event) => event.cursor).sort((left, right) => left - right);
    expect(cursors).toEqual(Array.from({ length: 20 }, (_, index) => before + index + 1));

    const replay = await events.replay({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      after: before,
      limit: 100,
    });
    expect(replay.authorized).toBe(true);
    expect(replay.events.map((event) => event.cursor)).toEqual(cursors);
    expect(replay.hasMore).toBe(false);
  });

  it("does not disclose a known room cursor or events to another tenant", async () => {
    await expect(
      events.replay({
        orgId: FOREIGN_ORG,
        actorId: OWNER,
        roomId: ROOM,
        after: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({ authorized: false, events: [] });
  });

  it("commits message and read mutations with one replayable cursor", async () => {
    const store = new PostgresChatStore(sql);
    const before = await currentCursor(sql);
    const message = await store.sendMessage({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      body: "atomic realtime event",
      clientMessageId: "chat-0708-atomic",
    });
    expect(message.realtimeCursor).toBe(before + 1);

    const retry = await store.sendMessage({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      body: "ignored retry",
      clientMessageId: "chat-0708-atomic",
    });
    expect(retry).toMatchObject({ id: message.id, realtimeCursor: before + 1 });
    expect(await currentCursor(sql)).toBe(before + 1);

    const receipt = await store.markRead({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      messageId: message.id,
    });
    expect(receipt.realtimeCursor).toBe(before + 2);
    await expect(
      store.markRead({ orgId: ORG, actorId: OWNER, roomId: ROOM, messageId: message.id }),
    ).resolves.toMatchObject({ realtimeCursor: null });
    expect(await currentCursor(sql)).toBe(before + 2);

    const replay = await events.replay({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      after: before,
      limit: 10,
    });
    expect(replay.events).toEqual([
      expect.objectContaining({
        type: "message.created",
        cursor: before + 1,
        message: expect.objectContaining({ id: message.id, body: "atomic realtime event" }),
      }),
      expect.objectContaining({ type: "read", cursor: before + 2, messageId: message.id }),
    ]);

    await sql`
      delete from chat_room_events
      where org_id = ${ORG} and room_id = ${ROOM} and sequence <= ${before + 1}
    `;
    await expect(
      events.replay({ orgId: ORG, actorId: OWNER, roomId: ROOM, after: before, limit: 10 }),
    ).resolves.toMatchObject({ resetRequired: true, events: [], latestCursor: before + 2 });
  });

  it("uses one complete projection for history and every durable message transition", async () => {
    const store = new PostgresChatStore(sql);
    const events = new PostgresChatRoomEventLog(sql);
    const before = await currentCursor(sql);
    const root = await store.sendMessage({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      body: "projection root",
      clientMessageId: "chat-projection-root",
    });
    await store.react({
      orgId: ORG,
      actorId: OWNER,
      messageId: root.id,
      emoji: "👍",
      op: "add",
    });
    await store.pinMessage({ orgId: ORG, actorId: OWNER, roomId: ROOM, messageId: root.id });
    const reply = await store.sendMessage({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      parentMessageId: root.id,
      body: "projection reply",
      clientMessageId: "chat-projection-reply",
    });
    await store.editMessage({
      orgId: ORG,
      actorId: OWNER,
      messageId: root.id,
      body: "projection root edited",
    });

    const history = await store.listMessages({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      limit: 100,
    });
    expect(history.find(({ id }) => id === root.id)).toMatchObject({
      body: "projection root edited",
      replyCount: 1,
      reactions: [expect.objectContaining({ actorId: OWNER, emoji: "👍" })],
      pin: expect.objectContaining({ pinnedByActorId: OWNER }),
    });

    const firstClient = await events.replay({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      after: before,
      limit: 100,
    });
    const secondClient = await events.replay({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      after: before,
      limit: 100,
    });
    expect(secondClient.events).toEqual(firstClient.events);
    expect(firstClient.events.map(({ type }) => type)).toEqual([
      "message.created",
      "message.updated",
      "message.updated",
      "message.created",
      "message.updated",
      "message.updated",
    ]);
    expect(firstClient.events.at(-1)).toMatchObject({
      message: {
        id: root.id,
        body: "projection root edited",
        replyCount: 1,
        reactions: [expect.objectContaining({ emoji: "👍" })],
        pin: expect.objectContaining({ messageId: root.id }),
      },
    });

    await store.deleteMessage({ orgId: ORG, actorId: OWNER, messageId: root.id });
    const tombstone = await events.replay({
      orgId: ORG,
      actorId: OWNER,
      roomId: ROOM,
      after: firstClient.latestCursor,
      limit: 10,
    });
    expect(tombstone.events).toEqual([
      expect.objectContaining({ type: "message.deleted", messageId: root.id }),
    ]);
    expect(reply.parentMessageId).toBe(root.id);
  });

  it("fans REST sends and reactions to two clients without appending duplicate events", async () => {
    await sql`delete from outbox where subject = ${roomSubject(ORG, ROOM)}`;
    const transport = new InMemoryEventBus();
    const eventLog = new PostgresChatRoomEventLog(sql);
    const publisher = new EventBusChatRoomBus(transport, { events: eventLog });
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    const subscriberA = new EventBusChatRoomBus(transport, { events: eventLog });
    const subscriberB = new EventBusChatRoomBus(transport, { events: eventLog });
    await subscriberA.subscribe(ORG, ROOM, async (event) => {
      receivedA.push(event);
    });
    await subscriberB.subscribe(ORG, ROOM, async (event) => {
      receivedB.push(event);
    });
    const registry = createToolRegistry();
    registerChatTools(registry, { store: new PostgresChatStore(sql), bus: publisher });
    const context = { actor: { ...ownerActor, scopes: ["chat.post"] } };
    const before = await currentCursor(sql);

    const sent = await registry.invoke(
      "chat.send",
      { roomId: ROOM, body: "REST fanout", clientMessageId: "chat-rest-fanout" },
      context,
    );
    const sentMessageId = sent.ok ? (sent.output as { readonly id?: unknown }).id : undefined;
    if (typeof sentMessageId !== "string") throw new Error("REST send failed.");
    await registry.invoke(
      "chat.react",
      { messageId: sentMessageId, emoji: "👍", op: "add" },
      context,
    );

    expect(await currentCursor(sql)).toBe(before + 2);
    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual([]);
    await new OutboxWorker({ store: new PostgresOutboxStore(sql), events: transport }).drainOnce();
    for (const received of [receivedA, receivedB]) {
      expect(received).toHaveLength(2);
      expect(received).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "message.created", cursor: before + 1 }),
          expect.objectContaining({
            type: "message.updated",
            cursor: before + 2,
            message: expect.objectContaining({
              id: sentMessageId,
              reactions: [expect.objectContaining({ actorId: OWNER, emoji: "👍" })],
            }),
          }),
        ]),
      );
    }
  });

  it("durably emits ACL events for revocation and principal suspension", async () => {
    await sql`delete from outbox where subject = ${roomSubject(ORG, ROOM)}`;
    const transport = new InMemoryEventBus();
    const replica = new EventBusChatRoomBus(transport, {
      events: new PostgresChatRoomEventLog(appSql),
    });
    const socket = new IntegrationSocket();
    await expect(appSql`select id from threads where id = ${ROOM}`).resolves.toEqual([]);
    const subscribeAt = await currentCursor(sql);
    let socketResource: AsyncResource | undefined;
    await withTenantPostgresContext(appSql, { orgId: ORG, actorId: OWNER }, async () => {
      socketResource = new AsyncResource("chat-stale-request-context");
      await handleChatSocket(socket, ticketRequest(), {
        store: new PostgresChatStore(appSql),
        tickets: new IntegrationTicketStore(),
        bus: replica,
        presence: new InMemoryChatPresenceStore(),
        trustedOrigins: [],
      });
    });
    socketResource?.runInAsyncScope(() => {
      socket.receive({ type: "subscribe", roomId: ROOM, cursor: subscribeAt });
    });
    await expect
      .poll(() => socket.messages, { timeout: 2_000 })
      .toContainEqual(expect.objectContaining({ type: "subscribed" }));
    socketResource?.runInAsyncScope(() => {
      socket.receive({
        type: "send",
        roomId: ROOM,
        body: "post-upgrade transaction",
        clientMessageId: "chat-0708-post-upgrade",
      });
    });
    await expect.poll(() => currentCursor(sql)).toBeGreaterThan(subscribeAt);
    await new OutboxWorker({ store: new PostgresOutboxStore(sql), events: transport }).drainOnce();
    await expect
      .poll(() => socket.messages, { timeout: 2_000 })
      .toContainEqual(
        expect.objectContaining({
          type: "message.created",
          message: expect.objectContaining({ body: "post-upgrade transaction" }),
        }),
      );
    socketResource?.emitDestroy();

    const beforeRevoke = await currentCursor(sql);
    await sql`
      update permissions
      set status = 'revoked', revoked_at = now(), revocation_epoch = 1
      where org_id = ${ORG} and actor_id = ${OWNER} and resource_id = ${ROOM}
    `;
    await expect(accessEventsAfter(sql, beforeRevoke)).resolves.toEqual([
      expect.objectContaining({ actorId: OWNER, cursor: beforeRevoke + 1 }),
    ]);
    const revokeOutbox = await sql`
      select subject, payload from outbox
      where subject = ${roomSubject(ORG, ROOM)}
        and (payload->>'cursor')::bigint = ${beforeRevoke + 1}
    `;
    await transport.publish(String(revokeOutbox[0]?.subject), revokeOutbox[0]?.payload);
    await expect.poll(() => socket.closed).toEqual({ code: 1008, reason: "access denied" });

    await sql`
      update permissions
      set status = 'active', revoked_at = null, revocation_epoch = 0
      where org_id = ${ORG} and actor_id = ${OWNER} and resource_id = ${ROOM}
    `;
    const beforeActorSuspend = await currentCursor(sql);
    await sql`update actors set disabled_at = now() where org_id = ${ORG} and id = ${OWNER}`;
    await expect(accessEventsAfter(sql, beforeActorSuspend)).resolves.toEqual([
      expect.objectContaining({ actorId: OWNER, cursor: beforeActorSuspend + 1 }),
    ]);

    await sql`update actors set disabled_at = null where org_id = ${ORG} and id = ${OWNER}`;
    const beforeMembershipSuspend = await currentCursor(sql);
    await sql`
      update organization_memberships
      set status = 'suspended', suspended_at = now()
      where org_id = ${ORG} and actor_id = ${OWNER}
    `;
    await expect(accessEventsAfter(sql, beforeMembershipSuspend)).resolves.toEqual([
      expect.objectContaining({ actorId: OWNER, cursor: beforeMembershipSuspend + 1 }),
    ]);
    await expect(
      events.replay({ orgId: ORG, actorId: OWNER, roomId: ROOM, after: 0, limit: 1 }),
    ).resolves.toMatchObject({ authorized: false, events: [] });

    await sql`
      update organization_memberships
      set status = 'active', suspended_at = null
      where org_id = ${ORG} and actor_id = ${OWNER}
    `;
    const identityRows = await sql`
      select subject_id from organization_memberships
      where org_id = ${ORG} and actor_id = ${OWNER}
    `;
    const beforeIdentitySuspend = await currentCursor(sql);
    await sql`
      update identity_subjects set status = 'suspended'
      where id = ${identityRows[0]?.subject_id}
    `;
    await expect(accessEventsAfter(sql, beforeIdentitySuspend)).resolves.toEqual([
      expect.objectContaining({ actorId: OWNER, cursor: beforeIdentitySuspend + 1 }),
    ]);

    const outboxRows = await sql`
      select payload
      from outbox
      where subject = ${roomSubject(ORG, ROOM)}
        and (payload->>'cursor')::bigint > ${beforeRevoke}
      order by (payload->>'cursor')::bigint
    `;
    expect(outboxRows.length).toBeGreaterThanOrEqual(7);
    expect(outboxRows.every((row) => row.payload.type === "access.changed")).toBe(true);
  });
});

const ownerActor: Actor = {
  id: OWNER,
  orgId: ORG,
  type: "user",
  email: EMAIL,
  displayName: "Realtime Owner",
};

class IntegrationTicketStore implements ChatWebSocketTicketStore {
  async issue(): Promise<{ readonly ticket: string; readonly expiresAt: Date }> {
    return { ticket: "t".repeat(43), expiresAt: new Date(Date.now() + 30_000) };
  }

  async consume(
    input: Parameters<ChatWebSocketTicketStore["consume"]>[0],
  ): Promise<{ readonly actor: Actor; readonly roomId: string } | null> {
    return input.audience === CHAT_WEBSOCKET_AUDIENCE && input.path === CHAT_WEBSOCKET_PATH
      ? { actor: ownerActor, roomId: ROOM }
      : null;
  }
}

class IntegrationSocket {
  closed: { readonly code?: number; readonly reason?: string } | null = null;
  readonly messages: Record<string, unknown>[] = [];
  readonly #messageHandlers: ((value: Buffer | ArrayBuffer | string) => void)[] = [];
  readonly #closeHandlers: (() => void)[] = [];
  readonly #errorHandlers: ((error: Error) => void)[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    for (const handler of this.#closeHandlers) handler();
  }

  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(
    event: "message" | "close" | "error",
    handler:
      ((data: Buffer | ArrayBuffer | string) => void) | (() => void) | ((error: Error) => void),
  ): void {
    if (event === "message") {
      this.#messageHandlers.push(handler as (data: Buffer | ArrayBuffer | string) => void);
    } else if (event === "close") {
      this.#closeHandlers.push(handler as () => void);
    } else {
      this.#errorHandlers.push(handler as (error: Error) => void);
    }
  }

  receive(payload: unknown): void {
    for (const handler of this.#messageHandlers) {
      handler(JSON.stringify(payload));
    }
  }
}

function ticketRequest(): FastifyRequest {
  return {
    tenant: { orgId: ORG },
    headers: {
      "sec-websocket-protocol": `helix.chat.v1, helix.ticket.${"t".repeat(43)}`,
    },
  } as unknown as FastifyRequest;
}

async function currentCursor(sql: postgres.Sql): Promise<number> {
  const rows = await sql`
    select next_event_sequence from chat_room_settings
    where org_id = ${ORG} and thread_id = ${ROOM}
  `;
  return Number(rows[0]?.next_event_sequence ?? 0);
}

async function accessEventsAfter(sql: postgres.Sql, cursor: number): Promise<unknown[]> {
  const rows = await sql`
    select event
    from chat_room_events
    where org_id = ${ORG} and room_id = ${ROOM} and sequence > ${cursor}
    order by sequence
  `;
  return rows.map((row) => row.event);
}

async function cleanup(sql: postgres.Sql): Promise<void> {
  await sql`delete from outbox where payload->>'orgId' in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from chat_read_receipts where thread_id = ${ROOM}`;
  await sql`delete from messages where thread_id = ${ROOM}`;
  await sql`delete from permissions where actor_id = ${OWNER} or resource_id = ${ROOM}`;
  await sql`delete from threads where id = ${ROOM}`;
  await sql`delete from organization_memberships where actor_id = ${OWNER}`;
  await sql`delete from activity where org_id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from actors where id = ${OWNER}`;
  await sql`delete from orgs where id in (${ORG}, ${FOREIGN_ORG})`;
  await sql`delete from identity_subjects where canonical_email = ${EMAIL}`;
}

async function dropAppRole(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ readonly exists: boolean }[]>`
    select exists (select 1 from pg_roles where rolname = ${APP_ROLE}) as exists
  `;
  if (rows[0]?.exists !== true) return;
  await sql.unsafe(`drop owned by ${APP_ROLE}`);
  await sql.unsafe(`drop role ${APP_ROLE}`);
}
