/* Docs live-collaboration provider.

   Speaks the Helix backend's binary Yjs sync protocol at
   `/sync/docs/:docId?protocol=yjs` (y-protocols sync + awareness — see
   apps/helix/src/platform/docs/routes.ts → handleYjsDocsSocket).

   The backend selects the binary protocol when the upgrade request carries
   `?protocol=yjs`; without it the socket falls back to a plain-JSON protocol.
   This provider is a minimal stand-in for `y-websocket`'s `WebsocketProvider`
   (which is not a dependency): it binds a `Y.Doc` + `Awareness` to one socket,
   performs the sync handshake, relays document + awareness updates, and
   reconnects with backoff. */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { addAccessTokenSearchParam } from "@/lib/auth";

/** y-protocols message-type tags — must match the backend's constants. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export type DocsCollabStatus = "connecting" | "connected" | "disconnected";

export interface DocsCollabUser {
  /** Stable colour for this user's caret/selection. */
  readonly color: string;
  /** Display name shown on the remote caret label. */
  readonly name: string;
}

export interface DocsCollabPeer {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
}

export interface DocsCollabProviderOptions {
  readonly docId: string;
  readonly doc: Y.Doc;
  readonly user: DocsCollabUser;
  /** Override the WebSocket URL (tests). */
  readonly url?: string;
  /** Override the WebSocket implementation (tests). */
  readonly WebSocketImpl?: typeof WebSocket;
  readonly onStatus?: (status: DocsCollabStatus) => void;
  /** Fired whenever the set of remote awareness peers changes. */
  readonly onPeers?: (peers: readonly DocsCollabPeer[]) => void;
}

/** Builds the `?protocol=yjs` sync WebSocket URL for a document. */
export function docsCollabUrl(docId: string): string {
  const path = `/sync/docs/${encodeURIComponent(docId)}?protocol=yjs`;
  if (typeof window === "undefined") {
    return path;
  }
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return addAccessTokenSearchParam(url.toString());
}

/**
 * Live-collaboration provider for a single Docs document.
 *
 * The {@link doc} and {@link awareness} fields are passed straight to Tiptap's
 * Collaboration / CollaborationCaret extensions.
 */
