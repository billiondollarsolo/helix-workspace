/**
 * E2.5 — shell depth: command palette, rail navigation, URL deep-links.
 *
 * MOCKED (default): intercepts `/api/**` with fixtures so the real production
 * shell + Mail surface render without a live backend.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";

test.describe("shell depth (palette + rail + deep-link)", () => {
  test("opens command palette and navigates to Mail", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);

    // Drive uses a live search input (not the palette button). Palette still
    // opens via the shell ⌘/Ctrl+K shortcut from AppShell.
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();

    const combobox = dialog.getByRole("combobox");
    await combobox.fill("Mail");
    await expect(dialog.getByRole("option", { name: /Go to Mail/i })).toBeVisible();
    await dialog.getByRole("option", { name: /Go to Mail/i }).click();

    await expect(page).toHaveURL(/\/mail(?:[/?#]|$)/);
    await expect(page.getByRole("main", { name: "Mail" })).toBeVisible();
  });

  test("rail navigation reaches Mail and deep-link /mail preserves surface", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);

    await page.goto("/chat");
    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();

    await page.getByRole("link", { name: "Mail" }).click();
    await expect(page).toHaveURL(/\/mail(?:[/?#]|$)/);
    await expect(page.getByRole("main", { name: "Mail" })).toBeVisible();

    // Hard navigation / shared URL: deep-link must rehydrate the same surface.
    await page.goto("/mail");
    await expect(page).toHaveURL(/\/mail(?:[/?#]|$)/);
    await expect(page.getByRole("main", { name: "Mail" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Mail" })).toHaveAttribute("aria-current", "page");
  });
});

async function seedSession(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: accessTokenStorageKey, value: "e2e-shell-depth-token" },
  );
}

async function mockShellBackend(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "shell-depth-user",
          email: "shell@helix.local",
          name: "Shell Depth User",
          actorId: "00000000-0000-4000-8000-000000000111",
        },
      });
      return;
    }

    if (await fulfillCoreAppsRoute(route)) {
      return;
    }

    if (pathname === "/api/tools/drive.list") {
      await fulfillJson(route, { entries: [] });
      return;
    }
    if (pathname === "/api/tools/drive.search") {
      await fulfillJson(route, { hits: [] });
      return;
    }
    if (pathname === "/api/tools/mail.threads.list") {
      await fulfillJson(route, {
        threads: [],
        total: 0,
        limit: 50,
        offset: 0,
      });
      return;
    }
    if (pathname === "/api/tools/mail.filter.list") {
      await fulfillJson(route, { filters: [] });
      return;
    }
    if (pathname === "/api/tools/mail.vacation.get") {
      await fulfillJson(route, {
        vacation: {
          enabled: false,
          subject: "Out of office",
          body: "I am away right now.",
          startsAt: null,
          endsAt: null,
        },
      });
      return;
    }
    if (pathname === "/api/tools/mail.folders.list") {
      await fulfillJson(route, {
        folders: [
          { key: "inbox", label: "Inbox", unread: 0, total: 0 },
          { key: "sent", label: "Sent", unread: 0, total: 0 },
        ],
      });
      return;
    }
    if (pathname === "/api/tools/mail.labels.list") {
      await fulfillJson(route, { labels: [] });
      return;
    }
    if (pathname === "/api/tools/chat.rooms.list" || pathname === "/api/tools/chat.listRooms") {
      await fulfillJson(route, { rooms: [] });
      return;
    }
    if (pathname === "/api/tools/notifications.unread-count") {
      await fulfillJson(route, { count: 0 });
      return;
    }

    await fulfillJson(route, {});
  });
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
