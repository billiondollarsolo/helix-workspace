// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellOverlayContext } from "@/components/shell";
import { MailShell } from "./mail-shell";

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({ emptyFallback }: { readonly emptyFallback?: React.ReactNode }) =>
    emptyFallback ?? null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const overlayApi = {
  openNotifications: vi.fn(),
  openPalette: vi.fn(),
  openSettings: vi.fn(),
};

/* ---------------------------------------------------------- backend fixtures */

const FOLDERS = [
  { id: "inbox", label: "Inbox", total: 12, unread: 3 },
  { id: "starred", label: "Starred", total: 2, unread: 0 },
  { id: "snoozed", label: "Snoozed", total: 0, unread: 0 },
  { id: "sent", label: "Sent", total: 0, unread: 0 },
  { id: "drafts", label: "Drafts", total: 0, unread: 0 },
  { id: "archive", label: "Archive", total: 0, unread: 0 },
  { id: "trash", label: "Trash", total: 0, unread: 0 },
];

const LABELS = [
  {
    id: "l1",
    slug: "team",
    name: "Team",
    color: "#7c3aed",
    sortOrder: 0,
    threadCount: 4,
    shared: true,
  },
];

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    messageId: "message-1",
    subject: "Q3 roadmap sign-off",
    from: "Mira Okafor",
    fromEmail: "mira@helix.io",
    preview: "Final roadmap attached",
    time: "2026-05-21T10:42:00.000Z",
    unread: true,
    starred: false,
    hasAttachment: true,
    messageCount: 1,
    labels: ["team"],
    category: "primary",
    folder: "inbox",
    snoozedUntil: null,
    ...overrides,
  };
}

const UPDATES_ROW = threadRow({
  threadId: "thread-2",
  messageId: "message-2",
  subject: "PR #4521 was merged",
  from: "GitHub",
  fromEmail: "noreply@github.com",
  category: "updates",
  labels: [],
});

