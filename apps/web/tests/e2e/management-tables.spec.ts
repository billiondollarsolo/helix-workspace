import axe from "axe-core";
import { expect, test, type Page } from "@playwright/test";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

const stamp = "2026-10-01T12:00:00Z";
const people = ["Zebra", "Atlas"].map((displayName, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  orgId: "00000000-0000-0000-0000-000000000000",
  displayName,
  description: "Scheduled workspace tasks",
  type: "agent",
  email: `${displayName.toLowerCase()}@example.test`,
  disabled: false,
  status: "active",
  scopes: ["platform.read"],
  createdAt: stamp,
  updatedAt: stamp,
  lastSignInAt: null,
  disabledAt: null,
}));
const credentials = people.map((person) => ({
  id: person.id,
  actorId: person.id,
  label: `${person.displayName} key`,
  credentialType: "api_key",
  purpose: "Scheduled work",
  scopes: ["platform.read"],
  clientId: null,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: stamp,
}));

async function install(page: Page, theme: string) {
  await page.addInitScript((theme) => {
    localStorage.setItem("helix.accessToken", "e2e-admin");
    localStorage.setItem("helix-appearance", JSON.stringify({ theme }));
  }, theme);
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith("/admin/agents")) json = { agents: people };
    else if (path.endsWith("/admin/users")) json = { users: people, nextCursor: null };
    else if (path.endsWith("/agent.account.requests.list")) json = { requests: [] };
    else if (path.endsWith("/agent.credentials.list")) json = { credentials };
    else if (path.endsWith("/app.passwords.list")) json = { appPasswords: credentials };
    else if (path.endsWith("/ai/cost-limits"))
      json = {
        tierDefault: { tier: "business", actorDailyUsd: 10, featureDailyUsd: null },
        limits: people.map((person, index) => ({
          actorId: person.id,
          actorDailyUsd: index === 0 ? 20 : 3,
          featureDailyUsd: null,
          updatedByActorId: null,
          updatedAt: stamp,
        })),
      };
    else if (path.endsWith("/webhook.overview"))
      json = {
        outbound: people.map((person) => ({
          id: person.id,
          orgId: person.orgId,
          name: person.displayName,
          url: `https://hooks.example.test/${person.displayName.toLowerCase()}`,
          eventSubjects: ["activity.mail.received"],
          secretRef: "never-index-this-secret",
          headers: {},
          enabled: true,
          metadata: {},
          createdByActorId: null,
          createdAt: stamp,
          updatedAt: stamp,
        })),
        inbound: [],
        deliveries: [],
      };
    await route.fulfill({ json });
  });
}

const screens = [
  ["agent-credentials", "Agent credentials", "Credential"],
  ["app-passwords", "App passwords", "Label"],
  ["ai-costs", "Per-user AI cost limits", "Person"],
  ["webhooks", "Outbound webhooks", "Name"],
] as const;

for (const width of [390, 768, 1440]) {
  for (const theme of ["light", "dark"]) {
    for (const [section, label, column] of screens) {
      test(`${section}: sortable searchable accessible list at ${width}px ${theme}`, async ({
        page,
      }, testInfo) => {
        test.skip(isLiveBackend(), "Uses isolated management-list fixtures.");
        await page.setViewportSize({ width, height: 900 });
        await install(page, theme);
        await page.goto(`/admin/${section}`);
        const table = page.getByRole("table", { name: label, exact: true });
        await expect(table).toContainText("Atlas");
        if (width <= 640) {
          await page
            .getByRole("combobox", { name: `Sort ${label.toLowerCase()}` })
            .selectOption({ label: `${column} (ascending)` });
        } else await table.getByRole("button", { name: column, exact: true }).click();
        await expect(table.locator("tbody tr").first()).toContainText("Atlas");
        const search = page.getByRole("searchbox", { name: `Search ${label.toLowerCase()}` });
        await search.fill("zebra");
        await expect(table.locator("tbody tr")).toHaveCount(1);
        await expect(table).toContainText("Zebra");
        await search.fill("never-index-this-secret");
        await expect(table).toContainText("No matching results");
        await search.fill("");
        await expect(table.locator("tbody tr")).toHaveCount(2);
        await expect(table.locator("tbody tr").first()).toContainText("Atlas");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await page.addScriptTag({ content: axe.source });
        const violations = await page.evaluate(async () => {
          const browser = window as typeof window & { axe: typeof axe };
          return (
            await browser.axe.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
            })
          ).violations;
        });
        expect(violations).toEqual([]);
        if (section !== "webhooks") {
          const [action, title] =
            section === "agent-credentials"
              ? ["Add credential", "Create credential"]
              : section === "app-passwords"
                ? ["Add app password", "Create app password"]
                : ["Add limit", "Set a person's AI budget"];
          await expect(page.getByRole("dialog", { name: title, exact: true })).toHaveCount(0);
          await page.getByRole("button", { name: action, exact: true }).click();
          const panel = page.getByRole("dialog", { name: title, exact: true });
          await expect(panel).toBeVisible();
          await expect(panel).not.toHaveAttribute("aria-modal", "true");
          if (section === "agent-credentials") {
            await panel.locator("#agent-actor-id").selectOption({ label: "Atlas" });
            await expect(panel.locator("#agent-actor-id")).toHaveValue(people[1]!.id);
          }
          const panelViolations = await page.evaluate(async () => {
            const browser = window as typeof window & { axe: typeof axe };
            return (
              await browser.axe.run(document, {
                runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
              })
            ).violations;
          });
          expect(panelViolations).toEqual([]);
          await page.screenshot({
            path: testInfo.outputPath("management-panel.png"),
            fullPage: true,
          });
          await panel.getByRole("button", { name: "Close", exact: true }).click();
          await expect(panel).toHaveCount(0);
          await expect(table.locator("tbody tr").first()).toContainText("Atlas");
        }
        await page.screenshot({ path: testInfo.outputPath("management-list.png"), fullPage: true });
      });
    }
  }
}
