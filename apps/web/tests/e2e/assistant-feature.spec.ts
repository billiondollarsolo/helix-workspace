/**
 * Assistant feature E2E (P1-1) — drives the real /assistant UI in a real browser.
 *
 * MOCKED (default): `/api/**` is intercepted; the assistant.chat tool returns a
 * deterministic turn with a pending tool-call confirmation.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's assistant
 * tool with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, mintLiveAccessToken } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const assistantScope = "platform.read assistant.chat";
const prompt = "Share the Q3 Launch PRD with Bruno.";

test.describe("/assistant feature flow", () => {
  test("sends a prompt and renders the backend assistant turn", async ({ page }) => {
    const accessToken = await seedAccessToken(page, assistantScope, "e2e-assistant-token");
    if (!isLiveBackend()) {
      await mockAssistantBackend(page, accessToken);
    }

    await page.goto("/assistant");

    await expect(page.getByRole("main", { name: "Assistant" })).toBeVisible();

    const composer = page.locator("#assistant-composer-body");
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();

    // The user's prompt is echoed into the conversation regardless of backend.
    await expect(page.getByText(prompt)).toBeVisible();

    if (!isLiveBackend()) {
      await expect(
        page.getByText("I found the PRD and need approval before sharing it."),
      ).toBeVisible();
      await expect(page.getByText("drive.share", { exact: true })).toBeVisible();
    }
  });
});

async function seedAccessToken(page: Page, scope: string, mockToken: string): Promise<string> {
  const token = isLiveBackend() ? await mintLiveAccessToken(scope) : mockToken;
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: accessTokenStorageKey, value: token },
  );
  return token;
}

async function mockAssistantBackend(page: Page, accessToken: string) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (request.headers().authorization !== `Bearer ${accessToken}`) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing bearer token" }),
      });
      return;
    }

    if (pathname === "/api/tools/assistant.chat") {
      await fulfillJson(route, {
        conversation: { id: "00000000-0000-4000-8000-000000000123" },
        response: {
          id: "00000000-0000-4000-8000-000000000124",
          content: "I found the PRD and need approval before sharing it.",
          createdAt: "2026-05-20T12:00:00.000Z",
        },
        ai: {
          providerId: "openai-compatible.test",
          model: "test-model",
          usage: { inputTokens: 123, outputTokens: 45, costCents: 0.12 },
          metadata: { promptHash: "sha256:backend-test", traceId: "trace-backend-test" },
        },
        sources: [
          {
            id: "source-launch-prd",
            title: "Launch PRD",
            type: "drive.object",
            url: "drive.object/launch-prd",
          },
        ],
        toolCalls: [
          {
            toolCallId: "tool-call-share-prd",
            toolId: "drive.share",
            input: { objectId: "launch-prd" },
            status: "pending",
            pending: { id: "00000000-0000-4000-8000-000000000999", toolId: "drive.share" },
          },
        ],
        pendingConfirmations: [
          { id: "00000000-0000-4000-8000-000000000999", toolId: "drive.share" },
        ],
      });
      return;
    }

    // The production shell calls GET /api/core-apps on mount; serve the
    // shared valid CoreAppShellStatus fixture so the shell never crashes.
    if (await fulfillCoreAppsRoute(route)) {
      return;
    }

    await fulfillJson(route, {});
  });
}

async function fulfillJson(route: Route, value: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}
