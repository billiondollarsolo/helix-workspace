import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import type { EventBus, EventEnvelope, JsonObject, Unsubscribe } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import type { SheetOperation, SheetsStore } from "./store.js";
import type { WebsocketConnectionMetrics } from "../websocket-metrics.js";
import { trackWebsocketConnection } from "../websocket-metrics.js";

export const SHEETS_WS_ROUTE = "/sync/sheets/:sheetId" as const;
export const SHEETS_WS_PROTOCOL = "sheets-ot" as const;

interface SheetsSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface RegisterSheetsRoutesOptions {
  readonly store: SheetsStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly events?: EventBus | undefined;
  readonly operationLogCompaction?: SheetsOperationLogCompactionOptions | undefined;
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface SheetsOperationLogCompactionOptions {
  readonly compactAfterRevisions: number;
  readonly retainRevisions: number;
}

export interface SheetsRouteState {
  readonly rooms: Map<string, SheetsRoom>;
  readonly nodeId: string;
}

interface SheetsRoom {
  readonly orgId: string;
  readonly sheetId: string;
  readonly peers: Map<SheetsSocket, Actor>;
  unsubscribe?: Unsubscribe | undefined;
  latestRevision: number;
}

const paramsSchema = z.object({
  sheetId: z.string().uuid(),
});

const querySchema = z
  .object({
    protocol: z.union([z.string(), z.array(z.string())]),
  })
  .partial();

const inboundSchema = z.object({
  type: z.literal("operation"),
  tabId: z.string().uuid(),
  operation: z.object({
    id: z.string().min(1),
    baseRevision: z.number().int().nonnegative(),
    changes: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("set-cell"),
            row: z.number().int().nonnegative(),
            col: z.number().int().nonnegative(),
            value: z.string(),
          }),
          z.object({
            kind: z.literal("clear-cell"),
            row: z.number().int().nonnegative(),
            col: z.number().int().nonnegative(),
          }),
          z.object({
            kind: z.literal("insert-rows"),
            index: z.number().int().nonnegative(),
            count: z.number().int().positive(),
          }),
          z.object({
            kind: z.literal("delete-rows"),
            index: z.number().int().nonnegative(),
            count: z.number().int().positive(),
          }),
          z.object({
            kind: z.literal("insert-columns"),
            index: z.number().int().nonnegative(),
            count: z.number().int().positive(),
          }),
          z.object({
            kind: z.literal("delete-columns"),
            index: z.number().int().nonnegative(),
            count: z.number().int().positive(),
          }),
        ]),
      )
      .min(1),
  }),
});

const fanoutSchema = z.object({
  sourceId: z.string().min(1),
  orgId: z.string().uuid(),
  sheetId: z.string().uuid(),
  tabId: z.string().uuid(),
  revision: z.number().int().positive(),
  operation: inboundSchema.shape.operation,
});

const defaultOperationLogCompaction: SheetsOperationLogCompactionOptions = {
  compactAfterRevisions: 1_000,
  retainRevisions: 500,
};

export async function registerSheetsRoutes(
  app: FastifyInstance,
  options: RegisterSheetsRoutesOptions,
): Promise<void> {
  const state: SheetsRouteState = { rooms: new Map(), nodeId: randomUUID() };
  app.get(SHEETS_WS_ROUTE, { websocket: true }, async (socket, request) => {
    await handleSheetsSocket(socket as SheetsSocket, request, options, state);
  });
}

