// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantChatStreamCallbacks,
  AssistantConversationListPage,
  AssistantConversationRecord,
  AssistantMemoryForgetResult,
  AssistantTurnResponseWithPendingConfirmations,
} from "./api";

import { sessionQueryKeys, type SessionUser } from "@/lib/auth";

const SESSION_USER: SessionUser = {
  id: "user-1",
  actorId: "actor-1",
  name: "Léa Nguyen",
  email: "lea@example.test",
};
const navigateMock = vi.fn();

const streamAssistantChatMock =
  vi.fn<
    (
      input: { readonly conversationId?: string; readonly message: string },
      callbacks: AssistantChatStreamCallbacks,
    ) => Promise<AssistantTurnResponseWithPendingConfirmations>
  >();
const listAssistantConversationsMock = vi.fn<() => Promise<AssistantConversationListPage>>();
const setAssistantConversationPinnedMock =
  vi.fn<
    (input: {
      readonly conversationId: string;
      readonly pinned: boolean;
    }) => Promise<AssistantConversationRecord>
  >();
const renameAssistantConversationMock =
  vi.fn<
    (input: {
      readonly conversationId: string;
      readonly title: string;
    }) => Promise<AssistantConversationRecord>
  >();
const deleteAssistantConversationMock =
  vi.fn<(input: { readonly conversationId: string }) => Promise<void>>();
const forgetAssistantMemoryMock = vi.fn<() => Promise<AssistantMemoryForgetResult>>();
const getAssistantConversationMock = vi.fn<() => Promise<{ messages: readonly unknown[] }>>();

let routeSearch: { readonly prompt?: string } = {};
const CITATIONS = [
  { kind: "mail", id: "m-1", title: "Harbor launch", path: "/mail/thread-9?message=m-1" },
  { kind: "drive", id: "file-4", title: "Harbor brief.md", path: "/drive/file-4" },
  { kind: "chat", id: "c-1", title: "#harbor", path: "/chat/room-2?message=c-1" },
  { kind: "calendar", id: "ev-7", title: "Harbor sync", path: "/calendar/events/ev-7" },
] as const;
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useSearch: () => routeSearch,
  Link: ({
    children,
    to,
    search,
    className,
  }: {
    readonly children: ReactNode;
    readonly to: string;
    readonly search: Record<string, string>;
    readonly className?: string;
  }) => (
    <a href={`${to}?${new URLSearchParams(search).toString()}`} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/shell", () => ({
  SurfaceFrame: ({
    children,
    title,
    searchPlaceholder,
    searchValue,
    onSearchChange,
  }: {
    readonly children: ReactNode;
    readonly title: string;
    readonly searchPlaceholder?: string;
    readonly searchValue?: string;
    readonly onSearchChange?: (value: string) => void;
  }) => (
    <div data-testid="surface-frame" data-title={title}>
      <input
        aria-label={searchPlaceholder}
        value={searchValue ?? ""}
        onChange={(event) => onSearchChange?.(event.target.value)}
      />
      {children}
    </div>
  ),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  streamAssistantChat: (
    input: { readonly conversationId?: string; readonly message: string },
    callbacks: AssistantChatStreamCallbacks,
  ) => streamAssistantChatMock(input, callbacks),
  listAssistantConversations: () => listAssistantConversationsMock(),
  listAssistantTools: () =>
    Promise.resolve({
      limit: 128,
      groups: [{ id: "mail", label: "Mail", count: 4, defaultEnabled: true }],
    }),
  listAssistantModels: () =>
    Promise.resolve({
      models: [{ id: "groq/llama", label: "Llama", providerId: "groq", model: "llama" }],
      defaultModelId: "groq/llama",
      webSearchEnabled: true,
    }),
  getAssistantConversation: () => getAssistantConversationMock(),
  setAssistantConversationPinned: (input: {
    readonly conversationId: string;
    readonly pinned: boolean;
  }) => setAssistantConversationPinnedMock(input),
  renameAssistantConversation: (input: {
    readonly conversationId: string;
    readonly title: string;
  }) => renameAssistantConversationMock(input),
  deleteAssistantConversation: (input: { readonly conversationId: string }) =>
    deleteAssistantConversationMock(input),
  forgetAssistantMemory: () => forgetAssistantMemoryMock(),
}));

