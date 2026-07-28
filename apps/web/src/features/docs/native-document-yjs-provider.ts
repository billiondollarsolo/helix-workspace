import { Debouncer } from "@tanstack/pacer";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { addAccessTokenSearchParam } from "@/lib/auth";

const yjsMessageSync = 0;
const yjsMessageAwareness = 1;
const socketOpen = 1;
const defaultReconnectDelayMs = 1_000;
const defaultMaxReconnectAttempts = 5;

export type NativeDocumentProviderStatus = "offline" | "connecting" | "connected";

export interface NativeDocumentYjsProviderInput {
  readonly url: string;
  readonly doc: Y.Doc;
  readonly awareness?: awarenessProtocol.Awareness | undefined;
  readonly WebSocketCtor?: typeof WebSocket | undefined;
  readonly onStatusChange?: ((status: NativeDocumentProviderStatus) => void) | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly reconnect?: boolean | undefined;
  readonly reconnectDelayMs?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
}

export interface NativeDocumentYjsProviderDisconnectOptions {
  readonly notify?: boolean | undefined;
}

export class NativeDocumentYjsProvider {
  readonly awareness: awarenessProtocol.Awareness;
  private readonly url: string;
  private readonly doc: Y.Doc;
  private readonly WebSocketCtor: typeof WebSocket | undefined;
  private readonly ownsAwareness: boolean;
  private readonly onStatusChange: ((status: NativeDocumentProviderStatus) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private socket: WebSocket | null = null;
  private status: NativeDocumentProviderStatus = "offline";
  private listening = false;
  private reconnectAttempts = 0;
  private readonly reconnectDebouncer: Debouncer<() => void>;

  constructor(input: NativeDocumentYjsProviderInput) {
    this.url = input.url;
    this.doc = input.doc;
    this.WebSocketCtor = input.WebSocketCtor ?? globalThis.WebSocket;
    this.ownsAwareness = input.awareness === undefined;
    this.awareness = input.awareness ?? new awarenessProtocol.Awareness(input.doc);
    this.onStatusChange = input.onStatusChange;
    this.onError = input.onError;
    this.reconnect = input.reconnect ?? true;
    this.reconnectDelayMs = input.reconnectDelayMs ?? defaultReconnectDelayMs;
    this.maxReconnectAttempts = input.maxReconnectAttempts ?? defaultMaxReconnectAttempts;
    this.reconnectDebouncer = new Debouncer(
      () => {
        this.connect();
      },
      { wait: this.reconnectDelayMs },
    );
  }

  connect(): void {
    this.reconnectDebouncer.cancel();
    if (this.socket !== null || this.WebSocketCtor === undefined) {
      this.setStatus("offline");
      return;
    }
    const socket = new this.WebSocketCtor(toWebSocketUrl(this.url));
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.setStatus("connecting");
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
    this.attachLocalListeners();
  }

  disconnect(options: NativeDocumentYjsProviderDisconnectOptions = {}): void {
    const notify = options.notify ?? true;
    this.reconnectDebouncer.cancel();
    this.reconnectAttempts = 0;
    const socket = this.socket;
    this.detachLocalListeners();
    if (this.ownsAwareness) {
      this.awareness.destroy();
    }
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
    socket.close(1000, "native document editor closed");
    if (notify) {
      this.setStatus("offline");
    } else {
      this.status = "offline";
    }
  }

  getStatus(): NativeDocumentProviderStatus {
    return this.status;
  }

  private readonly handleOpen = (): void => {
    this.reconnectAttempts = 0;
    this.setStatus("connected");
    this.sendFrame(
      encodeSyncFrame((encoder) => {
        syncProtocol.writeSyncStep1(encoder, this.doc);
      }),
    );
    this.sendAwareness([this.awareness.clientID]);
  };

  private readonly handleMessage = (event: MessageEvent): void => {
    try {
      const message = toUint8Array(event.data);
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === yjsMessageSync) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, yjsMessageSync);
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, this, (error) => {
          throw error;
        });
        if (encoding.length(encoder) > 1) {
          this.sendFrame(encoding.toUint8Array(encoder));
        }
        return;
      }
      if (messageType === yjsMessageAwareness) {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this,
        );
        return;
      }
      throw new Error(`Unknown native document Yjs message type: ${String(messageType)}`);
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
    this.detachLocalListeners();
    this.setStatus("offline");
    this.scheduleReconnect();
  };

  private readonly handleError = (event: Event): void => {
    this.handleRealtimeFailure(event);
  };

  private readonly handleDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this) {
      this.sendFrame(
        encodeSyncFrame((encoder) => {
          syncProtocol.writeUpdate(encoder, update);
        }),
      );
    }
  };

  private readonly handleAwarenessUpdate = (
    change: {
      readonly added: readonly number[];
      readonly updated: readonly number[];
      readonly removed: readonly number[];
    },
    origin: unknown,
  ): void => {
    if (origin !== this) {
      this.sendAwareness([...change.added, ...change.updated, ...change.removed]);
    }
  };

  private sendAwareness(clientIds: readonly number[]): void {
    if (clientIds.length === 0) {
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, yjsMessageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...clientIds]),
    );
    this.sendFrame(encoding.toUint8Array(encoder));
  }

  private sendFrame(frame: Uint8Array): void {
    if (this.socket?.readyState === socketOpen) {
      try {
        this.socket.send(frame);
      } catch (error) {
        this.handleRealtimeFailure(error);
      }
    }
  }

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
    this.detachLocalListeners();
    try {
      socket.close(1011, "native document sync failed");
    } catch {
      // Ignore close failures; the provider is already offline.
    }
    this.setStatus("offline");
    this.scheduleReconnect();
  }

  private attachLocalListeners(): void {
    if (this.listening) {
      return;
    }
    this.doc.on("update", this.handleDocumentUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
    this.listening = true;
  }

  private detachLocalListeners(): void {
    if (!this.listening) {
      return;
    }
    this.doc.off("update", this.handleDocumentUpdate);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.listening = false;
  }

  private scheduleReconnect(): void {
    if (
      !this.reconnect ||
      this.WebSocketCtor === undefined ||
      this.socket !== null ||
      this.reconnectDebouncer.store.state.isPending ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectDebouncer.maybeExecute();
  }

  private setStatus(status: NativeDocumentProviderStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.onStatusChange?.(status);
    }
  }
}

export function applyNativeDocumentState(doc: Y.Doc, stateBase64: string | null): void {
  const state = base64ToUint8Array(stateBase64);
  if (state !== null && state.byteLength > 0) {
    try {
      Y.applyUpdate(doc, state);
    } catch {
      // Treat malformed stored state as an empty document; the session route
      // remains usable and the next server sync can repair local state.
    }
  }
}

export function toWebSocketUrl(url: string): string {
  if (/^wss?:\/\//iu.test(url)) {
    return addAccessTokenSearchParam(url);
  }
  const base = typeof window === "undefined" ? "http://localhost" : window.location.href;
  const resolved = new URL(url, base);
  resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  return addAccessTokenSearchParam(resolved.toString());
}

function encodeSyncFrame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, yjsMessageSync);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

function base64ToUint8Array(value: string | null): Uint8Array | null {
  if (value === null || value.length === 0) {
    return null;
  }
  try {
    const binary = globalThis.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError("Expected native document Yjs binary message.");
}
