// @vitest-environment jsdom

/* ChatShell tests — exercise the backend-wired surface end to end.

   The chat tools (`/api/tools/chat.*`) are driven through a mocked
   `authenticatedFetch`; realtime is driven through an injected fake
   WebSocket so we can assert live messages, typing, presence, read
   markers and the REST fallback without a server. */

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { sessionQueryKeys } from "@/lib/auth";
import { shortcutRegistry } from "@/lib/shortcuts/registry";
import { shellOverlaysForTest } from "@/test/shell-overlays";
import { axeViolations } from "@/test/ui";

const ROOM_ID = "33333333-3333-4333-8333-333333333333";
const DM_ID = "55555555-5555-4555-8555-555555555555";
const SELF_ACTOR = "11111111-1111-4111-8111-111111111111";
const PEER_ACTOR = "22222222-2222-4222-8222-222222222222";
const MSG_ID = "44444444-4444-4444-8444-444444444444";
const REPLY_ID = "66666666-6666-4666-8666-666666666666";

const members = [
  { actorId: SELF_ACTOR, role: "owner", displayName: "Maya Chen", email: "maya@example.com" },
  { actorId: PEER_ACTOR, role: "member", displayName: "Daniel Cho", email: "daniel@example.com" },
];

const room = {
  id: ROOM_ID,
  kind: "chat_room" as const,
  subject: "Platform Engineering",
  createdByActorId: SELF_ACTOR,
  members,
  settings: {
    threadId: ROOM_ID,
    name: "Platform Engineering",
    topic: "Release coordination",
    privacy: "restricted" as const,
    readReceiptsEnabled: true,
  },
  createdAt: "2026-05-20T11:00:00.000Z",
  updatedAt: "2026-05-20T12:00:00.000Z",
};

const dmRoom = {
  ...room,
  id: DM_ID,
  kind: "chat_dm" as const,
  subject: "Old subject",
  settings: null,
};

const message = {
  id: MSG_ID,
  roomId: ROOM_ID,
  actorId: PEER_ACTOR,
  body: "Rolling the v2.4 release to canary now.",
  bodyFormat: "plain",
  attachmentObjectIds: [] as string[],
  metadata: {},
  replyCount: 2,
  lastReplyAt: "2026-05-20T12:30:00.000Z",
  sentAt: "2026-05-20T12:00:00.000Z",
  editedAt: null,
  deletedAt: null,
};

const unread = {
  rooms: [
    {
      roomId: ROOM_ID,
      unreadCount: 3,
      mentionCount: 1,
      lastMessageAt: "2026-05-20T12:00:00.000Z",
      lastReadAt: "2026-05-20T11:00:00.000Z",
    },
    {
      roomId: DM_ID,
      unreadCount: 2,
      mentionCount: 0,
      lastMessageAt: "2026-05-20T10:00:00.000Z",
      lastReadAt: null,
    },
  ],
  totalUnread: 5,
  totalMentions: 1,
};

type Overrides = Partial<Record<string, unknown>>;

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Mocked chat-tool fetch. Routes `/api/tools/<id>` to canned responses. */
function makeFetch(overrides: Overrides = {}) {
  const canned: Record<string, unknown> = {
    "chat.room.list": { rooms: [room, dmRoom] },
    "chat.unread.list": unread,
    "chat.message.list": { messages: [message] },
    "chat.thread.list": {
      messages: [
        { ...message, id: REPLY_ID, actorId: SELF_ACTOR, body: "On it.", parentMessageId: MSG_ID },
      ],
    },
    "chat.mentions.list": { mentions: [], nextBefore: null },
    "chat.search": { hits: [] },
    "chat.pins.list": { pins: [] },
    "chat.send": { ...message, id: "sent" },
    "chat.reply_in_thread": { ...message, id: "reply", parentMessageId: MSG_ID },
    "chat.react": { reaction: null },
    "chat.create_room": { ...dmRoom, id: "77777777-7777-4777-8777-777777777777" },
    ...overrides,
  };
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = urlOf(input);
    if (url === "/api/chat/ws-ticket") {
      return Promise.resolve(Response.json({ ticket: "t".repeat(43) }));
    }
    const tool = url.split("/api/tools/")[1] ?? "";
    const value = canned[tool];
    if (value instanceof Response) return Promise.resolve(value.clone());
    return Promise.resolve(Response.json(value ?? {}));
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

  frames(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((p) => JSON.parse(p) as { type: string });
  }

  #emit(type: string, event: { data?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const overlayApi = shellOverlaysForTest();

const navigateMock = vi.fn();
let searchParams: Record<string, string> = {};
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ navigate: navigateMock }),
  useSearch: () => searchParams,
}));

