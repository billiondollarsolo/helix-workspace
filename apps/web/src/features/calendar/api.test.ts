import { describe, expect, it, vi } from "vitest";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  findCalendarTime,
  listCalendarEvents,
  respondToCalendarEvent,
  updateCalendarEvent,
} from "./api";
import {
  calendarEventsInputFromRouteSearch,
  calendarRouteSearchFromState,
  calendarRouteStateFromSearch,
  defaultCalendarRouteState,
  validateCalendarRouteSearch,
} from "./queries";

const eventId = "33333333-3333-4333-8333-333333333333";

describe("calendar API", () => {
  it("creates events through the calendar.event.create tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: eventId,
          calendarId: "44444444-4444-4444-8444-444444444444",
          title: "Planning",
          startsAt: "2026-05-20T13:00:00.000Z",
          endsAt: "2026-05-20T14:00:00.000Z",
          allDay: false,
          status: "confirmed",
          attendees: [],
        }),
      ),
    );

    await expect(
      createCalendarEvent(
        {
          title: "Planning",
          startsAt: "2026-05-20T13:00:00.000Z",
          endsAt: "2026-05-20T14:00:00.000Z",
          attendees: [{ email: "sam@helix.test", displayName: "Sam Patel" }],
          sendInvitations: false,
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: eventId });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/calendar.event.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        calendarId: null,
        title: "Planning",
        description: null,
        location: null,
        startsAt: "2026-05-20T13:00:00.000Z",
        endsAt: "2026-05-20T14:00:00.000Z",
        timezone: "UTC",
        allDay: false,
        recurrenceRule: null,
        attendees: [{ email: "sam@helix.test", displayName: "Sam Patel" }],
        metadata: {},
        sendInvitations: false,
      }),
    });
  });

  it("updates and responds through backend calendar tools", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: eventId,
          calendarId: "44444444-4444-4444-8444-444444444444",
          title: "Planning",
          startsAt: "2026-05-20T13:30:00.000Z",
          endsAt: "2026-05-20T14:30:00.000Z",
          allDay: false,
          status: "confirmed",
          attendees: [],
        }),
      ),
    );

    await updateCalendarEvent(
      {
        eventId,
        patch: {
          startsAt: "2026-05-20T13:30:00.000Z",
          endsAt: "2026-05-20T14:30:00.000Z",
        },
        sendInvitations: false,
      },
      fetchImpl,
    );
    await respondToCalendarEvent(
      { eventId, attendeeEmail: "sam@helix.test", responseStatus: "accepted" },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/calendar.event.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId,
        patch: {
          startsAt: "2026-05-20T13:30:00.000Z",
          endsAt: "2026-05-20T14:30:00.000Z",
        },
        sendInvitations: false,
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/calendar.event.respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId,
        attendeeEmail: "sam@helix.test",
        responseStatus: "accepted",
      }),
    });
  });

  it("deletes events through the calendar.event.delete tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          deleted: true,
          eventId,
          cancellationsQueued: 0,
        }),
      ),
    );

    await expect(
      deleteCalendarEvent(
        {
          eventId,
          sendCancellation: false,
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ deleted: true, eventId });

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/calendar.event.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId,
        sendCancellation: false,
      }),
    });
  });

  it("finds meeting slots and surfaces backend errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          slots: [
            {
              startsAt: "2026-05-21T14:00:00.000Z",
              endsAt: "2026-05-21T14:30:00.000Z",
              busy: [],
            },
          ],
        }),
      ),
    );

    await expect(
      findCalendarTime(
        {
          attendeeEmails: ["sam@helix.test"],
          windowStartsAt: "2026-05-21T13:00:00.000Z",
          windowEndsAt: "2026-05-21T22:00:00.000Z",
          durationMinutes: 30,
        },
        fetchImpl,
      ),
    ).resolves.toHaveLength(1);

    fetchImpl.mockResolvedValueOnce(
      Response.json({ error: "missing calendar scope" }, { status: 403 }),
    );
    await expect(
      findCalendarTime(
        {
          windowStartsAt: "2026-05-21T13:00:00.000Z",
          windowEndsAt: "2026-05-21T22:00:00.000Z",
          durationMinutes: 30,
        },
        fetchImpl,
      ),
    ).rejects.toThrow("missing calendar scope");
  });

  it("lists events through the calendar.event.list tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          events: [
            {
              id: eventId,
              calendarId: "44444444-4444-4444-8444-444444444444",
              title: "Planning",
              startsAt: "2026-05-20T13:00:00.000Z",
              endsAt: "2026-05-20T14:00:00.000Z",
              allDay: false,
              status: "confirmed",
              attendees: [],
            },
          ],
        }),
      ),
    );

    await expect(
      listCalendarEvents(
        {
          calendarId: "44444444-4444-4444-8444-444444444444",
          startsAt: "2026-05-20T00:00:00.000Z",
          endsAt: "2026-05-21T00:00:00.000Z",
          limit: 25,
        },
        fetchImpl,
      ),
    ).resolves.toHaveLength(1);

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/calendar.event.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        calendarId: "44444444-4444-4444-8444-444444444444",
        startsAt: "2026-05-20T00:00:00.000Z",
        endsAt: "2026-05-21T00:00:00.000Z",
        limit: 25,
      }),
    });
  });
});

describe("calendar route search", () => {
  it("normalizes route search params for calendar event prefetching", () => {
    const search = validateCalendarRouteSearch({
      event: " evt-1 ",
      date: "2026-05-21",
      view: "day",
      q: " planning ",
      query: "ignored",
    });

    expect(search).toEqual({
      event: "evt-1",
      date: "2026-05-21",
      view: "day",
      q: "planning",
    });
    expect(calendarEventsInputFromRouteSearch(search)).toEqual({
      startsAt: "2026-05-21T00:00:00.000Z",
      endsAt: "2026-05-21T23:59:59.999Z",
      limit: 100,
    });
  });

  it("falls back to safe defaults and derives week/month event windows", () => {
    const defaultSearch = validateCalendarRouteSearch({
      date: "2026-02-31",
      view: "agenda",
      query: " backend ",
    });

    expect(defaultSearch).toEqual({
      event: undefined,
      date: undefined,
      view: undefined,
      q: "backend",
    });
    expect(calendarEventsInputFromRouteSearch(defaultSearch)).toEqual({
      startsAt: "2026-05-18T00:00:00.000Z",
      endsAt: "2026-05-24T23:59:59.999Z",
      limit: 100,
    });
    expect(calendarEventsInputFromRouteSearch({ date: "2026-06-15", view: "month" })).toEqual({
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-06-30T23:59:59.999Z",
      limit: 100,
    });
  });

  it("round-trips shell route state while omitting default params", () => {
    // A non-default date so the round-trip preserves it in the search params.
    const customDate = "2027-01-15";
    const routeState = calendarRouteStateFromSearch({
      event: "evt-2",
      date: customDate,
      view: "month",
      q: "launch",
    });

    expect(routeState).toEqual({
      eventId: "evt-2",
      date: customDate,
      view: "month",
      query: "launch",
    });
    expect(calendarRouteSearchFromState(routeState)).toEqual({
      event: "evt-2",
      date: customDate,
      view: "month",
      q: "launch",
    });
    expect(
      calendarRouteSearchFromState({
        eventId: "",
        date: defaultCalendarRouteState.date,
        view: "week",
        query: "",
      }),
    ).toEqual({
      event: undefined,
      date: undefined,
      view: undefined,
      q: undefined,
    });
  });
});
