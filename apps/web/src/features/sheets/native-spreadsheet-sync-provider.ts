import { addAccessTokenSearchParam } from "@/lib/auth";
import type { SheetsApiTabWithCells, SheetsCellEdit } from "./api";

const socketOpen = 1;
const protocol = "sheets-ot";
const defaultReconnectDelayMs = 1_000;
const defaultMaxReconnectAttempts = 5;

export type NativeSpreadsheetSyncStatus = "offline" | "connecting" | "connected";

export type NativeSpreadsheetOperationChange =
  | {
      readonly kind: "set-cell";
      readonly row: number;
      readonly col: number;
      readonly value: string;
    }
  | {
      readonly kind: "clear-cell";
      readonly row: number;
      readonly col: number;
    }
  | {
      readonly kind: "insert-rows";
      readonly index: number;
      readonly count: number;
    }
  | {
      readonly kind: "delete-rows";
      readonly index: number;
      readonly count: number;
    }
  | {
      readonly kind: "insert-columns";
      readonly index: number;
      readonly count: number;
    }
  | {
      readonly kind: "delete-columns";
      readonly index: number;
      readonly count: number;
    };

export interface NativeSpreadsheetOperation {
  readonly id: string;
  readonly baseRevision: number;
  readonly changes: readonly NativeSpreadsheetOperationChange[];
}

export interface NativeSpreadsheetOperationFrame {
  readonly type: "operation";
  readonly protocol: typeof protocol;
  readonly sheetId: string;
  readonly tabId: string;
  readonly revision: number;
  readonly operation: NativeSpreadsheetOperation;
}

export interface NativeSpreadsheetSyncProviderInput {
  readonly sheetId: string;
  readonly WebSocketCtor?: typeof WebSocket | undefined;
  readonly onStatusChange?: ((status: NativeSpreadsheetSyncStatus) => void) | undefined;
  readonly onOperation?: ((frame: NativeSpreadsheetOperationFrame) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly operationId?: (() => string) | undefined;
  readonly reconnect?: boolean | undefined;
  readonly reconnectDelayMs?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
}

export interface NativeSpreadsheetSyncProviderDisconnectOptions {
  readonly notify?: boolean | undefined;
}

export class NativeSpreadsheetSyncProvider {
  private readonly sheetId: string;
  private readonly WebSocketCtor: typeof WebSocket | undefined;
  private readonly onStatusChange: ((status: NativeSpreadsheetSyncStatus) => void) | undefined;
  private readonly onOperation: ((frame: NativeSpreadsheetOperationFrame) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly operationId: () => string;
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private socket: WebSocket | null = null;
  private revision = 0;
  private status: NativeSpreadsheetSyncStatus = "offline";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: NativeSpreadsheetSyncProviderInput) {
    this.sheetId = input.sheetId;
    this.WebSocketCtor = input.WebSocketCtor ?? globalThis.WebSocket;
    this.onStatusChange = input.onStatusChange;
    this.onOperation = input.onOperation;
    this.onError = input.onError;
    this.operationId = input.operationId ?? randomOperationId;
    this.reconnect = input.reconnect ?? true;
    this.reconnectDelayMs = input.reconnectDelayMs ?? defaultReconnectDelayMs;
    this.maxReconnectAttempts = input.maxReconnectAttempts ?? defaultMaxReconnectAttempts;
  }

