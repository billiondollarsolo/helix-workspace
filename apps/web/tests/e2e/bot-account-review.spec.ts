import { test, expect } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";

test("bot requests are searchable, reviewable and accessible without a blocking creation modal", async ({
  page,
}) => {
  test.skip(isLiveBackend(), "Uses an isolated account-request fixture.");
  const requests = ["Beacon", "Atlas"].map((name, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    externalBotId: `local:${name}`,
    displayName: name,
    purpose: "Local integration",
    requestedEmail: `${name.toLowerCase()}@example.test`,
    requestedScopes: ["platform.read", "chat.read"],
    status: "pending",
    actorId: null,
    credentialId: null,
    credentialExpiresAt: null,
    ownerActorId: null,
    approvedScopes: [],
    approvedEmail: null,
    reason: null,
    createdAt: "2026-10-16T00:00:00Z",
    expiresAt: "2026-10-23T00:00:00Z",
    reviewUrl: "/admin/agent-credentials",
  }));
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith("/agent.account.requests.list")) json = { requests };
    else if (path.endsWith("/agent.credentials.list")) json = { credentials: [] };
    else if (path.endsWith("/admin/agents")) json = { agents: [] };
    else if (path.endsWith("/admin/users")) json = { users: [], nextCursor: null };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(json) });
  });
  await page.goto("/admin/agent-credentials");
  const table = page.getByRole("table", { name: "Bot account requests", exact: true });
  await expect(table).toContainText("Beacon");
  await page.getByRole("searchbox", { name: "Search bot account requests" }).fill("Beacon");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await table.getByRole("button", { name: "Review", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Review Beacon", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute("aria-modal", "true");
  await expect(panel.getByLabel("Bot email address", { exact: true })).toHaveValue(
    "beacon@example.test",
  );
  await expect(panel.getByRole("button", { name: "Approve reviewed account" })).toBeDisabled();
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(
    async () =>
      (
        await (window as typeof window & { axe: typeof axe }).axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
        })
      ).violations,
  );
  expect(violations).toEqual([]);
});
