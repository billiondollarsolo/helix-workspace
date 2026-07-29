import type { Actor, JsonObject, MeteringClient } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { z } from "zod3";
import type { DocsDocumentRecord } from "./types.js";
import type { DocsStore } from "./store.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection, traceContextFromUpgradeRequest } from "../websocket-metrics.js";

/** Route label for the docs sync WebSocket connection gauge. */
const DOCS_WS_ROUTE = "/sync/docs/:docId";

interface DocsSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

const paramsSchema = z.object({
  docId: z.string().uuid(),
});

const inboundSchema = z.object({
  type: z.literal("update"),
  updateBase64: z.string().min(1),
  stateBase64: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export interface RegisterDocsRoutesOptions {
  readonly store: DocsStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly concurrentEditorLimit?: (input: {
    readonly request: FastifyRequest;
    readonly actor: Actor;
    readonly document: DocsDocumentRecord;
  }) => number | null | undefined | Promise<number | null | undefined>;
  readonly debounceMs?: number | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  /** Active-connections gauge recorder (Follow-up B). */
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: ((error: unknown) => void) | undefined;
  readonly nowMs?: (() => number) | undefined;
}

interface DocsRouteState {
  readonly rooms: Map<string, Set<DocsSocket>>;
  readonly compactions: Map<string, NodeJS.Timeout>;
  readonly yjsRooms?: Map<string, DocsYjsRoom>;
}

interface DocsYjsRoom {
  readonly sockets: Set<DocsSocket>;
  readonly actors: Map<DocsSocket, Actor>;
  readonly awarenessClients: Map<DocsSocket, Set<number>>;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly orgId: string;
  readonly documentId: string;
  readonly store: DocsStore;
  readonly debounceMs: number;
  readonly compactions: Map<string, NodeJS.Timeout>;
  readonly onError?: (error: unknown) => void;
}

const yjsMessageSync = 0;
const yjsMessageAwareness = 1;

/** Close code sent to docs sync clients when the host is shutting down. */
const DOCS_SHUTDOWN_CLOSE_CODE = 1001;
const DOCS_QUOTA_CLOSE_CODE = 1008;
const DOCS_QUOTA_CLOSE_REASON = "Concurrent editor quota exceeded";

/**
 * Handle returned by {@link registerDocsRoutes} so the server's graceful
 * shutdown drain (PRD §16.3 step 4) can notify connected clients before
 * sockets are torn down.
 */
export interface DocsRoutesHandle {
  /**
   * Broadcast a typed "host shutting down" frame to every connected docs sync
   * socket (plain-JSON and Yjs-protocol alike) and then close it cleanly so
   * clients reconnect to a surviving replica.
   */
  broadcastShutdown(): void;
}

export async function registerDocsRoutes(
  app: FastifyInstance,
  options: RegisterDocsRoutesOptions,
): Promise<DocsRoutesHandle> {
  const state: DocsRouteState = {
    rooms: new Map<string, Set<DocsSocket>>(),
    compactions: new Map<string, NodeJS.Timeout>(),
    yjsRooms: new Map<string, DocsYjsRoom>(),
  };

  app.get("/sync/docs/:docId", { websocket: true }, async (socket, request) => {
    await handleDocsSocket(socket as DocsSocket, request, options, state);
  });

  return {
    broadcastShutdown: () => {
      broadcastDocsShutdown(state, options);
    },
  };
}

/**
 * Send the "host shutting down" frame to every docs socket and close it (PRD
 * §16.3 step 4). Plain-JSON sync clients receive a typed JSON frame; Yjs
 * clients have no JSON channel, so the typed signal is the WebSocket close
 * frame (code 1001, reason "host shutting down").
 */
function broadcastDocsShutdown(state: DocsRouteState, options: RegisterDocsRoutesOptions): void {
  const frame = JSON.stringify({ type: "shutdown", reason: "host shutting down" });
  for (const room of state.rooms.values()) {
    for (const socket of room) {
      try {
        socket.send(frame);
        socket.close(DOCS_SHUTDOWN_CLOSE_CODE, "host shutting down");
      } catch (error) {
        options.onError?.(error);
      }
    }
  }
  for (const room of (state.yjsRooms ?? new Map<string, DocsYjsRoom>()).values()) {
    for (const socket of room.sockets) {
      try {
        socket.close(DOCS_SHUTDOWN_CLOSE_CODE, "host shutting down");
      } catch (error) {
        options.onError?.(error);
      }
    }
  }
}

export async function handleDocsSocket(
  docsSocket: DocsSocket,
  request: FastifyRequest,
  options: RegisterDocsRoutesOptions,
  state: DocsRouteState = {
    rooms: new Map<string, Set<DocsSocket>>(),
    compactions: new Map<string, NodeJS.Timeout>(),
    yjsRooms: new Map<string, DocsYjsRoom>(),
  },
): Promise<void> {
  // Follow-up B: count this connection on the active-connections gauge.
  trackWebsocketConnection(docsSocket, DOCS_WS_ROUTE, options.metrics);
  // P2-6: extract W3C trace context from the WebSocket upgrade request so
  // `yjs.sync` spans created for this socket are children of the originating
  // client trace — trace context rides the socket, not just event envelopes.
  const traceContext = traceContextFromUpgradeRequest(request);

  const parsed = paramsSchema.parse(request.params);
  const docId = parsed.docId;
  const actor = await options.actorFromRequest(request);
  const document = await options.store.getDocumentForActor({
    orgId: actor.orgId,
    actorId: actor.id,
    documentId: docId,
  });
  if (document === null) {
    docsSocket.close(1008, "Unknown or inaccessible document");
    return;
  }

  const concurrentEditorLimit = await options.concurrentEditorLimit?.({
    request,
    actor,
    document,
  });
  if (
    concurrentEditorLimit !== null &&
    concurrentEditorLimit !== undefined &&
    activeDocsSocketCount(state, docId) >= concurrentEditorLimit
  ) {
    docsSocket.close(DOCS_QUOTA_CLOSE_CODE, DOCS_QUOTA_CLOSE_REASON);
    return;
  }

  if (isYjsProtocolRequest(request)) {
    trackDocsCollabSession(docsSocket, document, options, "yjs");
    handleYjsDocsSocket(docsSocket, actor, document, options, state, traceContext);
    return;
  }

  trackDocsCollabSession(docsSocket, document, options, "legacy-json");
  const room = state.rooms.get(docId) ?? new Set<DocsSocket>();
  room.add(docsSocket);
  state.rooms.set(docId, room);
  docsSocket.send(
    JSON.stringify({
      type: "ready",
      documentId: docId,
      updateSeq: document.updateSeq,
      stateBase64: document.ydocState?.toString("base64") ?? null,
    }),
  );

  docsSocket.on("message", (raw) => {
    // P2-6: a `yjs.sync` span per sync message, parented to the handshake
    // trace context so it joins the originating client trace.
    void withYjsSyncSpan(traceContext, docId, () =>
      handleSyncMessage({
        raw,
        socket: docsSocket,
        actor,
        documentId: docId,
        store: options.store,
        room,
        debounceMs: options.debounceMs ?? 250,
        compactions: state.compactions,
      }),
    ).catch((error: unknown) => {
      options.onError?.(error);
      docsSocket.send(
        JSON.stringify({
          type: "error",
          error: error instanceof Error ? error.message : "Docs sync failed",
        }),
      );
    });
  });

  docsSocket.on("close", () => {
    room.delete(docsSocket);
    if (room.size === 0) {
      state.rooms.delete(docId);
    }
  });

  docsSocket.on("error", (error) => {
    options.onError?.(error);
  });
}

function trackDocsCollabSession(
  socket: DocsSocket,
  document: DocsDocumentRecord,
  options: RegisterDocsRoutesOptions,
  protocol: "legacy-json" | "yjs",
): void {
  if (options.metering === undefined) {
    return;
  }
  const startedAt = (options.nowMs ?? Date.now)();
  socket.on("close", () => {
    const durationSeconds = Math.max(
      1,
      Math.round(((options.nowMs ?? Date.now)() - startedAt) / 1000),
    );
    void options.metering
      ?.emit(document.orgId, {
        type: "collab.session.opened",
        quantity: durationSeconds,
        metadata: {
          surface: "docs.sync",
          protocol,
          duration_seconds: durationSeconds,
        },
      })
      .catch((error: unknown) => {
        options.onMeteringError?.(error);
      });
  });
}

async function handleSyncMessage(input: {
  readonly raw: Buffer | ArrayBuffer | string;
  readonly socket: DocsSocket;
  readonly actor: Actor;
  readonly documentId: string;
  readonly store: DocsStore;
  readonly room: Set<DocsSocket>;
  readonly debounceMs: number;
  readonly compactions: Map<string, NodeJS.Timeout>;
}): Promise<void> {
  const parsed = parseSyncMessage(input.raw);
  const update = await input.store.appendUpdate({
    orgId: input.actor.orgId,
    actorId: input.actor.id,
    documentId: input.documentId,
    update: parsed.update,
    metadata: {
      ...parsed.metadata,
      ...(parsed.state === null ? {} : { stateBase64: parsed.state.toString("base64") }),
    },
  });

  scheduleCompaction({
    orgId: input.actor.orgId,
    documentId: input.documentId,
    state: parsed.state ?? parsed.update,
    store: input.store,
    debounceMs: input.debounceMs,
    compactions: input.compactions,
  });

  const outbound = JSON.stringify({
    type: "update",
    documentId: input.documentId,
    actorId: input.actor.id,
    seq: update.seq,
    updateBase64: parsed.update.toString("base64"),
    createdAt: update.createdAt.toISOString(),
  });
  for (const peer of input.room) {
    peer.send(outbound);
  }
}

function parseSyncMessage(raw: Buffer | ArrayBuffer | string): {
  readonly update: Buffer;
  readonly state: Buffer | null;
  readonly metadata: JsonObject;
} {
  if (typeof raw !== "string") {
    const update = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    return { update, state: null, metadata: {} };
  }
  const parsed = inboundSchema.parse(JSON.parse(raw));
  return {
    update: Buffer.from(parsed.updateBase64, "base64"),
    state: parsed.stateBase64 === undefined ? null : Buffer.from(parsed.stateBase64, "base64"),
    metadata: toJsonObject(parsed.metadata),
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function handleYjsDocsSocket(
  socket: DocsSocket,
  actor: Actor,
  document: DocsDocumentRecord,
  options: RegisterDocsRoutesOptions,
  state: DocsRouteState,
  traceContext: Context,
): void {
  const room = getOrCreateYjsRoom(document, options, state);
  room.sockets.add(socket);
  room.actors.set(socket, actor);
  room.awarenessClients.set(socket, new Set<number>());

  sendYjsSyncMessage(socket, (encoder) => {
    syncProtocol.writeSyncStep1(encoder, room.doc);
  });
  sendAwarenessSnapshot(socket, room);

  socket.on("message", (raw) => {
    // P2-6: a `yjs.sync` span per Yjs protocol message, parented to the
    // handshake trace context.
    void withYjsSyncSpan(traceContext, document.id, async () => {
      handleYjsMessage(socket, raw, room);
    }).catch((error: unknown) => {
      options.onError?.(error);
      socket.close(1011, error instanceof Error ? error.message : "Docs sync failed");
    });
  });

  socket.on("close", () => {
    room.sockets.delete(socket);
    room.actors.delete(socket);
    const awarenessClients = room.awarenessClients.get(socket);
    room.awarenessClients.delete(socket);
    if (awarenessClients !== undefined && awarenessClients.size > 0) {
      // Encode BEFORE removing: y-protocols' encoder reads awareness.meta for
      // each clientID's clock, and removeAwarenessStates wipes those entries.
      // Encoding after the remove crashed with "Cannot read properties of
      // undefined (reading 'clock')" on disconnect.
      const ids = [...awarenessClients];
      let update: Uint8Array | null = null;
      try {
        update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, ids);
      } catch {
        // Best-effort: if meta was already partially cleaned (e.g. by another
        // close handler interleaving), just skip the broadcast.
      }
      awarenessProtocol.removeAwarenessStates(room.awareness, ids, socket);
      if (update !== null) {
        broadcastYjsAwareness(room, update, socket);
      }
    }
    if (room.sockets.size === 0) {
      room.doc.destroy();
      getYjsRooms(state).delete(document.id);
    }
  });

  socket.on("error", (error) => {
    options.onError?.(error);
  });
}

function getOrCreateYjsRoom(
  document: DocsDocumentRecord,
  options: RegisterDocsRoutesOptions,
  state: DocsRouteState,
): DocsYjsRoom {
  const rooms = getYjsRooms(state);
  const existing = rooms.get(document.id);
  if (existing !== undefined) {
    return existing;
  }

  const doc = ydocFromStoredState(document.ydocState);
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const room: DocsYjsRoom = {
    sockets: new Set<DocsSocket>(),
    actors: new Map<DocsSocket, Actor>(),
    awarenessClients: new Map<DocsSocket, Set<number>>(),
    doc,
    awareness,
    orgId: document.orgId,
    documentId: document.id,
    store: options.store,
    debounceMs: options.debounceMs ?? 250,
    compactions: state.compactions,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (!isDocsSocket(origin) || !room.sockets.has(origin)) {
      return;
    }
    void persistAndBroadcastYjsUpdate(room, origin, update);
  });

  rooms.set(document.id, room);
  return room;
}

function getYjsRooms(state: DocsRouteState): Map<string, DocsYjsRoom> {
  if (state.yjsRooms !== undefined) {
    return state.yjsRooms;
  }
  const mutableState = state as DocsRouteState & { yjsRooms: Map<string, DocsYjsRoom> };
  mutableState.yjsRooms = new Map<string, DocsYjsRoom>();
  return mutableState.yjsRooms;
}

function activeDocsSocketCount(state: DocsRouteState, documentId: string): number {
  return (
    (state.rooms.get(documentId)?.size ?? 0) + (state.yjsRooms?.get(documentId)?.sockets.size ?? 0)
  );
}

async function persistAndBroadcastYjsUpdate(
  room: DocsYjsRoom,
  origin: DocsSocket,
  update: Uint8Array,
): Promise<void> {
  const actor = room.actors.get(origin);
  if (actor === undefined) {
    return;
  }

  try {
    await room.store.appendUpdate({
      orgId: room.orgId,
      actorId: actor.id,
      documentId: room.documentId,
      update: Buffer.from(update),
      metadata: {
        protocol: "yjs",
        stateBase64: Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64"),
      },
    });
    scheduleYjsCompaction(room);
    broadcastYjsUpdate(room, update, origin);
  } catch (error) {
    room.onError?.(error);
    origin.close(1011, error instanceof Error ? error.message : "Docs sync failed");
  }
}

function handleYjsMessage(
  socket: DocsSocket,
  raw: Buffer | ArrayBuffer | string,
  room: DocsYjsRoom,
): void {
  const decoder = decoding.createDecoder(rawToUint8Array(raw));
  const messageType = decoding.readVarUint(decoder);
  if (messageType === yjsMessageSync) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, yjsMessageSync);
    syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket, (error) => {
      throw error;
    });
    if (encoding.length(encoder) > 1) {
      socket.send(Buffer.from(encoding.toUint8Array(encoder)));
    }
    return;
  }

  if (messageType === yjsMessageAwareness) {
    const update = decoding.readVarUint8Array(decoder);
    const clientIds = awarenessClientIds(update);
    room.awarenessClients.set(socket, mergeClientIds(room.awarenessClients.get(socket), clientIds));
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, socket);
    broadcastYjsAwareness(room, update, socket);
    return;
  }

  throw new Error(`Unknown Docs Yjs message type: ${String(messageType)}`);
}