export class DocsCollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  #socket: WebSocket | null = null;
  #status: DocsCollabStatus = "connecting";
  #destroyed = false;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #url: string;
  readonly #WebSocketImpl: typeof WebSocket;
  #onStatus: ((status: DocsCollabStatus) => void) | undefined;
  #onPeers: ((peers: readonly DocsCollabPeer[]) => void) | undefined;

  constructor(options: DocsCollabProviderOptions) {
    this.doc = options.doc;
    this.awareness = new awarenessProtocol.Awareness(options.doc);
    this.awareness.setLocalStateField("user", {
      name: options.user.name,
      color: options.user.color,
    });

    this.#url = options.url ?? docsCollabUrl(options.docId);
    this.#WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.#onStatus = options.onStatus;
    this.#onPeers = options.onPeers;

    this.doc.on("update", this.#handleDocUpdate);
    this.awareness.on("update", this.#handleAwarenessUpdate);

    this.#connect();
  }

  get status(): DocsCollabStatus {
    return this.#status;
  }

  /**
   * Attaches (or replaces) the status/peer callbacks. Used when the provider
   * is created synchronously but its consumer wires React state in an effect.
   * Immediately replays the current status + peer set to the new handlers.
   */
  setHandlers(handlers: {
    readonly onStatus?: (status: DocsCollabStatus) => void;
    readonly onPeers?: (peers: readonly DocsCollabPeer[]) => void;
  }): void {
    this.#onStatus = handlers.onStatus;
    this.#onPeers = handlers.onPeers;
    handlers.onStatus?.(this.#status);
    this.#emitPeers();
  }

  /** Tears the provider down: closes the socket and clears awareness state. */
  destroy(): void {
    this.#destroyed = true;
    if (this.#reconnectTimer !== null) {
      // eslint-disable-next-line helix/pacer-discipline -- non-React class; WebSocket reconnect backoff cannot use Pacer hooks.
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.doc.off("update", this.#handleDocUpdate);
    this.awareness.off("update", this.#handleAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "provider-destroy",
    );
    this.awareness.destroy();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        /* socket already closing */
      }
    }
  }

  #connect(): void {
    if (this.#destroyed) {
      return;
    }
    this.#setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new this.#WebSocketImpl(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("open", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#reconnectAttempts = 0;
      this.#setStatus("connected");
      // Sync step 1 — advertise our state vector so the server replies with
      // anything we are missing.
      this.#send((encoder) => {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, this.doc);
      });
      // Publish our awareness (the local caret) to peers already in the room.
      if (this.awareness.getLocalState() !== null) {
        this.#send((encoder) => {
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
          );
        });
      }
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.#socket === socket) {
        this.#handleMessage(event.data);
      }
    });

    socket.addEventListener("close", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = null;
      // Drop remote peers — their carets are stale once we disconnect.
      const remoteClients = [...this.awareness.getStates().keys()].filter(
        (clientId) => clientId !== this.doc.clientID,
      );
      if (remoteClients.length > 0) {
        awarenessProtocol.removeAwarenessStates(this.awareness, remoteClients, "disconnect");
      }
      this.#emitPeers();
      this.#scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // `close` always follows `error`; reconnect is scheduled there.
    });
  }

  #handleMessage(raw: unknown): void {
    const bytes = toUint8Array(raw);
    if (bytes === null || bytes.length === 0) {
      return;
    }
    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      // The provider itself is the transaction origin so our own
      // `doc.on("update")` handler skips re-broadcasting server-applied data.
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) {
        this.#sendEncoded(encoding.toUint8Array(encoder));
      }
      return;
    }

    if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
      this.#emitPeers();
    }
  }

  readonly #handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Skip updates we just applied from the socket (origin === this).
    if (origin === this) {
      return;
    }
    this.#send((encoder) => {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
    });
  };

  readonly #handleAwarenessUpdate = (
    changes: { readonly added: number[]; readonly updated: number[]; readonly removed: number[] },
    origin: unknown,
  ): void => {
    // Awareness changes that arrived from the socket are already broadcast by
    // peers; only relay our own local changes.
    if (origin === this) {
      this.#emitPeers();
      return;
    }
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    this.#send((encoder) => {
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
      );
    });
    this.#emitPeers();
  };

  #emitPeers(): void {
    if (this.#onPeers === undefined) {
      return;
    }
    const peers: DocsCollabPeer[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) {
        continue;
      }
      const user = (state as { readonly user?: { name?: unknown; color?: unknown } }).user;
      peers.push({
        clientId,
        name: typeof user?.name === "string" ? user.name : "Collaborator",
        color: typeof user?.color === "string" ? user.color : "#6366f1",
      });
    }
    this.#onPeers(peers);
  }

  #send(write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder();
    write(encoder);
    this.#sendEncoded(encoding.toUint8Array(encoder));
  }

  #sendEncoded(payload: Uint8Array): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== this.#WebSocketImpl.OPEN) {
      return;
    }
    try {
      socket.send(payload);
    } catch {
      /* socket dropped mid-send; close handler reconnects */
    }
  }

  #scheduleReconnect(): void {
    if (this.#destroyed) {
      return;
    }
    this.#setStatus("disconnected");
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.#reconnectAttempts,
      RECONNECT_MAX_MS,
    );
    this.#reconnectAttempts += 1;
    // eslint-disable-next-line helix/pacer-discipline -- non-React class; WebSocket reconnect backoff cannot use Pacer hooks.
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #setStatus(status: DocsCollabStatus): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#onStatus?.(status);
  }
}

function toUint8Array(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

/** Deterministic caret colour from a user identifier. */
export function collabColorFor(seed: string): string {
  const palette = [
    "#0891b2",
    "#7c3aed",
    "#db2777",
    "#059669",
    "#ea580c",
    "#2563eb",
    "#d97706",
    "#dc2626",
  ];
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return palette[Math.abs(hash) % palette.length] ?? palette[0]!;
}
