/* Calendars, events for the visible window, per-calendar visibility, and the
   occurrences the views draw. */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { viewRange, type CalendarView } from "./date-math";
import {
  calendarSourceFromApi,
  eventQueryWindowForTimeZone,
  occurrencesInWindow,
  type CalendarSource,
  type ViewerIdentity,
} from "./event-model";
import type { CalendarPreferences } from "./preferences";
import { calendarCalendarsQueryOptions, calendarEventsQueryOptions } from "./queries";

const VISIBILITY_KEY = "helix.calendar.visibility";

function readVisibility(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(VISIBILITY_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeVisibility(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(VISIBILITY_KEY, JSON.stringify(value));
  } catch {
    // Without storage the choice lasts for this visit only.
  }
}

export function useCalendarData({
  view,
  anchor,
  preferences,
  viewer,
  query,
  hiddenEventIds,
}: {
  readonly view: CalendarView;
  readonly anchor: string;
  readonly preferences: CalendarPreferences;
  readonly viewer: ViewerIdentity;
  readonly query: string;
  /** Events removed in this session but still undoable. */
  readonly hiddenEventIds: ReadonlySet<string>;
}) {
  const range = useMemo(() => viewRange(view, anchor, preferences), [view, anchor, preferences]);
  const listInput = useMemo(
    () =>
      eventQueryWindowForTimeZone(
        {
          startsAt: `${range.start}T00:00:00.000Z`,
          endsAt: `${range.end}T23:59:59.999Z`,
          limit: 250,
        },
        preferences.timeZone,
      ),
    [range.start, range.end, preferences.timeZone],
  );
  const eventsQuery = useQuery(calendarEventsQueryOptions(listInput));
  const calendarsQuery = useQuery(calendarCalendarsQueryOptions());

  const calendars = useMemo<CalendarSource[]>(
    () => (calendarsQuery.data ?? []).map(calendarSourceFromApi),
    [calendarsQuery.data],
  );
  const calendarsById = useMemo(
    () => new Map(calendars.map((calendar) => [calendar.id, calendar])),
    [calendars],
  );

  const [visibility, setVisibility] = useState(readVisibility);
  const hiddenCalendars = useMemo(
    () =>
      new Set(
        calendars
          .filter((calendar) => !(visibility[calendar.id] ?? calendar.visible))
          .map((calendar) => calendar.id),
      ),
    [calendars, visibility],
  );
  const updateVisibility = useCallback((next: Record<string, boolean>) => {
    setVisibility(next);
    writeVisibility(next);
  }, []);
  const toggleCalendar = useCallback(
    (id: string) => updateVisibility({ ...visibility, [id]: hiddenCalendars.has(id) }),
    [hiddenCalendars, updateVisibility, visibility],
  );
  const showOnlyCalendar = useCalendarOnly(calendars, updateVisibility);

  const needle = query.trim().toLowerCase();
  const occurrences = useMemo(() => {
    const events = (eventsQuery.data ?? []).filter(
      (event) => !hiddenCalendars.has(event.calendarId) && !hiddenEventIds.has(event.id),
    );
    const all = occurrencesInWindow(events, {
      calendars: calendarsById,
      timeZone: preferences.timeZone,
      from: range.start,
      to: range.end,
      viewer,
    });
    if (needle === "") return all;
    return all.filter(({ event }) =>
      [
        event.title,
        event.location ?? "",
        event.description ?? "",
        ...event.attendees.map((a) => `${a.displayName ?? ""} ${a.email}`),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [
    eventsQuery.data,
    hiddenCalendars,
    hiddenEventIds,
    calendarsById,
    preferences.timeZone,
    range,
    viewer,
    needle,
  ]);

  return {
    range,
    eventsQuery,
    calendarsQuery,
    calendars,
    calendarsById,
    hiddenCalendars,
    toggleCalendar,
    showOnlyCalendar,
    occurrences,
  };
}

function useCalendarOnly(
  calendars: readonly CalendarSource[],
  update: (next: Record<string, boolean>) => void,
) {
  return useCallback(
    (id: string) =>
      update(Object.fromEntries(calendars.map((calendar) => [calendar.id, calendar.id === id]))),
    [calendars, update],
  );
}
