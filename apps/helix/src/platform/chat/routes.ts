import {
  chatInboundFrameSchema,
  type ChatInboundFrame,
  type ChatPresenceStatus,
} from "@helix/contracts";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { unauthenticatedActor } from "../../api/actor.js";
import { ApiError, UnauthorizedError } from "../../api/api-error.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import { dlpDecisionError, type DlpGuard } from "../dlp.js";
import { evaluateWebSocketOrigin } from "../security/origin-policy.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";
import { registerChatAttachmentRoutes, type ChatAttachmentStore } from "./attachments.js";
import {
  consumeToken,
  createBucket,
  DEFAULT_CHAT_WS_RATE_LIMIT,
  type TokenBucketConfig,
} from "./core/rate-limit.js";
import { ChatRateLimitedError, ChatRoomAccessError } from "./errors.js";
import type { ChatPresenceStore, ChatRoomBus, ChatRoomEvent, PresenceEntry } from "./realtime.js";
import { isDurableChatRoomEvent } from "./realtime.js";
import { chatMessageCreatedEvent, chatReadEvent, type ChatStore } from "./store.js";
import { serializeReadReceipt } from "./tools.js";
import {
  CHAT_WEBSOCKET_AUDIENCE,
  CHAT_WEBSOCKET_PATH,
  chatWebSocketTicketFromProtocols,
  type ChatWebSocketTicketStore,
} from "./websocket-tickets.js";

/** Route label for the chat WebSocket connection gauge. */
const CHAT_WS_ROUTE = CHAT_WEBSOCKET_PATH;

const chatWebSocketTicketRequestSchema = z.object({ roomId: z.string().uuid() }).strict();
const chatEventParamsSchema = z.object({ roomId: z.string().uuid() }).strict();
const chatEventQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().positive().max(100).default(100),
  })
  .strict();

/** Close code sent to chat clients when the host is shutting down. */
const CHAT_SHUTDOWN_CLOSE_CODE = 1001;

/** Close code when auth is missing / invalid. */
const CHAT_AUTH_CLOSE_CODE = 4401;

/** Standard WebSocket close codes for client abuse and server backpressure. */
const CHAT_POLICY_CLOSE_CODE = 1008;
const CHAT_PAYLOAD_CLOSE_CODE = 1009;
const CHAT_DEADLINE_CLOSE_CODE = 1011;
const CHAT_BACKPRESSURE_CLOSE_CODE = 1013;
const CHAT_RESYNC_CLOSE_CODE = 1012;

const CHAT_MAX_PAYLOAD_BYTES = 64 * 1024;
const CHAT_MAX_PENDING_FRAMES = 32;
const CHAT_FRAME_DEADLINE_MS = 10_000;
const CHAT_REPLAY_BATCH_SIZE = 100;
const CHAT_MAX_CONNECTIONS_PER_MEMBER = 8;

