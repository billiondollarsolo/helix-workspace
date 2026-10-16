import {
  actor,
  otherActor,
  roomId,
  messageId,
  trustedOrigins,
  emptyWebSocketRequest,
  ticketRequest,
  FakeSocket,
  FakeTicketStore,
  FakeChatStore,
  BlockingChatStore,
  PresencePrivacyChatStore,
  PresenceRecordingRoomBus,
} from "../../test-support/chat-realtime.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { unauthenticatedActor } from "../../api/actor.js";
import { UnauthorizedError } from "../../api/api-error.js";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { ChatRoomAccessError } from "./errors.js";
import {
  EventBusChatRoomBus,
  InMemoryChatPresenceStore,
  InMemoryChatRoomBus,
  InMemoryChatRoomEventLog,
  roomSubject,
} from "./realtime.js";
import { handleChatSocket, registerChatRoutes } from "./routes.js";
import { chatWebSocketTicketFromProtocols } from "./websocket-tickets.js";

describe("chat realtime", () => {
  it("builds stable per-room subjects for the NATS abstraction", () => {
    expect(roomSubject(actor.orgId, roomId)).toBe(`chat.org.${actor.orgId}.room.${roomId}.events`);
    expect(roomSubject("org.with.dots", "room.with.dots")).toBe(
      "chat.org.org_with_dots.room.room_with_dots.events",
    );
  });

  it("rejects an unauthenticated upgrade before accepting frames", async () => {
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(null),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: "error", code: "unauthenticated" }),
    );
    expect(socket.closed).toEqual({ code: 4401, reason: "auth required" });
  });

  it("rejects a replayed ticket and bearer-style websocket protocols", async () => {
    const tickets = new FakeTicketStore(actor);
    const first = new FakeSocket();
    const replay = new FakeSocket();
    const options = {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets,
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    };

    await handleChatSocket(first, emptyWebSocketRequest, options);
    await handleChatSocket(replay, emptyWebSocketRequest, options);

    expect(first.messages).toContainEqual(expect.objectContaining({ type: "ready" }));
    expect(replay.closed).toEqual({ code: 4401, reason: "auth required" });
    expect(chatWebSocketTicketFromProtocols("helix-bearer, a-very-long-access-token")).toBeNull();
  });

  it("limits aggregate member connections instead of letting tabs multiply the quota", async () => {
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    const first = new FakeSocket();
    const second = new FakeSocket();
    const options = {
      store: new FakeChatStore(),
      bus: new InMemoryChatRoomBus(),
      presence,
      maxConnectionsPerMember: 1,
    };
    await handleChatSocket(first, emptyWebSocketRequest, {
      ...options,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
    });
    await handleChatSocket(second, emptyWebSocketRequest, {
      ...options,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
    });
    expect(first.messages).toContainEqual(expect.objectContaining({ type: "ready" }));
    expect(second.closed).toEqual({ code: 1008, reason: "connection limit exceeded" });

    first.close();
    await settle();
    const replacement = new FakeSocket();
    await handleChatSocket(replacement, emptyWebSocketRequest, {
      ...options,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
    });
    expect(replacement.messages).toContainEqual(expect.objectContaining({ type: "ready" }));
  });

  it("confines every room-bearing frame to the ticket room", async () => {
    const socket = new FakeSocket();
    const store = new FakeChatStore();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    socket.receive({
      type: "send",
      roomId: "99999999-9999-4999-8999-999999999999",
      body: "cross-room",
    });
    await settle();

    expect(store.sentBodies).toEqual([]);
    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: "error", code: "forbidden" }),
    );
  });

  it("handles subscribe, typing, send, and read websocket messages", async () => {
    const socket = new FakeSocket();
    const bus = new InMemoryChatRoomBus();
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    const store = new FakeChatStore();

    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus,
      presence,
    });

    socket.receive({ type: "subscribe", roomId });
    await settle();
    socket.receive({ type: "typing", roomId, isTyping: true });
    await settle();
    socket.receive({ type: "send", roomId, body: "hello" });
    await settle();
    socket.receive({ type: "read", roomId, messageId });
    await settle();

    expect(store.sentBodies).toEqual(["hello"]);
    expect(store.readMessageIds).toEqual([messageId]);
    expect(socket.messages.map((message) => message.type)).toContain("ready");
    expect(socket.messages.map((message) => message.type)).toContain("subscribed");
    expect(socket.messages.map((message) => message.type)).toContain("typing");
    expect(socket.messages.map((message) => message.type)).toContain("message.created");
    expect(socket.messages.map((message) => message.type)).toContain("read");
    expect(await presence.list(roomId)).toHaveLength(1);
  });

  it("fans out websocket room events to another subscribed socket", async () => {
    const senderSocket = new FakeSocket();
    const receiverSocket = new FakeSocket();
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    const bus = new PresenceRecordingRoomBus(presence);
    const store = new FakeChatStore();

    await handleChatSocket(receiverSocket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(otherActor),
      actorFromRequest: () => otherActor,
      bus,
      presence,
    });
    receiverSocket.receive({ type: "subscribe", roomId });
    await settle();
    receiverSocket.messages.length = 0;

    await handleChatSocket(senderSocket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus,
      presence,
    });
    senderSocket.receive({ type: "subscribe", roomId });
    await settle();

    expect(receiverSocket.messages).toContainEqual(
      expect.objectContaining({ type: "presence.joined", roomId, actorId: actor.id }),
    );
    receiverSocket.messages.length = 0;

    senderSocket.receive({ type: "typing", roomId, isTyping: true });
    await settle();
    expect(receiverSocket.messages).toContainEqual(
      expect.objectContaining({ type: "typing", roomId, actorId: actor.id, isTyping: true }),
    );
    receiverSocket.messages.length = 0;

    senderSocket.receive({ type: "send", roomId, body: "hello" });
    await settle();
    expect(receiverSocket.messages).toContainEqual(
      expect.objectContaining({ type: "message.created", roomId, actorId: actor.id }),
    );
    receiverSocket.messages.length = 0;

    await presence.remove({ roomId, actorId: actor.id });
    senderSocket.receive({ type: "read", roomId, messageId });
    await settle();
    expect(receiverSocket.messages).toContainEqual(
      expect.objectContaining({ type: "read", roomId, actorId: actor.id }),
    );
    expect(bus.readRostersAtPublish.at(-1)?.map((entry) => entry.actorId)).toContain(actor.id);
    receiverSocket.messages.length = 0;

    senderSocket.close();
    await settle();
    expect(receiverSocket.messages).toContainEqual(
      expect.objectContaining({ type: "presence.left", roomId, actorId: actor.id }),
    );
  });

  it("hydrates existing read receipts in the subscribed event", async () => {
    const store = new FakeChatStore();
    await store.markRead({ orgId: actor.orgId, actorId: otherActor.id, roomId, messageId });

    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    socket.receive({ type: "subscribe", roomId });
    await settle();

    const subscribed = socket.messages.find((message) => message.type === "subscribed");
    expect(subscribed).toBeDefined();
    expect(subscribed?.receipts).toEqual([
      expect.objectContaining({ actorId: otherActor.id, lastReadMessageId: messageId }),
    ]);
  });

  it("keeps read progress private when room receipt sharing is disabled", async () => {
    const store = new FakeChatStore({ shareReadReceipts: false });
    await store.markRead({ orgId: actor.orgId, actorId: otherActor.id, roomId, messageId });
    const bus = new InMemoryChatRoomBus();
    const receiverSocket = new FakeSocket();
    await handleChatSocket(receiverSocket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus,
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });
    receiverSocket.receive({ type: "subscribe", roomId });
    await settle();

    const subscribed = receiverSocket.messages.find((message) => message.type === "subscribed");
    expect(subscribed?.receipts).toEqual([]);
    receiverSocket.messages.length = 0;

    const senderSocket = new FakeSocket();
    await handleChatSocket(senderSocket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(otherActor),
      actorFromRequest: () => otherActor,
      bus,
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });
    senderSocket.receive({ type: "read", roomId, messageId });
    await settle();

    expect(store.readMessageIds).toContain(messageId);
    expect(receiverSocket.messages.some((message) => message.type === "read")).toBe(false);
  });

  it("rejects an inaccessible ticket room before accepting frames", async () => {
    const socket = new FakeSocket();
    const store = new FakeChatStore({ inaccessibleRoomIds: [roomId] });

    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    socket.receive({ type: "presence", roomId });
    await settle();

    expect(store.getRoomForActorCalls).toEqual([{ orgId: actor.orgId, actorId: actor.id, roomId }]);
    expect(socket.messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "forbidden",
        message: "Chat room access denied",
      }),
    );
  });

  it("revalidates grants before realtime fanout and closes a revoked subscriber", async () => {
    const socket = new FakeSocket();
    const store = new FakeChatStore();
    const bus = new InMemoryChatRoomBus();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus,
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });
    socket.receive({ type: "subscribe", roomId });
    await settle();
    socket.messages.length = 0;

    store.denyRoom(roomId);
    await bus.publish(actor.orgId, roomId, {
      type: "access.changed",
      roomId,
      orgId: actor.orgId,
      actorId: actor.id,
      aclVersion: 1,
    });

    expect(socket.messages).toEqual([
      expect.objectContaining({ type: "error", code: "forbidden" }),
    ]);
    expect(socket.closed).toEqual({ code: 1008, reason: "access denied" });
  });

  it("replays durable room events once in order from the requested cursor", async () => {
    const bus = new InMemoryChatRoomBus();
    for (const id of ["one", "two", "three"]) {
      await bus.publish(actor.orgId, roomId, {
        type: "message.created",
        roomId,
        orgId: actor.orgId,
        message: { id },
      });
    }

    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus,
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });
    socket.receive({ type: "subscribe", roomId, cursor: 1 });
    await settle();

    expect(
      socket.messages
        .filter((event) => event.type === "message.created")
        .map((event) => event.cursor),
    ).toEqual([2, 3]);
    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: "subscribed", roomId, cursor: 3 }),
    );
  });

  it("deduplicates direct and outbox delivery across replicas by cursor", async () => {
    const transport = new InMemoryEventBus();
    const events = new InMemoryChatRoomEventLog();
    const publisher = new EventBusChatRoomBus(transport, { events });
    const subscriber = new EventBusChatRoomBus(transport, { events });
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: subscriber,
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });
    socket.receive({ type: "subscribe", roomId });
    await settle();
    socket.messages.length = 0;

    const event = {
      type: "message.created",
      roomId,
      orgId: actor.orgId,
      message: { id: messageId },
    } as const;
    await publisher.publish(actor.orgId, roomId, event);
    await transport.publish(roomSubject(actor.orgId, roomId), { ...event, cursor: 1 });
    await settle();

    expect(socket.messages.filter((message) => message.type === "message.created")).toEqual([
      expect.objectContaining({ cursor: 1 }),
    ]);
  });

  it("records real fanout and replay outcomes without room or actor labels", async () => {
    const operationalEvents: { readonly operation: string; readonly status: string }[] = [];
    const units: number[] = [];
    const bus = new EventBusChatRoomBus(new InMemoryEventBus(), {
      events: new InMemoryChatRoomEventLog(),
      metrics: {
        recordOperationalEvent: (event) => operationalEvents.push(event),
        addOperationalUnits: (event) => units.push(event.value ?? 1),
      },
    });

    await bus.publish(actor.orgId, roomId, {
      type: "message.created",
      roomId,
      orgId: actor.orgId,
      message: { id: messageId },
    });
    await bus.replay({ orgId: actor.orgId, actorId: actor.id, roomId, after: 0, limit: 10 });

    expect(operationalEvents).toEqual([
      expect.objectContaining({ operation: "fanout", status: "success" }),
      expect.objectContaining({ operation: "replay", status: "success" }),
    ]);
    expect(units).toEqual([1]);
  });

  it("closes with an explicit resync signal when a cursor is ahead of retained history", async () => {
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });
    socket.receive({ type: "subscribe", roomId, cursor: 9 });
    await settle();

    expect(socket.messages).toContainEqual({ type: "resync.required", roomId, cursor: 0 });
    expect(socket.closed).toEqual({ code: 1012, reason: "chat history resync required" });
  });

  it("revokes an existing socket when an ACL event arrives from another replica", async () => {
    const transport = new InMemoryEventBus();
    const events = new InMemoryChatRoomEventLog();
    const publisher = new EventBusChatRoomBus(transport, { events });
    const subscriber = new EventBusChatRoomBus(transport, { events });
    const store = new FakeChatStore();
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: subscriber,
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });
    socket.receive({ type: "subscribe", roomId });
    await settle();
    socket.messages.length = 0;

    store.denyRoom(roomId);
    await publisher.publish(actor.orgId, roomId, {
      type: "access.changed",
      roomId,
      orgId: actor.orgId,
      actorId: actor.id,
      aclVersion: 1,
    });

    await expect
      .poll(() => socket.messages)
      .toEqual([expect.objectContaining({ type: "error", code: "forbidden" })]);
    expect(socket.closed).toEqual({ code: 1008, reason: "access denied" });
  });

  it("honors presence status busy on touch and lists it", async () => {
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    await presence.touch({ roomId, actor, status: "busy" });
    const roster = await presence.list(roomId);
    expect(roster).toEqual([expect.objectContaining({ actorId: actor.id, status: "busy" })]);
  });

  it("reports away after the idle threshold and drops after TTL", async () => {
    let now = 1_000_000;
    const presence = new InMemoryChatPresenceStore({
      ttlSeconds: 10,
      awayThresholdFraction: 0.5,
      now: () => now,
    });
    await presence.touch({
      roomId,
      actor,
      status: "available",
      at: new Date(now),
    });
    now = 1_000_000 + 6_000; // past 50% of 10s
    expect((await presence.list(roomId))[0]?.status).toBe("away");
    now = 1_000_000 + 11_000;
    expect(await presence.list(roomId)).toHaveLength(0);
  });

  it("aggregates member devices and makes invisible authoritative", async () => {
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    await presence.touch({ roomId, actor, connectionId: "phone", status: "available" });
    await presence.touch({ roomId, actor, connectionId: "laptop", status: "dnd" });
    expect(await presence.list(roomId)).toEqual([
      expect.objectContaining({ actorId: actor.id, status: "dnd" }),
    ]);

    await presence.touch({ roomId, actor, connectionId: "private", status: "invisible" });
    expect(await presence.list(roomId)).toEqual([]);
    await presence.remove({ roomId, actorId: actor.id, connectionId: "private" });
    expect((await presence.list(roomId))[0]?.status).toBe("dnd");
  });

  it("enforces one membership connection quota across tabs and expires crashed leases", async () => {
    let now = 1_000;
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 5, now: () => now });
    expect(
      await presence.connect({
        orgId: actor.orgId,
        actorId: actor.id,
        connectionId: "first",
        limit: 1,
      }),
    ).toBe(true);
    expect(
      await presence.connect({
        orgId: actor.orgId,
        actorId: actor.id,
        connectionId: "second",
        limit: 1,
      }),
    ).toBe(false);
    now += 10_001;
    expect(
      await presence.connect({
        orgId: actor.orgId,
        actorId: actor.id,
        connectionId: "second",
        limit: 1,
      }),
    ).toBe(true);
  });

  it("heartbeats renew presence without user activity", async () => {
    let now = 0;
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30, now: () => now });
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence,
    });
    socket.receive({ type: "subscribe", roomId });
    await settle();
    now = 20_000;
    socket.receive({ type: "heartbeat" });
    await settle();
    now = 40_000;
    expect(await presence.list(roomId)).toHaveLength(1);
  });

  it("filters blocked actors from presence snapshots", async () => {
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    await presence.touch({ roomId, actor: otherActor, status: "available" });
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new PresencePrivacyChatStore(otherActor.id),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence,
    });
    socket.receive({ type: "subscribe", roomId });
    await settle();
    const subscribed = socket.messages.find((message) => message.type === "subscribed");
    expect(subscribed?.presence).toEqual([expect.objectContaining({ actorId: actor.id })]);
  });

  it("rate-limits inbound frames when capacity is exhausted", async () => {
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
      rateLimit: { capacity: 2, refillPerSecond: 0 },
    });

    socket.receive({ type: "subscribe", roomId });
    await settle();
    socket.receive({ type: "typing", roomId, isTyping: true });
    await settle();
    socket.receive({ type: "typing", roomId, isTyping: true });
    await settle();

    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: "error", code: "rate_limited" }),
    );
    expect(socket.closed).toEqual({ code: 1008, reason: "rate limit exceeded" });
  });

  it("processes a burst in arrival order with exactly one frame in flight", async () => {
    const socket = new FakeSocket();
    const store = new BlockingChatStore();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
      rateLimit: { capacity: 10, refillPerSecond: 0 },
    });

    for (const body of ["first", "second", "third"]) {
      socket.receive({ type: "send", roomId, body });
    }

    await expect.poll(() => store.startedBodies).toEqual(["first"]);
    store.releaseNext();
    await expect.poll(() => store.startedBodies).toEqual(["first", "second"]);
    store.releaseNext();
    await expect.poll(() => store.startedBodies).toEqual(["first", "second", "third"]);
    store.releaseNext();
    await expect.poll(() => store.sentBodies).toEqual(["first", "second", "third"]);
    expect(store.maxInFlight).toBe(1);
  });

  it("closes with backpressure before a per-socket queue can grow past its bound", async () => {
    const socket = new FakeSocket();
    const store = new BlockingChatStore();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
      rateLimit: { capacity: 10, refillPerSecond: 0 },
      maxPendingFrames: 2,
    });

    socket.receive({ type: "send", roomId, body: "active" });
    await expect.poll(() => store.startedBodies).toEqual(["active"]);
    socket.receive({ type: "send", roomId, body: "queued" });
    socket.receive({ type: "send", roomId, body: "rejected" });

    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: "error", code: "backpressure" }),
    );
    expect(socket.closed).toEqual({ code: 1013, reason: "too many pending frames" });
    store.releaseNext();
    await settle();
    expect(store.startedBodies).toEqual(["active"]);
    expect(store.maxInFlight).toBe(1);
  });

  it("rejects oversized frames before parsing or store work", async () => {
    const socket = new FakeSocket();
    const store = new FakeChatStore();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
      maxPayloadBytes: 64,
    });

    socket.receive({ type: "send", roomId, body: "x".repeat(128) });

    expect(store.sentBodies).toEqual([]);
    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: "error", code: "payload_too_large" }),
    );
    expect(socket.closed).toEqual({ code: 1009, reason: "payload too large" });
  });

  it("closes a socket when one frame exceeds its processing deadline", async () => {
    const socket = new FakeSocket();
    const store = new BlockingChatStore();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
      frameDeadlineMs: 5,
    });

    socket.receive({ type: "send", roomId, body: "blocked" });

    await expect
      .poll(() => socket.closed, { timeout: 250 })
      .toEqual({ code: 1011, reason: "frame deadline exceeded" });
    expect(socket.messages).toContainEqual(
      expect.objectContaining({ type: "error", code: "deadline_exceeded" }),
    );
    expect(store.maxInFlight).toBe(1);
  });
});

