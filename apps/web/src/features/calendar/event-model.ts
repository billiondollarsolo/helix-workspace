/* Backend calendar events and calendars mapped to what the views draw.

   Events are listed as series masters; recurring ones are expanded here into
   the occurrences that fall in the visible window. All positions are in the
   viewer's time zone, except floating and all-day events, which keep their
   wall-clock times wherever they are viewed. */

import { instantToLocalDateTime, localDateTimeToInstant } from "@helix/contracts";
import type {
  CalendarApiCalendar,
  CalendarApiEvent,
  CalendarApiResponseStatus,
  CalendarListEventsInput,
} from "./api";
import { calendarLabel, type CalendarLabel } from "./colors";
import { conferenceFromMetadata, externalConferenceUrl } from "./conference";
import { addIsoDays, clockToHour } from "./date-math";
import { occurrenceDates, parseRRule } from "./recurrence";

/** A calendar in the sidebar. */
export interface CalendarSource {
  readonly id: string;
  readonly name: string;
  readonly label: CalendarLabel;
  readonly group: "mine" | "team";
  readonly visible: boolean;
  readonly role: CalendarApiCalendar["role"];
  readonly writable: boolean;
  readonly timezone: string;
  readonly ownerDisplayName: string | null;
  /** The owner's primary calendar: it can be renamed and recoloured but not deleted. */
  readonly isDefault: boolean;
}

export function calendarSourceFromApi(calendar: CalendarApiCalendar): CalendarSource {
  return {
    id: calendar.id,
    name: calendar.name,
    label: calendarLabel(calendar.color),
    group: calendar.group,
    visible: calendar.visible,
    role: calendar.role,
    writable: calendar.writable ?? calendar.role !== "reader",
    timezone: calendar.timezone ?? "UTC",
    ownerDisplayName: calendar.ownerDisplayName ?? null,
    isDefault: calendar.isDefault ?? false,
  };
}

/** One drawn instance of an event (a single event, or one date of a series). */
export interface CalendarOccurrence {
  /** Unique per occurrence: `<eventId>:<start date>`. */
  readonly key: string;
  readonly event: CalendarApiEvent;
  readonly label: CalendarLabel;
  /** Drawn in the all-day row: all-day events and anything 24 hours or longer. */
  readonly allDay: boolean;
  /** Viewer-local first and last day (inclusive). */
  readonly startDate: string;
  readonly endDate: string;
  /** Decimal hours: `start` on `startDate`, `end` on `endDate` (24 = midnight). */
  readonly start: number;
  readonly end: number;
  /** Viewer-local `yyyy-mm-ddTHH:MM:SS` bounds of this occurrence. */
  readonly startsLocal: string;
  readonly endsLocal: string;
  readonly recurring: boolean;
  /** The viewer's own RSVP, when they are a guest. */
  readonly selfStatus: CalendarApiResponseStatus | null;
}

export interface ViewerIdentity {
  readonly actorId: string | null;
  readonly email: string | null;
}

export interface OccurrenceContext {
  readonly calendars: ReadonlyMap<string, CalendarSource>;
  readonly timeZone: string;
  /** Inclusive ISO date window. */
  readonly from: string;
  readonly to: string;
  readonly viewer: ViewerIdentity;
}

/** The viewer's guest entry on an event, if any. */
export function selfAttendee(event: CalendarApiEvent, viewer: ViewerIdentity) {
  return (
    event.attendees.find((attendee) =>
      attendee.actorId && viewer.actorId
        ? attendee.actorId === viewer.actorId
        : viewer.email !== null && attendee.email.toLowerCase() === viewer.email.toLowerCase(),
    ) ?? null
  );
}

function usesWallClock(event: CalendarApiEvent): boolean {
  return event.allDay || event.timeSemantics === "floating" || event.timeSemantics === "all_day";
}

/** Wall-clock bounds of the series master, in the zone its recurrence runs in. */
function seriesBounds(event: CalendarApiEvent): { readonly start: string; readonly end: string } {
  if (usesWallClock(event)) {
    return {
      start: event.startsLocal ?? instantToLocalDateTime(event.startsAt, "UTC"),
      end: event.endsLocal ?? instantToLocalDateTime(event.endsAt, "UTC"),
    };
  }
  const zone = event.timezone ?? "UTC";
  return {
    start: instantToLocalDateTime(event.startsAt, zone),
    end: instantToLocalDateTime(event.endsAt, zone),
  };
}

/** Shift a local `yyyy-mm-ddTHH:MM:SS` by whole minutes. */
export function addLocalMinutes(local: string, minutes: number): string {
  const instant = new Date(`${local.slice(0, 19)}Z`);
  return new Date(instant.getTime() + minutes * 60_000).toISOString().slice(0, 19);
}

function localMinutesBetween(start: string, end: string): number {
  return Math.round(
    (new Date(`${end.slice(0, 19)}Z`).getTime() - new Date(`${start.slice(0, 19)}Z`).getTime()) /
      60_000,
  );
}