const { AssistantSurface } = await import("./assistant-surface");
const { AssistantRequestError } = await import("./tool-limit");

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CONVERSATIONS: AssistantConversationListPage = {
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Draft Q3 board update narrative",
      pinned: true,
      pinnedAt: "2026-05-21T09:00:00.000Z",
      memoryOptIn: false,
      updatedAt: "2026-05-21T09:30:00.000Z",
      createdAt: "2026-05-20T09:00:00.000Z",
      messageCount: 6,
      preview: "Here is the board narrative.",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Summarize unread inbox",
      pinned: false,
      pinnedAt: null,
      memoryOptIn: false,
      updatedAt: "2026-05-21T10:20:00.000Z",
      createdAt: "2026-05-21T10:00:00.000Z",
      messageCount: 2,
      preview: "Three things to flag.",
    },
  ],
  nextCursor: null,
};

describe("AssistantSurface", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-27T12:00:00.000Z"));
    navigateMock.mockReset();
    routeSearch = {};
    streamAssistantChatMock.mockReset();
    listAssistantConversationsMock.mockReset();
    setAssistantConversationPinnedMock.mockReset();
    renameAssistantConversationMock.mockReset();
    deleteAssistantConversationMock.mockReset();
    forgetAssistantMemoryMock.mockReset();
    getAssistantConversationMock.mockReset();

    listAssistantConversationsMock.mockResolvedValue(CONVERSATIONS);
    setAssistantConversationPinnedMock.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Draft Q3 board update narrative",
      pinnedAt: null,
      memoryOptIn: false,
      updatedAt: "2026-05-21T11:00:00.000Z",
      createdAt: "2026-05-20T09:00:00.000Z",
    });
    renameAssistantConversationMock.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      title: "Renamed chat",
      pinnedAt: null,
      memoryOptIn: false,
      updatedAt: "2026-05-21T11:00:00.000Z",
      createdAt: "2026-05-21T10:00:00.000Z",
    });
    deleteAssistantConversationMock.mockResolvedValue(undefined);
    forgetAssistantMemoryMock.mockResolvedValue({ forgottenCount: 3 });
    getAssistantConversationMock.mockResolvedValue({
      messages: [
        { id: "saved-user", role: "user", content: "Previous question" },
        { id: "saved-assistant", role: "assistant", content: "Persisted answer" },
      ],
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    queryClient.setQueryData(sessionQueryKeys.current, SESSION_USER);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AssistantSurface />
        </QueryClientProvider>,
      );
    });
  }

  async function flush() {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function textarea(): HTMLTextAreaElement {
    const node = container.querySelector("textarea");
    if (node === null) {
      throw new Error("composer textarea not found");
    }
    return node;
  }

  function setNativeValue(node: HTMLTextAreaElement | HTMLInputElement, value: string) {
    const prototype =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) {
      throw new Error("native value setter unavailable");
    }
    Reflect.apply(setter, node, [value]);
  }

  function setComposerValue(value: string) {
    const node = textarea();
    setNativeValue(node, value);
    act(() => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** Opens a Radix menu from the keyboard, as the menu's own tests do. */
  async function openMenu(trigger: HTMLButtonElement | null) {
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
  }

  function menuItem(text: string): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent.includes(text),
    );
  }

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes(text) === true,
    );
  }

  it("greets the current user and follows updates to the shared session", async () => {
    render();
    await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Hi Léa, what can I help with?");
    act(() => {
      queryClient.setQueryData(sessionQueryKeys.current, { ...SESSION_USER, name: "Priya Shah" });
    });
    await flush();
    expect(container.querySelector("h1")?.textContent).toBe("Hi Priya, what can I help with?");
  });

  it.each([null, { ...SESSION_USER, name: "   " }])(
    "uses a generic greeting without a name",
    async (user) => {
      queryClient.setQueryData(sessionQueryKeys.current, user);
      render();
      await flush();
      expect(container.querySelector("h1")?.textContent).toBe("What can I help with?");
    },
  );

  it("renders pinned and recent threads from assistant.conversations.list", async () => {
    render();
    await flush();
    expect(listAssistantConversationsMock).toHaveBeenCalled();
    const text = container.textContent ?? "";
    expect(text).toContain("Pinned");
    expect(text).toContain("Previous 7 Days");
    expect(text).toContain("Draft Q3 board update narrative");
    expect(text).toContain("Summarize unread inbox");
  });

  it("searches conversations from the top bar, with no second search box", async () => {
    render();
    await flush();
    listAssistantConversationsMock.mockClear();

    const searchInputs = container.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Search chats"]',
    );
    expect(searchInputs).toHaveLength(1);
    const searchInput = searchInputs[0] ?? null;
    if (searchInput === null) {
      throw new Error("search input not found");
    }
    setNativeValue(searchInput, "board");
    act(() => {
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(listAssistantConversationsMock).toHaveBeenCalled();
  });

  it("shows the empty hero state after starting a new chat", async () => {
    render();
    await flush();
    const newChat = buttonByText("New chat");
    expect(newChat).toBeDefined();
    act(() => {
      newChat?.click();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("what can I help with");
    expect(text).toContain("Catch me up on mail");
  });

  it("shows tool progress and failed outcomes without losing the retry draft", async () => {
    let failTurn: (reason: Error) => void = () => undefined;
    let streamCallbacks: AssistantChatStreamCallbacks | undefined;
    streamAssistantChatMock.mockImplementation((_input, callbacks) => {
      streamCallbacks = callbacks;
      callbacks.onTool?.({ toolCallId: "search-1", toolId: "web.search", status: "running" });
      return new Promise((_resolve, reject) => {
        failTurn = reject;
      });
    });
    render();
    await flush();
    setComposerValue("Find a public source");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await flush();
    expect(container.querySelector('[aria-label="Tool activity"]')?.textContent).toContain(
      "Running",
    );
    act(() => {
      streamCallbacks?.onTool?.({
        toolCallId: "search-1",
        toolId: "web.search",
        status: "failed",
        error: "Search timed out.",
      });
      failTurn(new Error("Try the search again."));
    });
    await flush();
    expect(container.querySelectorAll('[aria-label="Tool activity"] li')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Tool activity"]')?.textContent).toContain(
      "Search timed out.",
    );
    expect(container.textContent).toContain("Try the search again.");
    expect(textarea().value).toBe("Find a public source");
  });

  it("streams an assistant reply and hydrates persisted history from the turn", async () => {
    streamAssistantChatMock.mockImplementation((_input, callbacks) => {
      callbacks.onDelta("Hello ");
      callbacks.onDelta("there.");
      return Promise.resolve({
        conversation: { id: "33333333-3333-4333-8333-333333333333" },
        response: { content: "Hello there." },
        messages: [
          {
            id: "m1",
            role: "user",
            content: "hi there",
          },
          {
            id: "m2",
            role: "assistant",
            content: "Hello there.",
          },
        ],
      });
    });

    render();
    await flush();
    setComposerValue("hi there");
    const sendButton = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Send message",
    );
    act(() => {
      sendButton?.click();
    });
    await flush();

    expect(streamAssistantChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "hi there" }),
      expect.anything(),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("hi there");
    expect(text).toContain("Hello there.");
    expect(container.querySelector('[role="img"][aria-label="Léa Nguyen"]')?.textContent).toBe(
      "LN",
    );
    act(() => {
      queryClient.setQueryData(sessionQueryKeys.current, { ...SESSION_USER, name: "Priya Shah" });
    });
    await flush();
    expect(container.querySelector('[role="img"][aria-label="Priya Shah"]')?.textContent).toBe(
      "PS",
    );
  });

  it("reopens a past conversation and continues it on the next turn", async () => {
    streamAssistantChatMock.mockResolvedValue({
      conversation: { id: "22222222-2222-4222-8222-222222222222" },
      response: { content: "Picking up." },
    });

    render();
    await flush();
    const threadButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Summarize unread inbox") === true,
    );
    expect(threadButton).toBeDefined();
    act(() => {
      threadButton?.click();
    });
    await flush();
    expect(container.textContent ?? "").toContain("Persisted answer");

    setComposerValue("continue please");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(streamAssistantChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "22222222-2222-4222-8222-222222222222",
        message: "continue please",
        webSearch: false,
      }),
      expect.anything(),
    );
  });

  it("restores web search from the last user message when reopening a conversation", async () => {
    getAssistantConversationMock.mockResolvedValue({
      messages: [
        {
          id: "saved-user",
          role: "user",
          content: "whats the weather tomorrow",
          webSearch: true,
        },
        { id: "saved-assistant", role: "assistant", content: "I need a ZIP code." },
      ],
    });
    streamAssistantChatMock.mockResolvedValue({
      conversation: { id: "22222222-2222-4222-8222-222222222222" },
      response: { content: "Searching Gaithersburg." },
    });

    render();
    await flush();
    const threadButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Summarize unread inbox") === true,
    );
    act(() => {
      threadButton?.click();
    });
    await flush();
    expect(container.querySelector('[aria-label="Turn off web search"]')).not.toBeNull();
    setComposerValue("whats teh weatehr for 20882");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(streamAssistantChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "22222222-2222-4222-8222-222222222222",
        message: "whats teh weatehr for 20882",
        webSearch: true,
      }),
      expect.anything(),
    );
  });

  it("pins a conversation through assistant.conversation.pin", async () => {
    render();
    await flush();
    await openMenu(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Chat options for Summarize unread inbox"]',
      ),
    );
    const pinItem = menuItem("Pin");
    expect(pinItem).toBeDefined();
    act(() => {
      pinItem?.click();
    });
    await flush();
    expect(setAssistantConversationPinnedMock).toHaveBeenCalledWith({
      conversationId: "22222222-2222-4222-8222-222222222222",
      pinned: true,
    });
  });

  it("renames a conversation through assistant.conversation.rename", async () => {
    render();
    await flush();
    await openMenu(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Chat options for Summarize unread inbox"]',
      ),
    );
    act(() => {
      menuItem("Rename")?.click();
    });
    await flush();
    const titleInput = container.querySelector<HTMLInputElement>('input[aria-label="Chat title"]');
    expect(titleInput).not.toBeNull();
    if (titleInput !== null) {
      setNativeValue(titleInput, "Renamed chat");
      act(() => {
        titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    act(() => {
      buttonByText("Save")?.click();
    });
    await flush();
    expect(renameAssistantConversationMock).toHaveBeenCalledWith({
      conversationId: "22222222-2222-4222-8222-222222222222",
      title: "Renamed chat",
    });
  });

  it("deletes a conversation through assistant.conversation.delete after confirmation", async () => {
    render();
    await flush();
    await openMenu(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Chat options for Summarize unread inbox"]',
      ),
    );
    act(() => {
      menuItem("Archive")?.click();
    });
    await flush();
    const confirmButton = [...document.querySelectorAll("button")].find(
      (button) => button.className.includes("danger") && button.textContent === "Archive",
    );
    expect(confirmButton).toBeDefined();
    act(() => {
      confirmButton?.click();
    });
    await flush();
    expect(deleteAssistantConversationMock).toHaveBeenCalledWith({
      conversationId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("forgets assistant memory through assistant.memory.forget", async () => {
    render();
    await flush();
    await openMenu(buttonByText("Memory") ?? null);
    act(() => {
      menuItem("Forget memory")?.click();
    });
    await flush();
    // Nothing is forgotten until the confirmation is accepted.
    expect(forgetAssistantMemoryMock).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.className.includes("danger") && button.textContent === "Forget memory",
    );
    expect(confirm).toBeDefined();
    act(() => {
      confirm?.click();
    });
    await flush();
    expect(forgetAssistantMemoryMock).toHaveBeenCalled();
    expect(container.textContent ?? "").toContain("Forgot 3 saved memories");
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    streamAssistantChatMock.mockResolvedValue({ response: { content: "ok" } });
    render();
    await flush();
    setComposerValue("first line");

    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      );
    });
    expect(streamAssistantChatMock).not.toHaveBeenCalled();

    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(streamAssistantChatMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and displays the backend error when the request fails", async () => {
    streamAssistantChatMock.mockRejectedValue(new Error("network down"));
    render();
    await flush();
    setComposerValue("summarize my inbox");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(container.textContent ?? "").toContain("network down");
    expect(textarea().value).toBe("summarize my inbox");
  });

  it("keeps incremental text visible while streaming and stops without losing the partial response", async () => {
    streamAssistantChatMock.mockImplementation((_input, callbacks) => {
      callbacks.onDelta("Partial response");
      return new Promise((_resolve, reject) =>
        callbacks.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }),
      );
    });
    render();
    await flush();
    setComposerValue("Keep this draft");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("Partial response");
    act(() => {
      buttonByText("Stop response")?.click();
    });
    await flush();
    expect(container.textContent).toContain("Partial response");
    expect(container.textContent).toContain("Response stopped.");
    expect(textarea().value).toBe("Keep this draft");
    expect(buttonByText("Stop response")).toBeUndefined();
  });

  it("shows an unavailable notice when the conversation list is unreachable", async () => {
    listAssistantConversationsMock.mockRejectedValue(new Error("offline"));
    render();
    await flush();
    expect(container.textContent ?? "").toContain("Couldn't load chats");
    expect(buttonByText("Retry")).toBeDefined();
  });

  it("offers one-click tool-group toggles when the tool limit is exceeded, then retries", async () => {
    streamAssistantChatMock
      .mockRejectedValueOnce(
        new AssistantRequestError("Too many tools.", "assistant_tool_limit_exceeded", {
          limit: 128,
          selected: 143,
          excess: 15,
          groups: [
            { id: "admin", label: "Administration", count: 40 },
            { id: "mail", label: "Mail", count: 30 },
          ],
        }),
      )
      .mockResolvedValueOnce({ response: { content: "Here is your catch-up." } });
    render();
    await flush();
    setComposerValue("Catch me up on mail");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    const alert = [...container.querySelectorAll('[role="alert"]')].find((node) =>
      node.textContent.includes("Too many tool groups are on (143 of 128 tools)."),
    );
    expect(alert).toBeDefined();
    const turnOff = buttonByText("Turn off Administration (40)");
    expect(buttonByText("Turn off Mail (30)")).toBeDefined();
    act(() => {
      turnOff?.click();
    });
    await flush();

    expect(streamAssistantChatMock).toHaveBeenCalledTimes(2);
    expect(streamAssistantChatMock.mock.calls[1]?.[0]).toMatchObject({
      message: "Catch me up on mail",
      toolGroups: ["mail"],
    });
    expect(container.textContent).toContain("Here is your catch-up.");
    expect(container.textContent).not.toContain("Too many tool groups");
  });

  it("links workspace citations to the mail, drive, chat and calendar items", async () => {
    streamAssistantChatMock.mockResolvedValue({
      conversation: { id: "33333333-3333-4333-8333-333333333333" },
      response: { content: "Two things." },
      sources: [{ id: "s5", type: "web.search", title: "News", url: "https://example.com/a" }],
      messages: [
        { id: "m1", role: "user", content: "harbor status" },
        { id: "m2", role: "assistant", content: "Two things.", citations: CITATIONS },
      ],
    });
    render();
    await flush();
    setComposerValue("harbor status");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();

    const links = [
      ...container.querySelectorAll<HTMLAnchorElement>('[aria-label="Workspace sources"] a'),
    ].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Harbor launch", "/mail?thread=thread-9"],
      ["Harbor brief.md", "/drive?file=file-4"],
      ["#harbor", "/chat?room=room-2"],
      ["Harbor sync", "/calendar?event=ev-7"],
    ]);
  });

  it("regenerates an answer by sending its prompt again", async () => {
    streamAssistantChatMock
      .mockResolvedValueOnce({ response: { content: "First answer." } })
      .mockResolvedValueOnce({ response: { content: "Second answer." } });
    render();
    await flush();
    setComposerValue("Draft an email");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Regenerate response"]')?.click();
    });
    await flush();
    expect(streamAssistantChatMock).toHaveBeenCalledTimes(2);
    expect(streamAssistantChatMock.mock.calls[1]?.[0]).toMatchObject({ message: "Draft an email" });
    expect(container.textContent).toContain("Second answer.");
    expect(container.textContent).not.toContain("First answer.");
  });

  it("sends a prompt handed over in the URL once, as a new chat", async () => {
    routeSearch = { prompt: "Find a file" };
    streamAssistantChatMock.mockResolvedValue({ response: { content: "Found it." } });
    render();
    await flush();
    expect(streamAssistantChatMock).toHaveBeenCalledTimes(1);
    expect(streamAssistantChatMock.mock.calls[0]?.[0]).toMatchObject({ message: "Find a file" });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/assistant", search: {}, replace: true });
  });
});
