import { randomUUID } from "node:crypto";
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
import type { ChatPresenceStore, ChatRoomBus, ChatRoomEvent, PresenceEntry } from "./realtime.js";
import { InMemoryChatPresenceStore, InMemoryChatRoomBus } from "./realtime.js";
import type { ChatStore } from "./store.js";
import type { ChatRoomRecord } from "./types.js";
import { serializeReadReceipt } from "./tools.js";
import {
  evaluateWebSocketOrigin,
  type WebSocketOriginDecision,
} from "../security/origin-policy.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";

/** Route label for the chat WebSocket connection gauge. */
const CHAT_WS_ROUTE = "/ws/chat";

/** Close code sent to chat clients when the host is shutting down. */
const CHAT_SHUTDOWN_CLOSE_CODE = 1001;
const CHAT_SLOW_CONSUMER_CLOSE_CODE = 1013;
const CHAT_MAX_BUFFERED_BYTES = 1024 * 1024;

/** Close code when auth is missing / invalid. */
const CHAT_AUTH_CLOSE_CODE = 4401;

/** Close code for a rejected browser Origin / CSWSH attempt. */
const CHAT_ORIGIN_CLOSE_CODE = 4403;

/** Grace window to receive a first-frame `{ type: "auth", token }` message. */
const CHAT_AUTH_GRACE_MS = 5_000;

/** Prevent an unauthenticated connection from buffering an unbounded credential. */
const CHAT_MAX_BEARER_TOKEN_LENGTH = 4_096;

/** JSON envelope overhead permitted around the bounded first-frame token. */
const CHAT_MAX_AUTH_FRAME_BYTES = CHAT_MAX_BEARER_TOKEN_LENGTH + 256;

