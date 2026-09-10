import {
  instantToLocalDateTime,
  localDateTimeToFloatingInstant,
  localDateTimeToInstant,
} from "@helix/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  respondToCalendarEvent,
  updateCalendarEvent,
  type CalendarApiResponseStatus,
  type CalendarCreateEventInput,
  type CalendarDeleteEventInput,
  type CalendarRespondInput,
  type CalendarUpdateEventInput,
} from "./api";
import { draftInstants, formatWindowLabel, shiftIsoDate } from "./calendar-date-helpers";
import {
  attendeeInputs,
  CalendarEventDialog,
  calendarReminderMetadata,
  calendarReminderMinutes,
  clockToDecimalHour,
  decimalHourToClock,
  type EventDraft,
} from "./calendar-event-dialog";
import { CalendarSidebar } from "./calendar-sidebar";
import { CalendarWeek } from "./calendar-week";
import {
  eventQueryWindowForTimeZone,
  gridEventFromApiEvent,
  sidebarEntryFromApiCalendar,
  todayDayIndex,
  todayIso,
  type CalendarGridEvent,
  type CalendarSidebarEntry,
} from "./data";
import {
  calendarCalendarsQueryOptions,
  calendarEventsInputFromRouteState,
  calendarEventsQueryOptions,
  calendarQueryKeys,
  defaultCalendarRouteState,
  type CalendarRouteState,
} from "./queries";

/** Props let the route own URL search state; all are optional for standalone use. */
export interface CalendarShellProps {
  readonly routeState?: CalendarRouteState;
  readonly onRouteStateChange?: (state: CalendarRouteState) => void;
}

