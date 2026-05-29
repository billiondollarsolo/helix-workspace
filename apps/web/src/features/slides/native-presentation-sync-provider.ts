import { addAccessTokenSearchParam } from "@/lib/auth";
import type { SlidesApiDeck, SlidesApiDeckDetail, SlidesApiSlide } from "./api";
import type { SlideContent } from "./seed";

const socketOpen = 1;
const protocol = "slides-sync";
const defaultReconnectDelayMs = 1_000;
const defaultMaxReconnectAttempts = 5;

export type NativePresentationSyncStatus = "offline" | "connecting" | "connected";
export type NativePresentationAwarenessMode = "editing" | "presenting";

export type NativePresentationOperation =
  | {
      readonly kind: "update-deck";
      readonly title?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly kind: "create-slide";
      readonly content: SlideContent;
      readonly speakerNotes?: string;
      readonly position?: number;
    }
  | {
      readonly kind: "update-slide";
      readonly slideId: string;
      readonly content?: SlideContent;
      readonly speakerNotes?: string;
      /** Per-slide CAS token; see SlidesApiSlide.revision. */
      readonly expectedRevision?: number;
    }
  | {
      readonly kind: "delete-slide";
      readonly slideId: string;
      readonly expectedRevision?: number;
    }
  | {
      readonly kind: "reorder-slides";
      readonly slideIds: readonly string[];
    };

export interface NativePresentationSnapshotFrame extends SlidesApiDeckDetail {
  readonly type: "operation";
  readonly protocol: typeof protocol;
  readonly deckId: string;
  readonly operationId: string;
  readonly revision: number;
  readonly operation: NativePresentationOperation;
}

export interface NativePresentationReadyFrame extends SlidesApiDeckDetail {
  readonly type: "ready";
  readonly protocol: typeof protocol;
  readonly deckId: string;
  readonly revision: number;
  readonly awareness?: readonly NativePresentationWireAwarenessState[];
}

export interface NativePresentationAwarenessState {
  readonly actorId: string;
  readonly displayName: string;
  readonly selectedSlideId: string | null;
  readonly selectedShapeId: string | null;
  readonly mode: NativePresentationAwarenessMode;
  readonly updatedAt: string;
}

export interface NativePresentationAwarenessFrame extends NativePresentationAwarenessState {
  readonly type: "awareness";
  readonly protocol: typeof protocol;
  readonly deckId: string;
  readonly status: "active" | "left";
}

interface NativePresentationWireAwarenessState extends Omit<
  NativePresentationAwarenessState,
  "selectedShapeId"
> {
  readonly selectedShapeId?: string | null;
}

interface NativePresentationWireAwarenessFrame extends NativePresentationWireAwarenessState {
  readonly type: "awareness";
  readonly protocol: typeof protocol;
  readonly deckId: string;
  readonly status: "active" | "left";
}

/**
 * Server-side per-slide CAS rejection. The client's pending edit was based on
 * a stale slide revision because another writer mutated the same slide first.
 * The frame ships the authoritative snapshot so the client can rebase. This
 * is the interim safety net for concurrent slide edits — see
 * docs/reviews/follow-up.md.
 */
export interface NativePresentationSlideConflictFrame extends SlidesApiDeckDetail {
  readonly type: "slide-conflict";
  readonly protocol: typeof protocol;
  readonly deckId: string;
  readonly operationId: string;
  readonly revision: number;
  readonly slideId: string;
  readonly currentSlideRevision: number;
}