function sendYjsSyncMessage(socket: DocsSocket, writePayload: (encoder: encoding.Encoder) => void) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, yjsMessageSync);
  writePayload(encoder);
  socket.send(Buffer.from(encoding.toUint8Array(encoder)));
}

function sendAwarenessSnapshot(socket: DocsSocket, room: DocsYjsRoom): void {
  const clientIds = [...room.awareness.getStates().keys()];
  if (clientIds.length === 0) {
    return;
  }
  const update = awarenessProtocol.encodeAwarenessUpdate(room.awareness, clientIds);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, yjsMessageAwareness);
  encoding.writeVarUint8Array(encoder, update);
  socket.send(Buffer.from(encoding.toUint8Array(encoder)));
}

function broadcastYjsUpdate(room: DocsYjsRoom, update: Uint8Array, origin: DocsSocket): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, yjsMessageSync);
  syncProtocol.writeUpdate(encoder, update);
  const payload = Buffer.from(encoding.toUint8Array(encoder));
  for (const peer of room.sockets) {
    if (peer !== origin) {
      peer.send(payload);
    }
  }
}

function broadcastYjsAwareness(room: DocsYjsRoom, update: Uint8Array, origin: DocsSocket): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, yjsMessageAwareness);
  encoding.writeVarUint8Array(encoder, update);
  const payload = Buffer.from(encoding.toUint8Array(encoder));
  for (const peer of room.sockets) {
    if (peer !== origin) {
      peer.send(payload);
    }
  }
}

