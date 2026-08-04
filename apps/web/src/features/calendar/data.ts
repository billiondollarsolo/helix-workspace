/* Calendar visual data model.
 *
 * The week view positions events on a fixed 12-hour x 7-day grid. This module
 * defines the typed event shape used by the UI, dynamic "today/now" helpers
 * driven by the system clock, and mappers from the calendar backend's
 * `CalendarApiEvent` onto the UI shape. No fabricated event data lives here. */

import type { CalendarApiCalendar, CalendarApiEvent } from "./api";

/** JS weekdays are Sunday-first; the calendar grid is Monday-first. */
function mondayRelativeIndex(weekday: number): number {
  return weekday === 0 ? 6 : weekday - 1;
}

/** First hour shown in the week grid (7 AM). */
export const GRID_START_HOUR = 7;
/** Number of hour rows rendered (7 AM - 6 PM). */
export const GRID_HOUR_COUNT = 12;
/** Pixel height of a single hour row. */
export const HOUR_HEIGHT = 56;

/** Hour labels for the gutter, e.g. [7, 8, ..., 18]. */
export const GRID_HOURS: readonly number[] = Array.from(
  { length: GRID_HOUR_COUNT },
  (_, index) => GRID_START_HOUR + index,
);

/** Monday-anchored short weekday labels for day-column headers. */
export const WEEK_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** A calendar event placed on the week grid. */
export interface CalendarGridEvent {
  /** Stable identifier — backend UUID. */
  readonly id: string;
  /** Monday-relative day index, 0 (Mon) - 6 (Sun). */
  readonly day: number;
  /** Start time as a 24h decimal hour (9.5 = 9:30 AM). */
  readonly start: number;
  /** End time as a 24h decimal hour. */
  readonly end: number;
  /** Event title. */
  readonly title: string;
  /** Attendee display names (excludes the current user). */
  readonly attendees: readonly string[];
  /** Card colour — a CSS colour or token reference. */
  readonly color: string;
  /** Optional location / conferencing label. */
  readonly location?: string;
  /** ISO `yyyy-mm-dd` of the event's day. */
  readonly date: string;
  /** Owning calendar id, when the event came from the backend. */
  readonly calendarId?: string;
  /** Raw backend event, present only for backend-sourced events. */
  readonly apiEvent?: CalendarApiEvent;
}

/** A toggleable calendar source mapped from `calendar.calendars.list`. */
export interface CalendarSidebarEntry {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly group: "mine" | "team";
  readonly visible: boolean;
  readonly role: string;
  readonly writable: boolean;
}

/** ISO `yyyy-mm-dd` for today, using the system clock. */
// Re-exported so the data helpers and the route-state helpers cannot drift.
export { todayIso } from "./route-state";

/** Monday-relative day index (0-6) for today, using the system clock. */
export function todayDayIndex(): number {
  const weekday = new Date().getDay();
  return mondayRelativeIndex(weekday);
}

/** Decimal hour for "now" using the local clock (e.g. 10:42 → 10.7). */
export function nowDecimalHour(): number {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
}

/** Day-of-month number for a Monday-relative day in the given week. */
export function dateNumberForDay(weekStartIso: string, dayIndex: number): number {
  const base = new Date(`${weekStartIso}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + dayIndex);
  return base.getUTCDate();
}

const BACKEND_EVENT_COLORS = [
  "var(--accent)",
  "#0891b2",
  "#7c3aed",
  "#dc2626",
  "#ea580c",
  "#059669",
];

/** Stable hash → index in [0, mod) for deterministic colour assignment. */
function hashIndex(value: string, mod: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % mod;
}

/** Monday-relative day index (0-6) for an ISO timestamp. */
function dayIndexForIso(iso: string): number {
  const date = new Date(iso);
  const weekday = date.getUTCDay();
  return mondayRelativeIndex(weekday);
}

/** Decimal hour (UTC) for an ISO timestamp. */
function decimalHourForIso(iso: string): number {
  const date = new Date(iso);
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}

/**
 * Convert a backend `CalendarApiEvent` into the week-grid event shape. Cards
 * are tinted to match their owning calendar; events with no known calendar
 * fall back to a deterministic colour derived from the event id.
 */
export function gridEventFromApiEvent(
  event: CalendarApiEvent,
  calendarColors: ReadonlyMap<string, string> = new Map(),
): CalendarGridEvent {
  const day = dayIndexForIso(event.startsAt);
  const start = decimalHourForIso(event.startsAt);
  const end = decimalHourForIso(event.endsAt);
  const calendarColor = calendarColors.get(event.calendarId);
  return {
    id: event.id,
    day,
    start,
    end: end > start ? end : start + 0.5,
    title: event.title,
    attendees: event.attendees
      .filter((attendee) => attendee.isOrganizer !== true)
      .map((attendee) => attendee.displayName ?? attendee.email),
    color:
      calendarColor ??
      BACKEND_EVENT_COLORS[hashIndex(event.id, BACKEND_EVENT_COLORS.length)] ??
      "var(--accent)",
    location: event.location ?? undefined,
    date: event.startsAt.slice(0, 10),
    calendarId: event.calendarId,
    apiEvent: event,
  };
}

/** Map a backend `calendar.calendars.list` entry into a sidebar entry. */
export function sidebarEntryFromApiCalendar(calendar: CalendarApiCalendar): CalendarSidebarEntry {
  return {
    id: calendar.id,
    name: calendar.name,
    color: calendar.color,
    group: calendar.group,
    visible: calendar.visible,
    role: calendar.role,
    writable: calendar.writable ?? calendar.role !== "viewer",
  };
}

/** True when an event lands on the visible week grid (days 0-6, hours 7-19). */
export function isOnGrid(event: CalendarGridEvent): boolean {
  return (
    event.day >= 0 &&
    event.day <= 6 &&
    event.end > GRID_START_HOUR &&
    event.start < GRID_START_HOUR + GRID_HOUR_COUNT
  );
}

/** Format a decimal hour as a 12-hour clock string, e.g. 13.5 -> "1:30 PM". */
export function formatHour(decimalHour: number): string {
  const hour = Math.floor(decimalHour);
  const minutes = Math.round((decimalHour - hour) * 60);
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(display)}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

/** Short start-time label used on event cards, e.g. 14.5 -> "2:30". */
export function formatCardTime(decimalHour: number): string {
  const hour = Math.floor(decimalHour);
  const minutes = Math.round((decimalHour - hour) * 60);
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return minutes === 0 ? String(display) : `${String(display)}:${String(minutes).padStart(2, "0")}`;
}
