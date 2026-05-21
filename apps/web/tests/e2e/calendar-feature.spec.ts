/**
 * Calendar feature E2E (P1-1) — drives the real /calendar UI in a real browser.
 *
 * MOCKED (default): `/api/**` is intercepted with deterministic fixtures.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's calendar
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, mintLiveAccessToken } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const accessTokenStorageKey = "helix.accessToken";
const calendarScope = "platform.read calendar.read";
const eventId = "00000000-0000-4000-8000-000000000901";

test.describe("/calendar feature flow", () => {
  test("renders backend calendar events on the board", async ({ page }) => {
    const accessToken = await seedAccessToken(page, calendarScope, "e2e-calendar-token");
    if (!isLiveBackend()) {
      await mockCalendarBackend(page, accessToken);
    }

    await page.goto("/calendar");

    await expect(page.getByRole("main", { name: "Calendar" })).toBeVisible();

    if (!isLiveBackend()) {
      await expect(page.getByText("Backend planning").first()).toBeVisible();
    } else {
      await expect(page.getByText("Calendar backend unavailable")).toHaveCount(0);
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

async function mockCalendarBackend(page: Page, accessToken: string) {
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

    if (pathname === "/api/tools/calendar.event.list") {
      await fulfillJson(route, {
        events: [
          {
            id: eventId,
            calendarId: "00000000-0000-4000-8000-000000000444",
            title: "Backend planning",
            description: "From backend calendar tool",
            location: "Room Backend",
            startsAt: "2026-05-20T09:00:00.000Z",
            endsAt: "2026-05-20T10:00:00.000Z",
            allDay: false,
            status: "confirmed",
            metadata: {},
            attendees: [
              {
                id: "attendee-sam",
                email: "sam@helix.test",
                displayName: "Sam Patel",
                responseStatus: "needs_action",
              },
            ],
          },
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
