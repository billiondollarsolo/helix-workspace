import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import { slideContentSchema } from "./content.js";
import type { SlidesStore, SlideSyncOperation } from "./store.js";
import type { SlideDeckSummaryRecord, SlideRecord } from "./types.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";

export const SLIDES_WS_ROUTE = "/sync/slides/:deckId" as const;
export const SLIDES_WS_PROTOCOL = "slides-sync" as const;

interface SlidesSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface RegisterSlidesRoutesOptions {
  readonly store: SlidesStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

interface SlidesRouteState {
  readonly rooms: Map<string, SlidesRoom>;
}

interface SlidesRoom {
  readonly deckId: string;
  readonly sockets: Set<SlidesSocket>;
  readonly awareness: Map<SlidesSocket, SlidesAwarenessState>;
  latestRevision: number;
}

interface SlidesAwarenessState {
  readonly actorId: string;
  readonly displayName: string;
  readonly selectedSlideId: string | null;
  readonly selectedShapeId: string | null;
  readonly mode: "editing" | "presenting";
  readonly updatedAt: string;
}

const paramsSchema = z.object({
  deckId: z.string().uuid(),
});

const querySchema = z
  .object({
    protocol: z.union([z.string(), z.array(z.string())]),
  })
  .partial();

const metadataSchema = z.record(z.string(), z.unknown());

const operationSchema = z.union([
  z
    .object({
      kind: z.literal("update-deck"),
      title: z.string().min(1).max(255).optional(),
      metadata: metadataSchema.optional(),
    })
    .refine((value) => value.title !== undefined || value.metadata !== undefined, {
      message: "Provide a deck title or metadata update.",
    }),
  z.object({
    kind: z.literal("create-slide"),
    content: slideContentSchema,
    speakerNotes: z.string().max(20_000).optional(),
    position: z.number().int().nonnegative().max(10_000).optional(),
  }),
  z
    .object({
      kind: z.literal("update-slide"),
      slideId: z.string().uuid(),
      content: slideContentSchema.optional(),
      speakerNotes: z.string().max(20_000).optional(),
      /** Per-slide CAS token; see SlideRecord.revision. */
      expectedRevision: z.number().int().nonnegative().max(2_000_000_000).optional(),
    })
    .refine((value) => value.content !== undefined || value.speakerNotes !== undefined, {
      message: "Provide slide content or speaker notes.",
    }),
  z.object({
    kind: z.literal("delete-slide"),
    slideId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().max(2_000_000_000).optional(),
  }),
  z.object({
    kind: z.literal("reorder-slides"),
    slideIds: z.array(z.string().uuid()).min(1).max(1_000),
  }),
]);

const awarenessSchema = z.object({
  type: z.literal("awareness"),
  selectedSlideId: z.string().uuid().nullable().optional(),
  selectedShapeId: z.string().min(1).max(120).nullable().optional(),
  mode: z.enum(["editing", "presenting"]).optional(),
});

const operationInboundSchema = z.object({
  type: z.literal("operation"),
  operationId: z.string().min(1),
  baseRevision: z.number().int().nonnegative().default(0),
  operation: operationSchema,
});

const inboundSchema = z.discriminatedUnion("type", [operationInboundSchema, awarenessSchema]);

export async function registerSlidesRoutes(
  app: FastifyInstance,
  options: RegisterSlidesRoutesOptions,
): Promise<void> {
  const state: SlidesRouteState = { rooms: new Map() };
  app.get(SLIDES_WS_ROUTE, { websocket: true }, async (socket, request) => {
    await handleSlidesSocket(socket as SlidesSocket, request, options, state);
  });
}

export async function handleSlidesSocket(
  socket: SlidesSocket,
  request: FastifyRequest,
  options: RegisterSlidesRoutesOptions,
  state: SlidesRouteState = { rooms: new Map() },
): Promise<void> {
  trackWebsocketConnection(socket, SLIDES_WS_ROUTE, options.metrics);

  const parsedParams = paramsSchema.parse(request.params);
  const parsedQuery = querySchema.parse(request.query);
  if (
    parsedQuery.protocol !== undefined &&
    parsedQuery.protocol !== SLIDES_WS_PROTOCOL &&
    !(
      Array.isArray(parsedQuery.protocol) &&
      parsedQuery.protocol.length === 1 &&
      parsedQuery.protocol[0] === SLIDES_WS_PROTOCOL
    )
  ) {
    socket.close(1008, "Unsupported Slides sync protocol");
    return;
  }

  const actor = await options.actorFromRequest(request);
  const deckDetail = await options.store.getDeckForActor({
    orgId: actor.orgId,
    actorId: actor.id,
    deckId: parsedParams.deckId,
  });
  if (deckDetail === null) {
    socket.close(1008, "Unknown or inaccessible presentation");
    return;
  }

  const recentOperations = await options.store.listOperations({
    orgId: actor.orgId,
    actorId: actor.id,
    deckId: parsedParams.deckId,
  });
  const durableRevision = recentOperations.at(-1)?.revision ?? 0;
  const room = state.rooms.get(parsedParams.deckId) ?? {
    deckId: parsedParams.deckId,
    sockets: new Set<SlidesSocket>(),
    awareness: new Map<SlidesSocket, SlidesAwarenessState>(),
    latestRevision: durableRevision,
  };
  room.latestRevision = Math.max(room.latestRevision, durableRevision);
  room.sockets.add(socket);
  state.rooms.set(parsedParams.deckId, room);

  socket.send(
    JSON.stringify({
      type: "ready",
      protocol: SLIDES_WS_PROTOCOL,
      deckId: parsedParams.deckId,
      revision: room.latestRevision,
      deck: serializeDeck(deckDetail.deck),
      slides: deckDetail.slides.map(serializeSlide),
      awareness: [...room.awareness.values()],
    }),
  );

  socket.on("message", (raw) => {
    void handleSlidesMessage({
      raw,
      socket,
      actor,
      room,
      store: options.store,
    }).catch((error: unknown) => {
      options.onError?.(error);
      socket.send(
        JSON.stringify({
          type: "error",
          error: error instanceof Error ? error.message : "Slides sync failed",
        }),
      );
    });
  });

  socket.on("close", () => {
    room.sockets.delete(socket);
    const awareness = room.awareness.get(socket);
    room.awareness.delete(socket);
    if (awareness !== undefined) {
      broadcastSlidesAwareness({
        room,
        frame: { ...awareness, status: "left" },
        except: socket,
      });
    }
    if (room.sockets.size === 0) {
      state.rooms.delete(parsedParams.deckId);
    }
  });

  socket.on("error", (error) => {
    options.onError?.(error);
  });
}

async function handleSlidesMessage(input: {
  readonly raw: Buffer | ArrayBuffer | string;
  readonly socket: SlidesSocket;
  readonly actor: Actor;
  readonly room: SlidesRoom;
  readonly store: SlidesStore;
}): Promise<void> {
  const message = inboundSchema.parse(JSON.parse(rawToString(input.raw)));
  if (message.type === "awareness") {
    const awareness = {
      actorId: input.actor.id,
      displayName: input.actor.displayName ?? "Collaborator",
      selectedSlideId: message.selectedSlideId ?? null,
      selectedShapeId: message.selectedShapeId ?? null,
      mode: message.mode ?? "editing",
      updatedAt: new Date().toISOString(),
    } satisfies SlidesAwarenessState;
    input.room.awareness.set(input.socket, awareness);
    broadcastSlidesAwareness({
      room: input.room,
      frame: { ...awareness, status: "active" },
      except: input.socket,
    });
    return;
  }

  const result = await input.store.applyOperation({
    orgId: input.actor.orgId,
    actorId: input.actor.id,
    deckId: input.room.deckId,
    operationId: message.operationId,
    baseRevision: message.baseRevision,
    operation: toJsonObject(message.operation) as unknown as SlideSyncOperation,
  });

  if (result.status === "duplicate") {
    input.socket.send(
      JSON.stringify({
        type: "ack",
        operationId: message.operationId,
        revision: result.revision,
        duplicate: true,
      }),
    );
    return;
  }

  if (result.status === "ahead") {
    input.socket.send(
      JSON.stringify({
        type: "error",
        operationId: message.operationId,
        revision: result.revision,
        error: "Slides operation base revision is ahead of the server revision.",
      }),
    );
    return;
  }

  if (result.status === "slide-conflict") {
    // Per-slide CAS failed: another writer mutated this slide first. We
    // deliver the authoritative snapshot back to the sender so it can rebase
    // its pending edit on fresh content (and surface the conflict to the
    // user) without overwriting the other writer's work. This is the
    // interim safety net documented in docs/reviews/follow-up.md until
    // full per-shape OT lands.
    input.socket.send(
      JSON.stringify({
        type: "slide-conflict",
        protocol: SLIDES_WS_PROTOCOL,
        deckId: input.room.deckId,
        operationId: message.operationId,
        revision: result.revision,
        slideId: result.slideId,
        currentSlideRevision: result.currentSlideRevision,
        deck: serializeDeck(result.snapshot.deck),
        slides: result.snapshot.slides.map(serializeSlide),
      }),
    );
    return;
  }

  input.room.latestRevision = Math.max(input.room.latestRevision, result.revision);
  const frame = JSON.stringify({
    type: "operation",
    protocol: SLIDES_WS_PROTOCOL,
    deckId: input.room.deckId,
    operationId: result.operationId,
    revision: result.revision,
    operation: result.operation,
    deck: serializeDeck(result.snapshot.deck),
    slides: result.snapshot.slides.map(serializeSlide),
  });
  for (const peer of input.room.sockets) {
    peer.send(frame);
  }
}

function broadcastSlidesAwareness(input: {
  readonly room: SlidesRoom;
  readonly frame: SlidesAwarenessState & { readonly status: "active" | "left" };
  readonly except: SlidesSocket;
}): void {
  const frame = JSON.stringify({
    type: "awareness",
    protocol: SLIDES_WS_PROTOCOL,
    deckId: input.room.deckId,
    ...input.frame,
  });
  for (const peer of input.room.sockets) {
    if (peer !== input.except) {
      peer.send(frame);
    }
  }
}

function serializeDeck(deck: SlideDeckSummaryRecord): JsonObject {
  return {
    id: deck.id,
    orgId: deck.orgId,
    title: deck.title,
    ownerActorId: deck.ownerActorId,
    createdByActorId: deck.createdByActorId,
    slideCount: deck.slideCount,
    metadata: deck.metadata,
    deletedAt: deck.deletedAt?.toISOString() ?? null,
    createdAt: deck.createdAt.toISOString(),
    updatedAt: deck.updatedAt.toISOString(),
  };
}

function serializeSlide(slide: SlideRecord): JsonObject {
  return {
    id: slide.id,
    orgId: slide.orgId,
    deckId: slide.deckId,
    position: slide.position,
    layout: slide.layout,
    content: toJsonObject(slide.content),
    speakerNotes: slide.speakerNotes,
    revision: slide.revision,
    createdAt: slide.createdAt.toISOString(),
    updatedAt: slide.updatedAt.toISOString(),
  };
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function rawToString(raw: Buffer | ArrayBuffer | string): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  return Buffer.from(new Uint8Array(raw)).toString("utf8");
}
