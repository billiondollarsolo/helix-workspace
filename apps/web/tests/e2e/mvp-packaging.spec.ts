/**
 * Web MVP packaging hard guarantees (elite plan E1.3).
 *
 * Default e2e CI serves the full workspace Vite graph so calendar/docs/meet
 * feature specs remain valid. This file asserts the production MVP launcher
 * boundary only when `VITE_HELIX_MVP_ONLY=true` is set for the Playwright
 * webServer (see `support/mvp-packaging-mode.ts` and `playwright.config.ts`).
 *
 * Unit coverage that always runs: `src/components/apps.test.ts`,
 * `src/packaging/mvp-packaging.test.ts` (drives real `workspaceAppsForBuild` /
 * `isMvpOnlyBuild`).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import {
  isMvpPackagingE2e,
  MVP_EXCLUDED_LAUNCHER_NAMES,
  MVP_PRIMARY_LAUNCHER_NAMES,
} from "./support/mvp-packaging-mode";

test.describe("production MVP packaging (launcher)", () => {
  test.beforeEach(() => {
    test.skip(
      !isMvpPackagingE2e(),
      "Set VITE_HELIX_MVP_ONLY=true to serve the MVP packaging graph (see support/mvp-packaging-mode.ts)",
    );
  });

  test("launcher rail shows only mail, drive, chat, assistant, and admin", async ({ page }) => {
    await seedSession(page);
    await mockBackend(page);
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();

    await page.getByRole("button", { name: "Helix apps" }).click();
    const launcher = page.getByRole("menu", { name: "Helix apps" });
    await expect(launcher).toBeVisible();

    const itemNames = await launcher.getByRole("menuitem").allTextContents();
    const normalized = itemNames.map((name) => name.trim());

    expect(normalized).toEqual(expect.arrayContaining([...MVP_PRIMARY_LAUNCHER_NAMES]));
    expect(normalized).toHaveLength(MVP_PRIMARY_LAUNCHER_NAMES.length);

    for (const excluded of MVP_EXCLUDED_LAUNCHER_NAMES) {
      await expect(launcher.getByRole("menuitem", { name: excluded })).toHaveCount(0);
    }

    // Left rail icons use the same APPS filter as the launcher grid.
    for (const excluded of MVP_EXCLUDED_LAUNCHER_NAMES) {
      await expect(page.getByRole("link", { name: excluded })).toHaveCount(0);
    }
    for (const primary of ["Mail", "Drive", "Chat", "Helix AI", "Admin"] as const) {
      await expect(page.getByRole("link", { name: primary })).toBeVisible();
    }
  });

  test("deep links to excluded Full Workspace surfaces redirect or 404", async ({ page }) => {
    await seedSession(page);
    await mockBackend(page);

    // Product rule: either `enforceFullWorkspaceRoute` → /drive, or the MVP
    // route ignore pattern removes the surface (404). Never render the editor
    // or collaboration shell as a primary workspace surface.
    for (const path of ["/docs", "/sheets", "/slides", "/calendar", "/meet"] as const) {
      await page.goto(path);
      const onDrive = /\/drive(?:\/|\?|$)/u.test(page.url());
      const notFound = page.getByRole("heading", { name: "That page isn’t here" });
      if (onDrive) {
        await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();
      } else {
        await expect(notFound).toBeVisible();
      }
      await expect(page.getByRole("main", { name: "Docs" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Calendar" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Meet" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Sheets" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Slides" })).toHaveCount(0);
    }
  });
});

async function seedSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("helix.accessToken", "mvp-packaging-e2e-token");
  });
}

async function mockBackend(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "mvp-packaging-user",
          email: "mvp@helix.local",
          name: "MVP Packaging User",
          actorId: "00000000-0000-4000-8000-000000000211",
        },
      });
      return;
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname === "/api/tools/drive.list") {
      await fulfillJson(route, { entries: [] });
      return;
    }
    if (pathname === "/api/tools/drive.search") {
      await fulfillJson(route, { hits: [] });
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
