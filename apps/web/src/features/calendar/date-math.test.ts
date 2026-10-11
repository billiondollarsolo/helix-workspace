import { describe, expect, it } from "vitest";
import {
  addIsoMonths,
  formatHourLabel,
  formatRangeTitle,
  formatTime,
  formatTimeRange,
  gridDays,
  monthWeeks,
  nowHourInZone,
  shiftAnchor,
  snapHour,
  startOfWeekIso,
  todayInZone,
  viewRange,
} from "./date-math";

describe("today and now", () => {
  it("reads today's full date in the viewer's zone, not just the weekday", () => {
    const instant = new Date("2026-05-21T02:30:00.000Z");
    expect(todayInZone("UTC", instant)).toBe("2026-05-21");
    expect(todayInZone("America/Los_Angeles", instant)).toBe("2026-05-20");
    expect(todayInZone("Asia/Tokyo", instant)).toBe("2026-05-21");
    // A week later is a different "today", even on the same weekday.
    expect(todayInZone("UTC", new Date("2026-05-28T02:30:00.000Z"))).toBe("2026-05-28");
  });

  it("reads the current hour in the viewer's zone", () => {
    expect(nowHourInZone("America/New_York", new Date("2026-05-20T14:45:00.000Z"))).toBe(10.75);
  });
});

describe("week ranges", () => {
  const options = { weekStartsOn: 0 as const, showWeekends: true };

  it("starts weeks on the preferred day", () => {
    expect(startOfWeekIso("2026-05-20", 0)).toBe("2026-05-17");
    expect(startOfWeekIso("2026-05-20", 1)).toBe("2026-05-18");
    expect(startOfWeekIso("2026-05-17", 1)).toBe("2026-05-11");
    expect(startOfWeekIso("2026-05-20", 6)).toBe("2026-05-16");
  });

  it("lists the day columns for day, 3-day and week views", () => {
    expect(gridDays("day", "2026-05-20", options)).toEqual(["2026-05-20"]);
    expect(gridDays("3day", "2026-05-20", options)).toEqual([
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
    ]);
    expect(gridDays("week", "2026-05-20", options)).toHaveLength(7);
    expect(gridDays("week", "2026-05-20", { weekStartsOn: 1, showWeekends: false })).toEqual([
      "2026-05-18",
      "2026-05-19",
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
    ]);
  });

  it("crosses month and year boundaries", () => {
    expect(viewRange("week", "2026-12-31", options)).toEqual({
      start: "2026-12-27",
      end: "2027-01-02",
    });
    expect(viewRange("schedule", "2026-05-20", options)).toEqual({
      start: "2026-05-20",
      end: "2026-06-18",
    });
  });
});

describe("month grid", () => {
  it("covers whole weeks around the month", () => {
    const may = monthWeeks("2026-05-20", 0);
    expect(may).toHaveLength(6);
    expect(may[0]?.[0]).toBe("2026-04-26");
    expect(may.at(-1)?.[6]).toBe("2026-06-06");
    const february = monthWeeks("2026-02-10", 0);
    expect(february).toHaveLength(4);
    expect(february[0]?.[0]).toBe("2026-02-01");
    expect(monthWeeks("2026-05-20", 1)[0]?.[0]).toBe("2026-04-27");
  });

  it("clamps month steps to the last day", () => {
    expect(addIsoMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftAnchor("month", "2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftAnchor("week", "2026-05-20", 1)).toBe("2026-05-27");
    expect(shiftAnchor("3day", "2026-05-20", -1)).toBe("2026-05-17");
  });
});

describe("labels", () => {
  it("titles each view", () => {
    expect(formatRangeTitle("week", "2026-05-17", "2026-05-23")).toBe("May 17 – 23, 2026");
    expect(formatRangeTitle("week", "2026-09-27", "2026-10-03")).toBe("Sep 27 – Oct 3, 2026");
    expect(formatRangeTitle("week", "2026-12-27", "2027-01-02")).toBe("Dec 27, 2026 – Jan 2, 2027");
    expect(formatRangeTitle("month", "2026-04-26", "2026-06-06")).toBe("May 2026");
    expect(formatRangeTitle("day", "2026-05-20", "2026-05-20")).toBe("May 20, 2026");
  });

  it("formats times the way calendar users read them", () => {
    expect(formatTime(9)).toBe("9am");
    expect(formatTime(13.5)).toBe("1:30pm");
    expect(formatTime(12)).toBe("12pm");
    expect(formatTime(0)).toBe("12am");
    expect(formatTimeRange(9, 10)).toBe("9 – 10am");
    expect(formatTimeRange(9.5, 11)).toBe("9:30 – 11am");
    expect(formatTimeRange(11, 13)).toBe("11am – 1pm");
    expect(formatTimeRange(23, 24)).toBe("11pm – 12am");
    expect(formatHourLabel(0)).toBe("");
    expect(formatHourLabel(9)).toBe("9 AM");
    expect(formatHourLabel(12)).toBe("12 PM");
    expect(formatHourLabel(15)).toBe("3 PM");
  });

  it("snaps to quarter hours", () => {
    expect(snapHour(9.13)).toBe(9.25);
    expect(snapHour(9.12)).toBe(9);
    expect(snapHour(9.74, 30)).toBe(9.5);
  });
});