function scheduleYjsCompaction(room: DocsYjsRoom): void {
  scheduleCompaction({
    orgId: room.orgId,
    documentId: room.documentId,
    state: Buffer.from(Y.encodeStateAsUpdate(room.doc)),
    stateVector: Buffer.from(Y.encodeStateVector(room.doc)),
    store: room.store,
    debounceMs: room.debounceMs,
    compactions: room.compactions,
  });
}

function ydocFromStoredState(state: Buffer | null): Y.Doc {
  const doc = new Y.Doc();
  if (state === null || state.length === 0) {
    return doc;
  }
  try {
    Y.applyUpdate(doc, new Uint8Array(state));
  } catch {
    doc.getText("markdown").insert(0, state.toString("utf8"));
  }
  return doc;
}

function rawToUint8Array(raw: Buffer | ArrayBuffer | string): Uint8Array {
  if (typeof raw === "string") {
    return Buffer.from(raw, "base64");
  }
  return Buffer.isBuffer(raw) ? raw : new Uint8Array(raw);
}

function awarenessClientIds(update: Uint8Array): readonly number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const clientIds: number[] = [];
  for (let index = 0; index < count; index += 1) {
    clientIds.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return clientIds;
}

function mergeClientIds(existing: Set<number> | undefined, next: readonly number[]): Set<number> {
  const merged = existing ?? new Set<number>();
  for (const clientId of next) {
    merged.add(clientId);
  }
  return merged;
}

