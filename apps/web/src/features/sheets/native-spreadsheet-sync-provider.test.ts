// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeAccessToken } from "@/lib/auth";
import type { SheetsApiTabWithCells } from "./api";
import {
  NativeSpreadsheetSyncProvider,
  applySpreadsheetOperationToTab,
  sheetSyncWebSocketUrl,
} from "./native-spreadsheet-sync-provider";

const sheetId = "11111111-1111-4111-8111-111111111111";
const tabId = "22222222-2222-4222-8222-222222222222";

describe("native spreadsheet sync provider", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
    window.history.replaceState(null, "", "/sheets/sheet-1");
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes Sheets sync URLs and preserves fallback realtime auth", () => {
    expect(sheetSyncWebSocketUrl("sheet 1")).toBe(
      "ws://localhost:3000/sync/sheets/sheet%201?protocol=sheets-ot",
    );

    storeAccessToken("token-1");

    expect(sheetSyncWebSocketUrl("sheet 1")).toBe(
      "ws://localhost:3000/sync/sheets/sheet%201?protocol=sheets-ot&access_token=token-1",
    );
  });

  it("sends cell edits with the current server revision", () => {
    const statuses: string[] = [];
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      operationId: () => "op-1",
      onStatusChange: (status) => statuses.push(status),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    expect(socket?.url).toBe(`ws://localhost:3000/sync/sheets/${sheetId}?protocol=sheets-ot`);
    socket?.open();
    socket?.receive({ type: "ready", revision: 7 });

    expect(provider.sendCellEdits(tabId, [{ row: 1, col: 2, value: "42" }])).toBe(true);

    expect(statuses).toEqual(["connecting", "connected"]);
    expect(socket?.sent).toEqual([
      {
        type: "operation",
        tabId,
        operation: {
          id: "op-1",
          baseRevision: 7,
          changes: [{ kind: "set-cell", row: 1, col: 2, value: "42" }],
        },
      },
    ]);
  });

  it("can disconnect during React cleanup without reporting offline to an unmounting component", () => {
    const statuses: string[] = [];
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      onStatusChange: (status) => statuses.push(status),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();

    provider.disconnect({ notify: false });

    expect(provider.getStatus()).toBe("offline");
    expect(socket?.closed).toBe(true);
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("reconnects after an unexpected socket close", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      reconnectDelayMs: 25,
      onStatusChange: (status) => statuses.push(status),
    });

    provider.connect();
    const firstSocket = MockWebSocket.instances.at(-1);
    firstSocket?.open();
    firstSocket?.close();

    expect(provider.getStatus()).toBe("offline");
    expect(statuses).toEqual(["connecting", "connected", "offline"]);

    vi.advanceTimersByTime(25);

    const secondSocket = MockWebSocket.instances.at(-1);
    expect(secondSocket).not.toBe(firstSocket);
    expect(statuses).toEqual(["connecting", "connected", "offline", "connecting"]);
    secondSocket?.open();
    expect(statuses).toEqual(["connecting", "connected", "offline", "connecting", "connected"]);
  });

  it("sends structural operations with the current server revision", () => {
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      operationId: () => "op-structure",
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();
    socket?.receive({ type: "ready", revision: 3 });

    expect(
      provider.sendOperation(tabId, [
        { kind: "insert-rows", index: 1, count: 1 },
        { kind: "delete-rows", index: 3, count: 1 },
        { kind: "insert-columns", index: 2, count: 1 },
        { kind: "delete-columns", index: 4, count: 1 },
      ]),
    ).toBe(true);
    expect(socket?.sent.at(-1)).toEqual({
      type: "operation",
      tabId,
      operation: {
        id: "op-structure",
        baseRevision: 3,
        changes: [
          { kind: "insert-rows", index: 1, count: 1 },
          { kind: "delete-rows", index: 3, count: 1 },
          { kind: "insert-columns", index: 2, count: 1 },
          { kind: "delete-columns", index: 4, count: 1 },
        ],
      },
    });
  });

  it("returns false and goes offline when realtime send fails", () => {
    const statuses: string[] = [];
    const errors: unknown[] = [];
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      operationId: () => "op-fail",
      onStatusChange: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();
    if (socket !== undefined) {
      socket.throwOnSend = true;
    }

    expect(provider.sendCellEdits(tabId, [{ row: 0, col: 1, value: "fallback" }])).toBe(false);
    expect(provider.getStatus()).toBe("offline");
    expect(socket?.closed).toBe(true);
    expect(statuses).toEqual(["connecting", "connected", "offline"]);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("applies accepted operation frames to callers and advances revision", () => {
    const frames: unknown[] = [];
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      onOperation: (frame) => frames.push(frame),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();
    socket?.receive({
      type: "operation",
      protocol: "sheets-ot",
      sheetId,
      tabId,
      revision: 3,
      operation: {
        id: "op-remote",
        baseRevision: 2,
        changes: [{ kind: "clear-cell", row: 0, col: 0 }],
      },
    });

    expect(frames).toHaveLength(1);
    expect(provider.sendCellEdits(tabId, [{ row: 0, col: 1, value: "next" }])).toBe(true);
    expect(socket?.sent.at(-1)).toMatchObject({
      operation: { baseRevision: 3 },
    });
  });

  it("keeps formatted edits on the REST fallback path", () => {
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    });

    provider.connect();
    MockWebSocket.instances.at(-1)?.open();

    expect(
      provider.canSendCellEdits([{ row: 0, col: 0, value: "x", format: { bold: true } }]),
    ).toBe(false);
  });

  it("updates sparse tab cells from operation frames", () => {
    const updated = applySpreadsheetOperationToTab(tab(), {
      id: "op-1",
      baseRevision: 0,
      changes: [
        { kind: "set-cell", row: 1, col: 1, value: "new" },
        { kind: "clear-cell", row: 0, col: 0 },
      ],
    });

    expect(
      updated.cells.map((cell) => ({ row: cell.row, col: cell.col, value: cell.value })),
    ).toEqual([{ row: 1, col: 1, value: "new" }]);
  });

  it("updates sparse tab cells from structural operation frames", () => {
    const updated = applySpreadsheetOperationToTab(tab(), {
      id: "op-structure",
      baseRevision: 0,
      changes: [
        { kind: "insert-rows", index: 0, count: 1 },
        { kind: "insert-columns", index: 0, count: 1 },
      ],
    });

    expect(
      updated.cells.map((cell) => ({ row: cell.row, col: cell.col, value: cell.value })),
    ).toEqual([{ row: 1, col: 1, value: "old" }]);
  });

  it("deletes sparse tab rows and columns from structural operation frames", () => {
    const updated = applySpreadsheetOperationToTab(
      tab({
        cells: [tabCell(0, 0, "deleted"), tabCell(1, 1, "kept-1"), tabCell(3, 3, "kept-2")],
      }),
      {
        id: "op-delete-structure",
        baseRevision: 0,
        changes: [
          { kind: "delete-rows", index: 0, count: 1 },
          { kind: "delete-columns", index: 0, count: 1 },
        ],
      },
    );

    expect(
      updated.cells.map((cell) => ({ row: cell.row, col: cell.col, value: cell.value })),
    ).toEqual([
      { row: 0, col: 0, value: "kept-1" },
      { row: 2, col: 2, value: "kept-2" },
    ]);
  });

  it("rebases relative formula references across structural operation frames", () => {
    const updated = applySpreadsheetOperationToTab(
      tab({
        cells: [
          tabCell(0, 0, "1"),
          tabCell(1, 1, "=A1+$A$1+B$2+$B3", {
            formula: "A1+$A$1+B$2+$B3",
          }),
          tabCell(4, 4, "=A1+B2+$B2+B$2"),
        ],
      }),
      {
        id: "op-rebase-structure",
        baseRevision: 0,
        changes: [
          { kind: "insert-rows", index: 0, count: 1 },
          { kind: "insert-columns", index: 0, count: 1 },
          { kind: "delete-rows", index: 4, count: 1 },
        ],
      },
    );

    const formulaCell = updated.cells.find((cell) => cell.value.startsWith("="));
    expect(formulaCell).toMatchObject({
      row: 2,
      col: 2,
      value: "=B2+$B$2+C$3+$C4",
      formula: "B2+$B$2+C$3+$C4",
    });
    expect(updated.cells.some((cell) => cell.value.includes("#REF!"))).toBe(false);
  });
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  closed = false;
  throwOnSend = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.throwOnSend) {
      throw new Error("socket send failed");
    }
    if (typeof data === "string") {
      this.sent.push(JSON.parse(data));
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  receive(message: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function tab(overrides: Partial<SheetsApiTabWithCells> = {}): SheetsApiTabWithCells {
  return {
    id: tabId,
    sheetId,
    name: "Sheet1",
    position: 0,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    cells: [tabCell(0, 0, "old")],
    ...overrides,
  };
}

function tabCell(
  row: number,
  col: number,
  value: string,
  overrides: Partial<SheetsApiTabWithCells["cells"][number]> = {},
): SheetsApiTabWithCells["cells"][number] {
  return {
    id: `cell-${String(row)}-${String(col)}`,
    sheetTabId: tabId,
    row,
    col,
    value,
    formula: null,
    calcValue: null,
    dependencies: [],
    formulaError: null,
    format: {},
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}
