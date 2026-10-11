// @vitest-environment jsdom

import { ShellOverlayContext } from "@/components/shell";
import { shortcutRegistry } from "@/lib/shortcuts/registry";
import { shellOverlaysForTest } from "@/test/shell-overlays";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailShell } from "./mail-shell";
import { FOLDERS, LABELS, THREAD_DETAIL, threadRow, UPDATES_ROW } from "./mail-shell.test-fixtures";
import { MAIL_DRAG_TYPE } from "./mail-thread-row";

const navigateMock = vi.fn();
const notifyMock = vi.fn<(options: unknown) => string>(() => "toast-id");
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
  useRouter: () => ({ navigate: navigateMock }),
  useSearch: () => ({}),
  useBlocker: () => ({ status: "idle" }),
}));
vi.mock("@/components/ui/toast", () => ({
  notify: (options: unknown) => notifyMock(options),
  dismissNotification: vi.fn(),
}));
vi.mock("@helix/sdk-web", () => ({ SuggestionSlot: () => null }));
const dialogs = vi.hoisted(() => ({
  filter: vi.fn(),
  label: vi.fn(),
  removeLabel: vi.fn(),
}));
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  openFilterDialog: dialogs.filter,
  openLabelDialog: dialogs.label,
  openRemoveLabelDialog: dialogs.removeLabel,
}));
const overlays = shellOverlaysForTest();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface NotifyOptions {
  readonly message: string;
  readonly tone?: string;
  readonly action?: { readonly label: string; readonly onAction: () => void };
}

type ToolBody = Record<string, unknown>;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let threadsResponse: (body: ToolBody) => unknown;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function toolCalls(tool: string): ToolBody[] {
  return fetchMock.mock.calls
    .filter((call) => urlOf(call[0]).endsWith(`/tools/${tool}`))
    .map((call) => JSON.parse(typeof call[1]?.body === "string" ? call[1].body : "{}") as ToolBody);
}

function respond(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = urlOf(input);
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as ToolBody;
  if (url.endsWith("/auth/csrf-token")) return Promise.resolve(Response.json({ csrfToken: "t" }));
  if (url.endsWith("/mail.folders.list"))
    return Promise.resolve(Response.json({ folders: FOLDERS }));
  if (url.endsWith("/mail.labels.list")) return Promise.resolve(Response.json({ labels: LABELS }));
  if (url.endsWith("/mail.threads.list"))
    return Promise.resolve(Response.json(threadsResponse(body)));
  if (url.endsWith("/mail.thread.get"))
    return Promise.resolve(Response.json({ thread: THREAD_DETAIL }));
  if (url.endsWith("/account.preferences.get")) {
    return Promise.resolve(
      Response.json({
        workingHours: null,
        mail: { readingPane: "none", density: "default", conversationView: true },
      }),
    );
  }
  if (url.endsWith("/account.preferences.set")) {
    return Promise.resolve(
      Response.json({ workingHours: null, mail: { readingPane: "right", density: "default" } }),
    );
  }
  return Promise.resolve(Response.json({ ok: true }));
}

const defaultThreads = (body: ToolBody) => {
  if (body.folder === "sent" || body.query === "from:nobody") {
    return { threads: [], total: 0, limit: 50, offset: 0 };
  }
  if (body.tab === "updates") return { threads: [UPDATES_ROW], total: 1, limit: 50, offset: 0 };
  return {
    threads: [
      threadRow({
        messageCount: 3,
        participants: [
          { name: "Mira Okafor", email: "mira@helix.io", isMe: false },
          { name: "me", email: "alex@helix.io", isMe: true },
        ],
      }),
      threadRow({
        threadId: "thread-3",
        messageId: "message-3",
        subject: "Lunch on Friday",
        unread: false,
        labels: [],
        hasAttachment: false,
      }),
    ],
    total: 2,
    limit: 50,
    offset: 0,
  };
};

async function flush(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

function render() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ShellOverlayContext.Provider value={overlays}>
          <MailShell />
        </ShellOverlayContext.Provider>
      </QueryClientProvider>,
    );
  });
}

