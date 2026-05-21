// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailShell } from "./mail-shell";
import { mailUiStore, resetMailUiStoreForTest } from "./mail-store";

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({ emptyFallback }: { readonly emptyFallback?: React.ReactNode }) =>
    emptyFallback ?? null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("MailShell backend tool integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;
  let localStorageState: Map<string, string>;
  let setItemMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorageState = new Map();
    setItemMock = vi.fn((key: string, value: string) => {
      localStorageState.set(key, value);
    });
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
    Range.prototype.getClientRects = vi.fn(
      () =>
        ({
          length: 0,
          item: () => null,
          [Symbol.iterator]: function* iterator() {},
        }) as DOMRectList,
    );
    Range.prototype.getBoundingClientRect = vi.fn(() => new DOMRect());
    HTMLElement.prototype.getBoundingClientRect = vi.fn(
      () =>
        new DOMRect(0, 0, 960, 720) satisfies DOMRect,
    );
    scrollIntoViewMock = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => localStorageState.get(key) ?? null),
        removeItem: vi.fn((key: string) => {
          localStorageState.delete(key);
        }),
        setItem: setItemMock,
      },
    });
    resetMailUiStoreForTest();
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (input === "/api/tools/mail.search") {
        return Promise.resolve(
          Response.json({
            hits: [
              {
                threadId: "00000000-0000-4000-8000-000000000301",
                messageId: "00000000-0000-4000-8000-000000000401",
                subject: "Backend launch thread",
                from: { address: "sam@helix.local", name: "Sam Patel" },
                preview: "Backend search result preview",
                sentAt: "2026-05-20T12:00:00.000Z",
                labels: ["planning"],
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/mail.thread.get") {
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as { threadId?: string }) : {};
        const threadId = body.threadId ?? "00000000-0000-4000-8000-000000000301";
        const isDeepLinkedThread = threadId === "00000000-0000-4000-8000-000000000302";
        return Promise.resolve(
          Response.json({
            thread: {
              id: threadId,
              subject: isDeepLinkedThread ? "Deep linked thread" : "Backend launch thread",
              preview: isDeepLinkedThread ? "Opened from URL state" : "Full backend preview",
              participants: [{ address: "sam@helix.local", name: "Sam Patel" }],
              messages: [
                {
                  id: "00000000-0000-4000-8000-000000000401",
                  from: { address: "sam@helix.local", name: "Sam Patel" },
                  to: [{ address: "maya@helix.local", name: "Maya Chen" }],
                  cc: [],
                  bcc: [],
                  sentAt: "2026-05-20T12:00:00.000Z",
                  body: isDeepLinkedThread
                    ? "Deep linked backend message body"
                    : "Full backend message body",
                  bodyFormat: "plain",
                  hasAttachment: false,
                },
                ...(isDeepLinkedThread
                  ? [
                      {
                        id: "00000000-0000-4000-8000-000000000402",
                        from: { address: "riley@helix.local", name: "Riley Brooks" },
                        to: [{ address: "maya@helix.local", name: "Maya Chen" }],
                        cc: [],
                        bcc: [],
                        sentAt: "2026-05-20T12:30:00.000Z",
                        body: "Deep linked target message body",
                        bodyFormat: "plain",
                        hasAttachment: false,
                      },
                    ]
                  : []),
              ],
              labels: ["planning"],
              archivedAt: null,
              deletedAt: null,
              snoozedUntil: null,
              lastActivity: "2026-05-20T12:00:00.000Z",
              unread: false,
              starred: false,
              direction: "inbound",
            },
          }),
        );
      }
      if (input === "/api/tools/mail.vacation.get") {
        return Promise.resolve(
          Response.json({
            vacation: {
              id: "00000000-0000-4000-8000-000000000601",
              enabled: false,
              subject: "Out of office",
              body: "I am away this week.",
              startsAt: null,
              endsAt: null,
              updatedAt: "2026-05-20T10:00:00.000Z",
            },
          }),
        );
      }
      if (input === "/api/tools/mail.filter.list") {
        return Promise.resolve(
          Response.json({
            filters: [
              {
                id: "00000000-0000-4000-8000-000000000701",
                name: "Planning attachments",
                enabled: true,
                priority: 50,
                criteria: { subjectContains: "roadmap", hasAttachment: true },
                actions: { applyLabels: ["planning"] },
                createdAt: "2026-05-20T09:00:00.000Z",
                updatedAt: "2026-05-20T09:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/mail.filter.create") {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as {
                actions?: Record<string, unknown>;
                criteria?: Record<string, unknown>;
                enabled?: boolean;
                name?: string;
                priority?: number;
              })
            : {};
        return Promise.resolve(
          Response.json({
            id: "00000000-0000-4000-8000-000000000702",
            name: body.name,
            enabled: body.enabled ?? true,
            priority: body.priority ?? 100,
            criteria: body.criteria ?? {},
            actions: body.actions ?? {},
            createdAt: "2026-05-20T09:10:00.000Z",
            updatedAt: "2026-05-20T09:10:00.000Z",
          }),
        );
      }
      if (input === "/api/tools/mail.filter.update") {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as { enabled?: boolean; id?: string })
            : {};
        return Promise.resolve(
          Response.json({
            id: body.id,
            name: "Planning attachments",
            enabled: body.enabled ?? false,
            priority: 50,
            criteria: { subjectContains: "roadmap", hasAttachment: true },
            actions: { applyLabels: ["planning"] },
            createdAt: "2026-05-20T09:00:00.000Z",
            updatedAt: "2026-05-20T09:15:00.000Z",
          }),
        );
      }
      if (input === "/api/tools/mail.filter.delete") {
        return Promise.resolve(Response.json({ deleted: true }));
      }
      if (input === "/api/tools/mail.vacation.set") {
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        return Promise.resolve(
          Response.json({
            vacation: {
              id: "00000000-0000-4000-8000-000000000601",
              updatedAt: "2026-05-20T10:05:00.000Z",
              ...body,
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ status: "queued" }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetMailUiStoreForTest();
    vi.unstubAllGlobals();
  });

  it("loads search hits, hydrates the selected thread, and replies through mail.reply", async () => {
    renderMail();
    await waitForText("Backend launch thread");
    await clickButton("Backend launch thread");
    await waitForText("Full backend message body");

    expect(container.querySelector(".mail-workspace.reading")).toBeInstanceOf(HTMLElement);
    expect(container.querySelector('[aria-label="Thread list"]')).toBeNull();
    expect(container.querySelector('[aria-label="Inbox categories"]')).toBeNull();
    expect(container.textContent).not.toContain("Happening soon");

    await clickIconButton("Star thread");
    await clickIconButton("Mark thread unread");
    await clickButton("Reply");
    await typeBody("Reply from the web shell");
    await clickComposerSend();
    await clickIconButton("Snooze thread");

    expect(toolCallBody("mail.star.set")).toEqual({
      threadId: "00000000-0000-4000-8000-000000000301",
      starred: true,
    });
    expect(toolCallBody("mail.read.set")).toEqual({
      threadId: "00000000-0000-4000-8000-000000000301",
      unread: true,
    });
    expect(toolCallBody("mail.snooze")).toMatchObject({
      threadId: "00000000-0000-4000-8000-000000000301",
    });
    const replyCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/mail.reply");
    expect(replyCall?.[1]?.method).toBe("POST");
    const replyBody = replyCall?.[1]?.body;
    if (typeof replyBody !== "string") {
      throw new Error("Expected mail.reply JSON body.");
    }
    expect(JSON.parse(replyBody)).toEqual({
      threadId: "00000000-0000-4000-8000-000000000301",
      to: [{ address: "sam@helix.local", name: "Sam Patel" }],
      cc: [],
      bcc: [],
      subject: "Re: Backend launch thread",
      bodyText: "Reply from the web shell",
    });
  });

  it("uses route search state for the backend search query", async () => {
    renderMail({
      searchState: {
        query: "launch",
        label: "planning",
        mailbox: "inbox",
        unreadOnly: false,
        priorityOnly: false,
        attachmentsOnly: false,
      },
    });

    await waitForText("Backend launch thread");

    expect(toolCallBody("mail.search")).toEqual({
      query: "launch",
      labels: ["planning"],
      limit: 50,
    });
    const searchInput = container.querySelector('input[placeholder="Search mail"]');
    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    expect((searchInput as HTMLInputElement).value).toBe("launch");
    expect(buttonWithText("Planning")?.className).toContain("active");
  });

  it("emits route search updates from filter controls", async () => {
    const onSearchStateChange = vi.fn();

    renderMail({ onSearchStateChange });
    await waitForText("Backend launch thread");

    await typeSearch("launch");
    await clickButton("Unread");

    expect(onSearchStateChange).toHaveBeenCalledWith({
      query: "launch",
      label: "all",
      mailbox: "inbox",
      unreadOnly: false,
      priorityOnly: false,
      attachmentsOnly: false,
    });
    expect(onSearchStateChange).toHaveBeenLastCalledWith({
      query: "launch",
      label: "all",
      mailbox: "inbox",
      unreadOnly: true,
      priorityOnly: false,
      attachmentsOnly: false,
    });
  });

  it("emits thread route updates while preserving current search state", async () => {
    const onThreadRouteStateChange = vi.fn();
    const searchState = {
      query: "launch",
      label: "planning" as const,
      mailbox: "inbox" as const,
      unreadOnly: false,
      priorityOnly: false,
      attachmentsOnly: false,
    };

    renderMail({ onThreadRouteStateChange, searchState });
    await waitForText("Backend launch thread");

    await clickButton("Backend launch thread");
    await waitForText("Full backend message body");

    expect(onThreadRouteStateChange).toHaveBeenCalledWith(
      { threadId: "00000000-0000-4000-8000-000000000301" },
      searchState,
    );

    await clickIconButton("Back to inbox");

    expect(onThreadRouteStateChange).toHaveBeenLastCalledWith({}, searchState);
  });

  it("clears the routed thread when mailbox navigation changes the list", async () => {
    const onThreadRouteStateChange = vi.fn();
    const searchState = {
      query: "launch",
      label: "planning" as const,
      mailbox: "inbox" as const,
      unreadOnly: false,
      priorityOnly: false,
      attachmentsOnly: false,
    };

    renderMail({ onThreadRouteStateChange, searchState });
    await waitForText("Backend launch thread");
    await clickButton("Backend launch thread");
    await waitForText("Full backend message body");

    await clickButton("Starred");

    expect(onThreadRouteStateChange).toHaveBeenLastCalledWith(
      {},
      {
        ...searchState,
        mailbox: "starred",
      },
    );
  });

  it("hydrates the initial thread id from route search state", async () => {
    renderMail({ initialThreadId: "00000000-0000-4000-8000-000000000302" });

    await waitForText("Deep linked thread");
    await waitForText("Deep linked backend message body");

    expect(toolCallBody("mail.thread.get")).toEqual({
      threadId: "00000000-0000-4000-8000-000000000302",
    });
  });

  it("focuses and scrolls the initial message id after thread hydration", async () => {
    renderMail({
      initialMessageId: "00000000-0000-4000-8000-000000000402",
      initialThreadId: "00000000-0000-4000-8000-000000000302",
    });

    await waitForText("Deep linked target message body");

    const focusedMessage = container.querySelector(
      '[data-message-id="00000000-0000-4000-8000-000000000402"]',
    );
    expect(focusedMessage).toBeInstanceOf(HTMLElement);
    expect(focusedMessage?.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(focusedMessage);
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });

  it("saves the current search as a backend mail filter", async () => {
    renderMail();
    await waitForText("Backend launch thread");
    await waitForText("Planning attachments");
    await waitForText("Status");
    await waitForText("Criteria");
    await waitForText("subject contains roadmap, has attachments");

    await typeSearch("launch");
    await clickIconButton("Save current mail filter");

    expect(toolCallBody("mail.filter.create")).toEqual({
      name: "Mail filter: launch",
      enabled: true,
      priority: 100,
      criteria: { subjectContains: "launch" },
      actions: {},
    });
    await waitForText("Mail filter: launch");
    await waitForText("subject contains launch");
  });

  it("updates and deletes saved mail filter rows", async () => {
    renderMail();
    await waitForText("Planning attachments");

    await clickIconButton("Disable mail filter Planning attachments");

    expect(toolCallBody("mail.filter.update")).toEqual({
      id: "00000000-0000-4000-8000-000000000701",
      enabled: false,
    });
    await waitForText("Paused");

    await clickIconButton("Delete mail filter Planning attachments");

    expect(toolCallBody("mail.filter.delete")).toEqual({
      id: "00000000-0000-4000-8000-000000000701",
    });
    await waitForText("No saved mail filters.");
  });

  it("loads and saves vacation settings through mail.vacation tools", async () => {
    renderMail();
    await waitForText("Vacation off");
    await waitForButtonEnabled("Vacation off");

    await clickButton("Vacation off");

    expect(toolCallBody("mail.vacation.set")).toEqual({
      enabled: true,
      subject: "Out of office",
      body: "I am away this week.",
      startsAt: null,
      endsAt: null,
    });
    await waitForText("Vacation on");
  });

  it("persists compact and comfortable density preferences in the mail store", async () => {
    renderMail();
    await waitForText("Backend launch thread");

    await clickButton("Compact");

    expect(container.querySelector(".mail-thread-list.compact")).toBeInstanceOf(HTMLElement);
    expect(setItemMock).toHaveBeenLastCalledWith(
      "helix-mail-ui",
      JSON.stringify({ density: "compact" }),
    );

    await clickButton("Comfort");

    expect(container.querySelector(".mail-thread-list.compact")).toBeNull();
    expect(setItemMock).toHaveBeenLastCalledWith(
      "helix-mail-ui",
      JSON.stringify({ density: "comfortable" }),
    );
  });

  it("tracks multi-select thread and message ids in the mail store", async () => {
    renderMail();
    await waitForText("Backend launch thread");

    const threadCheckbox = await waitForCheckbox("Select thread Backend launch thread");
    expect(threadCheckbox.checked).toBe(false);
    await clickCheckbox(threadCheckbox);
    expect(checkboxWithLabel("Select thread Backend launch thread").checked).toBe(true);

    await clickButton("Backend launch thread");
    await waitForText("Full backend message body");

    const messageCheckbox = checkboxWithLabel("Select message from Sam Patel");
    expect(messageCheckbox.checked).toBe(false);

    await clickCheckbox(messageCheckbox);

    expect(checkboxWithLabel("Select message from Sam Patel").checked).toBe(true);

    await clickIconButton("Back to inbox");
    await clickCheckbox(checkboxWithLabel("Select thread Backend launch thread"));

    expect(checkboxWithLabel("Select thread Backend launch thread").checked).toBe(false);
  });

  it("preserves an open composer draft in the mail store across shell remounts", async () => {
    renderMail();
    await waitForText("Backend launch thread");

    await clickButton("Compose");
    await addRecipient("maya@helix.local");
    await typeSubject("Store backed draft");
    await typeBody("This draft survives remount.");

    expect(mailUiStore.state.composerDraft).toMatchObject({
      subject: "Store backed draft",
      body: "This draft survives remount.",
      to: [{ email: "maya@helix.local", name: "Maya Chen" }],
    });

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    renderMail();

    await waitForSubject("Store backed draft");
    expect(container.querySelector(".mail-body-input")?.textContent).toContain(
      "This draft survives remount.",
    );
  });

  it("clears the store-backed composer draft when the composer is closed", async () => {
    renderMail();
    await waitForText("Backend launch thread");

    await clickButton("Compose");
    await typeSubject("Discarded draft");
    expect(mailUiStore.state.composerDraft?.subject).toBe("Discarded draft");

    await clickIconButton("Close composer");

    expect(mailUiStore.state.composerDraft).toBeNull();
    expect(container.querySelector(".mail-composer")).toBeNull();
  });

  it("clears the store-backed composer draft on send and restores it through undo send", async () => {
    renderMail();
    await waitForText("Backend launch thread");

    await clickButton("Compose");
    await addRecipient("maya@helix.local");
    await typeSubject("Queued draft");
    await typeBody("Send this store-backed draft.");
    await clickComposerSend();

    expect(mailUiStore.state.composerDraft).toBeNull();
    expect(toolCallBody("mail.send")).toEqual({
      to: [{ address: "maya@helix.local", name: "Maya Chen" }],
      cc: [],
      bcc: [],
      subject: "Queued draft",
      bodyText: "Send this store-backed draft.",
    });

    await clickButton("Undo");

    expect(mailUiStore.state.composerDraft).toMatchObject({
      subject: "Queued draft",
      body: "Send this store-backed draft.",
    });
    await waitForSubject("Queued draft");
  });

  it("blocks invalid vacation form values with field validation", async () => {
    renderMail();
    await waitForText("Vacation off");
    await waitForButtonEnabled("Vacation off");
    await clickIconButton("Vacation settings");

    await typeVacationSubject("x".repeat(121));
    await clickButton("Save");

    await waitForText("Subject must be 120 characters or fewer.");
    expect(
      fetchMock.mock.calls.filter((call) => call[0] === "/api/tools/mail.vacation.set"),
    ).toHaveLength(0);
  });

  it("shows seeded sample mail when mail.search is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    renderMail();
    await waitForText("[AlphaBravoCompany/remotedialer] Run failed");
    await waitForText("A recent debit is above the transaction amount you set");

    expect(container.textContent).not.toContain("Mailbox unavailable");
  });

  it("keeps seeded sample mail after an unavailable first search", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));

    renderMail();
    await waitForText("[AlphaBravoCompany/remotedialer] Run failed");

    expect(
      fetchMock.mock.calls.filter((call) => call[0] === "/api/tools/mail.search"),
    ).toHaveLength(1);
  });

  function renderMail(props: Parameters<typeof MailShell>[0] = {}) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MailShell {...props} />
        </QueryClientProvider>,
      );
    });
  }

  async function clickButton(text: string) {
    const button = buttonWithText(text);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickIconButton(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Icon button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickCheckbox(checkbox: HTMLInputElement) {
    act(() => {
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function toolCallBody(toolId: string) {
    const call = fetchMock.mock.calls.find((candidate) => candidate[0] === `/api/tools/${toolId}`);
    const body = call?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error(`Expected ${toolId} JSON body.`);
    }
    return JSON.parse(body) as unknown;
  }

  async function typeSearch(value: string) {
    const input = container.querySelector('input[placeholder="Search mail"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Search input not found.");
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function typeVacationSubject(value: string) {
    const input = container.querySelector('input[aria-label="Vacation subject"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Vacation subject input not found.");
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function typeSubject(value: string) {
    const input = subjectInput();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function typeBody(value: string) {
    const editor = container.querySelector(".mail-body-input");
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer body not found.");
    }
    act(() => {
      editor.textContent = value;
      editor.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function addRecipient(value: string) {
    const input = container.querySelector('input[aria-label="Add recipient"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Recipient input not found.");
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickComposerSend() {
    const composer = container.querySelector(".mail-composer");
    const button = Array.from(composer?.querySelectorAll("button") ?? []).find((candidate) =>
      candidate.textContent?.includes("Send"),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Composer send button not found.");
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitForButtonEnabled(text: string) {
    await waitFor(() => {
      const button = buttonWithText(text);
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  }

  async function waitForSubject(value: string) {
    await waitFor(() => expect(subjectInput().value).toBe(value));
  }

  function buttonWithText(text: string) {
    return Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
  }

  function checkboxWithLabel(label: string) {
    const checkbox = container.querySelector(`input[type="checkbox"][aria-label="${label}"]`);
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error(`Checkbox not found: ${label}`);
    }
    return checkbox;
  }

  function subjectInput() {
    const input = container.querySelector('input[aria-label="Subject"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Subject input not found.");
    }
    return input;
  }

  async function waitForCheckbox(label: string) {
    let checkbox: HTMLInputElement | undefined;
    await waitFor(() => {
      checkbox = checkboxWithLabel(label);
    });
    return checkbox!;
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }
});