export function CalendarShell({ routeState, onRouteStateChange }: CalendarShellProps = {}) {
  const queryClient = useQueryClient();
  const viewerTimeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const [localState, setLocalState] = useState<CalendarRouteState>(
    routeState ?? defaultCalendarRouteState,
  );
  const state = routeState ?? localState;

  const updateState = (patch: Partial<CalendarRouteState>) => {
    const next: CalendarRouteState = { ...state, ...patch };
    setLocalState(next);
    onRouteStateChange?.(next);
  };

  /** Jump the visible window to today. */
  const goToday = () => {
    updateState({ date: todayIso() });
  };

  /** Shift the visible window by one view-sized step (day/week/month). */
  const shiftWindow = (direction: -1 | 1) => {
    updateState({ date: shiftIsoDate(state.date, state.view, direction) });
  };

  const displayWindowInput = useMemo(
    () => calendarEventsInputFromRouteState({ date: state.date, view: state.view }),
    [state.date, state.view],
  );
  const eventsInput = useMemo(
    () => eventQueryWindowForTimeZone(displayWindowInput, viewerTimeZone),
    [displayWindowInput, viewerTimeZone],
  );
  /** Human label for the visible window header, e.g. "May 18 – 24, 2026". */
  const windowLabel = useMemo(
    () => formatWindowLabel(displayWindowInput.startsAt, displayWindowInput.endsAt),
    [displayWindowInput.startsAt, displayWindowInput.endsAt],
  );
  const eventsQuery = useQuery(calendarEventsQueryOptions(eventsInput));
  const calendarsQuery = useQuery(calendarCalendarsQueryOptions());

  /** Sidebar calendars from the backend, mapped to the checklist shape. */
  const calendars = useMemo<readonly CalendarSidebarEntry[]>(
    () => (calendarsQuery.data ?? []).map(sidebarEntryFromApiCalendar),
    [calendarsQuery.data],
  );

  /** Per-calendar visible toggles — seeded from the backend `visible` flag. */
  const [visibility, setVisibility] = useState<Readonly<Record<string, boolean>>>({});
  useEffect(() => {
    if (calendars.length === 0) {
      return;
    }
    setVisibility((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const calendar of calendars) {
        next[calendar.id] = current[calendar.id] ?? calendar.visible;
        if (current[calendar.id] === undefined) {
          changed = true;
        }
      }
      return changed || Object.keys(current).length !== calendars.length ? next : current;
    });
  }, [calendars]);

  const toggleCalendar = (id: string) => {
    setVisibility((current) => ({ ...current, [id]: !(current[id] ?? true) }));
  };

  /** Calendar id -> colour, for tinting backend events to match their source. */
  const calendarColors = useMemo<ReadonlyMap<string, string>>(
    () => new Map(calendars.map((calendar) => [calendar.id, calendar.color])),
    [calendars],
  );

  /** Backend events normalized for the selected view and filtered by calendar. */
  const backendEvents = useMemo<readonly CalendarGridEvent[]>(() => {
    const data = eventsQuery.data;
    if (data === undefined) {
      return [];
    }
    return data.map((event) => gridEventFromApiEvent(event, calendarColors, viewerTimeZone));
  }, [eventsQuery.data, calendarColors, viewerTimeZone]);

  /** True when the backend events request failed — drives the error banner. */
  const eventsFailed = eventsQuery.isError;

  /** Events the grid renders: backend data only. */
  const sourceEvents = backendEvents;

  /** Hide events that belong to a calendar toggled off in the sidebar. */
  const visibleEvents = useMemo<readonly CalendarGridEvent[]>(() => {
    if (calendars.length === 0) {
      return sourceEvents;
    }
    return sourceEvents.filter(
      (event) => event.calendarId === undefined || (visibility[event.calendarId] ?? true),
    );
  }, [sourceEvents, calendars.length, visibility]);

  const query = state.query.trim().toLowerCase();
  const events = useMemo<readonly CalendarGridEvent[]>(() => {
    if (query.length === 0) {
      return visibleEvents;
    }
    return visibleEvents.filter((event) =>
      `${event.title} ${event.location ?? ""} ${event.attendees.join(" ")}`
        .toLowerCase()
        .includes(query),
    );
  }, [visibleEvents, query]);

  const selectedEvent =
    state.eventId.length > 0 ? (events.find((event) => event.id === state.eventId) ?? null) : null;

  /* ----------------------------------------------------------- mutations */

  const [actionError, setActionError] = useState<string | null>(null);
  const clearError = useCallback(() => {
    setActionError(null);
  }, []);

  /** Invalidate every events window plus the calendars list after a write. */
  const invalidateCalendarData = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: calendarQueryKeys.eventsRoot });
    void queryClient.invalidateQueries({ queryKey: calendarQueryKeys.calendars });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (input: CalendarCreateEventInput) => createCalendarEvent(input),
    onMutate: clearError,
    onError: (error: unknown) => {
      setActionError(error instanceof Error ? error.message : "Could not create the event.");
    },
    onSuccess: invalidateCalendarData,
  });

  const updateMutation = useMutation({
    mutationFn: (input: CalendarUpdateEventInput) => updateCalendarEvent(input),
    onMutate: clearError,
    onError: (error: unknown) => {
      setActionError(error instanceof Error ? error.message : "Could not update the event.");
    },
    onSuccess: invalidateCalendarData,
  });

  const deleteMutation = useMutation({
    mutationFn: (input: CalendarDeleteEventInput) => deleteCalendarEvent(input),
    onMutate: clearError,
    onError: () => {
      setActionError("Could not delete the event. Try again.");
    },
    onSuccess: () => {
      invalidateCalendarData();
      updateState({ eventId: "" });
    },
  });

  const respondMutation = useMutation({
    mutationFn: (input: CalendarRespondInput) => respondToCalendarEvent(input),
    onMutate: clearError,
    onError: () => {
      setActionError("Could not send your RSVP. Try again.");
    },
    onSuccess: invalidateCalendarData,
  });

  /** First writable calendar id -- the default target for new events. */
  const defaultCalendarId = useMemo<string | null>(
    () => calendars.find((calendar) => calendar.writable)?.id ?? null,
    [calendars],
  );

  /* ------------------------------------------------------------ dialog */

  const [draft, setDraft] = useState<EventDraft | null>(null);
  /** Monday of the visible window — anchors drag-create/move ISO dates. */
  const weekStartIso = (displayWindowInput.startsAt ?? "2026-05-18").slice(0, 10);

  /** ISO date for a Monday-relative day index in the visible window. */
  const isoDateForWeekDay = useCallback(
    (dayIndex: number): string => {
      if (state.view === "day") return state.date;
      const base = new Date(`${weekStartIso}T00:00:00.000Z`);
      base.setUTCDate(base.getUTCDate() + dayIndex);
      return base.toISOString().slice(0, 10);
    },
    [state.date, state.view, weekStartIso],
  );

  const openCreateDialog = (seed?: { date: string; start: number; end: number }) => {
    clearError();
    const timezone =
      calendars.find((calendar) => calendar.id === defaultCalendarId)?.timezone ?? viewerTimeZone;
    setDraft({
      mode: "create",
      calendarId: defaultCalendarId,
      title: "",
      description: "",
      location: "",
      attendeeEmails: "",
      recurrenceRule: "",
      reminderMinutes: "",
      metadata: {},
      date: seed?.date ?? isoDateForWeekDay(todayDayIndex()),
      start: seed?.start ?? 9,
      end: seed?.end ?? 10,
      timezone,
      allDay: false,
      timeSemantics: "zoned",
    });
  };

  const openEditDialog = (event: CalendarGridEvent) => {
    clearError();
    const apiEvent = event.apiEvent;
    const timeSemantics = apiEvent?.allDay ? "all_day" : (apiEvent?.timeSemantics ?? "zoned");
    const timezone = apiEvent?.timezone ?? viewerTimeZone;
    const intentZone = timeSemantics === "zoned" ? timezone : "UTC";
    const startsLocal =
      apiEvent?.startsLocal ??
      (apiEvent === undefined
        ? `${event.date}T${decimalHourToClock(event.start)}:00`
        : instantToLocalDateTime(apiEvent.startsAt, intentZone));
    const endsLocal =
      apiEvent?.endsLocal ??
      (apiEvent === undefined
        ? `${event.date}T${decimalHourToClock(event.end)}:00`
        : instantToLocalDateTime(apiEvent.endsAt, intentZone));
    setDraft({
      mode: "edit",
      eventId: event.id,
      calendarId: event.calendarId ?? defaultCalendarId,
      title: event.title,
      description: event.apiEvent?.description ?? "",
      location: event.location ?? "",
      attendeeEmails:
        event.apiEvent?.attendees
          .filter((attendee) => attendee.isOrganizer !== true)
          .map((attendee) => attendee.email)
          .join(", ") ?? "",
      recurrenceRule: event.apiEvent?.recurrenceRule ?? "",
      reminderMinutes: calendarReminderMinutes(event.apiEvent?.metadata),
      metadata: event.apiEvent?.metadata ?? {},
      date: startsLocal.slice(0, 10),
      start: clockToDecimalHour(startsLocal.slice(11, 16), event.start),
      end: clockToDecimalHour(endsLocal.slice(11, 16), event.end),
      timezone,
      allDay: apiEvent?.allDay ?? false,
      timeSemantics,
    });
  };

  const submitDraft = (value: EventDraft) => {
    let startsAt: string;
    let endsAt: string;
    try {
      const instants = draftInstants(value);
      startsAt = instants.startsAt;
      endsAt = instants.endsAt;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That local time is invalid.");
      return;
    }
    if (value.mode === "create") {
      const attendees = attendeeInputs(value.attendeeEmails);
      createMutation.mutate({
        calendarId: value.calendarId,
        title: value.title,
        description: value.description.trim() === "" ? null : value.description,
        location: value.location.trim() === "" ? null : value.location,
        startsAt,
        endsAt,
        timezone: value.timezone,
        allDay: value.allDay,
        timeSemantics: value.timeSemantics,
        recurrenceRule: value.recurrenceRule.trim() || null,
        attendees,
        metadata: calendarReminderMetadata(value.reminderMinutes, value.metadata),
      });
    } else if (value.eventId !== undefined) {
      const attendees = attendeeInputs(value.attendeeEmails);
      updateMutation.mutate({
        eventId: value.eventId,
        patch: {
          title: value.title,
          description: value.description.trim() === "" ? null : value.description,
          location: value.location.trim() === "" ? null : value.location,
          startsAt,
          endsAt,
          timezone: value.timezone,
          allDay: value.allDay,
          timeSemantics: value.timeSemantics,
          recurrenceRule: value.recurrenceRule.trim() || null,
          attendees,
          metadata: calendarReminderMetadata(value.reminderMinutes, value.metadata),
        },
      });
    }
    setDraft(null);
  };

  /** Drag-move a backend event to a new day/start, preserving its duration. */
  const moveEvent = (event: CalendarGridEvent, nextDay: number, nextStart: number) => {
    if (event.apiEvent === undefined) {
      setActionError("This event can't be moved.");
      return;
    }
    const duration = event.end - event.start;
    const date = isoDateForWeekDay(nextDay);
    const semantics = event.apiEvent.timeSemantics ?? "zoned";
    const localStart = `${date}T${decimalHourToClock(nextStart)}:00`;
    const localEnd = `${date}T${decimalHourToClock(nextStart + duration)}:00`;
    let startsAt: string;
    let endsAt: string;
    try {
      if (semantics === "floating") {
        startsAt = localDateTimeToFloatingInstant(localStart).toISOString();
        endsAt = localDateTimeToFloatingInstant(localEnd).toISOString();
      } else {
        startsAt = localDateTimeToInstant(localStart, viewerTimeZone).toISOString();
        endsAt = localDateTimeToInstant(localEnd, viewerTimeZone).toISOString();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That local time is invalid.");
      return;
    }
    updateMutation.mutate({
      eventId: event.id,
      patch: {
        startsAt,
        endsAt,
      },
    });
  };

  /** Drag-create on an empty slot opens the dialog prefilled with that range. */
  const dragCreate = (day: number, start: number, end: number) => {
    openCreateDialog({
      date: isoDateForWeekDay(day),
      start,
      end: Math.max(end, start + 0.5),
    });
  };

  const respond = (eventId: string, status: CalendarApiResponseStatus) => {
    if (status === "needs_action") {
      return;
    }
    respondMutation.mutate({ eventId, responseStatus: status });
  };

  const writableSelected = selectedEvent !== null && selectedEvent.apiEvent !== undefined;

  return (
    <section className="calendar-page flex flex-1 min-w-0 min-h-0 relative">
      <h1 className="sr-only">Calendar</h1>
      <CalendarSidebar
        query={state.query}
        onSearchChange={(value) => updateState({ query: value })}
        calendars={calendars}
        calendarsLoading={calendarsQuery.isLoading}
        calendarsError={calendarsQuery.isError}
        visibility={visibility}
        onToggleCalendar={toggleCalendar}
        onCreate={() => openCreateDialog()}
      />
      <CalendarWeek
        events={events}
        weekStartIso={weekStartIso}
        selectedEvent={selectedEvent}
        onSelectEvent={(eventId) => updateState({ eventId })}
        onCloseEvent={() => updateState({ eventId: "" })}
        view={state.view}
        onChangeView={(view) => updateState({ view })}
        windowLabel={windowLabel}
        onToday={goToday}
        onShiftWindow={shiftWindow}
        loading={eventsQuery.isLoading}
        errored={eventsFailed}
        empty={!eventsQuery.isLoading && !eventsFailed && events.length === 0}
        actionError={actionError}
        onDismissError={clearError}
        onMoveEvent={moveEvent}
        onDragCreate={dragCreate}
        onEditEvent={writableSelected ? openEditDialog : undefined}
        onDeleteEvent={
          writableSelected ? (eventId) => deleteMutation.mutate({ eventId }) : undefined
        }
        onRespond={writableSelected ? respond : undefined}
        respondPending={respondMutation.isPending}
        deletePending={deleteMutation.isPending}
      />
      {draft !== null && (
        <CalendarEventDialog
          draft={draft}
          calendars={calendars}
          pending={createMutation.isPending || updateMutation.isPending}
          onSubmit={submitDraft}
          onClose={() => setDraft(null)}
        />
      )}
    </section>
  );
}
