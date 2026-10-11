/**
 * Calendar feature E2E — drives the real /calendar UI in a real browser.
 *
 * MOCKED (default): `/v1/api/**` is intercepted with an in-memory calendar so
 * creates, edits and deletes show up after the UI refetches.
 * LIVE (`HELIX_E2E_BACKEND=live`): only the first test runs, against the
 * docker-compose backend. See `support/backend-mode.ts`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import axe from "axe-core";
import { fulfillCoreAppsRoute } from "./support/api-fixtures";
import { isLiveBackend, seedBrowserSession } from "./support/backend-mode";

const EVENT_ID = "00000000-0000-4000-8000-000000000901";
const CALENDAR_ID = "00000000-0000-4000-8000-000000000444";

interface MockEvent {
  id: string;
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  timeSemantics: "zoned";
  allDay: boolean;
  status: "confirmed";
  recurrenceRule: string | null;
  metadata: Record<string, unknown>;
  attendees: readonly Record<string, unknown>[];
}

interface ToolCall {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

test.use({ timezoneId: "UTC" });

function planningEvent(): MockEvent {
  return {
    id: EVENT_ID,
    calendarId: CALENDAR_ID,
    title: "Backend planning",
    description: "From backend calendar tool",
    location: "Room Backend",
    startsAt: "2026-05-20T14:00:00.000Z",
    endsAt: "2026-05-20T15:00:00.000Z",
    timezone: "UTC",
    timeSemantics: "zoned",
    allDay: false,
    status: "confirmed",
    recurrenceRule: null,
    metadata: {},
    attendees: [
      {
        id: "attendee-sam",
        email: "sam@helix.test",
        displayName: "Sam Patel",
        responseStatus: "needs_action",
      },
    ],
  };
}

async function openCalendar(
  page: Page,
  path = "/calendar?date=2026-05-20",
  extraEvents: readonly MockEvent[] = [],
) {
  await page.clock.setFixedTime(new Date("2026-05-20T12:00:00Z"));
  const accessToken = await seedBrowserSession(page, "e2e-calendar-token");
  const calls: ToolCall[] = [];
  if (!isLiveBackend()) await mockCalendarBackend(page, accessToken, calls, extraEvents);
  await page.goto(path);
  await expect(page.getByRole("main", { name: "Calendar" })).toBeVisible();
  return calls;
}

async function expectNoAxeViolations(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const browser = window as typeof window & { axe: typeof axe };
    const result = await browser.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
      },
    });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`);
  });
  expect(violations).toEqual([]);
}

test.describe("/calendar feature flow", () => {
  test("renders backend calendar events on the week grid", async ({ page }) => {
    await openCalendar(page);
    if (isLiveBackend()) {
      await expect(page.getByText("Couldn't load events")).toHaveCount(0);
      return;
    }
    await expect(page.getByRole("button", { name: /^Backend planning, 2 – 3pm/ })).toBeVisible();
    await expect(page.locator("[data-day]")).toHaveCount(7);
    await expect(page.locator('.cal-grid [aria-current="date"]')).toHaveCount(1);
  });

  test.describe("mocked backend", () => {
    test.skip(isLiveBackend(), "drives an in-memory calendar");

    test("switches between views from the menu and the keyboard", async ({ page }) => {
      await openCalendar(page);
      await page.getByRole("button", { name: "View: Week" }).click();
      await page.getByRole("menuitemradio", { name: /Month/ }).click();
      await expect(page.getByRole("region", { name: "Month" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "May 2026" })).toBeVisible();

      await page.keyboard.press("d");
      await expect(page.locator("[data-day]")).toHaveCount(1);
      await page.keyboard.press("a");
      await expect(page.getByRole("region", { name: "Schedule" })).toContainText(
        "Backend planning",
      );
      await page.keyboard.press("x");
      await expect(page.locator("[data-day]")).toHaveCount(3);
      await page.keyboard.press("w");
      await expect(page.locator("[data-day]")).toHaveCount(7);
    });

    test("creates an event by dragging across empty time", async ({ page }) => {
      const calls = await openCalendar(page);
      const column = page.locator('[data-day="2026-05-21"]');
      const box = await column.boundingBox();
      if (box === null) throw new Error("day column is not laid out");
      const yAt = (hour: number) => box.y + (box.height * hour) / 24 + 2;
      await page.mouse.move(box.x + 20, yAt(13));
      await page.mouse.down();
      await page.mouse.move(box.x + 20, yAt(14.5), { steps: 6 });
      await page.mouse.up();

      const quickCreate = page.getByRole("dialog", { name: "Create event" });
      await expect(quickCreate).toContainText("Thursday, May 21 · 1 – 2:30pm");
      await quickCreate.getByRole("textbox", { name: "Title" }).fill("Roadmap sync");
      await quickCreate.getByRole("button", { name: "Save" }).click();

      await expect(page.getByRole("button", { name: /^Roadmap sync, 1 – 2:30pm/ })).toBeVisible();
      expect(calls.find((call) => call.tool === "calendar.event.create")?.body).toMatchObject({
        title: "Roadmap sync",
        startsAt: "2026-05-21T13:00:00.000Z",
        endsAt: "2026-05-21T14:30:00.000Z",
      });
    });

    test("edits an event to repeat weekly", async ({ page }) => {
      const calls = await openCalendar(page);
      await page.getByRole("button", { name: /^Backend planning/ }).click();
      await page.getByRole("button", { name: "Edit event" }).click();
      const editor = page.getByRole("region", { name: "Edit event" });
      await expect(editor.getByRole("textbox", { name: "Title" })).toHaveValue("Backend planning");
      await editor.getByLabel("Repeat").selectOption("weekly");
      await editor.getByRole("button", { name: "Save" }).click();

      await expect(
        page.getByRole("button", { name: /^Backend planning, .*Repeats/ }).first(),
      ).toBeVisible();
      expect(calls.find((call) => call.tool === "calendar.event.update")?.body).toMatchObject({
        eventId: EVENT_ID,
        patch: { recurrenceRule: "FREQ=WEEKLY;BYDAY=WE" },
      });
    });

    test("deletes with Undo, then for real when the snackbar closes", async ({ page }) => {
      const calls = await openCalendar(page);
      const chip = page.getByRole("button", { name: /^Backend planning/ });
      await chip.click();
      await page.keyboard.press("Delete");
      await expect(chip).toHaveCount(0);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(chip).toBeVisible();
      expect(calls.some((call) => call.tool === "calendar.event.delete")).toBe(false);

      await chip.click();
      await page.getByRole("button", { name: "Delete event" }).click();
      await expect(chip).toHaveCount(0);
      await page.getByRole("button", { name: "Dismiss" }).click();
      await expect
        .poll(() => calls.some((call) => call.tool === "calendar.event.delete"))
        .toBe(true);
      await expect(chip).toHaveCount(0);
    });

    test("joins Helix Meet calls in the app and shows other meetings as plain links", async ({
      page,
    }) => {
      const joinUrl = "https://helix.example.test/meet?code=abc-defg-hij";
      await openCalendar(page, "/calendar?date=2026-05-20", [
        {
          ...planningEvent(),
          id: "00000000-0000-4000-8000-000000000903",
          title: "Design sync",
          location: null,
          startsAt: "2026-05-20T09:00:00.000Z",
          endsAt: "2026-05-20T10:00:00.000Z",
          metadata: {
            conference: { provider: "meet", roomId: "room-1", joinCode: "abc-defg-hij", joinUrl },
          },
        },
        {
          ...planningEvent(),
          id: "00000000-0000-4000-8000-000000000904",
          title: "Vendor call",
          location: null,
          startsAt: "2026-05-20T16:00:00.000Z",
          endsAt: "2026-05-20T17:00:00.000Z",
          metadata: {
            source: "mail.invitation",
            conference: { provider: "external", joinUrl: "https://video.example.org/j/42" },
          },
        },
      ]);

      await page.getByRole("button", { name: /^Design sync, 9 – 10am/ }).click();
      await expect(page.getByRole("link", { name: "Join with Helix Meet" })).toHaveAttribute(
        "href",
        joinUrl,
      );
      await page.keyboard.press("Escape");

      await page.getByRole("button", { name: /^Vendor call, 4 – 5pm/ }).click();
      const external = page.getByRole("link", { name: "https://video.example.org/j/42" });
      await expect(external).toHaveAttribute("target", "_blank");
      await expect(external).toHaveAttribute("rel", "noopener noreferrer");
      await expect(page.getByRole("link", { name: "Join with Helix Meet" })).toHaveCount(0);
    });

    test("shows three days and the schedule on a phone", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openCalendar(page);
      await expect(page.getByRole("button", { name: "View: 3 days" })).toBeVisible();
      await expect(page.locator("[data-day]")).toHaveCount(3);
      await page.getByRole("button", { name: "View: 3 days" }).click();
      await expect(page.getByRole("menuitemradio", { name: /Week/ })).toHaveCount(0);
      await page.getByRole("menuitemradio", { name: /Schedule/ }).click();
      await expect(page.getByRole("region", { name: "Schedule" })).toContainText(
        "Backend planning",
      );
      await expect(page.getByRole("button", { name: "Create event" })).toBeVisible();
    });

    for (const colorScheme of ["light", "dark"] as const) {
      test(`calendar pages have no accessibility violations in ${colorScheme} mode`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await openCalendar(page);
        await expect(page.getByRole("button", { name: /^Backend planning/ })).toBeVisible();
        await expectNoAxeViolations(page);

        await page.getByRole("button", { name: /^Backend planning/ }).click();
        await expect(page.getByRole("dialog", { name: "Event: Backend planning" })).toBeVisible();
        await expectNoAxeViolations(page);
        await page.keyboard.press("Escape");

        await page.keyboard.press("m");
        await expect(page.getByRole("region", { name: "Month" })).toBeVisible();
        await expectNoAxeViolations(page);

        await page.keyboard.press("c");
        await expect(page.getByRole("region", { name: "New event" })).toBeVisible();
        await expectNoAxeViolations(page);
      });
    }
  });
});

async function mockCalendarBackend(
  page: Page,
  accessToken: string,
  calls: ToolCall[],
  extraEvents: readonly MockEvent[],
) {
  const events: MockEvent[] = [planningEvent(), ...extraEvents];
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

    const tool = pathname.split("/v1/api/tools/")[1];
    if (tool === undefined) {
      await fulfillJson(route, {});
      return;
    }
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ tool, body });

    if (tool === "calendar.calendars.list") {
      await fulfillJson(route, {
        calendars: [
          {
            id: CALENDAR_ID,
            name: "Team planning",
            color: "#0f766e",
            role: "owner",
            visible: true,
            group: "mine",
            writable: true,
            timezone: "UTC",
          },
        ],
      });
      return;
    }
    if (tool === "calendar.event.list") {
      await fulfillJson(route, { events });
      return;
    }
    if (tool === "calendar.event.create") {
      const created: MockEvent = {
        ...planningEvent(),
        ...(body as Partial<MockEvent>),
        id: "00000000-0000-4000-8000-000000000902",
        attendees: [],
      };
      events.push(created);
      await fulfillJson(route, created);
      return;
    }
    if (tool === "calendar.event.update") {
      const patch = (body.patch ?? {}) as Partial<MockEvent>;
      const index = events.findIndex((event) => event.id === body.eventId);
      const current = events[index];
      if (current !== undefined)
        events[index] = { ...current, ...patch, attendees: current.attendees };
      await fulfillJson(route, events[index] ?? {});
      return;
    }
    if (tool === "calendar.event.delete") {
      const index = events.findIndex((event) => event.id === body.eventId);
      if (index >= 0) events.splice(index, 1);
      await fulfillJson(route, { deleted: true, eventId: body.eventId });
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
