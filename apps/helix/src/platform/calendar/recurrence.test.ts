import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  CalendarRecurrenceError,
  expandCalendarEventOccurrences,
  expandCalendarOccurrencePage,
} from "./recurrence.js";

describe("bounded RFC 5545 recurrence", () => {
  it("loads through native Node ESM without the test runner's CommonJS interop", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(new URL("./recurrence.ts", import.meta.url).href)})`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("supports yearly ordinal weekdays and preserves event duration", () => {
    const occurrences = expandCalendarEventOccurrences(
      event("FREQ=YEARLY;BYMONTH=3;BYDAY=2SU;COUNT=3"),
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2029-01-01T00:00:00.000Z"),
    );

    expect(occurrences.map(({ startsAt }) => startsAt.toISOString())).toEqual([
      "2026-03-08T09:00:00.000Z",
      "2027-03-14T09:00:00.000Z",
      "2028-03-12T09:00:00.000Z",
    ]);
    expect(occurrences[0]?.endsAt.toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });

  it("combines RDATE and EXDATE in one ordered set", () => {
    const occurrences = expandCalendarEventOccurrences(
      {
        ...event("FREQ=DAILY;COUNT=3"),
        metadata: {
          caldav: {
            rdate: ["2026-03-20T09:00:00.000Z"],
            exdate: ["2026-03-09T09:00:00.000Z"],
          },
        },
      },
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-04-01T00:00:00.000Z"),
    );

    expect(occurrences.map(({ startsAt }) => startsAt.toISOString())).toEqual([
      "2026-03-08T09:00:00.000Z",
      "2026-03-10T09:00:00.000Z",
      "2026-03-20T09:00:00.000Z",
    ]);
  });

  it("keeps a zoned weekly event at the same wall time across DST", () => {
    const occurrences = expandCalendarEventOccurrences(
      {
        ...event("FREQ=WEEKLY;COUNT=3"),
        startsAt: new Date("2026-03-01T14:00:00.000Z"),
        endsAt: new Date("2026-03-01T15:00:00.000Z"),
        timezone: "America/New_York",
        timeSemantics: "zoned" as const,
        startsLocal: "2026-03-01T09:00:00",
      },
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-22T00:00:00.000Z"),
    );

    expect(occurrences.map(({ startsAt }) => startsAt.toISOString())).toEqual([
      "2026-03-01T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-15T13:00:00.000Z",
    ]);
  });

  it("applies exact, cancelled, and THISANDFUTURE occurrence overrides", () => {
    const occurrences = expandCalendarEventOccurrences(
      {
        ...event("FREQ=DAILY;COUNT=5"),
        metadata: {
          caldav: {
            exdate: ["2026-03-10T09:00:00.000Z"],
            overrides: [
              override("2026-03-09T09:00:00.000Z", "2026-03-09T11:00:00.000Z"),
              {
                ...override("2026-03-10T09:00:00.000Z", "2026-03-10T09:00:00.000Z"),
                status: "cancelled",
              },
              {
                ...override("2026-03-11T09:00:00.000Z", "2026-03-11T12:00:00.000Z"),
                range: "this_and_future",
              },
            ],
          },
        },
      },
      new Date("2026-03-08T00:00:00.000Z"),
      new Date("2026-03-14T00:00:00.000Z"),
    );

    expect(occurrences.map(({ startsAt }) => startsAt.toISOString())).toEqual([
      "2026-03-08T09:00:00.000Z",
      "2026-03-09T11:00:00.000Z",
      "2026-03-11T12:00:00.000Z",
      "2026-03-12T12:00:00.000Z",
    ]);
  });

  it("pages dense recurrence with an exclusive stable cursor", () => {
    const recurring = event("FREQ=HOURLY;COUNT=5");
    const start = new Date("2026-03-08T00:00:00.000Z");
    const end = new Date("2026-03-09T00:00:00.000Z");
    const first = expandCalendarOccurrencePage(recurring, start, end, { limit: 2 });
    if (first.nextCursor === null) throw new Error("Expected a second page.");
    const second = expandCalendarOccurrencePage(recurring, start, end, {
      limit: 2,
      cursor: first.nextCursor,
    });
    if (second.nextCursor === null) throw new Error("Expected a third page.");
    const third = expandCalendarOccurrencePage(recurring, start, end, {
      limit: 2,
      cursor: second.nextCursor,
    });

    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).not.toBeNull();
    expect(third.nextCursor).toBeNull();
    expect([...first.occurrences, ...second.occurrences, ...third.occurrences]).toHaveLength(5);
  });

  it("pages past cancelled instances without hiding later occurrences", () => {
    const recurring = {
      ...event("FREQ=DAILY;COUNT=5"),
      metadata: {
        caldav: {
          overrides: ["2026-03-08T09:00:00.000Z", "2026-03-09T09:00:00.000Z"].map((date) => ({
            ...override(date, date),
            status: "cancelled",
          })),
        },
      },
    };
    const start = new Date("2026-03-08T00:00:00.000Z");
    const end = new Date("2026-03-14T00:00:00.000Z");
    const first = expandCalendarOccurrencePage(recurring, start, end, { limit: 1 });
    expect(first.occurrences.map(({ startsAt }) => startsAt.toISOString())).toEqual([
      "2026-03-10T09:00:00.000Z",
    ]);
    expect(first.nextCursor).toBe("2026-03-10T09:00:00.000Z");
    if (first.nextCursor === null) throw new Error("Expected another visible page.");
    const second = expandCalendarOccurrencePage(recurring, start, end, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.occurrences.map(({ startsAt }) => startsAt.toISOString())).toEqual([
      "2026-03-11T09:00:00.000Z",
      "2026-03-12T09:00:00.000Z",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("pages rule dates before a far-future RDATE", () => {
    const first = expandCalendarOccurrencePage(
      {
        ...event("FREQ=DAILY;COUNT=5"),
        metadata: { caldav: { rdate: ["2026-03-20T09:00:00.000Z"] } },
      },
      new Date("2026-03-08T00:00:00.000Z"),
      new Date("2026-03-21T00:00:00.000Z"),
      { limit: 1 },
    );
    expect(first.occurrences[0]?.startsAt.toISOString()).toBe("2026-03-08T09:00:00.000Z");
    expect(first.nextCursor).toBe("2026-03-08T09:00:00.000Z");
  });

  it("includes an extended override overlapping the query window", () => {
    const occurrences = expandCalendarEventOccurrences(
      {
        ...event("FREQ=DAILY;COUNT=1"),
        metadata: {
          caldav: {
            overrides: [
              {
                ...override("2026-03-08T09:00:00.000Z", "2026-03-08T09:00:00.000Z"),
                endsAt: "2026-03-10T09:00:00.000Z",
              },
            ],
          },
        },
      },
      new Date("2026-03-09T00:00:00.000Z"),
      new Date("2026-03-10T00:00:00.000Z"),
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.endsAt.toISOString()).toBe("2026-03-10T09:00:00.000Z");
  });

  it("bounds scans when all dense future occurrences are cancelled", () => {
    expect(() =>
      expandCalendarOccurrencePage(
        {
          ...event("FREQ=SECONDLY"),
          metadata: {
            caldav: {
              overrides: [
                {
                  ...override("2026-03-08T09:00:00.000Z", "2026-03-08T09:00:00.000Z"),
                  range: "this_and_future",
                  status: "cancelled",
                },
              ],
            },
          },
        },
        new Date("2026-03-08T00:00:00.000Z"),
        new Date("2026-03-09T00:00:00.000Z"),
        { limit: 1 },
      ),
    ).toThrow("Recurrence scan exceeds");
  });

  it.each([
    "FREQ=NOPE",
    "FREQ=DAILY;COUNT=10001",
    "RRULE:FREQ=DAILY",
    "FREQ=DAILY\nEXDATE:20260308T090000Z",
  ])("rejects malformed or unbounded rule %s deterministically", (rule) => {
    expect(() =>
      expandCalendarEventOccurrences(
        event(rule),
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2027-01-01T00:00:00.000Z"),
      ),
    ).toThrow(CalendarRecurrenceError);
  });

  it("rejects oversized windows and malformed date metadata", () => {
    expect(() =>
      expandCalendarEventOccurrences(
        event("FREQ=DAILY"),
        new Date("2020-01-01T00:00:00.000Z"),
        new Date("2031-01-02T00:00:00.000Z"),
      ),
    ).toThrow("cannot exceed ten years");
    expect(() =>
      expandCalendarEventOccurrences(
        { ...event("FREQ=DAILY"), metadata: { caldav: { exdate: ["not-a-date"] } } },
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2027-01-01T00:00:00.000Z"),
      ),
    ).toThrow("EXDATE must be an ISO date-time");
  });
});

function event(recurrenceRule: string) {
  return {
    id: "event-1",
    startsAt: new Date("2026-03-08T09:00:00.000Z"),
    endsAt: new Date("2026-03-08T10:30:00.000Z"),
    recurrenceRule,
    metadata: {},
  };
}

function override(recurrenceId: string, startsAt: string) {
  return {
    recurrenceId,
    range: "this" as const,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 90 * 60_000).toISOString(),
    status: "confirmed" as const,
    title: "Override",
    sequence: 2,
    dtstamp: "2026-03-01T00:00:00.000Z",
    attendees: [],
  };
}
