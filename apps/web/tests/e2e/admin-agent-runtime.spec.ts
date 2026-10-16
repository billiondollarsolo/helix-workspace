import { test, expect, type Page } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend } from "./support/backend-mode";
import { agentRuntimeConfigSchema, type AgentRuntime } from "@helix/contracts";
const actorId = "11111111-1111-4111-8111-111111111111",
  credentialId = "22222222-2222-4222-8222-222222222222";
test.beforeEach(() => test.skip(isLiveBackend(), "Uses isolated agent hosting fixtures."));
async function setup(page: Page, failed = false) {
  const state: { items: AgentRuntime[]; writes: unknown[]; reads: number } = {
    items: [],
    writes: [],
    reads: 0,
  };
  if (failed)
    state.items.push({
      actorId,
      config: agentRuntimeConfigSchema.parse({
        mode: "helix",
        enabled: false,
        credentialId,
        modelId: "test/model",
      }),
      cursor: 1,
      version: 1,
      state: "error",
      lastError: "An interrupted turn needs review.",
      lastRunAt: null,
      conversationId: null,
      interrupted: true,
    });
  await page.route("**/api/**", async (route) => {
    if (await fulfillCoreAppsRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/api/admin/agents")
      return route.fulfill({
        json: {
          agents: [
            {
              id: actorId,
              displayName: "Atlas",
              type: "agent",
              description: "Workspace helper",
              disabled: false,
              createdAt: "2026-10-15T00:00:00Z",
            },
          ],
        },
      });
    if (path === "/v1/api/tools/agent.credentials.list")
      return route.fulfill({
        json: {
          credentials: [
            {
              id: credentialId,
              actorId,
              credentialType: "api_key",
              label: "Atlas runtime",
              purpose: "Testing",
              scopes: ["assistant.write", "notifications.read", "chat.read", "chat.post"],
              clientId: null,
              expiresAt: "2027-01-01T00:00:00Z",
              revokedAt: null,
              lastUsedAt: null,
            },
          ],
        },
      });
    if (path === "/v1/api/admin/agent-runtimes") {
      state.reads++;
      return route.fulfill({
        json: {
          items: state.items,
          models: { models: [{ id: "test/model", label: "Test model" }] },
        },
      });
    }
    if (path === `/v1/api/admin/agent-runtimes/${actorId}`) {
      const body = route.request().postDataJSON() as {
        config: AgentRuntime["config"];
        resetToNow: boolean;
      };
      state.writes.push(body);
      const runtime: AgentRuntime = {
        actorId,
        config: body.config,
        cursor: 1,
        version: 2,
        state: body.config.enabled ? "listening" : "paused",
        lastError: null,
        lastRunAt: null,
        conversationId: null,
        interrupted: false,
      };
      state.items = [runtime];
      return route.fulfill({ json: { runtime } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/admin/agent-credentials");
  await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
  return state;
}
test("configures Helix hosting inline, preserves drafts on refresh, and is accessible", async ({
  page,
}) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Add hosting configuration" }).click();
  await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption(actorId);
  await page.getByLabel("Where the agent runs").selectOption("helix");
  await page.getByRole("combobox", { name: "Credential", exact: true }).selectOption(credentialId);
  await page.getByRole("combobox", { name: "AI model", exact: true }).selectOption("test/model");
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Help Mike in Chat. Keep approvals.");
  await page.getByRole("combobox", { name: "Hosting status", exact: true }).selectOption("true");
  await expect.poll(() => state.reads, { timeout: 15000 }).toBeGreaterThan(1);
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(
    "Help Mike in Chat. Keep approvals.",
  );
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
  await page.getByRole("button", { name: "Save hosting", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({
    config: { mode: "helix", enabled: true, credentialId, modelId: "test/model" },
    resetToNow: false,
  });
  await expect(page.getByRole("table", { name: "Agent hosting" })).toContainText("listening");
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByLabel("Where the agent runs").selectOption("external");
  await expect(page.getByText(/Subscribe to/)).toBeVisible();
  await page.getByRole("button", { name: "Save hosting", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({ config: { mode: "external", enabled: false } });
});
test("requires a concrete recovery decision before skipping interrupted work", async ({ page }) => {
  const state = await setup(page, true);
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByRole("button", { name: "Review and start from now" }).click();
  expect(state.writes).toHaveLength(0);
  await expect(page.getByRole("alertdialog")).toContainText("skips the unprocessed event backlog");
  await page.getByRole("button", { name: "Start from now", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ resetToNow: true });
});
