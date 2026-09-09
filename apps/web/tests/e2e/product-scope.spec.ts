import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { seedBrowserSession } from "./support/backend-mode";
const PRIMARY_NAMES = ["Mail", "Calendar", "Drive", "Meet", "Chat", "Helix AI", "Admin"] as const;
const EXCLUDED_NAMES = ["Docs", "Sheets", "Slides", "PDF"] as const;
test.describe("workspace product scope", () => {
  test("launcher shows communication and file storage apps", async ({ page }) => {
    await seedBrowserSession(page, "storage-scope-token");
    await mockBackend(page);
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();

    await page.getByRole("button", { name: "Helix apps" }).click();
    const launcher = page.getByRole("menu", { name: "Helix apps" });
    await expect(launcher).toBeVisible();

    const itemNames = await launcher.getByRole("menuitem").allTextContents();
    const normalized = itemNames.map((name) => name.trim());

    expect(normalized).toEqual(expect.arrayContaining([...PRIMARY_NAMES]));
    expect(normalized).toHaveLength(PRIMARY_NAMES.length);

    for (const excluded of EXCLUDED_NAMES) {
      await expect(launcher.getByRole("menuitem", { name: excluded })).toHaveCount(0);
    }

    // Left rail icons use the same APPS filter as the launcher grid.
    for (const excluded of EXCLUDED_NAMES) {
      await expect(page.getByRole("link", { name: excluded })).toHaveCount(0);
    }
    for (const primary of ["Mail", "Drive", "Chat", "Helix AI", "Admin"] as const) {
      await expect(page.getByRole("link", { name: primary })).toBeVisible();
    }
  });

  test("removed editor and viewer routes return 404", async ({ page }) => {
    await seedBrowserSession(page, "storage-scope-token");
    await mockBackend(page);

    for (const path of [
      "/docs",
      "/sheets",
      "/slides",
      "/open/storage-file",
      "/media/storage-file",
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "That page isn’t here" })).toBeVisible();
      await expect(page.getByRole("main", { name: "Docs" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Calendar" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Meet" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Sheets" })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "Slides" })).toHaveCount(0);
    }
  });
});

async function mockBackend(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "product-scope-user",
          email: "scope@helix.local",
          name: "Product Scope User",
          actorId: "00000000-0000-4000-8000-000000000211",
        },
      });
      return;
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname === "/v1/api/tools/drive.list") {
      await fulfillJson(route, { entries: [] });
      return;
    }
    if (pathname === "/v1/api/tools/drive.search") {
      await fulfillJson(route, { hits: [] });
      return;
    }
    if (pathname === "/v1/api/tools/notifications.unread-count") {
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
