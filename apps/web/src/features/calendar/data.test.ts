import { describe, expect, it } from "vitest";
import {
  GRID_HOURS,
  dateNumberForDay,
  formatCardTime,
  formatHour,
  gridEventFromApiEvent,
  isOnGrid,
} from "./data";
import type { CalendarApiEvent } from "./api";

describe("calendar grid helpers", () => {
  it("exposes a 12-hour gutter starting at 7 AM", () => {
    expect(GRID_HOURS).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("computes the day-of-month for a Monday-relative index within a given week", () => {
    expect(dateNumberForDay("2026-05-18", 0)).toBe(18);
    expect(dateNumberForDay("2026-05-18", 6)).toBe(24);
    // Works for any week, not just the prototype's anchor:
    expect(dateNumberForDay("2026-12-28", 4)).toBe(1); // Friday Jan 1, 2027
  });

  it("formats decimal hours for the popover and event cards", () => {
    expect(formatHour(9)).toBe("9:00 AM");
    expect(formatHour(13.5)).toBe("1:30 PM");
    expect(formatHour(12)).toBe("12:00 PM");
    expect(formatCardTime(14)).toBe("2");
    expect(formatCardTime(15.5)).toBe("3:30");
  });

});

describe("gridEventFromApiEvent", () => {
  const apiEvent: CalendarApiEvent = {
    id: "22222222-2222-4222-8222-222222222222",
    calendarId: "team",
    title: "Quarterly review",
    location: "Helix Meet",
    startsAt: "2026-05-21T14:30:00.000Z",
    endsAt: "2026-05-21T15:30:00.000Z",
    allDay: false,
    status: "confirmed",
    attendees: [
      {
        id: "a1",
        email: "lead@helix.test",
        displayName: "Team Lead",
        responseStatus: "accepted",
        isOrganizer: true,
      },
      {
        id: "a2",
        email: "sam@helix.test",
        displayName: "Sam Patel",
        responseStatus: "needs_action",
        isOrganizer: false,
      },
    ],
  };

  it("places the event on the right day and decimal hour band", () => {
    const gridEvent = gridEventFromApiEvent(apiEvent);
    expect(gridEvent.day).toBe(3); // Thursday May 21.
    expect(gridEvent.start).toBe(14.5);
    expect(gridEvent.end).toBe(15.5);
    expect(gridEvent.date).toBe("2026-05-21");
    expect(isOnGrid(gridEvent)).toBe(true);
  });

  it("excludes the organizer from the attendee list", () => {
    const gridEvent = gridEventFromApiEvent(apiEvent);
    expect(gridEvent.attendees).toEqual(["Sam Patel"]);
  });

  it("flags events that fall outside the visible hour band as off-grid", () => {
    const earlyEvent = gridEventFromApiEvent({
      ...apiEvent,
      startsAt: "2026-05-21T03:00:00.000Z",
      endsAt: "2026-05-21T04:00:00.000Z",
    });
    expect(isOnGrid(earlyEvent)).toBe(false);
  });
});
