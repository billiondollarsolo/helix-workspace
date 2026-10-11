import {
  localDateTimeToFloatingInstant,
  localDateTimeToInstant,
  type CalendarTimeSemantics,
} from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import ICAL from "ical.js";
import { DavStandardsParseError, parseICalendar } from "../dav/standards.js";
import type { CalendarRecurrenceOverride } from "./recurrence.js";
import type { CalendarAttendeeInput } from "./store.js";
import type { CalendarAttendeeRole, CalendarResponseStatus } from "./types.js";

/** VEVENT parsing shared by CalDAV PUT and inbound iMIP invitation import. */
export interface ParsedVevent {
  readonly uid: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone: string;
  readonly allDay: boolean;
  readonly timeSemantics: CalendarTimeSemantics;
  readonly recurrenceRule: string | null;
  readonly metadata: JsonObject;
  readonly attendees: readonly CalendarAttendeeInput[];
}

export type ICalComponent = InstanceType<typeof ICAL.Component>;

export function parseVeventIcs(body: unknown): ParsedVevent | null {
  const calendar = parseIcsBody(body);
  return calendar === null ? null : parseVeventCalendar(calendar);
}

/** Decode a bounded VCALENDAR body; malformed or oversized input yields null. */
export function parseIcsBody(body: unknown): ICalComponent | null {
  const text =
    typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : null;
  if (text === null) {
    return null;
  }
  try {
    return parseICalendar(text);
  } catch (error) {
    if (error instanceof DavStandardsParseError) return null;
    throw error;
  }
}

/** Parse the master VEVENT (plus bounded overrides) of an already-parsed VCALENDAR. */
export function parseVeventCalendar(calendar: ICalComponent): ParsedVevent | null {
  const vevents = calendar.getAllSubcomponents("vevent");
  const event = vevents.find((candidate) => !candidate.hasProperty("recurrence-id")) ?? vevents[0];
  if (event === undefined) return null;
  const uid = componentText(event, "uid");
  const summary = componentText(event, "summary");
  const startsAt = parseIcsDate(event.getFirstProperty("dtstart"));
  const endsAt = parseIcsDate(event.getFirstProperty("dtend"));
  if (
    uid === null ||
    summary === null ||
    startsAt === null ||
    endsAt === null ||
    endsAt.date.getTime() <= startsAt.date.getTime()
  ) {
    return null;
  }
  const timezone = startsAt.timezone ?? endsAt.timezone ?? "UTC";
  const overrideComponents = vevents.filter((candidate) => candidate.hasProperty("recurrence-id"));
  if (overrideComponents.length > 1_000) return null;
  const overrides = overrideComponents.map((candidate) =>
    parseRecurrenceOverride(candidate, event, uid, startsAt.date, endsAt.date),
  );
  if (overrides.some((candidate) => candidate === null)) return null;
  const exdates = uniqueStrings([
    ...event
      .getAllProperties("exdate")
      .flatMap((candidate) =>
        candidate.getValues().flatMap((value) => parseIcsTime(value, candidate)),
      )
      .map((date) => date.toISOString()),
    ...cancelledRecurrenceIds(vevents),
  ]);
  return {
    uid,
    title: summary,
    description: componentText(event, "description"),
    location: componentText(event, "location"),
    startsAt: startsAt.date,
    endsAt: endsAt.date,
    timezone,
    allDay: startsAt.allDay && endsAt.allDay,
    timeSemantics: startsAt.timeSemantics,
    recurrenceRule: componentValueText(event, "rrule"),
    metadata: {
      source: "caldav.put",
      caldav: {
        exdate: exdates,
        overrides: overrides.flatMap((override) =>
          override === null ? [] : [calendarOverrideJson(override)],
        ),
      },
    },
    attendees: event.getAllProperties("attendee").flatMap(parseAttendee),
  };
}

function calendarOverrideJson(override: CalendarRecurrenceOverride): JsonObject {
  return {
    recurrenceId: override.recurrenceId,
    range: override.range,
    startsAt: override.startsAt,
    endsAt: override.endsAt,
    status: override.status,
    sequence: override.sequence,
    dtstamp: override.dtstamp,
    attendees: override.attendees.map((attendee) => ({
      email: attendee.email,
      responseStatus: attendee.responseStatus,
      ...(attendee.displayName === undefined ? {} : { displayName: attendee.displayName }),
      ...(attendee.role === undefined ? {} : { role: attendee.role }),
    })),
    ...(override.title === undefined ? {} : { title: override.title }),
    ...(override.description === undefined ? {} : { description: override.description }),
    ...(override.location === undefined ? {} : { location: override.location }),
  };
}

