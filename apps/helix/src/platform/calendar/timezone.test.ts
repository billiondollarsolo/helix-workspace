import { describe, expect, it } from "vitest";
import { zonedLocalDateToUtc } from "./timezone.js";

describe("zonedLocalDateToUtc (CAL.7)", () => {
  it("converts America/New_York winter and summer offsets", () => {
    const winter = zonedLocalDateToUtc(
      { year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 },
      "America/New_York",
    );
    // EST = UTC-5
    expect(winter.toISOString()).toBe("2026-01-15T17:00:00.000Z");

    const summer = zonedLocalDateToUtc(
      { year: 2026, month: 7, day: 15, hour: 12, minute: 0, second: 0 },
      "America/New_York",
    );
    // EDT = UTC-4
    expect(summer.toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });
});
