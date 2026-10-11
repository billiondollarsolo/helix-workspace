import { describe, expect, it } from "vitest";
import type { CalendarApiEvent } from "./api";
import { calendarLabel } from "./colors";
import { draftFromEvent, draftToEventInput, newEventDraft } from "./event-draft";
import {
  conferenceUrl,
  eventQueryWindowForTimeZone,
  occurrencesInWindow,
  type OccurrenceContext,
} from "./event-model";
import { allDayPlacements, timedSegmentsForDay } from "./grid-layout";
import { describeReminder, reminderFromMinutes, reminderToMinutes } from "./reminders";
import { calendarPreferencesFrom } from "./preferences";
import { shiftDraft } from "./use-event-actions";

function apiEvent(overrides: Partial<CalendarApiEvent> = {}): CalendarApiEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    calendarId: "cal-1",
    title: "Planning",
    startsAt: "2026-05-20T13:00:00.000Z",
    endsAt: "2026-05-20T14:00:00.000Z",
    timezone: "America/New_York",
    timeSemantics: "zoned",
    allDay: false,
    status: "confirmed",
    attendees: [],
    ...overrides,
  };
}

const context: OccurrenceContext = {
  calendars: new Map(),
  timeZone: "America/New_York",
  from: "2026-05-17",
  to: "2026-05-23",
  viewer: { actorId: "me", email: "me@helix.test" },
};

describe("occurrencesInWindow", () => {
  it("places timed events in the viewer's zone", () => {
    const [occurrence] = occurrencesInWindow([apiEvent()], context);
    expect(occurrence).toMatchObject({ startDate: "2026-05-20", start: 9, end: 10, allDay: false });
    const [tokyo] = occurrencesInWindow([apiEvent()], { ...context, timeZone: "Asia/Tokyo" });
    expect(tokyo).toMatchObject({ startDate: "2026-05-20", start: 22, end: 23 });
  });

  it("keeps all-day events on their dates and makes the end inclusive", () => {
    const [occurrence] = occurrencesInWindow(
      [
        apiEvent({
          allDay: true,
          timeSemantics: "all_day",
          startsAt: "2026-05-20T00:00:00.000Z",
          endsAt: "2026-05-22T00:00:00.000Z",
          startsLocal: "2026-05-20T00:00:00",
          endsLocal: "2026-05-22T00:00:00",
        }),
      ],
      { ...context, timeZone: "Pacific/Honolulu" },
    );
    expect(occurrence).toMatchObject({
      allDay: true,
      startDate: "2026-05-20",
      endDate: "2026-05-21",
    });
  });

  it("expands a weekly series and records the viewer's RSVP", () => {
    const occurrences = occurrencesInWindow(
      [
        apiEvent({
          startsAt: "2026-05-04T13:00:00.000Z",
          endsAt: "2026-05-04T13:30:00.000Z",
          recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,TH",
          attendees: [{ actorId: "me", email: "me@helix.test", responseStatus: "tentative" }],
        }),
      ],
      context,
    );
    expect(occurrences.map((occurrence) => occurrence.startDate)).toEqual([
      "2026-05-18",
      "2026-05-21",
    ]);
    expect(occurrences.every((occurrence) => occurrence.recurring)).toBe(true);
    expect(occurrences[0]).toMatchObject({ start: 9, end: 9.5, selfStatus: "tentative" });
  });

  it("drops cancelled events and resolves query windows across DST", () => {
    expect(occurrencesInWindow([apiEvent({ status: "cancelled" })], context)).toEqual([]);
    expect(
      eventQueryWindowForTimeZone(
        { startsAt: "2026-03-08T00:00:00.000Z", endsAt: "2026-03-08T23:59:59.999Z", limit: 100 },
        "America/New_York",
      ),
    ).toEqual({
      startsAt: "2026-03-08T05:00:00.000Z",
      endsAt: "2026-03-09T03:59:59.999Z",
      limit: 100,
    });
  });

  it("only trusts http(s) links for Join", () => {
    expect(conferenceUrl(apiEvent({ location: "https://meet.example.test/abc" }))).toBe(
      "https://meet.example.test/abc",
    );
    expect(conferenceUrl(apiEvent({ location: "Room 4" }))).toBeNull();
    const conference = { provider: "meet", roomId: "r1", joinCode: "abc-defg-hij" };
    expect(
      conferenceUrl(
        apiEvent({
          metadata: {
            conference: { ...conference, joinUrl: "https://helix.test/meet?code=abc-defg-hij" },
          },
        }),
      ),
    ).toBe("https://helix.test/meet?code=abc-defg-hij");
    expect(
      conferenceUrl(
        apiEvent({ metadata: { conference: { ...conference, joinUrl: "javascript:alert(1)" } } }),
      ),
    ).toBeNull();
  });
});