function parseRecurrenceOverride(
  component: InstanceType<typeof ICAL.Component>,
  master: InstanceType<typeof ICAL.Component>,
  uid: string,
  masterStartsAt: Date,
  masterEndsAt: Date,
): CalendarRecurrenceOverride | null {
  if (componentText(component, "uid") !== uid) return null;
  const recurrenceProperty = component.getFirstProperty("recurrence-id");
  if (recurrenceProperty === null) return null;
  const recurrence = parseIcsDate(recurrenceProperty);
  if (recurrence === null) return null;
  const duration = masterEndsAt.getTime() - masterStartsAt.getTime();
  const parsedStart = parseIcsDate(component.getFirstProperty("dtstart"));
  const parsedEnd = parseIcsDate(component.getFirstProperty("dtend"));
  const startsAt = parsedStart?.date ?? recurrence.date;
  const endsAt = parsedEnd?.date ?? new Date(startsAt.getTime() + duration);
  if (endsAt <= startsAt) return null;
  const rawStatus = componentText(component, "status")?.toLowerCase() ?? "confirmed";
  if (rawStatus !== "confirmed" && rawStatus !== "tentative" && rawStatus !== "cancelled") {
    return null;
  }
  const rawSequence = component.getFirstPropertyValue("sequence");
  const sequence = rawSequence === null ? 0 : Number(rawSequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
  const dtstamp =
    parseIcsDate(component.getFirstProperty("dtstamp"))?.date ??
    parseIcsDate(master.getFirstProperty("dtstamp"))?.date ??
    new Date(0);
  const rangeValue: unknown = recurrenceProperty.getFirstParameter("range");
  const range = typeof rangeValue === "string" ? rangeValue.toUpperCase() : undefined;
  return {
    recurrenceId: recurrence.date.toISOString(),
    range: range === "THISANDFUTURE" ? "this_and_future" : "this",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: rawStatus,
    title: componentText(component, "summary") ?? componentText(master, "summary") ?? uid,
    description: componentText(component, "description"),
    location: componentText(component, "location"),
    sequence,
    dtstamp: dtstamp.toISOString(),
    attendees: component
      .getAllProperties("attendee")
      .flatMap(parseAttendee)
      .map((attendee) => ({
        email: attendee.email,
        displayName: attendee.displayName,
        role: attendee.role,
        responseStatus: attendee.responseStatus ?? "needs_action",
      })),
  };
}

export function componentText(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
): string | null {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function componentValueText(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
): string | null {
  const value = component.getFirstPropertyValue(name);
  return value === null ? null : String(value);
}

function parseIcsDate(propertyValue: InstanceType<typeof ICAL.Property> | null): {
  readonly date: Date;
  readonly allDay: boolean;
  readonly timezone?: string;
  readonly timeSemantics: CalendarTimeSemantics;
} | null {
  if (propertyValue === null) return null;
  const value = propertyValue.getFirstValue();
  if (!(value instanceof ICAL.Time)) return null;
  return dateFromIcalTime(value, propertyValue.getFirstParameter("tzid"));
}

function dateFromIcalTime(
  value: InstanceType<typeof ICAL.Time>,
  tzid: string | undefined,
): {
  readonly date: Date;
  readonly allDay: boolean;
  readonly timezone?: string;
  readonly timeSemantics: CalendarTimeSemantics;
} | null {
  if (value.isDate) {
    const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
    return { date, allDay: true, timezone: "UTC", timeSemantics: "all_day" };
  }
  const localDateTime = [
    `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`,
    `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}:${String(value.second).padStart(2, "0")}`,
  ].join("T");
  const isUtc = value.zone.tzid === "UTC";
  const timezone = isUtc ? "UTC" : (tzid ?? "UTC");
  const timeSemantics = isUtc || tzid !== undefined ? "zoned" : "floating";
  let date: Date;
  try {
    date =
      timeSemantics === "floating"
        ? localDateTimeToFloatingInstant(localDateTime)
        : localDateTimeToInstant(localDateTime, timezone);
  } catch {
    return null;
  }
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    date,
    allDay: false,
    timezone,
    timeSemantics,
  };
}

function parseIcsTime(
  value: unknown,
  property: InstanceType<typeof ICAL.Property>,
): readonly Date[] {
  if (!(value instanceof ICAL.Time)) return [];
  const parsed = dateFromIcalTime(value, property.getFirstParameter("tzid"));
  return parsed === null ? [] : [parsed.date];
}

function cancelledRecurrenceIds(
  vevents: readonly InstanceType<typeof ICAL.Component>[],
): readonly string[] {
  return vevents.flatMap((event) => {
    if (componentText(event, "status")?.toUpperCase() !== "CANCELLED") return [];
    const parsed = parseIcsDate(event.getFirstProperty("recurrence-id"));
    return parsed === null ? [] : [parsed.date.toISOString()];
  });
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function parseAttendee(
  propertyValue: InstanceType<typeof ICAL.Property>,
): readonly CalendarAttendeeInput[] {
  const raw = propertyValue.getFirstValue();
  if (typeof raw !== "string") return [];
  const email = raw.toLowerCase().startsWith("mailto:") ? raw.slice("mailto:".length) : raw;
  if (!email.includes("@")) {
    return [];
  }
  return [
    {
      email,
      displayName: optionalParameter(propertyValue, "cn") ?? null,
      role: attendeeRole(propertyValue.getFirstParameter("role")),
      responseStatus: attendeeResponse(propertyValue.getFirstParameter("partstat")),
    },
  ];
}

function optionalParameter(
  propertyValue: InstanceType<typeof ICAL.Property>,
  name: string,
): string | undefined {
  const value: unknown = propertyValue.getFirstParameter(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function attendeeRole(value: string | undefined): CalendarAttendeeRole {
  const normalized = value?.toUpperCase();
  if (normalized === "OPT-PARTICIPANT") {
    return "optional";
  }
  if (normalized === "NON-PARTICIPANT") {
    return "resource";
  }
  return "required";
}

function attendeeResponse(value: string | undefined): CalendarResponseStatus {
  const normalized = value?.toUpperCase();
  if (normalized === "ACCEPTED") {
    return "accepted";
  }
  if (normalized === "DECLINED") {
    return "declined";
  }
  if (normalized === "TENTATIVE") {
    return "tentative";
  }
  return "needs_action";
}
