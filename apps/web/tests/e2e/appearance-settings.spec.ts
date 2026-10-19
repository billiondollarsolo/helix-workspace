import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

test.beforeEach(() => {
  test.skip(isLiveBackend(), "Appearance is client-side; the mock backend keeps it isolated.");
});

async function mockBackend(page: Page) {
  await seedBrowserSession(page, "appearance-settings-session");
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/api/auth/get-session") {
      await fulfillJson(route, {
        user: { id: "appearance-user", email: "lea@example.test", name: "Léa Nguyen" },
      });
      return;
    }
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname === "/v1/api/tools/assistant.conversations.list") {
      await fulfillJson(route, { items: [], nextCursor: null });
      return;
    }
    await fulfillJson(route, {});
  });
}

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function stored(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("helix-appearance") ?? "{}"));
}

test("System theme follows the device and explicit choices persist", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await mockBackend(page);
  await page.goto("/assistant?settings=appearance");
  const settings = page.getByRole("dialog", { name: "Personal settings", exact: true });
  const theme = settings.getByRole("group", { name: "Theme" });

  await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await theme.locator("label", { hasText: "Dark" }).click();
  await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const density = settings.getByRole("group", { name: "Density" });
  await expect(density.getByRole("radio")).toHaveCount(3);
  await density.getByRole("radio", { name: /Compact/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  expect(await stored(page)).toMatchObject({ theme: "dark", density: "compact" });

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`appearance settings are accessible in ${colorScheme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await mockBackend(page);
    await page.goto("/assistant?settings=appearance");
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await expect(page.getByRole("radio", { name: "System" })).toBeVisible();
    await page.addScriptTag({ content: axe.source });
    const violations = await page.evaluate(async () => {
      const browser = window as typeof window & { axe: typeof axe };
      const result = await browser.axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
        },
      });
      return result.violations.map((violation) => violation.id);
    });
    expect(violations).toEqual([]);
  });
}