describe("grid layout", () => {
  it("puts overlapping events side by side", () => {
    const events = [
      apiEvent({
        id: "a",
        startsAt: "2026-05-20T13:00:00.000Z",
        endsAt: "2026-05-20T15:00:00.000Z",
      }),
      apiEvent({
        id: "b",
        startsAt: "2026-05-20T14:00:00.000Z",
        endsAt: "2026-05-20T14:30:00.000Z",
      }),
      apiEvent({
        id: "c",
        startsAt: "2026-05-20T16:00:00.000Z",
        endsAt: "2026-05-20T17:00:00.000Z",
      }),
    ];
    const segments = timedSegmentsForDay(occurrencesInWindow(events, context), "2026-05-20");
    expect(
      segments.map(({ occurrence, column, columns }) => [occurrence.event.id, column, columns]),
    ).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 0, 1],
    ]);
  });

  it("splits events that cross midnight and stacks all-day lanes", () => {
    const late = apiEvent({
      startsAt: "2026-05-21T02:00:00.000Z",
      endsAt: "2026-05-21T05:00:00.000Z",
    });
    const occurrences = occurrencesInWindow([late], context);
    expect(timedSegmentsForDay(occurrences, "2026-05-20")[0]).toMatchObject({ start: 22, end: 24 });
    expect(timedSegmentsForDay(occurrences, "2026-05-21")[0]).toMatchObject({ start: 0, end: 1 });

    const allDay = (id: string, start: string, end: string) =>
      apiEvent({
        id,
        allDay: true,
        timeSemantics: "all_day",
        startsLocal: `${start}T00:00:00`,
        endsLocal: `${end}T00:00:00`,
      });
    const placements = allDayPlacements(
      occurrencesInWindow(
        [allDay("x", "2026-05-15", "2026-05-19"), allDay("y", "2026-05-18", "2026-05-19")],
        context,
      ),
      ["2026-05-17", "2026-05-18", "2026-05-19"],
    );
    expect(
      placements.map(({ occurrence, first, last, lane, continuesBefore }) => [
        occurrence.event.id,
        first,
        last,
        lane,
        continuesBefore,
      ]),
    ).toEqual([
      ["x", 0, 1, 0, true],
      ["y", 1, 1, 1, false],
    ]);
  });
});

describe("drafts", () => {
  it("round-trips an event through the editor model", () => {
    const event = apiEvent({
      recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
      metadata: { alarms: [{ minutesBefore: 60 }], transparency: "transparent" },
      attendees: [
        { email: "boss@helix.test", isOrganizer: true, responseStatus: "accepted" },
        { email: "sam@helix.test", displayName: "Sam", responseStatus: "accepted" },
      ],
    });
    const draft = draftFromEvent(event);
    expect(draft).toMatchObject({
      startDate: "2026-05-20",
      startTime: 9,
      endTime: 10,
      busy: false,
      reminder: { amount: 1, unit: "hours" },
    });
    expect(draft.guests.map((guest) => guest.email)).toEqual(["sam@helix.test"]);
    const input = draftToEventInput(draft);
    expect(input).toMatchObject({
      startsAt: "2026-05-20T13:00:00.000Z",
      endsAt: "2026-05-20T14:00:00.000Z",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=WE",
      attendees: [{ email: "sam@helix.test", responseStatus: "accepted" }],
      metadata: { alarms: [{ minutesBefore: 60 }], transparency: "transparent" },
    });
  });

  it("shifts and resizes by minutes and saves all-day spans inclusively", () => {
    const draft = newEventDraft({
      date: "2026-05-20",
      start: 23.5,
      end: 24,
      calendarId: null,
      timeZone: "UTC",
    });
    expect(shiftDraft(draft, 30, 30)).toMatchObject({
      startDate: "2026-05-21",
      startTime: 0,
      endTime: 0.5,
    });
    expect(shiftDraft(draft, 0, 15)).toMatchObject({ endDate: "2026-05-21", endTime: 0.25 });
    const allDay = {
      ...newEventDraft({ date: "2026-05-20", allDay: true, calendarId: null, timeZone: "UTC" }),
    };
    expect(draftToEventInput(allDay)).toMatchObject({
      allDay: true,
      timeSemantics: "all_day",
      startsAt: "2026-05-20T00:00:00.000Z",
      endsAt: "2026-05-21T00:00:00.000Z",
    });
  });
});

