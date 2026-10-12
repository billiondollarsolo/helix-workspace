import type { CalendarTimeSemantics } from "@helix/contracts";
import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type CalendarApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CalendarApiResponseStatus = "needs_action" | "accepted" | "declined" | "tentative";
type CalendarApiAttendeeRole = "required" | "optional" | "resource";

export interface CalendarApiAttendeeInput {
  readonly actorId?: string | null;
  readonly email: string;
  readonly displayName?: string | null;
  readonly role?: CalendarApiAttendeeRole;
  readonly responseStatus?: CalendarApiResponseStatus;
  readonly metadata?: Record<string, unknown>;
}
type CalendarApiEventStatus = "confirmed" | "tentative" | "cancelled";

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
  readonly timeSemantics?: CalendarTimeSemantics;
  readonly startsLocal?: string;
  readonly endsLocal?: string;
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
  readonly timeSemantics?: CalendarTimeSemantics;
  readonly recurrenceRule?: string | null;
  readonly attendees?: readonly CalendarApiAttendeeInput[];
  readonly metadata?: Record<string, unknown>;
  readonly sendInvitations?: boolean;
  /** "Add video conferencing": the event's `metadata.conference.joinUrl` links the Meet room. */
  readonly conference?: "meet";
}

type CalendarUpdateEventPatch = Partial<
  Omit<CalendarCreateEventInput, "sendInvitations" | "conference">
>;

export interface CalendarUpdateEventInput {
  readonly eventId: string;
  readonly patch: CalendarUpdateEventPatch;
  readonly sendInvitations?: boolean;
  /** Add video conferencing to an event that has none yet. */
  readonly conference?: "meet";
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
  readonly eventId: string;
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

type CalendarApiMembershipRole = "owner" | "manager" | "writer" | "reader";

/** A busy block for one person, without event details. */
export interface CalendarBusyBlock {
  readonly actorId: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface CalendarFreeBusyInput {
  readonly actorIds: readonly string[];
  readonly windowStartsAt: string;
  readonly windowEndsAt: string;
}

export type CalendarShareRole = "manager" | "writer" | "reader";

export interface CalendarMembership {
  readonly calendarId: string;
  readonly actorId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: CalendarApiMembershipRole;
}

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
  /** The owner's primary calendar; it cannot be deleted. */
  readonly isDefault?: boolean;
  readonly eventCount?: number;
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
      ...(input.timeSemantics === undefined ? {} : { timeSemantics: input.timeSemantics }),
      recurrenceRule: input.recurrenceRule ?? null,
      attendees: input.attendees ?? [],
      metadata: input.metadata ?? {},
      sendInvitations: input.sendInvitations ?? true,
      ...(input.conference === undefined ? {} : { conference: input.conference }),
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
      ...(input.conference === undefined ? {} : { conference: input.conference }),
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

export async function listCalendarFreeBusy(
  input: CalendarFreeBusyInput,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<readonly CalendarBusyBlock[]> {
  const output = await callCalendarTool<{ readonly busy?: readonly CalendarBusyBlock[] }>(
    "calendar.free-busy",
    input,
    fetchImpl,
  );
  return output.busy ?? [];
}

export async function listCalendarMemberships(
  calendarId: string,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<readonly CalendarMembership[]> {
  const output = await callCalendarTool<{ readonly memberships?: readonly CalendarMembership[] }>(
    "calendar.memberships.list",
    { calendarId },
    fetchImpl,
  );
  return output.memberships ?? [];
}

export async function setCalendarMembership(
  input: {
    readonly calendarId: string;
    readonly actorId: string;
    readonly role: CalendarShareRole;
  },
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<CalendarMembership> {
  return callCalendarTool<CalendarMembership>("calendar.memberships.set", input, fetchImpl);
}

export async function removeCalendarMembership(
  input: { readonly calendarId: string; readonly actorId: string },
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<void> {
  await callCalendarTool<unknown>("calendar.memberships.remove", input, fetchImpl);
}

export async function createCalendar(
  input: { readonly name: string; readonly color: string },
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<{ readonly id: string; readonly name: string; readonly color: string }> {
  return callCalendarTool("calendar.calendar.create", input, fetchImpl);
}

export async function updateCalendar(
  input: { readonly calendarId: string; readonly name?: string; readonly color?: string },
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<void> {
  await callCalendarTool<unknown>("calendar.calendar.update", input, fetchImpl);
}

export async function deleteCalendar(
  calendarId: string,
  fetchImpl: CalendarApiFetch = authenticatedFetch,
): Promise<void> {
  await callCalendarTool<unknown>("calendar.calendar.delete", { calendarId }, fetchImpl);
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