/** Viewer-local bounds for a series-zone wall-clock start, or null inside a DST gap. */
function viewerBounds(
  event: CalendarApiEvent,
  seriesStart: string,
  durationMinutes: number,
  timeZone: string,
): { readonly start: string; readonly end: string } | null {
  if (usesWallClock(event)) {
    return { start: seriesStart, end: addLocalMinutes(seriesStart, durationMinutes) };
  }
  try {
    const instant = localDateTimeToInstant(seriesStart.slice(0, 19), event.timezone ?? "UTC");
    return {
      start: instantToLocalDateTime(instant, timeZone),
      end: instantToLocalDateTime(new Date(instant.getTime() + durationMinutes * 60_000), timeZone),
    };
  } catch {
    return null;
  }
}

function occurrenceFrom(
  event: CalendarApiEvent,
  bounds: { readonly start: string; readonly end: string },
  context: OccurrenceContext,
  recurring: boolean,
): CalendarOccurrence {
  const startDate = bounds.start.slice(0, 10);
  const endsAtMidnight = bounds.end.slice(11, 19) === "00:00:00" && bounds.end > bounds.start;
  const endDate = endsAtMidnight
    ? addIsoDays(bounds.end.slice(0, 10), -1)
    : bounds.end.slice(0, 10);
  const start = clockToHour(bounds.start.slice(11, 16));
  const rawEnd = endsAtMidnight ? 24 : clockToHour(bounds.end.slice(11, 16));
  const durationMinutes = localMinutesBetween(bounds.start, bounds.end);
  const calendar = context.calendars.get(event.calendarId);
  return {
    key: `${event.id}:${startDate}`,
    event,
    label: calendar?.label ?? calendarLabel(null),
    allDay: event.allDay || durationMinutes >= 24 * 60,
    startDate,
    endDate: endDate < startDate ? startDate : endDate,
    start,
    end: endDate === startDate && rawEnd <= start ? Math.min(24, start + 0.25) : rawEnd,
    startsLocal: bounds.start,
    endsLocal: bounds.end,
    recurring,
    selfStatus: selfAttendee(event, context.viewer)?.responseStatus ?? null,
  };
}

/** Every occurrence of `events` that touches the context window, sorted by start. */
export function occurrencesInWindow(
  events: readonly CalendarApiEvent[],
  context: OccurrenceContext,
): CalendarOccurrence[] {
  const result: CalendarOccurrence[] = [];
  for (const event of events) {
    if (event.status === "cancelled") continue;
    const series = seriesBounds(event);
    const duration = Math.max(15, localMinutesBetween(series.start, series.end));
    const rule =
      event.recurrenceRule === null || event.recurrenceRule === undefined
        ? null
        : parseRRule(event.recurrenceRule, usesWallClock(event) ? null : (event.timezone ?? "UTC"));
    const spanDays = Math.ceil(duration / 1440) + 1;
    const starts =
      rule === null
        ? [series.start]
        : occurrenceDates(
            rule,
            series.start.slice(0, 10),
            addIsoDays(context.from, -spanDays),
            addIsoDays(context.to, 1),
          ).map((date) => `${date}${series.start.slice(10, 19)}`);
    for (const seriesStart of starts) {
      const bounds = viewerBounds(event, seriesStart, duration, context.timeZone);
      if (bounds === null) continue;
      const occurrence = occurrenceFrom(event, bounds, context, rule !== null);
      if (occurrence.endDate >= context.from && occurrence.startDate <= context.to) {
        result.push(occurrence);
      }
    }
  }
  return result.sort(
    (left, right) =>
      left.startsLocal.localeCompare(right.startsLocal) ||
      right.endsLocal.localeCompare(left.endsLocal),
  );
}

/** True when the occurrence covers any part of `day`. */
export function occursOn(occurrence: CalendarOccurrence, day: string): boolean {
  return occurrence.startDate <= day && occurrence.endDate >= day;
}

/** Resolve a date-based display window to the viewer's real boundary instants. */
export function eventQueryWindowForTimeZone(
  input: CalendarListEventsInput,
  viewerTimeZone: string,
): CalendarListEventsInput {
  if (input.startsAt === undefined || input.endsAt === undefined) return input;
  const startsAt = localDateTimeToInstant(
    `${input.startsAt.slice(0, 10)}T00:00:00`,
    viewerTimeZone,
  );
  const exclusiveEnd = localDateTimeToInstant(
    `${addIsoDays(input.endsAt.slice(0, 10), 1)}T00:00:00`,
    viewerTimeZone,
  );
  return {
    ...input,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(exclusiveEnd.getTime() - 1).toISOString(),
  };
}

/**
 * The event's video call. `meet` is this workspace's own Meet room; any other
 * link (an imported invitation's meeting, an http(s) location) is `external`
 * and is only ever shown as a plain link.
 */
export interface EventJoinLink {
  readonly url: string;
  readonly kind: "meet" | "external";
}

export function eventJoinLink(event: CalendarApiEvent): EventJoinLink | null {
  const meet = httpUrl(conferenceFromMetadata(event.metadata)?.joinUrl);
  if (meet !== null) return { url: meet, kind: "meet" };
  const external = httpUrl(externalConferenceUrl(event.metadata)) ?? httpUrl(event.location);
  return external === null ? null : { url: external, kind: "external" };
}

export function httpUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
