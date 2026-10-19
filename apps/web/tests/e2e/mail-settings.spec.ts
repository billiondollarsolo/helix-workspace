import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

/* Settings → Mail against a small in-memory backend: labels, filters,
   vacation responder, mail settings and account preferences keep state, so
   each flow is checked by what the next request returns. */

test.beforeEach(() => {
  test.skip(isLiveBackend(), "Uses an in-memory mail backend to keep each flow isolated.");
});

interface Label {
  id: string;
  slug: string;
  name: string;
  color: string;
  colorName: string;
  parentId: string | null;
  sortOrder: number;
  threadCount: number;
  unreadCount: number;
  shared: boolean;
}

function mailBackend() {
  const labels: Label[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      slug: "clients",
      name: "Clients",
      color: "#007c76",
      colorName: "teal",
      parentId: null,
      sortOrder: 100,
      threadCount: 4,
      unreadCount: 1,
      shared: false,
    },
  ];
  const filters: Record<string, unknown>[] = [];
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  let vacation: Record<string, unknown> | null = null;
  let preferences = {
    language: "en",
    timeZone: "America/New_York",
    dateFormat: null,
    timeFormat: null,
    weekStart: null,
    workingHours: null,
    mail: { readingPane: "none", density: "default", conversationView: true },
    updatedAt: null,
  };
  const tools: Record<string, (input: Record<string, unknown>) => unknown> = {
    "mail.labels.list": () => ({ labels }),
    "mail.label.create": (input) => {
      const label: Label = {
        id: `00000000-0000-4000-8000-00000000000${String(labels.length + 1)}`,
        slug: String(input.name).toLowerCase(),
        name: String(input.name),
        color: "#000000",
        colorName: String(input.color),
        parentId: (input.parentId as string | null | undefined) ?? null,
        sortOrder: 100,
        threadCount: 0,
        unreadCount: 0,
        shared: false,
      };
      labels.push(label);
      return { label };
    },
    "mail.filter.list": () => ({ filters }),
    "mail.filter.create": (input) => {
      const filter = { ...input, id: "22222222-2222-4222-8222-222222222222" };
      filters.push(filter);
      return filter;
    },
    "mail.threads.list": () => ({ threads: [], total: 3, limit: 1, offset: 0 }),
    "mail.vacation.get": () => ({ vacation }),
    "mail.vacation.set": (input) => {
      vacation = { ...input, id: "vacation-1" };
      return { vacation };
    },
    "mail.settings.get": () => ({
      signatureText: "Thanks, Léa",
      signatureHtml: null,
      includeSignatureOnReplies: true,
      blockedSenders: ["spam@example.net"],
      updatedAt: null,
    }),
    "account.preferences.get": () => preferences,
    "account.preferences.set": (input) => {
      preferences = {
        ...preferences,
        mail: { ...preferences.mail, ...(input.mail as object) },
      };
      return preferences;
    },
    "notifications.unread-count": () => ({ count: 0 }),
    "notifications.list": () => ({ notifications: [] }),
    "assistant.conversations.list": () => ({ items: [], nextCursor: null }),
  };
  return {
    calls,
    async install(page: Page) {
      await seedBrowserSession(page, "mail-settings-session");
      await page.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (await fulfillCoreAppsRoute(route)) return;
        const toolId = pathname.startsWith("/v1/api/tools/")
          ? pathname.slice("/v1/api/tools/".length)
          : null;
        const handler = toolId === null ? undefined : tools[toolId];
        if (toolId !== null && handler !== undefined) {
          const input = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
          calls.push({ tool: toolId, input });
          await fulfillJson(route, handler(input));
          return;
        }
        await fulfillJson(route, {});
      });
    },
  };
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Personal settings", exact: true });
}

