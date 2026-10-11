import { describe, expect, it } from "vitest";
import {
  buildRRule,
  describeRecurrence,
  occurrenceDates,
  parseRRule,
  presetForRule,
  presetLabels,
  ruleForPreset,
  type RecurrenceRule,
} from "./recurrence";

const timed = { startDate: "2026-05-20", allDay: false, timeZone: "America/New_York" };

describe("recurrence presets", () => {
  it("words the choices for the start date", () => {
    expect(presetLabels("2026-05-20")).toMatchObject({
      none: "Does not repeat",
      weekly: "Weekly on Wednesday",
      monthly: "Monthly on day 20",
      annually: "Annually on May 20",
      weekdays: "Every weekday (Monday to Friday)",
      custom: "Custom…",
    });
  });

  it.each([
    ["daily", "FREQ=DAILY"],
    ["weekly", "FREQ=WEEKLY;BYDAY=WE"],
    ["monthly", "FREQ=MONTHLY"],
    ["annually", "FREQ=YEARLY"],
    ["weekdays", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
  ] as const)("builds %s as %s and reads it back", (preset, rrule) => {
    const rule = ruleForPreset(preset, "2026-05-20");
    expect(rule).not.toBeNull();
    expect(buildRRule(rule as RecurrenceRule, timed)).toBe(rrule);
    expect(presetForRule(parseRRule(rrule), "2026-05-20")).toBe(preset);
  });

  it("has no rule for 'Does not repeat'", () => {
    expect(ruleForPreset("none", "2026-05-20")).toBeNull();
    expect(presetForRule(null, "2026-05-20")).toBe("none");
  });
});

describe("custom rules", () => {
  it("round-trips interval, weekdays and a count", () => {
    const rule: RecurrenceRule = {
      frequency: "WEEKLY",
      interval: 2,
      weekdays: ["WE", "MO"],
      end: { kind: "after", count: 5 },
    };
    const text = buildRRule(rule, timed);
    expect(text).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5");
    expect(parseRRule(text)).toEqual({ ...rule, weekdays: ["MO", "WE"] });
    expect(presetForRule(parseRRule(text), "2026-05-20")).toBe("custom");
    expect(describeRecurrence(rule, "2026-05-20")).toBe(
      "Every 2 weeks on Monday and Wednesday, 5 times",
    );
  });

  it("ends 'on' a date at the end of that local day", () => {
    const rule: RecurrenceRule = {
      frequency: "DAILY",
      interval: 1,
      weekdays: [],
      end: { kind: "on", until: "2026-06-30" },
    };
    const text = buildRRule(rule, timed);
    expect(text).toBe("FREQ=DAILY;UNTIL=20260701T035959Z");
    expect(parseRRule(text, "America/New_York")).toEqual(rule);
    expect(buildRRule(rule, { ...timed, allDay: true })).toBe("FREQ=DAILY;UNTIL=20260630");
    expect(describeRecurrence(rule, "2026-05-20")).toBe("Daily, until Jun 30, 2026");
  });

  it("rejects rules the editor cannot show", () => {
    expect(parseRRule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR")).toBeNull();
    expect(parseRRule("FREQ=HOURLY")).toBeNull();
    expect(parseRRule("not a rule")).toBeNull();
    expect(parseRRule("RRULE:FREQ=WEEKLY;BYDAY=TU")).toEqual({
      frequency: "WEEKLY",
      interval: 1,
      weekdays: ["TU"],
      end: { kind: "never" },
    });
  });
});

describe("occurrence expansion", () => {
  it("expands weekly rules into the window", () => {
    const rule = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE") as RecurrenceRule;
    expect(occurrenceDates(rule, "2026-05-20", "2026-05-24", "2026-06-03")).toEqual([
      "2026-05-25",
      "2026-05-27",
      "2026-06-01",
      "2026-06-03",
    ]);
  });

  it("counts from the series start and honours the end date", () => {
    const counted = parseRRule("FREQ=DAILY;COUNT=3") as RecurrenceRule;
    expect(occurrenceDates(counted, "2026-05-20", "2026-05-21", "2026-05-30")).toEqual([
      "2026-05-21",
      "2026-05-22",
    ]);
    const until: RecurrenceRule = { ...counted, end: { kind: "on", until: "2026-05-22" } };
    expect(occurrenceDates(until, "2026-05-20", "2026-05-01", "2026-05-31")).toEqual([
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
    ]);
  });

  it("skips months without the start day", () => {
    const monthly = parseRRule("FREQ=MONTHLY") as RecurrenceRule;
    expect(occurrenceDates(monthly, "2026-01-31", "2026-01-01", "2026-05-31")).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
    ]);
  });
});
