import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { unauthenticatedActor } from "../../api/actor.js";
import {
  bearerTokenFromSecWebSocketProtocol,
  handleChatSocket,
  registerChatRoutes,
} from "./routes.js";
import { InMemoryChatPresenceStore, InMemoryChatRoomBus, roomSubject } from "./realtime.js";
import type { ChatStore } from "./store.js";
import type {
  ChatMessageRecord,
  ChatPinRecord,
  ChatReadReceiptRecord,
  ChatReactionRecord,
  ChatRoomRecord,
  ChatSearchHit,
} from "./types.js";

const now = new Date("2026-05-20T12:00:00.000Z");
const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Ada",
};
const otherActor: Actor = {
  id: "55555555-5555-4555-8555-555555555555",
  orgId: actor.orgId,
  type: "user",
  displayName: "Grace",
};
const roomId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const trustedOrigins = ["https://app.helix.test"];
const emptyWebSocketRequest = {
  headers: { origin: trustedOrigins[0] },
  query: {},
} as unknown as FastifyRequest;

describe("chat realtime", () => {
  it("builds stable per-room subjects for the NATS abstraction", () => {
    expect(roomSubject(actor.orgId, roomId)).toBe(`chat.org.${actor.orgId}.room.${roomId}.events`);
    expect(roomSubject("org.with.dots", "room.with.dots")).toBe(
      "chat.org.org_with_dots.room.room_with_dots.events",
    );
  });

  it("handles subscribe, typing, send, and read websocket messages", async () => {
    const socket = new FakeSocket();
    const bus = new InMemoryChatRoomBus();
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    const store = new FakeChatStore();

    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      actorFromRequest: () => actor,
      trustedOrigins,
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
      actorFromRequest: () => otherActor,
      trustedOrigins,
      bus,
      presence,
    });
    receiverSocket.receive({ type: "subscribe", roomId });
    await settle();
    receiverSocket.messages.length = 0;

    await handleChatSocket(senderSocket, emptyWebSocketRequest, {
      store,
      actorFromRequest: () => actor,
      trustedOrigins,
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
      actorFromRequest: () => actor,
      trustedOrigins,
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

  it("rejects inaccessible presence requests after consulting room access", async () => {
    const socket = new FakeSocket();
    const store = new FakeChatStore({ inaccessibleRoomIds: [roomId] });

    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      actorFromRequest: () => actor,
      trustedOrigins,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    socket.receive({ type: "presence", roomId });
    await settle();

    expect(store.getRoomForActorCalls).toEqual([{ orgId: actor.orgId, actorId: actor.id, roomId }]);
    expect(socket.messages).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "not_found",
        message: "Chat room was not found.",
      }),
    );
  });

  it("stops realtime fanout and presence immediately after membership revocation", async () => {
    const socket = new FakeSocket();
    const store = new FakeChatStore();
    const bus = new InMemoryChatRoomBus();
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store,
      actorFromRequest: () => actor,
      trustedOrigins,
      bus,
      presence,
    });
    socket.receive({ type: "subscribe", roomId });
    await settle();
    socket.messages.length = 0;

    store.denyRoom(roomId);
    await bus.publish(actor.orgId, roomId, {
      type: "typing",
      eventId: "revoked-event",
      orgId: actor.orgId,
      roomId,
      actorId: otherActor.id,
      isTyping: true,
    });
    await settle();

    expect(socket.messages).toEqual([]);
    expect(await presence.list(roomId)).toEqual([]);
  });

  it("closes and unsubscribes a slow socket before its buffer grows without bound", async () => {
    const socket = new FakeSocket();
    const bus = new InMemoryChatRoomBus();
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
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

  it("rate-limits inbound frames when capacity is exhausted", async () => {
    const socket = new FakeSocket();
    await handleChatSocket(socket, emptyWebSocketRequest, {
      store: new FakeChatStore(),
      actorFromRequest: () => actor,
      trustedOrigins,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
      rateLimit: { capacity: 2, refillPerSecond: 0 },
      authGraceMs: 5_000,
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
  });
});

describe("chat websocket handshake security", () => {
  it("rejects cross-site websocket hijacking with a valid session cookie", async () => {
    const socket = new FakeSocket();
    let resolverCalls = 0;

    await handleChatSocket(
      socket,
      request({
        origin: "https://app.helix.test.evil.invalid",
        cookie: "helix_session=valid-but-cross-site",
      }),
      secureSocketOptions({
        actorFromRequest: () => {
          resolverCalls += 1;
          return actor;
        },
      }),
    );

    expect(socket.closed).toEqual({ code: 4403, reason: "origin rejected" });
    expect(socket.messages).toEqual([]);
    expect(resolverCalls).toBe(0);
  });

  it("requires Origin when a browser session cookie is present", async () => {
    const socket = new FakeSocket();

    await handleChatSocket(
      socket,
      request({ cookie: "helix_session=valid-but-originless" }),
      secureSocketOptions(),
    );

    expect(socket.closed).toEqual({ code: 4403, reason: "origin rejected" });
  });

  it("accepts cookie-free non-browser Authorization authentication without Origin", async () => {
    const socket = new FakeSocket();

    await handleChatSocket(
      socket,
      request({ authorization: "Bearer service-token" }),
      secureSocketOptions(),
    );

    expect(socket.messages).toContainEqual({ type: "ready", actorId: actor.id });
    expect(socket.closed).toBeNull();
  });

  it("bounds the missing-Origin first-frame service bearer handshake", async () => {
    const socket = new FakeSocket();
    const tokens: string[] = [];

    await handleChatSocket(
      socket,
      request({}),
      secureSocketOptions({
        actorFromRequest: () => unauthenticatedActor,
        actorFromToken: (token) => {
          tokens.push(token);
          return actor;
        },
        authGraceMs: 500,
      }),
    );
    socket.receive({ type: "auth", token: "service-token" });
    await settle();

    expect(tokens).toEqual(["service-token"]);
    expect(socket.messages).toContainEqual({ type: "ready", actorId: actor.id });
  });

  it("rejects an oversized first-frame bearer credential", async () => {
    const socket = new FakeSocket();
    let resolverCalls = 0;

    await handleChatSocket(
      socket,
      request({}),
      secureSocketOptions({
        actorFromRequest: () => unauthenticatedActor,
        actorFromToken: () => {
          resolverCalls += 1;
          return actor;
        },
        authGraceMs: 500,
      }),
    );
    socket.receive({ type: "auth", token: "x".repeat(5_000) });
    await settle();

    expect(resolverCalls).toBe(0);
    expect(socket.closed).toEqual({ code: 4401, reason: "auth failed" });
  });

  it("does not report token-bearing authentication adapter errors", async () => {
    const socket = new FakeSocket();
    const errors: unknown[] = [];

    await handleChatSocket(
      socket,
      request({ "sec-websocket-protocol": "helix-bearer, reusable-secret" }),
      secureSocketOptions({
        actorFromRequest: () => unauthenticatedActor,
        actorFromToken: () => {
          throw new Error("adapter included reusable-secret");
        },
        onError: (error) => errors.push(error),
      }),
    );

    expect(socket.closed).toEqual({ code: 4401, reason: "auth failed" });
    expect(errors).toEqual([]);
    expect(JSON.stringify(socket.messages)).not.toContain("reusable-secret");
  });

  it("rejects the token-echoing dotted websocket subprotocol form", () => {
    expect(
      bearerTokenFromSecWebSocketProtocol(
        request({ "sec-websocket-protocol": "helix-bearer.reusable-secret" }),
      ),
    ).toBeNull();
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
} {
  let handler: ((socket: unknown, request: FastifyRequest) => Promise<void>) | undefined;
  const app = {
    get: (_path: string, _opts: unknown, registered: typeof handler) => {
      handler = registered;
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
  };
}

function request(headers: Record<string, string>): FastifyRequest {
  return { headers, query: {} } as unknown as FastifyRequest;
}

function secureSocketOptions(
  overrides: Partial<Parameters<typeof handleChatSocket>[2]> = {},
): Parameters<typeof handleChatSocket>[2] {
  return {
    store: new FakeChatStore(),
    actorFromRequest: () => actor,
    trustedOrigins,
    bus: new InMemoryChatRoomBus(),
    presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    ...overrides,
  };
}

describe("chat graceful-shutdown broadcast (PRD §16.3 step 5)", () => {
  it("sends a reconnect-required frame and closes connected chat sockets", async () => {
    const { app, connect } = captureWebsocketApp();
    const handle = await registerChatRoutes(app, {
      store: new FakeChatStore(),
      actorFromRequest: () => actor,
      trustedOrigins,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    const first = new FakeSocket();
    const second = new FakeSocket();
    await connect(first, emptyWebSocketRequest);
    await connect(second, emptyWebSocketRequest);

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
      actorFromRequest: () => actor,
      trustedOrigins,
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

class FakeSocket {
  readonly messages: Record<string, unknown>[] = [];
  bufferedAmount = 0;
  closed: { readonly code?: number; readonly reason?: string } | null = null;
  #messageHandlers: ((data: string) => void)[] = [];
  #closeHandlers: (() => void)[] = [];
  #errorHandlers: ((error: Error) => void)[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    for (const handler of this.#closeHandlers) {
      handler();
    }
  }

  on(event: "message", handler: (data: string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(
    event: "message" | "close" | "error",
    handler: ((data: string) => void) | (() => void) | ((error: Error) => void),
  ): void {
    if (event === "message") {
      this.#messageHandlers.push(handler as (data: string) => void);
      return;
    }
    if (event === "close") {
      this.#closeHandlers.push(handler as () => void);
      return;
    }
    this.#errorHandlers.push(handler as (error: Error) => void);
  }

  receive(payload: unknown): void {
    for (const handler of this.#messageHandlers) {
      handler(JSON.stringify(payload));
    }
  }
}

class FakeChatStore implements ChatStore {
  readonly sentBodies: string[] = [];
  readonly readMessageIds: (string | null)[] = [];
  readonly getRoomForActorCalls: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }[] = [];
  readonly #inaccessibleRoomIds: Set<string>;

  constructor(options: { readonly inaccessibleRoomIds?: readonly string[] } = {}) {
    this.#inaccessibleRoomIds = new Set(options.inaccessibleRoomIds ?? []);
  }

  denyRoom(deniedRoomId: string): void {
    this.#inaccessibleRoomIds.add(deniedRoomId);
  }

  async createRoom(): Promise<ChatRoomRecord> {
    return roomRecord();
  }

  async invite(
    input: Parameters<ChatStore["invite"]>[0],
  ): Promise<{ readonly roomId: string; readonly invitedActorIds: readonly string[] }> {
    return { roomId: input.roomId, invitedActorIds: input.actorIds };
  }

  async listRooms(): Promise<readonly ChatRoomRecord[]> {
    return [roomRecord()];
  }

  async sendMessage(input: Parameters<ChatStore["sendMessage"]>[0]): Promise<ChatMessageRecord> {
    this.sentBodies.push(input.body);
    return messageRecord(input.body);
  }

  async react(): Promise<ChatReactionRecord | null> {
    return null;
  }

  async editMessage(
    input: Parameters<ChatStore["editMessage"]>[0],
  ): Promise<ChatMessageRecord | null> {
    return messageRecord(input.body);
  }

  async deleteMessage(): Promise<ChatMessageRecord | null> {
    return messageRecord("deleted");
  }

  async markRead(input: Parameters<ChatStore["markRead"]>[0]): Promise<ChatReadReceiptRecord> {
    this.readMessageIds.push(input.messageId ?? null);
    const receipt: ChatReadReceiptRecord = {
      roomId: input.roomId,
      actorId: input.actorId,
      orgId: input.orgId,
      lastReadMessageId: input.messageId ?? null,
      lastReadAt: now,
      updatedAt: now,
    };
    this.readReceipts.set(input.actorId, receipt);
    return receipt;
  }

  readonly readReceipts = new Map<string, ChatReadReceiptRecord>();

  async listReadReceipts(
    input: Parameters<NonNullable<ChatStore["listReadReceipts"]>>[0],
  ): Promise<readonly ChatReadReceiptRecord[]> {
    return [...this.readReceipts.values()].filter((receipt) => receipt.roomId === input.roomId);
  }

  async listMessages(): Promise<readonly ChatMessageRecord[]> {
    return [messageRecord("hello")];
  }

  async search(): Promise<readonly ChatSearchHit[]> {
    return [];
  }

  async getRoomForActor(
    input: Parameters<ChatStore["getRoomForActor"]>[0],
  ): Promise<ChatRoomRecord | null> {
    this.getRoomForActorCalls.push(input);
    if (this.#inaccessibleRoomIds.has(input.roomId)) {
      return null;
    }
    return roomRecord();
  }

  async listThreadReplies(): Promise<readonly ChatMessageRecord[]> {
    return [];
  }

  async pinMessage(input: {
    readonly roomId: string;
    readonly messageId: string;
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<ChatPinRecord> {
    return {
      roomId: input.roomId,
      messageId: input.messageId,
      orgId: input.orgId,
      pinnedByActorId: input.actorId,
      createdAt: now,
    };
  }

  async unpinMessage(): Promise<{ readonly ok: true }> {
    return { ok: true };
  }

  async listPins(): Promise<readonly ChatPinRecord[]> {
    return [];
  }
}

class PresenceRecordingRoomBus extends InMemoryChatRoomBus {
  readonly readRostersAtPublish: { readonly actorId: string }[][] = [];

  constructor(private readonly presence: InMemoryChatPresenceStore) {
    super();
  }

  override async publish(
    orgId: string,
    roomId: string,
    event: Parameters<InMemoryChatRoomBus["publish"]>[2],
  ): Promise<void> {
    if (event.type === "read") {
      this.readRostersAtPublish.push([...(await this.presence.list(roomId))]);
    }
    await super.publish(orgId, roomId, event);
  }
}

function roomRecord(): ChatRoomRecord {
  return {
    id: roomId,
    orgId: actor.orgId,
    kind: "chat_room",
    subject: "General",
    createdByActorId: actor.id,
    metadata: {},
    members: [
      { actorId: actor.id, role: "owner", displayName: "Maya Chen", email: "maya@example.com" },
    ],
    settings: null,
    createdAt: now,
    updatedAt: now,
  };
}

function messageRecord(body: string): ChatMessageRecord {
  return {
    id: messageId,
    orgId: actor.orgId,
    roomId,
    actorId: actor.id,
    body,
    bodyFormat: "plain",
    metadata: {},
    attachmentObjectIds: [],
    sentAt: now,
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
