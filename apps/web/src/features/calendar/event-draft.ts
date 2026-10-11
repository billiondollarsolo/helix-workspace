/* The editable shape behind quick create and the full event editor, and its
   conversion to and from the calendar API. */

import {
  instantToLocalDateTime,
  localDateTimeToFloatingInstant,
  localDateTimeToInstant,
  type CalendarTimeSemantics,
} from "@helix/contracts";
import type { PersonRef } from "@/features/people/person-ref";
import type { CalendarApiAttendeeInput, CalendarApiEvent, CalendarCreateEventInput } from "./api";
import { conferenceFromMetadata, metadataWithConference, type EventConference } from "./conference";
import { addIsoDays, clockToHour, hourToClock } from "./date-math";
import { buildRRule, describeRecurrence, parseRRule, type RecurrenceRule } from "./recurrence";
import {
  DEFAULT_REMINDER,
  isReminderValid,
  metadataWithReminder,
  reminderFromMetadata,
  type Reminder,
} from "./reminders";

export interface EventDraft {
  readonly mode: "create" | "edit";
  readonly eventId?: string;
  readonly calendarId: string | null;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly guests: readonly PersonRef[];
  readonly startDate: string;
  /** Decimal hours; ignored for all-day events. */
  readonly startTime: number;
  /** Inclusive last day for all-day events; the end day otherwise. */
  readonly endDate: string;
  readonly endTime: number;
  readonly allDay: boolean;
  readonly timeZone: string;
  /** Timed events stay "zoned" or "floating"; all-day events ignore this. */
  readonly timedSemantics: Exclude<CalendarTimeSemantics, "all_day">;
  readonly recurrence: RecurrenceRule | null;
  /** A stored rule the editor cannot represent, kept as-is until changed. */
  readonly preservedRule: string | null;
  readonly reminder: Reminder | null;
  readonly conference: EventConference | null;
  /** Create a Meet room on save. */
  readonly addConference: boolean;
  /** Shown as busy in free/busy (`transparency: opaque`). */
  readonly busy: boolean;
  /** Original metadata, carried through edits. */
  readonly metadata: Record<string, unknown>;
  /** Original attendees, so existing RSVPs survive an edit. */
  readonly attendees: CalendarApiEvent["attendees"];
}

export interface NewDraftSeed {
  readonly date: string;
  readonly start?: number;
  readonly end?: number;
  readonly allDay?: boolean;
  readonly title?: string;
  readonly calendarId: string | null;
  readonly timeZone: string;
  readonly guests?: readonly PersonRef[];
}

export function newEventDraft(seed: NewDraftSeed): EventDraft {
  const start = seed.start ?? 9;
  const end = seed.end ?? Math.min(24, start + 1);
  return {
    mode: "create",
    calendarId: seed.calendarId,
    title: seed.title ?? "",
    description: "",
    location: "",
    guests: seed.guests ?? [],
    startDate: seed.date,
    startTime: start,
    endDate: end >= 24 && !seed.allDay ? addIsoDays(seed.date, 1) : seed.date,
    endTime: end >= 24 ? 0 : end,
    allDay: seed.allDay ?? false,
    timeZone: seed.timeZone,
    timedSemantics: "zoned",
    recurrence: null,
    preservedRule: null,
    reminder: DEFAULT_REMINDER,
    conference: null,
    addConference: false,
    busy: true,
    metadata: {},
    attendees: [],
  };
}

function guestFromAttendee(attendee: CalendarApiEvent["attendees"][number]): PersonRef {
  return {
    kind: attendee.actorId ? "member" : "external",
    displayName: attendee.displayName ?? attendee.email,
    email: attendee.email,
    actorId: attendee.actorId ?? null,
    groupId: null,
    title: null,
    avatarDataUrl: null,
  };
}

/** Load an event into the editor, in the zone its times were written in. */
export function draftFromEvent(event: CalendarApiEvent): EventDraft {
  const wallClock =
    event.allDay || event.timeSemantics === "floating" || event.timeSemantics === "all_day";
  const zone = wallClock ? "UTC" : (event.timezone ?? "UTC");
  const startsLocal =
    (wallClock ? event.startsLocal : undefined) ?? instantToLocalDateTime(event.startsAt, zone);
  const endsLocal =
    (wallClock ? event.endsLocal : undefined) ?? instantToLocalDateTime(event.endsAt, zone);
  const parsed =
    event.recurrenceRule === null || event.recurrenceRule === undefined
      ? null
      : parseRRule(event.recurrenceRule, wallClock ? null : zone);
  return {
    mode: "edit",
    eventId: event.id,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description ?? "",
    location: event.location ?? "",
    guests: event.attendees
      .filter((attendee) => attendee.isOrganizer !== true)
      .map(guestFromAttendee),
    startDate: startsLocal.slice(0, 10),
    startTime: clockToHour(startsLocal.slice(11, 16)),
    endDate: event.allDay ? addIsoDays(endsLocal.slice(0, 10), -1) : endsLocal.slice(0, 10),
    endTime: clockToHour(endsLocal.slice(11, 16)),
    allDay: event.allDay,
    timeZone: event.timezone ?? "UTC",
    timedSemantics: event.timeSemantics === "floating" ? "floating" : "zoned",
    recurrence: parsed,
    preservedRule: parsed === null ? (event.recurrenceRule ?? null) : null,
    reminder: reminderFromMetadata(event.metadata),
    conference: conferenceFromMetadata(event.metadata),
    addConference: false,
    busy: event.metadata?.transparency !== "transparent",
    metadata: event.metadata ?? {},
    attendees: event.attendees,
  };
}

