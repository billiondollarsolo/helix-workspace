// @vitest-environment jsdom

/* ChatShell tests — exercise the backend-wired surface end to end.

   The chat tools (`/api/tools/chat.*`) are driven through a mocked
   `authenticatedFetch`; realtime is driven through an injected fake
   WebSocket so we can assert live messages, typing, presence and the
   offline fallback without a server. */

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";

const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const DM_ID = "55555555-5555-4555-8555-555555555555";
const SELF_ACTOR = "11111111-1111-4111-8111-111111111111";
const PEER_ACTOR = "22222222-2222-4222-8222-222222222222";
const MSG_ID = "44444444-4444-4444-8444-444444444444";

const room = {
  id: ROOM_ID,
  kind: "chat_room" as const,
  subject: "Platform Engineering",
  createdByActorId: SELF_ACTOR,
  members: [
    { actorId: SELF_ACTOR, role: "owner", displayName: "Maya Chen", email: "maya@example.com" },
    { actorId: PEER_ACTOR, role: "member", displayName: "Daniel Cho", email: "daniel@example.com" },
  ],
  settings: { threadId: ROOM_ID, name: "Platform Engineering", topic: "Release coordination", isPrivate: false },
  createdAt: "2026-05-20T11:00:00.000Z",
  updatedAt: "2026-05-20T12:00:00.000Z",
};

const dmRoom = {
  id: DM_ID,
  kind: "chat_dm" as const,
  subject: null,
  createdByActorId: SELF_ACTOR,
  members: [
    { actorId: SELF_ACTOR, role: "owner", displayName: "Maya Chen", email: "maya@example.com" },
    { actorId: PEER_ACTOR, role: "member", displayName: "Daniel Cho", email: "daniel@example.com" },
  ],
  settings: null,
  createdAt: "2026-05-20T11:00:00.000Z",
  updatedAt: "2026-05-20T12:00:00.000Z",
};

const message = {
  id: MSG_ID,
  roomId: ROOM_ID,
  actorId: PEER_ACTOR,
  body: "Rolling the v2.4 release to canary now.",
  bodyFormat: "plain",
  attachmentObjectIds: [] as string[],
  metadata: {},
  sentAt: "2026-05-20T12:00:00.000Z",
  editedAt: null,
  deletedAt: null,
};

/** Mocked chat-tool fetch. Routes `/api/tools/<id>` to canned responses. */
function makeFetch(overrides: Partial<Record<string, unknown>> = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith("/chat.room.list")) {
      return Promise.resolve(
        Response.json(overrides["chat.room.list"] ?? { rooms: [room, dmRoom] }),
      );
    }
    if (url.endsWith("/chat.message.list")) {
      return Promise.resolve(
        Response.json(overrides["chat.message.list"] ?? { messages: [message] }),
      );
    }
    if (url.endsWith("/chat.send")) {
      return Promise.resolve(Response.json({ ...message, id: "sent" }));
    }
    if (url.endsWith("/chat.react")) {
      return Promise.resolve(Response.json({ reaction: null }));
    }
    if (url.endsWith("/chat.edit") || url.endsWith("/chat.delete")) {
      return Promise.resolve(Response.json(message));
    }
    return Promise.resolve(Response.json({}));
  });
}

