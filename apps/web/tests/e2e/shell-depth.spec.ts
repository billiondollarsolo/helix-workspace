/**
 * Shell depth: command palette (commands + content), rail navigation, URL
 * deep-links, /search, quick settings, help menu and navigation collapse.
 *
 * MOCKED (default): intercepts `/v1/api/**` with fixtures so the real production
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

test.describe("shell search", () => {
  test("palette lists content by app under the commands and opens results", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("harbor");
    const groups = dialog.getByRole("group");
    await expect(groups.first()).toHaveAccessibleName("Search");
    await expect(dialog.getByRole("group", { name: "Mail" })).toContainText("Harbor review");
    await expect(dialog.getByRole("group", { name: "Files" })).toContainText("Harbor brief.md");
    await expect(dialog.getByRole("group", { name: "Events" })).toContainText("Harbor sync");
    await expect(dialog.getByRole("group", { name: "People" })).toContainText("Luca Harbor");

    await dialog.getByRole("option", { name: /Harbor brief\.md/ }).click();
    await expect(page).toHaveURL(/\/drive\?.*file=file-1/);
  });

  test("top search opens /search with app filter chips", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);
    // Meet has no search of its own, so the top bar searches the workspace.
    await page.goto("/meet");
    await page.getByRole("textbox", { name: "Search Helix" }).fill("harbor");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/search\?q=harbor$/);
    const main = page.getByRole("main", { name: "Search" });
    await main.getByRole("button", { name: "Events" }).click();
    await expect(page).toHaveURL(/\/search\?q=harbor&type=calendar$/);
    await expect(main.getByRole("link", { name: /Harbor sync/ })).toBeVisible();
    await main.getByRole("button", { name: "All" }).click();
    await expect(page).toHaveURL(/\/search\?q=harbor$/);
    await expect(main.getByRole("link", { name: /Harbor review/ })).toBeVisible();
    await expect(main.getByRole("link", { name: "Email Luca Harbor" })).toBeVisible();

    await main.getByRole("button", { name: "Files" }).click();
    await expect(page).toHaveURL(/type=drive/);
    await expect(main.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(main.getByRole("link", { name: /Harbor brief\.md/ })).toBeVisible();
    await expect(main.getByRole("link", { name: /Harbor review/ })).toHaveCount(0);
  });

  test("palette actions open compose and the event editor through URL params", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("combobox").fill("schedule");
    await dialog.getByRole("option", { name: /Schedule meeting/ }).click();
    await expect(page).toHaveURL(/\/calendar\?(?:.*&)?create=event/);
  });
});

test.describe("shell chrome", () => {
  test("cog opens quick settings that switch theme and density", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);
    await page.goto("/drive");

    await page.getByRole("button", { name: "Quick settings" }).click();
    const drawer = page.getByRole("dialog", { name: "Quick settings" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("radio", { name: "Dark" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await drawer.getByRole("radio", { name: "Comfortable" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
    await expect(page.getByRole("button", { name: "Toggle theme" })).toHaveCount(0);

    await drawer.getByRole("button", { name: "See all settings" }).click();
    await expect(page).toHaveURL(/settings=profile/);
  });

  test("help menu offers shortcuts, documentation and About", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);
    await page.goto("/drive");

    await page.getByRole("button", { name: "Help" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText([
      /Keyboard shortcuts/,
      "Documentation",
      "About Helix",
    ]);
    await menu.getByRole("menuitem", { name: "About Helix" }).click();
    await expect(page.getByRole("dialog", { name: "Helix Workspace" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Help" }).click();
    await page.getByRole("menuitem", { name: /Keyboard shortcuts/ }).click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });

  test("hamburger collapses the sidebar to an icon rail and remembers it", async ({ page }) => {
    await seedSession(page);
    await mockShellBackend(page);
    await page.goto("/mail");
    const sidebar = page.locator(".surf-sidebar");
    await expect(sidebar).toBeVisible();
    const expanded = (await sidebar.boundingBox())?.width ?? 0;

    await page.getByRole("button", { name: "Main menu" }).click();
    await expect(page.getByRole("button", { name: "Main menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(80);
    await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible();

    await page.reload();
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(80);
    await page.getByRole("button", { name: "Main menu" }).click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBe(expanded);
  });

  test("shows an offline banner that is not a server error", async ({ page, context }) => {
    await seedSession(page);
    await mockShellBackend(page);
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();
    await context.setOffline(true);
    const banner = page.getByRole("status").filter({ hasText: "You’re offline" });
    await expect(banner).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await context.setOffline(false);
  });
});

const searchHits = [
  {
    id: "mail:1",
    type: "mail",
    title: "Harbor review",
    body: "Harbor review\nNora <nora@helix.local>\nCan we move the harbor review?",
    attributes: { threadId: "11111111-1111-4111-8111-111111111111", fromName: "Nora" },
  },
  {
    id: "drive:1",
    type: "drive",
    title: "Harbor brief.md",
    body: "Harbor brief.md",
    attributes: { fileId: "file-1", parentFolderId: "folder-1", ownerName: "Samara" },
  },
  {
    id: "calendar:1",
    type: "calendar",
    title: "Harbor sync",
    body: "Harbor sync",
    attributes: { eventId: "event-1", startsAt: "2026-10-12T15:00:00.000Z" },
  },
];

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

    if (pathname === "/v1/api/auth/get-session") {
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

    if (pathname === "/v1/api/tools/drive.list") {
      await fulfillJson(route, { entries: [] });
      return;
    }
    if (pathname === "/v1/api/tools/drive.search") {
      await fulfillJson(route, { hits: [] });
      return;
    }
    if (pathname === "/v1/api/tools/mail.threads.list") {
      await fulfillJson(route, {
        threads: [],
        total: 0,
        limit: 50,
        offset: 0,
      });
      return;
    }
    if (pathname === "/v1/api/tools/mail.filter.list") {
      await fulfillJson(route, { filters: [] });
      return;
    }
    if (pathname === "/v1/api/tools/mail.vacation.get") {
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
    if (pathname === "/v1/api/tools/mail.folders.list") {
      await fulfillJson(route, {
        folders: [
          { key: "inbox", label: "Inbox", unread: 0, total: 0 },
          { key: "sent", label: "Sent", unread: 0, total: 0 },
        ],
      });
      return;
    }
    if (pathname === "/v1/api/tools/mail.labels.list") {
      await fulfillJson(route, { labels: [] });
      return;
    }
    if (
      pathname === "/v1/api/tools/chat.rooms.list" ||
      pathname === "/v1/api/tools/chat.listRooms"
    ) {
      await fulfillJson(route, { rooms: [] });
      return;
    }
    if (pathname === "/v1/api/tools/notifications.unread-count") {
      await fulfillJson(route, { count: 0 });
      return;
    }
    if (pathname === "/v1/api/tools/search.query") {
      const input = route.request().postDataJSON() as { types?: string[] };
      const hits = searchHits.filter(
        (hit) => input.types === undefined || input.types.includes(hit.type),
      );
      await fulfillJson(route, { hits, query: "harbor", estimatedTotalHits: hits.length });
      return;
    }
    if (pathname === "/v1/api/people") {
      await fulfillJson(route, {
        people: [
          {
            id: "person-1",
            email: "luca@helix.local",
            displayName: "Luca Harbor",
            kind: "directory",
            favorite: false,
            avatarDataUrl: null,
            relationship: {},
            actorId: null,
            title: null,
          },
        ],
      });
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
