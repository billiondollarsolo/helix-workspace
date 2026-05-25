import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SheetsStore } from "./store.js";
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
  readonly metrics?: WebsocketConnectionMetrics | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
}

interface SheetsRouteState {
  readonly rooms: Map<string, SheetsRoom>;
}

interface SheetsRoom {
  readonly sheetId: string;
  readonly sockets: Set<SheetsSocket>;
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

export async function registerSheetsRoutes(
  app: FastifyInstance,
  options: RegisterSheetsRoutesOptions,
): Promise<void> {
  const state: SheetsRouteState = { rooms: new Map() };
  app.get(SHEETS_WS_ROUTE, { websocket: true }, async (socket, request) => {
    await handleSheetsSocket(socket as SheetsSocket, request, options, state);
  });
}

export async function handleSheetsSocket(
  socket: SheetsSocket,
  request: FastifyRequest,
  options: RegisterSheetsRoutesOptions,
  state: SheetsRouteState = { rooms: new Map() },
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

  const room = state.rooms.get(sheet.id) ?? {
    sheetId: sheet.id,
    sockets: new Set<SheetsSocket>(),
    latestRevision:
      (
        await options.store.listOperations({
          orgId: actor.orgId,
          actorId: actor.id,
          sheetId: sheet.id,
        })
      ).at(-1)?.revision ?? 0,
  };
  room.sockets.add(socket);
  state.rooms.set(sheet.id, room);

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
    room.sockets.delete(socket);
    if (room.sockets.size === 0) {
      state.rooms.delete(sheet.id);
    }
  });
}

async function handleSheetsMessage(input: {
  readonly raw: Buffer | ArrayBuffer | string;
  readonly socket: SheetsSocket;
  readonly actor: Actor;
  readonly room: SheetsRoom;
  readonly store: SheetsStore;
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

  input.room.latestRevision = result.revision;
  const frame = JSON.stringify({
    type: "operation",
    protocol: SHEETS_WS_PROTOCOL,
    sheetId: input.room.sheetId,
    tabId: message.tabId,
    revision: result.revision,
    operation: result.operation,
  });
  for (const peer of input.room.sockets) {
    peer.send(frame);
  }
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
