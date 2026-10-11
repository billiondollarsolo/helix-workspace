import {
  optionalEnumSearchParam,
  optionalIsoDateSearchParam,
  optionalStringSearchParam,
} from "@/lib/search-params";
import type { CalendarView } from "./date-math";

const calendarViews = [
  "day",
  "3day",
  "week",
  "month",
  "schedule",
] as const satisfies readonly CalendarView[];

export interface CalendarRouteSearch {
  readonly event?: string;
  readonly date?: string;
  readonly view?: CalendarView;
  readonly q?: string;
}

export interface CalendarRouteState {
  readonly eventId: string;
  /** Anchor date of the visible period. */
  readonly date: string;
  readonly view: CalendarView;
  readonly query: string;
}

/* Route validation runs in the initial bundle, so this stays free of the
   calendar and contracts modules: "en-CA" formats dates as yyyy-mm-dd. */
function browserToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export const defaultCalendarRouteState: CalendarRouteState = {
  eventId: "",
  date: browserToday(),
  view: "week",
  query: "",
};

export function validateCalendarRouteSearch(search: Record<string, unknown>): CalendarRouteSearch {
  return {
    event: optionalStringSearchParam(search.event),
    date: optionalIsoDateSearchParam(search.date),
    view: optionalEnumSearchParam(search.view, calendarViews),
    q: optionalStringSearchParam(search.q),
  };
}

export function calendarRouteStateFromSearch(search: CalendarRouteSearch): CalendarRouteState {
  return {
    eventId: search.event ?? defaultCalendarRouteState.eventId,
    date: search.date ?? browserToday(),
    view: search.view ?? defaultCalendarRouteState.view,
    query: search.q ?? defaultCalendarRouteState.query,
  };
}

export function calendarRouteSearchFromState(state: CalendarRouteState): CalendarRouteSearch {
  return {
    event: state.eventId || undefined,
    date: state.date === browserToday() ? undefined : state.date,
    view: state.view === defaultCalendarRouteState.view ? undefined : state.view,
    q: state.query.trim() || undefined,
  };
}
