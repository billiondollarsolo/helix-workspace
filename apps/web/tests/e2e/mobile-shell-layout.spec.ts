import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

test.describe("mobile shell layout", () => {
  test("moves app navigation to a safe bottom rail without page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedSession(page);
    await mockBackend(page);
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();

    const layout = await page.evaluate(() => {
      const rail = document.querySelector<HTMLElement>(".rail");
      const workspace = document.querySelector<HTMLElement>(".workspace");
      const firstRailItem = document.querySelector<HTMLElement>(".rail-item");
      if (rail === null || workspace === null || firstRailItem === null) {
        throw new Error("Mobile shell elements were not rendered.");
      }
      const railRect = rail.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const itemRect = firstRailItem.getBoundingClientRect();
      return {
        bodyWidth: document.documentElement.scrollWidth,
        railBottom: railRect.bottom,
        railDirection: getComputedStyle(rail).flexDirection,
        railTop: railRect.top,
        targetHeight: itemRect.height,
        targetWidth: itemRect.width,
        viewportWidth: document.documentElement.clientWidth,
        workspaceBottom: workspaceRect.bottom,
      };
    });

    expect(layout.railDirection).toBe("row");
    expect(layout.railBottom).toBeLessThanOrEqual(844);
    expect(layout.workspaceBottom).toBeLessThanOrEqual(layout.railTop + 1);
    expect(layout.targetWidth).toBeGreaterThanOrEqual(44);
    expect(layout.targetHeight).toBeGreaterThanOrEqual(44);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);

    await page.getByRole("button", { name: "Helix apps" }).click();
    const launcher = page.getByRole("menu", { name: "Helix apps" });
    await expect(launcher).toBeVisible();
    const launcherBox = await launcher.boundingBox();
    expect(launcherBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((launcherBox?.x ?? 0) + (launcherBox?.width ?? 0)).toBeLessThanOrEqual(390);
    expect((launcherBox?.y ?? 0) + (launcherBox?.height ?? 0)).toBeLessThanOrEqual(layout.railTop);
  });
});

async function seedSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("helix.accessToken", "mobile-shell-token");
  });
}

async function mockBackend(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/get-session") {
      await fulfillJson(route, {
        user: {
          id: "mobile-user",
          email: "mobile@helix.local",
          name: "Mobile User",
          actorId: "00000000-0000-4000-8000-000000000111",
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
