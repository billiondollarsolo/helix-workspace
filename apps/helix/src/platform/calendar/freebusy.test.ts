import { describe, expect, it } from "vitest";
import { findAvailableSlots, freeBusyEventsToBusyBlocks } from "./freebusy.js";

describe("calendar free-busy recurrence expansion", () => {
  it("expands recurring busy events inside the requested window and skips EXDATEs", () => {
    const blocks = freeBusyEventsToBusyBlocks(
      [
        {
          eventId: "weekly-planning",
          actorId: "actor-1",
          startsAt: new Date("2026-05-20T15:00:00.000Z"),
          endsAt: new Date("2026-05-20T16:00:00.000Z"),
          status: "confirmed",
          recurrenceRule: "FREQ=WEEKLY;COUNT=3",
          metadata: {
            caldav: {
              exdate: ["2026-05-27T15:00:00.000Z"],
            },
          },
        },
      ],
      {
        startsAt: new Date("2026-05-27T00:00:00.000Z"),
        endsAt: new Date("2026-06-04T00:00:00.000Z"),
      },
    );

    expect(blocks).toEqual([
      {
        actorId: "actor-1",
        startsAt: new Date("2026-06-03T15:00:00.000Z"),
        endsAt: new Date("2026-06-03T16:00:00.000Z"),
        eventIds: ["weekly-planning"],
      },
    ]);
  });

  it("uses stored wall-clock intent when recurrence crosses DST", () => {
    const blocks = freeBusyEventsToBusyBlocks(
      [
        {
          eventId: "weekly-planning",
          actorId: "actor-1",
          startsAt: new Date("2026-03-01T14:00:00.000Z"),
          endsAt: new Date("2026-03-01T15:00:00.000Z"),
          timezone: "America/New_York",
          timeSemantics: "zoned",
          startsLocal: "2026-03-01T09:00:00",
          status: "confirmed",
          recurrenceRule: "FREQ=WEEKLY;COUNT=2",
          metadata: {},
        },
      ],
      {
        startsAt: new Date("2026-03-08T00:00:00.000Z"),
        endsAt: new Date("2026-03-09T00:00:00.000Z"),
      },
    );

    expect(blocks[0]?.startsAt.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("enforces each attendee's local working hours across time zones", () => {
    const slots = findAvailableSlots({
      actorIds: ["new-york", "london"],
      startsAt: new Date("2026-06-01T11:00:00Z"),
      endsAt: new Date("2026-06-01T18:00:00Z"),
      durationMinutes: 60,
      incrementMinutes: 60,
      limit: 10,
      busy: [],
      workingHoursByActorId: {
        "new-york": { timezone: "America/New_York", startsAtHour: 9, endsAtHour: 17 },
        london: { timezone: "Europe/London", startsAtHour: 9, endsAtHour: 17 },
      },
    });

    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-06-01T13:00:00.000Z",
      "2026-06-01T14:00:00.000Z",
      "2026-06-01T15:00:00.000Z",
    ]);
  });
});
