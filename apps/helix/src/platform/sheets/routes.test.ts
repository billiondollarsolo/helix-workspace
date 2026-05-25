import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  InMemorySheetsStore,
  SHEETS_WS_PROTOCOL,
  SHEETS_WS_ROUTE,
  handleSheetsSocket,
  registerSheetsRoutes,
  type SheetsStore,
} from "./index.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const otherActorId = "33333333-3333-4333-8333-333333333333";
const actor: Actor = {
  id: actorId,
  orgId,
  type: "user",
  displayName: "Ada",
};

describe("sheets sync routes", () => {
  it("sends ready state, persists accepted cell operations, and broadcasts revisions", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Revenue" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("Expected default tab.");
    }
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const state = { rooms: new Map() };

    await handleSheetsSocket(firstSocket, requestFor(sheet.id), options(store), state);
    await handleSheetsSocket(secondSocket, requestFor(sheet.id), options(store), state);
    firstSocket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-1",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "42" }],
      },
    });
    await settle();

    expect(firstSocket.messages[0]).toMatchObject({
      type: "ready",
      protocol: SHEETS_WS_PROTOCOL,
      sheetId: sheet.id,
      revision: 0,
      tabs: [{ id: tab.id, name: "Sheet1", position: 0 }],
    });
    expect(secondSocket.messages[0]).toMatchObject({ type: "ready", sheetId: sheet.id });
    expect(firstSocket.messages.at(-1)).toMatchObject({
      type: "operation",
      revision: 1,
      operation: { id: "op-1" },
    });
    expect(secondSocket.messages.at(-1)).toMatchObject({
      type: "operation",
      revision: 1,
      operation: { id: "op-1" },
    });
    await expectCell(store, tab.id, "42");
    await expectOperations(store, sheet.id, ["op-1"]);

    firstSocket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-1",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "duplicate" }],
      },
    });
    await settle();

    expect(firstSocket.messages.at(-1)).toEqual({
      type: "ack",
      operationId: "op-1",
      revision: 1,
      duplicate: true,
    });
    await expectCell(store, tab.id, "42");
    await expectOperations(store, sheet.id, ["op-1"]);

    firstSocket.close();
    secondSocket.close();
    const reconnectedSocket = new FakeSocket();
    await handleSheetsSocket(reconnectedSocket, requestFor(sheet.id), options(store), {
      rooms: new Map(),
    });

    expect(reconnectedSocket.messages[0]).toMatchObject({
      type: "ready",
      sheetId: sheet.id,
      revision: 1,
    });
  });

  it("uses deterministic operation id ordering for stale same-cell writes", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Conflicts" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("Expected default tab.");
    }
    const socket = new FakeSocket();
    const state = { rooms: new Map() };

    await handleSheetsSocket(socket, requestFor(sheet.id), options(store), state);
    socket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-b",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "higher" }],
      },
    });
    await settle();
    socket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-a",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "lower" }],
      },
    });
    await settle();

    expect(socket.messages.at(-1)).toEqual({
      type: "ack",
      operationId: "op-a",
      revision: 1,
      dropped: true,
    });
    await expectCell(store, tab.id, "higher");
  });

  it("accepts structural row and column operations over the sync route", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Structure" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("Expected default tab.");
    }
    await store.updateCells({
      orgId,
      actorId,
      tabId: tab.id,
      edits: [
        { row: 0, col: 0, value: "A1" },
        { row: 1, col: 1, value: "B2" },
      ],
    });
    const socket = new FakeSocket();

    await handleSheetsSocket(socket, requestFor(sheet.id), options(store));
    socket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-structure",
        baseRevision: 0,
        changes: [
          { kind: "insert-rows", index: 1, count: 1 },
          { kind: "insert-columns", index: 1, count: 1 },
        ],
      },
    });
    await settle();

    expect(socket.messages.at(-1)).toMatchObject({
      type: "operation",
      revision: 1,
      operation: { id: "op-structure" },
    });
    await expect(store.getTabCells({ orgId, actorId, tabId: tab.id })).resolves.toMatchObject({
      cells: [
        expect.objectContaining({ row: 0, col: 0, value: "A1" }),
        expect.objectContaining({ row: 2, col: 2, value: "B2" }),
      ],
    });
  });

  it("closes inaccessible spreadsheets before registering message handlers", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({
      orgId,
      actorId: otherActorId,
      title: "Private",
    });
    const socket = new FakeSocket();

    await handleSheetsSocket(socket, requestFor(sheet.id), options(store));

    expect(socket.closed).toEqual({
      code: 1008,
      reason: "Unknown or inaccessible spreadsheet",
    });
    expect(socket.messageHandlerCount).toBe(0);
  });

  it("tracks active websocket metrics with the sheets route label", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Metrics" });
    const socket = new FakeSocket();
    const metrics = new RecordingWebsocketMetrics();

    await handleSheetsSocket(socket, requestFor(sheet.id), options(store, { metrics }));
    socket.close();

    expect(metrics.events).toEqual([`open:${SHEETS_WS_ROUTE}`, `close:${SHEETS_WS_ROUTE}`]);
  });
});

