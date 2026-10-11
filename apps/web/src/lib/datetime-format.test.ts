import { describe, expect, it } from "vitest";
import { createDateTimeFormat } from "./datetime-format";

const instant = "2026-10-09T22:05:00.000Z";

describe("createDateTimeFormat", () => {
  it("formats in the chosen zone with the chosen clock", () => {
    const tokyo24 = createDateTimeFormat({
      timeZone: "Asia/Tokyo",
      timeFormat: "24h",
      language: "en-US",
    });
    expect(tokyo24.time(instant)).toBe("07:05");
    const la12 = createDateTimeFormat({
      timeZone: "America/Los_Angeles",
      timeFormat: "12h",
      language: "en-US",
    });
    expect(la12.time(instant)).toBe("3:05 PM");
    expect(la12.hour12).toBe(true);
  });

  it("orders numeric and written dates as chosen", () => {
    const base = { timeZone: "UTC", language: "en-US" } as const;
    expect(createDateTimeFormat({ ...base, dateFormat: "mdy" }).numericDate(instant)).toBe(
      "10/09/2026",
    );
    expect(createDateTimeFormat({ ...base, dateFormat: "dmy" }).numericDate(instant)).toBe(
      "09/10/2026",
    );
    expect(createDateTimeFormat({ ...base, dateFormat: "ymd" }).numericDate(instant)).toBe(
      "2026-10-09",
    );
    expect(createDateTimeFormat({ ...base, dateFormat: "mdy" }).date(instant)).toBe("Oct 9, 2026");
    expect(createDateTimeFormat({ ...base, dateFormat: "dmy" }).date(instant)).toBe("9 Oct 2026");
  });

  it("says Today and Yesterday in the chosen zone", () => {
    const format = createDateTimeFormat({ timeZone: "UTC", timeFormat: "24h", language: "en-US" });
    const now = new Date("2026-10-10T08:00:00.000Z");
    expect(format.relative("2026-10-10T07:30:00.000Z", now)).toBe("Today, 07:30");
    expect(format.relative(instant, now)).toBe("Yesterday, 22:05");
    expect(format.relative("2026-03-01T12:00:00.000Z", now)).toBe("Mar 1");
    expect(format.relative("2025-03-01T12:00:00.000Z", now)).toBe("Mar 1, 2025");
  });

  it("falls back to sensible defaults and tolerates bad input", () => {
    const format = createDateTimeFormat({ timeZone: "Not/AZone", weekStart: 1 });
    expect(format.timeZone).not.toBe("Not/AZone");
    expect(format.weekStart).toBe(1);
    expect(format.time("not a date")).toBe("");
    expect(format.dateTime(Number.NaN)).toBe("");
  });

  it("survives locale tags Intl rejects, such as POSIX suffixes", () => {
    const format = createDateTimeFormat({
      language: "en-US@posix",
      timeZone: "UTC",
      timeFormat: "24h",
    });
    expect(format.locale).toBe("en-US");
    expect(format.time("2026-10-09T22:05:00.000Z")).toBe("22:05");
  });
});
