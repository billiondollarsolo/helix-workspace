import { queryOptions } from "@tanstack/react-query";
import {
  findCalendarTime,
  listCalendarEvents,
  listCalendars,
  type CalendarFindTimeInput,
  type CalendarListEventsInput,
} from "./api";
import {
  calendarEventsInputFromRouteSearch,
  calendarEventsInputFromRouteState,
  calendarRouteSearchFromState,
  calendarRouteStateFromSearch,
  calendarRouteViews,
  defaultCalendarRouteState,
  todayIso,
  validateCalendarRouteSearch,
  type CalendarRouteSearch,
  type CalendarRouteState,
  type CalendarRouteView,
} from "./route-state";

export {
  calendarEventsInputFromRouteSearch,
  calendarEventsInputFromRouteState,
  calendarRouteSearchFromState,
  calendarRouteStateFromSearch,
  calendarRouteViews,
  defaultCalendarRouteState,
  validateCalendarRouteSearch,
};
export type { CalendarRouteSearch, CalendarRouteState, CalendarRouteView };

/** Compute the Monday of the current week (ISO yyyy-mm-dd). */
function currentWeekStartIso(): string {
  const today = new Date();
  const dow = today.getDay(); // Sun=0..Sat=6
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  return monday.toISOString().slice(0, 10);
}

/** Compute the Sunday of the current week (ISO yyyy-mm-dd). */
function currentWeekEndIso(): string {
  const today = new Date();
  const dow = today.getDay();
  const sundayOffset = dow === 0 ? 0 : 7 - dow;
  const sunday = new Date(today);
  sunday.setDate(today.getDate() + sundayOffset);
  return sunday.toISOString().slice(0, 10);
}

export const defaultCalendarFindTimeInput: CalendarFindTimeInput = {
  attendeeEmails: [],
  windowStartsAt: `${todayIso()}T13:00:00.000Z`,
  windowEndsAt: `${currentWeekEndIso()}T22:00:00.000Z`,
  durationMinutes: 30,
  stepMinutes: 30,
  limit: 3,
};

export const defaultCalendarEventsInput: CalendarListEventsInput = {
  startsAt: `${currentWeekStartIso()}T00:00:00.000Z`,
  endsAt: `${currentWeekEndIso()}T23:59:59.999Z`,
  limit: 100,
};

export const calendarQueryKeys = {
  /** Stable prefix for invalidating every events window query at once. */
  eventsRoot: ["calendar", "events"] as const,
  calendars: ["calendar", "calendars"] as const,
  findTime: (input: CalendarFindTimeInput = defaultCalendarFindTimeInput) =>
    [
      "calendar",
      "find-time",
      [...(input.attendeeActorIds ?? [])].sort().join(","),
      [...(input.attendeeEmails ?? [])].sort().join(","),
      input.windowStartsAt,
      input.windowEndsAt,
      input.durationMinutes,
      input.stepMinutes ?? 15,
      input.limit ?? 10,
    ] as const,
  events: (input: CalendarListEventsInput = defaultCalendarEventsInput) =>
    [
      "calendar",
      "events",
      input.calendarId ?? "",
      input.startsAt ?? "",
      input.endsAt ?? "",
      input.limit ?? 100,
    ] as const,
};

export function calendarFindTimeQueryOptions(
  input: CalendarFindTimeInput = defaultCalendarFindTimeInput,
) {
  return queryOptions({
    queryKey: calendarQueryKeys.findTime(input),
    queryFn: () => findCalendarTime(input),
    throwOnError: false,
  });
}

export function calendarEventsQueryOptions(
  input: CalendarListEventsInput = defaultCalendarEventsInput,
) {
  return queryOptions({
    queryKey: calendarQueryKeys.events(input),
    queryFn: () => listCalendarEvents(input),
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
