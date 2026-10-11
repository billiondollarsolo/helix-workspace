/* Calendar date arithmetic on ISO `yyyy-mm-dd` dates and decimal hours.

   Dates are wall-calendar days, independent of any time zone: every helper
   works through UTC fields so a DST change can never shift a day. "Today" and
   "now" are read in the viewer's time zone. */

import { instantToLocalDateTime } from "@helix/contracts";

/** 0 = Sunday … 6 = Saturday, matching `Date.getUTCDay`. */
export type WeekStartDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The date picker offers Sunday, Monday or Saturday starts; other days fall back to Sunday. */
export function pickerWeekStart(day: WeekStartDay): 0 | 1 | 6 {
  return day === 1 || day === 6 ? day : 0;
}

/** The viewer's clock: "9:30am" or "09:30". */
export type TimeFormat = "12h" | "24h";

export type CalendarView = "day" | "3day" | "week" | "month" | "schedule";

/** Days the Schedule view lists from its anchor date. */
const SCHEDULE_DAYS = 30;

function fromIso(iso: string): Date {
  const [year = "1970", month = "1", day = "1"] = iso.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addIsoDays(iso: string, days: number): string {
  const date = fromIso(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

/** Same day-of-month in another month, clamped to that month's last day. */
export function addIsoMonths(iso: string, months: number): string {
  const date = fromIso(iso);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return toIso(target);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function isoDayDiff(from: string, to: string): number {
  return Math.round((fromIso(to).getTime() - fromIso(from).getTime()) / 86_400_000);
}

/** Weekday of an ISO date, 0 = Sunday. */
export function isoWeekday(iso: string): number {
  return fromIso(iso).getUTCDay();
}

export function isWeekend(iso: string): boolean {
  const weekday = isoWeekday(iso);
  return weekday === 0 || weekday === 6;
}

/** Today's ISO date in `timeZone`. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return instantToLocalDateTime(now, timeZone).slice(0, 10);
}

/** The current time in `timeZone` as a decimal hour, e.g. 10:42 → 10.7. */
export function nowHourInZone(timeZone: string, now: Date = new Date()): number {
  const local = instantToLocalDateTime(now, timeZone);
  return Number(local.slice(11, 13)) + Number(local.slice(14, 16)) / 60;
}

export function startOfWeekIso(iso: string, weekStartsOn: WeekStartDay): string {
  return addIsoDays(iso, -((isoWeekday(iso) - weekStartsOn + 7) % 7));
}

function isoRange(start: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addIsoDays(start, index));
}

/** Whole weeks covering the month that contains `iso` (5 or 6 rows). */
export function monthWeeks(iso: string, weekStartsOn: WeekStartDay): string[][] {
  const first = `${iso.slice(0, 8)}01`;
  const last = addIsoDays(addIsoMonths(first, 1), -1);
  const gridStart = startOfWeekIso(first, weekStartsOn);
  const weekCount = Math.ceil((isoDayDiff(gridStart, last) + 1) / 7);
  return Array.from({ length: weekCount }, (_, week) =>
    isoRange(addIsoDays(gridStart, week * 7), 7),
  );
}

export interface CalendarViewOptions {
  readonly weekStartsOn: WeekStartDay;
  readonly showWeekends: boolean;
}

/** The day columns a time-grid view shows. */
export function gridDays(
  view: "day" | "3day" | "week",
  anchor: string,
  options: CalendarViewOptions,
): string[] {
  if (view === "day") return [anchor];
  if (view === "3day") return isoRange(anchor, 3);
  const week = isoRange(startOfWeekIso(anchor, options.weekStartsOn), 7);
  return options.showWeekends ? week : week.filter((day) => !isWeekend(day));
}

/** First and last ISO date (inclusive) a view needs events for. */
export function viewRange(
  view: CalendarView,
  anchor: string,
  options: CalendarViewOptions,
): { readonly start: string; readonly end: string } {
  if (view === "month") {
    const weeks = monthWeeks(anchor, options.weekStartsOn);
    return { start: weeks[0]?.[0] ?? anchor, end: weeks.at(-1)?.[6] ?? anchor };
  }
  if (view === "schedule") return { start: anchor, end: addIsoDays(anchor, SCHEDULE_DAYS - 1) };
  const days = gridDays(view, anchor, { ...options, showWeekends: true });
  return { start: days[0] ?? anchor, end: days.at(-1) ?? anchor };
}

/** Move the anchor one view-sized step. */
export function shiftAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
  switch (view) {
    case "day":
      return addIsoDays(anchor, direction);
    case "3day":
      return addIsoDays(anchor, direction * 3);
    case "week":
      return addIsoDays(anchor, direction * 7);
    case "month":
      return addIsoMonths(anchor, direction);
    case "schedule":
      return addIsoDays(anchor, direction * SCHEDULE_DAYS);
  }
}

function formatIso(iso: string, options: Intl.DateTimeFormatOptions): string {
  return fromIso(iso).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

/** Toolbar title: "October 2026", "Oct 12 – 18, 2026", "Sep 28 – Oct 4, 2026", "Dec 29, 2026 – Jan 4, 2027". */
export function formatRangeTitle(view: CalendarView, start: string, end: string): string {
  if (view === "month") return formatIso(addIsoDays(start, 15), { month: "long", year: "numeric" });
  if (view === "day") return formatIso(start, { month: "long", day: "numeric", year: "numeric" });
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const sameMonth = sameYear && start.slice(5, 7) === end.slice(5, 7);
  if (sameMonth) {
    return `${formatIso(start, { month: "short", day: "numeric" })} – ${String(Number(end.slice(8)))}, ${end.slice(0, 4)}`;
  }
  if (sameYear) {
    return `${formatIso(start, { month: "short", day: "numeric" })} – ${formatIso(end, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return `${formatIso(start, { month: "short", day: "numeric", year: "numeric" })} – ${formatIso(end, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** "Thursday, October 15" */
export function formatLongDate(iso: string): string {
  return formatIso(iso, { weekday: "long", month: "long", day: "numeric" });
}

/** "Thu" */
export function formatWeekdayShort(iso: string): string {
  return formatIso(iso, { weekday: "short" });
}

/** "Oct 15, 2026" */
export function formatShortDate(iso: string): string {
  return formatIso(iso, { month: "short", day: "numeric", year: "numeric" });
}

/** "Oct" */
export function formatMonthShort(iso: string): string {
  return formatIso(iso, { month: "short" });
}

/* ------------------------------------------------------------------ times */

/** Snap a decimal hour to a step in minutes (15 → quarter hours). */
export function snapHour(hour: number, stepMinutes = 15): number {
  const steps = 60 / stepMinutes;
  return Math.round(hour * steps) / steps;
}

function clockParts(hour: number): { readonly h: number; readonly m: number } {
  const totalMinutes = Math.round(hour * 60);
  return { h: Math.floor(totalMinutes / 60) % 24, m: totalMinutes % 60 };
}

function meridiem(hour: number): "am" | "pm" {
  return clockParts(hour).h < 12 ? "am" : "pm";
}

function bareTime(hour: number): string {
  const { h, m } = clockParts(hour);
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? String(display) : `${String(display)}:${String(m).padStart(2, "0")}`;
}

/** "9am", "9:30am", "12pm"; or "09:00", "13:30" on a 24-hour clock. */
export function formatTime(hour: number, format: TimeFormat): string {
  if (format === "24h") {
    const { h, m } = clockParts(hour);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return `${bareTime(hour)}${meridiem(hour)}`;
}

/** "9 – 10am", "9:30 – 11am", "11am – 1pm"; or "09:00 – 10:00". */
export function formatTimeRange(start: number, end: number, format: TimeFormat): string {
  const endHour = end >= 24 ? 0 : end;
  if (format === "12h" && meridiem(start) === meridiem(endHour)) {
    return `${bareTime(start)} – ${formatTime(endHour, format)}`;
  }
  return `${formatTime(start, format)} – ${formatTime(endHour, format)}`;
}

/** Hour gutter label: "9 AM" or "09:00". Midnight has no label, like most calendars. */
export function formatHourLabel(hour: number, format: TimeFormat): string {
  if (hour === 0) return "";
  if (format === "24h") return `${String(hour).padStart(2, "0")}:00`;
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(display)} ${hour < 12 ? "AM" : "PM"}`;
}

/** Decimal hour → `HH:MM`, e.g. 13.5 → "13:30"; 24 → "24:00" is clamped to "23:59". */
export function hourToClock(hour: number): string {
  const totalMinutes = Math.min(Math.round(hour * 60), 24 * 60 - 1);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** `HH:MM[:SS]` → decimal hour. */
export function clockToHour(clock: string): number {
  return Number(clock.slice(0, 2)) + Number(clock.slice(3, 5)) / 60;
}

/** Short zone label for the time gutter, e.g. "GMT-04" or "EDT". */
export function formatZoneLabel(timeZone: string, now: Date = new Date()): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(now)
    .find((entry) => entry.type === "timeZoneName");
  return part?.value ?? timeZone;
}
