/* Calendar visual data model.
   The week view positions events on a fixed 12-hour x 7-day grid. This module
   defines the typed event shape used by the UI, the seed events ported from the
   design handoff (`app-calendar-drive.jsx` -> EVENTS), and helpers that map the
   calendar backend's `CalendarApiEvent` into the same shape. */

import type { CalendarApiCalendar, CalendarApiEvent } from "./api";

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
  /** Stable identifier — backend UUID or a seed id. */
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

/** A toggleable calendar source in the sidebar checklist. */
export interface CalendarSource {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly group: "mine" | "team";
  readonly defaultEnabled: boolean;
}

export const CALENDAR_SOURCES: readonly CalendarSource[] = [
  { id: "alex", name: "Alex Park", color: "var(--accent)", group: "mine", defaultEnabled: true },
  { id: "tasks", name: "Tasks", color: "#0891b2", group: "mine", defaultEnabled: true },
  { id: "birthdays", name: "Birthdays", color: "#059669", group: "mine", defaultEnabled: true },
  { id: "mira", name: "Mira Okafor", color: "#7c3aed", group: "team", defaultEnabled: true },
  { id: "jonas", name: "Jonas Reichert", color: "#dc2626", group: "team", defaultEnabled: true },
  { id: "priya", name: "Priya Anand", color: "#ea580c", group: "team", defaultEnabled: false },
];

/** The signed-in user — shown as "(you)" in the event popover attendee list. */
export const CALENDAR_CURRENT_USER = "Alex Park";

/** Monday of the week the prototype is anchored to (May 18, 2026). */
export const WEEK_START_ISO = "2026-05-18";
/** "Today" in the prototype — Thursday May 21, 2026 (day index 3). */
export const TODAY_ISO = "2026-05-21";
/** Day index (0-6) of "today" within the anchored week. */
export const TODAY_DAY_INDEX = 3;
/** Current decimal hour for the red "now" line (10:42 AM). */
export const NOW_DECIMAL_HOUR = 10.7;

/** ISO date for a Monday-relative day index in the anchored week. */
export function isoDateForDay(dayIndex: number): string {
  const date = new Date(Date.UTC(2026, 4, 18 + dayIndex));
  return date.toISOString().slice(0, 10);
}

/** Day-of-month number for a Monday-relative day index in the anchored week. */
export function dateNumberForDay(dayIndex: number): number {
  return 18 + dayIndex;
}