interface ChatSocket {
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

interface ChatSubscription {
  unsubscribe: Awaited<ReturnType<ChatRoomBus["subscribe"]>>;
  cursor: number;
  desiredCursor: number;
  catchUp: Promise<boolean> | undefined;
  closed: boolean;
}

export interface RegisterChatRoutesOptions {
  readonly trustedOrigins: readonly string[];
  readonly store: ChatStore;
  readonly attachments?: ChatAttachmentStore | undefined;
  readonly tickets: ChatWebSocketTicketStore;
  /** Must resolve only a browser session; bearer/API credentials cannot mint tickets. */
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly bus: ChatRoomBus;
  readonly presence: ChatPresenceStore;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly classifyResource?: ResourceClassifier | undefined;
  readonly dlp?: DlpGuard;
  /** Per-connection token-bucket config (G3). Defaults match historical constants. */
  readonly rateLimit?: TokenBucketConfig | undefined;
  /** Maximum UTF-8/binary bytes accepted in one inbound frame. */
  readonly maxPayloadBytes?: number | undefined;
  /** Maximum accepted frames per socket, including the one being processed. */
  readonly maxPendingFrames?: number | undefined;
  /** Maximum wall-clock time allowed for one frame's complete async work. */
  readonly frameDeadlineMs?: number | undefined;
  /** Aggregate tab/device limit for one tenant membership. */
  readonly maxConnectionsPerMember?: number | undefined;
}

type ChatSocketOptions = {
  readonly trustedOrigins: readonly string[];
  readonly store: ChatStore;
  readonly tickets: ChatWebSocketTicketStore;
  readonly bus: ChatRoomBus;
  readonly presence: ChatPresenceStore;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly classifyResource?: ResourceClassifier | undefined;
  readonly dlp?: DlpGuard;
  readonly connections?: Set<ChatSocket> | undefined;
  readonly rateLimit?: TokenBucketConfig | undefined;
  readonly maxPayloadBytes?: number | undefined;
  readonly maxPendingFrames?: number | undefined;
  readonly frameDeadlineMs?: number | undefined;
  readonly maxConnectionsPerMember?: number | undefined;
};

export interface ChatRoutesHandle {
  broadcastShutdown(): void;
}

export async function registerChatRoutes(
  app: FastifyInstance,
  options: RegisterChatRoutesOptions,
): Promise<ChatRoutesHandle> {
  const { bus, presence } = options;
  const connections = new Set<ChatSocket>();
  const rateLimit = options.rateLimit ?? DEFAULT_CHAT_WS_RATE_LIMIT;

  if (options.attachments !== undefined) {
    await registerChatAttachmentRoutes(app, {
      store: options.attachments,
      actorFromRequest: options.actorFromRequest,
      ...(options.dlp === undefined ? {} : { dlp: options.dlp }),
    });
  }

  app.post("/api/chat/ws-ticket", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      throw new UnauthorizedError("A browser session is required to open Chat realtime.");
    }
    const { roomId } = chatWebSocketTicketRequestSchema.parse(request.body);
    await requireSocketRoomAccess(options.store, actor, roomId);
    const issued = await options.tickets.issue({
      actor,
      roomId,
      audience: CHAT_WEBSOCKET_AUDIENCE,
      path: CHAT_WS_ROUTE,
    });
    reply.header("cache-control", "no-store");
    return { ticket: issued.ticket, expiresAt: issued.expiresAt.toISOString() };
  });

  app.get("/api/chat/rooms/:roomId/events", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (isUnauthenticated(actor)) {
      throw new UnauthorizedError("A browser session is required to replay Chat events.");
    }
    const { roomId } = chatEventParamsSchema.parse(request.params);
    const query = chatEventQuerySchema.parse(request.query);
    await requireSocketRoomAccess(options.store, actor, roomId);
    const replay = await bus.replay({
      orgId: actor.orgId,
      actorId: actor.id,
      roomId,
      after: query.cursor,
      limit: query.limit,
    });
    if (!replay.authorized) {
      throw new ChatRoomAccessError(roomId);
    }
    reply.header("cache-control", "no-store");
    return {
      events: replay.events,
      cursor: replay.cursor,
      latestCursor: replay.latestCursor,
      hasMore: replay.hasMore,
      resetRequired: replay.resetRequired,
    };
  });

  app.get("/ws/chat", { websocket: true }, async (socket, request) => {
    await handleChatSocket(socket as ChatSocket, request, {
      ...options,
      bus,
      presence,
      connections,
      rateLimit,
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
  if (!evaluateWebSocketOrigin(request, options.trustedOrigins).allowed) {
    socket.close(4403, "origin rejected");
    return;
  }

  const rateLimit = options.rateLimit ?? DEFAULT_CHAT_WS_RATE_LIMIT;
  const subscriptions = new Map<string, ChatSubscription>();
  const rateLimitBucket = createBucket(rateLimit);
  const maxPayloadBytes = options.maxPayloadBytes ?? CHAT_MAX_PAYLOAD_BYTES;
  const maxPendingFrames = options.maxPendingFrames ?? CHAT_MAX_PENDING_FRAMES;
  const frameDeadlineMs = options.frameDeadlineMs ?? CHAT_FRAME_DEADLINE_MS;
  const maxConnectionsPerMember = Math.min(
    64,
    Math.max(1, Math.trunc(options.maxConnectionsPerMember ?? CHAT_MAX_CONNECTIONS_PER_MEMBER)),
  );
  const connectionId = randomUUID();
  let connected = false;
  let presenceStatus: ChatPresenceStatus = "available";
  let acceptingFrames = true;
  let pendingFrames = 0;
  let frameQueue = Promise.resolve();

  const closeSocket = (code: number, reason: string): void => {
    if (!acceptingFrames) {
      return;
    }
    acceptingFrames = false;
    options.connections?.delete(socket);
    socket.close(code, reason);
  };
  const rejectSocket = (frameCode: string, message: string, code: number, reason: string): void => {
    if (!acceptingFrames) {
      return;
    }
    try {
      sendSocket(socket, { type: "error", code: frameCode, message });
    } catch (error) {
      options.onError?.(error);
    }
    closeSocket(code, reason);
  };
  const ticket = chatWebSocketTicketFromProtocols(request.headers["sec-websocket-protocol"]);
  const redeemed =
    ticket === null
      ? null
      : await options.tickets.consume({
          ticket,
          audience: CHAT_WEBSOCKET_AUDIENCE,
          path: CHAT_WS_ROUTE,
        });
  if (redeemed === null) {
    rejectSocket(
      "unauthenticated",
      "A valid one-time Chat WebSocket ticket is required",
      CHAT_AUTH_CLOSE_CODE,
      "auth required",
    );
    return;
  }
  const { actor, roomId: authorizedRoomId } = redeemed;
  const room = await withSocketActorContext(options.store, actor, (store) =>
    store.getRoomForActor({
      orgId: actor.orgId,
      actorId: actor.id,
      roomId: authorizedRoomId,
    }),
  );
  if (room === null) {
    rejectSocket("forbidden", "Chat room access denied", CHAT_POLICY_CLOSE_CODE, "access denied");
    return;
  }
  connected = await options.presence.connect({
    orgId: actor.orgId,
    actorId: actor.id,
    connectionId,
    limit: maxConnectionsPerMember,
  });
  if (!connected) {
    rejectSocket(
      "connection_limit",
      "Too many Chat connections for this member.",
      CHAT_POLICY_CLOSE_CODE,
      "connection limit exceeded",
    );
    return;
  }
  options.connections?.add(socket);

  const cleanupPresence = (resolved: Actor): void => {
    void Promise.allSettled([
      ...[...subscriptions.entries()].map(async ([roomId, subscription]) => {
        subscription.closed = true;
        const before = (await options.presence.list(roomId)).find(
          (entry) => entry.actorId === resolved.id,
        );
        await options.presence.remove({ roomId, actorId: resolved.id, connectionId });
        const after = (await options.presence.list(roomId)).find(
          (entry) => entry.actorId === resolved.id,
        );
        if (before !== undefined && after === undefined) {
          await options.bus.publish(resolved.orgId, roomId, {
            type: "presence.left",
            roomId,
            orgId: resolved.orgId,
            actorId: resolved.id,
          });
        } else if (after !== undefined && after.status !== before?.status) {
          await options.bus.publish(resolved.orgId, roomId, {
            type: "presence.joined",
            roomId,
            orgId: resolved.orgId,
            actorId: resolved.id,
            status: after.status,
          });
        }
        await subscription.unsubscribe();
      }),
      ...(connected
        ? [
            options.presence.disconnect({
              orgId: resolved.orgId,
              actorId: resolved.id,
              connectionId,
            }),
          ]
        : []),
    ]);
    connected = false;
  };

  socket.on("message", (data) => {
    if (!acceptingFrames) {
      return;
    }
    if (rawByteLength(data) > maxPayloadBytes) {
      rejectSocket(
        "payload_too_large",
        "Chat WebSocket frame exceeds the payload limit.",
        CHAT_PAYLOAD_CLOSE_CODE,
        "payload too large",
      );
      return;
    }
    if (!consumeToken(rateLimitBucket, rateLimit)) {
      const error = new ChatRateLimitedError();
      rejectSocket(error.code, error.message, CHAT_POLICY_CLOSE_CODE, "rate limit exceeded");
      return;
    }
    if (pendingFrames >= maxPendingFrames) {
      rejectSocket(
        "backpressure",
        "Chat WebSocket has too many pending frames.",
        CHAT_BACKPRESSURE_CLOSE_CODE,
        "too many pending frames",
      );
      return;
    }

    pendingFrames += 1;
    frameQueue = frameQueue
      .then(async () => {
        if (!acceptingFrames) {
          return;
        }
        await withDeadline(
          (async () => {
            const renewed = await options.presence.connect({
              orgId: actor.orgId,
              actorId: actor.id,
              connectionId,
              limit: maxConnectionsPerMember,
            });
            if (!renewed) {
              rejectSocket(
                "connection_limit",
                "Chat connection lease expired.",
                CHAT_POLICY_CLOSE_CODE,
                "connection limit exceeded",
              );
              return;
            }
            await handleInboundMessage({
              socket,
              actor,
              authorizedRoomId,
              raw: data,
              subscriptions,
              options,
              connectionId,
              getPresenceStatus: () => presenceStatus,
              setPresenceStatus: (status) => {
                presenceStatus = status;
              },
              denyAccess: () => {
                rejectSocket(
                  "forbidden",
                  "Chat room access denied",
                  CHAT_POLICY_CLOSE_CODE,
                  "access denied",
                );
              },
            });
          })(),
          frameDeadlineMs,
        );
      })
      .catch((error: unknown) => {
        if (!acceptingFrames) {
          return;
        }
        if (error instanceof ChatFrameDeadlineError) {
          options.onError?.(error);
          rejectSocket(
            "deadline_exceeded",
            "Chat WebSocket frame processing exceeded its deadline.",
            CHAT_DEADLINE_CLOSE_CODE,
            "frame deadline exceeded",
          );
          return;
        }
        if (error instanceof ChatRoomAccessError) {
          rejectSocket(
            "forbidden",
            "Chat room access denied",
            CHAT_POLICY_CLOSE_CODE,
            "access denied",
          );
          return;
        }
        options.onError?.(error);
        sendErrorFrame(socket, error);
      })
      .finally(() => {
        pendingFrames -= 1;
      });
  });

  socket.on("close", () => {
    acceptingFrames = false;
    options.connections?.delete(socket);
    cleanupPresence(actor);
  });

  socket.on("error", (error) => {
    options.onError?.(error);
  });

  sendSocket(socket, { type: "ready", actorId: actor.id });
}

function isUnauthenticated(actor: Actor): boolean {
  return actor.id === unauthenticatedActor.id || actor.id === "anonymous";
}

async function handleInboundMessage(input: {
  readonly socket: ChatSocket;
  readonly actor: Actor;
  readonly authorizedRoomId: string;
  readonly raw: Buffer | ArrayBuffer | string;
  readonly subscriptions: Map<string, ChatSubscription>;
  readonly options: ChatSocketOptions;
  readonly connectionId: string;
  readonly getPresenceStatus: () => ChatPresenceStatus;
  readonly setPresenceStatus: (status: ChatPresenceStatus) => void;
  readonly denyAccess: () => void;
}): Promise<void> {
  const message: ChatInboundFrame = chatInboundFrameSchema.parse(
    JSON.parse(rawToString(input.raw)),
  );

  if ("roomId" in message && message.roomId !== input.authorizedRoomId) {
    throw new ChatRoomAccessError(message.roomId);
  }
  await withSocketActorContext(input.options.store, input.actor, (store) =>
    requireSocketRoomAccess(store, input.actor, input.authorizedRoomId),
  );

  if (message.type === "heartbeat") {
    await Promise.all(
      [...input.subscriptions.keys()].map((roomId) =>
        input.options.presence.touch({
          roomId,
          actor: input.actor,
          connectionId: input.connectionId,
          status: input.getPresenceStatus(),
        }),
      ),
    );
    return;
  }

  if (message.type === "presence.set") {
    input.setPresenceStatus(message.status);
    await Promise.all(
      [...input.subscriptions.keys()].map(async (roomId) => {
        const entry = await input.options.presence.touch({
          roomId,
          actor: input.actor,
          connectionId: input.connectionId,
          status: message.status,
        });
        await input.options.bus.publish(
          input.actor.orgId,
          roomId,
          entry.status === "invisible"
            ? {
                type: "presence.left",
                roomId,
                orgId: input.actor.orgId,
                actorId: input.actor.id,
              }
            : {
                type: "presence.joined",
                roomId,
                orgId: input.actor.orgId,
                actorId: input.actor.id,
                status: entry.status,
                entry,
              },
        );
      }),
    );
    return;
  }

  if (message.type === "subscribe") {
    if (!input.subscriptions.has(message.roomId)) {
      const subscription: ChatSubscription = {
        unsubscribe: () => undefined,
        cursor: subscribeCursor(message),
        desiredCursor: subscribeCursor(message),
        catchUp: undefined,
        closed: false,
      };
      const unsubscribe = await input.options.bus.subscribe(
        input.actor.orgId,
        message.roomId,
        async (event) => {
          if (
            subscription.closed ||
            event.roomId !== message.roomId ||
            event.orgId !== input.actor.orgId
          ) {
            return;
          }
          try {
            await withSocketActorContext(input.options.store, input.actor, (store) =>
              requireSocketRoomAccess(store, input.actor, message.roomId),
            );
          } catch (error) {
            if (error instanceof ChatRoomAccessError) {
              subscription.closed = true;
              input.denyAccess();
              return;
            }
            throw error;
          }
          if (isDurableChatRoomEvent(event)) {
            if (!isEventCursor(event.cursor)) {
              throw new TypeError("Durable Chat event is missing its cursor.");
            }
            subscription.desiredCursor = Math.max(subscription.desiredCursor, event.cursor);
            await catchUpRoomEvents({
              socket: input.socket,
              actor: input.actor,
              roomId: message.roomId,
              subscription,
              options: input.options,
              denyAccess: input.denyAccess,
            });
            return;
          }
          if (
            (event.type === "presence.joined" || event.type === "presence.left") &&
            typeof event.actorId === "string" &&
            !(await canSeePresence(input.options.store, input.actor, event.actorId))
          ) {
            return;
          }
          sendSocket(input.socket, event);
        },
      );
      subscription.unsubscribe = unsubscribe;
      input.subscriptions.set(message.roomId, subscription);
      const caughtUp = await catchUpRoomEvents({
        socket: input.socket,
        actor: input.actor,
        roomId: message.roomId,
        subscription,
        options: input.options,
        denyAccess: input.denyAccess,
      });
      if (!caughtUp) {
        return;
      }
    }
    const subscription = input.subscriptions.get(message.roomId);
    if (subscription === undefined || subscription.closed) {
      return;
    }
    const entry = await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      connectionId: input.connectionId,
      status: input.getPresenceStatus(),
    });
    const roster = await visiblePresence(
      input.options.store,
      input.actor,
      await input.options.presence.list(message.roomId),
    );
    if (entry.status !== "invisible") {
      await input.options.bus.publish(input.actor.orgId, message.roomId, {
        type: "presence.joined",
        roomId: message.roomId,
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        status: entry.status,
        entry,
      });
    }
    const receipts = await withSocketActorContext(input.options.store, input.actor, (store) =>
      listRoomReadReceipts(store, input.actor, message.roomId),
    );
    sendSocket(input.socket, {
      type: "subscribed",
      roomId: message.roomId,
      cursor: subscription.cursor,
      presence: roster,
      receipts,
      members: roster.map((e) => ({ actorId: e.actorId, status: e.status })),
    });
    return;
  }

  if (message.type === "send") {
    if (input.options.dlp !== undefined) {
      const decision = await input.options.dlp.evaluate({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        boundary: message.attachmentObjectIds.length === 0 ? "chat_message" : "chat_attachment",
        content: message.body,
        resources: message.attachmentObjectIds.map((resourceId) => ({
          resourceType: "drive.file",
          resourceId,
        })),
      });
      if (decision.action === "block" || decision.action === "quarantine") {
        throw dlpDecisionError(decision);
      }
      if (decision.action === "warn") {
        sendSocket(input.socket, {
          type: "dlp.warning",
          boundary: decision.boundary,
          classification: decision.classification,
        });
      }
    }
    const stored = await withSocketActorContext(input.options.store, input.actor, (store) =>
      store.sendMessage({
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
      }),
    );
    await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      connectionId: input.connectionId,
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
    await input.options.bus.publish(
      input.actor.orgId,
      message.roomId,
      chatMessageCreatedEvent(stored),
    );
    return;
  }

  if (message.type === "typing") {
    await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      connectionId: input.connectionId,
      status: input.getPresenceStatus(),
    });
    await input.options.bus.publish(input.actor.orgId, message.roomId, {
      type: "typing",
      roomId: message.roomId,
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      isTyping: message.isTyping,
    });
    return;
  }

  if (message.type === "read") {
    const receipt = await withSocketActorContext(input.options.store, input.actor, (store) =>
      store.markRead({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        roomId: message.roomId,
        messageId: message.messageId,
      }),
    );
    await input.options.presence.touch({
      roomId: message.roomId,
      actor: input.actor,
      connectionId: input.connectionId,
      status: input.getPresenceStatus(),
    });
    if (receipt.isShared && receipt.realtimeCursor !== null) {
      await input.options.bus.publish(input.actor.orgId, message.roomId, chatReadEvent(receipt));
    }
    return;
  }

  const roster = await visiblePresence(
    input.options.store,
    input.actor,
    await input.options.presence.list(message.roomId),
  );
  sendSocket(input.socket, {
    type: "presence",
    roomId: message.roomId,
    presence: roster,
    members: roster.map((e) => ({ actorId: e.actorId, status: e.status })),
  });
}

