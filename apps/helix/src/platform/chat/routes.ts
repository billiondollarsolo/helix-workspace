import type { Actor, JsonValue } from "@helix/sdk-types";
import {
  chatInboundFrameSchema,
  type ChatInboundFrame,
  type ChatPresenceStatus,
} from "@helix/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../../api/api-error.js";
import { unauthenticatedActor } from "../../api/actor.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import {
  consumeToken,
  createBucket,
  DEFAULT_CHAT_WS_RATE_LIMIT,
  type TokenBucketConfig,
} from "./core/rate-limit.js";
import { ChatRateLimitedError, ChatRoomAccessError } from "./errors.js";
import type { ChatPresenceStore, ChatRoomBus, ChatRoomEvent } from "./realtime.js";
import { InMemoryChatPresenceStore, InMemoryChatRoomBus } from "./realtime.js";
import type { ChatStore } from "./store.js";
import { serializeReadReceipt } from "./tools.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";

/** Route label for the chat WebSocket connection gauge. */
const CHAT_WS_ROUTE = "/ws/chat";

/** Close code sent to chat clients when the host is shutting down. */
const CHAT_SHUTDOWN_CLOSE_CODE = 1001;

/** Close code when auth is missing / invalid. */
const CHAT_AUTH_CLOSE_CODE = 4401;

/** Grace window to receive a first-frame `{ type: "auth", token }` message. */
const CHAT_AUTH_GRACE_MS = 5_000;

interface ChatSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface RegisterChatRoutesOptions {
  readonly store: ChatStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  /**
   * Resolve an actor from a bearer token (subprotocol or first-frame auth).
   * When omitted, tokens are attached to a synthetic Authorization header and
   * resolved via {@link actorFromRequest}.
   */
  readonly actorFromToken?: (token: string) => Actor | Promise<Actor>;
  readonly bus?: ChatRoomBus | undefined;
  readonly presence?: ChatPresenceStore | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly classifyResource?: ResourceClassifier | undefined;
  /** Per-connection token-bucket config (G3). Defaults match historical constants. */
  readonly rateLimit?: TokenBucketConfig | undefined;
  /** Auth grace window in ms for first-frame auth. */
  readonly authGraceMs?: number | undefined;
}

type ChatSocketOptions = {
  readonly store: ChatStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly actorFromToken?: ((token: string) => Actor | Promise<Actor>) | undefined;
  readonly bus: ChatRoomBus;
  readonly presence: ChatPresenceStore;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly classifyResource?: ResourceClassifier | undefined;
  readonly connections?: Set<ChatSocket> | undefined;
  readonly rateLimit?: TokenBucketConfig | undefined;
  readonly authGraceMs?: number | undefined;
};

export interface ChatRoutesHandle {
  broadcastShutdown(): void;
}

