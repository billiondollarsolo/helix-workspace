import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument, SearchEventIndexer, SearchIndexer, SearchIndexerEvent } from "../../search/index.js";
import type {
  CalendarActivityPayload,
  CalendarSearchAttendee,
  CalendarSearchProjectionStore,
  CalendarSearchRecord,
} from "../types.js";

export const calendarSearchIndexerId = "calendar";
export const calendarSearchSubjects = ["activity.calendar.>", "com.helix.core.calendar.>"] as const;

export function createCalendarSearchIndexer(
  store: CalendarSearchProjectionStore,
): SearchIndexer<CalendarActivityPayload> {
  return {
    id: calendarSearchIndexerId,
    subjects: calendarSearchSubjects,
    async route(event) {
      const eventId = calendarEventIdFromEvent(event);
      if (eventId === undefined) {
        return undefined;
      }

      if (isDeleteSubject(event.subject)) {
        return { delete: [calendarDocumentId(eventId)] };
      }

      const record = await store.getCalendarSearchRecord(eventId);
      if (record === null || record.deletedAt !== undefined || record.status === "cancelled") {
        return { delete: [calendarDocumentId(eventId)] };
      }

      return { upsert: [calendarRecordToIndexDocument(record)] };
    },
  };
}

export function registerCalendarIndexer(indexer: SearchEventIndexer, store: CalendarSearchProjectionStore): void {
  indexer.register(createCalendarSearchIndexer(store));
}

export function calendarRecordToIndexDocument(record: CalendarSearchRecord): IndexDocument {
  const attendees = record.attendees ?? [];
  const attendeeText = attendees.map(attendeeSearchText).join(", ");
  const organizer = record.organizer === undefined
    ? undefined
    : [record.organizer.displayName, record.organizer.email, record.organizer.id].filter(Boolean).join(" ");
  const body = [
    record.title,
    record.description,
    record.location,
    organizer,
    attendeeText,
    record.startsAt,
    record.endsAt,
  ]
    .map((part) => part instanceof Date ? part.toISOString() : part)
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");

  return {
    id: calendarDocumentId(record.id),
    type: "calendar",
    title: record.title,
    body,
    url: `/calendar/events/${record.id}`,
    attributes: compactJsonObject({
      orgId: record.orgId,
      calendarId: record.calendarId,
      eventId: record.id,
      startsAt: timestampString(record.startsAt),
      endsAt: timestampString(record.endsAt),
      location: record.location ?? undefined,
      organizerId: record.organizer?.id,
      organizerEmail: record.organizer?.email,
      attendeeActorIds: attendees.map((attendee) => attendee.actorId).filter((actorId) => actorId !== undefined),
      attendeeEmails: attendees.map((attendee) => attendee.email),
      status: record.status,
      visibility: record.visibility,
      classification: record.classification,
      icsUid: record.icsUid,
      metadata: record.metadata,
    }),
    updatedAt: timestampString(record.updatedAt ?? record.startsAt) ?? "",
  };
}

export function calendarDocumentId(eventId: string): string {
  return `calendar:${eventId}`;
}

function calendarEventIdFromEvent(event: SearchIndexerEvent<CalendarActivityPayload>): string | undefined {
  const id = event.payload.eventId ?? event.payload.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isDeleteSubject(subject: string): boolean {
  return subject.endsWith(".deleted") || subject.endsWith(".delete") || subject.endsWith(".cancelled");
}

function attendeeSearchText(attendee: CalendarSearchAttendee): string {
  return [attendee.displayName, attendee.email, attendee.actorId].filter(Boolean).join(" ");
}

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  const output: Record<string, JsonObject[keyof JsonObject]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value as JsonObject[keyof JsonObject];
    }
  }
  return output;
}

function timestampString(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}