function all<T extends Element = HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector));
}

function button(name: string, scope: ParentNode = document): HTMLElement {
  const found = Array.from(scope.querySelectorAll<HTMLElement>("button, [role^='menuitem']")).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`Button not found: ${name}`);
  return found;
}

function click(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function openMenu(trigger: HTMLElement) {
  trigger.focus();
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await flush(5);
}

function rowFor(subject: string): HTMLElement {
  const row = all('[role="row"]').find((candidate) => candidate.textContent?.includes(subject));
  if (row === undefined) throw new Error(`Row not found: ${subject}`);
  return row;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function lastNotify(): NotifyOptions {
  return notifyMock.mock.calls.at(-1)?.[0] as NotifyOptions;
}

const dispatchShortcut = (event: KeyboardEvent) => {
  shortcutRegistry.handleKeyDown(event, { enabled: true, overlayOpen: false, isMac: false });
};

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockClear();
  notifyMock.mockClear();
  window.localStorage.clear();
  threadsResponse = defaultThreads;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  fetchMock = vi.fn<typeof fetch>(respond);
  vi.stubGlobal("fetch", fetchMock);
  window.addEventListener("keydown", dispatchShortcut);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  window.removeEventListener("keydown", dispatchShortcut);
  vi.unstubAllGlobals();
});

describe("mail sidebar", () => {
  it("lists folders in order with More, unread and draft counts, and nested labels", async () => {
    render();
    await flush();
    const folders = all("nav[aria-label='Folders'] .label").map((node) => node.textContent);
    expect(folders).toEqual(["Inbox", "Starred", "Snoozed", "Sent", "Drafts", "Scheduled", "More"]);
    const inbox = button("Inbox3 unread");
    expect(inbox.getAttribute("aria-current")).toBe("page");
    expect(button("Starred").querySelector(".count")).toBeNull();

    click(button("More"));
    const more = all("nav[aria-label='Folders'] .label").map((node) => node.textContent);
    expect(more).toEqual(
      expect.arrayContaining(["All Mail", "Archive", "Spam", "Trash", "Promotions", "Less"]),
    );
    const team = all("nav[aria-label='Labels'] .surf-nav-row")[0];
    expect(team?.textContent).toContain("Team");
    expect(team?.querySelector(".count")?.textContent).toContain("2");
    expect(container.textContent).not.toContain("has:attachment");
  });

  it("opens label edit, removal and sublabel dialogs from the label menu", async () => {
    render();
    await flush();
    for (const [name, check] of [
      [
        "Edit",
        () => expect(dialogs.label).toHaveBeenLastCalledWith({ mode: "edit", labelId: "l1" }),
      ],
      ["Remove label", () => expect(dialogs.removeLabel).toHaveBeenLastCalledWith("l1")],
      [
        "Add sublabel",
        () => expect(dialogs.label).toHaveBeenLastCalledWith({ mode: "create", parentId: "l1" }),
      ],
    ] as const) {
      await openMenu(button("Options for Team"));
      const item = all('[role="menuitem"]').find((node) => node.textContent?.includes(name));
      if (item === undefined) throw new Error(`${name} missing`);
      click(item);
      check();
    }
  });

  it("labels conversations dropped on a label", async () => {
    render();
    await flush();
    const label = all("nav[aria-label='Labels'] .surf-nav-row")[0];
    if (label === undefined) throw new Error("label row missing");
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: [MAIL_DRAG_TYPE], getData: () => JSON.stringify(["thread-3"]) },
    });
    act(() => {
      label.dispatchEvent(drop);
    });
    await flush();
    expect(toolCalls("mail.label.apply")).toContainEqual({
      threadId: "thread-3",
      add: ["team"],
      remove: [],
    });
  });
});

