import {
  optionalEnumSearchParam,
  optionalIsoDateSearchParam,
  optionalStringSearchParam,
} from "@/lib/search-params";
import type { CalendarListEventsInput } from "./api";

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

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const defaultCalendarRouteState: CalendarRouteState = {
  eventId: "",
  date: todayIso(),
  view: "week",
  query: "",
};

export function validateCalendarRouteSearch(search: Record<string, unknown>): CalendarRouteSearch {
  return {
    event: optionalStringSearchParam(search.event),
    date: optionalIsoDateSearchParam(search.date),
    view: optionalEnumSearchParam(search.view, calendarRouteViews),
    q: optionalStringSearchParam(search.q) ?? optionalStringSearchParam(search.query),
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

function dateFromIsoDate(value: string): Date {
  const [year = "0", month = "1", day = "1"] = value.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
