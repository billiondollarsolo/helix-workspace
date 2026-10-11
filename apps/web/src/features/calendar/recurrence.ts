/* Human recurrence choices ↔ RFC 5545 RRULE text.

   The editor offers "Does not repeat / Daily / Weekly on <day> / Monthly /
   Annually / Every weekday / Custom…"; this module turns those choices into
   the RRULE stored on the event, reads a stored rule back, describes it in
   words, and expands it into occurrence dates for the visible window. Rules
   outside the supported subset parse to `null` and are shown as stored. */

import { localDateTimeToInstant } from "@helix/contracts";
import { addIsoDays, addIsoMonths, isoWeekday, startOfWeekIso } from "./date-math";

export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

type RecurrenceEnd =
  | { readonly kind: "never" }
  | { readonly kind: "on"; readonly until: string }
  | { readonly kind: "after"; readonly count: number };

export interface RecurrenceRule {
  readonly frequency: RecurrenceFrequency;
  readonly interval: number;
  /** Weekly only; empty means "the start date's weekday". */
  readonly weekdays: readonly WeekdayCode[];
  readonly end: RecurrenceEnd;
}

export type RecurrencePreset =
  "none" | "daily" | "weekly" | "monthly" | "annually" | "weekdays" | "custom";

const WORK_WEEK: readonly WeekdayCode[] = ["MO", "TU", "WE", "TH", "FR"];

function weekdayOf(iso: string): WeekdayCode {
  return WEEKDAY_CODES[isoWeekday(iso)] ?? "MO";
}

/** The rule a preset stands for, anchored on the event's start date. */
export function ruleForPreset(preset: RecurrencePreset, startDate: string): RecurrenceRule | null {
  const base = { interval: 1, weekdays: [] as WeekdayCode[], end: { kind: "never" as const } };
  switch (preset) {
    case "none":
    case "custom":
      return null;
    case "daily":
      return { ...base, frequency: "DAILY" };
    case "weekly":
      return { ...base, frequency: "WEEKLY", weekdays: [weekdayOf(startDate)] };
    case "monthly":
      return { ...base, frequency: "MONTHLY" };
    case "annually":
      return { ...base, frequency: "YEARLY" };
    case "weekdays":
      return { ...base, frequency: "WEEKLY", weekdays: [...WORK_WEEK] };
  }
}

/** Which preset a rule matches; anything else is "custom". */
export function presetForRule(rule: RecurrenceRule | null, startDate: string): RecurrencePreset {
  if (rule === null) return "none";
  if (rule.interval !== 1 || rule.end.kind !== "never") return "custom";
  const days = [...rule.weekdays].sort().join(",");
  if (rule.frequency === "DAILY") return "daily";
  if (rule.frequency === "MONTHLY") return "monthly";
  if (rule.frequency === "YEARLY") return "annually";
  if (days === [...WORK_WEEK].sort().join(",")) return "weekdays";
  if (days === "" || days === weekdayOf(startDate)) return "weekly";
  return "custom";
}

export interface RecurrenceTiming {
  /** ISO date the series starts on. */
  readonly startDate: string;
  readonly allDay: boolean;
  /** Zone used to end an "on" rule at the end of that local day. Floating rules pass `null`. */
  readonly timeZone: string | null;
}

/** RRULE text (without the `RRULE:` prefix) for a rule. */
export function buildRRule(rule: RecurrenceRule, timing: RecurrenceTiming): string {
  const parts = [`FREQ=${rule.frequency}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${String(rule.interval)}`);
  if (rule.frequency === "WEEKLY") {
    const days = rule.weekdays.length > 0 ? rule.weekdays : [weekdayOf(timing.startDate)];
    const ordered = WEEKDAY_CODES.filter((code) => days.includes(code));
    parts.push(`BYDAY=${ordered.join(",")}`);
  }
  if (rule.end.kind === "after") parts.push(`COUNT=${String(Math.max(1, rule.end.count))}`);
  if (rule.end.kind === "on") parts.push(`UNTIL=${untilValue(rule.end.until, timing)}`);
  return parts.join(";");
}

function untilValue(until: string, timing: RecurrenceTiming): string {
  const compactDate = until.replaceAll("-", "");
  if (timing.allDay) return compactDate;
  if (timing.timeZone === null) return `${compactDate}T235959`;
  const endOfDay = localDateTimeToInstant(`${until}T23:59:59`, timing.timeZone);
  return `${endOfDay.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`;
}

/** Read a stored rule. Returns `null` for rules the editor cannot represent. */
export function parseRRule(text: string, timeZone: string | null = null): RecurrenceRule | null {
  const fields = new Map<string, string>();
  for (const part of text.replace(/^RRULE:/iu, "").split(";")) {
    const [key, value] = part.split("=");
    if (key === undefined || value === undefined || key.trim() === "") return null;
    fields.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }
  const frequency = fields.get("FREQ");
  if (
    frequency !== "DAILY" &&
    frequency !== "WEEKLY" &&
    frequency !== "MONTHLY" &&
    frequency !== "YEARLY"
  ) {
    return null;
  }
  const supported = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);
  if ([...fields.keys()].some((key) => !supported.has(key))) return null;
  const interval = Number(fields.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) return null;

  const byDay = fields.get("BYDAY");
  const weekdays = byDay === undefined ? [] : byDay.split(",");
  if (!weekdays.every((day): day is WeekdayCode => WEEKDAY_CODES.some((code) => code === day))) {
    return null;
  }
  if (frequency !== "WEEKLY" && weekdays.length > 0) return null;

  const count = fields.get("COUNT");
  const until = fields.get("UNTIL");
  let end: RecurrenceEnd = { kind: "never" };
  if (count !== undefined) {
    const value = Number(count);
    if (!Number.isInteger(value) || value < 1) return null;
    end = { kind: "after", count: value };
  } else if (until !== undefined) {
    const date = untilDate(until, timeZone);
    if (date === null) return null;
    end = { kind: "on", until: date };
  }
  return { frequency, interval, weekdays, end };
}