/** Fake WebSocket that records sends and lets tests push frames. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.#emit("close", {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.#emit("open", {});
  }

  receive(payload: unknown): void {
    this.#emit("message", { data: JSON.stringify(payload) });
  }

  #emit(type: string, event: { data?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const overlayApi = {
  openNotifications: vi.fn(),
  openPalette: vi.fn(),
  openSettings: vi.fn(),
};

// `authenticatedFetch` is mocked per-test via `fetchMock`.
let fetchMock = makeFetch();
vi.mock("@/lib/auth", () => ({
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetchMock(input, init),
  addAccessTokenSearchParam: (url: string) => url,
}));

describe("ChatShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    fetchMock = makeFetch();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  /** Lazily import ChatShell so the auth mock is in place first. */
  async function renderShell(WebSocketImpl: typeof WebSocket) {
    const { ChatShell } = await import("./chat-shell");
    // Wire the fake socket as the global the realtime client picks up.
    const previous = globalThis.WebSocket;
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = WebSocketImpl;
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ShellOverlayContext.Provider value={overlayApi}>
            <ChatShell />
          </ShellOverlayContext.Provider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = previous;
  }

  /** Settle pending microtasks (query resolution, effects).
     Loops several macrotask ticks so chained work settles: the rooms query
     resolves, an effect picks the active room, and only then does the
     dependent message-list query become enabled and fetch. */
  async function flush() {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function readyConnection(socket: FakeWebSocket) {
    await act(async () => {
      socket.open();
      socket.receive({ type: "ready", actorId: SELF_ACTOR });
      await Promise.resolve();
    });
  }

  it("loads rooms from the backend and renders the sidebar", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    await flush();

    const sidebar = container.querySelector(".chat-sidebar");
    expect(sidebar?.textContent).toContain("Platform Engineering");
    expect(sidebar?.textContent).toContain("Direct messages");
    // The DM room renders as its peer's display name.
    expect(sidebar?.textContent).toContain("Daniel Cho");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tools/chat.room.list",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders backend messages in the channel pane", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    await flush();

    expect(container.querySelector(".chat-messages")?.textContent).toContain(
      "Rolling the v2.4 release to canary now.",
    );
    // Author is resolved from the room member list.
    expect(container.querySelector(".chat-msg-author")?.textContent).toBe("Daniel Cho");
  });

  it("subscribes over the WebSocket and shows a live new message", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    await flush();
    await readyConnection(socket!);
    await flush();

    // The active room is subscribed once the socket opens.
    expect(socket!.sent.map((p) => JSON.parse(p) as { type: string })).toContainEqual(
      expect.objectContaining({ type: "subscribe", roomId: ROOM_ID }),
    );

    await act(async () => {
      socket!.receive({
        type: "message.created",
        roomId: ROOM_ID,
        actorId: PEER_ACTOR,
        message: { ...message, id: "live-1", body: "Canary is healthy." },
      });
      await Promise.resolve();
    });

    expect(container.querySelector(".chat-messages")?.textContent).toContain(
      "Canary is healthy.",
    );
  });

  it("shows a typing indicator from a realtime typing event", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    const socket = FakeWebSocket.instances[0]!;
    await flush();
    await readyConnection(socket);
    await flush();

    expect(container.querySelector(".chat-typing")).toBeNull();

    await act(async () => {
      socket.receive({ type: "typing", roomId: ROOM_ID, actorId: PEER_ACTOR, isTyping: true });
      await Promise.resolve();
    });

    expect(container.querySelector(".chat-typing")?.textContent).toContain("Daniel Cho");
    expect(container.querySelectorAll(".chat-typing-dot").length).toBe(3);
  });

  it("reflects presence dots from the subscribed roster", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    const socket = FakeWebSocket.instances[0]!;
    await flush();
    await readyConnection(socket);

    await act(async () => {
      socket.receive({
        type: "subscribed",
        roomId: ROOM_ID,
        presence: [
          {
            actorId: PEER_ACTOR,
            orgId: "org",
            status: "online",
            seenAt: "2026-05-20T12:00:00.000Z",
          },
        ],
        receipts: [],
      });
      await Promise.resolve();
    });

    const activeDot = container.querySelector('.chat-presence-dot[data-presence="active"]');
    expect(activeDot).not.toBeNull();
  });

  it("sends a message over the WebSocket when connected", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    const socket = FakeWebSocket.instances[0]!;
    await flush();
    await readyConnection(socket);
    await flush();

    const textarea = container.querySelector(".chat-composer-input") as HTMLTextAreaElement;
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    ) as { set?: (this: HTMLTextAreaElement, v: string) => void };
    act(() => {
      descriptor.set?.call(textarea, "Looks good");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendButton = Array.from(container.querySelectorAll(".chat-composer button")).find(
      (b) => b.textContent?.includes("Send"),
    ) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    act(() => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(socket.sent.map((p) => JSON.parse(p) as { type: string })).toContainEqual(
      expect.objectContaining({ type: "send", roomId: ROOM_ID, body: "Looks good" }),
    );
  });

  it("opens the thread panel from a message reply action", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    await flush();

    expect(container.querySelector(".chat-thread-panel")).toBeNull();
    const replyButton = container.querySelector(
      '[aria-label="Reply in thread"]',
    ) as HTMLElement;
    act(() => {
      replyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const panel = container.querySelector(".chat-thread-panel");
    expect(panel?.textContent).toContain("Thread");
    expect(panel?.textContent).toContain("Rolling the v2.4 release to canary now.");
    expect(container.querySelector(".chat-info-panel")).toBeNull();
  });

  it("renders the info panel with backend members", async () => {
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    await flush();

    expect(container.querySelector(".chat-info-panel")).not.toBeNull();
    expect(container.textContent).toContain("Release coordination");

    const membersTab = Array.from(container.querySelectorAll(".chat-info-tab")).find((t) =>
      t.textContent?.includes("Members"),
    ) as HTMLButtonElement;
    act(() => {
      membersTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".chat-info-body")?.textContent).toContain("Daniel Cho");
  });

  it("falls back to seed spaces when the room list request fails", async () => {
    fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ error: "offline" }, { status: 503 })),
    );
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    await flush();

    const sidebar = container.querySelector(".chat-sidebar");
    expect(sidebar?.textContent).toContain("Offline");
    // Seed spaces from chat-data.ts back the offline sidebar.
    expect(sidebar?.textContent).toContain("Platform Engineering");
  });

  it("shows an empty state when a room has no messages", async () => {
    fetchMock = makeFetch({ "chat.message.list": { messages: [] } });
    await renderShell(FakeWebSocket as unknown as typeof WebSocket);
    await flush();

    expect(container.querySelector(".chat-messages")?.textContent).toContain(
      "No messages yet",
    );
  });
});