function isDocsSocket(value: unknown): value is DocsSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof (value as { readonly send?: unknown }).send === "function"
  );
}

function isYjsProtocolRequest(request: FastifyRequest): boolean {
  const query = request.query;
  return (
    typeof query === "object" &&
    query !== null &&
    "protocol" in query &&
    (query as { readonly protocol?: unknown }).protocol === "yjs"
  );
}

function scheduleCompaction(input: {
  readonly orgId: string;
  readonly documentId: string;
  readonly state: Buffer;
  readonly stateVector?: Buffer | null | undefined;
  readonly store: DocsStore;
  readonly debounceMs: number;
  readonly compactions: Map<string, NodeJS.Timeout>;
}): void {
  const key = `${input.orgId}:${input.documentId}`;
  const existing = input.compactions.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  input.compactions.set(
    key,
    setTimeout(() => {
      input.compactions.delete(key);
      void input.store.compactDocument({
        orgId: input.orgId,
        documentId: input.documentId,
        state: input.state,
        stateVector: input.stateVector,
      });
    }, input.debounceMs),
  );
}

/**
 * Run a Yjs document-sync operation inside a `yjs.sync` span (P2-6).
 *
 * The span is created under {@link traceContext} — the context extracted from
 * the WebSocket upgrade request — so it joins the originating client trace.
 * Exceptions are recorded on the span and re-thrown so existing error handling
 * is unchanged.
 */
async function withYjsSyncSpan<T>(
  traceContext: Context,
  documentId: string,
  run: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("helix.docs");
  return tracer.startActiveSpan(
    "yjs.sync",
    { attributes: { "helix.docs.document_id": documentId } },
    traceContext,
    async (span) => {
      try {
        return await run();
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
