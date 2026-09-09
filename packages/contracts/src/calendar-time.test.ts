import { describe, expect, it } from "vitest";
import {
  CalendarTimeError,
  instantToLocalDateTime,
  localDateTimeToFloatingInstant,
  localDateTimeToInstant,
} from "./calendar-time.js";

describe("calendar time model", () => {
  it("uses IANA DST rules and rejects skipped spring wall time", () => {
    expect(localDateTimeToInstant("2026-03-08T01:30:00", "America/New_York").toISOString()).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(() => localDateTimeToInstant("2026-03-08T02:30:00", "America/New_York")).toThrow(
      CalendarTimeError,
    );
  });

  it("chooses the earlier instant during a fall overlap", () => {
    expect(localDateTimeToInstant("2026-11-01T01:30:00", "America/New_York").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("supports traveler display while floating values never shift", () => {
    expect(instantToLocalDateTime("2026-05-21T13:00:00.000Z", "America/Los_Angeles")).toBe(
      "2026-05-21T06:00:00",
    );
    expect(localDateTimeToFloatingInstant("2026-05-21T09:00:00").toISOString()).toBe(
      "2026-05-21T09:00:00.000Z",
    );
  });

  it("preserves wall-clock intent when an event's time zone changes", () => {
    expect(localDateTimeToInstant("2026-12-15T09:00:00", "America/New_York").toISOString()).toBe(
      "2026-12-15T14:00:00.000Z",
    );
    expect(localDateTimeToInstant("2026-12-15T09:00:00", "America/Los_Angeles").toISOString()).toBe(
      "2026-12-15T17:00:00.000Z",
    );
  });
});