interface ChatSocket {
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface RegisterChatRoutesOptions {
  readonly store: ChatStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  /** Canonical exact origins parsed from BETTER_AUTH_TRUSTED_ORIGINS. */
  readonly trustedOrigins: readonly string[];
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
  readonly trustedOrigins: readonly string[];
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

  const originDecision = evaluateWebSocketOrigin(request, options.trustedOrigins);
  if (!originDecision.allowed) {
    socket.close(CHAT_ORIGIN_CLOSE_CODE, "origin rejected");
    return;
  }

  const rateLimit = options.rateLimit ?? DEFAULT_CHAT_WS_RATE_LIMIT;
  const authGraceMs = options.authGraceMs ?? CHAT_AUTH_GRACE_MS;
  const subscriptions = new Map<string, Awaited<ReturnType<ChatRoomBus["subscribe"]>>>();
  const rateLimitBucket = createBucket(rateLimit);
  let presenceStatus: ChatPresenceStatus = "available";
  options.connections?.add(socket);

  let actor: Actor | null;
  try {
    actor = await resolveInitialActor(request, options, originDecision);
  } catch {
    // Authentication adapters are not permitted to leak the presented token
    // through an error message or structured log field.
    socket.close(CHAT_AUTH_CLOSE_CODE, "auth failed");
    return;
  }
  if (actor !== null && isUnauthenticated(actor)) {
    actor = null;
  }

  let authTimer: ReturnType<typeof setTimeout> | null = null;
  if (actor === null) {
    if (originDecision.browser) {
      sendErrorFrame(
        socket,
        new ApiError("unauthenticated", "Chat WebSocket session authentication required"),
      );
      socket.close(CHAT_AUTH_CLOSE_CODE, "auth required");
      return;
    }
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

  /* Shared tail for every first-frame auth rejection: cancel the grace timer,
     drop the socket from the shutdown broadcast set, then tell the client. */
  function rejectInvalidToken(): void {
    if (authTimer !== null) clearTimeout(authTimer);
    options.connections?.delete(socket);
    sendErrorFrame(socket, new ApiError("unauthenticated", "Invalid chat WebSocket token"));
    socket.close(CHAT_AUTH_CLOSE_CODE, "auth failed");
  }

  const cleanupPresence = (resolved: Actor): void => {
    void Promise.allSettled([
      ...[...subscriptions.entries()].map(async ([roomId, unsubscribe]) => {
        await options.presence.remove({ roomId, actorId: resolved.id });
        await options.bus.publish(resolved.orgId, roomId, {
          type: "presence.left",
          eventId: randomUUID(),
          orgId: resolved.orgId,
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
          const raw = rawToString(data);
          if (Buffer.byteLength(raw, "utf8") > CHAT_MAX_AUTH_FRAME_BYTES) {
            throw new TypeError("Chat WebSocket authentication frame is too large.");
          }
          const parsed = chatInboundFrameSchema.safeParse(JSON.parse(raw));
          if (
            !parsed.success ||
            parsed.data.type !== "auth" ||
            parsed.data.token.length > CHAT_MAX_BEARER_TOKEN_LENGTH
          ) {
            sendErrorFrame(
              socket,
              new ApiError("unauthenticated", "Expected auth frame as first message"),
            );
            if (authTimer !== null) clearTimeout(authTimer);
            options.connections?.delete(socket);
            socket.close(CHAT_AUTH_CLOSE_CODE, "auth failed");
            return;
          }
          const resolved = await resolveActorFromToken(parsed.data.token, options);
          if (resolved === null || isUnauthenticated(resolved)) {
            rejectInvalidToken();
            return;
          }
          actor = resolved;
          if (authTimer !== null) clearTimeout(authTimer);
          sendSocket(socket, { type: "ready", actorId: resolved.id });
        } catch {
          // Deliberately generic: auth adapter exceptions may contain a
          // credential and must not reach logs or the client.
          rejectInvalidToken();
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
  originDecision: Extract<WebSocketOriginDecision, { readonly allowed: true }>,
): Promise<Actor | null> {
  // Browser sockets authenticate exclusively through the ordinary request
  // resolver, which prefers the Secure/HttpOnly session cookie. They do not
  // consume bearer tokens from a protocol header or first message.
  if (originDecision.browser || originDecision.initialCredential) {
    const actor = await options.actorFromRequest(stripAccessTokenQuery(request));
    if (!isUnauthenticated(actor)) {
      return actor;
    }
    if (originDecision.browser) {
      return null;
    }
  }

  // Cookie-free clients without Origin are the bounded service/CLI path.
  // Query-param tokens are always ignored (G6 leak risk).
  const protocolToken = bearerTokenFromSecWebSocketProtocol(request);
  return protocolToken === null ? null : resolveActorFromToken(protocolToken, options);
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
 * The bounded legacy service-client form is `helix-bearer, <token>`.
 *
 * The `helix-bearer.<token>` form is intentionally rejected because a
 * WebSocket server may echo the selected protocol value in its response.
 * Browser clients do not use this function at all.
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
      if (
        next !== undefined &&
        next.length > 0 &&
        next.length <= CHAT_MAX_BEARER_TOKEN_LENGTH &&
        !next.startsWith("helix-")
      ) {
        return next;
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
        const room = await input.options.store.getRoomForActor({
          orgId: input.actor.orgId,
          actorId: input.actor.id,
          roomId,
        });
        if (room === null) {
          await dropSocketRoom(input, roomId);
          return;
        }
        const entry = await input.options.presence.touch({
          roomId,
          actor: input.actor,
          status: message.status,
        });
        await input.options.bus.publish(input.actor.orgId, roomId, {
          type: "presence.joined",
          eventId: randomUUID(),
          orgId: input.actor.orgId,
          roomId,
          actorId: input.actor.id,
          status: message.status,
          entry,
          roster: filterRoomPresence(room, await input.options.presence.list(roomId)),
        });
      }),
    );
    return;
  }

  if (message.type === "subscribe") {
    const room = await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
    if (!input.subscriptions.has(message.roomId)) {
      const unsubscribe = await input.options.bus.subscribe(
        input.actor.orgId,
        message.roomId,
        async (event) => {
          const currentRoom = await input.options.store.getRoomForActor({
            orgId: input.actor.orgId,
            actorId: input.actor.id,
            roomId: message.roomId,
          });
          if (currentRoom === null) {
            await dropSocketRoom(input, message.roomId);
            return;
          }
          if (!sendSocket(input.socket, event)) {
            await dropSocketRoom(input, message.roomId);
          }
        },
      );
      input.subscriptions.set(message.roomId, unsubscribe);
    }
    const entry = await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      status: input.getPresenceStatus(),
    });
    const roster = filterRoomPresence(room, await input.options.presence.list(message.roomId));
    await input.options.bus.publish(input.actor.orgId, message.roomId, {
      type: "presence.joined",
      eventId: randomUUID(),
      orgId: input.actor.orgId,
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
      members: presenceMembers(roster),
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
    await input.options.bus.publish(input.actor.orgId, message.roomId, {
      type: "message.created",
      eventId: randomUUID(),
      orgId: input.actor.orgId,
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
    await input.options.bus.publish(input.actor.orgId, message.roomId, {
      type: "typing",
      eventId: randomUUID(),
      orgId: input.actor.orgId,
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
    await input.options.bus.publish(input.actor.orgId, message.roomId, {
      type: "read",
      eventId: randomUUID(),
      orgId: input.actor.orgId,
      roomId: message.roomId,
      actorId: input.actor.id,
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      receipt: serializeReadReceipt(receipt),
    });
    return;
  }

  const room = await requireSocketRoomAccess(input.options.store, input.actor, message.roomId);
  const roster = filterRoomPresence(room, await input.options.presence.list(message.roomId));
  sendSocket(input.socket, {
    type: "presence",
    roomId: message.roomId,
    presence: roster,
    members: presenceMembers(roster),
  });
}

/** The trimmed member roster carried alongside the full presence entries. */
function presenceMembers(
  roster: readonly PresenceEntry[],
): readonly { readonly actorId: string; readonly status: ChatPresenceStatus }[] {
  return roster.map((entry) => ({ actorId: entry.actorId, status: entry.status }));
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
): Promise<ChatRoomRecord> {
  const room = await store.getRoomForActor({
    orgId: actor.orgId,
    actorId: actor.id,
    roomId,
  });
  if (room === null) {
    throw new ChatRoomAccessError();
  }
  return room;
}

async function dropSocketRoom(
  input: {
    readonly actor: Actor;
    readonly subscriptions: Map<string, Awaited<ReturnType<ChatRoomBus["subscribe"]>>>;
    readonly options: ChatSocketOptions;
  },
  roomId: string,
): Promise<void> {
  const unsubscribe = input.subscriptions.get(roomId);
  input.subscriptions.delete(roomId);
  await input.options.presence.remove({ roomId, actorId: input.actor.id });
  await unsubscribe?.();
}

function filterRoomPresence(
  room: ChatRoomRecord,
  entries: readonly PresenceEntry[],
): readonly PresenceEntry[] {
  const memberIds = new Set(room.members.map((member) => member.actorId));
  return entries.filter((entry) => entry.orgId === room.orgId && memberIds.has(entry.actorId));
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

function sendSocket(socket: ChatSocket, payload: ChatRoomEvent | Record<string, unknown>): boolean {
  if ((socket.bufferedAmount ?? 0) > CHAT_MAX_BUFFERED_BYTES) {
    socket.close(CHAT_SLOW_CONSUMER_CLOSE_CODE, "slow consumer");
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
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