/**
 * Minimal Fastify stand-in that captures the websocket handler registered by
 * `registerChatRoutes` so a test can drive sockets through it and then invoke
 * the returned graceful-shutdown handle (PRD §16.3 step 5).
 */
function captureWebsocketApp(): {
  readonly app: FastifyInstance;
  readonly connect: (socket: FakeSocket, request: FastifyRequest) => Promise<void>;
  readonly issueTicket: (roomId: string) => Promise<{
    readonly output: unknown;
    readonly headers: Readonly<Record<string, string>>;
  }>;
  readonly replayEvents: (cursor: number) => Promise<{
    readonly output: unknown;
    readonly headers: Readonly<Record<string, string>>;
  }>;
} {
  let handler: ((socket: unknown, request: FastifyRequest) => Promise<void>) | undefined;
  let ticketHandler:
    | ((
        request: FastifyRequest,
        reply: { header(name: string, value: string): unknown },
      ) => Promise<unknown>)
    | undefined;
  let replayHandler:
    | ((
        request: FastifyRequest,
        reply: { header(name: string, value: string): unknown },
      ) => Promise<unknown>)
    | undefined;
  const app = {
    post: (
      _path: string,
      registered: (
        request: FastifyRequest,
        reply: { header(name: string, value: string): unknown },
      ) => Promise<unknown>,
    ) => {
      ticketHandler = registered;
    },
    get: (path: string, optsOrHandler: unknown, registered?: typeof handler) => {
      if (path === "/ws/chat") {
        handler = registered;
        return;
      }
      replayHandler = optsOrHandler as typeof replayHandler;
    },
  } as unknown as FastifyInstance;
  return {
    app,
    connect: async (socket, request) => {
      if (handler === undefined) {
        throw new Error("No websocket handler registered.");
      }
      await handler(socket, request);
    },
    issueTicket: async (requestedRoomId) => {
      if (ticketHandler === undefined) {
        throw new Error("No ticket handler registered.");
      }
      const headers: Record<string, string> = {};
      const reply = {
        header: (name: string, value: string) => {
          headers[name] = value;
          return reply;
        },
      };
      const output = await ticketHandler(
        { body: { roomId: requestedRoomId } } as FastifyRequest,
        reply,
      );
      return { output, headers };
    },
    replayEvents: async (cursor) => {
      if (replayHandler === undefined) {
        throw new Error("No replay handler registered.");
      }
      const headers: Record<string, string> = {};
      const reply = {
        header: (name: string, value: string) => {
          headers[name] = value;
          return reply;
        },
      };
      const output = await replayHandler(
        { params: { roomId }, query: { cursor, limit: 100 } } as unknown as FastifyRequest,
        reply,
      );
      return { output, headers };
    },
  };
}

