import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type CalendarApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CalendarApiResponseStatus = "needs_action" | "accepted" | "declined" | "tentative";
export type CalendarApiAttendeeRole = "required" | "optional" | "resource";
export type CalendarApiEventStatus = "confirmed" | "tentative" | "cancelled";

export interface CalendarApiAttendeeInput {
  readonly actorId?: string | null;
  readonly email: string;
  readonly displayName?: string | null;
  readonly role?: CalendarApiAttendeeRole;
  readonly responseStatus?: CalendarApiResponseStatus;
  readonly metadata?: Record<string, unknown>;
}

export interface CalendarApiAttendee {
  readonly id?: string | null;
  readonly actorId?: string | null;
  readonly email: string;
  readonly displayName?: string | null;
  readonly role?: CalendarApiAttendeeRole;
  readonly responseStatus: CalendarApiResponseStatus;
  readonly isOrganizer?: boolean;
  readonly rsvpToken?: string;
  readonly respondedAt?: string | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
}

export interface CalendarApiEvent {
  readonly id: string;
  readonly orgId?: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone?: string;
  readonly allDay: boolean;
  readonly status: CalendarApiEventStatus;
  readonly recurrenceRule?: string | null;
  readonly icsSequence?: number;
  readonly metadata?: Record<string, unknown>;
  readonly deletedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly attendees: readonly CalendarApiAttendee[];
}

export interface CalendarCreateEventInput {
  readonly calendarId?: string | null;
  readonly title: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone?: string;
  readonly allDay?: boolean;
  readonly recurrenceRule?: string | null;
  readonly attendees?: readonly CalendarApiAttendeeInput[];
  readonly metadata?: Record<string, unknown>;
  readonly sendInvitations?: boolean;
}

export type CalendarUpdateEventPatch = Partial<Omit<CalendarCreateEventInput, "sendInvitations">>;

export interface CalendarUpdateEventInput {
  readonly eventId: string;
  readonly patch: CalendarUpdateEventPatch;
  readonly sendInvitations?: boolean;
}

export interface CalendarDeleteEventInput {
  readonly eventId: string;
  readonly sendCancellation?: boolean;
}

export interface CalendarDeleteEventOutput {
  readonly deleted: boolean;
  readonly eventId: string;
  readonly cancellationsQueued?: number;
}

export interface CalendarRespondInput {
  readonly eventId?: string;
  readonly attendeeEmail?: string;
  readonly rsvpToken?: string;
  readonly responseStatus: Exclude<CalendarApiResponseStatus, "needs_action">;
}

export interface CalendarFindTimeInput {
  readonly attendeeActorIds?: readonly string[];
  readonly attendeeEmails?: readonly string[];
  readonly windowStartsAt: string;
  readonly windowEndsAt: string;
  readonly durationMinutes: number;
  readonly stepMinutes?: number;
  readonly limit?: number;
}

export interface CalendarListEventsInput {
  readonly calendarId?: string | null;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly limit?: number;
}

export interface CalendarFindTimeSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly busy: readonly {
    readonly eventId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly actorId: string | null;
    readonly email: string | null;
    readonly title?: string;
  }[];
}

export type CalendarApiMembershipRole = "owner" | "editor" | "viewer";

/** A calendar as returned by `calendar.calendars.list` for the sidebar. */
export interface CalendarApiCalendar {
  readonly id: string;
  readonly orgId?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly timezone?: string;
  readonly color: string;
  readonly ownerActorId?: string;
  readonly ownerDisplayName?: string | null;
  readonly role: CalendarApiMembershipRole;
  readonly visible: boolean;
  readonly group: "mine" | "team";
  readonly writable?: boolean;
  readonly sortOrder?: number;
  readonly eventCount?: number;
}

export interface CalendarListCalendarsOutput {
  readonly calendars: readonly CalendarApiCalendar[];
  readonly mine: readonly CalendarApiCalendar[];
  readonly team: readonly CalendarApiCalendar[];
}

export async function createCalendarEvent(
  input: CalendarCreateEventInput,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<CalendarApiEvent> {
  return callCalendarTool<CalendarApiEvent>(
    "calendar.event.create",
    {
      calendarId: input.calendarId ?? null,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timezone: input.timezone ?? "UTC",
      allDay: input.allDay ?? false,
      recurrenceRule: input.recurrenceRule ?? null,
      attendees: input.attendees ?? [],
      metadata: input.metadata ?? {},
      sendInvitations: input.sendInvitations ?? true,
    },
    fetchImpl,
  );
}

export async function updateCalendarEvent(
  input: CalendarUpdateEventInput,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<CalendarApiEvent> {
  return callCalendarTool<CalendarApiEvent>(
    "calendar.event.update",
    {
      eventId: input.eventId,
      patch: input.patch,
      sendInvitations: input.sendInvitations ?? true,
    },
    fetchImpl,
  );
}

export async function deleteCalendarEvent(
  input: CalendarDeleteEventInput,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<CalendarDeleteEventOutput> {
  return callCalendarTool<CalendarDeleteEventOutput>(
    "calendar.event.delete",
    {
      eventId: input.eventId,
      sendCancellation: input.sendCancellation ?? true,
    },
    fetchImpl,
  );
}

export async function respondToCalendarEvent(
  input: CalendarRespondInput,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<CalendarApiEvent> {
  return callCalendarTool<CalendarApiEvent>(
    "calendar.event.respond",
    {
      eventId: input.eventId,
      attendeeEmail: input.attendeeEmail,
      rsvpToken: input.rsvpToken,
      responseStatus: input.responseStatus,
    },
    fetchImpl,
  );
}

export async function findCalendarTime(
  input: CalendarFindTimeInput,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<readonly CalendarFindTimeSlot[]> {
  const output = await callCalendarTool<{ readonly slots?: readonly CalendarFindTimeSlot[] }>(
    "calendar.find-time",
    {
      attendeeActorIds: input.attendeeActorIds ?? [],
      attendeeEmails: input.attendeeEmails ?? [],
      windowStartsAt: input.windowStartsAt,
      windowEndsAt: input.windowEndsAt,
      durationMinutes: input.durationMinutes,
      stepMinutes: input.stepMinutes ?? 15,
      limit: input.limit ?? 10,
    },
    fetchImpl,
  );

  return output.slots ?? [];
}

export async function listCalendarEvents(
  input: CalendarListEventsInput = {},
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<readonly CalendarApiEvent[]> {
  const output = await callCalendarTool<{ readonly events?: readonly CalendarApiEvent[] }>(
    "calendar.event.list",
    {
      calendarId: input.calendarId ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      limit: input.limit ?? 100,
    },
    fetchImpl,
  );

  return output.events ?? [];
}

export async function listCalendars(
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<readonly CalendarApiCalendar[]> {
  const output = await callCalendarTool<{ readonly calendars?: readonly CalendarApiCalendar[] }>(
    "calendar.calendars.list",
    {},
    fetchImpl,
  );

  return output.calendars ?? [];
}

async function callCalendarTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: CalendarApiFetch,
): Promise<Output> {
  // Auto-approves pending_confirmation (e.g. calendar.event.delete) via the
  // shared callTool helper.
  return callTool<Output>(toolId, input, { fetchImpl });
}
