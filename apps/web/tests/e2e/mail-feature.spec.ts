/**
 * Mail feature E2E — drives the real /mail UI in a real browser.
 *
 * MOCKED (default): every `/v1/api/**` call is intercepted with deterministic
 * fixtures, so this runs anywhere including CI's `pnpm exec playwright test`.
 * The mock keeps a little mailbox state (archived threads, labels, reading
 * pane) so undo and optimistic updates can be checked end to end.
 *
 * LIVE (`HELIX_E2E_BACKEND=live`): no mocks are installed; only the first test
 * runs, against the live mail tools served by the docker-compose backend. See
 * `.github/workflows/e2e.yml` and `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

interface BackendCall {
  readonly authorization: string | null;
  readonly method: string;
  readonly pathname: string;
  readonly body: Record<string, unknown>;
}

interface MailboxState {
  readonly calls: BackendCall[];
  readonly archived: Set<string>;
  readingPane: "none" | "right" | "below";
  htmlThread?: boolean;
  incoming?: boolean;
  chatUnread?: number;
}

const THREAD_ID = "00000000-0000-4000-8000-000000000301";
const SECOND_ID = "00000000-0000-4000-8000-000000000302";

const THREADS = [
  {
    threadId: THREAD_ID,
    messageId: "00000000-0000-4000-8000-000000000401",
    subject: "Backend launch thread",
    from: "Sam Patel",
    fromEmail: "sam@helix.local",
    preview: "Backend search result preview",
    time: "2026-05-20T12:00:00.000Z",
    unread: true,
    starred: false,
    hasAttachment: true,
    messageCount: 3,
    labels: ["planning"],
    category: "primary",
    folder: "inbox",
    snoozedUntil: null,
    participants: [
      { name: "Sam Patel", email: "sam@helix.local", isMe: false },
      { name: "me", email: "admin@example.test", isMe: true },
    ],
  },
  {
    threadId: SECOND_ID,
    messageId: "00000000-0000-4000-8000-000000000402",
    subject: "Quarterly planning notes",
    from: "Lee Wong",
    fromEmail: "lee@helix.local",
    preview: "Notes from the planning session",
    time: "2026-05-19T09:00:00.000Z",
    unread: false,
    starred: true,
    hasAttachment: false,
    messageCount: 1,
    labels: [],
    category: "primary",
    folder: "inbox",
    snoozedUntil: null,
    participants: [{ name: "Lee Wong", email: "lee@helix.local", isMe: false }],
  },
];

const LABELS = [
  {
    id: "00000000-0000-4000-8000-000000000501",
    slug: "planning",
    name: "Planning",
    color: "#00792f",
    colorName: "green",
    parentId: null,
    sortOrder: 0,
    threadCount: 1,
    unreadCount: 1,
    shared: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000502",
    slug: "travel",
    name: "Travel",
    color: "#006fa7",
    colorName: "sky",
    parentId: null,
    sortOrder: 1,
    threadCount: 0,
    unreadCount: 0,
    shared: false,
  },
];

const FOLDERS = [
  { id: "inbox", label: "Inbox", total: 2, unread: 1 },
  { id: "starred", label: "Starred", total: 1, unread: 0 },
  { id: "drafts", label: "Drafts", total: 1, unread: 0 },
];

test.describe("/mail feature flow", () => {
  test("renders backend thread rows in the inbox", async ({ page }) => {
    const state = await openMail(page, "e2e-mail-token");

    await expect(page.getByRole("main", { name: "Mail" })).toBeVisible();
    if (isLiveBackend()) {
      // Live mode: the list must render without the error state.
      await expect(page.getByText("Couldn't load your mail")).toHaveCount(0);
      return;
    }
    const row = page.getByRole("row", { name: /Backend launch thread/u });
    await expect(row).toContainText("Sam, me (3)");
    await expect(row.getByText("Planning")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Labels" })).toContainText("Planning");
    const listCall = state.calls.find((call) => call.pathname.endsWith("/mail.threads.list"));
    expect(listCall?.method).toBe("POST");
    expect(listCall?.authorization).toBeNull();
    expect(await axeViolations(page, "main")).toEqual([]);
  });
});

test.describe("/mail list and conversation", () => {
  test.skip(isLiveBackend(), "These flows need the mocked mailbox.");

  test("shows new Chat unread counts while keeping the Mail draft focused", async ({ page }) => {
    await page.clock.install();
    const state = await openMail(page, "cross-app-chat-test");
    await page.getByRole("button", { name: "Compose", exact: true }).last().click();
    const subject = page.getByRole("textbox", { name: "Subject", exact: true });
    await subject.fill("Keep this draft while Atlas chats");
    state.chatUnread = 3;
    await page.clock.runFor(30_100);
    await expect(page.locator(".rail #rail-chat-unread")).toHaveText("3 unread messages");
    await expect(subject).toHaveValue("Keep this draft while Atlas chats");
    await expect(subject).toBeFocused();
    expect(page.url()).toContain("/mail");
  });

  for (const eventType of ["message", "open"] as const) {
    test(`updates the inbox without reloading on a mail stream ${eventType}`, async ({ page }) => {
      await page.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        window.EventSource = class extends NativeEventSource {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            if (new URL(url, location.href).pathname === "/v1/sse/mail")
              (window as unknown as { mailTestSource: EventSource }).mailTestSource = this;
          }
        };
      });
      const state = await openMail(page, "realtime-mail-test");
      await page.getByRole("button", { name: "Compose", exact: true }).last().click();
      const subject = page.getByRole("textbox", { name: "Subject", exact: true });
      await subject.fill("Keep this draft while mail arrives");
      await subject.evaluate((input: HTMLInputElement) => input.setSelectionRange(5, 15));
      await page.evaluate(() => {
        (window as unknown as { mailPageMarker: string }).mailPageMarker = "same-page";
      });
      await expect(page.getByRole("row", { name: /New realtime message/u })).toHaveCount(0);
      state.incoming = true;
      await page.evaluate((type) => {
        const source = (window as unknown as { mailTestSource: EventSource }).mailTestSource;
        source.dispatchEvent(
          type === "open"
            ? new Event("open")
            : new MessageEvent("message", {
                data: JSON.stringify({
                  type: "mail.received",
                  threadId: "00000000-0000-4000-8000-000000000303",
                }),
              }),
        );
      }, eventType);
      await expect(page.getByRole("row", { name: /New realtime message/u })).toBeVisible();
      await expect(page.locator(".rail #rail-mail-unread")).toHaveText("2 unread messages");
      await expect(subject).toHaveValue("Keep this draft while mail arrives");
      await expect(subject).toBeFocused();
      expect(
        await subject.evaluate((input: HTMLInputElement) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      ).toEqual([5, 15]);
      expect(
        await page.evaluate(() => (window as unknown as { mailPageMarker: string }).mailPageMarker),
      ).toBe("same-page");
    });
  }

  for (const mode of ["light", "dark", "phone"] as const) {
    test(`renders a Gmail reply on a white reading canvas in ${mode} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: mode === "dark" ? "dark" : "light" });
      if (mode === "phone") await page.setViewportSize({ width: 390, height: 844 });
      const state = await openMail(page, `html-message-${mode}`);
      state.htmlThread = true;
      await page.getByRole("row", { name: /Backend launch thread/u }).click();
      const canvas = page.locator(".mail-conversation-body");
      await expect(canvas).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(canvas).toHaveCSS("color", "rgb(32, 33, 36)");
      await expect(page.getByRole("group", { name: "Message body view" })).toHaveCount(0);
      const frame = page.frameLocator('iframe[title="HTML email content"]');
      await expect(frame.getByText("Hi there")).toBeVisible();
      await expect(frame.getByText("Earlier reply")).toBeHidden();
      await expect(frame.getByText(/^On Wed/u)).toBeHidden();
      const iframe = page.locator('iframe[title="HTML email content"]');
      await expect.poll(async () => (await iframe.boundingBox())?.height ?? 999).toBeLessThan(120);
      const collapsedHeight = (await iframe.boundingBox())?.height ?? 0;
      await frame.locator("summary").focus();
      await frame.locator("summary").press("Enter");
      await expect(frame.getByText("Earlier reply")).toBeVisible();
      await expect
        .poll(async () => (await iframe.boundingBox())?.height ?? 0)
        .toBeGreaterThan(collapsedHeight);
      await frame.locator("summary").press("Enter");
      await expect
        .poll(async () => (await iframe.boundingBox())?.height ?? 999)
        .toBeLessThanOrEqual(collapsedHeight);
      expect(await axeViolations(page, "main")).toEqual([]);
      if (mode === "phone") {
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          390,
        );
      }
      await frame.getByRole("link", { name: "Report" }).click();
      await expect(page.getByRole("alert")).toContainText("opens outside Helix");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "More message actions" }).click();
      await page.getByRole("menuitem", { name: "Show plain text" }).click();
      await expect(iframe).toHaveCount(0);
      await expect(canvas).toContainText("Hi there — readable plain alternative");
    });
  }

  test("searches all mail with operators and the search options form", async ({ page }) => {
    const state = await openMail(page, "e2e-mail-search");
    await page.getByRole("textbox", { name: "Search mail" }).fill("from:sam has:attachment");
    await expect(page.getByRole("heading", { name: "Search results" })).toBeVisible();
    await expect
      .poll(() => lastBody(state, "mail.threads.list"))
      .toMatchObject({
        folder: "all",
        query: "from:sam has:attachment",
      });
    await expect(page.getByRole("tablist", { name: "Inbox categories" })).toHaveCount(0);

    await page.getByRole("button", { name: "Show search options" }).click();
    const form = page.getByRole("dialog", { name: "Search options" });
    await expect(form.getByLabel("From")).toHaveValue("sam");
    await form.getByLabel("Subject").fill("launch plan");
    await form.getByLabel("Search in").selectOption("anywhere");
    await form.getByRole("button", { name: "Search" }).click();
    await expect
      .poll(() => lastBody(state, "mail.threads.list"))
      .toMatchObject({
        query: 'from:sam subject:"launch plan" has:attachment in:anywhere',
      });
  });

  test("archives with an undo snackbar", async ({ page }) => {
    const state = await openMail(page, "e2e-mail-undo");
    const row = page.getByRole("row", { name: /Backend launch thread/u });
    await row.hover();
    await row.getByRole("button", { name: "Archive" }).click();
    await expect(row).toHaveCount(0);
    const snackbar = page.getByRole("region", { name: /Notifications/u });
    await expect(snackbar.getByText("Conversation archived")).toBeVisible();
    await snackbar.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("row", { name: /Backend launch thread/u })).toBeVisible();
    expect(state.calls.map((call) => call.pathname)).toEqual(
      expect.arrayContaining(["/v1/api/tools/mail.archive", "/v1/api/tools/mail.unarchive"]),
    );

    // z undoes the last action too.
    await page.getByRole("row", { name: /Quarterly planning notes/u }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Archive/u }).click();
    await expect(page.getByRole("row", { name: /Quarterly planning notes/u })).toHaveCount(0);
    await page.keyboard.press("z");
    await expect(page.getByRole("row", { name: /Quarterly planning notes/u })).toBeVisible();
  });

  test("snoozes a conversation from the picker", async ({ page }) => {
    const state = await openMail(page, "e2e-mail-snooze");
    await page.getByRole("row", { name: /Backend launch thread/u }).click();
    const toolbar = page.getByRole("toolbar", { name: "Conversation actions" });
    await toolbar.getByRole("button", { name: "Snooze" }).click();
    const picker = page.getByRole("dialog", { name: "Snooze until" });
    await expect(picker.getByRole("button", { name: /^Tomorrow/u })).toBeVisible();
    expect(await axeViolations(page, '[role="dialog"]')).toEqual([]);
    await picker.getByRole("button", { name: "Pick date & time" }).click();
    await expect(picker.getByRole("grid")).toBeVisible();
    await picker.getByRole("button", { name: "Cancel" }).click();
    await picker.getByRole("button", { name: /^Tomorrow/u }).click();
    await expect.poll(() => lastBody(state, "mail.snooze")).toMatchObject({ threadId: THREAD_ID });
    await expect(page.getByRole("grid", { name: "Conversations" })).toBeVisible();
  });

  test("labels a conversation from the label menu", async ({ page }) => {
    const state = await openMail(page, "e2e-mail-labels");
    await page.getByRole("row", { name: /Backend launch thread/u }).click();
    await expect(page.getByText("Sam Patel").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Download brief.pdf, 12 KB" })).toBeVisible();
    await page
      .getByRole("toolbar", { name: "Conversation actions" })
      .getByRole("button", { name: "Labels" })
      .click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitemcheckbox", { name: "Planning" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await menu.getByRole("menuitemcheckbox", { name: "Travel" }).click();
    await expect
      .poll(() => lastBody(state, "mail.label.apply"))
      .toEqual({
        threadId: THREAD_ID,
        add: ["travel"],
        remove: [],
      });
  });

  test("offers the row context menu with the keyboard", async ({ page }) => {
    const state = await openMail(page, "e2e-mail-context");
    const row = page.getByRole("row", { name: /Quarterly planning notes/u });
    await row.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Reply all" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Open in new window" })).toBeVisible();
    expect(await axeViolations(page, '[role="menu"]')).toEqual([]);
    await menu.getByRole("menuitem", { name: "Mark as unread" }).click();
    await expect
      .poll(() => lastBody(state, "mail.read.set"))
      .toEqual({
        threadId: SECOND_ID,
        unread: true,
      });
  });

  test("switches the reading pane to the right of the list", async ({ page }) => {
    const state = await openMail(page, "e2e-mail-pane");
    await page
      .getByRole("toolbar", { name: "List actions" })
      .getByRole("button", { name: "More actions" })
      .click();
    await page.getByRole("menuitemradio", { name: "Right of inbox" }).click();
    await expect(page.getByText("No conversation selected")).toBeVisible();
    await page.getByRole("row", { name: /Backend launch thread/u }).click();
    await expect(page.getByRole("grid", { name: "Conversations" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Conversation" })).toBeVisible();
    expect(state.readingPane).toBe("right");
    expect(await axeViolations(page, "main")).toEqual([]);
  });
});

test.describe("/mail on a phone", () => {
  test.skip(isLiveBackend(), "Needs the mocked mailbox.");
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("shows stacked rows, a floating Compose and a full-screen conversation", async ({
    page,
  }) => {
    await openMail(page, "e2e-mail-mobile");
    const row = page.getByRole("row", { name: /Backend launch thread/u });
    await expect(row.getByText("Sam, me (3)")).toBeVisible();
    await expect(row.getByText("Backend launch thread")).toBeVisible();
    await expect(row.getByText("Backend search result preview")).toBeVisible();
    await expect(row.getByRole("button", { name: "Star" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Compose" }).last()).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);

    await row.click();
    await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();
    await expect(page.getByRole("grid", { name: "Conversations" })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to list" }).click();
    await expect(page.getByRole("grid", { name: "Conversations" })).toBeVisible();
  });
});

async function openMail(page: Page, token: string): Promise<MailboxState> {
  const state: MailboxState = { calls: [], archived: new Set(), readingPane: "none" };
  const accessToken = await seedBrowserSession(page, token);
  if (!isLiveBackend()) {
    await page.route("**/api/**", (route) => mockMailBackend(route, state, accessToken));
  }
  await page.goto("/mail");
  if (!isLiveBackend()) {
    await expect(page.getByRole("row", { name: /Backend launch thread/u })).toBeVisible();
  }
  return state;
}

function lastBody(state: MailboxState, tool: string): Record<string, unknown> | undefined {
  return state.calls.filter((call) => call.pathname === `/v1/api/tools/${tool}`).at(-1)?.body;
}

async function mockMailBackend(route: Route, state: MailboxState, accessToken: string) {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (await fulfillCoreAppsRoute(route)) return;
  const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
  state.calls.push({
    authorization: request.headers().authorization ?? null,
    method: request.method(),
    pathname,
    body,
  });

  if (!(request.headers().cookie ?? "").includes(`helix_session=${accessToken}`)) {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "missing session cookie" }),
    });
    return;
  }

  const threadId = typeof body.threadId === "string" ? body.threadId : "";
  switch (pathname) {
    case "/v1/api/tools/mail.threads.list": {
      const threads = [
        ...THREADS,
        ...(state.incoming
          ? [
              {
                ...THREADS[1],
                threadId: "00000000-0000-4000-8000-000000000303",
                messageId: "00000000-0000-4000-8000-000000000403",
                subject: "New realtime message",
              },
            ]
          : []),
      ].filter((thread) => !state.archived.has(thread.threadId));
      await fulfillJson(route, { threads, total: threads.length, limit: 50, offset: 0 });
      return;
    }
    case "/v1/api/tools/mail.folders.list":
      await fulfillJson(route, {
        folders: FOLDERS.map((folder) =>
          folder.id === "inbox" && state.incoming ? { ...folder, unread: 2, total: 3 } : folder,
        ),
      });
      return;
    case "/v1/api/tools/chat.unread.list":
      await fulfillJson(route, { rooms: [], totalUnread: state.chatUnread ?? 0, totalMentions: 0 });
      return;
    case "/v1/api/tools/mail.labels.list":
      await fulfillJson(route, { labels: LABELS });
      return;
    case "/v1/api/tools/mail.thread.get":
      await fulfillJson(route, { thread: threadDetail(state.htmlThread) });
      return;
    case "/v1/api/tools/mail.archive":
    case "/v1/api/tools/mail.snooze":
      state.archived.add(threadId);
      await fulfillJson(route, { ok: true });
      return;
    case "/v1/api/tools/mail.unarchive":
      state.archived.delete(threadId);
      await fulfillJson(route, { ok: true });
      return;
    case "/v1/api/tools/account.preferences.get":
      await fulfillJson(route, preferences(state));
      return;
    case "/v1/api/tools/account.preferences.set": {
      const mail = body.mail as { readonly readingPane?: MailboxState["readingPane"] } | undefined;
      if (mail?.readingPane !== undefined) state.readingPane = mail.readingPane;
      await fulfillJson(route, preferences(state));
      return;
    }
    case "/v1/api/tools/mail.filter.list":
      await fulfillJson(route, { filters: [] });
      return;
    default:
      await fulfillJson(route, {});
  }
}

function preferences(state: MailboxState) {
  return {
    language: null,
    timeZone: null,
    dateFormat: null,
    timeFormat: null,
    weekStart: null,
    workingHours: null,
    mail: { readingPane: state.readingPane, density: "default", conversationView: true },
    updatedAt: null,
  };
}

function threadDetail(html = false) {
  const [thread] = THREADS;
  return {
    id: THREAD_ID,
    subject: thread?.subject,
    preview: thread?.preview,
    participants: [{ address: "sam@helix.local", name: "Sam Patel" }],
    labels: ["planning"],
    archivedAt: null,
    deletedAt: null,
    snoozedUntil: null,
    lastActivity: "2026-05-20T12:00:00.000Z",
    unread: false,
    starred: false,
    direction: "inbound",
    messages: [
      {
        id: "00000000-0000-4000-8000-000000000401",
        from: { address: "sam@helix.local", name: "Sam Patel" },
        to: [{ address: "admin@example.test", name: "Test admin" }],
        cc: [],
        bcc: [],
        sentAt: "2026-05-20T12:00:00.000Z",
        body: html
          ? '<div>Hi there <a href="#helix-link" data-helix-href="https://example.com/report">Report</a></div><br/><div><div>On Wed, Oct 14, Mike wrote:</div><blockquote>Earlier reply<br/>A second line</blockquote></div>'
          : "Launch plan attached.",
        bodyFormat: html ? "html" : "plain",
        ...(html ? { plainBody: "Hi there — readable plain alternative" } : {}),
        hasAttachment: true,
        attachments: [
          {
            objectId: "00000000-0000-4000-8000-000000000601",
            filename: "brief.pdf",
            mimeType: "application/pdf",
            byteSize: 12_288,
            disposition: "attachment",
            inline: false,
            downloadUrl:
              "/v1/api/mail/messages/00000000-0000-4000-8000-000000000401/attachments/00000000-0000-4000-8000-000000000601",
          },
        ],
      },
    ],
  };
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

async function axeViolations(page: Page, selector: string) {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async (include) => {
    const browser = window as typeof window & { axe: typeof axe };
    const result = await browser.axe.run(
      { include: [include] },
      {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
        },
      },
    );
    return result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
  }, selector);
}