describe("conversation list", () => {
  it("renders participant rows on a grid with Inbox-only category tabs", async () => {
    render();
    await flush();
    expect(document.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe(
      "Conversations",
    );
    const row = rowFor("Q3 roadmap");
    expect(row.textContent).toContain("Mira, me (3)");
    expect(row.querySelector("[data-unread]")).not.toBeNull();
    expect(row.classList.contains("render-contained-list-item")).toBe(true);
    expect(container.textContent).toContain("1–2 of 2");

    click(button("Updates"));
    await flush();
    expect(toolCalls("mail.threads.list").some((body) => body.tab === "updates")).toBe(true);
    expect(container.textContent).toContain("PR #4521 was merged");

    click(button("Sent"));
    await flush();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(container.textContent).toContain("No conversations in Sent");
    expect(document.querySelector('[data-slot="pager"]')).toBeNull();
  });

  it("searches All Mail with operators and shows Search results", async () => {
    render();
    await flush();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search mail"]');
    if (input === null) throw new Error("search box missing");
    typeInto(input, "from:mira has:attachment");
    await wait(400);
    expect(toolCalls("mail.threads.list")).toContainEqual(
      expect.objectContaining({ folder: "all", query: "from:mira has:attachment" }),
    );
    expect(container.querySelector(".mail-list-heading")?.textContent).toBe("Search results");
    expect(document.querySelector('[role="tablist"]')).toBeNull();

    typeInto(input, "from:nobody");
    await wait(400);
    expect(container.textContent).toContain("No messages matched your search");
  });

  it("builds a query from the search options form", async () => {
    render();
    await flush();
    click(button("Show search options"));
    await flush(5);
    const form = document.querySelector("form.mail-search-form");
    if (form === null) throw new Error("form missing");
    const from = form.querySelector<HTMLInputElement>("input");
    if (from === null) throw new Error("from missing");
    typeInto(from, "Samara Malik");
    const attachment = Array.from(
      form.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    )[0];
    if (attachment === undefined) throw new Error("checkbox missing");
    click(attachment);
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(toolCalls("mail.threads.list")).toContainEqual(
      expect.objectContaining({ folder: "all", query: 'from:"Samara Malik" has:attachment' }),
    );
  });

  it("shows skeleton rows while loading and Retry when the list fails", async () => {
    let fail = true;
    fetchMock.mockImplementation((input, init) =>
      urlOf(input).endsWith("/mail.threads.list") && fail
        ? Promise.resolve(Response.json({ error: "mail offline" }, { status: 503 }))
        : respond(input, init),
    );
    render();
    expect(
      document.querySelector('[role="status"][aria-label="Loading conversations"]'),
    ).not.toBeNull();
    await flush();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load your mail");
    fail = false;
    click(button("Retry"));
    await flush();
    expect(container.textContent).toContain("Q3 roadmap sign-off");
  });

  it("selects every matching conversation from the banner and acts on all of them", async () => {
    threadsResponse = (body) => {
      const base = defaultThreads(body) as { threads: unknown[] };
      if (body.limit === 200) {
        return {
          threads: [...base.threads, threadRow({ threadId: "thread-9", messageId: "m9" })],
          total: 3,
          limit: 200,
          offset: 0,
        };
      }
      return { ...base, total: 120 };
    };
    render();
    await flush();
    const selectAll = container.querySelector(
      'input[aria-label="Select all conversations on this page"]',
    );
    if (selectAll === null) throw new Error("select all missing");
    click(selectAll);
    await flush(5);
    expect(container.textContent).toContain("All 2 conversations on this page are selected.");
    click(button("Select all 120 conversations in Inbox"));
    await flush(5);
    expect(container.textContent).toContain("All 120 conversations in Inbox are selected.");
    click(button("Archive", container.querySelector('[role="toolbar"]') ?? document));
    await flush();
    expect(toolCalls("mail.archive").map((body) => body.threadId)).toEqual([
      "thread-1",
      "thread-3",
      "thread-9",
    ]);
    expect(lastNotify().message).toBe("3 conversations archived");
  });

  it("selects read and starred subsets from the select menu", async () => {
    render();
    await flush();
    await openMenu(button("Select"));
    click(button("Read"));
    await flush(5);
    expect(rowFor("Lunch on Friday").getAttribute("aria-selected")).toBe("true");
    expect(rowFor("Q3 roadmap").getAttribute("aria-selected")).toBe("false");
  });
});

describe("actions with undo", () => {
  it("archives at once from the row and undoes from the snackbar", async () => {
    const archived = new Set<string>();
    fetchMock.mockImplementation((input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as ToolBody;
      if (urlOf(input).endsWith("/mail.archive")) archived.add(String(body.threadId));
      if (urlOf(input).endsWith("/mail.unarchive")) archived.delete(String(body.threadId));
      return respond(input, init);
    });
    threadsResponse = (body) => {
      const list = defaultThreads(body) as { threads: { threadId: string }[] };
      return { ...list, threads: list.threads.filter((row) => !archived.has(row.threadId)) };
    };
    render();
    await flush();
    click(button("Archive", rowFor("Q3 roadmap")));
    await flush();
    expect(container.textContent).not.toContain("Q3 roadmap sign-off");
    expect(toolCalls("mail.archive")).toEqual([{ threadId: "thread-1" }]);
    const toast = lastNotify();
    expect(toast.message).toBe("Conversation archived");
    expect(toast.action?.label).toBe("Undo");
    act(() => toast.action?.onAction());
    await flush();
    expect(toolCalls("mail.unarchive")).toEqual([{ threadId: "thread-1" }]);
    expect(container.textContent).toContain("Q3 roadmap sign-off");
  });

  it("undoes the last action with z", async () => {
    render();
    await flush();
    click(button("Mark as unread", rowFor("Lunch on Friday")));
    await flush();
    expect(toolCalls("mail.read.set")).toContainEqual({ threadId: "thread-3", unread: true });
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
    });
    await flush();
    expect(toolCalls("mail.read.set").at(-1)).toEqual({ threadId: "thread-3", unread: false });
    expect(lastNotify().message).toBe("Action undone");
  });

  it("snoozes from the picker", async () => {
    render();
    await flush();
    click(button("Snooze", rowFor("Q3 roadmap")));
    await flush(5);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    click(button("Pick date & time", dialog ?? document));
    await flush(5);
    expect(document.querySelector('[aria-label="Snooze until"][role="group"]')).not.toBeNull();
    click(button("Cancel"));
    await flush(5);
    const option = all(".mail-snooze-option")[0];
    if (option === undefined) throw new Error("no snooze option");
    click(option);
    await flush();
    const [call] = toolCalls("mail.snooze");
    expect(call?.threadId).toBe("thread-1");
    expect(new Date(String(call?.until)).getTime()).toBeGreaterThan(Date.now());
    expect(lastNotify().message).toMatch(/^Conversation snoozed until/u);
  });

  it("offers the row menu on right-click", async () => {
    render();
    await flush();
    const content = rowFor("Lunch on Friday").querySelector("[data-thread-id]");
    if (content === null) throw new Error("row content missing");
    act(() => {
      content.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    await flush(5);
    const items = all('[role="menuitem"]').map((item) => item.textContent?.trim() ?? "");
    for (const name of [
      "Reply",
      "Reply all",
      "Forward",
      "Archive",
      "Delete",
      "Mark as unread",
      "Snooze",
      "Move to",
      "Label as",
      "Open in new window",
    ]) {
      expect(items.some((item) => item.startsWith(name))).toBe(true);
    }
    const remove = all('[role="menuitem"]').find((item) => item.textContent?.startsWith("Delete"));
    if (remove === undefined) throw new Error("Delete missing");
    click(remove);
    await flush();
    expect(toolCalls("mail.delete")).toEqual([{ threadId: "thread-3" }]);
  });
});

describe("conversation view", () => {
  async function openThread() {
    render();
    await flush();
    click(rowFor("Q3 roadmap"));
    await flush();
  }

  it("opens with the toolbar, position, message header and attachment chips", async () => {
    await openThread();
    expect(toolCalls("mail.read.set")).toContainEqual({ threadId: "thread-1", unread: false });
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Conversation actions"]');
    const labels = Array.from(toolbar?.querySelectorAll("button") ?? []).map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "Back to list",
      "Archive",
      "Report spam",
      "Delete",
      "Mark as unread",
      "Snooze",
      "Move to",
      "Labels",
      "More actions",
      "Newer",
      "Older",
    ]);
    expect(toolbar?.textContent).toContain("1 of 2");
    expect(container.textContent).toContain("Here is the consolidated roadmap for review.");
    expect(container.textContent).toContain("to Alex");
    const chip = document.querySelector<HTMLAnchorElement>("a.mail-attachment");
    expect(chip?.getAttribute("href")).toBe("/v1/api/mail/messages/message-1/attachments/object-1");
    expect(chip?.getAttribute("aria-label")).toBe("Download roadmap.pdf, 242 KB");
  });

  it("toggles labels from the Labels menu", async () => {
    await openThread();
    await openMenu(button("Labels"));
    const team = all('[role="menuitemcheckbox"]').find((item) =>
      item.textContent?.includes("Team"),
    );
    expect(team?.getAttribute("aria-checked")).toBe("true");
    if (team === undefined) throw new Error("Team item missing");
    click(team);
    await flush();
    expect(toolCalls("mail.label.apply")).toContainEqual({
      threadId: "thread-1",
      add: [],
      remove: ["team"],
    });
  });

  it("hands filters and label dialogs to Mail settings", async () => {
    await openThread();
    await openMenu(
      button(
        "More actions",
        document.querySelector('[aria-label="Conversation actions"]') ?? document,
      ),
    );
    click(button("Filter messages like these"));
    expect(dialogs.filter).toHaveBeenCalledWith({ from: "mira@helix.io" });
    expect(toolCalls("mail.filter.create")).toEqual([]);

    await openMenu(button("Labels"));
    const create = all('[role="menuitem"]').find((item) =>
      item.textContent?.includes("Create new"),
    );
    if (create === undefined) throw new Error("Create new missing");
    click(create);
    expect(dialogs.label).toHaveBeenCalledWith({ mode: "create" });

    await openMenu(button("Labels"));
    const manage = all('[role="menuitem"]').find((item) =>
      item.textContent?.includes("Manage labels"),
    );
    if (manage === undefined) throw new Error("Manage labels missing");
    click(manage);
    expect(overlays.openSettings).toHaveBeenCalledWith("mail/labels");
  });

  it("marks unread and returns to the list", async () => {
    await openThread();
    click(button("Mark as unread"));
    await flush();
    expect(toolCalls("mail.read.set").at(-1)).toEqual({ threadId: "thread-1", unread: true });
    expect(document.querySelector('[role="grid"]')).not.toBeNull();
  });
});

describe("reading pane and URL", () => {
  it("shows the list and the conversation side by side and saves the choice", async () => {
    render();
    await flush();
    await openMenu(button("More actions", container.querySelector('[role="toolbar"]') ?? document));
    const right = all('[role="menuitemradio"]').find((item) =>
      item.textContent?.includes("Right of inbox"),
    );
    if (right === undefined) throw new Error("reading pane option missing");
    click(right);
    await flush();
    expect(toolCalls("account.preferences.set")).toContainEqual({ mail: { readingPane: "right" } });
    expect(container.querySelector(".mail-main")?.classList.contains("mail-pane-right")).toBe(true);
    expect(container.textContent).toContain("No conversation selected");
  });

  it("keeps other URL parameters such as ?settings= when the view changes", async () => {
    render();
    await flush();
    click(button("Starred"));
    await flush();
    const call = navigateMock.mock.calls.at(-1)?.[0] as {
      readonly to: string;
      readonly search: (previous: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.to).toBe("/mail");
    expect(call.search({ settings: "appearance", q: "old" })).toMatchObject({
      settings: "appearance",
      folder: "starred",
      q: undefined,
    });
  });
});