export async function handleSheetsSocket(
  socket: SheetsSocket,
  request: FastifyRequest,
  options: RegisterSheetsRoutesOptions,
  state: SheetsRouteState = { rooms: new Map(), nodeId: randomUUID() },
): Promise<void> {
  trackWebsocketConnection(socket, SHEETS_WS_ROUTE, options.metrics);

  const parsedParams = paramsSchema.parse(request.params);
  const parsedQuery = querySchema.parse(request.query);
  if (
    parsedQuery.protocol !== undefined &&
    parsedQuery.protocol !== SHEETS_WS_PROTOCOL &&
    !(
      Array.isArray(parsedQuery.protocol) &&
      parsedQuery.protocol.length === 1 &&
      parsedQuery.protocol[0] === SHEETS_WS_PROTOCOL
    )
  ) {
    socket.close(1008, "Unsupported Sheets sync protocol");
    return;
  }

  const actor = await options.actorFromRequest(request);
  const sheet = await options.store.getSheet({
    orgId: actor.orgId,
    actorId: actor.id,
    sheetId: parsedParams.sheetId,
  });
  if (sheet === null) {
    socket.close(1008, "Unknown or inaccessible spreadsheet");
    return;
  }

  const roomKey = sheetRoomKey(actor.orgId, sheet.id);
  const room =
    state.rooms.get(roomKey) ??
    (await createSheetsRoom({
      actor,
      sheetId: sheet.id,
      state,
      options,
    }));
  room.peers.set(socket, actor);
  state.rooms.set(roomKey, room);

  socket.send(
    JSON.stringify({
      type: "ready",
      protocol: SHEETS_WS_PROTOCOL,
      sheetId: sheet.id,
      revision: room.latestRevision,
      tabs: sheet.tabs.map((tab) => ({ id: tab.id, name: tab.name, position: tab.position })),
    }),
  );

  socket.on("message", (raw) => {
    void handleSheetsMessage({
      raw,
      socket,
      actor,
      room,
      store: options.store,
      events: options.events,
      operationLogCompaction: options.operationLogCompaction,
      nodeId: state.nodeId,
      onError: options.onError,
    }).catch((error: unknown) => {
      options.onError?.(error);
      socket.send(
        JSON.stringify({
          type: "error",
          error: error instanceof Error ? error.message : "Sheets sync failed",
        }),
      );
    });
  });

  socket.on("close", () => {
    room.peers.delete(socket);
    if (room.peers.size === 0) {
      state.rooms.delete(roomKey);
      const unsubscribe = room.unsubscribe;
      room.unsubscribe = undefined;
      void Promise.resolve(unsubscribe?.()).catch((error: unknown) => {
        options.onError?.(error);
      });
    }
  });
}

async function handleSheetsMessage(input: {
  readonly raw: Buffer | ArrayBuffer | string;
  readonly socket: SheetsSocket;
  readonly actor: Actor;
  readonly room: SheetsRoom;
  readonly store: SheetsStore;
  readonly events?: EventBus | undefined;
  readonly operationLogCompaction?: SheetsOperationLogCompactionOptions | undefined;
  readonly nodeId: string;
  readonly onError?: ((error: unknown) => void) | undefined;
}): Promise<void> {
  const message = inboundSchema.parse(JSON.parse(rawToString(input.raw)));
  const result = await input.store.applyOperation({
    orgId: input.actor.orgId,
    actorId: input.actor.id,
    sheetId: input.room.sheetId,
    tabId: message.tabId,
    operation: message.operation,
  });

  if (result.status === "ahead") {
    input.socket.send(
      JSON.stringify({
        type: "error",
        error: "Operation base revision is ahead of the room revision.",
        revision: result.revision,
      }),
    );
    return;
  }
  if (result.status === "compacted") {
    input.socket.send(
      JSON.stringify({
        type: "error",
        error: "Operation base revision has been compacted; reconnect required.",
        revision: result.revision,
        compactedThroughRevision: result.compactedThroughRevision,
        reconnectRequired: true,
      }),
    );
    return;
  }
  if (result.status === "dropped" || result.status === "duplicate") {
    input.room.latestRevision = Math.max(input.room.latestRevision, result.revision);
    input.socket.send(
      JSON.stringify({
        type: "ack",
        operationId: result.operationId,
        revision: result.revision,
        ...(result.status === "dropped" ? { dropped: true } : { duplicate: true }),
      }),
    );
    return;
  }

  broadcastSheetsOperation(input.room, {
    sheetId: input.room.sheetId,
    tabId: message.tabId,
    revision: result.revision,
    operation: result.operation,
  });
  await publishSheetsFanout({
    events: input.events,
    nodeId: input.nodeId,
    actor: input.actor,
    room: input.room,
    tabId: message.tabId,
    revision: result.revision,
    operation: result.operation,
    onError: input.onError,
  });
  await compactSheetsOperationLog({
    store: input.store,
    actor: input.actor,
    room: input.room,
    compaction: input.operationLogCompaction ?? defaultOperationLogCompaction,
    onError: input.onError,
  });
}