describe("registerSheetsRoutes", () => {
  it("mounts the sheets OT websocket route", async () => {
    const app = captureWebsocketApp();
    const store = new InMemorySheetsStore();

    await registerSheetsRoutes(app.app, options(store));

    expect(app.path).toBe(SHEETS_WS_ROUTE);
  });
});

function options(
  store: SheetsStore,
  overrides: {
    readonly metrics?: RecordingWebsocketMetrics | undefined;
  } = {},
): Parameters<typeof handleSheetsSocket>[2] {
  return {
    store,
    actorFromRequest: () => actor,
    ...(overrides.metrics === undefined ? {} : { metrics: overrides.metrics }),
  };
}

async function expectCell(store: SheetsStore, tabId: string, value: string): Promise<void> {
  const tab = await store.getTabCells({ orgId, actorId, tabId });
  expect(tab?.cells).toEqual([
    expect.objectContaining({
      row: 0,
      col: 0,
      value,
    }),
  ]);
}

async function expectOperations(
  store: SheetsStore,
  sheetId: string,
  operationIds: readonly string[],
): Promise<void> {
  const operations = await store.listOperations({ orgId, actorId, sheetId });
  expect(operations.map((operation) => operation.operationId)).toEqual(operationIds);
  expect(operations.map((operation) => operation.revision)).toEqual(
    operationIds.map((_operationId, index) => index + 1),
  );
}

function requestFor(sheetId: string): FastifyRequest {
  return {
    params: { sheetId },
    query: { protocol: SHEETS_WS_PROTOCOL },
  } as unknown as FastifyRequest;
}

function captureWebsocketApp(): {
  readonly app: FastifyInstance;
  readonly path: string | undefined;
} {
  let path: string | undefined;
  const app = {
    get: (registeredPath: string) => {
      path = registeredPath;
    },
  } as unknown as FastifyInstance;
  return {
    app,
    get path() {
      return path;
    },
  };
}

class FakeSocket {
  readonly messages: unknown[] = [];
  closed: { readonly code?: number; readonly reason?: string } | null = null;
  #messageHandlers: Array<(data: Buffer | ArrayBuffer | string) => void> = [];
  #closeHandlers: Array<() => void> = [];

  get messageHandlerCount(): number {
    return this.#messageHandlers.length;
  }

  send(data: string | Buffer): void {
    this.messages.push(JSON.parse(Buffer.from(data).toString("utf8")));
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

  on(event: "message", handler: (data: Buffer | ArrayBuffer | string) => void): void;
  on(event: "close", handler: () => void): void;
  on(_event: "error", _handler: (error: Error) => void): void;
  on(
    event: "message" | "close" | "error",
    handler:
      | ((data: Buffer | ArrayBuffer | string) => void)
      | (() => void)
      | ((error: Error) => void),
  ): void {
    if (event === "message") {
      this.#messageHandlers.push(handler as (data: Buffer | ArrayBuffer | string) => void);
      return;
    }
    if (event === "close") {
      this.#closeHandlers.push(handler as () => void);
    }
  }

  receive(message: unknown): void {
    for (const handler of this.#messageHandlers) {
      handler(JSON.stringify(message));
    }
  }
}

class RecordingWebsocketMetrics {
  readonly events: string[] = [];

  recordWebsocketConnectionOpened(input: { readonly route: string }): void {
    this.events.push(`open:${input.route}`);
  }

  recordWebsocketConnectionClosed(input: { readonly route: string }): void {
    this.events.push(`close:${input.route}`);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
