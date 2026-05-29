import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { serializeReadReceipt } from "./tools.js";
import type { ChatStore } from "./store.js";
import type { ChatPresenceStore, ChatRoomBus, ChatRoomEvent } from "./realtime.js";
import { InMemoryChatPresenceStore, InMemoryChatRoomBus } from "./realtime.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";

/** Route label for the chat WebSocket connection gauge. */
const CHAT_WS_ROUTE = "/ws/chat";

/**
 * Per-connection token-bucket rate limit (Chat C1). One bucket per socket,
 * shared across all inbound frame types so a misbehaving client cannot flood
 * any single channel (send / typing / read / presence / subscribe).
 *
 * Defaults: capacity 30 tokens, refill 30 tokens per 10 seconds (3 tokens/s).
 */
const CHAT_WS_RATE_LIMIT_CAPACITY = 30;
const CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND = 3;

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

function createBucket(): TokenBucket {
  return { tokens: CHAT_WS_RATE_LIMIT_CAPACITY, lastRefillMs: Date.now() };
}

/** Returns true when a token was available and consumed. */
function consumeToken(bucket: TokenBucket): boolean {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
  if (elapsedSeconds > 0) {
    bucket.tokens = Math.min(
      CHAT_WS_RATE_LIMIT_CAPACITY,
      bucket.tokens + elapsedSeconds * CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND,
    );
    bucket.lastRefillMs = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

interface ChatSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

const inboundMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    roomId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("send"),
    roomId: z.string().uuid(),
    body: z.string().min(1).max(50_000),
    bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
    attachmentObjectIds: z.array(z.string().uuid()).default([]),
  }),
  z.object({
    type: z.literal("typing"),
    roomId: z.string().uuid(),
    isTyping: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("read"),
    roomId: z.string().uuid(),
    messageId: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("presence"),
    roomId: z.string().uuid(),
  }),
]);

export interface RegisterChatRoutesOptions {
  readonly store: ChatStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly bus?: ChatRoomBus | undefined;
  readonly presence?: ChatPresenceStore | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Active-connections gauge recorder (Follow-up B). */
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  /**
   * Auto-classification hook (Chat C2). When provided, `send` frames received
   * over the WebSocket are classified in the same way as the REST `chat.send`
   * tool (PRD §8.4), keeping the two ingress paths in sync.
   */
  readonly classifyResource?: ResourceClassifier | undefined;
}

type ChatSocketOptions = {
  readonly store: ChatStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly bus: ChatRoomBus;
  readonly presence: ChatPresenceStore;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly classifyResource?: ResourceClassifier | undefined;
  /** Live registry of open chat sockets, used by graceful-shutdown broadcast. */
  readonly connections?: Set<ChatSocket> | undefined;
};

/** Close code sent to chat clients when the host is shutting down. */
const CHAT_SHUTDOWN_CLOSE_CODE = 1001;

/**
 * Handle returned by {@link registerChatRoutes} so the server's graceful
 * shutdown drain (PRD §16.3 step 5) can notify connected clients before
 * sockets are torn down.
 */
export interface ChatRoutesHandle {
  /**
   * Broadcast a typed "reconnect required" frame to every connected chat
   * socket and then close it cleanly so clients reconnect to a surviving
   * replica.
   */
  broadcastShutdown(): void;
}

export async function registerChatRoutes(
  app: FastifyInstance,
  options: RegisterChatRoutesOptions,
): Promise<ChatRoutesHandle> {
  const bus = options.bus ?? new InMemoryChatRoomBus();
  const presence = options.presence ?? new InMemoryChatPresenceStore();
  const connections = new Set<ChatSocket>();

  app.get("/ws/chat", { websocket: true }, async (socket, request) => {
    await handleChatSocket(socket as ChatSocket, request, {
      ...options,
      bus,
      presence,
      connections,
    });
  });

  return {
    broadcastShutdown: () => {
      const frame = JSON.stringify({ type: "reconnect", reason: "reconnect required" });
      for (const socket of connections) {
        try {
          socket.send(frame);
          socket.close(CHAT_SHUTDOWN_CLOSE_CODE, "reconnect required");
        } catch (error) {
          options.onError?.(error);
        }
      }
    },
  };
}

