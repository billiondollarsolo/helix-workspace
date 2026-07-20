// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatRealtime } from "./use-chat-realtime";

const ROOM = "33333333-3333-4333-8333-333333333333";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set<(event: unknown) => void>();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  receive(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function Harness({
  roomId,
  onState,
}: {
  readonly roomId: string | undefined;
  readonly onState: (s: ReturnType<typeof useChatRealtime>) => void;
}) {
  const state = useChatRealtime({
    roomId,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    url: "ws://localhost/ws/chat",
    reconnectBaseMs: 100,
    reconnectCapMs: 400,
    pendingTimeoutMs: 50,
  });
  onState(state);
  return null;
}

describe("useChatRealtime reconnect", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useChatRealtime> | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("reconnects after unexpected close and re-subscribes", async () => {
    act(() => {
      root.render(
        <Harness
          roomId={ROOM}
          onState={(s) => {
            latest = s;
          }}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const first = FakeWebSocket.instances[0];
    if (first === undefined) throw new Error("missing socket");
    // subscribe on open
    expect(first.sent.some((s) => s.includes("subscribe"))).toBe(true);

    act(() => {
      first.close(1006);
    });
    expect(latest?.connection).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => {
      await Promise.resolve();
    });
    expect(second?.sent.some((s) => s.includes(ROOM))).toBe(true);
  });

  it("does not reconnect after unmount", async () => {
    act(() => {
      root.render(
        <Harness
          roomId={ROOM}
          onState={(s) => {
            latest = s;
          }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const first = FakeWebSocket.instances[0];
    act(() => {
      root.unmount();
    });
    act(() => {
      first?.close(1006);
    });
    const count = FakeWebSocket.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(FakeWebSocket.instances.length).toBe(count);
  });

  it("optimistic send becomes pending then reconciles on echo", async () => {
    act(() => {
      root.render(
        <Harness
          roomId={ROOM}
          onState={(s) => {
            latest = s;
          }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("no socket");

    act(() => {
      latest?.sendMessage("hello opt");
    });
    expect(latest?.pendingMessages).toHaveLength(1);
    expect(latest?.pendingMessages[0]?.status).toBe("pending");

    const sent = socket.sent
      .map((s) => JSON.parse(s) as { type?: string; clientMessageId?: string })
      .find((f) => f.type === "send");
    const clientMessageId = sent?.clientMessageId;
    expect(clientMessageId).toBeDefined();

    act(() => {
      socket.receive({
        type: "message.created",
        roomId: ROOM,
        actorId: "self",
        message: {
          id: "44444444-4444-4444-8444-444444444444",
          orgId: "o",
          roomId: ROOM,
          actorId: "self",
          body: "hello opt",
          bodyFormat: "plain",
          metadata: {},
          attachmentObjectIds: [],
          clientMessageId,
          sentAt: "2026-07-18T00:00:00.000Z",
          editedAt: null,
          deletedAt: null,
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      });
    });
    expect(latest?.pendingMessages).toHaveLength(0);
    expect(latest?.liveMessages).toHaveLength(1);
  });
});