test("creates a nested, colored label from the Labels tab", async ({ page }) => {
  const backend = mailBackend();
  await backend.install(page);
  await page.goto("/assistant?settings=mail/labels");
  const settings = settingsDialog(page);
  await expect(settings.getByRole("tab", { name: "Labels" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(settings.getByRole("list", { name: "Labels" })).toContainText("Clients");

  await settings.getByRole("button", { name: "Add label" }).click();
  const dialog = page.getByRole("dialog", { name: "New label" });
  await dialog.getByLabel("Label name").fill("Acme");
  await dialog.getByLabel("Nest label under").check();
  await dialog.getByLabel("Parent label").selectOption({ label: "Clients" });
  await dialog.getByTitle("Indigo").click();
  await expect(dialog.getByRole("radio", { name: "Indigo" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create" }).click();

  await expect(dialog).toBeHidden();
  await expect(settings.getByRole("list", { name: "Labels" })).toContainText("Acme");
  await expect(settings.getByRole("button", { name: "Edit Clients/Acme" })).toBeVisible();
  expect(backend.calls.find((call) => call.tool === "mail.label.create")?.input).toEqual({
    name: "Acme",
    color: "indigo",
    parentId: "11111111-1111-4111-8111-111111111111",
  });
  // Escape closed only the label dialog; the settings page stays open.
  await expect(settings).toBeVisible();
});

test("creates a filter in two steps with a match preview", async ({ page }) => {
  const backend = mailBackend();
  await backend.install(page);
  await page.goto("/assistant?settings=mail/filters");
  const settings = settingsDialog(page);
  await expect(settings.getByText("No filters yet")).toBeVisible();
  await settings.getByRole("button", { name: "Add filter" }).click();

  const dialog = page.getByRole("dialog", { name: "Create a filter" });
  await dialog.getByLabel("From", { exact: true }).fill("billing@example.com");
  await dialog.getByLabel("Has attachment").check();
  await dialog.getByRole("button", { name: "Search" }).click();
  await expect(dialog.getByRole("status")).toHaveText("3 conversations match.");
  await dialog.getByRole("button", { name: "Continue" }).click();

  await expect(dialog.getByText("from:billing@example.com has:attachment")).toBeVisible();
  await dialog.getByLabel("Skip the Inbox (Archive it)").check();
  await dialog.getByLabel("Mark as read").check();
  await dialog.getByLabel("Apply the label:").check();
  await dialog.getByRole("button", { name: "Create filter" }).click();

  await expect(dialog).toBeHidden();
  await expect(settings.getByRole("list", { name: "Filters" })).toContainText(
    "Skip Inbox, Mark as read, Apply label “Clients”",
  );
  expect(backend.calls.find((call) => call.tool === "mail.filter.create")?.input).toMatchObject({
    criteria: { fromContains: "billing@example.com", hasAttachment: true },
    actions: { archive: true, markRead: true, applyLabels: ["clients"] },
  });
});

test("turns the vacation responder on", async ({ page }) => {
  const backend = mailBackend();
  await backend.install(page);
  await page.goto("/assistant?settings=mail");
  const settings = settingsDialog(page);
  await expect(settings.getByRole("tab", { name: "General" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await settings.getByRole("radio", { name: "Vacation responder on" }).check();
  await settings.getByRole("button", { name: "Save responder" }).click();
  await expect(settings.getByText("Add a subject.")).toBeVisible();

  await settings.getByLabel("First day").fill("2026-12-21");
  await settings.getByLabel("Turn off after").check();
  await settings.getByLabel("Last day", { exact: true }).fill("2027-01-03");
  await settings.getByLabel("Subject").fill("Away for the holidays");
  await settings.getByLabel("Message").fill("Back on January 4.");
  await settings.getByRole("button", { name: "Save responder" }).click();

  await expect(settings.getByText("Vacation responder is on.")).toBeVisible();
  expect(backend.calls.find((call) => call.tool === "mail.vacation.set")?.input).toMatchObject({
    enabled: true,
    subject: "Away for the holidays",
    body: "Back on January 4.",
  });
});

test("switches tabs with the keyboard and keeps the tab in the URL", async ({ page }) => {
  const backend = mailBackend();
  await backend.install(page);
  await page.goto("/assistant?settings=mail/general");
  const settings = settingsDialog(page);
  await settings.getByRole("tab", { name: "General" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(settings.getByRole("tab", { name: "Labels" })).toBeFocused();
  await expect(page).toHaveURL(/settings=mail(%2F|\/)labels/u);
  await page.keyboard.press("ArrowLeft");
  await expect(settings.getByRole("tab", { name: "General" })).toBeFocused();
  await expect(page).toHaveURL(/settings=mail(%2F|\/)general/u);
  await settings.getByRole("radio", { name: "Right of inbox" }).check();
  await expect
    .poll(() => backend.calls.filter((call) => call.tool === "account.preferences.set").length)
    .toBe(1);
});

/** Buttons that only show once each part of the tab has loaded. */
const READY = {
  general: ["Change in Language & region", "Save signature", "Save responder"],
  labels: ["Add label"],
  filters: ["Add filter", "Unblock spam@example.net"],
} as const;

for (const colorScheme of ["light", "dark"] as const) {
  for (const tab of ["general", "labels", "filters"] as const) {
    test(`mail settings ${tab} tab is accessible in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      const backend = mailBackend();
      await backend.install(page);
      await page.goto(`/assistant?settings=mail/${tab}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      const panel = page.getByRole("tabpanel");
      for (const loaded of READY[tab]) {
        await expect(panel.getByRole("button", { name: loaded })).toBeVisible({ timeout: 15_000 });
      }
      if (tab === "filters") {
        await panel.getByRole("button", { name: "Add filter" }).click();
        await expect(page.getByRole("dialog", { name: "Create a filter" })).toBeVisible();
      }
      if (tab === "labels") {
        await panel.getByRole("button", { name: "Add label" }).click();
        await expect(page.getByRole("dialog", { name: "New label" })).toBeVisible();
      }
      await page.addScriptTag({ content: axe.source });
      const violations = await page.evaluate(async () => {
        const browser = window as typeof window & { axe: typeof axe };
        const result = await browser.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
          },
        });
        return result.violations.map(
          (violation) =>
            `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
        );
      });
      expect(violations).toEqual([]);
    });
  }
}