describe("chat websocket ticket issuance", () => {
  it("mints a no-store ticket only after session actor and room checks", async () => {
    const tickets = new FakeTicketStore(actor);
    const store = new FakeChatStore();
    const { app, issueTicket } = captureWebsocketApp();
    await registerChatRoutes(app, {
      store,
      trustedOrigins,
      tickets,
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore(),
    });

    await expect(issueTicket(roomId)).resolves.toEqual({
      output: {
        ticket: "t".repeat(43),
        expiresAt: "2026-05-20T12:00:30.000Z",
      },
      headers: { "cache-control": "no-store" },
    });
    expect(tickets.issuedRooms).toEqual([roomId]);
    expect(store.getRoomForActorCalls).toEqual([{ orgId: actor.orgId, actorId: actor.id, roomId }]);
  });

  it("rejects ticket minting without a browser session", async () => {
    const { app, issueTicket } = captureWebsocketApp();
    await registerChatRoutes(app, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => unauthenticatedActor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore(),
    });

    await expect(issueTicket(roomId)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("chat event cursor endpoint", () => {
  it("returns only authorized durable events after the requested cursor", async () => {
    const bus = new InMemoryChatRoomBus();
    await bus.publish(actor.orgId, roomId, {
      type: "message.created",
      roomId,
      orgId: actor.orgId,
      message: { id: "one" },
    });
    await bus.publish(actor.orgId, roomId, {
      type: "message.created",
      roomId,
      orgId: actor.orgId,
      message: { id: "two" },
    });
    const { app, replayEvents } = captureWebsocketApp();
    await registerChatRoutes(app, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus,
      presence: new InMemoryChatPresenceStore(),
    });

    await expect(replayEvents(1)).resolves.toEqual({
      output: {
        events: [expect.objectContaining({ cursor: 2 })],
        cursor: 2,
        latestCursor: 2,
        hasMore: false,
        resetRequired: false,
      },
      headers: { "cache-control": "no-store" },
    });
  });

  it("checks current room access before disclosing an in-memory cursor", async () => {
    const { app, replayEvents } = captureWebsocketApp();
    await registerChatRoutes(app, {
      store: new FakeChatStore({ inaccessibleRoomIds: [roomId] }),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore(),
    });

    await expect(replayEvents(0)).rejects.toBeInstanceOf(ChatRoomAccessError);
  });
});

describe("chat graceful-shutdown broadcast (PRD §16.3 step 5)", () => {
  it("sends a reconnect-required frame and closes connected chat sockets", async () => {
    const { app, connect } = captureWebsocketApp();
    const handle = await registerChatRoutes(app, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    const first = new FakeSocket();
    const second = new FakeSocket();
    await connect(first, emptyWebSocketRequest);
    await connect(second, ticketRequest("u"));

    handle.broadcastShutdown();

    for (const socket of [first, second]) {
      expect(socket.messages.at(-1)).toEqual({
        type: "reconnect",
        reason: "reconnect required",
      });
      expect(socket.closed).toEqual({ code: 1001, reason: "reconnect required" });
    }
  });

  it("does not reach sockets that already disconnected", async () => {
    const { app, connect } = captureWebsocketApp();
    const handle = await registerChatRoutes(app, {
      store: new FakeChatStore(),
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    const socket = new FakeSocket();
    await connect(socket, emptyWebSocketRequest);
    await settle();
    socket.close();
    socket.closed = null;

    handle.broadcastShutdown();

    expect(socket.messages.some((message) => message.type === "reconnect")).toBe(false);
    expect(socket.closed).toBeNull();
  });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("chat transport safety", () => {
  it("closes and unsubscribes a slow socket before its buffer grows without bound", async () => {
    const socket = new FakeSocket();
    const bus = new InMemoryChatRoomBus();
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => actor,
      trustedOrigins,
      bus,
      presence,
    });
    socket.receive({ type: "subscribe", roomId });
    await settle();
    socket.bufferedAmount = 2 * 1024 * 1024;
    await bus.publish(actor.orgId, roomId, {
      type: "typing",
      eventId: "slow-event",
      orgId: actor.orgId,
      roomId,
      actorId: otherActor.id,
      isTyping: true,
    });
    await settle();
    expect(socket.closed).toEqual({ code: 1013, reason: "slow consumer" });
    expect(await presence.list(roomId)).toEqual([]);
  });
  it.each([
    { origin: "https://evil.invalid", cookie: "helix_session=valid" },
    { cookie: "helix_session=valid" },
  ])("rejects unsafe browser origins before consuming a ticket", async (headers) => {
    const socket = new FakeSocket();
    const tickets = new FakeTicketStore(actor);
    await handleChatSocket(
      socket,
      {
        headers: { ...emptyWebSocketRequest.headers, origin: undefined, ...headers },
      } as FastifyRequest,
      {
        store: new FakeChatStore(),
        tickets,
        actorFromRequest: () => actor,
        trustedOrigins,
        bus: new InMemoryChatRoomBus(),
        presence: new InMemoryChatPresenceStore(),
      },
    );
    expect(socket.closed).toEqual({ code: 4403, reason: "origin rejected" });
    const accepted = new FakeSocket();
    await handleChatSocket(accepted, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      tickets,
      actorFromRequest: () => actor,
      trustedOrigins,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore(),
    });
    expect(accepted.messages).toContainEqual(expect.objectContaining({ type: "ready" }));
  });
});

describe("Chat session revocation", () => {
  it.each(["incoming", "outgoing"])(
    "rejects %s frames after the session is revoked",
    async (direction) => {
      let valid = true;
      const socket = new FakeSocket();
      const bus = new InMemoryChatRoomBus();
      await handleChatSocket(socket, emptyWebSocketRequest, {
        store: new FakeChatStore(),
        trustedOrigins,
        tickets: new FakeTicketStore(actor),
        actorFromRequest: () => (valid ? actor : unauthenticatedActor),
        bus,
        presence: new InMemoryChatPresenceStore(),
      });
      socket.receive({ type: "subscribe", roomId });
      await expect.poll(() => socket.messages.some((m) => m.type === "subscribed")).toBe(true);
      socket.messages.length = 0;
      valid = false;
      if (direction === "incoming") socket.receive({ type: "heartbeat" });
      else
        await bus.publish(actor.orgId, roomId, {
          type: "typing",
          orgId: actor.orgId,
          roomId,
          actorId: otherActor.id,
          isTyping: true,
        });
      await expect.poll(() => socket.closed?.code).toBe(1008);
      expect(socket.messages).toEqual([
        expect.objectContaining({ type: "error", code: "forbidden" }),
      ]);
    },
  );
});

it.each(["chat.read", "chat.post"])(
  "honors revocation of %s on an existing Chat socket",
  async (revoked) => {
    let scopes = ["chat.read", "chat.post"];
    const socket = new FakeSocket();
    const store = new FakeChatStore();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      trustedOrigins,
      tickets: new FakeTicketStore(actor),
      actorFromRequest: () => ({ ...actor, scopes }),
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore(),
    });
    expect(socket.messages.some((m) => m.type === "ready")).toBe(true);
    scopes = scopes.filter((scope) => scope !== revoked);
    socket.receive({ type: "send", roomId, body: "must not send" });
    await expect.poll(() => socket.closed?.code).toBe(1008);
    expect(store.sentBodies).toEqual([]);
  },
);
