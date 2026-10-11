/**
 * Contacts side panel and person hovercard.
 *
 * MOCKED (default): intercepts `/v1/api/**` with fixtures so the real shell
 * renders the people directory without a live backend.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const samActorId = "00000000-0000-4000-8000-000000000111";

test.describe("contacts side panel", () => {
  test.skip(isLiveBackend(), "Mocked people directory fixture");

  test("lists people with human labels and hands off from the hovercard", async ({ page }) => {
    await seedBrowserSession(page, "e2e-people-token");
    await mockPeopleBackend(page);

    await page.goto("/mail");
    await page.getByRole("button", { name: "Contacts", exact: true }).click();

    const list = page.getByRole("list", { name: "Contacts" });
    await expect(list.getByRole("button", { name: /Sam Patel/u })).toBeVisible();
    await expect(list.getByText("Group", { exact: true })).toBeVisible();
    await expect(list.getByText("directory", { exact: true })).toHaveCount(0);

    await list.getByRole("button", { name: /Sam Patel/u }).click();
    const card = page.getByRole("dialog", { name: "Sam Patel contact card" });
    await expect(card).toBeVisible();
    await expect(card.getByText("Engineer")).toBeVisible();
    await expect(card.getByRole("button", { name: "Chat" })).toBeVisible();

    await card.getByRole("button", { name: "Send email" }).click();
    // Mail consumes the compose handoff: a New message window addressed to Sam.
    const compose = page.getByRole("dialog", { name: "New message" });
    await expect(compose.getByRole("list", { name: "To recipients" })).toContainText(
      "sam@helix.local",
    );
  });

  test("searches the directory as you type", async ({ page }) => {
    await seedBrowserSession(page, "e2e-people-token");
    const queries = await mockPeopleBackend(page);

    await page.goto("/mail");
    await page.getByRole("button", { name: "Contacts", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search contacts" }).fill("sales");

    await expect.poll(() => queries.at(-1)).toBe("sales");
    await expect(page.getByText("No people or groups match “sales”.")).toBeVisible();
  });
});

async function mockPeopleBackend(page: Page): Promise<string[]> {
  const queries: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (await fulfillCoreAppsRoute(route)) return;
    if (url.pathname === "/v1/api/people") {
      const query = url.searchParams.get("query") ?? "";
      queries.push(query);
      await fulfillJson(route, {
        people:
          query === ""
            ? [
                {
                  id: samActorId,
                  kind: "directory",
                  actorId: samActorId,
                  email: "sam@helix.local",
                  displayName: "Sam Patel",
                  title: "Engineer",
                  favorite: false,
                  avatarDataUrl: null,
                  relationship: {},
                },
                {
                  id: "00000000-0000-4000-8000-000000000900",
                  kind: "group",
                  actorId: null,
                  email: "launch@helix.local",
                  displayName: "Launch crew",
                  title: null,
                  favorite: false,
                  avatarDataUrl: null,
                  relationship: {},
                },
              ]
            : [],
      });
      return;
    }
    await fulfillJson(route, {});
  });
  return queries;
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
