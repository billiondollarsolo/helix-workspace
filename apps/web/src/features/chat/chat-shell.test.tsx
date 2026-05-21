// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadChatRouteData, validateChatRouteSearch } from "@/routes/_shell/chat";
import { ChatShell } from "./chat-shell";
import { chatQueryKeys } from "./queries";

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({ emptyFallback }: { readonly emptyFallback?: React.ReactNode }) =>
    emptyFallback ?? null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roomId = "33333333-3333-4333-8333-333333333333";
const dmRoomId = "77777777-7777-4777-8777-777777777777";
const messageId = "44444444-4444-4444-8444-444444444444";
const dmMessageId = "88888888-8888-4888-8888-888888888888";

describe("ChatShell backend tool integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });
    scrollIntoViewMock = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (input === "/api/tools/chat.room.list") {
        return Promise.resolve(
          Response.json({
            rooms: [
              {
                id: roomId,
                kind: "chat_room",
                subject: "Backend launch room",
                createdByActorId: "maya",
                members: [
                  {
                    actorId: "maya",
                    role: "owner",
                    displayName: "Maya Chen",
                    email: "maya@example.com",
                  },
                  {
                    actorId: "sam",
                    role: "member",
                    displayName: "Sam Patel",
                    email: "sam@example.com",
                  },
                ],
                settings: {
                  threadId: roomId,
                  name: "Backend launch room",
                  topic: "Backend-backed room hydration",
                  isPrivate: false,
                },
                createdAt: "2026-05-20T11:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
              {
                id: dmRoomId,
                kind: "chat_dm",
                subject: "Sam Patel",
                createdByActorId: "maya",
                members: [
                  {
                    actorId: "maya",
                    role: "owner",
                    displayName: "Maya Chen",
                    email: "maya@example.com",
                  },
                  {
                    actorId: "sam",
                    role: "member",
                    displayName: "Sam Patel",
                    email: "sam@example.com",
                  },
                ],
                settings: {
                  threadId: dmRoomId,
                  name: "Sam Patel",
                  topic: "Direct messages",
                  isPrivate: true,
                },
                createdAt: "2026-05-20T11:30:00.000Z",
                updatedAt: "2026-05-20T12:30:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/chat.message.list") {
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as { roomId?: string }) : {};
        const requestedRoomId = body.roomId ?? roomId;
        return Promise.resolve(
          Response.json({
            messages: [
              {
                id: messageId,
                roomId: requestedRoomId,
                actorId: "maya",
                body:
                  requestedRoomId === dmRoomId
                    ? "Deep linked DM history"
                    : "Backend message history",
                bodyFormat: "plain",
                attachmentObjectIds: [],
                sentAt: "2026-05-20T12:00:00.000Z",
                editedAt: null,
                deletedAt: null,
              },
              ...(requestedRoomId === dmRoomId
                ? [
                    {
                      id: dmMessageId,
                      roomId: requestedRoomId,
                      actorId: "sam",
                      body: "Focused deep linked DM message",
                      bodyFormat: "plain",
                      attachmentObjectIds: [],
                      sentAt: "2026-05-20T12:10:00.000Z",
                      editedAt: null,
                      deletedAt: null,
                    },
                  ]
                : []),
            ],
          }),
        );
      }
      if (input === "/api/tools/chat.send") {
        return Promise.resolve(
          Response.json({
            id: "55555555-5555-4555-8555-555555555555",
            roomId,
            actorId: "maya",
            body: "Backend send from web",
            bodyFormat: "plain",
            attachmentObjectIds: [],
            sentAt: "2026-05-20T12:05:00.000Z",
            editedAt: null,
            deletedAt: null,
          }),
        );
      }
      if (input === "/api/tools/chat.edit") {
        return Promise.resolve(
          Response.json({
            id: messageId,
            roomId,
            actorId: "maya",
            body: "Edited backend text",
            bodyFormat: "plain",
            attachmentObjectIds: [],
            sentAt: "2026-05-20T12:00:00.000Z",
            editedAt: "2026-05-20T12:06:00.000Z",
            deletedAt: null,
          }),
        );
      }
      if (input === "/api/tools/chat.react") {
        return Promise.resolve(Response.json({ reaction: null }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads backend chat search hits and sends through chat.send", async () => {
    renderChat();
    await waitForText("Backend launch room");
    await waitForText("Backend message history");
    expect(container.textContent).toContain("Backend-backed room hydration");
    expect(container.textContent).not.toContain("Simulate loading");

    await typeComposer("Backend send from web");
    await clickButton("Send");

    const sendCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/chat.send");
    expect(sendCall?.[1]?.method).toBe("POST");
    const sendBody = sendCall?.[1]?.body;
    if (typeof sendBody !== "string") {
      throw new Error("Expected chat.send JSON body.");
    }
    expect(JSON.parse(sendBody)).toEqual({
      roomId,
      body: "Backend send from web",
      bodyFormat: "plain",
      attachmentObjectIds: [],
      metadata: {},
    });
  });

  it("blocks empty and whitespace chat submits with accessible validation errors", async () => {
    renderChat();
    await waitForText("Backend message history");

    await submitComposerForm();

    expect(container.textContent).toContain("Message is required.");
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/chat.send")).toBe(false);

    await typeComposer("   ");
    await submitComposerForm();

    expect(container.textContent).toContain("Message is required.");
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/chat.send")).toBe(false);
  });

  it("renders backend messages through a virtualized stream in jsdom", async () => {
    const bulkMessages = Array.from({ length: 40 }, (_, index) => ({
      id: `bulk-message-${String(index).padStart(2, "0")}`,
      roomId,
      actorId: index % 2 === 0 ? "maya" : "sam",
      body: `Bulk backend message ${String(index).padStart(2, "0")}`,
      bodyFormat: "plain",
      attachmentObjectIds: [],
      sentAt: `2026-05-20T12:${String(index).padStart(2, "0")}:00.000Z`,
      editedAt: null,
      deletedAt: null,
    }));
    fetchMock.mockImplementation((input, init) => {
      if (input === "/api/tools/chat.room.list") {
        return Promise.resolve(
          Response.json({
            rooms: [
              {
                id: roomId,
                kind: "chat_room",
                subject: "Backend launch room",
                createdByActorId: "maya",
                members: [
                  {
                    actorId: "maya",
                    role: "owner",
                    displayName: "Maya Chen",
                    email: "maya@example.com",
                  },
                  {
                    actorId: "sam",
                    role: "member",
                    displayName: "Sam Patel",
                    email: "sam@example.com",
                  },
                ],
                settings: {
                  threadId: roomId,
                  name: "Backend launch room",
                  topic: "Backend-backed room hydration",
                  isPrivate: false,
                },
                createdAt: "2026-05-20T11:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/chat.message.list") {
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as { roomId?: string }) : {};
        return Promise.resolve(
          Response.json({
            messages: bulkMessages.map((message) => ({
              ...message,
              roomId: body.roomId ?? roomId,
            })),
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });

    renderChat();
    await waitForText("Backend launch room");
    await waitForText("Bulk backend message 39");

    const stream = container.querySelector(".chat-message-stream");
    const spacer = container.querySelector('[data-testid="chat-message-virtual-spacer"]');
    const renderedMessages = container.querySelectorAll("[data-message-id]");

    expect(stream?.getAttribute("data-virtualized")).toBe("true");
    expect(spacer).toBeInstanceOf(HTMLDivElement);
    expect((spacer as HTMLDivElement).style.height).toBe("5280px");
    expect(renderedMessages.length).toBeGreaterThan(0);
    expect(renderedMessages.length).toBeLessThan(bulkMessages.length);
  });

  it("hydrates the initial room id from route search state", async () => {
    renderChat({ initialRoomId: dmRoomId });

    await waitForText("Sam Patel");
    await waitForText("Deep linked DM history");

    const messageListCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/chat.message.list",
    );
    expect(messageListCall?.[1]?.body).toBe(
      JSON.stringify({ roomId: dmRoomId, before: undefined, limit: 50 }),
    );
  });

  it("focuses and scrolls the initial message id after room hydration", async () => {
    renderChat({ initialMessageId: dmMessageId, initialRoomId: dmRoomId });

    await waitForText("Focused deep linked DM message");

    const focusedMessage = container.querySelector(`[data-message-id="${dmMessageId}"]`);
    expect(focusedMessage).toBeInstanceOf(HTMLElement);
    expect(focusedMessage?.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(focusedMessage);
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("prefetches the room list and deep-linked room messages for route hydration", async () => {
    expect(validateChatRouteSearch({ message: dmMessageId, room: dmRoomId })).toEqual({
      message: dmMessageId,
      room: dmRoomId,
    });
    expect(validateChatRouteSearch({ message: "", room: ["bad"] })).toEqual({});

    await preloadChatRouteData(queryClient, { message: dmMessageId, room: dmRoomId });

    expect(queryClient.getQueryData(chatQueryKeys.rooms())).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: roomId })]),
    );
    expect(queryClient.getQueryData(chatQueryKeys.messages(dmRoomId))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: dmMessageId })]),
    );

    const roomListCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/chat.room.list",
    );
    const messageListCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/chat.message.list",
    );
    expect(roomListCall?.[1]?.body).toBe(JSON.stringify({ query: "", limit: 50 }));
    expect(messageListCall?.[1]?.body).toBe(
      JSON.stringify({ roomId: dmRoomId, before: undefined, limit: 50 }),
    );
  });

  it("calls backend reaction and edit mutations exposed by the UI", async () => {
    renderChat();
    await waitForText("Backend message history");

    await clickButtonByLabel("React with check");
    await clickButtonByLabel("Edit message");
    await typeEditBody("Edited backend text");
    await clickButton("Save");

    const reactCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/chat.react");
    const editCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/chat.edit");
    expect(reactCall?.[1]?.body).toBe(JSON.stringify({ messageId, emoji: "✅", op: "add" }));
    expect(editCall?.[1]?.body).toBe(JSON.stringify({ messageId, body: "Edited backend text" }));
  });

  it("blocks empty chat edit submits and keeps the editor open", async () => {
    renderChat();
    await waitForText("Backend message history");

    await clickButtonByLabel("Edit message");
    await typeEditBody("   ");
    await clickButton("Save");

    expect(container.textContent).toContain("Message is required.");
    expect(container.querySelector('textarea[aria-label="Edit message"]')).toBeInstanceOf(
      HTMLTextAreaElement,
    );
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/chat.edit")).toBe(false);
  });

  it("subscribes to chat websocket events for typing, presence, messages, and reads", async () => {
    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal("WebSocket", fakeWebSocketClass(sockets));

    renderChat();
    await waitForText("Backend launch room");
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = firstSocket(sockets);
    openSocket(socket);

    await waitFor(() =>
      expect(socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>)).toEqual([
        { type: "subscribe", roomId },
        { type: "presence", roomId },
      ]),
    );

    receiveSocket(socket, {
      type: "presence",
      roomId,
      presence: [
        {
          actorId: "sam",
          orgId: "org-1",
          displayName: "Sam Patel",
          status: "online",
          seenAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    });
    receiveSocket(socket, { type: "typing", roomId, actorId: "sam", isTyping: true });
    await waitForText("Sam typing");

    receiveSocket(socket, {
      type: "message.created",
      roomId,
      actorId: "sam",
      message: {
        id: "66666666-6666-4666-8666-666666666666",
        roomId,
        actorId: "sam",
        body: "Realtime backend message",
        bodyFormat: "plain",
        attachmentObjectIds: [],
        sentAt: "2026-05-20T12:07:00.000Z",
        editedAt: null,
        deletedAt: null,
        createdAt: "2026-05-20T12:07:00.000Z",
        updatedAt: "2026-05-20T12:07:00.000Z",
      },
    });
    await waitForText("Realtime backend message");

    receiveSocket(socket, {
      type: "read",
      roomId,
      actorId: "sam",
      receipt: {
        roomId,
        actorId: "sam",
        orgId: "org-1",
        lastReadMessageId: messageId,
        lastReadAt: "2026-05-20T12:08:00.000Z",
        updatedAt: "2026-05-20T12:08:00.000Z",
      },
    });
    await waitForText("Seen by everyone");

    vi.useFakeTimers();
    try {
      await typeComposer("Realtime send");
      await waitForSent(socket, { type: "typing", roomId, isTyping: true });
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      await flush();
      await waitForSent(socket, { type: "typing", roomId, isTyping: false });
    } finally {
      vi.useRealTimers();
    }
    await clickButton("Mark read");
    await waitForSent(socket, {
      type: "read",
      roomId,
      messageId: "66666666-6666-4666-8666-666666666666",
    });
  });

  it("shows an offline state instead of sample rooms when backend chat hydration is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    renderChat();
    await waitForText("Chat backend unavailable");
    await waitForText("Room list could not reach the backend");

    expect(container.textContent).not.toContain("launch-readiness");
    expect(container.textContent).not.toContain("customer-support");
    expect(container.textContent).not.toContain("release-room");
    expect(container.textContent).not.toContain(
      "Room membership and read receipts are ready for the release smoke test.",
    );
  });

  it("retries unavailable chat rooms by invalidating the active query", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderChat();
    await waitForText("Chat backend unavailable");

    await clickButton("Retry");
    await waitForText("Backend launch room");

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: chatQueryKeys.rooms() });
    expect(
      fetchMock.mock.calls.filter((call) => call[0] === "/api/tools/chat.room.list"),
    ).toHaveLength(2);
  });

  function renderChat(props: Parameters<typeof ChatShell>[0] = {}) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatShell {...props} />
        </QueryClientProvider>,
      );
    });
  }

  async function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.click();
    });
    await flush();
  }

  async function clickButtonByLabel(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${label}`);
    }
    act(() => {
      button.click();
    });
    await flush();
  }

  async function typeComposer(value: string) {
    const textarea = container.querySelector("#chat-composer-input");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Composer body not found.");
    }
    setTextareaValue(textarea, value);
    await flush();
  }

  async function submitComposerForm() {
    const form = container.querySelector("form.chat-composer");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Composer form not found.");
    }
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  async function typeEditBody(value: string) {
    const textarea = container.querySelector('textarea[aria-label="Edit message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Edit body not found.");
    }
    setTextareaValue(textarea, value);
    await flush();
  }

  function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set as ((this: HTMLTextAreaElement, value: string) => void) | undefined;
      if (valueSetter !== undefined) {
        Reflect.apply(valueSetter, textarea, [value]);
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitForSent(socket: FakeWebSocket, expected: Record<string, unknown>) {
    await waitFor(() =>
      expect(
        socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>),
      ).toContainEqual(expected),
    );
  }

  function openSocket(socket: FakeWebSocket) {
    act(() => {
      socket.open();
    });
  }

  function receiveSocket(socket: FakeWebSocket, payload: unknown) {
    act(() => {
      socket.receive(payload);
    });
  }

  function firstSocket(sockets: readonly FakeWebSocket[]): FakeWebSocket {
    const socket = sockets[0];
    if (socket === undefined) {
      throw new Error("Expected websocket instance.");
    }
    return socket;
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await flush();
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await flush();
      }
    }
    throw lastError;
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
    });
  }
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { readonly data?: string }) => void>>();
  readyState = FakeWebSocket.CONNECTING;

  addEventListener(type: string, listener: (event: { readonly data?: string }) => void): void {
    const listeners =
      this.#listeners.get(type) ?? new Set<(event: { readonly data?: string }) => void>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: { readonly data?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function fakeWebSocketClass(instances: FakeWebSocket[]): typeof WebSocket {
  return class extends FakeWebSocket {
    constructor() {
      super();
      instances.push(this);
    }
  } as unknown as typeof WebSocket;
}
