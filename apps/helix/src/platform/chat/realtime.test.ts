import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { handleChatSocket, registerChatRoutes } from "./routes.js";
import { InMemoryChatPresenceStore, InMemoryChatRoomBus, roomSubject } from "./realtime.js";
import type { ChatStore } from "./store.js";
import type {
  ChatMessageRecord,
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

describe("chat realtime", () => {
  it("builds stable per-room subjects for the NATS abstraction", () => {
    expect(roomSubject(roomId)).toBe(`chat.room.${roomId}.events`);
    expect(roomSubject("room.with.dots")).toBe("chat.room.room_with_dots.events");
  });

  it("handles subscribe, typing, send, and read websocket messages", async () => {
    const socket = new FakeSocket();
    const bus = new InMemoryChatRoomBus();
    const presence = new InMemoryChatPresenceStore({ ttlSeconds: 30 });
    const store = new FakeChatStore();

    await handleChatSocket(socket, {} as FastifyRequest, {
      store,
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

    await handleChatSocket(receiverSocket, {} as FastifyRequest, {
      store,
      actorFromRequest: () => otherActor,
      bus,
      presence,
    });
    receiverSocket.receive({ type: "subscribe", roomId });
    await settle();
    receiverSocket.messages.length = 0;

    await handleChatSocket(senderSocket, {} as FastifyRequest, {
      store,
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
    await handleChatSocket(socket, {} as FastifyRequest, {
      store,
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

  it("rejects inaccessible presence requests after consulting room access", async () => {
    const socket = new FakeSocket();
    const store = new FakeChatStore({ inaccessibleRoomIds: [roomId] });

    await handleChatSocket(socket, {} as FastifyRequest, {
      store,
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
        error: `Unknown or inaccessible chat room: ${roomId}`,
      }),
    );
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
  let handler:
    | ((socket: unknown, request: FastifyRequest) => Promise<void>)
    | undefined;
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

describe("chat graceful-shutdown broadcast (PRD §16.3 step 5)", () => {
  it("sends a reconnect-required frame and closes connected chat sockets", async () => {
    const { app, connect } = captureWebsocketApp();
    const handle = await registerChatRoutes(app, {
      store: new FakeChatStore(),
      actorFromRequest: () => actor,
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    const first = new FakeSocket();
    const second = new FakeSocket();
    await connect(first, {} as FastifyRequest);
    await connect(second, {} as FastifyRequest);

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
      bus: new InMemoryChatRoomBus(),
      presence: new InMemoryChatPresenceStore({ ttlSeconds: 30 }),
    });

    const socket = new FakeSocket();
    await connect(socket, {} as FastifyRequest);
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
}

class PresenceRecordingRoomBus extends InMemoryChatRoomBus {
  readonly readRostersAtPublish: { readonly actorId: string }[][] = [];

  constructor(private readonly presence: InMemoryChatPresenceStore) {
    super();
  }

  override async publish(
    roomId: string,
    event: Parameters<InMemoryChatRoomBus["publish"]>[1],
  ): Promise<void> {
    if (event.type === "read") {
      this.readRostersAtPublish.push([...(await this.presence.list(roomId))]);
    }
    await super.publish(roomId, event);
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
