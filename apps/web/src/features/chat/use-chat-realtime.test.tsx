// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatRealtime } from "./use-chat-realtime";

const ROOM = "33333333-3333-4333-8333-333333333333";
const OTHER_ROOM = "44444444-4444-4444-8444-444444444444";
const ticketFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  void input;
  void init;
  return Promise.resolve(Response.json({ ticket: "t".repeat(43) }));
});

function messageEvent(cursor: number, id: string): Record<string, unknown> {
  return {
    type: "message.created",
    roomId: ROOM,
    cursor,
    actorId: "self",
    message: {
      id,
      orgId: "org",
      roomId: ROOM,
      actorId: "self",
      body: id,
      bodyFormat: "plain",
      metadata: {},
      attachmentObjectIds: [],
      sentAt: "2026-07-18T00:00:00.000Z",
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  };
}

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
    fetchImpl: ticketFetch,
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
    ticketFetch.mockClear();
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
    expect(ticketFetch).toHaveBeenCalledTimes(2);
    const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => {
      await Promise.resolve();
    });
    expect(second?.sent.some((s) => s.includes(ROOM))).toBe(true);
  });

  it("resumes from the last cursor and applies duplicate delivery once", async () => {
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
    if (first === undefined) throw new Error("missing socket");

    act(() => {
      first.receive(messageEvent(1, "one"));
      first.receive(messageEvent(1, "duplicate"));
    });
    expect(latest?.liveMessages.map((message) => message.id)).toEqual(["one"]);

    act(() => {
      first.close(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const second = FakeWebSocket.instances.at(-1);
    expect(second?.sent).toContain(JSON.stringify({ type: "subscribe", roomId: ROOM, cursor: 1 }));
  });

  it("applies shared message updates and tombstones in cursor order", async () => {
    act(() => {
      root.render(
        <Harness
          roomId={ROOM}
          onState={(state) => {
            latest = state;
          }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("missing socket");

    const created = messageEvent(1, "one");
    const updated = messageEvent(2, "one");
    act(() => {
      socket.receive(created);
      socket.receive({
        ...updated,
        type: "message.updated",
        message: {
          ...(updated.message as Record<string, unknown>),
          body: "updated",
          reactions: [
            {
              messageId: "one",
              actorId: "peer",
              orgId: "org",
              emoji: "✅",
              createdAt: "2026-07-18T00:01:00.000Z",
            },
          ],
        },
      });
    });
    expect(latest?.liveMessages).toHaveLength(1);
    expect(latest?.liveMessages[0]).toMatchObject({
      body: "updated",
      reactions: [{ emoji: "✅" }],
    });

    act(() => {
      socket.receive({
        type: "message.deleted",
        roomId: ROOM,
        cursor: 3,
        messageId: "one",
        revision: 3,
        deletedAt: "2026-07-18T00:02:00.000Z",
      });
    });
    expect(latest?.liveMessages).toEqual([]);
    expect(latest?.deletedMessageIds.has("one")).toBe(true);
  });

  it("drops a gapped stream and reconnects from zero for a full replay", async () => {
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
    if (first === undefined) throw new Error("missing socket");

    act(() => {
      first.receive(messageEvent(2, "gap"));
    });
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(latest?.liveMessages).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(FakeWebSocket.instances.at(-1)?.sent).toContain(
      JSON.stringify({ type: "subscribe", roomId: ROOM, cursor: 0 }),
    );
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

  it("closes the old room socket and mints a new room-bound ticket", async () => {
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
      root.render(
        <Harness
          roomId={OTHER_ROOM}
          onState={(s) => {
            latest = s;
          }}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(first?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(ticketFetch.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify({ roomId: ROOM }),
      JSON.stringify({ roomId: OTHER_ROOM }),
    ]);
    expect(FakeWebSocket.instances[1]?.sent).toContain(
      JSON.stringify({ type: "subscribe", roomId: OTHER_ROOM, cursor: 0 }),
    );
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
      latest?.sendMessage({
        body: "hello opt",
        bodyFormat: "plain",
        attachmentObjectIds: [],
      });
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
        cursor: 1,
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
