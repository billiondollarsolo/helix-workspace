import { expect, test, type Page, type Route } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

test.describe("mobile shell layout", () => {
  test("uses a five-slot bottom bar with a More sheet and no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedSession(page);
    await mockBackend(page);
    await page.goto("/drive");
    await expect(page.getByRole("main", { name: "Drive" })).toBeVisible();

    const bottomNav = page.locator(".bottom-nav");
    await expect(bottomNav).toBeVisible();
    await expect(page.locator(".rail")).toBeHidden();
    await expect(page.locator(".side-panel-rail")).toBeHidden();
    await expect(page.locator(".topbar-title")).toHaveText("Drive");

    const items = bottomNav.locator(".bottom-nav-item");
    await expect(items).toHaveCount(5);
    await expect(items).toHaveText(["Mail", "Calendar", "Drive", "Chat", "More"]);

    const layout = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>(".bottom-nav");
      const workspace = document.querySelector<HTMLElement>(".workspace");
      const active = document.querySelector<HTMLElement>(".bottom-nav-item[data-active]");
      const pill = active?.querySelector<HTMLElement>(".bottom-nav-pill") ?? null;
      if (nav === null || workspace === null || active === null || pill === null) {
        throw new Error("Mobile shell elements were not rendered.");
      }
      const item = active.getBoundingClientRect();
      return {
        activeLabel: active.textContent,
        bodyWidth: document.documentElement.scrollWidth,
        navBottom: nav.getBoundingClientRect().bottom,
        navTop: nav.getBoundingClientRect().top,
        pillBackground: getComputedStyle(pill).backgroundColor,
        pillRadius: getComputedStyle(pill).borderTopLeftRadius,
        targetHeight: item.height,
        targetWidth: item.width,
        viewportWidth: document.documentElement.clientWidth,
        workspaceBottom: workspace.getBoundingClientRect().bottom,
      };
    });

    expect(layout.activeLabel).toBe("Drive");
    expect(layout.pillBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(layout.pillRadius).toBe("999px");
    expect(layout.navBottom).toBeLessThanOrEqual(844);
    expect(layout.workspaceBottom).toBeLessThanOrEqual(layout.navTop + 1);
    expect(layout.targetWidth).toBeGreaterThanOrEqual(44);
    expect(layout.targetHeight).toBeGreaterThanOrEqual(44);
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);

    await bottomNav.getByRole("button", { name: "More" }).click();
    const sheet = page.getByRole("dialog", { name: "More" });
    await expect(sheet).toBeVisible();
    await sheet.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    await expect(sheet.getByRole("link")).toHaveText([
      "Meet",
      "Contacts",
      "Helix AI",
      "Admin",
      "Search",
    ]);
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((sheetBox?.x ?? 0) + (sheetBox?.width ?? 0)).toBeLessThanOrEqual(390);
    expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeLessThanOrEqual(844);

    await sheet.getByRole("link", { name: "Meet" }).click();
    await expect(page).toHaveURL(/\/meet(?:[/?#]|$)/);
    await expect(sheet).toBeHidden();
    await expect(bottomNav.getByRole("button", { name: "More" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("keeps Mail controls usable while section navigation is collapsed", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBackend(page);
    await page.goto("/mail");
    await expect(page.locator(".topbar-title")).toHaveText("Mail");
    const navigation = page.getByRole("button", { name: "Main menu" });
    await expect(navigation).toBeVisible();
    // The sidebar's Compose hides with the menu; the floating Compose stays over the list.
    const sidebarCompose = page
      .getByRole("complementary", { name: "Mail navigation" })
      .getByRole("button", { name: "Compose", exact: true });
    await expect(sidebarCompose).toBeHidden();
    await expect(page.getByRole("button", { name: "Compose", exact: true })).toBeVisible();
    const refresh = page.getByRole("button", { name: "Refresh", exact: true });
    await expect(refresh).toBeVisible();
    await refresh.click();
    await navigation.click();
    await expect(sidebarCompose).toBeVisible();
    await navigation.click();
    await expect(sidebarCompose).toBeHidden();
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
    if (pathname === "/v1/api/auth/get-session") {
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
