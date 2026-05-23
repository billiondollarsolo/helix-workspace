import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  findCalendarTime,
  listCalendarEvents,
  listCalendars,
  type CalendarFindTimeInput,
  type CalendarListEventsInput,
} from "./api";

export const calendarRouteViews = ["week", "month", "day"] as const;
export type CalendarRouteView = (typeof calendarRouteViews)[number];

export interface CalendarRouteSearch {
  readonly event?: string;
  readonly date?: string;
  readonly view?: CalendarRouteView;
  readonly q?: string;
}

export interface CalendarRouteState {
  readonly eventId: string;
  readonly date: string;
  readonly view: CalendarRouteView;
  readonly query: string;
}

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

/** Today as an ISO yyyy-mm-dd string. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

export const defaultCalendarRouteState: CalendarRouteState = {
  eventId: "",
  date: todayIso(),
  view: "week",
  query: "",
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

const nonEmptyStringParam = z
  .string()
  .trim()
  .min(1)
  .optional()
  .catch(undefined);

const isoDateRouteParam = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => formatIsoDate(dateFromIsoDate(value)) === value)
  .optional()
  .catch(undefined);

const calendarRouteSearchSchema = z
  .object({
    event: nonEmptyStringParam,
    date: isoDateRouteParam,
    view: z.enum(calendarRouteViews).optional().catch(undefined),
    q: nonEmptyStringParam,
    query: nonEmptyStringParam,
  })
  .catch({});

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

export function validateCalendarRouteSearch(search: Record<string, unknown>): CalendarRouteSearch {
  const parsed = calendarRouteSearchSchema.parse(search);
  return {
    event: parsed.event,
    date: parsed.date,
    view: parsed.view,
    q: parsed.q ?? parsed.query,
  };
}

export function calendarRouteStateFromSearch(search: CalendarRouteSearch): CalendarRouteState {
  return {
    eventId: search.event ?? defaultCalendarRouteState.eventId,
    date: search.date ?? defaultCalendarRouteState.date,
    view: search.view ?? defaultCalendarRouteState.view,
    query: search.q ?? defaultCalendarRouteState.query,
  };
}

export function calendarRouteSearchFromState(state: CalendarRouteState): CalendarRouteSearch {
  return {
    event: state.eventId || undefined,
    date: state.date === defaultCalendarRouteState.date ? undefined : state.date,
    view: state.view === defaultCalendarRouteState.view ? undefined : state.view,
    q: state.query.trim() || undefined,
  };
}

export function calendarEventsInputFromRouteSearch(
  search: CalendarRouteSearch,
): CalendarListEventsInput {
  return calendarEventsInputFromRouteState(calendarRouteStateFromSearch(search));
}

export function calendarEventsInputFromRouteState(
  state: Pick<CalendarRouteState, "date" | "view">,
): CalendarListEventsInput {
  if (state.view === "day") {
    return {
      startsAt: `${state.date}T00:00:00.000Z`,
      endsAt: `${state.date}T23:59:59.999Z`,
      limit: 100,
    };
  }

  if (state.view === "month") {
    const date = dateFromIsoDate(state.date);
    const startsAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const endsAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));

    return {
      startsAt: `${formatIsoDate(startsAt)}T00:00:00.000Z`,
      endsAt: `${formatIsoDate(endsAt)}T23:59:59.999Z`,
      limit: 100,
    };
  }

  const date = dateFromIsoDate(state.date);
  const day = date.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const startsAt = addUtcDays(date, -daysSinceMonday);
  const endsAt = addUtcDays(startsAt, 6);

  return {
    startsAt: `${formatIsoDate(startsAt)}T00:00:00.000Z`,
    endsAt: `${formatIsoDate(endsAt)}T23:59:59.999Z`,
    limit: 100,
  };
}

function dateFromIsoDate(value: string) {
  const [year = "0", month = "1", day = "1"] = value.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