let fetchMock = makeFetch();
vi.mock("@/lib/auth", () => ({
  authenticatedFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
  sessionQueryKeys: { current: ["auth", "session"] },
  sessionUserQueryOptions: () => ({
    queryKey: ["auth", "session"],
    queryFn: () => Promise.resolve(null),
    staleTime: 30_000,
    throwOnError: false,
  }),
  getSessionUser: () => Promise.resolve(null),
}));

function calls(tool: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([input]) => urlOf(input).endsWith(`/${tool}`))
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
}

describe("ChatShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let previousWebSocket: typeof WebSocket;

  beforeEach(() => {
    navigateMock.mockClear();
    searchParams = {};
    FakeWebSocket.instances = [];
    fetchMock = makeFetch();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    queryClient.setQueryDefaults(sessionQueryKeys.current, { gcTime: Number.POSITIVE_INFINITY });
    queryClient.setQueryData(sessionQueryKeys.current, {
      id: "user-1",
      actorId: SELF_ACTOR,
      name: "Maya Chen",
      email: "maya@example.com",
    });
    previousWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
      FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.replaceChildren();
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
    vi.clearAllMocks();
  });

  async function renderShell() {
    const { ChatShell } = await import("./chat-shell");
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
    // The rooms query settles before anything else is worth asserting.
    for (let i = 0; i < 40 && container.querySelector('[data-slot="skeleton"]') !== null; i += 1) {
      await flush();
    }
    await flush();
  }

  /** Let chained queries, effects and timers settle. */
  async function flush() {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function button(label: string, scope: ParentNode = container): HTMLButtonElement {
    const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label ||
        candidate.textContent?.trim() === label ||
        candidate.querySelector(".label")?.textContent === label,
    );
    if (found === undefined) throw new Error(`No button "${label}"`);
    return found;
  }

  async function press(target: HTMLElement) {
    act(() => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function openRoom(name: string) {
    await press(button(name));
  }

  async function readySocket() {
    const socket = FakeWebSocket.instances.at(-1);
    if (socket === undefined) throw new Error("Expected a Chat socket.");
    await act(async () => {
      socket.open();
      socket.receive({ type: "ready", actorId: SELF_ACTOR });
      await Promise.resolve();
    });
    await flush();
    return socket;
  }

  function typeInto(input: HTMLTextAreaElement, value: string) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("opens on Home with Mentions, direct messages by name and spaces", async () => {
    await renderShell();
    const sidebar = container.querySelector<HTMLElement>("nav.chat-sidebar");
    const sections = Array.from(sidebar?.querySelectorAll("section") ?? []).map((section) =>
      section.getAttribute("aria-label"),
    );
    expect(sections).toEqual(["Direct messages", "Spaces"]);
    expect(button("Home").getAttribute("aria-current")).toBe("page");
    expect(sidebar?.textContent).toContain("Mentions");
    // The DM is titled by the other person, never by an id, subject or "#".
    const dmRow = button("Daniel Cho");
    expect(dmRow.textContent).not.toContain("#");
    expect(sidebar?.textContent).not.toContain("Old subject");
    // Unread rows are bold with a count; a mention shows "@".
    expect(dmRow.dataset.unread).toBe("true");
    expect(dmRow.querySelector(".chat-badge")?.textContent).toBe("22 unread");
    expect(button("Platform Engineering").querySelector(".chat-badge")?.textContent).toBe(
      "@1 mention",
    );
    // Home lists unread conversations first.
    const feed = Array.from(container.querySelectorAll(".chat-feed-name")).map(
      (n) => n.textContent,
    );
    expect(feed).toEqual(["Platform Engineering", "Daniel Cho"]);
    expect(container.querySelector(".chat-composer")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("opens a conversation at the newest message with dividers and a labelled composer", async () => {
    await renderShell();
    await openRoom("Platform Engineering");

    const log = container.querySelector('[role="log"]');
    expect(log?.getAttribute("aria-label")).toBe("Messages in Platform Engineering");
    expect(log?.textContent).toContain("Rolling the v2.4 release to canary now.");
    expect(container.querySelector(".chat-msg-author")?.textContent).toBe("Daniel Cho");
    expect(container.querySelector('[data-divider="unread"]')?.textContent).toBe("Unread");
    expect(container.querySelector(".chat-divider")?.textContent).not.toBe("");
    expect(container.querySelector(".chat-thread-link")?.textContent).toContain("2 replies");
    const composer = container.querySelector<HTMLTextAreaElement>(".chat-composer-input");
    expect(composer?.getAttribute("aria-label")).toBe("Message Platform Engineering");
    // Details stay closed until the header toggle opens them.
    expect(container.querySelector(".chat-details-panel")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("marks the conversation read on view and clears its badge", async () => {
    await renderShell();
    await openRoom("Platform Engineering");
    const socket = await readySocket();
    expect(socket.frames()).toContainEqual(
      expect.objectContaining({ type: "read", roomId: ROOM_ID, messageId: MSG_ID }),
    );
    expect(button("Platform Engineering").querySelector(".chat-badge")).toBeNull();
  });

  it("shows a server error with Retry instead of a fake room or composer", async () => {
    fetchMock = makeFetch({
      "chat.room.list": Response.json({ error: { message: "boom" } }, { status: 500 }),
    });
    await renderShell();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t load your conversations");
    expect(alert?.textContent).not.toContain("Offline");
    expect(button("Retry", alert ?? container)).toBeDefined();
    expect(container.querySelector(".chat-composer")).toBeNull();
    expect(container.querySelector(".chat-conversation")).toBeNull();
    expect(container.textContent).not.toContain("0 members");
  });

  it("shows an empty state that starts a chat when there are no conversations", async () => {
    fetchMock = makeFetch({
      "chat.room.list": { rooms: [] },
      "chat.unread.list": { rooms: [], totalUnread: 0, totalMentions: 0 },
    });
    await renderShell();
    expect(container.textContent).toContain("No conversations yet — start a chat");
    await press(button("Start a chat"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Start a chat");
    expect(document.querySelector('[role="combobox"]')?.getAttribute("aria-label")).toBeNull();
    expect(document.body.textContent).not.toMatch(/actor|uuid/iu);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("opens the DM from a /chat?dm= handoff", async () => {
    searchParams = { dm: PEER_ACTOR };
    await renderShell();
    expect(calls("chat.create_room")).toContainEqual(
      expect.objectContaining({ kind: "chat_dm", memberActorIds: [PEER_ACTOR] }),
    );
  });

  it("opens a thread with its replies, replies in it, and closes on Escape", async () => {
    await renderShell();
    await openRoom("Platform Engineering");
    const threadLink = container.querySelector<HTMLButtonElement>(".chat-thread-link");
    expect(threadLink?.textContent).toMatch(/^2 replies· /u);
    await press(threadLink as HTMLButtonElement);

    const panel = container.querySelector<HTMLElement>(".chat-thread-panel");
    expect(panel?.textContent).toContain("Rolling the v2.4 release to canary now.");
    expect(panel?.textContent).toContain("On it.");
    expect(calls("chat.thread.list")).toContainEqual({
      roomId: ROOM_ID,
      parentMessageId: MSG_ID,
      limit: 100,
    });

    const reply = panel?.querySelector<HTMLTextAreaElement>(".chat-composer-input");
    if (!reply) throw new Error("Expected the thread composer.");
    typeInto(reply, "Shipping now");
    act(() => {
      reply.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(calls("chat.reply_in_thread")).toContainEqual(
      expect.objectContaining({ roomId: ROOM_ID, parentMessageId: MSG_ID, body: "Shipping now" }),
    );

    act(() => {
      shortcutRegistry.handleKeyDown(new KeyboardEvent("keydown", { key: "Escape" }), {
        enabled: true,
        overlayOpen: false,
        isMac: false,
      });
    });
    await flush();
    expect(container.querySelector(".chat-thread-panel")).toBeNull();
  });

  it("aggregates shared reactions and removes the current actor's reaction", async () => {
    const createdAt = "2026-05-20T12:01:00.000Z";
    fetchMock = makeFetch({
      "chat.message.list": {
        messages: [
          {
            ...message,
            reactions: [
              { messageId: MSG_ID, actorId: SELF_ACTOR, emoji: "✅", createdAt },
              { messageId: MSG_ID, actorId: PEER_ACTOR, emoji: "✅", createdAt },
            ],
          },
        ],
      },
    });
    await renderShell();
    await openRoom("Platform Engineering");
    await readySocket();

    const reaction = button("✅ 2 reactions");
    expect(reaction.getAttribute("aria-pressed")).toBe("true");
    await press(reaction);
    expect(calls("chat.react")).toContainEqual({ messageId: MSG_ID, emoji: "✅", op: "remove" });
  });

  it("groups consecutive messages from one sender", async () => {
    fetchMock = makeFetch({
      "chat.message.list": {
        messages: [
          { ...message, id: "m3", body: "third", sentAt: "2026-05-20T12:20:00.000Z" },
          { ...message, id: "m2", body: "second", sentAt: "2026-05-20T12:01:00.000Z" },
          message,
        ],
      },
    });
    await renderShell();
    await openRoom("Platform Engineering");
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".chat-msg"));
    expect(rows.map((row) => row.dataset.grouped)).toEqual(["false", "true", "false"]);
  });

  it("subscribes over the WebSocket, shows live messages and sends over it", async () => {
    await renderShell();
    await openRoom("Platform Engineering");
    const socket = await readySocket();
    expect(socket.frames()).toContainEqual(
      expect.objectContaining({ type: "subscribe", roomId: ROOM_ID }),
    );

    await act(async () => {
      socket.receive({
        type: "message.created",
        roomId: ROOM_ID,
        actorId: PEER_ACTOR,
        message: { ...message, id: "live-1", body: "Canary is healthy.", replyCount: 0 },
      });
      await Promise.resolve();
    });
    expect(container.querySelector('[role="log"]')?.textContent).toContain("Canary is healthy.");

    const input = container.querySelector<HTMLTextAreaElement>(".chat-composer-input");
    if (!input) throw new Error("Expected the composer.");
    typeInto(input, "Looks good");
    await press(button("Send message"));
    expect(socket.frames()).toContainEqual(
      expect.objectContaining({ type: "send", roomId: ROOM_ID, body: "Looks good" }),
    );
  });

  it("falls back to chat.send REST when realtime is not open", async () => {
    await renderShell();
    await openRoom("Platform Engineering");
    const input = container.querySelector<HTMLTextAreaElement>(".chat-composer-input");
    if (!input) throw new Error("Expected the composer.");
    typeInto(input, "Ship via REST fallback");
    await press(button("Send message"));
    expect(calls("chat.send")).toContainEqual(
      expect.objectContaining({ roomId: ROOM_ID, body: "Ship via REST fallback" }),
    );
    // No stray "not sent" copy next to the message REST delivers.
    expect(container.textContent).not.toContain("Not sent");
  });

  it("shows typing and presence from the socket", async () => {
    await renderShell();
    await openRoom("Daniel Cho");
    const socket = await readySocket();
    await act(async () => {
      socket.receive({
        type: "subscribed",
        roomId: DM_ID,
        cursor: 0,
        presence: [
          { actorId: PEER_ACTOR, orgId: "org", status: "available", seenAt: message.sentAt },
        ],
        receipts: [],
      });
      socket.receive({ type: "typing", roomId: DM_ID, actorId: PEER_ACTOR, isTyping: true });
      await Promise.resolve();
    });
    expect(container.querySelector(".chat-typing")?.textContent).toContain("Daniel Cho is typing");
    expect(container.querySelector('.chat-presence-dot[data-presence="active"]')).not.toBeNull();
    expect(container.querySelector(".chat-conversation-meta")?.textContent).toBe("Active");
  });

  it("disables posting in announcement spaces for ordinary members", async () => {
    fetchMock = makeFetch({
      "chat.room.list": {
        rooms: [
          {
            ...room,
            members: [{ ...members[0], role: "member" }, members[1]],
            settings: { ...room.settings, spaceType: "announcement" },
          },
        ],
      },
    });
    await renderShell();
    await openRoom("Platform Engineering");
    const composer = container.querySelector<HTMLTextAreaElement>(".chat-composer-input");
    expect(composer?.disabled).toBe(true);
    expect(composer?.placeholder).toBe("Only space managers can post here");
  });

  it("renders only server-sanitized Markdown HTML and keeps plain text inert", async () => {
    fetchMock = makeFetch({
      "chat.message.list": {
        messages: [
          {
            ...message,
            body: "**Safe** ~~old~~ [link](https://example.com)",
            bodyFormat: "markdown",
            renderedBodyHtml:
              '<p><strong>Safe</strong> <s>old</s> <a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">link ↗</a></p>',
          },
          {
            ...message,
            id: "plain-inert",
            body: "<img src=x onerror=alert(1)>",
            bodyFormat: "plain",
            renderedBodyHtml: '<img src=x onerror="alert(1)">',
            sentAt: "2026-05-20T11:00:00.000Z",
          },
        ],
      },
    });
    await renderShell();
    await openRoom("Platform Engineering");
    expect(container.querySelector(".chat-msg-line strong")?.textContent).toBe("Safe");
    expect(container.querySelector(".chat-msg-line s")?.textContent).toBe("old");
    expect(container.querySelector(".chat-msg-line a")?.getAttribute("rel")).toBe(
      "noopener noreferrer nofollow",
    );
    expect(container.querySelector(".chat-msg-line img")).toBeNull();
    expect(container.querySelector('[role="log"]')?.textContent).toContain("<img src=x");
  });

  it("opens the details panel from the header with members", async () => {
    await renderShell();
    await openRoom("Platform Engineering");
    const toggle = button("Conversation details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await press(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = container.querySelector<HTMLElement>(".chat-details-panel");
    expect(panel?.textContent).toContain("Release coordination");
    await press(button("Members (2)", panel ?? container));
    expect(panel?.textContent).toContain("Daniel Cho");
    expect(panel?.querySelector("input")).toBeNull();
  });

  it("searches chat from the top search box and opens a result", async () => {
    fetchMock = makeFetch({
      "chat.search": {
        hits: [
          {
            roomId: ROOM_ID,
            messageId: MSG_ID,
            actorId: PEER_ACTOR,
            subject: "Platform Engineering",
            preview: "Rolling the v2.4 release",
            sentAt: message.sentAt,
          },
        ],
      },
    });
    await renderShell();
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search in Chat"]');
    if (!search) throw new Error("Expected the search box.");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "canary");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      search.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(calls("chat.search")).toContainEqual({ query: "canary", limit: 50 });
    const hit = container.querySelector<HTMLButtonElement>(".chat-search-hit");
    expect(hit?.textContent).toContain("Daniel Cho");
    await press(hit as HTMLButtonElement);
    expect(container.querySelector(".chat-conversation")).not.toBeNull();
    expect(
      container.querySelector(`[data-message-id="${MSG_ID}"]`)?.getAttribute("data-highlighted"),
    ).toBe("true");
  });
});
