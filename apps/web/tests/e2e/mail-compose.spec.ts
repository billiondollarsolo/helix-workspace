/**
 * Mail compose and reply (mocked backend): the docked compose window, Cc/Bcc,
 * Send with the undo snackbar, schedule send, Reply all, and an axe pass on
 * the compose dialog.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const THREAD_ID = "00000000-0000-4000-8000-000000000301";
const OUTBOUND_ID = "00000000-0000-4000-8000-000000000901";

const THREAD_ROW = {
  threadId: THREAD_ID,
  messageId: "00000000-0000-4000-8000-000000000402",
  subject: "Launch plan",
  from: "Samara Diaz",
  fromEmail: "samara@helix.local",
  preview: "Can everyone review the plan?",
  time: "2026-10-09T12:00:00.000Z",
  unread: false,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labels: [],
  category: "primary",
  folder: "inbox",
  snoozedUntil: null,
  participants: [],
};

const THREAD_DETAIL = {
  id: THREAD_ID,
  subject: "Launch plan",
  preview: "Can everyone review the plan?",
  participants: [],
  labels: [],
  archivedAt: null,
  deletedAt: null,
  snoozedUntil: null,
  lastActivity: "2026-10-09T12:00:00.000Z",
  unread: false,
  starred: false,
  direction: "inbound",
  messages: [
    {
      id: "00000000-0000-4000-8000-000000000402",
      subject: "Launch plan",
      from: { address: "samara@helix.local", name: "Samara Diaz" },
      to: [
        { address: "user@helix.local", name: "Uma User" },
        { address: "lee@helix.local", name: "Lee Chen" },
      ],
      cc: [{ address: "kai@helix.local", name: "Kai Ito" }],
      bcc: [],
      sentAt: "2026-10-09T12:00:00.000Z",
      body: "Can everyone review the plan?",
      bodyFormat: "plain",
      hasAttachment: false,
      attachments: [],
    },
  ],
};

interface ToolCall {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

test.describe("/mail compose and reply", () => {
  test.skip(isLiveBackend(), "Uses deterministic mocked mail tools.");

  test("compose, send, and undo from the snackbar", async ({ page }) => {
    const calls = await openMail(page);
    await page.getByRole("button", { name: "Compose" }).click();
    await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
    // The window's name follows the subject, so keep a handle that survives it.
    const dialog = page.locator("[data-compose-window]");
    await expect(dialog.getByRole("combobox", { name: "To" })).toBeFocused();
    expect(await axeViolations(page, "[data-compose-window]")).toEqual([]);

    await dialog.getByRole("combobox", { name: "To" }).fill("samara@helix.local");
    await page.keyboard.press("Enter");
    await dialog.getByRole("textbox", { name: "Subject" }).fill("Lunch Friday?");
    await dialog.getByRole("textbox", { name: "Message body" }).fill("Noon at the usual place.");
    await expect(dialog.getByText("Draft saved")).toBeVisible();

    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("dialog", { name: "Lunch Friday?" })).toHaveCount(0);
    const toast = page.getByRole("region", { name: /Notifications/u });
    await expect(toast.getByText("Message sent")).toBeVisible();
    const send = calls.find((call) => call.tool === "mail.send");
    expect(send?.body).toMatchObject({
      to: [{ address: "samara@helix.local" }],
      subject: "Lunch Friday?",
      bodyText: "Noon at the usual place.",
    });

    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("dialog", { name: "Lunch Friday?" })).toBeVisible();
    expect(calls.some((call) => call.tool === "mail.outbound.cancel")).toBe(true);
  });

  test("Cc and Bcc reveal, and schedule send from Send ▾", async ({ page }) => {
    const calls = await openMail(page);
    await page.getByRole("button", { name: "Compose" }).click();
    const dialog = page.getByRole("dialog", { name: "New message" });
    await expect(dialog.getByRole("combobox", { name: "Cc" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Add Cc recipients" }).click();
    await expect(dialog.getByRole("combobox", { name: "Cc" })).toBeFocused();
    await page.keyboard.press("Control+Shift+B");
    await expect(dialog.getByRole("combobox", { name: "Bcc" })).toBeFocused();

    await dialog.getByRole("combobox", { name: "To" }).fill("lee@helix.local");
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "More send options" }).click();
    await expect(page.getByRole("menu").getByText("Schedule send")).toBeVisible();
    await page.getByRole("menuitem", { name: /Tomorrow morning/u }).click();
    await expect(page.getByText(/Send scheduled for/u)).toBeVisible();
    const send = calls.find((call) => call.tool === "mail.send");
    expect(typeof send?.body.sendAt).toBe("string");
    await page.getByRole("button", { name: "View scheduled" }).click();
    await expect(page).toHaveURL(/folder=scheduled/u);
  });

  test("minimize, full screen, and Escape follow the docked-window pattern", async ({ page }) => {
    await openMail(page);
    await page.getByRole("button", { name: "Compose" }).click();
    const dialog = page.getByRole("dialog", { name: "New message" });
    await dialog.getByRole("button", { name: "Full screen" }).click();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await dialog.getByRole("textbox", { name: "Subject" }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveAttribute("aria-modal", "false");
    await dialog.getByRole("button", { name: "Minimize" }).click();
    await expect(dialog.getByRole("textbox", { name: "Subject" })).toBeHidden();
    await dialog.getByRole("button", { name: "Restore" }).click();
    await dialog.getByRole("textbox", { name: "Subject" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "New message" })).toHaveCount(0);
  });

  test("Reply all shows every recipient and sends to the chips", async ({ page }) => {
    const calls = await openMail(page);
    await page.getByText("Launch plan").first().click();
    await page.getByRole("button", { name: "Reply all", exact: true }).click();
    const reply = page.getByRole("region", { name: "Reply all" });
    await expect(reply.getByRole("button", { name: /Edit recipients/u })).toContainText(
      "To: Samara Diaz, Lee Chen",
    );
    await expect(reply).not.toContainText("Uma User");
    expect(await axeViolations(page, "section.reply-panel")).toEqual([]);
    await reply.getByRole("textbox", { name: "Message body" }).fill("Looks good to me.");
    await reply.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Message sent")).toBeVisible();
    const sent = calls.find((call) => call.tool === "mail.reply");
    expect(sent?.body).toMatchObject({
      threadId: THREAD_ID,
      to: [
        { address: "samara@helix.local", name: "Samara Diaz" },
        { address: "lee@helix.local", name: "Lee Chen" },
      ],
      cc: [{ address: "kai@helix.local", name: "Kai Ito" }],
    });
  });

  test("a person link opens compose addressed to them", async ({ page }) => {
    await seedBrowserSession(page, "e2e-compose-token");
    await page.route("**/api/**", (route) => mockBackend(route, []));
    await page.goto("/mail?compose=new&to=lee@helix.local");
    const dialog = page.getByRole("dialog", { name: "New message" });
    await expect(dialog.getByRole("list", { name: "To recipients" })).toContainText(
      "lee@helix.local",
    );
    await expect(page).not.toHaveURL(/compose=new/u);
  });
});

async function openMail(page: Page): Promise<ToolCall[]> {
  const calls: ToolCall[] = [];
  await seedBrowserSession(page, "e2e-compose-token");
  await page.route("**/api/**", (route) => mockBackend(route, calls));
  await page.goto("/mail");
  await expect(page.getByText("Launch plan")).toBeVisible();
  return calls;
}

async function mockBackend(route: Route, calls: ToolCall[]) {
  if (await fulfillCoreAppsRoute(route)) return;
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (pathname === "/v1/api/mail/addresses") {
    await fulfillJson(route, {
      actorId: "actor-1",
      primaryEmail: "user@helix.local",
      loginEmail: "user@helix.local",
      eligibleDomains: [],
      addresses: [
        {
          id: null,
          address: "user@helix.local",
          displayName: "Uma User",
          isPrimary: true,
          receiveEnabled: true,
          sendAsEnabled: true,
          source: "primary",
        },
      ],
    });
    return;
  }
  if (pathname.startsWith("/v1/api/people")) {
    await fulfillJson(route, { people: [] });
    return;
  }
  const tool = pathname.startsWith("/v1/api/tools/") ? pathname.slice("/v1/api/tools/".length) : "";
  const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
  if (tool !== "") calls.push({ tool, body });
  const sent = {
    id: OUTBOUND_ID,
    threadId: THREAD_ID,
    status: "queued",
    undoUntil: new Date(Date.now() + 30_000).toISOString(),
  };
  switch (tool) {
    case "mail.threads.list":
      await fulfillJson(route, { threads: [THREAD_ROW], total: 1, limit: 50, offset: 0 });
      return;
    case "mail.thread.get":
      await fulfillJson(route, { thread: THREAD_DETAIL });
      return;
    case "mail.draft.save":
      await fulfillJson(route, {
        id: "00000000-0000-4000-8000-000000000801",
        revision: Number(body.expectedRevision ?? 0) + 1,
      });
      return;
    case "mail.send":
    case "mail.reply":
    case "mail.forward":
      await fulfillJson(route, sent);
      return;
    case "mail.outbound.cancel":
      await fulfillJson(route, { outbound: { ...sent, status: "cancelled" } });
      return;
    case "account.preferences.get":
      await fulfillJson(route, {
        language: null,
        timeZone: "UTC",
        dateFormat: null,
        timeFormat: null,
        weekStart: null,
        workingHours: null,
        mail: { readingPane: "none", density: "default", conversationView: true },
        updatedAt: null,
      });
      return;
    default:
      await fulfillJson(route, {});
  }
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