/** Local wall-clock bounds of the draft, `yyyy-mm-ddTHH:MM:SS`. */
export function draftLocalBounds(draft: EventDraft): {
  readonly start: string;
  readonly end: string;
} {
  if (draft.allDay) {
    return {
      start: `${draft.startDate}T00:00:00`,
      end: `${addIsoDays(draft.endDate, 1)}T00:00:00`,
    };
  }
  return {
    start: `${draft.startDate}T${hourToClock(draft.startTime)}:00`,
    end: `${draft.endDate}T${hourToClock(draft.endTime)}:00`,
  };
}

/** What is wrong with the draft, in words, or null when it can be saved. */
export function draftProblem(draft: EventDraft): string | null {
  const bounds = draftLocalBounds(draft);
  if (draft.allDay ? draft.endDate < draft.startDate : bounds.end <= bounds.start) {
    return "The event must end after it starts.";
  }
  if (draft.reminder !== null && !isReminderValid(draft.reminder)) {
    return "Notifications can be at most 4 weeks before the event.";
  }
  if (draft.guests.some((guest) => guest.email === null)) {
    return "Every guest needs an email address.";
  }
  return null;
}

function attendeeInputs(draft: EventDraft): CalendarApiAttendeeInput[] {
  const existing = new Map(
    draft.attendees.map((attendee) => [attendee.email.toLowerCase(), attendee]),
  );
  return draft.guests.flatMap((guest) => {
    if (guest.email === null) return [];
    const previous = existing.get(guest.email.toLowerCase());
    return [
      {
        email: guest.email,
        actorId: guest.actorId,
        displayName: guest.displayName === guest.email ? null : guest.displayName,
        ...(previous === undefined ? {} : { responseStatus: previous.responseStatus }),
      },
    ];
  });
}

function draftRecurrenceRule(draft: EventDraft): string | null {
  if (draft.recurrence === null) return draft.preservedRule;
  return buildRRule(draft.recurrence, {
    startDate: draft.startDate,
    allDay: draft.allDay,
    timeZone: draft.allDay || draft.timedSemantics === "floating" ? null : draft.timeZone,
  });
}

export function draftRecurrenceText(draft: EventDraft): string | null {
  if (draft.recurrence !== null) return describeRecurrence(draft.recurrence, draft.startDate);
  return draft.preservedRule === null ? null : "Repeats on a custom schedule";
}

/** API instants for the draft. Throws when a time does not exist (a DST gap). */
export function draftInstants(draft: EventDraft): {
  readonly startsAt: string;
  readonly endsAt: string;
} {
  const bounds = draftLocalBounds(draft);
  const resolve = (local: string) =>
    draft.allDay || draft.timedSemantics === "floating"
      ? localDateTimeToFloatingInstant(local)
      : localDateTimeToInstant(local, draft.timeZone);
  return {
    startsAt: resolve(bounds.start).toISOString(),
    endsAt: resolve(bounds.end).toISOString(),
  };
}

/** The create/update payload for a draft, with an optional new conference. */
export function draftToEventInput(
  draft: EventDraft,
  conference: EventConference | null = draft.conference,
): CalendarCreateEventInput {
  const { startsAt, endsAt } = draftInstants(draft);
  let metadata = metadataWithReminder(draft.metadata, draft.reminder);
  metadata = metadataWithConference(metadata, conference);
  metadata = { ...metadata, transparency: draft.busy ? "opaque" : "transparent" };
  return {
    calendarId: draft.calendarId,
    title: draft.title.trim() || "(No title)",
    description: draft.description.trim() === "" ? null : draft.description,
    location: draft.location.trim() === "" ? null : draft.location.trim(),
    startsAt,
    endsAt,
    timezone: draft.timeZone,
    allDay: draft.allDay,
    timeSemantics: draft.allDay ? "all_day" : draft.timedSemantics,
    recurrenceRule: draftRecurrenceRule(draft),
    attendees: attendeeInputs(draft),
    metadata,
  };
}
