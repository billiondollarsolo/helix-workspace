import { describe, expect, it, vi } from "vitest";
import {
  createCalendar,
  createCalendarEvent,
  deleteCalendar,
  deleteCalendarEvent,
  findCalendarTime,
  listCalendarEvents,
  listCalendarFreeBusy,
  listCalendarMemberships,
  removeCalendarMembership,
  respondToCalendarEvent,
  setCalendarMembership,
  updateCalendar,
  updateCalendarEvent,
} from "./api";
import {
  calendarRouteSearchFromState,
  calendarRouteStateFromSearch,
  defaultCalendarRouteState,
  validateCalendarRouteSearch,
} from "./route-state";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

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
    await respondToCalendarEvent({ eventId, responseStatus: "accepted" }, fetchImpl);

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
  it("normalizes route search params", () => {
    expect(
      validateCalendarRouteSearch({
        event: " evt-1 ",
        date: "2026-05-21",
        view: "3day",
        q: " planning ",
      }),
    ).toEqual({ event: "evt-1", date: "2026-05-21", view: "3day", q: "planning" });
    expect(
      validateCalendarRouteSearch({ date: "2026-02-31", view: "agenda", query: "ignored" }),
    ).toEqual({ event: undefined, date: undefined, view: undefined, q: undefined });
  });

  it("round-trips shell route state while omitting default params", () => {
    const routeState = calendarRouteStateFromSearch({
      event: "evt-2",
      date: "2027-01-15",
      view: "schedule",
      q: "launch",
    });

    expect(routeState).toEqual({
      eventId: "evt-2",
      date: "2027-01-15",
      view: "schedule",
      query: "launch",
    });
    expect(calendarRouteSearchFromState(routeState)).toEqual({
      event: "evt-2",
      date: "2027-01-15",
      view: "schedule",
      q: "launch",
    });
    expect(
      calendarRouteSearchFromState({
        eventId: "",
        date: defaultCalendarRouteState.date,
        view: "week",
        query: "",
      }),
    ).toEqual({ event: undefined, date: undefined, view: undefined, q: undefined });
  });
});

describe("calendar free/busy and sharing API", () => {
  it("reads busy blocks and manages calendar members through tools", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: requestUrl(input),
        body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown,
      });
      const url = requestUrl(input);
      if (url.endsWith("calendar.free-busy")) {
        return Promise.resolve(
          Response.json({
            busy: [
              {
                actorId: "a1",
                startsAt: "2026-05-20T13:00:00.000Z",
                endsAt: "2026-05-20T14:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url.endsWith("calendar.memberships.list")) {
        return Promise.resolve(
          Response.json({
            memberships: [
              {
                calendarId: "c1",
                actorId: "a2",
                displayName: "Sam",
                email: "sam@x.test",
                role: "reader",
              },
            ],
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    await expect(
      listCalendarFreeBusy(
        {
          actorIds: ["a1"],
          windowStartsAt: "2026-05-20T00:00:00.000Z",
          windowEndsAt: "2026-05-21T00:00:00.000Z",
        },
        fetchImpl,
      ),
    ).resolves.toHaveLength(1);
    await expect(listCalendarMemberships("c1", fetchImpl)).resolves.toEqual([
      expect.objectContaining({ actorId: "a2", role: "reader" }),
    ]);
    await setCalendarMembership({ calendarId: "c1", actorId: "a2", role: "writer" }, fetchImpl);
    await removeCalendarMembership({ calendarId: "c1", actorId: "a2" }, fetchImpl);

    expect(calls.map((call) => call.url)).toEqual([
      "/api/tools/calendar.free-busy",
      "/api/tools/calendar.memberships.list",
      "/api/tools/calendar.memberships.set",
      "/api/tools/calendar.memberships.remove",
    ]);
    expect(calls[2]?.body).toEqual({ calendarId: "c1", actorId: "a2", role: "writer" });
  });

  it("manages calendars through the calendar.calendar.* tools", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: requestUrl(input), body: JSON.parse(init?.body as string) });
      return Promise.resolve(Response.json({ id: "c1", name: "Team", color: "teal" }));
    });
    await createCalendar({ name: "Team", color: "teal" }, fetchImpl);
    await updateCalendar({ calendarId: "c1", name: "Platform" }, fetchImpl);
    await deleteCalendar("c1", fetchImpl);
    expect(calls).toEqual([
      { url: "/api/tools/calendar.calendar.create", body: { name: "Team", color: "teal" } },
      {
        url: "/api/tools/calendar.calendar.update",
        body: { calendarId: "c1", name: "Platform" },
      },
      { url: "/api/tools/calendar.calendar.delete", body: { calendarId: "c1" } },
    ]);
  });
});