const THREAD_DETAIL = {
  id: "thread-1",
  subject: "Q3 roadmap sign-off",
  preview: "Final roadmap attached",
  participants: [{ address: "mira@helix.io", name: "Mira Okafor" }],
  messages: [
    {
      id: "message-1",
      from: { address: "mira@helix.io", name: "Mira Okafor" },
      to: [{ address: "alex@helix.io", name: "Alex" }],
      cc: [],
      bcc: [],
      sentAt: "2026-05-21T10:42:00.000Z",
      body: "Here is the consolidated roadmap for review.",
      bodyFormat: "plain",
      hasAttachment: true,
    },
  ],
  labels: ["team"],
  archivedAt: null,
  deletedAt: null,
  snoozedUntil: null,
  lastActivity: "2026-05-21T10:42:00.000Z",
  unread: true,
  starred: false,
  direction: "inbound",
};

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
    if (url.endsWith("/mail.folders.list")) {
      return Promise.resolve(Response.json({ folders: FOLDERS }));
    }
    if (url.endsWith("/mail.labels.list")) {
      return Promise.resolve(Response.json({ labels: LABELS }));
    }
    if (url.endsWith("/mail.threads.list")) {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as { readonly folder?: string; readonly tab?: string; readonly query?: string };
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
    return Promise.resolve(Response.json({ id: "m1", status: "sent" }));
  }

  beforeEach(() => {
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
      root.unmount();
    });
    container.remove();
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
      | ((this: HTMLElement, value: string) => void)
      | undefined;
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
    for (const folder of ["Inbox", "Starred", "Snoozed", "Drafts", "Archive", "Trash"]) {
      expect(container.textContent).toContain(folder);
    }
    expect(container.textContent).toContain("Primary");
    expect(container.textContent).toContain("Promotions");
    expect(container.textContent).toContain("Team");
    expect(container.textContent).toContain("Q3 roadmap sign-off");
    expect(container.textContent).toContain("1–1 of 1");

    const calledTools = fetchMock.mock.calls.map((call) => call[0]);
    expect(calledTools).toContain("/api/tools/mail.folders.list");
    expect(calledTools).toContain("/api/tools/mail.labels.list");
    expect(calledTools).toContain("/api/tools/mail.threads.list");
  });

  it("switches category tabs and re-queries mail.threads.list", async () => {
    render();
    await flush();
    clickButtonText("Updates");
    await flush();
    expect(container.textContent).toContain("PR #4521 was merged");
    expect(container.textContent).not.toContain("Q3 roadmap sign-off");

    const tabCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== "/api/tools/mail.threads.list") {
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

  it("passes the operator query to the backend and shows a no-results state", async () => {
    render();
    await flush();
    setInputValue(findSearchInput(), "from:nobody");
    await flush();
    expect(container.textContent).toContain('No results for "from:nobody"');

    const queryCall = fetchMock.mock.calls.find((call) => {
      if (call[0] !== "/api/tools/mail.threads.list") {
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
    expect(container.textContent).toContain("Summarize with Helix AI");

    clickButtonText("Reply all");
    expect(container.textContent).toContain("Replying all");

    const calledTools = fetchMock.mock.calls.map((call) => call[0]);
    expect(calledTools).toContain("/api/tools/mail.thread.get");
    expect(calledTools).toContain("/api/tools/mail.read.set");

    clickAriaButton("Back");
    expect(container.textContent).toContain("1–1 of 1");
  });

  it("stars a thread through the mail.star.set tool", async () => {
    render();
    await flush();
    clickAriaButton("Star");
    await flush();
    const starCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/mail.star.set",
    );
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
      (call) => call[0] === "/api/tools/mail.archive",
    );
    expect(archiveCall).toBeDefined();
    expect(container.textContent).toContain("1–1 of 1");
  });

  it("opens the compose modal and sends through the mail.send backend tool", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    expect(container.textContent).toContain("New message");

    const sendButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Send",
    );
    expect(sendButton?.disabled).toBe(true);

    const toInput = container.querySelector('input[aria-label="To"]');
    if (!(toInput instanceof HTMLInputElement)) {
      throw new Error("To input not found");
    }
    setInputValue(toInput, "mira@helix.io");

    clickButtonText("Cc");
    const ccInput = container.querySelector('input[aria-label="Cc"]');
    if (ccInput instanceof HTMLInputElement) {
      setInputValue(ccInput, "ops@helix.io");
    }

    const subjectInput = container.querySelector('input[aria-label="Subject"]');
    if (subjectInput instanceof HTMLInputElement) {
      setInputValue(subjectInput, "Hello");
    }

    clickButtonText("Send");
    await flush();

    const sendCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/mail.send",
    );
    expect(sendCall).toBeDefined();
    const rawBody = (sendCall?.[1] as RequestInit).body;
    const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      readonly to: ReadonlyArray<{ readonly address: string }>;
      readonly cc: ReadonlyArray<{ readonly address: string }>;
      readonly subject: string;
    };
    expect(body.to).toEqual([{ address: "mira@helix.io" }]);
    expect(body.cc).toEqual([{ address: "ops@helix.io" }]);
    expect(body.subject).toBe("Hello");
    expect(container.textContent).not.toContain("New message");
  });

  it("falls back to offline seed data when mail.threads.list fails", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.endsWith("/mail.threads.list")) {
        return Promise.resolve(Response.json({ error: "mail offline" }, { status: 503 }));
      }
      return defaultFetch(input, init);
    });
    render();
    await flush();
    expect(container.textContent).toContain("offline data");
    expect(container.textContent).toContain("Q3 roadmap — final sign-off needed by Friday");
  });

  /* ----------------------------------------------------------------- compose: drag-and-drop */

  /**
   * Helper: build a minimal drag event that jsdom accepts.
   * jsdom does not expose `DragEvent` as a global, so we use
   * `document.createEvent("Event")` and annotate it manually.
   * We only stub the subset the Compose handler reads (`files`, `dropEffect`).
   */
  function makeDragEvent(
    type: string,
    files: File[],
    target: Element,
  ): Event {
    const dataTransfer = {
      files: Object.assign([...files], {
        item: (index: number) => files[index] ?? null,
        length: files.length,
      }),
      dropEffect: "none" as string,
      effectAllowed: "all" as string,
      items: { length: files.length },
      types: [] as string[],
      clearData: () => undefined,
      getData: () => "",
      setData: () => undefined,
      setDragImage: () => undefined,
    };

    const event = document.createEvent("Event");
    event.initEvent(type, /* bubbles */ true, /* cancelable */ true);
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer, writable: false });
    Object.defineProperty(event, "target", { value: target, writable: false });
    return event;
  }

  /** Resolves all pending microtasks / timers (including FileReader callbacks). */
  async function flushMicrotasks() {
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  it("shows the drop overlay when files are dragged over the open Compose modal", async () => {
    render();
    await flush();
    clickButtonText("Compose");
    expect(container.textContent).toContain("New message");

    const compose = container.querySelector(".compose-drop-root");
    if (!(compose instanceof HTMLElement)) {
      throw new Error("Compose root not found");
    }

    // Overlay should not be visible before dragging.
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [new File(["hi"], "hello.txt")], compose));
    });
    expect(container.querySelector(".compose-drop-overlay")).not.toBeNull();
    expect(container.textContent).toContain("Drop files to attach");

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragleave", [], compose));
    });
    // Counter reaches 0 — overlay dismissed.
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();
  });

  it("attaches dropped files through the same sendMail mechanism", async () => {
    // Stub FileReader so it delivers base64 synchronously in the test env.
    const fileContent = "hello attachment";
    const fileBase64 = btoa(fileContent);
    const fileReaderMock = {
      readAsDataURL: vi.fn(function (this: typeof fileReaderMock) {
        this.result = `data:text/plain;base64,${fileBase64}`;
        if (typeof this.onload === "function") {
          this.onload();
        }
      }),
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      result: null as string | null,
    };
    vi.stubGlobal(
      "FileReader",
      vi.fn(() => fileReaderMock),
    );

    render();
    await flush();
    clickButtonText("Compose");

    const compose = container.querySelector(".compose-drop-root");
    if (!(compose instanceof HTMLElement)) {
      throw new Error("Compose root not found");
    }

    const droppedFile = new File([fileContent], "report.pdf", {
      type: "application/pdf",
    });

    // Simulate drop sequence: dragenter → dragover → drop
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [droppedFile], compose));
    });
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragover", [droppedFile], compose));
    });
    act(() => {
      compose.dispatchEvent(makeDragEvent("drop", [droppedFile], compose));
    });

    // Wait for the async FileReader → state update chain.
    await flushMicrotasks();

    // Attachment chip should appear.
    expect(container.textContent).toContain("report.pdf");

    // Overlay should be gone after drop.
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();

    // Now send the message; the attachment must be included in the API call.
    const toInput = container.querySelector('input[aria-label="To"]');
    if (!(toInput instanceof HTMLInputElement)) {
      throw new Error("To input not found");
    }
    setInputValue(toInput, "mira@helix.io");
    clickButtonText("Send");
    await flush();

    const sendCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/mail.send",
    );
    expect(sendCall).toBeDefined();
    const rawBody = (sendCall?.[1] as RequestInit).body;
    const parsedBody = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as {
      readonly attachments?: ReadonlyArray<{
        readonly filename: string;
        readonly contentType: string;
        readonly content: string;
      }>;
    };
    expect(parsedBody.attachments).toBeDefined();
    expect(parsedBody.attachments).toHaveLength(1);
    expect(parsedBody.attachments?.[0]?.filename).toBe("report.pdf");
    expect(parsedBody.attachments?.[0]?.contentType).toBe("application/pdf");
    expect(parsedBody.attachments?.[0]?.content).toBe(fileBase64);

    vi.unstubAllGlobals();
  });

  it("does not flicker the drop overlay when the cursor crosses child elements", async () => {
    render();
    await flush();
    clickButtonText("Compose");

    const compose = container.querySelector(".compose-drop-root");
    if (!(compose instanceof HTMLElement)) {
      throw new Error("Compose root not found");
    }

    const file = new File(["x"], "x.txt");

    // Simulate cursor entering the compose root, then entering a child (fires
    // another dragenter + dragleave on the parent per bubbling semantics).
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [file], compose)); // depth → 1
    });
    expect(container.querySelector(".compose-drop-overlay")).not.toBeNull();

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragenter", [file], compose)); // depth → 2
    });
    act(() => {
      compose.dispatchEvent(makeDragEvent("dragleave", [file], compose)); // depth → 1
    });
    // Depth is 1, so the overlay must still be visible.
    expect(container.querySelector(".compose-drop-overlay")).not.toBeNull();

    act(() => {
      compose.dispatchEvent(makeDragEvent("dragleave", [file], compose)); // depth → 0
    });
    expect(container.querySelector(".compose-drop-overlay")).toBeNull();
  });

  /* ============================================================
     Feature: per-row hover actions
     ============================================================ */

  it("row hover Archive button fires mail.archive for that thread", async () => {
    render();
    await flush();
    // The hover action toolbar is in the DOM (opacity:0 via CSS — pointer events
    // are disabled in the browser, but in jsdom we can click directly).
    clickAriaButton("Archive");
    await flush();
    const archiveCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/api/tools/mail.archive",
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
      (call) => call[0] === "/api/tools/mail.delete",
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
      (call) => call[0] === "/api/tools/mail.read.set",
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
      (call) => call[0] === "/api/tools/mail.snooze",
    );
    expect(snoozeCalls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(
      typeof (snoozeCalls[0]?.[1] as RequestInit).body === "string"
        ? ((snoozeCalls[0]?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly threadId: string };
    expect(body.threadId).toBe("thread-1");
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
      (call) => call[0] === "/api/tools/mail.threads.list",
    ).length;

    clickAriaButton("Refresh");
    await flush();

    const callsAfter = fetchMock.mock.calls.filter(
      (call) => call[0] === "/api/tools/mail.threads.list",
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
      const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
      if (url.endsWith("/mail.threads.list")) {
        return Promise.resolve(
          Response.json({ threads: rows, total: 3, limit: 50, offset: 0 }),
        );
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
      .filter((call) => call[0] === "/api/tools/mail.read.set")
      .map((call) => {
        const body = JSON.parse(
          typeof (call[1] as RequestInit).body === "string"
            ? ((call[1] as RequestInit).body as string)
            : "{}",
        ) as { readonly threadId: string; readonly unread: boolean };
        return body;
      });

    // Only unread threads (t1 and t2) should have been marked read
    const markedReadIds = readCalls
      .filter((c) => c.unread === false)
      .map((c) => c.threadId);
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
      .filter((call) => call[0] === "/api/tools/mail.star.set")
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
      const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
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
      (call) => call[0] === "/api/tools/mail.filter.create",
    );
    expect(filterCall).toBeDefined();
    const body = JSON.parse(
      typeof (filterCall?.[1] as RequestInit).body === "string"
        ? ((filterCall?.[1] as RequestInit).body as string)
        : "{}",
    ) as { readonly criteria?: { readonly fromContains?: string } };
    expect(body.criteria?.fromContains).toBe("mira@helix.io");
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
      const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
      if (url.endsWith("/mail.threads.list")) {
        return Promise.resolve(
          Response.json({ threads: rows, total: 3, limit: 50, offset: 0 }),
        );
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
      .filter((call) => call[0] === "/api/tools/mail.archive")
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
      .filter((call) => call[0] === "/api/tools/mail.spam")
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
      (call) => call[0] === "/api/tools/mail.delete",
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
      rowCheckboxes[2]?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true }),
      );
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
      rowCheckboxes[1]?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true }),
      );
    });
    await flush();

    expect(container.textContent).toContain("2 selected");
  });
});
