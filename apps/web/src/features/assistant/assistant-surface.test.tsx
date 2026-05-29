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

const navigateMock = vi.fn();

const streamAssistantChatMock =
  vi.fn<
    (
      input: { readonly conversationId?: string; readonly message: string },
      callbacks: AssistantChatStreamCallbacks,
    ) => Promise<AssistantTurnResponseWithPendingConfirmations>
  >();
const listAssistantConversationsMock =
  vi.fn<() => Promise<AssistantConversationListPage>>();
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
const forgetAssistantMemoryMock =
  vi.fn<() => Promise<AssistantMemoryForgetResult>>();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/components/shell", () => ({
  SurfaceFrame: ({ children, title }: { readonly children: ReactNode; readonly title: string }) => (
    <div data-testid="surface-frame" data-title={title}>
      {children}
    </div>
  ),
}));

vi.mock("./api", () => ({
  streamAssistantChat: (
    input: { readonly conversationId?: string; readonly message: string },
    callbacks: AssistantChatStreamCallbacks,
  ) => streamAssistantChatMock(input, callbacks),
  listAssistantConversations: () => listAssistantConversationsMock(),
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
    navigateMock.mockReset();
    streamAssistantChatMock.mockReset();
    listAssistantConversationsMock.mockReset();
    setAssistantConversationPinnedMock.mockReset();
    renameAssistantConversationMock.mockReset();
    deleteAssistantConversationMock.mockReset();
    forgetAssistantMemoryMock.mockReset();

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

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
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
    // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter invoked via Reflect.apply with node receiver
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

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes(text) === true,
    );
  }

  it("renders pinned and recent threads from assistant.conversations.list", async () => {
    render();
    await flush();
    expect(listAssistantConversationsMock).toHaveBeenCalled();
    const text = container.textContent ?? "";
    expect(text).toContain("Pinned");
    // The Recent section is now subdivided into ChatGPT-style date buckets.
    // Our fixture lives ~6 days back, which lands in "Previous 7 Days".
    expect(text).toContain("Previous 7 Days");
    expect(text).toContain("Draft Q3 board update narrative");
    expect(text).toContain("Summarize unread inbox");
  });

  it("searches conversations by passing the query through to the list tool", async () => {
    render();
    await flush();
    listAssistantConversationsMock.mockClear();

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search chats"]',
    );
    if (searchInput === null) {
      throw new Error("search input not found");
    }
    setNativeValue(searchInput, "board");
    act(() => {
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    // The list query refetches once the search query changes.
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
    expect(text).toContain("What can I help you with");
    expect(text).toContain("Catch me up on mail");
  });

  it("streams an assistant reply and hydrates persisted history from the turn", async () => {
    streamAssistantChatMock.mockImplementation((_input, callbacks) => {
      callbacks.onDelta("Hello ");
      callbacks.onDelta("Alex.");
      return Promise.resolve({
        conversation: { id: "33333333-3333-4333-8333-333333333333" },
        response: { content: "Hello Alex." },
        messages: [
          {
            id: "m1",
            role: "user",
            content: "hi there",
          },
          {
            id: "m2",
            role: "assistant",
            content: "Hello Alex.",
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
    expect(text).toContain("Hello Alex.");
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
    expect(container.textContent ?? "").toContain("Conversation reopened");

    setComposerValue("continue please");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(streamAssistantChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "22222222-2222-4222-8222-222222222222",
        message: "continue please",
      }),
      expect.anything(),
    );
  });

  it("pins a conversation through assistant.conversation.pin", async () => {
    render();
    await flush();
    const optionsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Chat options for Summarize unread inbox"]',
    );
    expect(optionsButton).not.toBeNull();
    act(() => {
      optionsButton?.click();
    });
    const pinItem = buttonByText("Pin");
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
    const optionsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Chat options for Summarize unread inbox"]',
    );
    act(() => {
      optionsButton?.click();
    });
    act(() => {
      buttonByText("Rename")?.click();
    });
    const titleInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Chat title"]',
    );
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
    const optionsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Chat options for Summarize unread inbox"]',
    );
    act(() => {
      optionsButton?.click();
    });
    act(() => {
      // The menu entry was renamed to "Archive" to match the backend's
      // soft-delete semantics (sets archived_at, retains history).
      buttonByText("Archive")?.click();
    });
    const confirmButton = [...container.querySelectorAll("button")].find(
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
    const forgetButton = buttonByText("Forget memory");
    expect(forgetButton).toBeDefined();
    act(() => {
      forgetButton?.click();
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

  it("shows the friendly fallback message when the assistant request fails", async () => {
    streamAssistantChatMock.mockRejectedValue(new Error("network down"));
    render();
    await flush();
    setComposerValue("summarize my inbox");
    act(() => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(container.textContent ?? "").toContain("Configure a provider in Settings");
  });

  it("shows an unavailable notice when the conversation list is unreachable", async () => {
    listAssistantConversationsMock.mockRejectedValue(new Error("offline"));
    render();
    await flush();
    expect(container.textContent ?? "").toContain("Chats unavailable — try again later.");
  });
});