export async function handleChatSocket(
  socket: ChatSocket,
  request: FastifyRequest,
  options: ChatSocketOptions,
): Promise<void> {
  // Follow-up B: count this connection on the active-connections gauge.
  trackWebsocketConnection(socket, CHAT_WS_ROUTE, options.metrics);

  const actor = await options.actorFromRequest(request);
  const subscriptions = new Map<string, Awaited<ReturnType<ChatRoomBus["subscribe"]>>>();
  // Per-connection token bucket for rate limiting (Chat C1).
  const rateLimitBucket = createBucket();

  // Track this socket so graceful shutdown (PRD §16.3 step 5) can reach it.
  options.connections?.add(socket);

  socket.on("message", (data) => {
    if (!consumeToken(rateLimitBucket)) {
      // Drop the frame, signal the client, and do not advance state.
      sendSocket(socket, {
        type: "error",
        error: "rate_limited",
        message: "Chat rate limit exceeded; slow down inbound frames.",
      });
      return;
    }
    void handleInboundMessage({
      socket,
      actor,
      raw: data,
      subscriptions,
      options,
    }).catch((error: unknown) => {
      options.onError?.(error);
      sendSocket(socket, {
        type: "error",
        error: error instanceof Error ? error.message : "Chat message failed",
      });
    });
  });

  socket.on("close", () => {
    options.connections?.delete(socket);
    void Promise.allSettled([
      ...[...subscriptions.entries()].map(async ([roomId, unsubscribe]) => {
        await options.presence.remove({ roomId, actorId: actor.id });
        await options.bus.publish(roomId, {
          type: "presence.left",
          roomId,
          actorId: actor.id,
        });
        await unsubscribe();
      }),
    ]);
  });

  socket.on("error", (error) => {
    options.onError?.(error);
  });

  sendSocket(socket, { type: "ready", actorId: actor.id });
}

async function handleInboundMessage(input: {
  readonly socket: ChatSocket;
  readonly actor: Actor;
  readonly raw: Buffer | ArrayBuffer | string;
  readonly subscriptions: Map<string, Awaited<ReturnType<ChatRoomBus["subscribe"]>>>;
  readonly options: ChatSocketOptions;
}): Promise<void> {
  const message = inboundMessageSchema.parse(JSON.parse(rawToString(input.raw)));

  if (message.type === "subscribe") {
    await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
    if (!input.subscriptions.has(message.roomId)) {
      const unsubscribe = await input.options.bus.subscribe(message.roomId, async (event) => {
        sendSocket(input.socket, event);
      });
      input.subscriptions.set(message.roomId, unsubscribe);
    }
    const entry = await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
    });
    const roster = await input.options.presence.list(message.roomId);
    await input.options.bus.publish(message.roomId, {
      type: "presence.joined",
      roomId: message.roomId,
      actorId: input.actor.id,
      entry,
      roster,
    });
    const receipts = await listRoomReadReceipts(input.options.store, input.actor, message.roomId);
    sendSocket(input.socket, {
      type: "subscribed",
      roomId: message.roomId,
      presence: roster,
      receipts,
    });
    return;
  }

  if (message.type === "send") {
    const stored = await input.options.store.sendMessage({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      roomId: message.roomId,
      body: message.body,
      bodyFormat: message.bodyFormat,
      attachmentObjectIds: message.attachmentObjectIds,
    });
    await input.options.presence.touch({ roomId: message.roomId, actor: input.actor });
    await input.options.bus.publish(message.roomId, {
      type: "message.created",
      roomId: message.roomId,
      actorId: input.actor.id,
      message: {
        ...stored,
        sentAt: stored.sentAt.toISOString(),
        editedAt: stored.editedAt?.toISOString() ?? null,
        deletedAt: stored.deletedAt?.toISOString() ?? null,
        createdAt: stored.createdAt.toISOString(),
        updatedAt: stored.updatedAt.toISOString(),
      },
    });
    return;
  }

  if (message.type === "typing") {
    await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
    await input.options.presence.touch({ roomId: message.roomId, actor: input.actor });
    await input.options.bus.publish(message.roomId, {
      type: "typing",
      roomId: message.roomId,
      actorId: input.actor.id,
      isTyping: message.isTyping,
    });
    return;
  }

  if (message.type === "read") {
    await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
    const receipt = await input.options.store.markRead({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      roomId: message.roomId,
      messageId: message.messageId,
    });
    await input.options.presence.touch({ roomId: message.roomId, actor: input.actor });
    await input.options.bus.publish(message.roomId, {
      type: "read",
      roomId: message.roomId,
      actorId: input.actor.id,
      receipt: serializeReadReceipt(receipt),
    });
    return;
  }

  await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
  const roster = await input.options.presence.list(message.roomId);
  sendSocket(input.socket, { type: "presence", roomId: message.roomId, presence: roster });
}

async function listRoomReadReceipts(
  store: ChatStore,
  actor: Actor,
  roomId: string,
): Promise<readonly ReturnType<typeof serializeReadReceipt>[]> {
  if (store.listReadReceipts === undefined) {
    return [];
  }
  const receipts = await store.listReadReceipts({
    orgId: actor.orgId,
    actorId: actor.id,
    roomId,
  });
  return receipts.map(serializeReadReceipt);
}

async function requireSocketRoomAccess(
  store: ChatStore,
  actor: Actor,
  roomId: string,
): Promise<void> {
  const room = await store.getRoomForActor({
    orgId: actor.orgId,
    actorId: actor.id,
    roomId,
  });
  if (room === null) {
    throw new Error(`Unknown or inaccessible chat room: ${roomId}`);
  }
}

function sendSocket(socket: ChatSocket, payload: ChatRoomEvent | Record<string, unknown>): void {
  socket.send(JSON.stringify(payload));
}

function rawToString(raw: Buffer | ArrayBuffer | string): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}