async function visiblePresence(
  store: ChatStore,
  actor: Actor,
  roster: readonly PresenceEntry[],
): Promise<readonly PresenceEntry[]> {
  if (store.listPresenceBlockedActorIds === undefined || roster.length === 0) return roster;
  const blocked = new Set(
    await withSocketActorContext(store, actor, (scoped) => {
      if (scoped.listPresenceBlockedActorIds === undefined) return Promise.resolve([]);
      return scoped.listPresenceBlockedActorIds({
        orgId: actor.orgId,
        actorId: actor.id,
        candidateActorIds: roster.map((entry) => entry.actorId),
      });
    }),
  );
  return roster.filter((entry) => !blocked.has(entry.actorId));
}

async function canSeePresence(
  store: ChatStore,
  actor: Actor,
  subjectActorId: string,
): Promise<boolean> {
  return (
    (
      await visiblePresence(store, actor, [
        { actorId: subjectActorId, orgId: actor.orgId, status: "available", seenAt: "" },
      ])
    ).length === 1
  );
}

async function catchUpRoomEvents(input: {
  readonly socket: ChatSocket;
  readonly actor: Actor;
  readonly roomId: string;
  readonly subscription: ChatSubscription;
  readonly options: ChatSocketOptions;
  readonly denyAccess: () => void;
}): Promise<boolean> {
  const running = input.subscription.catchUp;
  if (running !== undefined) {
    const caughtUp = await running;
    if (
      caughtUp &&
      !input.subscription.closed &&
      input.subscription.cursor < input.subscription.desiredCursor
    ) {
      return catchUpRoomEvents(input);
    }
    return caughtUp;
  }

  const work = drainRoomEvents(input);
  input.subscription.catchUp = work;
  try {
    return await work;
  } finally {
    if (input.subscription.catchUp === work) {
      input.subscription.catchUp = undefined;
    }
  }
}

