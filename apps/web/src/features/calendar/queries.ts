import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import {
  findCalendarTime,
  listCalendarEvents,
  listCalendarFreeBusy,
  listCalendarMemberships,
  listCalendars,
  type CalendarFindTimeInput,
  type CalendarFreeBusyInput,
  type CalendarListEventsInput,
} from "./api";

export const calendarQueryKeys = {
  /** Prefix shared by every events window, for invalidation after writes. */
  eventsRoot: ["calendar", "events"] as const,
  events: (input: CalendarListEventsInput) =>
    [
      "calendar",
      "events",
      input.calendarId ?? "",
      input.startsAt ?? "",
      input.endsAt ?? "",
      input.limit ?? 100,
    ] as const,
  calendars: ["calendar", "calendars"] as const,
  memberships: (calendarId: string) => ["calendar", "memberships", calendarId] as const,
  freeBusy: (input: CalendarFreeBusyInput) =>
    [
      "calendar",
      "free-busy",
      [...input.actorIds].sort().join(","),
      input.windowStartsAt,
      input.windowEndsAt,
    ] as const,
  findTime: (input: CalendarFindTimeInput) =>
    [
      "calendar",
      "find-time",
      [...(input.attendeeActorIds ?? [])].sort().join(","),
      [...(input.attendeeEmails ?? [])].sort().join(","),
      input.windowStartsAt,
      input.windowEndsAt,
      input.durationMinutes,
    ] as const,
};

export function calendarEventsQueryOptions(input: CalendarListEventsInput) {
  return queryOptions({
    queryKey: calendarQueryKeys.events(input),
    queryFn: () => listCalendarEvents(input),
    // Keep the current events on screen while the next period loads.
    placeholderData: keepPreviousData,
    throwOnError: false,
  });
}

export function calendarCalendarsQueryOptions() {
  return queryOptions({
    queryKey: calendarQueryKeys.calendars,
    queryFn: () => listCalendars(),
    throwOnError: false,
  });
}

export function calendarMembershipsQueryOptions(calendarId: string) {
  return queryOptions({
    queryKey: calendarQueryKeys.memberships(calendarId),
    queryFn: () => listCalendarMemberships(calendarId),
    throwOnError: false,
  });
}

export function calendarFreeBusyQueryOptions(input: CalendarFreeBusyInput) {
  return queryOptions({
    queryKey: calendarQueryKeys.freeBusy(input),
    queryFn: () => listCalendarFreeBusy(input),
    enabled: input.actorIds.length > 0,
    throwOnError: false,
  });
}

export function calendarFindTimeQueryOptions(input: CalendarFindTimeInput) {
  return queryOptions({
    queryKey: calendarQueryKeys.findTime(input),
    queryFn: () => findCalendarTime(input),
    throwOnError: false,
  });
}
