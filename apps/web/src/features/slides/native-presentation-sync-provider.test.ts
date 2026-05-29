// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeAccessToken } from "@/lib/auth";
import {
  NativePresentationSyncProvider,
  presentationSyncWebSocketUrl,
} from "./native-presentation-sync-provider";

const deckId = "11111111-1111-4111-8111-111111111111";
const slideId = "22222222-2222-4222-8222-222222222222";

describe("native presentation sync provider", () => {
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
    window.history.replaceState(null, "", "/slides/deck-1");
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes Slides sync URLs and preserves fallback realtime auth", () => {
    expect(presentationSyncWebSocketUrl("deck 1")).toBe(
      "ws://localhost:3000/sync/slides/deck%201?protocol=slides-sync",
    );

    storeAccessToken("token-1");

    expect(presentationSyncWebSocketUrl("deck 1")).toBe(
      "ws://localhost:3000/sync/slides/deck%201?protocol=slides-sync&access_token=token-1",
    );
  });

  it("sends slide update operations over the open socket", () => {
    const provider = new NativePresentationSyncProvider({
      deckId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      operationId: () => "op-1",
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    expect(socket?.url).toBe(`ws://localhost:3000/sync/slides/${deckId}?protocol=slides-sync`);
    socket?.open();

    expect(
      provider.sendOperation({
        kind: "update-slide",
        slideId,
        content: { layout: "title", title: "Updated" },
        speakerNotes: "Notes",
      }),
    ).toBe("op-1");
    expect(socket?.sent).toEqual([
      {
        type: "operation",
        operationId: "op-1",
        baseRevision: 0,
        operation: {
          kind: "update-slide",
          slideId,
          content: { layout: "title", title: "Updated" },
          speakerNotes: "Notes",
        },
      },
    ]);
  });

  it("returns null and goes offline when realtime send fails", () => {
    const statuses: string[] = [];
    const errors: unknown[] = [];
    const provider = new NativePresentationSyncProvider({
      deckId,
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

    expect(
      provider.sendOperation({
        kind: "update-slide",
        slideId,
        content: { layout: "title", title: "Fallback" },
        speakerNotes: "",
      }),
    ).toBeNull();

    expect(provider.getStatus()).toBe("offline");
    expect(socket?.closed).toBe(true);
    expect(statuses).toEqual(["connecting", "connected", "offline"]);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("can disconnect during React cleanup without reporting offline to an unmounting component", () => {
    const statuses: string[] = [];
    const provider = new NativePresentationSyncProvider({
      deckId,
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
    const provider = new NativePresentationSyncProvider({
      deckId,
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

  it("applies ready and operation snapshots to callers", () => {
    const snapshots: unknown[] = [];
    const operations: unknown[] = [];
    const provider = new NativePresentationSyncProvider({
      deckId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onOperation: (frame) => operations.push(frame.operationId),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();
    socket?.receive({
      type: "ready",
      protocol: "slides-sync",
      deckId,
      revision: 0,
      deck: deck(),
      slides: [slide("Original")],
    });
    socket?.receive({
      type: "operation",
      protocol: "slides-sync",
      deckId,
      operationId: "op-remote",
      revision: 1,
      operation: {
        kind: "update-slide",
        slideId,
        content: { layout: "title", title: "Remote" },
      },
      deck: deck(),
      slides: [slide("Remote")],
    });

    expect(snapshots).toEqual([
      { deck: deck(), slides: [slide("Original")] },
      { deck: deck(), slides: [slide("Remote")] },
    ]);
    expect(operations).toEqual(["op-remote"]);
  });

  it("advances revisions from server frames and sends the latest base revision", () => {
    const provider = new NativePresentationSyncProvider({
      deckId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      operationId: () => "op-local",
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();
    socket?.receive({
      type: "ready",
      protocol: "slides-sync",
      deckId,
      revision: 3,
      deck: deck(),
      slides: [slide("Ready")],
    });

    provider.sendOperation({
      kind: "update-slide",
      slideId,
      content: { layout: "title", title: "Local" },
    });
    expect(socket?.sent.at(-1)).toMatchObject({
      type: "operation",
      operationId: "op-local",
      baseRevision: 3,
    });

    socket?.receive({
      type: "operation",
      protocol: "slides-sync",
      deckId,
      operationId: "op-remote",
      revision: 4,
      operation: {
        kind: "update-slide",
        slideId,
        content: { layout: "title", title: "Remote" },
      },
      deck: deck(),
      slides: [slide("Remote")],
    });
    provider.sendOperation({
      kind: "update-slide",
      slideId,
      content: { layout: "title", title: "After remote" },
    });

    expect(socket?.sent.at(-1)).toMatchObject({ baseRevision: 4 });
  });

  it("sends and receives slide-level awareness frames", () => {
    const awareness: unknown[] = [];
    const provider = new NativePresentationSyncProvider({
      deckId,
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      onAwareness: (frame) => awareness.push(frame),
    });

    provider.connect();
    const socket = MockWebSocket.instances.at(-1);
    socket?.open();

    expect(
      provider.sendAwareness({
        selectedSlideId: slideId,
        selectedShapeId: "shape-1",
        mode: "presenting",
      }),
    ).toBe(true);
    expect(socket?.sent.at(-1)).toEqual({
      type: "awareness",
      selectedSlideId: slideId,
      selectedShapeId: "shape-1",
      mode: "presenting",
    });

    socket?.receive({
      type: "ready",
      protocol: "slides-sync",
      deckId,
      revision: 0,
      deck: deck(),
      slides: [slide("Ready")],
      awareness: [
        {
          actorId: "actor-2",
          displayName: "Grace Hopper",
          selectedSlideId: slideId,
          selectedShapeId: "shape-2",
          mode: "editing",
          updatedAt: "2026-05-20T12:01:00.000Z",
        },
      ],
    });
    socket?.receive({
      type: "awareness",
      protocol: "slides-sync",
      deckId,
      actorId: "actor-2",
      displayName: "Grace Hopper",
      selectedSlideId: slideId,
      selectedShapeId: "shape-3",
      mode: "presenting",
      updatedAt: "2026-05-20T12:02:00.000Z",
      status: "active",
    });
    socket?.receive({
      type: "awareness",
      protocol: "slides-sync",
      deckId,
      actorId: "actor-2",
      displayName: "Grace Hopper",
      selectedSlideId: slideId,
      mode: "presenting",
      updatedAt: "2026-05-20T12:03:00.000Z",
      status: "left",
    });

    expect(awareness).toEqual([
      {
        type: "awareness",
        protocol: "slides-sync",
        deckId,
        actorId: "actor-2",
        displayName: "Grace Hopper",
        selectedSlideId: slideId,
        selectedShapeId: "shape-2",
        mode: "editing",
        updatedAt: "2026-05-20T12:01:00.000Z",
        status: "active",
      },
      {
        type: "awareness",
        protocol: "slides-sync",
        deckId,
        actorId: "actor-2",
        displayName: "Grace Hopper",
        selectedSlideId: slideId,
        selectedShapeId: "shape-3",
        mode: "presenting",
        updatedAt: "2026-05-20T12:02:00.000Z",
        status: "active",
      },
      {
        type: "awareness",
        protocol: "slides-sync",
        deckId,
        actorId: "actor-2",
        displayName: "Grace Hopper",
        selectedSlideId: slideId,
        selectedShapeId: null,
        mode: "presenting",
        updatedAt: "2026-05-20T12:03:00.000Z",
        status: "left",
      },
    ]);
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

function deck() {
  return {
    id: deckId,
    title: "Board narrative",
    ownerActorId: "actor-1",
    createdByActorId: "actor-1",
    slideCount: 1,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function slide(title: string) {
  return {
    id: slideId,
    deckId,
    position: 0,
    layout: "title",
    content: { layout: "title", title },
    speakerNotes: "",
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}
