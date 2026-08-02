import { describe, expect, it } from "vitest";
import { findAvailableSlots } from "./freebusy.js";
import {
  formatZonedIcsLocalDate,
  isValidTimeZone,
  utcToZonedParts,
  zonedDayOfWeek,
  zonedHourOfDay,
  zonedLocalDateToUtc,
} from "./timezone.js";

describe("calendar timezone + DST pack (CAL.7)", () => {
  it("validates IANA time zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });

  it("converts America/New_York winter EST wall clock to UTC (UTC-5)", () => {
    // 2026-01-15 09:30 EST = 14:30 UTC
    const utc = zonedLocalDateToUtc(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(utc.toISOString()).toBe("2026-01-15T14:30:00.000Z");
    expect(utcToZonedParts(utc, "America/New_York")).toMatchObject({
      year: 2026,
      month: 1,
      day: 15,
      hour: 9,
      minute: 30,
      second: 0,
    });
  });

  it("converts America/New_York summer EDT wall clock to UTC (UTC-4)", () => {
    // 2026-07-15 09:30 EDT = 13:30 UTC
    const utc = zonedLocalDateToUtc(
      { year: 2026, month: 7, day: 15, hour: 9, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(utc.toISOString()).toBe("2026-07-15T13:30:00.000Z");
    expect(formatZonedIcsLocalDate(utc, "America/New_York")).toBe("20260715T093000");
  });

  it("handles US spring-forward (2026-03-08 02:00 does not exist; 03:00 EDT is 07:00 UTC)", () => {
    // First instant of EDT: 2026-03-08 03:00 local = 07:00 UTC
    const afterSpring = zonedLocalDateToUtc(
      { year: 2026, month: 3, day: 8, hour: 3, minute: 0, second: 0 },
      "America/New_York",
    );
    expect(afterSpring.toISOString()).toBe("2026-03-08T07:00:00.000Z");

    // 01:30 EST still exists = 06:30 UTC
    const beforeSpring = zonedLocalDateToUtc(
      { year: 2026, month: 3, day: 8, hour: 1, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(beforeSpring.toISOString()).toBe("2026-03-08T06:30:00.000Z");
  });

  it("handles US fall-back (2026-11-01 01:30 repeats; prefer standard mapping via iteration)", () => {
    // 01:30 is ambiguous: EDT → 05:30 UTC or EST → 06:30 UTC.
    // The iterative solver converges on one valid offset; both are acceptable.
    const local = zonedLocalDateToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
      "America/New_York",
    );
    expect(Number.isNaN(local.getTime())).toBe(false);
    const parts = utcToZonedParts(local, "America/New_York");
    expect(parts).toMatchObject({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    // UTC hour for local 01:30 must be 05 (EDT, UTC-4) or 06 (EST, UTC-5).
    expect([5, 6]).toContain(local.getUTCHours());
    expect(local.toISOString()).toMatch(/^2026-11-01T0[56]:30:00\.000Z$/);
  });

  it("projects zoned hour-of-day across DST for free/busy working hours", () => {
    // 14:00 UTC on 2026-07-15 is 10:00 EDT
    const summer = new Date("2026-07-15T14:00:00.000Z");
    expect(zonedHourOfDay(summer, "America/New_York")).toBe(10);
    expect(zonedDayOfWeek(summer, "America/New_York")).toBe(3); // Wednesday

    // 14:00 UTC on 2026-01-15 is 09:00 EST
    const winter = new Date("2026-01-15T14:00:00.000Z");
    expect(zonedHourOfDay(winter, "America/New_York")).toBe(9);
  });

  it("applies workingHours.timezone so DST does not shift availability incorrectly", () => {
    // Window: 2026-07-15 12:00–18:00 UTC → 08:00–14:00 EDT
    // Working hours 09:00–17:00 America/New_York → first slot at 13:00 UTC (09:00 EDT)
    const slots = findAvailableSlots({
      actorIds: ["actor-1"],
      startsAt: new Date("2026-07-15T12:00:00.000Z"),
      endsAt: new Date("2026-07-15T18:00:00.000Z"),
      durationMinutes: 30,
      incrementMinutes: 30,
      limit: 5,
      busy: [],
      workingHours: {
        timezone: "America/New_York",
        daysOfWeek: [3], // Wednesday
        startsAtHour: 9,
        endsAtHour: 17,
      },
    });

    expect(slots[0]?.startsAt.toISOString()).toBe("2026-07-15T13:00:00.000Z");
    expect(slots.map((slot) => slot.startsAt.toISOString())).not.toContain(
      "2026-07-15T12:00:00.000Z",
    );

    // Same UTC window in January: 12:00 UTC = 07:00 EST — before 09:00 work start.
    // First valid slot: 09:00 EST = 14:00 UTC.
    const winterSlots = findAvailableSlots({
      actorIds: ["actor-1"],
      startsAt: new Date("2026-01-15T12:00:00.000Z"),
      endsAt: new Date("2026-01-15T18:00:00.000Z"),
      durationMinutes: 30,
      incrementMinutes: 30,
      limit: 3,
      busy: [],
      workingHours: {
        timezone: "America/New_York",
        daysOfWeek: [4], // Thursday 2026-01-15
        startsAtHour: 9,
        endsAtHour: 17,
      },
    });
    expect(winterSlots[0]?.startsAt.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("keeps UTC working hours behavior when timezone is omitted", () => {
    const slots = findAvailableSlots({
      actorIds: ["actor-1"],
      startsAt: new Date("2026-05-20T08:00:00.000Z"),
      endsAt: new Date("2026-05-20T12:00:00.000Z"),
      durationMinutes: 60,
      incrementMinutes: 60,
      limit: 5,
      busy: [],
      workingHours: {
        startsAtHour: 9,
        endsAtHour: 17,
      },
    });
    expect(slots[0]?.startsAt.toISOString()).toBe("2026-05-20T09:00:00.000Z");
  });
});
