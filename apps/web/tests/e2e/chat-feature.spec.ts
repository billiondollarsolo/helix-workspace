/**
 * Chat feature E2E (P1-1) — drives the real /chat UI in a real browser.
 *
 * MOCKED (default): `/api/**` is intercepted with deterministic fixtures.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's chat
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, mintLiveAccessToken } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const chatScope = "platform.read chat.read chat.write";
const roomId = "00000000-0000-4000-8000-000000000501";

test.describe("/chat feature flow", () => {
  test("renders backend chat rooms and a selected room's messages", async ({ page }) => {
    const accessToken = await seedAccessToken(page, chatScope, "e2e-chat-token");
    if (!isLiveBackend()) {
      await mockChatBackend(page, accessToken);
    }

    await page.goto("/chat");

    await expect(page.getByRole("main", { name: "Chat" })).toBeVisible();

    if (!isLiveBackend()) {
      await expect(page.getByText("Backend launch room").first()).toBeVisible();
      await expect(page.getByText("Backend chat message").first()).toBeVisible();
    } else {
      await expect(page.getByText("Chat backend unavailable")).toHaveCount(0);
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

async function mockChatBackend(page: Page, accessToken: string) {
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

    if (pathname === "/api/tools/chat.room.list") {
      await fulfillJson(route, {
        rooms: [
          {
            id: roomId,
            orgId: "00000000-0000-4000-8000-000000000100",
            kind: "chat_room",
            subject: "Backend launch room",
            createdByActorId: "00000000-0000-4000-8000-000000000111",
            members: [
              {
                actorId: "00000000-0000-4000-8000-000000000111",
                role: "owner",
                displayName: "Sam Patel",
                email: "sam@helix.local",
              },
            ],
            settings: {
              threadId: "00000000-0000-4000-8000-000000000444",
              name: "Backend launch room",
              topic: "Launch coordination",
              isPrivate: false,
            },
            createdAt: "2026-05-20T11:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (pathname === "/api/tools/chat.message.list") {
      await fulfillJson(route, {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000601",
            orgId: "00000000-0000-4000-8000-000000000100",
            roomId,
            actorId: "00000000-0000-4000-8000-000000000111",
            body: "Backend chat message",
            bodyFormat: "text",
            attachmentObjectIds: [],
            sentAt: "2026-05-20T12:00:00.000Z",
            editedAt: null,
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (pathname === "/api/tools/chat.search") {
      await fulfillJson(route, { hits: [] });
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