export async function registerChatRoutes(
  app: FastifyInstance,
  options: RegisterChatRoutesOptions,
): Promise<ChatRoutesHandle> {
  const bus = options.bus ?? new InMemoryChatRoomBus();
  const presence = options.presence ?? new InMemoryChatPresenceStore();
  const connections = new Set<ChatSocket>();
  const rateLimit = options.rateLimit ?? DEFAULT_CHAT_WS_RATE_LIMIT;
  const authGraceMs = options.authGraceMs ?? CHAT_AUTH_GRACE_MS;

  app.get("/ws/chat", { websocket: true }, async (socket, request) => {
    await handleChatSocket(socket as ChatSocket, request, {
      ...options,
      bus,
      presence,
      connections,
      rateLimit,
      authGraceMs,
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
  trackWebsocketConnection(socket, CHAT_WS_ROUTE, options.metrics);

  const rateLimit = options.rateLimit ?? DEFAULT_CHAT_WS_RATE_LIMIT;
  const authGraceMs = options.authGraceMs ?? CHAT_AUTH_GRACE_MS;
  const subscriptions = new Map<string, Awaited<ReturnType<ChatRoomBus["subscribe"]>>>();
  const rateLimitBucket = createBucket(rateLimit);
  let presenceStatus: ChatPresenceStatus = "available";
  options.connections?.add(socket);

  let actor: Actor | null = await resolveInitialActor(request, options);
  if (actor !== null && isUnauthenticated(actor)) {
    actor = null;
  }

  let authTimer: ReturnType<typeof setTimeout> | null = null;
  if (actor === null) {
    authTimer = setTimeout(() => {
      if (actor !== null) {
        return;
      }
      options.connections?.delete(socket);
      sendErrorFrame(
        socket,
        new ApiError("unauthenticated", "Chat WebSocket authentication required"),
      );
      socket.close(CHAT_AUTH_CLOSE_CODE, "auth required");
    }, authGraceMs);
  }

  const cleanupPresence = (resolved: Actor): void => {
    void Promise.allSettled([
      ...[...subscriptions.entries()].map(async ([roomId, unsubscribe]) => {
        await options.presence.remove({ roomId, actorId: resolved.id });
        await options.bus.publish(roomId, {
          type: "presence.left",
          roomId,
          actorId: resolved.id,
        });
        await unsubscribe();
      }),
    ]);
  };

  socket.on("message", (data) => {
    void (async () => {
      // Auth handshake when not yet resolved.
      if (actor === null) {
        try {
          const parsed = chatInboundFrameSchema.safeParse(JSON.parse(rawToString(data)));
          if (!parsed.success || parsed.data.type !== "auth") {
            sendErrorFrame(
              socket,
              new ApiError("unauthenticated", "Expected auth frame as first message"),
            );
            return;
          }
          const resolved = await resolveActorFromToken(parsed.data.token, options);
          if (resolved === null || isUnauthenticated(resolved)) {
            if (authTimer !== null) clearTimeout(authTimer);
            options.connections?.delete(socket);
            sendErrorFrame(socket, new ApiError("unauthenticated", "Invalid chat WebSocket token"));
            socket.close(CHAT_AUTH_CLOSE_CODE, "auth failed");
            return;
          }
          actor = resolved;
          if (authTimer !== null) clearTimeout(authTimer);
          sendSocket(socket, { type: "ready", actorId: resolved.id });
        } catch (error) {
          options.onError?.(error);
          sendErrorFrame(socket, error);
        }
        return;
      }

      if (!consumeToken(rateLimitBucket, rateLimit)) {
        sendErrorFrame(socket, new ChatRateLimitedError());
        return;
      }

      const resolved = actor;
      try {
        await handleInboundMessage({
          socket,
          actor: resolved,
          raw: data,
          subscriptions,
          options,
          getPresenceStatus: () => presenceStatus,
          setPresenceStatus: (status) => {
            presenceStatus = status;
          },
        });
      } catch (error) {
        options.onError?.(error);
        sendErrorFrame(socket, error);
      }
    })();
  });

  socket.on("close", () => {
    if (authTimer !== null) clearTimeout(authTimer);
    options.connections?.delete(socket);
    if (actor !== null) {
      cleanupPresence(actor);
    }
  });

  socket.on("error", (error) => {
    options.onError?.(error);
  });

  if (actor !== null) {
    sendSocket(socket, { type: "ready", actorId: actor.id });
  }
}

async function resolveInitialActor(
  request: FastifyRequest,
  options: ChatSocketOptions,
): Promise<Actor | null> {
  const protocolToken = bearerTokenFromSecWebSocketProtocol(request);
  if (protocolToken !== null) {
    return resolveActorFromToken(protocolToken, options);
  }
  // Cookie / Authorization header auth still works; query-param tokens are
  // intentionally ignored for chat WS (G6 leak risk).
  return options.actorFromRequest(stripAccessTokenQuery(request));
}

async function resolveActorFromToken(
  token: string,
  options: ChatSocketOptions,
): Promise<Actor | null> {
  if (options.actorFromToken !== undefined) {
    return options.actorFromToken(token);
  }
  const synthetic = {
    headers: { authorization: `Bearer ${token}` },
    query: {},
  } as unknown as FastifyRequest;
  return options.actorFromRequest(synthetic);
}

/**
 * Extract a bearer token from `Sec-WebSocket-Protocol`.
 * Supported forms:
 *   - `helix-bearer, <token>`
 *   - `helix-bearer.<token>`
 */
export function bearerTokenFromSecWebSocketProtocol(request: FastifyRequest): string | null {
  const raw = request.headers["sec-websocket-protocol"];
  if (raw === undefined) {
    return null;
  }
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) continue;
    if (part === "helix-bearer") {
      const next = parts[i + 1];
      if (next !== undefined && next.length > 0 && !next.startsWith("helix-")) {
        return next;
      }
    }
    if (part.startsWith("helix-bearer.")) {
      const token = part.slice("helix-bearer.".length);
      if (token.length > 0) {
        return token;
      }
    }
  }
  return null;
}

function stripAccessTokenQuery(request: FastifyRequest): FastifyRequest {
  if (typeof request.query !== "object" || request.query === null) {
    return request;
  }
  if (!("access_token" in (request.query as Record<string, unknown>))) {
    return request;
  }
  const { access_token: _ignored, ...rest } = request.query as Record<string, unknown>;
  return { ...request, query: rest };
}

function isUnauthenticated(actor: Actor): boolean {
  return actor.id === unauthenticatedActor.id || actor.id === "anonymous";
}

async function handleInboundMessage(input: {
  readonly socket: ChatSocket;
  readonly actor: Actor;
  readonly raw: Buffer | ArrayBuffer | string;
  readonly subscriptions: Map<string, Awaited<ReturnType<ChatRoomBus["subscribe"]>>>;
  readonly options: ChatSocketOptions;
  readonly getPresenceStatus: () => ChatPresenceStatus;
  readonly setPresenceStatus: (status: ChatPresenceStatus) => void;
}): Promise<void> {
  const message: ChatInboundFrame = chatInboundFrameSchema.parse(
    JSON.parse(rawToString(input.raw)),
  );

  if (message.type === "auth") {
    return;
  }

  if (message.type === "presence.set") {
    input.setPresenceStatus(message.status);
    await Promise.all(
      [...input.subscriptions.keys()].map(async (roomId) => {
        const entry = await input.options.presence.touch({
          roomId,
          actor: input.actor,
          status: message.status,
        });
        await input.options.bus.publish(roomId, {
          type: "presence.joined",
          roomId,
          actorId: input.actor.id,
          status: message.status,
          entry,
          roster: await input.options.presence.list(roomId),
        });
      }),
    );
    return;
  }

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
      status: input.getPresenceStatus(),
    });
    const roster = await input.options.presence.list(message.roomId);
    await input.options.bus.publish(message.roomId, {
      type: "presence.joined",
      roomId: message.roomId,
      actorId: input.actor.id,
      status: entry.status,
      entry,
      roster,
    });
    const receipts = await listRoomReadReceipts(input.options.store, input.actor, message.roomId);
    sendSocket(input.socket, {
      type: "subscribed",
      roomId: message.roomId,
      presence: roster,
      receipts,
      members: roster.map((e) => ({ actorId: e.actorId, status: e.status })),
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
      ...(message.clientMessageId === undefined
        ? {}
        : { clientMessageId: message.clientMessageId }),
      ...(message.parentMessageId === undefined
        ? {}
        : { parentMessageId: message.parentMessageId }),
    });
    await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      status: input.getPresenceStatus(),
    });
    if (input.options.classifyResource !== undefined) {
      await input.options.classifyResource({
        actor: input.actor,
        resourceType: "chat.message",
        resourceId: stored.id,
        derivation: { content: message.body, scanContent: true },
      });
    }
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
        ...(stored.parentMessageId === undefined || stored.parentMessageId === null
          ? {}
          : { parentMessageId: stored.parentMessageId }),
        ...(stored.clientMessageId === undefined
          ? {}
          : { clientMessageId: stored.clientMessageId }),
      } as JsonValue,
    });
    return;
  }

  if (message.type === "typing") {
    await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
    await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      status: input.getPresenceStatus(),
    });
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
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
    });
    await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      status: input.getPresenceStatus(),
    });
    await input.options.bus.publish(message.roomId, {
      type: "read",
      roomId: message.roomId,
      actorId: input.actor.id,
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      receipt: serializeReadReceipt(receipt),
    });
    return;
  }

  await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
  const roster = await input.options.presence.list(message.roomId);
  sendSocket(input.socket, {
    type: "presence",
    roomId: message.roomId,
    presence: roster,
    members: roster.map((e) => ({ actorId: e.actorId, status: e.status })),
  });
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
    throw new ChatRoomAccessError(roomId);
  }
}

function sendErrorFrame(socket: ChatSocket, error: unknown): void {
  if (error instanceof ApiError) {
    sendSocket(socket, {
      type: "error",
      code: error.code,
      message: error.message,
    });
    return;
  }
  sendSocket(socket, {
    type: "error",
    code: "internal_error",
    message: error instanceof Error ? error.message : "Chat message failed",
  });
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