describe("video conferencing in drafts", () => {
  it("asks the server for a room once and keeps or drops an existing link", () => {
    const fresh = newEventDraft({ date: "2026-05-20", calendarId: null, timeZone: "UTC" });
    expect(draftToEventInput(fresh).conference).toBeUndefined();
    expect(draftToEventInput({ ...fresh, addConference: true }).conference).toBe("meet");

    const conference = {
      provider: "meet",
      roomId: "r1",
      joinCode: "abc-defg-hij",
      joinUrl: "https://helix.test/meet?code=abc-defg-hij",
    };
    const existing = draftFromEvent(apiEvent({ metadata: { conference } }));
    expect(existing.conference).toEqual(conference);
    const kept = draftToEventInput({ ...existing, addConference: true });
    expect(kept.conference).toBeUndefined();
    expect(kept.metadata).toMatchObject({ conference });
    expect(draftToEventInput({ ...existing, conference: null }).metadata).not.toHaveProperty(
      "conference",
    );
  });
});

describe("calendar preferences", () => {
  it("reads account preferences and falls back to the browser for unset fields", () => {
    const account = {
      language: null,
      timeZone: "Europe/Paris",
      dateFormat: null,
      timeFormat: "24h" as const,
      weekStart: 1,
      workingHours: {
        enabled: true,
        days: [
          { day: 2, start: "08:30", end: "16:00" },
          { day: 1, start: "09:00", end: "17:30" },
        ],
      },
      mail: { readingPane: "right" as const, density: "default" as const, conversationView: true },
      updatedAt: null,
    };
    expect(calendarPreferencesFrom(account)).toEqual({
      weekStartsOn: 1,
      timeZone: "Europe/Paris",
      timeFormat: "24h",
      workingHours: { start: 8.5, end: 17.5, days: [1, 2] },
    });
    const unset = calendarPreferencesFrom({
      ...account,
      timeZone: null,
      timeFormat: null,
      weekStart: null,
      workingHours: null,
    });
    expect(unset.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    expect(unset.workingHours).toEqual({ start: 9, end: 17, days: [1, 2, 3, 4, 5] });
    expect(["12h", "24h"]).toContain(unset.timeFormat);
  });
});

describe("reminders and colours", () => {
  it("converts number + unit reminders", () => {
    expect(reminderToMinutes({ amount: 2, unit: "hours" })).toBe(120);
    expect(reminderFromMinutes(10_080)).toEqual({ amount: 1, unit: "weeks" });
    expect(reminderFromMinutes(90)).toEqual({ amount: 90, unit: "minutes" });
    expect(describeReminder({ amount: 1, unit: "days" })).toBe("1 day before");
  });

  it("maps stored calendar colours onto the label palette", () => {
    expect(calendarLabel("#4f46e5")).toBe("indigo");
    expect(calendarLabel("#0f766e")).toBe("teal");
    expect(calendarLabel("#dc2626")).toBe("red");
    expect(calendarLabel("#64748b")).toBe("slate");
    expect(calendarLabel("emerald")).toBe("emerald");
    expect(calendarLabel(null)).toBe("blue");
  });
});