export interface NativePresentationSyncProviderInput {
  readonly deckId: string;
  readonly WebSocketCtor?: typeof WebSocket | undefined;
  readonly onStatusChange?: ((status: NativePresentationSyncStatus) => void) | undefined;
  readonly onSnapshot?: ((snapshot: SlidesApiDeckDetail) => void) | undefined;
  readonly onOperation?: ((frame: NativePresentationSnapshotFrame) => void) | undefined;
  readonly onAwareness?: ((frame: NativePresentationAwarenessFrame) => void) | undefined;
  readonly onConflict?: ((frame: NativePresentationSlideConflictFrame) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly operationId?: (() => string) | undefined;
  readonly reconnect?: boolean | undefined;
  readonly reconnectDelayMs?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
}

export interface NativePresentationSyncProviderDisconnectOptions {
  readonly notify?: boolean | undefined;
}

export class NativePresentationSyncProvider {
  private readonly deckId: string;
  private readonly WebSocketCtor: typeof WebSocket | undefined;
  private readonly onStatusChange: ((status: NativePresentationSyncStatus) => void) | undefined;
  private readonly onSnapshot: ((snapshot: SlidesApiDeckDetail) => void) | undefined;
  private readonly onOperation: ((frame: NativePresentationSnapshotFrame) => void) | undefined;
  private readonly onAwareness: ((frame: NativePresentationAwarenessFrame) => void) | undefined;
  private readonly onConflict: ((frame: NativePresentationSlideConflictFrame) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly operationId: () => string;
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private socket: WebSocket | null = null;
  private status: NativePresentationSyncStatus = "offline";
  private revision = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: NativePresentationSyncProviderInput) {
    this.deckId = input.deckId;
    this.WebSocketCtor = input.WebSocketCtor ?? globalThis.WebSocket;
    this.onStatusChange = input.onStatusChange;
    this.onSnapshot = input.onSnapshot;
    this.onOperation = input.onOperation;
    this.onAwareness = input.onAwareness;
    this.onConflict = input.onConflict;
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
    const socket = new this.WebSocketCtor(presentationSyncWebSocketUrl(this.deckId));
    this.socket = socket;
    this.setStatus("connecting");
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  disconnect(options: NativePresentationSyncProviderDisconnectOptions = {}): void {
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
    socket.close(1000, "native presentation editor closed");
    if (notify) {
      this.setStatus("offline");
    } else {
      this.status = "offline";
    }
  }

  getStatus(): NativePresentationSyncStatus {
    return this.status;
  }

  canSendOperation(): boolean {
    return this.status === "connected" && this.socket?.readyState === socketOpen;
  }

  sendOperation(operation: NativePresentationOperation): string | null {
    if (!this.canSendOperation()) {
      return null;
    }
    const operationId = this.operationId();
    try {
      this.socket?.send(
        JSON.stringify({
          type: "operation",
          operationId,
          baseRevision: this.revision,
          operation,
        }),
      );
    } catch (error) {
      this.handleRealtimeFailure(error);
      return null;
    }
    return operationId;
  }

  sendAwareness(input: {
    readonly selectedSlideId?: string | null | undefined;
    readonly selectedShapeId?: string | null | undefined;
    readonly mode?: NativePresentationAwarenessMode | undefined;
  }): boolean {
    if (!this.canSendOperation()) {
      return false;
    }
    try {
      this.socket?.send(
        JSON.stringify({
          type: "awareness",
          ...(input.selectedSlideId === undefined
            ? {}
            : { selectedSlideId: input.selectedSlideId }),
          ...(input.selectedShapeId === undefined
            ? {}
            : { selectedShapeId: input.selectedShapeId }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
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
        this.onSnapshot?.({ deck: message.deck, slides: message.slides });
        for (const awareness of message.awareness ?? []) {
          this.onAwareness?.(
            normalizeAwarenessFrame({
              type: "awareness",
              protocol,
              deckId: message.deckId,
              status: "active",
              ...awareness,
            }),
          );
        }
        return;
      }
      if (isSnapshotFrame(message)) {
        this.revision = message.revision;
        this.onSnapshot?.({ deck: message.deck, slides: message.slides });
        this.onOperation?.(message);
        return;
      }
      if (isSlideConflictFrame(message)) {
        // Adopt server snapshot so subsequent edits are based on fresh
        // content. The user's pending optimistic edit is intentionally
        // discarded — preserving it would re-introduce the data-loss bug.
        this.revision = message.revision;
        this.onSnapshot?.({ deck: message.deck, slides: message.slides });
        this.onConflict?.(message);
        return;
      }
      if (isErrorFrame(message)) {
        const { revision } = message;
        if (typeof revision === "number" && Number.isInteger(revision)) {
          this.revision = revision;
        }
        this.handleRealtimeFailure(new Error(message.error));
        return;
      }
      if (isAwarenessFrame(message)) {
        this.onAwareness?.(normalizeAwarenessFrame(message));
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
      socket.close(1011, "native presentation sync failed");
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

  private setStatus(status: NativePresentationSyncStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.onStatusChange?.(status);
    }
  }
}

export function presentationSyncWebSocketUrl(deckId: string): string {
  const path = `/sync/slides/${encodeURIComponent(deckId)}?protocol=${protocol}`;
  if (typeof window === "undefined") {
    return addAccessTokenSearchParam(`ws://localhost${path}`);
  }
  const resolved = new URL(path, window.location.href);
  resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  return addAccessTokenSearchParam(resolved.toString());
}

function parseSocketMessage(data: unknown): unknown {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  throw new TypeError("Expected native presentation sync JSON message.");
}

function isReadyFrame(value: unknown): value is NativePresentationReadyFrame {
  return (
    isRecord(value) &&
    value.type === "ready" &&
    value.protocol === protocol &&
    typeof value.deckId === "string" &&
    Number.isInteger(value.revision) &&
    isDeck(value.deck) &&
    Array.isArray(value.slides) &&
    value.slides.every(isSlide) &&
    (value.awareness === undefined ||
      (Array.isArray(value.awareness) && value.awareness.every(isAwarenessState)))
  );
}

function isSnapshotFrame(value: unknown): value is NativePresentationSnapshotFrame {
  return (
    isRecord(value) &&
    value.type === "operation" &&
    value.protocol === protocol &&
    typeof value.deckId === "string" &&
    typeof value.operationId === "string" &&
    Number.isInteger(value.revision) &&
    isNativePresentationOperation(value.operation) &&
    isDeck(value.deck) &&
    Array.isArray(value.slides) &&
    value.slides.every(isSlide)
  );
}

function isErrorFrame(
  value: unknown,
): value is { readonly type: "error"; readonly error: string; readonly revision?: number } {
  return (
    isRecord(value) &&
    value.type === "error" &&
    typeof value.error === "string" &&
    (value.revision === undefined || Number.isInteger(value.revision))
  );
}

function isSlideConflictFrame(value: unknown): value is NativePresentationSlideConflictFrame {
  return (
    isRecord(value) &&
    value.type === "slide-conflict" &&
    value.protocol === protocol &&
    typeof value.deckId === "string" &&
    typeof value.operationId === "string" &&
    typeof value.slideId === "string" &&
    Number.isInteger(value.revision) &&
    Number.isInteger(value.currentSlideRevision) &&
    isDeck(value.deck) &&
    Array.isArray(value.slides) &&
    value.slides.every(isSlide)
  );
}

function isAwarenessFrame(value: unknown): value is NativePresentationWireAwarenessFrame {
  return (
    isRecord(value) &&
    value.type === "awareness" &&
    value.protocol === protocol &&
    typeof value.deckId === "string" &&
    (value.status === "active" || value.status === "left") &&
    isAwarenessState(value)
  );
}

function isAwarenessState(value: unknown): value is NativePresentationWireAwarenessState {
  return (
    isRecord(value) &&
    typeof value.actorId === "string" &&
    typeof value.displayName === "string" &&
    (typeof value.selectedSlideId === "string" || value.selectedSlideId === null) &&
    (value.selectedShapeId === undefined ||
      typeof value.selectedShapeId === "string" ||
      value.selectedShapeId === null) &&
    (value.mode === "editing" || value.mode === "presenting") &&
    typeof value.updatedAt === "string"
  );
}

function normalizeAwarenessFrame(
  frame: NativePresentationWireAwarenessFrame,
): NativePresentationAwarenessFrame {
  return {
    ...frame,
    selectedShapeId: frame.selectedShapeId ?? null,
  };
}

function isDeck(value: unknown): value is SlidesApiDeck {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    Number.isInteger(value.slideCount) &&
    isRecord(value.metadata) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isSlide(value: unknown): value is SlidesApiSlide {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.deckId === "string" &&
    Number.isInteger(value.position) &&
    isRecord(value.content) &&
    typeof value.speakerNotes === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isNativePresentationOperation(value: unknown): value is NativePresentationOperation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  return (
    value.kind === "update-deck" ||
    value.kind === "create-slide" ||
    value.kind === "update-slide" ||
    value.kind === "delete-slide" ||
    value.kind === "reorder-slides"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `op-${Date.now().toString(36)}`;
}