  connect(): void {
    this.clearReconnectTimer();
    if (this.socket !== null || this.WebSocketCtor === undefined) {
      this.setStatus("offline");
      return;
    }
    const socket = new this.WebSocketCtor(sheetSyncWebSocketUrl(this.sheetId));
    this.socket = socket;
    this.setStatus("connecting");
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  disconnect(options: NativeSpreadsheetSyncProviderDisconnectOptions = {}): void {
    const notify = options.notify ?? true;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    const socket = this.socket;
    if (socket === null) {
      if (notify) {
        this.setStatus("offline");
      }
      return;
    }
    this.socket = null;
    socket.removeEventListener("open", this.handleOpen);
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    socket.removeEventListener("error", this.handleError);
    socket.close(1000, "native spreadsheet editor closed");
    if (notify) {
      this.setStatus("offline");
    } else {
      this.status = "offline";
    }
  }

  getStatus(): NativeSpreadsheetSyncStatus {
    return this.status;
  }

  canSendCellEdits(edits: readonly SheetsCellEdit[]): boolean {
    return (
      this.canSendOperation() &&
      edits.length > 0 &&
      edits.every((edit) => edit.format === undefined)
    );
  }

  sendCellEdits(tabId: string, edits: readonly SheetsCellEdit[]): boolean {
    if (!this.canSendCellEdits(edits)) {
      return false;
    }
    return this.sendOperation(tabId, edits.map(cellEditToOperationChange));
  }

  canSendOperation(): boolean {
    return this.status === "connected" && this.socket?.readyState === socketOpen;
  }

  sendOperation(tabId: string, changes: readonly NativeSpreadsheetOperationChange[]): boolean {
    if (!this.canSendOperation() || changes.length === 0) {
      return false;
    }
    try {
      this.socket?.send(
        JSON.stringify({
          type: "operation",
          tabId,
          operation: {
            id: this.operationId(),
            baseRevision: this.revision,
            changes,
          },
        }),
      );
    } catch (error) {
      this.handleRealtimeFailure(error);
      return false;
    }
    return true;
  }

  private readonly handleOpen = (): void => {
    this.reconnectAttempts = 0;
    this.setStatus("connected");
  };

  private readonly handleMessage = (event: MessageEvent): void => {
    try {
      const message = parseSocketMessage(event.data);
      if (isReadyFrame(message)) {
        this.revision = message.revision;
        return;
      }
      if (isOperationFrame(message)) {
        this.revision = message.revision;
        this.onOperation?.(message);
        return;
      }
      if (isAckFrame(message)) {
        this.revision = message.revision;
        return;
      }
      if (isErrorFrame(message)) {
        this.handleRealtimeFailure(new Error(message.error));
      }
    } catch (error) {
      this.handleRealtimeFailure(error);
    }
  };

  private readonly handleClose = (): void => {
    const socket = this.socket;
    if (socket !== null) {
      socket.removeEventListener("open", this.handleOpen);
      socket.removeEventListener("message", this.handleMessage);
      socket.removeEventListener("close", this.handleClose);
      socket.removeEventListener("error", this.handleError);
      this.socket = null;
    }
    this.setStatus("offline");
    this.scheduleReconnect();
  };

  private readonly handleError = (event: Event): void => {
    this.handleRealtimeFailure(event);
  };

  private handleRealtimeFailure(error: unknown): void {
    this.onError?.(error);
    const socket = this.socket;
    if (socket === null) {
      this.setStatus("offline");
      return;
    }
    this.socket = null;
    socket.removeEventListener("open", this.handleOpen);
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    socket.removeEventListener("error", this.handleError);
    try {
      socket.close(1011, "native spreadsheet sync failed");
    } catch {
      // Ignore close failures; the provider is already in fallback mode.
    }
    this.setStatus("offline");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (
      !this.reconnect ||
      this.WebSocketCtor === undefined ||
      this.socket !== null ||
      this.reconnectTimer !== null ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: NativeSpreadsheetSyncStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.onStatusChange?.(status);
    }
  }
}

export function sheetSyncWebSocketUrl(sheetId: string): string {
  const path = `/sync/sheets/${encodeURIComponent(sheetId)}?protocol=${protocol}`;
  if (typeof window === "undefined") {
    return addAccessTokenSearchParam(`ws://localhost${path}`);
  }
  const resolved = new URL(path, window.location.href);
  resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  return addAccessTokenSearchParam(resolved.toString());
}

export function applySpreadsheetOperationToTab(
  tab: SheetsApiTabWithCells,
  operation: NativeSpreadsheetOperation,
): SheetsApiTabWithCells {
  let cells = [...tab.cells];
  const now = new Date().toISOString();
  for (const change of operation.changes) {
    if (change.kind === "clear-cell") {
      cells = cells.filter((cell) => cell.row !== change.row || cell.col !== change.col);
      continue;
    }
    if (change.kind === "insert-rows") {
      cells = cells.map((cell) =>
        rebaseCellForStructuralChange(
          cell.row >= change.index ? { ...cell, row: cell.row + change.count } : cell,
          change,
          now,
          cell.row >= change.index,
        ),
      );
      continue;
    }
    if (change.kind === "delete-rows") {
      cells = cells
        .filter((cell) => cell.row < change.index || cell.row >= change.index + change.count)
        .map((cell) =>
          rebaseCellForStructuralChange(
            cell.row >= change.index + change.count
              ? { ...cell, row: cell.row - change.count }
              : cell,
            change,
            now,
            cell.row >= change.index + change.count,
          ),
        );
      continue;
    }
    if (change.kind === "insert-columns") {
      cells = cells.map((cell) =>
        rebaseCellForStructuralChange(
          cell.col >= change.index ? { ...cell, col: cell.col + change.count } : cell,
          change,
          now,
          cell.col >= change.index,
        ),
      );
      continue;
    }
    if (change.kind === "delete-columns") {
      cells = cells
        .filter((cell) => cell.col < change.index || cell.col >= change.index + change.count)
        .map((cell) =>
          rebaseCellForStructuralChange(
            cell.col >= change.index + change.count
              ? { ...cell, col: cell.col - change.count }
              : cell,
            change,
            now,
            cell.col >= change.index + change.count,
          ),
        );
      continue;
    }
    const existing = cells.find((cell) => cell.row === change.row && cell.col === change.col);
    const nextCell = {
      id: existing?.id ?? `sync:${tab.id}:${String(change.row)}:${String(change.col)}`,
      orgId: existing?.orgId,
      sheetTabId: tab.id,
      row: change.row,
      col: change.col,
      value: change.value,
      formula: existing?.formula ?? null,
      calcValue: existing?.calcValue ?? null,
      dependencies: existing?.dependencies ?? [],
      formulaError: existing?.formulaError ?? null,
      format: existing?.format ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    cells = [
      ...cells.filter((cell) => cell.row !== change.row || cell.col !== change.col),
      nextCell,
    ].sort((left, right) => left.row - right.row || left.col - right.col);
  }
  return {
    ...tab,
    cells: cells.sort((left, right) => left.row - right.row || left.col - right.col),
  };
}

export function rebaseSpreadsheetFormulaForStructuralChange(
  value: string,
  change: NativeSpreadsheetOperationChange,
): string {
  if (!value.trimStart().startsWith("=")) {
    return value;
  }
  if (
    change.kind !== "insert-rows" &&
    change.kind !== "delete-rows" &&
    change.kind !== "insert-columns" &&
    change.kind !== "delete-columns"
  ) {
    return value;
  }
  return value.replace(
    /(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/g,
    (match, colAbsolute: string, colLabel: string, rowAbsolute: string, rowLabel: string) => {
      const col = columnIndexFromLabel(colLabel);
      const row = Number.parseInt(rowLabel, 10) - 1;
      if (col === null || !Number.isFinite(row)) {
        return match;
      }
      const nextRow = rebaseStructuralIndex(row, change, "row");
      const nextCol = rebaseStructuralIndex(col, change, "col");
      if (nextRow === null || nextCol === null) {
        return "#REF!";
      }
      return `${colAbsolute}${columnLetter(nextCol)}${rowAbsolute}${String(nextRow + 1)}`;
    },
  );
}

function rebaseCellForStructuralChange(
  cell: SheetsApiTabWithCells["cells"][number],
  change: NativeSpreadsheetOperationChange,
  now: string,
  moved: boolean,
): SheetsApiTabWithCells["cells"][number] {
  const value = rebaseSpreadsheetFormulaForStructuralChange(cell.value, change);
  const formula =
    cell.formula === null
      ? null
      : rebaseSpreadsheetFormulaForStructuralChange(`=${cell.formula}`, change).slice(1);
  return {
    ...cell,
    value,
    formula,
    updatedAt: moved || value !== cell.value || formula !== cell.formula ? now : cell.updatedAt,
  };
}

function rebaseStructuralIndex(
  index: number,
  change: NativeSpreadsheetOperationChange,
  axis: "row" | "col",
): number | null {
  if (axis === "row") {
    if (change.kind === "insert-rows") {
      return index >= change.index ? index + change.count : index;
    }
    if (change.kind === "delete-rows") {
      if (index >= change.index && index < change.index + change.count) {
        return null;
      }
      return index >= change.index + change.count ? index - change.count : index;
    }
    return index;
  }
  if (change.kind === "insert-columns") {
    return index >= change.index ? index + change.count : index;
  }
  if (change.kind === "delete-columns") {
    if (index >= change.index && index < change.index + change.count) {
      return null;
    }
    return index >= change.index + change.count ? index - change.count : index;
  }
  return index;
}

function columnIndexFromLabel(label: string): number | null {
  let index = 0;
  for (const char of label) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) {
      return null;
    }
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function columnLetter(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function cellEditToOperationChange(edit: SheetsCellEdit): NativeSpreadsheetOperationChange {
  if (edit.value.length === 0) {
    return { kind: "clear-cell", row: edit.row, col: edit.col };
  }
  return { kind: "set-cell", row: edit.row, col: edit.col, value: edit.value };
}

function parseSocketMessage(data: unknown): unknown {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  throw new TypeError("Expected native spreadsheet sync JSON message.");
}

function isReadyFrame(
  value: unknown,
): value is { readonly type: "ready"; readonly revision: number } {
  return isRecord(value) && value.type === "ready" && Number.isInteger(value.revision);
}

function isOperationFrame(value: unknown): value is NativeSpreadsheetOperationFrame {
  return (
    isRecord(value) &&
    value.type === "operation" &&
    value.protocol === protocol &&
    typeof value.sheetId === "string" &&
    typeof value.tabId === "string" &&
    Number.isInteger(value.revision) &&
    isNativeSpreadsheetOperation(value.operation)
  );
}

function isAckFrame(value: unknown): value is { readonly type: "ack"; readonly revision: number } {
  return isRecord(value) && value.type === "ack" && Number.isInteger(value.revision);
}

function isErrorFrame(value: unknown): value is { readonly type: "error"; readonly error: string } {
  return isRecord(value) && value.type === "error" && typeof value.error === "string";
}

function isNativeSpreadsheetOperation(value: unknown): value is NativeSpreadsheetOperation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Number.isInteger(value.baseRevision) &&
    Array.isArray(value.changes) &&
    value.changes.every(isNativeSpreadsheetOperationChange)
  );
}

function isNativeSpreadsheetOperationChange(
  value: unknown,
): value is NativeSpreadsheetOperationChange {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.kind === "set-cell" &&
    Number.isInteger(value.row) &&
    Number.isInteger(value.col) &&
    typeof value.value === "string"
  ) {
    return true;
  }
  if (value.kind === "clear-cell" && Number.isInteger(value.row) && Number.isInteger(value.col)) {
    return true;
  }
  const index = value.index;
  const count = value.count;
  return (
    (value.kind === "insert-rows" ||
      value.kind === "delete-rows" ||
      value.kind === "insert-columns" ||
      value.kind === "delete-columns") &&
    Number.isInteger(index) &&
    typeof index === "number" &&
    index >= 0 &&
    Number.isInteger(count) &&
    typeof count === "number" &&
    count > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `op-${Date.now().toString(36)}`;
}
