import { addAccessTokenSearchParam } from "@/lib/auth";
import type { SlidesApiDeck, SlidesApiDeckDetail, SlidesApiSlide } from "./api";
import type { SlideContent } from "./seed";

const socketOpen = 1;
const protocol = "slides-sync";

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
    }
  | {
      readonly kind: "delete-slide";
      readonly slideId: string;
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

export interface NativePresentationSyncProviderInput {
  readonly deckId: string;
  readonly WebSocketCtor?: typeof WebSocket | undefined;
  readonly onStatusChange?: ((status: NativePresentationSyncStatus) => void) | undefined;
  readonly onSnapshot?: ((snapshot: SlidesApiDeckDetail) => void) | undefined;
  readonly onOperation?: ((frame: NativePresentationSnapshotFrame) => void) | undefined;
  readonly onAwareness?: ((frame: NativePresentationAwarenessFrame) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly operationId?: (() => string) | undefined;
}

export class NativePresentationSyncProvider {
  private readonly deckId: string;
  private readonly WebSocketCtor: typeof WebSocket | undefined;
  private readonly onStatusChange: ((status: NativePresentationSyncStatus) => void) | undefined;
  private readonly onSnapshot: ((snapshot: SlidesApiDeckDetail) => void) | undefined;
  private readonly onOperation: ((frame: NativePresentationSnapshotFrame) => void) | undefined;
  private readonly onAwareness: ((frame: NativePresentationAwarenessFrame) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly operationId: () => string;
  private socket: WebSocket | null = null;
  private status: NativePresentationSyncStatus = "offline";
  private revision = 0;

  constructor(input: NativePresentationSyncProviderInput) {
    this.deckId = input.deckId;
    this.WebSocketCtor = input.WebSocketCtor ?? globalThis.WebSocket;
    this.onStatusChange = input.onStatusChange;
    this.onSnapshot = input.onSnapshot;
    this.onOperation = input.onOperation;
    this.onAwareness = input.onAwareness;
    this.onError = input.onError;
    this.operationId = input.operationId ?? randomOperationId;
  }

  connect(): void {
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

  disconnect(): void {
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
    socket.close(1000, "native presentation editor closed");
    this.setStatus("offline");
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
    this.socket?.send(
      JSON.stringify({
        type: "operation",
        operationId,
        baseRevision: this.revision,
        operation,
      }),
    );
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
    this.socket?.send(
      JSON.stringify({
        type: "awareness",
        ...(input.selectedSlideId === undefined ? {} : { selectedSlideId: input.selectedSlideId }),
        ...(input.selectedShapeId === undefined ? {} : { selectedShapeId: input.selectedShapeId }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
      }),
    );
    return true;
  }

  private readonly handleOpen = (): void => {
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
      if (isErrorFrame(message)) {
        const { revision } = message;
        if (typeof revision === "number" && Number.isInteger(revision)) {
          this.revision = revision;
        }
        this.onError?.(new Error(message.error));
        return;
      }
      if (isAwarenessFrame(message)) {
        this.onAwareness?.(normalizeAwarenessFrame(message));
      }
    } catch (error) {
      this.onError?.(error);
    }
  };

  private readonly handleClose = (): void => {
    this.socket = null;
    this.setStatus("offline");
  };

  private readonly handleError = (event: Event): void => {
    this.onError?.(event);
  };

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
