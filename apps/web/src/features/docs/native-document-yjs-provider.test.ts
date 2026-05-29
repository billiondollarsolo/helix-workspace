// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { storeAccessToken } from "@/lib/auth";
import {
  NativeDocumentYjsProvider,
  applyNativeDocumentState,
  toWebSocketUrl,
} from "./native-document-yjs-provider";

const yjsMessageSync = 0;

describe("native document Yjs provider", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => {
          return storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
    window.history.replaceState(null, "", "/docs/doc-1");
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes Yjs sync URLs and preserves fallback realtime auth", () => {
    expect(toWebSocketUrl("/sync/docs/doc-1?protocol=yjs")).toBe(
      "ws://localhost:3000/sync/docs/doc-1?protocol=yjs",
    );

    storeAccessToken("token-1");

    expect(toWebSocketUrl("/sync/docs/doc-1?protocol=yjs")).toBe(
      "ws://localhost:3000/sync/docs/doc-1?protocol=yjs&access_token=token-1",
    );
    expect(toWebSocketUrl("ws://localhost/sync/docs/doc-1?protocol=yjs")).toBe(
      "ws://localhost/sync/docs/doc-1?protocol=yjs&access_token=token-1",
    );
  });

  it("hydrates valid state and ignores malformed state", () => {
    const source = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Hydrated body");
    paragraph.insert(0, [text]);
    source.getXmlFragment("default").insert(0, [paragraph]);

    const target = new Y.Doc();
    applyNativeDocumentState(target, bytesToBase64(Y.encodeStateAsUpdate(source)));

    expect(xmlFragmentText(target.getXmlFragment("default"))).toBe("Hydrated body");
    expect(() => applyNativeDocumentState(target, "not-valid-yjs-state")).not.toThrow();
  });

  it("syncs document updates over the binary Yjs protocol", () => {
    const serverDoc = new Y.Doc();
    serverDoc.getText("default").insert(0, "Server body");
    const clientDoc = new Y.Doc();
    const statuses: string[] = [];
    const provider = new NativeDocumentYjsProvider({
      url: "/sync/docs/doc-1?protocol=yjs",
      doc: clientDoc,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      onStatusChange: (status) => statuses.push(status),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    expect(socket?.url).toBe("ws://localhost:3000/sync/docs/doc-1?protocol=yjs");
    socket?.open();

    const clientSyncStep1 = socket?.sent[0];
    expect(clientSyncStep1).toBeInstanceOf(Uint8Array);
    const serverResponse = readSyncFrame(serverDoc, clientSyncStep1 ?? new Uint8Array(), "server");
    expect(serverResponse).not.toBeNull();
    socket?.receive(serverResponse ?? new Uint8Array());

    expect(clientDoc.getText("default").toJSON()).toBe("Server body");
    expect(statuses).toEqual(["connecting", "connected"]);

    clientDoc.getText("default").insert(11, "!");
    const clientUpdate = socket?.sent.at(-1);
    expect(clientUpdate).toBeInstanceOf(Uint8Array);
    expect(readSyncFrame(serverDoc, clientUpdate ?? new Uint8Array(), "server")).toBeNull();
    expect(serverDoc.getText("default").toJSON()).toBe("Server body!");

    provider.disconnect();
    expect(provider.getStatus()).toBe("offline");
    expect(socket?.closed).toBe(true);
  });

  it("goes offline when sending a Yjs update fails", () => {
    const statuses: string[] = [];
    const errors: unknown[] = [];
    const clientDoc = new Y.Doc();
    const provider = new NativeDocumentYjsProvider({
      url: "/sync/docs/doc-1?protocol=yjs",
      doc: clientDoc,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      onStatusChange: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();
    if (socket !== undefined) {
      socket.throwOnSend = true;
    }

    clientDoc.getText("default").insert(0, "fallback");

    expect(provider.getStatus()).toBe("offline");
    expect(socket?.closed).toBe(true);
    expect(statuses).toEqual(["connecting", "connected", "offline"]);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("can disconnect during React cleanup without reporting offline to an unmounting component", () => {
    const statuses: string[] = [];
    const provider = new NativeDocumentYjsProvider({
      url: "/sync/docs/doc-1?protocol=yjs",
      doc: new Y.Doc(),
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

  it("reconnects after an unexpected close without duplicating document listeners", () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const clientDoc = new Y.Doc();
    const provider = new NativeDocumentYjsProvider({
      url: "/sync/docs/doc-1?protocol=yjs",
      doc: clientDoc,
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

    const sentBeforeUpdate = secondSocket?.sent.length ?? 0;
    clientDoc.getText("default").insert(0, "reconnected");
    expect(secondSocket?.sent).toHaveLength(sentBeforeUpdate + 1);
  });
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
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
    if (data instanceof Uint8Array) {
      this.sent.push(data);
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

  receive(data: Uint8Array): void {
    this.emit("message", { data } as MessageEvent);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
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

function readSyncFrame(doc: Y.Doc, frame: Uint8Array, origin: unknown): Uint8Array | null {
  const decoder = decoding.createDecoder(frame);
  expect(decoding.readVarUint(decoder)).toBe(yjsMessageSync);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, yjsMessageSync);
  syncProtocol.readSyncMessage(decoder, encoder, doc, origin, (error) => {
    throw error;
  });
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function xmlFragmentText(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .flatMap((child) => {
      if (child instanceof Y.XmlText) {
        return deltaText(child);
      }
      if (child instanceof Y.XmlElement) {
        return child
          .toArray()
          .map((nested) => (nested instanceof Y.XmlText ? deltaText(nested) : ""));
      }
      return "";
    })
    .join("");
}

function deltaText(text: Y.XmlText): string {
  const delta = (text.toDelta as () => readonly { readonly insert?: unknown }[])();
  return delta.map((item) => (typeof item.insert === "string" ? item.insert : "")).join("");
}