/** Seed events ported verbatim from the handoff `EVENTS` array. */
export const SEED_EVENTS: readonly CalendarGridEvent[] = [
  {
    id: "seed-eng-standup",
    day: 0,
    start: 9,
    end: 10,
    title: "Eng standup",
    attendees: ["Jonas Reichert", "Daniel Cho", "Mira Okafor"],
    color: "var(--accent)",
    date: isoDateForDay(0),
  },
  {
    id: "seed-atlas-renewal",
    day: 0,
    start: 11,
    end: 12,
    title: "Atlas renewal call",
    attendees: ["Rumi Tanaka"],
    color: "#0891b2",
    location: "Helix Meet",
    date: isoDateForDay(0),
  },
  {
    id: "seed-design-review",
    day: 0,
    start: 14,
    end: 15.5,
    title: "Design review — onboarding",
    attendees: ["Priya Anand"],
    color: "#7c3aed",
    date: isoDateForDay(0),
  },
  {
    id: "seed-1-1-jonas",
    day: 1,
    start: 9,
    end: 9.5,
    title: "1:1 with Jonas",
    attendees: ["Jonas Reichert"],
    color: "#475569",
    date: isoDateForDay(1),
  },
  {
    id: "seed-roadmap-session",
    day: 1,
    start: 10,
    end: 11.5,
    title: "Q3 Roadmap working session",
    attendees: ["Mira Okafor", "Priya Anand", "Jonas Reichert"],
    color: "var(--accent)",
    location: "Helix Meet",
    date: isoDateForDay(1),
  },
  {
    id: "seed-lunch-sasha",
    day: 1,
    start: 13,
    end: 14,
    title: "Lunch — Sasha",
    attendees: ["Sasha Levin"],
    color: "#059669",
    date: isoDateForDay(1),
  },
  {
    id: "seed-offsite-prep",
    day: 2,
    start: 8,
    end: 9,
    title: "Exec offsite prep",
    attendees: ["Mira Okafor"],
    color: "#475569",
    date: isoDateForDay(2),
  },
  {
    id: "seed-board-review",
    day: 2,
    start: 11,
    end: 12,
    title: "Board materials review",
    attendees: ["Naveen Iyer"],
    color: "#dc2626",
    date: isoDateForDay(2),
  },
  {
    id: "seed-ai-demo",
    day: 2,
    start: 15,
    end: 16,
    title: "Helix AI demo",
    attendees: ["Daniel Cho", "Priya Anand"],
    color: "var(--accent)",
    date: isoDateForDay(2),
  },
  {
    id: "seed-hiring-debrief",
    day: 3,
    start: 9.5,
    end: 10.5,
    title: "Hiring loop debrief — Maya",
    attendees: ["Sasha Levin", "Jonas Reichert"],
    color: "#059669",
    date: isoDateForDay(3),
  },
  {
    id: "seed-1-1-mira",
    day: 3,
    start: 11,
    end: 12,
    title: "1:1 with Mira",
    attendees: ["Mira Okafor"],
    color: "#7c3aed",
    date: isoDateForDay(3),
  },
  {
    id: "seed-caroline-atlas",
    day: 3,
    start: 14,
    end: 15,
    title: "Caroline Reyes / Atlas",
    attendees: ["Rumi Tanaka"],
    color: "#0891b2",
    date: isoDateForDay(3),
  },
  {
    id: "seed-postmortem",
    day: 3,
    start: 15.5,
    end: 17,
    title: "Postmortem — auth 05/15",
    attendees: ["Daniel Cho", "Jonas Reichert"],
    color: "#dc2626",
    date: isoDateForDay(3),
  },
  {
    id: "seed-leadership-sync",
    day: 4,
    start: 9,
    end: 10,
    title: "Weekly leadership sync",
    attendees: ["Mira Okafor", "Naveen Iyer", "Sasha Levin", "Owen Hart"],
    color: "var(--accent)",
    date: isoDateForDay(4),
  },
  {
    id: "seed-roadmap-signoff",
    day: 4,
    start: 13,
    end: 14,
    title: "Roadmap sign-off (DEADLINE)",
    attendees: ["Mira Okafor"],
    color: "#dc2626",
    date: isoDateForDay(4),
  },
  {
    id: "seed-all-hands",
    day: 4,
    start: 16,
    end: 17,
    title: "Helix all-hands",
    attendees: [],
    color: "#ea580c",
    date: isoDateForDay(4),
  },
];

/** Source colours cycled when a backend event lacks a known calendar. */
const BACKEND_EVENT_COLORS = ["var(--accent)", "#0891b2", "#7c3aed", "#dc2626", "#ea580c", "#059669"];

/** Stable hash → index in [0, mod) for deterministic colour assignment. */
function hashIndex(value: string, mod: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % mod;
}

/** Monday-relative day index (0-6) for an ISO timestamp in the anchored week. */
function dayIndexForIso(iso: string): number {
  const date = new Date(iso);
  const weekday = date.getUTCDay();
  return weekday === 0 ? 6 : weekday - 1;
}

/** Decimal hour (UTC) for an ISO timestamp. */
function decimalHourForIso(iso: string): number {
  const date = new Date(iso);
  return date.getUTCHours() + date.getUTCMinutes() / 60;
}

/**
 * Map a backend `CalendarApiEvent` into the week-grid event shape. Events that
 * fall outside the anchored week or the visible hour band are still returned —
 * callers filter them out so off-grid events don't render as broken cards.
 *
 * `calendarColors` maps a calendar id to its sidebar colour so backend events
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
