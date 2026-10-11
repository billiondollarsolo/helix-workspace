/**
 * Keyboard shortcuts E2E (SHELL-001) — drives the real shell and /mail UI.
 *
 * MOCKED only: every `/v1/api/**` call is intercepted with deterministic
 * fixtures so key presses produce predictable navigation and focus.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const THREADS = [
  ["00000000-0000-4000-8000-000000000301", "Quarterly planning notes"],
  ["00000000-0000-4000-8000-000000000302", "Design review follow-up"],
  ["00000000-0000-4000-8000-000000000303", "Travel itinerary"],
].map(([threadId, subject], index) => ({
  threadId,
  messageId: `00000000-0000-4000-8000-00000000040${index}`,
  subject,
  from: "Sam Patel",
  fromEmail: "sam@helix.local",
  preview: `Preview ${index}`,
  time: "2026-05-20T12:00:00.000Z",
  unread: false,
  starred: false,
  hasAttachment: false,
  messageCount: 1,
  labels: [],
  category: "primary",
  folder: "inbox",
  snoozedUntil: null,
  participants: [],
}));

test.describe("keyboard shortcuts", () => {
  test.skip(isLiveBackend(), "Deterministic key flows need the mocked mail fixtures.");

  test("? opens an accessible shortcut list generated from the registry", async ({ page }) => {
    await openMail(page);

    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Mail" })).toBeVisible();
    await expect(dialog.getByText("Go to Mail inbox")).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Shortcut list" })).toBeFocused();
    expect(await axeViolations(page, '[role="dialog"]')).toEqual([]);

    // Focus stays trapped inside the dialog.
    await dialog.getByRole("button", { name: "Close" }).focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("region", { name: "Shortcut list" })).toBeFocused();

    await dialog.getByRole("button", { name: "Shortcut settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
    await expect(settings.getByRole("group", { name: "Keyboard shortcuts" })).toBeVisible();
    expect(await axeViolations(page, '[aria-labelledby="settings-title"]')).toEqual([]);
  });

  test("g sequences, c, and j/k drive Mail", async ({ page }) => {
    await openMail(page);
    const rows = page.getByRole("row");

    await page.keyboard.press("j");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(rows.nth(0)).toBeFocused();

    await page.keyboard.press("o");
    await expect(page).toHaveURL(new RegExp(`thread=${THREADS[0]?.threadId}`));
    await expect(page.getByRole("button", { name: "Reply all", exact: true })).toBeVisible();
    await page.keyboard.press("j");
    await expect(page).toHaveURL(new RegExp(`thread=${THREADS[1]?.threadId}`));
    await page.keyboard.press("u");
    await expect(rows.nth(1)).toBeFocused();

    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect(page).toHaveURL(/folder=sent/u);
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page).not.toHaveURL(/folder=/u);

    await page.keyboard.press("c");
    await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
  });

  test("the off switch silences single-key shortcuts", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("helix-keyboard-shortcuts", "off"));
    await openMail(page);

    await page.keyboard.press("?");
    await page.keyboard.press("c");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  });
});

async function openMail(page: Page) {
  await seedBrowserSession(page, "e2e-shortcuts-token");
  await page.route("**/api/**", (route) => mockBackend(route));
  await page.goto("/mail");
  await expect(page.getByText(THREADS[2]?.subject ?? "")).toBeVisible();
}

async function mockBackend(route: Route) {
  if (await fulfillCoreAppsRoute(route)) return;
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/v1/api/tools/mail.threads.list") {
    await fulfillJson(route, { threads: THREADS, total: THREADS.length, limit: 50, offset: 0 });
    return;
  }
  if (pathname === "/v1/api/tools/mail.thread.get") {
    await fulfillJson(route, { thread: null });
    return;
  }
  await fulfillJson(route, {});
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