function untilDate(value: string, timeZone: string | null): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/u.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  const date = `${year ?? ""}-${month ?? ""}-${day ?? ""}`;
  if (hour === undefined || utc !== "Z" || timeZone === null) return date;
  const instant = new Date(`${date}T${hour}:${minute ?? "00"}:${second ?? "00"}Z`);
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(instant);
}

function formatUntil(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** "Weekly on Monday", "Every 2 weeks on Monday and Wednesday, 5 times". */
export function describeRecurrence(rule: RecurrenceRule, startDate: string): string {
  const date = new Date(`${startDate}T00:00:00Z`);
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[rule.frequency];
  const plainName = { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly", YEARLY: "Annually" }[
    rule.frequency
  ];
  const every = rule.interval === 1 ? plainName : `Every ${String(rule.interval)} ${unit}s`;
  let text: string;
  if (rule.frequency === "WEEKLY") {
    const days = rule.weekdays.length > 0 ? rule.weekdays : [weekdayOf(startDate)];
    const isWorkWeek =
      rule.interval === 1 &&
      days.length === WORK_WEEK.length &&
      WORK_WEEK.every((code) => days.includes(code));
    const names = WEEKDAY_CODES.filter((code) => days.includes(code)).map(
      (code) => WEEKDAY_NAMES[WEEKDAY_CODES.indexOf(code)] ?? code,
    );
    text = isWorkWeek ? "Every weekday (Monday to Friday)" : `${every} on ${joinNames(names)}`;
  } else if (rule.frequency === "MONTHLY") {
    text = `${every} on day ${String(date.getUTCDate())}`;
  } else if (rule.frequency === "YEARLY") {
    const monthDay = date.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    text = `${every} on ${monthDay}`;
  } else {
    text = every;
  }
  if (rule.end.kind === "after") {
    return `${text}, ${String(rule.end.count)} ${rule.end.count === 1 ? "time" : "times"}`;
  }
  if (rule.end.kind === "on") return `${text}, until ${formatUntil(rule.end.until)}`;
  return text;
}

/** Labels for the preset menu, worded for the event's start date. */
export function presetLabels(startDate: string): Readonly<Record<RecurrencePreset, string>> {
  const date = new Date(`${startDate}T00:00:00Z`);
  const weekday = WEEKDAY_NAMES[isoWeekday(startDate)] ?? "";
  return {
    none: "Does not repeat",
    daily: "Daily",
    weekly: `Weekly on ${weekday}`,
    monthly: `Monthly on day ${String(date.getUTCDate())}`,
    annually: `Annually on ${date.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}`,
    weekdays: "Every weekday (Monday to Friday)",
    custom: "Custom…",
  };
}

/** Upper bound on generated dates, so a bad rule cannot hang the page. */
const MAX_OCCURRENCES = 1000;

/**
 * Occurrence start dates of a series that fall in `[from, to]` (inclusive ISO
 * dates). COUNT counts from the series start, so earlier occurrences are
 * generated but not returned.
 */
export function occurrenceDates(
  rule: RecurrenceRule,
  startDate: string,
  from: string,
  to: string,
): string[] {
  const result: string[] = [];
  const limit = rule.end.kind === "after" ? rule.end.count : MAX_OCCURRENCES;
  const until = rule.end.kind === "on" ? rule.end.until : null;
  let produced = 0;
  const accept = (date: string): boolean => {
    if (date < startDate) return true;
    if ((until !== null && date > until) || date > to || produced >= limit) return false;
    produced += 1;
    if (date >= from) result.push(date);
    return true;
  };

  if (rule.frequency === "WEEKLY") {
    const days = rule.weekdays.length > 0 ? rule.weekdays : [weekdayOf(startDate)];
    // Weeks run Monday to Sunday (the RFC 5545 default WKST), which matters for intervals.
    const offsets = WEEKDAY_CODES.flatMap((code, index) =>
      days.includes(code) ? [(index + 6) % 7] : [],
    ).sort((left, right) => left - right);
    const firstWeek = startOfWeekIso(startDate, 1);
    for (let week = 0; week < MAX_OCCURRENCES; week += rule.interval) {
      const weekStart = addIsoDays(firstWeek, week * 7);
      if (weekStart > to) break;
      if (!offsets.every((offset) => accept(addIsoDays(weekStart, offset)))) break;
    }
    return result;
  }

  for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
    const step = index * rule.interval;
    const date =
      rule.frequency === "DAILY"
        ? addIsoDays(startDate, step)
        : addIsoMonths(startDate, rule.frequency === "MONTHLY" ? step : step * 12);
    // Monthly on the 31st skips shorter months instead of clamping.
    if (rule.frequency !== "DAILY" && date.slice(8) !== startDate.slice(8)) continue;
    if (!accept(date)) break;
  }
  return result;
}
