import { expect, test } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

for (const width of [1440, 390]) {
  test(`Workspace administration shares the federation structure at ${width}px`, async ({
    page,
  }) => {
    test.skip(isLiveBackend(), "Management navigation uses an isolated backend fixture.");
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/**", async (route) => {
      if (await fulfillCoreAppsRoute(route)) return;
      const path = new URL(route.request().url()).pathname;
      if (path === "/v1/api/admin/tenant-config")
        return route.fulfill({
          json: {
            tenantConfig: {
              orgId: "00000000-0000-4000-8000-000000000001",
              orgName: "Example organization",
              byo: {},
              features: {},
              quotas: {},
              branding: {},
              effective: { byo: {}, features: {}, quotas: {}, branding: {} },
            },
          },
        });
      if (path === "/v1/api/admin/federation-applications")
        return route.fulfill({
          json: {
            applications: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                origin: "https://bot.example.test",
                status: "active",
                installationId: "installation",
                tenantId: "team",
                lastSyncedAt: null,
                error: null,
                pending: false,
                rotationPending: false,
              },
            ],
          },
        });
      return route.fulfill({ json: { applications: [], targets: [], jobs: [] } });
    });
    await page.goto("/admin/federation-backups");
    await expect(
      page.getByRole("heading", { name: "Federated backups", exact: true }),
    ).toBeVisible();
    if (width < 600) await page.getByRole("button", { name: "Main menu", exact: true }).click();
    const nav = page.getByRole("navigation", { name: "Administration", exact: true });
    await expect(nav.getByText("Helix Workspace", { exact: true })).toBeVisible();
    await expect(nav.getByText("Example organization", { exact: true })).toBeVisible();
    for (const name of [
      "People and access",
      "Workspace settings",
      "Federation",
      "Activity",
      "Operations",
    ])
      await expect(nav.getByRole("heading", { name, exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Federated apps", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Federated apps", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View app details", exact: true }).click();
    await expect(page.getByText("Managed by Workspace", { exact: true })).toBeVisible();
    await expect(page.getByText("Managed in Helix Agentspace", { exact: true })).toBeVisible();
    if (width < 600) {
      await expect(nav).toBeHidden();
      await page.getByRole("button", { name: "Main menu", exact: true }).click();
    }
    await nav.getByRole("button", { name: "Personal settings", exact: true }).click();
    const personal = page.getByRole("dialog", { name: "Personal settings", exact: true });
    await expect(personal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(personal).toBeHidden();
    if (width < 600) await page.getByRole("button", { name: "Main menu", exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(0);
    await page.addScriptTag({ content: axe.source });
    expect(
      await page.evaluate(
        async () =>
          (
            await (window as typeof window & { axe: typeof axe }).axe.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
            })
          ).violations,
      ),
    ).toEqual([]);
  });
}