export async function handleSheetsFanoutEvent(
  event: EventEnvelope,
  state: SheetsRouteState,
  options: Pick<RegisterSheetsRoutesOptions, "onError" | "store">,
): Promise<void> {
  const parsed = fanoutSchema.safeParse(event.payload);
  if (!parsed.success) {
    options.onError?.(parsed.error);
    return;
  }
  const payload = parsed.data;
  if (payload.sourceId === state.nodeId) {
    return;
  }
  const room = state.rooms.get(sheetRoomKey(payload.orgId, payload.sheetId));
  if (room === undefined || payload.revision <= room.latestRevision) {
    return;
  }
  if (payload.revision > room.latestRevision + 1) {
    await replayMissingOperations(room, options.store);
    return;
  }
  broadcastSheetsOperation(room, {
    sheetId: payload.sheetId,
    tabId: payload.tabId,
    revision: payload.revision,
    operation: payload.operation,
  });
}

async function createSheetsRoom(input: {
  readonly actor: Actor;
  readonly sheetId: string;
  readonly state: SheetsRouteState;
  readonly options: RegisterSheetsRoutesOptions;
}): Promise<SheetsRoom> {
  const latestRevision =
    (
      await input.options.store.listOperations({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        sheetId: input.sheetId,
      })
    ).at(-1)?.revision ?? 0;
  const room: SheetsRoom = {
    orgId: input.actor.orgId,
    sheetId: input.sheetId,
    peers: new Map<SheetsSocket, Actor>(),
    latestRevision,
  };
  if (input.options.events !== undefined) {
    room.unsubscribe = await input.options.events.subscribe(
      sheetSyncSubject(input.actor.orgId, input.sheetId),
      async (event) => {
        await handleSheetsFanoutEvent(event, input.state, {
          store: input.options.store,
          onError: input.options.onError,
        });
      },
    );
  }
  return room;
}

async function replayMissingOperations(room: SheetsRoom, store: SheetsStore): Promise<void> {
  const actor = room.peers.values().next().value;
  if (actor === undefined) {
    return;
  }
  const operations = await store.listOperations({
    orgId: room.orgId,
    actorId: actor.id,
    sheetId: room.sheetId,
    afterRevision: room.latestRevision,
  });
  for (const operation of operations) {
    if (operation.revision <= room.latestRevision) {
      continue;
    }
    broadcastSheetsOperation(room, {
      sheetId: room.sheetId,
      tabId: operation.tabId,
      revision: operation.revision,
      operation: operation.operation,
    });
  }
}

function broadcastSheetsOperation(
  room: SheetsRoom,
  input: {
    readonly sheetId: string;
    readonly tabId: string;
    readonly revision: number;
    readonly operation: SheetOperation;
  },
): void {
  room.latestRevision = input.revision;
  const frame = JSON.stringify({
    type: "operation",
    protocol: SHEETS_WS_PROTOCOL,
    sheetId: input.sheetId,
    tabId: input.tabId,
    revision: input.revision,
    operation: input.operation,
  });
  for (const peer of room.peers.keys()) {
    peer.send(frame);
  }
}

async function publishSheetsFanout(input: {
  readonly events?: EventBus | undefined;
  readonly nodeId: string;
  readonly actor: Actor;
  readonly room: SheetsRoom;
  readonly tabId: string;
  readonly revision: number;
  readonly operation: SheetOperation;
  readonly onError?: ((error: unknown) => void) | undefined;
}): Promise<void> {
  if (input.events === undefined) {
    return;
  }
  const payload: JsonObject = {
    sourceId: input.nodeId,
    orgId: input.actor.orgId,
    sheetId: input.room.sheetId,
    tabId: input.tabId,
    revision: input.revision,
    operation: input.operation as unknown as JsonObject,
  };
  try {
    await input.events.publish(sheetSyncSubject(input.actor.orgId, input.room.sheetId), payload);
  } catch (error) {
    input.onError?.(error);
  }
}

async function compactSheetsOperationLog(input: {
  readonly store: SheetsStore;
  readonly actor: Actor;
  readonly room: SheetsRoom;
  readonly compaction: SheetsOperationLogCompactionOptions;
  readonly onError?: ((error: unknown) => void) | undefined;
}): Promise<void> {
  if (input.room.latestRevision < input.compaction.compactAfterRevisions) {
    return;
  }
  try {
    await input.store.compactOperations({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      sheetId: input.room.sheetId,
      retainRevisions: input.compaction.retainRevisions,
    });
  } catch (error) {
    input.onError?.(error);
  }
}

function sheetRoomKey(orgId: string, sheetId: string): string {
  return `${orgId}:${sheetId}`;
}

function sheetSyncSubject(orgId: string, sheetId: string): string {
  return `sheets.sync.${orgId}.${sheetId}`;
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
