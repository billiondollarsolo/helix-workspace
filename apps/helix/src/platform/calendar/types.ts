import type { AIClassification, JsonObject } from "@helix/sdk-types";

export const calendarPluginId = "com.helix.core.calendar";

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";
export type CalendarAttendeeRole = "required" | "optional" | "resource";
export type CalendarResponseStatus = "needs_action" | "accepted" | "declined" | "tentative";
export type CalendarVisibility = "default" | "public" | "private" | "confidential";

export interface CalendarRecord {
  readonly id: string;
  readonly orgId: string;
  readonly ownerActorId: string;
  readonly name: string;
  readonly color: string | null;
  readonly timezone: string;
  readonly description: string | null;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CalendarAttendeeRecord {
  readonly id?: string | undefined;
  readonly orgId?: string | undefined;
  readonly eventId?: string | undefined;
  readonly actorId: string | null;
  readonly email: string;
  readonly displayName?: string | null | undefined;
  readonly role?: CalendarAttendeeRole | undefined;
  readonly responseStatus: CalendarResponseStatus;
  readonly isOrganizer?: boolean | undefined;
  readonly rsvpToken?: string | undefined;
  readonly respondedAt?: Date | null | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly createdAt?: Date | undefined;
  readonly updatedAt?: Date | undefined;
}

export interface CalendarEventRecord {
  readonly id: string;
  readonly orgId: string;
  readonly calendarId: string;
  readonly threadId?: string | null | undefined;
  readonly uid?: string | undefined;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly location?: string | null | undefined;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timezone?: string | undefined;
  readonly allDay: boolean;
  readonly status: CalendarEventStatus;
  readonly recurrenceRule?: string | null | undefined;
  readonly organizerActorId?: string | null | undefined;
  readonly organizerEmail?: string | null | undefined;
  readonly organizer?: CalendarActor | undefined;
  readonly icsSequence: number;
  readonly sequence?: number | undefined;
  readonly visibility?: CalendarVisibility | undefined;
  readonly icsUid?: string | undefined;
  readonly classification?: AIClassification | undefined;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly attendees: readonly CalendarAttendeeRecord[];
}

export interface CalendarBusyInterval {
  readonly eventId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly actorId: string | null;
  readonly email: string | null;
  readonly title?: string | undefined;
}

export interface CalendarFindTimeSlot {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly busy: readonly CalendarBusyInterval[];
}

export interface CalendarFreeBusyEvent {
  readonly eventId: string;
  readonly actorId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status?: CalendarEventStatus | undefined;
  readonly transparency?: "opaque" | "transparent" | undefined;
  readonly recurrenceRule?: string | null | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface CalendarBusyBlock {
  readonly actorId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly eventIds: readonly string[];
}

export interface CalendarAvailabilitySlot {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly availableActorIds: readonly string[];
  readonly busyActorIds: readonly string[];
}

export interface CalendarFreeBusyRequest {
  readonly orgId: string;
  readonly actorIds: readonly string[];
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface CalendarWorkingHours {
  readonly timezone?: string | undefined;
  readonly daysOfWeek?: readonly number[] | undefined;
  readonly startsAtHour: number;
  readonly endsAtHour: number;
}

export interface CalendarFindTimeRequest extends CalendarFreeBusyRequest {
  readonly durationMinutes: number;
  readonly incrementMinutes?: number | undefined;
  readonly limit?: number | undefined;
  readonly workingHours?: CalendarWorkingHours | undefined;
}

export interface CalendarFindTimeResult {
  readonly busy: readonly CalendarBusyBlock[];
  readonly slots: readonly CalendarAvailabilitySlot[];
}

export interface CalendarFreeBusyStore {
  listCalendarFreeBusyEvents(
    request: CalendarFreeBusyRequest,
  ): Promise<readonly CalendarFreeBusyEvent[]>;
}

export interface CalendarActor {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
}

export interface CalendarSearchAttendee {
  readonly actorId?: string | undefined;
  readonly email: string;
  readonly displayName?: string | undefined;
  readonly responseStatus?: CalendarResponseStatus | undefined;
}

export interface CalendarSearchRecord {
  readonly id: string;
  readonly orgId: string;
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly location?: string | null | undefined;
  readonly startsAt: string | Date;
  readonly endsAt: string | Date;
  readonly status: CalendarEventStatus;
  readonly visibility?: CalendarVisibility | undefined;
  readonly classification?: AIClassification | undefined;
  readonly organizer?: CalendarActor | undefined;
  readonly attendees?: readonly CalendarSearchAttendee[] | undefined;
  readonly icsUid?: string | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly deletedAt?: string | Date | null | undefined;
  readonly updatedAt?: string | Date | undefined;
}

export interface CalendarActivityPayload extends JsonObject {
  readonly id?: string;
  readonly eventId?: string;
}

export interface CalendarSearchProjectionStore {
  getCalendarSearchRecord(eventId: string): Promise<CalendarSearchRecord | null>;
}
