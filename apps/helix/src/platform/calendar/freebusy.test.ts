import { describe, expect, it } from "vitest";
import { freeBusyEventsToBusyBlocks } from "./freebusy.js";

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
});
