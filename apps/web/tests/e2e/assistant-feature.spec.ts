/**
 * Assistant feature E2E (P1-1) — drives the real /assistant UI in a real browser.
 *
 * MOCKED (default): `/v1/api/**` is intercepted; the assistant.chat tool returns a
 * deterministic turn with a pending tool-call confirmation.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's assistant
 * tool with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { FAKE_MODEL_REPLY_PREFIX } from "./support/fake-model-server";

const prompt = "Share the Q3 Launch PRD with Bruno.";

test.describe("/assistant feature flow", () => {
  test("sends a prompt and renders the backend assistant turn", async ({ page }) => {
    const accessToken = await seedBrowserSession(page, "e2e-assistant-token");
    if (!isLiveBackend()) {
      await mockAssistantBackend(page, accessToken);
    }

    await page.goto("/assistant");

    await expect(page.getByRole("main", { name: "Helix AI" })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Apps" })
        .getByRole("link", { name: "Helix AI", exact: true }),
    ).toBeVisible();

    const composer = page.getByRole("textbox", { name: "Message Helix AI" });
    await composer.fill(prompt);

    const modelPicker = page.getByRole("combobox", { name: "Assistant model" });
    await expect(modelPicker).not.toHaveText("Loading models…");
    await expect(modelPicker).toBeEnabled();
    await page.getByRole("button", { name: "Send message" }).click();

    // The user's prompt is echoed into the conversation regardless of backend.
    // The composer clears during sending and restores the draft if the request fails.
    const conversation = page.getByTestId("assistant-conversation");
    await expect(conversation.getByText(prompt, { exact: true })).toBeVisible();

    // Live runs answer through support/fake-model-server.mjs, a deterministic
    // OpenAI-compatible model, so the full provider round trip is exercised.
    await expect(
      conversation.getByText(
        isLiveBackend()
          ? `${FAKE_MODEL_REPLY_PREFIX} ${prompt}`
          : "I found the PRD and need approval before sharing it.",
      ),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("turns a tool group off and retries when the tool limit is exceeded", async ({ page }) => {
    test.skip(isLiveBackend(), "The live tool registry stays under the provider limit.");
    const accessToken = await seedBrowserSession(page, "e2e-assistant-limit-token");
    const chatBodies: Record<string, unknown>[] = [];
    await mockAssistantBackend(page, accessToken, chatBodies);
    await page.goto("/assistant");

    await page.getByRole("textbox", { name: "Message Helix AI" }).fill("Audit the workspace");
    const modelPicker = page.getByRole("combobox", { name: "Assistant model" });
    await expect(modelPicker.locator("option")).toHaveText(["Claude Sonnet 4.5"]);

    // The tool-group selector shows each group's size and the provider limit.
    await page.getByRole("button", { name: "More composer options" }).click();
    await page.getByRole("menuitem", { name: "Tools", exact: true }).hover();
    const automatic = page.getByRole("menuitemcheckbox", { name: "Choose automatically" });
    await expect(automatic).toBeChecked();
    await expect(page.getByText("Helix AI picks up to 128 tools for each request")).toBeVisible();
    await automatic.click();
    await page.getByRole("menuitemcheckbox", { name: "Administration (40)" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Webhooks (12)" }).click();
    await expect(page.getByText("143 of 128 tools on")).toBeVisible();
    await expect(page.getByText("15 over the limit")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Send message" }).click();

    const conversation = page.getByTestId("assistant-conversation");
    await expect(
      conversation.getByRole("alert").filter({ hasText: "Too many tool groups are on" }),
    ).toContainText("(143 of 128 tools)");
    await conversation.getByRole("button", { name: "Turn off Administration (40)" }).click();

    await expect(conversation.getByText("Here is the audit.")).toBeVisible();
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]?.toolGroups).toEqual(["mail", "admin", "webhooks"]);
    expect(chatBodies[1]?.toolGroups).toEqual(["mail", "webhooks"]);
  });
});

test("rates a saved answer and keeps its cited items and rating after reload", async ({ page }) => {
  test.skip(isLiveBackend(), "Feedback round trip uses a deterministic mock turn.");
  await seedBrowserSession(page, "e2e-assistant-feedback-token");
  const conversationId = "00000000-0000-4000-8000-000000000501";
  const answerId = "00000000-0000-4000-8000-000000000503";
  let rating: "up" | "down" | null = null;
  const feedbackBodies: unknown[] = [];
  const turn = () => ({
    conversation: { id: conversationId },
    response: { id: answerId, content: "The launch plan is in Drive." },
    messages: [
      { id: "00000000-0000-4000-8000-000000000502", role: "user", content: "Where is the plan?" },
      {
        id: answerId,
        role: "assistant",
        content: "The launch plan is in Drive.",
        citations: [{ kind: "drive", id: "file-77", title: "Launch plan", path: "/drive/file-77" }],
        ...(rating === null
          ? {}
          : { feedback: { rating, comment: null, updatedAt: "2026-10-01" } }),
      },
    ],
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (await fulfillCoreAppsRoute(route)) return;
    if (pathname === "/v1/api/tools/assistant.models.list") {
      await fulfillJson(route, {
        models: [{ id: "test/model", label: "Test model", providerId: "test", model: "model" }],
        defaultModelId: "test/model",
      });
      return;
    }
    if (pathname === "/v1/api/tools/assistant.message.feedback") {
      const body = request.postDataJSON() as { rating: "up" | "down" | null };
      feedbackBodies.push(body);
      rating = body.rating;
      await fulfillJson(route, {
        messageId: answerId,
        feedback: rating === null ? null : { rating, comment: null, updatedAt: "2026-10-01" },
      });
      return;
    }
    if (
      pathname === "/v1/api/tools/assistant.chat" ||
      pathname === "/v1/api/tools/assistant.conversation.get"
    ) {
      await fulfillJson(route, turn());
      return;
    }
    await fulfillJson(route, {});
  });

  await page.goto("/assistant");
  await page.getByRole("textbox", { name: "Message Helix AI" }).fill("Where is the plan?");
  await page.getByRole("button", { name: "Send message" }).click();
  const conversation = page.getByTestId("assistant-conversation");
  await expect(conversation.getByText("The launch plan is in Drive.")).toBeVisible();
  const sources = conversation.getByRole("list", { name: "Workspace sources" });
  await expect(sources.getByRole("link", { name: "Launch plan" })).toHaveAttribute(
    "href",
    "/drive?file=file-77",
  );

  const good = conversation.getByRole("button", { name: "Good response" });
  await good.click();
  await expect(good).toHaveAttribute("aria-pressed", "true");
  // The rating shows optimistically; the buttons stay disabled until the save settles.
  await expect(good).toBeEnabled();
  await expect(good).toHaveAttribute("aria-pressed", "true");
  expect(feedbackBodies).toEqual([{ conversationId, messageId: answerId, rating: "up" }]);

  await page.goto(`/assistant?conversation=${conversationId}`);
  await expect(
    page.getByTestId("assistant-conversation").getByRole("button", { name: "Good response" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByRole("list", { name: "Workspace sources" })
      .getByRole("link", { name: "Launch plan" }),
  ).toBeVisible();
});

async function mockAssistantBackend(
  page: Page,
  accessToken: string,
  limitedChatBodies?: Record<string, unknown>[],
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (await fulfillCoreAppsRoute(route)) return;

    if (!(request.headers().cookie ?? "").includes(`helix_session=${accessToken}`)) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "missing bearer token" }),
      });
      return;
    }

    if (pathname === "/v1/api/tools/assistant.models.list") {
      await fulfillJson(
        route,
        limitedChatBodies === undefined
          ? {
              models: [
                { id: "test/model", label: "Test model", providerId: "test", model: "model" },
              ],
              defaultModelId: "test/model",
            }
          : {
              models: [
                {
                  id: "anthropic/claude-sonnet-4-5",
                  label: "anthropic · claude-sonnet-4-5",
                  providerId: "anthropic",
                  model: "claude-sonnet-4-5",
                },
              ],
              defaultModelId: "anthropic/claude-sonnet-4-5",
            },
      );
      return;
    }

    if (limitedChatBodies !== undefined && pathname === "/v1/api/tools/assistant.tools.list") {
      await fulfillJson(route, {
        limit: 128,
        groups: [
          { id: "mail", label: "Mail", count: 91, defaultEnabled: true },
          { id: "admin", label: "Administration", count: 40, defaultEnabled: false },
          { id: "webhooks", label: "Webhooks", count: 12, defaultEnabled: false },
        ],
      });
      return;
    }

    if (limitedChatBodies !== undefined && pathname === "/v1/api/tools/assistant.chat") {
      const body = request.postDataJSON() as Record<string, unknown>;
      limitedChatBodies.push(body);
      if (limitedChatBodies.length === 1) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "assistant_tool_limit_exceeded",
              message: "The selected tool groups include 143 tools; the limit is 128.",
              traceId: "trace-limit",
              details: {
                limit: 128,
                selected: 143,
                excess: 15,
                groups: [
                  { id: "mail", label: "Mail", count: 91 },
                  { id: "admin", label: "Administration", count: 40 },
                  { id: "webhooks", label: "Webhooks", count: 12 },
                ],
              },
            },
          }),
        });
        return;
      }
      await fulfillJson(route, {
        conversation: { id: "00000000-0000-4000-8000-000000000321" },
        response: { id: "00000000-0000-4000-8000-000000000322", content: "Here is the audit." },
      });
      return;
    }

    if (pathname === "/v1/api/tools/assistant.chat") {
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