async function drainRoomEvents(input: {
  readonly socket: ChatSocket;
  readonly actor: Actor;
  readonly roomId: string;
  readonly subscription: ChatSubscription;
  readonly options: ChatSocketOptions;
  readonly denyAccess: () => void;
}): Promise<boolean> {
  do {
    const replay = await input.options.bus.replay({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      roomId: input.roomId,
      after: input.subscription.cursor,
      limit: CHAT_REPLAY_BATCH_SIZE,
    });
    if (!replay.authorized) {
      input.subscription.closed = true;
      input.denyAccess();
      return false;
    }
    if (replay.resetRequired) {
      input.subscription.closed = true;
      sendSocket(input.socket, {
        type: "resync.required",
        roomId: input.roomId,
        cursor: replay.latestCursor,
      });
      input.socket.close(CHAT_RESYNC_CLOSE_CODE, "chat history resync required");
      return false;
    }

    input.subscription.desiredCursor = Math.max(
      input.subscription.desiredCursor,
      replay.latestCursor,
    );
    for (const event of replay.events) {
      if (event.cursor <= input.subscription.cursor) {
        continue;
      }
      if (event.cursor !== input.subscription.cursor + 1) {
        input.subscription.closed = true;
        sendSocket(input.socket, {
          type: "resync.required",
          roomId: input.roomId,
          cursor: replay.latestCursor,
        });
        input.socket.close(CHAT_RESYNC_CLOSE_CODE, "chat history gap detected");
        return false;
      }
      if (!sendSocket(input.socket, event)) {
        input.subscription.closed = true;
        return false;
      }
      input.subscription.cursor = event.cursor;
    }
    if (
      replay.events.length === 0 &&
      (replay.hasMore || input.subscription.cursor < input.subscription.desiredCursor)
    ) {
      input.subscription.closed = true;
      sendSocket(input.socket, {
        type: "resync.required",
        roomId: input.roomId,
        cursor: replay.latestCursor,
      });
      input.socket.close(CHAT_RESYNC_CLOSE_CODE, "chat history gap detected");
      return false;
    }
  } while (
    !input.subscription.closed &&
    input.subscription.cursor < input.subscription.desiredCursor
  );
  return !input.subscription.closed;
}

function isEventCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function subscribeCursor(
  message: Extract<ChatInboundFrame, { readonly type: "subscribe" }>,
): number {
  return message.cursor ?? 0;
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

function withSocketActorContext<T>(
  store: ChatStore,
  actor: Actor,
  callback: (store: ChatStore) => Promise<T>,
): Promise<T> {
  return store.withActorContext === undefined
    ? callback(store)
    : store.withActorContext({ orgId: actor.orgId, actorId: actor.id }, callback);
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
  if ((socket.bufferedAmount ?? 0) > 1024 * 1024) {
    socket.close(CHAT_BACKPRESSURE_CLOSE_CODE, "slow consumer");
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

function rawByteLength(raw: Buffer | ArrayBuffer | string): number {
  return typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
}

class ChatFrameDeadlineError extends Error {}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ChatFrameDeadlineError("Chat frame processing deadline exceeded."));
    }, timeoutMs);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
