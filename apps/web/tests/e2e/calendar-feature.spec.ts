/**
 * Calendar feature E2E (P1-1) — drives the real /calendar UI in a real browser.
 *
 * MOCKED (default): `/v1/api/**` is intercepted with deterministic fixtures.
 * LIVE (`HELIX_E2E_BACKEND=live`): drives the docker-compose backend's calendar
 * tools with a real OAuth token. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";

const eventId = "00000000-0000-4000-8000-000000000901";

test.describe("/calendar feature flow", () => {
  test("renders backend calendar events on the board", async ({ page }) => {
    if (!isLiveBackend()) await page.clock.setFixedTime(new Date("2026-05-20T12:00:00Z"));
    const accessToken = await seedBrowserSession(page, "e2e-calendar-token");
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

async function mockCalendarBackend(page: Page, accessToken: string) {
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

    if (pathname === "/v1/api/tools/calendar.event.list") {
      await fulfillJson(route, {
        events: [
          {
            id: eventId,
            calendarId: "00000000-0000-4000-8000-000000000444",
            title: "Backend planning",
            description: "From backend calendar tool",
            location: "Room Backend",
            startsAt: "2026-05-20T14:00:00.000Z",
            endsAt: "2026-05-20T15:00:00.000Z",
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
