// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { resetComposeWindows } from "./compose/compose-store";
import { MailShell } from "./mail-shell";
import { FOLDERS, LABELS, threadRow, UPDATES_ROW, THREAD_DETAIL } from "./mail-shell.test-fixtures";
import { shellOverlaysForTest } from "@/test/shell-overlays";

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ navigate: navigateMock }),
  useSearch: () => ({}),
  useBlocker: () => ({
    status: "idle",
    current: undefined,
    next: undefined,
    action: undefined,
    proceed: undefined,
    reset: undefined,
  }),
}));

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({ emptyFallback }: { readonly emptyFallback?: React.ReactNode }) =>
    emptyFallback ?? null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const overlayApi = shellOverlaysForTest();

describe("MailShell", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function urlOf(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return input.url;
  }

  function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    if (url.endsWith("/api/auth/csrf-token")) {
      return Promise.resolve(Response.json({ csrfToken: "test-csrf-token" }));
    }
    if (url.endsWith("/mail.folders.list")) {
      return Promise.resolve(Response.json({ folders: FOLDERS }));
    }
    if (url.endsWith("/mail.labels.list")) {
      return Promise.resolve(Response.json({ labels: LABELS }));
    }
    if (url.endsWith("/mail.threads.list")) {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        readonly folder?: string;
        readonly tab?: string;
        readonly query?: string;
      };
      if (body.folder === "drafts") {
        return Promise.resolve(Response.json({ threads: [], total: 0, limit: 50, offset: 0 }));
      }
      if (body.tab === "updates") {
        return Promise.resolve(
          Response.json({ threads: [UPDATES_ROW], total: 1, limit: 50, offset: 0 }),
        );
      }
      if (body.query === "from:nobody") {
        return Promise.resolve(Response.json({ threads: [], total: 0, limit: 50, offset: 0 }));
      }
      return Promise.resolve(
        Response.json({ threads: [threadRow()], total: 1, limit: 50, offset: 0 }),
      );
    }
    if (url.endsWith("/mail.thread.get")) {
      return Promise.resolve(Response.json({ thread: THREAD_DETAIL }));
    }
    if (url.endsWith("/mail/addresses"))
      return Promise.resolve(
        Response.json({
          actorId: "actor-1",
          primaryEmail: "alex@helix.io",
          eligibleDomains: [],
          addresses: [
            {
              id: null,
              address: "alex@helix.io",
              displayName: "Alex",
              isPrimary: true,
              receiveEnabled: true,
              sendAsEnabled: true,
              source: "primary",
            },
          ],
        }),
      );
    if (url.endsWith("/mail.settings.get")) {
      return Promise.resolve(
        Response.json({
          signatureText: "",
          signatureHtml: null,
          includeSignatureOnReplies: true,
          blockedSenders: [],
          updatedAt: null,
        }),
      );
    }
    return Promise.resolve(Response.json({ id: "m1", status: "sent" }));
  }

  beforeEach(() => {
    navigateMock.mockClear();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    fetchMock = vi.fn<typeof fetch>(defaultFetch);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      resetComposeWindows();
      root.unmount();
    });
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ShellOverlayContext.Provider value={overlayApi}>
            <MailShell />
          </ShellOverlayContext.Provider>
        </QueryClientProvider>,
      );
    });
  }

  async function flush() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function clickButtonText(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(text),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function clickAriaButton(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Icon button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = Reflect.get(descriptor ?? {}, "set") as
      ((this: HTMLElement, value: string) => void) | undefined;
    if (setter === undefined) {
      throw new Error("value setter not found");
    }
    act(() => {
      Reflect.apply(setter, input, [value]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function findSearchInput(): HTMLInputElement {
    const input = container.querySelector('input[placeholder^="Search mail"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Search input not found");
    }
    return input;
  }

  it("renders folders, labels, and thread rows from the backend tools", async () => {
    render();
    await flush();
    for (const folder of ["Inbox", "Starred", "Snoozed", "Drafts", "Archive", "Spam", "Trash"]) {
      expect(container.textContent).toContain(folder);
    }
    expect(container.textContent).toContain("Primary");
    expect(container.textContent).toContain("Promotions");
    expect(container.textContent).toContain("Team");
    expect(container.textContent).toContain("Q3 roadmap sign-off");
    expect(container.textContent).toContain("1–1 of 1");
    expect(
      container.querySelector(".mail-thread-row")?.classList.contains("render-contained-list-item"),
    ).toBe(true);

    const calledTools = fetchMock.mock.calls.map((call) => call[0]);
    expect(calledTools).toContain("/v1/api/tools/mail.folders.list");
    expect(calledTools).toContain("/v1/api/tools/mail.labels.list");
    expect(calledTools).toContain("/v1/api/tools/mail.threads.list");
  });

  it("switches category tabs and re-queries mail.threads.list", async () => {
    render();
    await flush();
    clickButtonText("Updates");
    await flush();
    expect(container.textContent).toContain("PR #4521 was merged");
    expect(container.textContent).not.toContain("Q3 roadmap sign-off");

    const tabCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== "/v1/api/tools/mail.threads.list") {
        return false;
      }
      const body = JSON.parse(
        typeof (call[1] as RequestInit).body === "string"
          ? ((call[1] as RequestInit).body as string)
          : "{}",
      ) as { readonly tab?: string };
      return body.tab === "updates";
    });
    expect(tabCall).toBeDefined();
  });

  it("shows a folder-specific empty state for Drafts", async () => {
    render();
    await flush();
    clickButtonText("Drafts");
    await flush();
    expect(container.textContent).toContain("No drafts");
    expect(container.textContent).toContain("Messages you start writing show up here.");
  });

  it("resumes a saved draft from Drafts in a compose window", async () => {
    const draftId = "11111111-1111-4111-8111-111111111111";
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (
        url.endsWith("/mail.threads.list") &&
        typeof init?.body === "string" &&
        init.body.includes('"drafts"')
      ) {
        return Promise.resolve(
          Response.json({
            threads: [
              threadRow({
                threadId: draftId,
                messageId: draftId,
                subject: "Half-written plan",
                from: "Draft",
                folder: "drafts",
                messageCount: 0,
                unread: false,
              }),
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (url.endsWith("/mail.draft.get")) {
        return Promise.resolve(
          Response.json({
            draft: {
              id: draftId,
              orgId: "o",
              actorId: "a",
              threadId: null,
              to: [],
              cc: [],
              bcc: [],
              subject: "Half-written plan",
              bodyText: "Step one",
              attachments: [],
              revision: 2,
              expiresAt: "2026-12-01T00:00:00.000Z",
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
            },
          }),
        );
      }
      return defaultFetch(input, init);
    });
    render();
    await flush();
    clickButtonText("Drafts");
    await flush();
    const row = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (candidate) => candidate.textContent?.includes("Half-written plan"),
    );
    act(() => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const subject = container.querySelector<HTMLInputElement>('[aria-label="Subject"]');
    expect(subject?.value).toBe("Half-written plan");
    expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain(
      "/v1/api/tools/mail.thread.get",
    );
  });

  it("passes the operator query to the backend and shows a no-results state", async () => {
    render();
    await flush();
    setInputValue(findSearchInput(), "from:nobody");
    await flush();
    expect(container.textContent).toContain('No results for "from:nobody"');

    const queryCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== "/v1/api/tools/mail.threads.list") {
        return false;
      }
      const body = JSON.parse(
        typeof (call[1] as RequestInit).body === "string"
          ? ((call[1] as RequestInit).body as string)
          : "{}",
      ) as { readonly query?: string };
      return body.query === "from:nobody";
    });
    expect(queryCall).toBeDefined();

    clickButtonText("Clear search");
    await flush();
    expect(container.textContent).toContain("Q3 roadmap sign-off");
  });

  it("opens a thread view backed by mail.thread.get", async () => {
    render();
    await flush();
    const row = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (candidate) => candidate.textContent?.includes("Q3 roadmap"),
    );
    if (row === undefined) {
      throw new Error("Thread row not found");
    }
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("Here is the consolidated roadmap for review.");
    expect(container.textContent).not.toContain("Summarize with Helix AI");

    clickButtonText("Reply all");
    await flush();
    expect(container.querySelector('section[aria-label="Reply all"]')).not.toBeNull();

    const calledTools = fetchMock.mock.calls.map((call) => call[0]);
    expect(calledTools).toContain("/v1/api/tools/mail.thread.get");
    expect(calledTools).toContain("/v1/api/tools/mail.read.set");

    clickAriaButton("Back");
    expect(container.textContent).toContain("1–1 of 1");
  });

  it("stars a thread through the mail.star.set tool", async () => {
    render();
    await flush();
    clickAriaButton("Star");
    await flush();
    const starCall = fetchMock.mock.calls.find((call) => call[0] === "/v1/api/tools/mail.star.set");
    expect(starCall).toBeDefined();
    const body = JSON.parse(
      typeof (starCall?.[1] as RequestInit).body === "string"
        ? ((starCall?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly starred: boolean };
    expect(body.starred).toBe(true);
  });

  it("archives the open thread through the mail.archive tool", async () => {
    render();
    await flush();
    const row = Array.from(container.querySelectorAll<HTMLElement>('[role="button"]')).find(
      (candidate) => candidate.textContent?.includes("Q3 roadmap"),
    );
    if (row === undefined) {
      throw new Error("Thread row not found");
    }
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    clickAriaButton("Archive");
    await flush();
    const archiveCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/v1/api/tools/mail.archive",
    );
    expect(archiveCall).toBeDefined();
    expect(container.textContent).toContain("1–1 of 1");
  });

  it("switches folders and pushes the folder into the mail URL search", async () => {
    render();
    await flush();

    clickButtonText("Starred");
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/mail",
        search: expect.objectContaining({ folder: "starred" }),
      }),
    );

    const starredListCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== "/v1/api/tools/mail.threads.list") {
        return false;
      }
      const init = call[1];
      if (init === undefined || typeof init !== "object" || init === null || !("body" in init)) {
        return false;
      }
      const raw = init.body;
      if (typeof raw !== "string") {
        return false;
      }
      const parsed: unknown = JSON.parse(raw);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        "folder" in parsed &&
        Reflect.get(parsed, "folder") === "starred"
      );
    });
    expect(starredListCall).toBeDefined();
    // Sidebar marks the active mailbox for assistive tech / styling.
    const starredButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Starred") === true,
    );
    expect(starredButton?.getAttribute("aria-current")).toBe("page");
  });

  it("renders an empty thread list when mail.threads.list fails", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.endsWith("/mail.threads.list")) {
        return Promise.resolve(Response.json({ error: "mail offline" }, { status: 503 }));
      }
      return defaultFetch(input, init);
    });
    render();
    await flush();
    expect(container.textContent).toContain("Could not load mail. Select Refresh to try again.");
    expect(container.textContent).not.toContain("Q3 roadmap — final sign-off needed by Friday");
  });

  it("row hover Archive button fires mail.archive for that thread", async () => {
    render();
    await flush();
    // The hover action toolbar is in the DOM (opacity:0 via CSS — pointer events
    // are disabled in the browser, but in jsdom we can click directly).
    clickAriaButton("Archive");
    await flush();
    const archiveCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/mail.archive",
    );
    expect(archiveCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(
      typeof (archiveCalls[0]?.[1] as RequestInit).body === "string"
        ? ((archiveCalls[0]?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly threadId: string };
    expect(body.threadId).toBe("thread-1");
  });

  it("row hover Delete button fires mail.delete for that thread", async () => {
    render();
    await flush();
    clickAriaButton("Delete");
    await flush();
    const deleteCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/mail.delete",
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(
      typeof (deleteCalls[0]?.[1] as RequestInit).body === "string"
        ? ((deleteCalls[0]?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly threadId: string };
    expect(body.threadId).toBe("thread-1");
  });

  it("row hover Mark-read button fires mail.read.set to mark the thread read", async () => {
    render();
    await flush();
    // The default threadRow has unread:true, so the button label is "Mark read"
    clickAriaButton("Mark read");
    await flush();
    const readCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/mail.read.set",
    );
    expect(readCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(
      typeof (readCalls[0]?.[1] as RequestInit).body === "string"
        ? ((readCalls[0]?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly threadId: string; readonly unread: boolean };
    expect(body.threadId).toBe("thread-1");
    expect(body.unread).toBe(false);
  });

  it("row hover Snooze button fires mail.snooze for that thread", async () => {
    render();
    await flush();
    clickAriaButton("Snooze");
    await flush();
    const snoozeCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/mail.snooze",
    );
    expect(snoozeCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(
      typeof (snoozeCalls[0]?.[1] as RequestInit).body === "string"
        ? ((snoozeCalls[0]?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly threadId: string };
    expect(body.threadId).toBe("thread-1");
  });

  it.each([
    ["Trash", "Restore", "mail.restore"],
    ["Archive", "Unarchive", "mail.unarchive"],
    ["Snoozed", "Unsnooze", "mail.unsnooze"],
  ])("offers %s mailbox reversal through %s", async (folder, action, tool) => {
    render();
    await flush();
    clickButtonText(folder);
    await flush();
    clickAriaButton(action);
    await flush();
    expect(fetchMock.mock.calls.some((call) => call[0] === `/v1/api/tools/${tool}`)).toBe(true);
  });

  /* ============================================================
     Feature: persistent toolbar — pager always visible
     ============================================================ */

  it("pager is visible in idle state (no rows selected)", async () => {
    render();
    await flush();
    // The pager range should be visible in the toolbar strip
    expect(container.textContent).toContain("1–1 of 1");
    // Newer/Older navigation buttons should be present
    expect(container.querySelector('button[aria-label="Newer"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Older"]')).not.toBeNull();
  });

  it("pager is still visible in active (bulk) state", async () => {
    setupThreeThreads();
    render();
    await flush();

    const masterCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all"]',
    );
    if (masterCheckbox === null) {
      throw new Error("Master checkbox not found");
    }
    act(() => {
      masterCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Selection is active
    expect(container.textContent).toContain("3 selected");

    // Pager must still be present
    expect(container.querySelector('button[aria-label="Newer"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Older"]')).not.toBeNull();
    expect(container.textContent).toContain("1–3 of 3");
  });

  /* ============================================================
     Feature: toolbar Refresh invalidates threads query
     ============================================================ */

  it("Refresh button invalidates the mail.threads.list query", async () => {
    render();
    await flush();

    const callsBefore = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/mail.threads.list",
    ).length;

    clickAriaButton("Refresh");
    await flush();

    const callsAfter = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/mail.threads.list",
    ).length;

    expect(callsAfter).toBeGreaterThan(callsBefore);
  });

  /* ============================================================
     Feature: toolbar "Mark all as read"
     ============================================================ */

  it("Mark all as read calls mail.read.set for every unread thread in view", async () => {
    // Set up 2 unread + 1 read thread
    const rows = [
      threadRow({ threadId: "t1", unread: true }),
      threadRow({ threadId: "t2", subject: "Thread B", unread: true }),
      threadRow({ threadId: "t3", subject: "Thread C", unread: false }),
    ];
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/mail.threads.list")) {
        return Promise.resolve(Response.json({ threads: rows, total: 3, limit: 50, offset: 0 }));
      }
      return defaultFetch(input, init);
    });

    render();
    await flush();

    // Open the "More" dropdown in idle toolbar
    clickAriaButton("More actions");
    await flush();

    // Click "Mark all as read"
    clickButtonText("Mark all as read");
    await flush();

    const readCalls = fetchMock.mock.calls
      .filter((call) => call[0] === "/v1/api/tools/mail.read.set")
      .map((call) => {
        const body = JSON.parse(
          typeof (call[1] as RequestInit).body === "string"
            ? ((call[1] as RequestInit).body as string)
            : "{}",
        ) as { readonly threadId: string; readonly unread: boolean };
        return body;
      });

    // Only unread threads (t1 and t2) should have been marked read
    const markedReadIds = readCalls.filter((c) => c.unread === false).map((c) => c.threadId);
    expect(markedReadIds).toContain("t1");
    expect(markedReadIds).toContain("t2");
    // t3 is already read — should NOT have been called for it via mark-all
    expect(markedReadIds).not.toContain("t3");
  });

  /* ============================================================
     Feature: bulk "Add star"
     ============================================================ */

  it("bulk 'Add star' fires mail.star.set(starred:true) for every selected thread", async () => {
    setupThreeThreads();
    render();
    await flush();

    // Select all three threads
    const masterCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all"]',
    );
    if (masterCheckbox === null) {
      throw new Error("Master checkbox not found");
    }
    act(() => {
      masterCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Open the bulk "More" menu
    clickAriaButton("More bulk actions");
    await flush();

    // Click "Add star"
    clickButtonText("Add star");
    await flush();

    const starCalls = fetchMock.mock.calls
      .filter((call) => call[0] === "/v1/api/tools/mail.star.set")
      .map((call) => {
        const body = JSON.parse(
          typeof (call[1] as RequestInit).body === "string"
            ? ((call[1] as RequestInit).body as string)
            : "{}",
        ) as { readonly threadId: string; readonly starred: boolean };
        return body;
      });

    expect(starCalls.length).toBe(3);
    expect(starCalls.every((c) => c.starred === true)).toBe(true);
    const threadIds = starCalls.map((c) => c.threadId);
    expect(threadIds).toContain("t1");
    expect(threadIds).toContain("t2");
    expect(threadIds).toContain("t3");
  });

  /* ============================================================
     Feature: bulk "Filter messages like these"
     ============================================================ */

  it("'Filter messages like these' calls mail.filter.create with sender from first selected thread", async () => {
    // Use threads where the first one has a known sender
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/mail.threads.list")) {
        return Promise.resolve(
          Response.json({
            threads: [
              threadRow({
                threadId: "t1",
                fromEmail: "mira@helix.io",
                from: "Mira Okafor",
              }),
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        );
      }
      if (url.endsWith("/mail.filter.create")) {
        return Promise.resolve(
          Response.json({
            id: "f1",
            name: "From mira@helix.io",
            enabled: true,
            priority: 100,
            criteria: { fromContains: "mira@helix.io" },
            actions: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        );
      }
      return defaultFetch(input, init);
    });

    render();
    await flush();

    // Select the thread
    const threadCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select Q3 roadmap sign-off"]',
    );
    if (threadCheckbox !== null) {
      act(() => {
        threadCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    } else {
      // Fallback: use master checkbox
      const masterCb = container.querySelector<HTMLInputElement>('input[aria-label="Select all"]');
      if (masterCb === null) throw new Error("Cannot find checkbox");
      act(() => {
        masterCb.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    await flush();

    // Open the bulk "More" menu
    clickAriaButton("More bulk actions");
    await flush();

    // Click "Filter messages like these"
    clickButtonText("Filter messages like these");
    await flush();

    const filterCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/v1/api/tools/mail.filter.create",
    );
    expect(filterCall).toBeDefined();
    const body = JSON.parse(
      typeof (filterCall?.[1] as RequestInit).body === "string"
        ? ((filterCall?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly criteria?: { readonly fromContains?: string }; readonly actions?: unknown };
    expect(body.criteria?.fromContains).toBe("mira@helix.io");
    // The server rejects action-less filters; the default action is named to the user.
    expect(body.actions).toEqual({ archive: true });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "New mail from mira@helix.io will skip the inbox and go to Archive.",
    );
  });

  /* ============================================================
     Feature: bulk-select toolbar — applies to all selected threads
     ============================================================ */

  /**
   * Helper: set up a multi-thread inbox so we can select >1 row.
   * Returns a fetchMock override that serves 3 threads.
   */
  function setupThreeThreads() {
    const rows = [
      threadRow({ threadId: "t1", subject: "Thread A", unread: true, starred: true }),
      threadRow({ threadId: "t2", subject: "Thread B", unread: false, starred: false }),
      threadRow({ threadId: "t3", subject: "Thread C", unread: true, starred: false }),
    ];
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/mail.threads.list")) {
        return Promise.resolve(Response.json({ threads: rows, total: 3, limit: 50, offset: 0 }));
      }
      return defaultFetch(input, init);
    });
    return rows;
  }

  it("bulk Archive applies mail.archive to every checked thread then clears selection", async () => {
    setupThreeThreads();
    render();
    await flush();

    // Check all three rows via the master checkbox (Select all).
    const masterCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all"]',
    );
    if (masterCheckbox === null) {
      throw new Error("Master checkbox not found");
    }
    act(() => {
      masterCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // The bulk toolbar should now be visible.
    expect(container.textContent).toContain("3 selected");

    // Click "Archive" in the bulk toolbar.
    clickAriaButton("Archive selected");
    await flush();

    // mail.archive must have been called once for each of the 3 threads.
    const archiveCalls = fetchMock.mock.calls
      .filter((call) => call[0] === "/v1/api/tools/mail.archive")
      .map((call) => {
        const body = JSON.parse(
          typeof (call[1] as RequestInit).body === "string"
            ? ((call[1] as RequestInit).body as string)
            : "{}",
        ) as { readonly threadId: string };
        return body.threadId;
      });

    expect(archiveCalls).toContain("t1");
    expect(archiveCalls).toContain("t2");
    expect(archiveCalls).toContain("t3");

    // After the action, the bulk toolbar should no longer show "selected".
    expect(container.textContent).not.toContain("selected");
  });

  it("bulk Report spam applies mail.spam to every checked thread", async () => {
    setupThreeThreads();
    render();
    await flush();

    // Select only t1 and t2 by clicking their individual checkboxes.
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((cb) => cb.ariaLabel?.startsWith("Select ") && cb.ariaLabel !== "Select all");

    // Click first two thread checkboxes.
    act(() => {
      checkboxes[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      checkboxes[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    clickAriaButton("Report spam");
    await flush();

    const spamCalls = fetchMock.mock.calls
      .filter((call) => call[0] === "/v1/api/tools/mail.spam")
      .map((call) => {
        const body = JSON.parse(
          typeof (call[1] as RequestInit).body === "string"
            ? ((call[1] as RequestInit).body as string)
            : "{}",
        ) as { readonly threadId: string };
        return body.threadId;
      });

    expect(spamCalls).toHaveLength(2);
  });

  it("bulk Delete applies mail.delete to every checked thread", async () => {
    setupThreeThreads();
    render();
    await flush();

    const masterCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select all"]',
    );
    if (masterCheckbox === null) {
      throw new Error("Master checkbox not found");
    }
    act(() => {
      masterCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    clickAriaButton("Delete selected");
    await flush();

    const deleteCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/api/tools/mail.delete",
    );
    expect(deleteCalls).toHaveLength(3);
  });

  /* ============================================================
     Feature: select-all dropdown subsets
     ============================================================ */

  it("select-all dropdown 'Read' selects only read (non-unread) threads", async () => {
    // Provide 3 threads: t1 unread, t2 read, t3 unread.
    setupThreeThreads();
    render();
    await flush();

    // Open the caret dropdown.
    clickAriaButton("Select subset");

    // Click "Read".
    clickButtonText("Read");
    await flush();

    // The bulk toolbar should show "1 selected" (only t2 is read).
    expect(container.textContent).toContain("1 selected");
  });

  it("select-all dropdown 'Unread' selects only unread threads", async () => {
    setupThreeThreads();
    render();
    await flush();

    clickAriaButton("Select subset");
    clickButtonText("Unread");
    await flush();

    // t1 and t3 are unread.
    expect(container.textContent).toContain("2 selected");
  });

  it("select-all dropdown 'Starred' selects only starred threads", async () => {
    setupThreeThreads();
    render();
    await flush();

    clickAriaButton("Select subset");

    // Click the "Starred" item inside the dropdown (not the sidebar folder button).
    const dropdownItems = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".mail-select-dropdown-item"),
    );
    const starredItem = dropdownItems.find((btn) => btn.textContent?.trim() === "Starred");
    if (starredItem === undefined) {
      throw new Error("Starred dropdown item not found");
    }
    act(() => {
      starredItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Only t1 is starred.
    expect(container.textContent).toContain("1 selected");
  });

  it("select-all dropdown 'Unstarred' selects only un-starred threads", async () => {
    setupThreeThreads();
    render();
    await flush();

    clickAriaButton("Select subset");
    clickButtonText("Unstarred");
    await flush();

    // t2 and t3 are not starred.
    expect(container.textContent).toContain("2 selected");
  });

  it("select-all dropdown 'All' checks every visible thread", async () => {
    setupThreeThreads();
    render();
    await flush();

    clickAriaButton("Select subset");
    clickButtonText("All");
    await flush();

    expect(container.textContent).toContain("3 selected");
  });

  it("select-all dropdown 'None' clears selection when threads are checked", async () => {
    setupThreeThreads();
    render();
    await flush();

    // Use the "All" option while no threads are selected (caret is visible in
    // the normal toolbar, before bulk kicks in).
    clickAriaButton("Select subset");
    const allItem = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".mail-select-dropdown-item"),
    ).find((btn) => btn.textContent?.trim() === "All");
    if (allItem === undefined) {
      throw new Error("'All' dropdown item not found");
    }
    act(() => {
      allItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("3 selected");

    // The bulk toolbar now shows a "Deselect all" checkbox — clicking it clears
    // the selection.  The caret dropdown is part of the normal toolbar which
    // is replaced by the bulk toolbar while rows are selected.
    const deselectCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="Deselect all"]',
    );
    if (deselectCheckbox === null) {
      throw new Error("Deselect all checkbox not found");
    }
    act(() => {
      deselectCheckbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Selection cleared — bulk toolbar gone.
    expect(container.textContent).not.toContain("selected");
  });

  /* ============================================================
     Feature: shift-click range select
     ============================================================ */

  it("shift-clicking a row checkbox selects the contiguous range from the last click", async () => {
    setupThreeThreads();
    render();
    await flush();

    // Get the three individual row checkboxes (not the master "Select all" one).
    const rowCheckboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((cb) => cb.ariaLabel?.startsWith("Select ") && cb.ariaLabel !== "Select all");

    expect(rowCheckboxes).toHaveLength(3);

    // Click first checkbox normally.
    act(() => {
      rowCheckboxes[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("1 selected");

    // Shift-click the third checkbox — should select rows 0, 1, and 2.
    act(() => {
      rowCheckboxes[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    await flush();

    expect(container.textContent).toContain("3 selected");
  });

  it("shift-clicking in the middle of an already-selected range extends to that row", async () => {
    setupThreeThreads();
    render();
    await flush();

    const rowCheckboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).filter((cb) => cb.ariaLabel?.startsWith("Select ") && cb.ariaLabel !== "Select all");

    // Click row 0 first.
    act(() => {
      rowCheckboxes[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Shift-click row 1 — extends range to rows 0 and 1.
    act(() => {
      rowCheckboxes[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    });
    await flush();

    expect(container.textContent).toContain("2 selected");
  });
});
