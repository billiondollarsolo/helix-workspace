import { describe, expect, it } from "vitest";
import type { Actor, EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  InMemorySheetsStore,
  SHEETS_WS_PROTOCOL,
  SHEETS_WS_ROUTE,
  handleSheetsSocket,
  handleSheetsFanoutEvent,
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
    const state = { rooms: new Map(), nodeId: "node-a" };

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
      nodeId: "node-b",
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
    const state = { rooms: new Map(), nodeId: "node-a" };

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

  it("fans out accepted operations through the event bus without echoing the source node", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Fanout" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("Expected default tab.");
    }
    const bus = new FakeEventBus();
    const sourceSocket = new FakeSocket();
    const remoteSocket = new FakeSocket();
    const sourceState = { rooms: new Map(), nodeId: "node-a" };
    const remoteState = { rooms: new Map(), nodeId: "node-b" };

    await handleSheetsSocket(
      sourceSocket,
      requestFor(sheet.id),
      options(store, { events: bus }),
      sourceState,
    );
    await handleSheetsSocket(remoteSocket, requestFor(sheet.id), options(store), remoteState);
    sourceSocket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-fanout",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "replicated" }],
      },
    });
    await settle();

    expect(bus.events).toHaveLength(1);
    const published = bus.events[0];
    if (published === undefined) {
      throw new Error("Expected published Sheets sync event.");
    }
    expect(published.subject).toBe(`sheets.sync.${orgId}.${sheet.id}`);
    expect(bus.subjects).toEqual([`sheets.sync.${orgId}.${sheet.id}`]);
    await handleSheetsFanoutEvent(published, sourceState, { store });
    await handleSheetsFanoutEvent(published, remoteState, { store });

    expect(sourceSocket.messages).toHaveLength(2);
    expect(remoteSocket.messages.at(-1)).toMatchObject({
      type: "operation",
      sheetId: sheet.id,
      tabId: tab.id,
      revision: 1,
      operation: { id: "op-fanout" },
    });
    sourceSocket.close();
    await settle();
    expect(bus.unsubscribeCount).toBe(1);
  });

  it("replays missing operation log entries when a remote fanout revision has a gap", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Gap Recovery" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("Expected default tab.");
    }
    const remoteSocket = new FakeSocket();
    const remoteState = { rooms: new Map(), nodeId: "node-b" };

    await handleSheetsSocket(remoteSocket, requestFor(sheet.id), options(store), remoteState);
    const firstOperation = {
      id: "op-gap-1",
      baseRevision: 0,
      changes: [{ kind: "set-cell" as const, row: 0, col: 0, value: "first" }],
    };
    const secondOperation = {
      id: "op-gap-2",
      baseRevision: 1,
      changes: [{ kind: "set-cell" as const, row: 0, col: 1, value: "second" }],
    };
    await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: firstOperation,
    });
    await store.applyOperation({
      orgId,
      actorId,
      sheetId: sheet.id,
      tabId: tab.id,
      operation: secondOperation,
    });

    await handleSheetsFanoutEvent(
      {
        subject: `sheets.sync.${orgId}.${sheet.id}`,
        payload: {
          sourceId: "node-a",
          orgId,
          sheetId: sheet.id,
          tabId: tab.id,
          revision: 2,
          operation: secondOperation,
        },
        occurredAt: "2026-05-25T12:00:00.000Z",
      },
      remoteState,
      { store },
    );

    expect(remoteSocket.messages.slice(1)).toMatchObject([
      { type: "operation", revision: 1, operation: { id: "op-gap-1" } },
      { type: "operation", revision: 2, operation: { id: "op-gap-2" } },
    ]);
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

  it("compacts operation logs after accepted sync writes and rejects compacted base revisions", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Route Compaction" });
    const tab = sheet.tabs[0];
    if (tab === undefined) {
      throw new Error("Expected default tab.");
    }
    const socket = new FakeSocket();

    await handleSheetsSocket(
      socket,
      requestFor(sheet.id),
      options(store, {
        operationLogCompaction: { compactAfterRevisions: 2, retainRevisions: 1 },
      }),
    );
    socket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-compact-1",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 0, value: "first" }],
      },
    });
    await settle();
    socket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-compact-2",
        baseRevision: 1,
        changes: [{ kind: "set-cell", row: 0, col: 1, value: "second" }],
      },
    });
    await settle();

    await expect(
      store.listOperations({ orgId, actorId, sheetId: sheet.id }),
    ).resolves.toMatchObject([{ operationId: "op-compact-2", revision: 2 }]);
    socket.receive({
      type: "operation",
      tabId: tab.id,
      operation: {
        id: "op-too-old",
        baseRevision: 0,
        changes: [{ kind: "set-cell", row: 0, col: 2, value: "stale" }],
      },
    });
    await settle();

    expect(socket.messages.at(-1)).toEqual({
      type: "error",
      error: "Operation base revision has been compacted; reconnect required.",
      revision: 2,
      compactedThroughRevision: 1,
      reconnectRequired: true,
    });
  });

  it("closes inaccessible spreadsheets before registering message handlers", async () => {
    const store = new InMemorySheetsStore();
    const bus = new FakeEventBus();
    const sheet = await store.createSheet({
      orgId,
      actorId: otherActorId,
      title: "Private",
    });
    const socket = new FakeSocket();

    await handleSheetsSocket(socket, requestFor(sheet.id), options(store, { events: bus }));

    expect(socket.closed).toEqual({
      code: 1008,
      reason: "Unknown or inaccessible spreadsheet",
    });
    expect(socket.messageHandlerCount).toBe(0);
    expect(bus.subjects).toEqual([]);
  });

  it("enforces the concurrent editor quota per spreadsheet room", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Quota" });
    const firstSocket = new FakeSocket();
    const blockedSocket = new FakeSocket();
    const state = { rooms: new Map(), nodeId: "node-a" };
    const routeOptions = options(store, { concurrentEditorLimit: 1 });

    await handleSheetsSocket(firstSocket, requestFor(sheet.id), routeOptions, state);
    await handleSheetsSocket(blockedSocket, requestFor(sheet.id), routeOptions, state);

    expect(firstSocket.closed).toBeNull();
    expect(blockedSocket.closed).toEqual({
      code: 1008,
      reason: "Concurrent editor quota exceeded",
    });
    expect(blockedSocket.messageHandlerCount).toBe(0);

    firstSocket.close();
    const nextSocket = new FakeSocket();
    await handleSheetsSocket(nextSocket, requestFor(sheet.id), routeOptions, state);

    expect(nextSocket.closed).toBeNull();
    expect(nextSocket.messages[0]).toMatchObject({ type: "ready", sheetId: sheet.id });
  });

  it("treats a null concurrent editor quota as unlimited for spreadsheets", async () => {
    const store = new InMemorySheetsStore();
    const sheet = await store.createSheet({ orgId, actorId, title: "Unlimited" });
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const state = { rooms: new Map(), nodeId: "node-a" };

    await handleSheetsSocket(
      firstSocket,
      requestFor(sheet.id),
      options(store, { concurrentEditorLimit: null }),
      state,
    );
    await handleSheetsSocket(
      secondSocket,
      requestFor(sheet.id),
      options(store, { concurrentEditorLimit: null }),
      state,
    );

    expect(firstSocket.closed).toBeNull();
    expect(secondSocket.closed).toBeNull();
    expect(secondSocket.messages[0]).toMatchObject({ type: "ready", sheetId: sheet.id });
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
    readonly events?: EventBus | undefined;
    readonly operationLogCompaction?: Parameters<
      typeof handleSheetsSocket
    >[2]["operationLogCompaction"];
    readonly metrics?: RecordingWebsocketMetrics | undefined;
    readonly concurrentEditorLimit?: number | null | undefined;
  } = {},
): Parameters<typeof handleSheetsSocket>[2] {
  return {
    store,
    actorFromRequest: () => actor,
    ...(overrides.concurrentEditorLimit === undefined
      ? {}
      : { concurrentEditorLimit: () => overrides.concurrentEditorLimit }),
    ...(overrides.events === undefined ? {} : { events: overrides.events }),
    ...(overrides.operationLogCompaction === undefined
      ? {}
      : { operationLogCompaction: overrides.operationLogCompaction }),
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

class FakeEventBus implements EventBus {
  readonly events: EventEnvelope[] = [];
  readonly subjects: string[] = [];
  unsubscribeCount = 0;

  async publish(subject: string, payload: JsonValue): Promise<void> {
    this.events.push({
      subject,
      payload,
      occurredAt: "2026-05-25T12:00:00.000Z",
    });
  }

  async subscribe(subject: string): Promise<Unsubscribe> {
    this.subjects.push(subject);
    return () => {
      this.unsubscribeCount += 1;
    };
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
