/* Helix Calendar — week view recreated from the design handoff.
   Left sidebar (Create, mini-month, calendar checklists), week board with an
   hour gutter + 7 day columns, absolute-positioned colour-coded event cards,
   the red "now" line, and a 340px event popover.

   Everything is wired to the calendar backend through TanStack Query:
   - `calendar.event.list` feeds the week grid for the visible window.
   - `calendar.calendars.list` feeds the "My calendars"/"Team" checklists; the
     checklist also drives which events are shown.
   - `calendar.event.create` / `.update` / `.delete` back the Create button,
     drag-to-create, drag-to-move, and the popover's Edit/Delete actions.
   - `calendar.event.respond` backs the popover RSVP buttons.
   The handoff seed data is gone — only real backend rows render. On error
   the grid shows an "events unavailable" banner instead of a fake dataset. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Avatar } from "@/components/ui/avatar";
import { Icons } from "@/components/icons";
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
import {
  GRID_HOURS,
  GRID_HOUR_COUNT,
  GRID_START_HOUR,
  HOUR_HEIGHT,
  nowDecimalHour,
  todayDayIndex,
  todayIso,
  WEEK_DAY_LABELS,
  dateNumberForDay,
  formatCardTime,
  formatHour,
  gridEventFromApiEvent,
  isOnGrid,
  sidebarEntryFromApiCalendar,
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
  type CalendarRouteView,
} from "./queries";

const VIEW_OPTIONS: readonly CalendarRouteView[] = ["day", "week", "month"];

/** Props let the route own URL search state; all are optional for standalone use. */
export interface CalendarShellProps {
  readonly routeState?: CalendarRouteState;
  readonly onRouteStateChange?: (state: CalendarRouteState) => void;
}

/** Draft consumed by the create/edit dialog. */
interface EventDraft {
  readonly mode: "create" | "edit";
  readonly eventId?: string;
  readonly calendarId: string | null;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  /** ISO date `yyyy-mm-dd`. */
  readonly date: string;
  /** Decimal hour. */
  readonly start: number;
  /** Decimal hour. */
  readonly end: number;
}

export function CalendarShell({ routeState, onRouteStateChange }: CalendarShellProps = {}) {
  const queryClient = useQueryClient();
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

  const eventsInput = useMemo(
    () => calendarEventsInputFromRouteState({ date: state.date, view: state.view }),
    [state.date, state.view],
  );
  /** Human label for the visible window header, e.g. "May 18 – 24, 2026". */
  const windowLabel = useMemo(
    () => formatWindowLabel(eventsInput.startsAt, eventsInput.endsAt),
    [eventsInput.startsAt, eventsInput.endsAt],
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

  /** Backend events mapped onto the week grid, filtered to what is visible. */
  const backendEvents = useMemo<readonly CalendarGridEvent[]>(() => {
    const data = eventsQuery.data;
    if (data === undefined) {
      return [];
    }
    return data.map((event) => gridEventFromApiEvent(event, calendarColors)).filter(isOnGrid);
  }, [eventsQuery.data, calendarColors]);

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
      (event) =>
        event.calendarId === undefined || (visibility[event.calendarId] ?? true),
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
    state.eventId.length > 0
      ? (events.find((event) => event.id === state.eventId) ?? null)
      : null;

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
    onError: () => {
      setActionError("Could not create the event. Try again.");
    },
    onSuccess: invalidateCalendarData,
  });

  const updateMutation = useMutation({
    mutationFn: (input: CalendarUpdateEventInput) => updateCalendarEvent(input),
    onMutate: clearError,
    onError: () => {
      setActionError("Could not update the event. Try again.");
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
  const weekStartIso = (eventsInput.startsAt ?? "2026-05-18").slice(0, 10);

  /** ISO date for a Monday-relative day index in the visible window. */
  const isoDateForWeekDay = useCallback(
    (dayIndex: number): string => {
      const base = new Date(`${weekStartIso}T00:00:00.000Z`);
      base.setUTCDate(base.getUTCDate() + dayIndex);
      return base.toISOString().slice(0, 10);
    },
    [weekStartIso],
  );

  const openCreateDialog = (seed?: { date: string; start: number; end: number }) => {
    clearError();
    setDraft({
      mode: "create",
      calendarId: defaultCalendarId,
      title: "",
      description: "",
      location: "",
      date: seed?.date ?? isoDateForWeekDay(todayDayIndex()),
      start: seed?.start ?? 9,
      end: seed?.end ?? 10,
    });
  };

  const openEditDialog = (event: CalendarGridEvent) => {
    clearError();
    setDraft({
      mode: "edit",
      eventId: event.id,
      calendarId: event.calendarId ?? defaultCalendarId,
      title: event.title,
      description: event.apiEvent?.description ?? "",
      location: event.location ?? "",
      date: event.date,
      start: event.start,
      end: event.end,
    });
  };

  const submitDraft = (value: EventDraft) => {
    const startsAt = `${value.date}T${decimalHourToClock(value.start)}:00.000Z`;
    const endsAt = `${value.date}T${decimalHourToClock(value.end)}:00.000Z`;
    if (value.mode === "create") {
      createMutation.mutate({
        calendarId: value.calendarId,
        title: value.title,
        description: value.description.trim() === "" ? null : value.description,
        location: value.location.trim() === "" ? null : value.location,
        startsAt,
        endsAt,
      });
    } else if (value.eventId !== undefined) {
      updateMutation.mutate({
        eventId: value.eventId,
        patch: {
          title: value.title,
          description: value.description.trim() === "" ? null : value.description,
          location: value.location.trim() === "" ? null : value.location,
          startsAt,
          endsAt,
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
    updateMutation.mutate({
      eventId: event.id,
      patch: {
        startsAt: `${date}T${decimalHourToClock(nextStart)}:00.000Z`,
        endsAt: `${date}T${decimalHourToClock(nextStart + duration)}:00.000Z`,
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

  const writableSelected =
    selectedEvent !== null && selectedEvent.apiEvent !== undefined;

  return (
    <section
      className="calendar-page"
      style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}
    >
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
          writableSelected
            ? (eventId) => deleteMutation.mutate({ eventId })
            : undefined
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

/* ------------------------------------------------------------------ sidebar */

function CalendarSidebar({
  query,
  onSearchChange,
  calendars,
  calendarsLoading,
  calendarsError,
  visibility,
  onToggleCalendar,
  onCreate,
}: {
  readonly query: string;
  readonly onSearchChange: (value: string) => void;
  readonly calendars: readonly CalendarSidebarEntry[];
  readonly calendarsLoading: boolean;
  readonly calendarsError: boolean;
  readonly visibility: Readonly<Record<string, boolean>>;
  readonly onToggleCalendar: (id: string) => void;
  readonly onCreate: () => void;
}) {
  const mineSources = calendars.filter((source) => source.group === "mine");
  const teamSources = calendars.filter((source) => source.group === "team");

  const renderGroup = (
    label: string,
    entries: readonly CalendarSidebarEntry[],
    pad: string,
  ) => (
    <>
      <div className="section-label" style={{ padding: pad }}>
        {label}
      </div>
      {entries.map((source) => (
        <CalendarCheck
          key={source.id}
          checked={visibility[source.id] ?? source.visible}
          color={source.color}
          name={source.name}
          onToggle={() => onToggleCalendar(source.id)}
        />
      ))}
      {entries.length === 0 && (
        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", padding: "4px 0" }}>
          No calendars
        </div>
      )}
    </>
  );

  return (
    <aside aria-label="Calendar navigation" className="surf-sidebar">
      <button
        className="btn primary lg"
        style={{ width: "100%", marginBottom: 16 }}
        type="button"
        onClick={onCreate}
      >
        <Icons.Plus />
        Create
      </button>

      <label
        className="row gap-2"
        style={{
          marginBottom: 16,
          padding: "0 8px",
          height: 30,
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        <Icons.Search size={14} />
        <span className="sr-only">Search events</span>
        <input
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search events"
          style={{
            border: "none",
            background: "transparent",
            outline: "none",
            fontSize: "var(--text-body)",
            width: "100%",
            color: "var(--text)",
          }}
          type="search"
          value={query}
        />
      </label>

      <MiniMonth />

      {calendarsLoading && (
        <div style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", padding: "8px 0" }}>
          Loading calendars…
        </div>
      )}

      {calendarsError && !calendarsLoading && (
        <div
          role="alert"
          style={{ fontSize: "var(--text-caption)", color: "var(--danger)", padding: "4px 0 8px" }}
        >
          Calendars unavailable — try again later.
        </div>
      )}

      {!calendarsLoading && !calendarsError && (
        <>
          {renderGroup("My calendars", mineSources, "8px 0 4px")}
          {renderGroup("Team", teamSources, "12px 0 4px")}
        </>
      )}
    </aside>
  );
}

function CalendarCheck({
  checked,
  color,
  name,
  onToggle,
}: {
  readonly checked: boolean;
  readonly color: string;
  readonly name: string;
  readonly onToggle: () => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
        // Calendar list row — same scale as primary sidebar nav across
        // the app (mail/drive/chat) for cross-surface consistency.
        fontSize: "var(--text-body)",
        cursor: "pointer",
      }}
    >
      <input
        checked={checked}
        onChange={onToggle}
        style={{ accentColor: color }}
        type="checkbox"
      />
      <span>{name}</span>
    </label>
  );
}

/** Mini-month for May 2026: today gets a violet circle, the active week tints. */
function MiniMonth() {
  const headers = ["S", "M", "T", "W", "T", "F", "S"];
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: "var(--text-meta)", fontWeight: 600 }}>May 2026</span>
        <div style={{ marginLeft: "auto", display: "flex" }}>
          <button aria-label="Previous month" className="icon-btn" type="button">
            <Icons.ChevronLeft />
          </button>
          <button aria-label="Next month" className="icon-btn" type="button">
            <Icons.ChevronRight />
          </button>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 1,
          fontSize: "var(--text-chip)",
          textAlign: "center",
          color: "var(--text-3)",
          marginBottom: 4,
        }}
      >
        {headers.map((label, index) => (
          <div key={`${label}-${String(index)}`}>{label}</div>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: 1,
          fontSize: "var(--text-caption)",
          textAlign: "center",
        }}
      >
        {Array.from({ length: 35 }, (_, index) => {
          const day = index - 3; // May 1, 2026 is a Friday -> offset by 3.
          const valid = day >= 1 && day <= 31;
          const isToday = day === 21;
          const inWeek = day >= 18 && day <= 24;
          return (
            <div
              key={index}
              style={{
                aspectRatio: "1",
                display: "grid",
                placeItems: "center",
                borderRadius: 999,
                color: !valid ? "var(--text-3)" : isToday ? "var(--accent-fg)" : "var(--text)",
                background: isToday
                  ? "var(--accent)"
                  : inWeek && valid
                    ? "var(--accent-soft)"
                    : "transparent",
                fontWeight: isToday ? 600 : 400,
              }}
            >
              {valid ? day : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- week pane */

function CalendarWeek({
  events,
  weekStartIso,
  selectedEvent,
  onSelectEvent,
  onCloseEvent,
  view,
  onChangeView,
  windowLabel,
  onToday,
  onShiftWindow,
  loading,
  errored,
  empty,
  actionError,
  onDismissError,
  onMoveEvent,
  onDragCreate,
  onEditEvent,
  onDeleteEvent,
  onRespond,
  respondPending,
  deletePending,
}: {
  readonly events: readonly CalendarGridEvent[];
  readonly weekStartIso: string;
  readonly selectedEvent: CalendarGridEvent | null;
  readonly onSelectEvent: (eventId: string) => void;
  readonly onCloseEvent: () => void;
  readonly view: CalendarRouteView;
  readonly onChangeView: (view: CalendarRouteView) => void;
  readonly windowLabel: string;
  readonly onToday: () => void;
  readonly onShiftWindow: (direction: -1 | 1) => void;
  readonly loading: boolean;
  readonly errored: boolean;
  readonly empty: boolean;
  readonly actionError: string | null;
  readonly onDismissError: () => void;
  readonly onMoveEvent: (event: CalendarGridEvent, day: number, start: number) => void;
  readonly onDragCreate: (day: number, start: number, end: number) => void;
  readonly onEditEvent?: (event: CalendarGridEvent) => void;
  readonly onDeleteEvent?: (eventId: string) => void;
  readonly onRespond?: (eventId: string, status: CalendarApiResponseStatus) => void;
  readonly respondPending: boolean;
  readonly deletePending: boolean;
}) {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const selectEvent = (event: CalendarGridEvent, target: HTMLElement) => {
    setAnchorRect(target.getBoundingClientRect());
    onSelectEvent(event.id);
  };

  const closePopover = () => {
    setAnchorRect(null);
    onCloseEvent();
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--surface)",
        position: "relative",
      }}
    >
      {/* header */}
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          gap: 12,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <button className="btn sm" type="button" onClick={onToday}>
          Today
        </button>
        <div className="row">
          <button
            aria-label="Previous period"
            className="icon-btn"
            type="button"
            onClick={() => onShiftWindow(-1)}
          >
            <Icons.ChevronLeft />
          </button>
          <button
            aria-label="Next period"
            className="icon-btn"
            type="button"
            onClick={() => onShiftWindow(1)}
          >
            <Icons.ChevronRight />
          </button>
        </div>
        <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>{windowLabel}</span>
        {loading && (
          <span role="status" style={{ fontSize: "var(--text-meta)", color: "var(--text-3)" }}>
            Loading...
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          {VIEW_OPTIONS.map((option) => (
            <button
              aria-pressed={view === option}
              className={`btn sm ${view === option ? "primary" : ""}`}
              key={option}
              onClick={() => onChangeView(option)}
              type="button"
            >
              {option.charAt(0).toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {errored && (
        <div
          role="alert"
          style={{
            flexShrink: 0,
            padding: "6px 16px",
            fontSize: "var(--text-meta)",
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border)",
            color: "var(--danger)",
          }}
        >
          Calendar events unavailable — try again later.
        </div>
      )}

      {actionError !== null && (
        <div
          role="alert"
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 16px",
            fontSize: "var(--text-meta)",
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border)",
            color: "var(--danger)",
          }}
        >
          <span>{actionError}</span>
          <button
            className="icon-btn"
            type="button"
            aria-label="Dismiss error"
            onClick={onDismissError}
            style={{ marginLeft: "auto" }}
          >
            <Icons.X size={12} />
          </button>
        </div>
      )}

      {/* day headers */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px repeat(7, 1fr)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div />
        {WEEK_DAY_LABELS.map((label, index) => {
          const isToday = index === todayDayIndex();
          return (
            <div
              key={label}
              style={{
                padding: "8px 12px",
                textAlign: "center",
                borderLeft: "1px solid var(--border)",
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-chip)",
                  color: "var(--text-3)",
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                }}
              >
                {label}
              </div>
              <div
                style={{
                  fontSize: "var(--text-h2)",
                  fontWeight: 600,
                  marginTop: 2,
                  display: "inline-grid",
                  placeItems: "center",
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: isToday ? "var(--accent)" : "transparent",
                  color: isToday ? "var(--accent-fg)" : "var(--text)",
                }}
              >
                {dateNumberForDay(weekStartIso, index)}
              </div>
            </div>
          );
        })}
      </div>

      {/* week grid */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "grid",
          gridTemplateColumns: "60px repeat(7, 1fr)",
          position: "relative",
        }}
      >
        {/* hour gutter */}
        <div>
          {GRID_HOURS.map((hour) => (
            <div
              key={hour}
              style={{
                height: HOUR_HEIGHT,
                fontSize: "var(--text-chip)",
                color: "var(--text-3)",
                textAlign: "right",
                paddingRight: 8,
                paddingTop: 2,
                borderBottom: "1px solid var(--border)",
              }}
            >
              {hour <= 12 ? hour : hour - 12} {hour < 12 ? "AM" : "PM"}
            </div>
          ))}
        </div>

        {WEEK_DAY_LABELS.map((label, dayIndex) => (
          <DayColumn
            key={label}
            dayIndex={dayIndex}
            events={events.filter((event) => event.day === dayIndex)}
            selectedEvent={selectedEvent}
            onSelect={selectEvent}
            onMoveEvent={onMoveEvent}
            onDragCreate={onDragCreate}
          />
        ))}

        {empty && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              pointerEvents: "none",
            }}
          >
            <span style={{ fontSize: "var(--text-body-sm)", color: "var(--text-3)" }}>
              No events this week.
            </span>
          </div>
        )}
      </div>

      {selectedEvent !== null && (
        <CalendarEventPopover
          anchorRect={anchorRect}
          event={selectedEvent}
          onClose={closePopover}
          onEdit={onEditEvent}
          onDelete={onDeleteEvent}
          onRespond={onRespond}
          respondPending={respondPending}
          deletePending={deletePending}
        />
      )}
    </div>
  );
}

/** One day column: hour cells, event cards, drag-to-create + drag-to-move. */
function DayColumn({
  dayIndex,
  events,
  selectedEvent,
  onSelect,
  onMoveEvent,
  onDragCreate,
}: {
  readonly dayIndex: number;
  readonly events: readonly CalendarGridEvent[];
  readonly selectedEvent: CalendarGridEvent | null;
  readonly onSelect: (event: CalendarGridEvent, target: HTMLElement) => void;
  readonly onMoveEvent: (event: CalendarGridEvent, day: number, start: number) => void;
  readonly onDragCreate: (day: number, start: number, end: number) => void;
}) {
  const columnRef = useRef<HTMLDivElement>(null);
  /** A live drag-to-create selection, in decimal hours. */
  const [dragRange, setDragRange] = useState<{ from: number; to: number } | null>(null);

  /** Snap a column-relative Y pixel to a quarter-hour decimal hour. */
  const hourFromY = (clientY: number): number => {
    const rect = columnRef.current?.getBoundingClientRect();
    if (rect === undefined) {
      return GRID_START_HOUR;
    }
    const raw = GRID_START_HOUR + (clientY - rect.top) / HOUR_HEIGHT;
    const snapped = Math.round(raw * 4) / 4;
    return Math.min(GRID_START_HOUR + GRID_HOUR_COUNT, Math.max(GRID_START_HOUR, snapped));
  };

  const handleMouseDown = (domEvent: React.MouseEvent<HTMLDivElement>) => {
    // Ignore clicks that land on an event card; those open the popover.
    if (
      domEvent.target instanceof HTMLElement &&
      domEvent.target.closest("[data-calendar-event]") !== null
    ) {
      return;
    }
    const start = hourFromY(domEvent.clientY);
    setDragRange({ from: start, to: start });

    const handleMove = (moveEvent: MouseEvent) => {
      setDragRange({ from: start, to: hourFromY(moveEvent.clientY) });
    };
    const handleUp = (upEvent: MouseEvent) => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      const end = hourFromY(upEvent.clientY);
      setDragRange(null);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      onDragCreate(dayIndex, lo, hi === lo ? lo + 1 : hi);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  return (
    <div
      ref={columnRef}
      data-calendar-day={dayIndex}
      onMouseDown={handleMouseDown}
      style={{ position: "relative", borderLeft: "1px solid var(--border)" }}
    >
      {GRID_HOURS.map((hour) => (
        <div
          key={hour}
          style={{ height: HOUR_HEIGHT, borderBottom: "1px solid var(--border)" }}
        />
      ))}

      {dragRange !== null && dragRange.to !== dragRange.from && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 4,
            right: 4,
            top: (Math.min(dragRange.from, dragRange.to) - GRID_START_HOUR) * HOUR_HEIGHT,
            height: Math.abs(dragRange.to - dragRange.from) * HOUR_HEIGHT,
            background: "var(--accent-soft)",
            border: "1px dashed var(--accent)",
            borderRadius: 4,
            zIndex: 1,
          }}
        />
      )}

      {events.map((event) => (
        <EventCard
          key={event.id}
          event={event}
          selected={selectedEvent?.id === event.id}
          onSelect={onSelect}
          onMove={onMoveEvent}
          hourFromClientY={hourFromY}
        />
      ))}

      {dayIndex === todayDayIndex() && <NowLine />}
    </div>
  );
}

function EventCard({
  event,
  selected,
  onSelect,
  onMove,
  hourFromClientY,
}: {
  readonly event: CalendarGridEvent;
  readonly selected: boolean;
  readonly onSelect: (event: CalendarGridEvent, target: HTMLElement) => void;
  readonly onMove: (event: CalendarGridEvent, day: number, start: number) => void;
  readonly hourFromClientY: (clientY: number) => number;
}) {
  const top = (event.start - GRID_START_HOUR) * HOUR_HEIGHT;
  const height = Math.max(18, (event.end - event.start) * HOUR_HEIGHT - 2);
  /** Live vertical offset while dragging, in pixels. */
  const [dragOffset, setDragOffset] = useState(0);
  const movable = event.apiEvent !== undefined;

  const handleMouseDown = (domEvent: React.MouseEvent<HTMLButtonElement>) => {
    if (!movable) {
      return;
    }
    domEvent.stopPropagation();
    const card = domEvent.currentTarget;
    const originY = domEvent.clientY;
    const originHour = hourFromClientY(originY);
    let moved = false;
    let lastHour = originHour;

    const handleMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientY - originY;
      if (Math.abs(delta) > 3) {
        moved = true;
      }
      lastHour = hourFromClientY(moveEvent.clientY);
      setDragOffset((lastHour - originHour) * HOUR_HEIGHT);
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      setDragOffset(0);
      if (moved) {
        const nextStart = Math.max(GRID_START_HOUR, event.start + (lastHour - originHour));
        if (Math.abs(nextStart - event.start) >= 0.25) {
          onMove(event, event.day, nextStart);
        }
      } else {
        onSelect(event, card);
      }
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  return (
    <button
      data-calendar-event
      onMouseDown={handleMouseDown}
      onClick={(domEvent) => {
        domEvent.stopPropagation();
        // Movable cards select on mouseup; non-movable (seed) cards select here.
        if (!movable) {
          onSelect(event, domEvent.currentTarget);
        }
      }}
      style={{
        position: "absolute",
        top: top + dragOffset,
        left: 4,
        right: 4,
        height,
        background: event.color,
        color: "#ffffff",
        borderRadius: 4,
        padding: "4px 6px",
        fontSize: "var(--text-caption)",
        lineHeight: 1.3,
        overflow: "hidden",
        boxShadow: selected
          ? `0 0 0 2px var(--surface), 0 0 0 4px ${event.color}`
          : "0 1px 2px rgba(0, 0, 0, 0.1)",
        cursor: movable ? "grab" : "pointer",
        borderLeft: "3px solid rgba(0, 0, 0, 0.2)",
        textAlign: "left",
        zIndex: dragOffset !== 0 ? 3 : undefined,
      }}
      type="button"
    >
      <div style={{ fontWeight: 600 }}>{event.title}</div>
      <div style={{ opacity: 0.85, fontSize: "var(--text-chip)" }}>
        {formatCardTime(event.start)}
        {event.location !== undefined && ` · ${event.location}`}
      </div>
    </button>
  );
}

/** 2px red horizontal line at the current decimal hour on today's column. */
function NowLine() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: (nowDecimalHour() - GRID_START_HOUR) * HOUR_HEIGHT,
        borderTop: "2px solid var(--danger)",
        zIndex: 2,
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: "var(--danger)",
          marginTop: -5,
          marginLeft: -4,
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- popover */

const POPOVER_WIDTH = 340;
const POPOVER_HEIGHT = 320;

const RSVP_OPTIONS: readonly { status: CalendarApiResponseStatus; label: string }[] = [
  { status: "accepted", label: "Going" },
  { status: "tentative", label: "Maybe" },
  { status: "declined", label: "No" },
];

function CalendarEventPopover({
  anchorRect,
  event,
  onClose,
  onEdit,
  onDelete,
  onRespond,
  respondPending,
  deletePending,
}: {
  readonly anchorRect: DOMRect | null;
  readonly event: CalendarGridEvent;
  readonly onClose: () => void;
  readonly onEdit?: (event: CalendarGridEvent) => void;
  readonly onDelete?: (eventId: string) => void;
  readonly onRespond?: (eventId: string, status: CalendarApiResponseStatus) => void;
  readonly respondPending: boolean;
  readonly deletePending: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    const handleKeydown = (domEvent: KeyboardEvent) => {
      if (domEvent.key === "Escape") {
        onClose();
      }
    };
    const handlePointerDown = (domEvent: MouseEvent) => {
      const target = domEvent.target;
      if (target instanceof Node && popoverRef.current?.contains(target) === true) {
        return;
      }
      if (target instanceof HTMLElement && target.closest("[data-calendar-event]") !== null) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    // `mousedown` of the interaction that opened the popover has already fired
    // before this effect runs, so the listener can attach immediately without
    // racing the opening click.
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [onClose]);

  const [position, setPosition] = useState<{ readonly left: number; readonly top: number }>(() =>
    computePopoverPosition(anchorRect),
  );

  useLayoutEffect(() => {
    setPosition(computePopoverPosition(anchorRect));
  }, [anchorRect]);

  const hasConferencing = event.location !== undefined;
  const apiAttendees = event.apiEvent?.attendees ?? [];
  /** RSVP only makes sense for backend events the popover can act on. */
  const canRespond = onRespond !== undefined && event.apiEvent !== undefined;
  const canEdit = onEdit !== undefined;
  const canDelete = onDelete !== undefined;

  return (
    <div
      data-calendar-popover
      ref={popoverRef}
      role="dialog"
      aria-label={`Event: ${event.title}`}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        width: POPOVER_WIDTH,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        boxShadow: "var(--shadow-lg)",
        zIndex: 100,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          borderLeft: `4px solid ${event.color}`,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "var(--text-body-lg)", fontWeight: 600, marginBottom: 4, lineHeight: 1.3 }}>
            {event.title}
          </div>
          <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
            {formatEventDateLabel(event.date)} · {formatHour(event.start)} -{" "}
            {formatHour(event.end)}
          </div>
          {hasConferencing && (
            <div
              style={{
                fontSize: "var(--text-meta)",
                color: "var(--text-2)",
                marginTop: 4,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Icons.Video size={14} />
              {event.location}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {canEdit && (
            <button
              aria-label="Edit event"
              className="icon-btn"
              type="button"
              onClick={() => {
                onEdit(event);
                onClose();
              }}
            >
              <Icons.EditPen />
            </button>
          )}
          {canDelete && (
            <button
              aria-label="Delete event"
              className="icon-btn"
              type="button"
              disabled={deletePending}
              onClick={() => setConfirmingDelete(true)}
            >
              <Icons.Trash />
            </button>
          )}
          <button aria-label="Close" className="icon-btn" onClick={onClose} type="button">
            <Icons.X />
          </button>
        </div>
      </div>

      {confirmingDelete && canDelete && (
        <div
          style={{
            padding: "8px 14px",
            background: "var(--surface-2)",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "var(--text-meta)",
          }}
        >
          <span>Delete this event?</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button
              className="btn sm"
              type="button"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </button>
            <button
              className="btn sm primary"
              type="button"
              disabled={deletePending}
              onClick={() => onDelete(event.id)}
            >
              {deletePending ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      )}

      <div style={{ height: 1, background: "var(--border)" }} />
      <div style={{ padding: "10px 14px" }}>
        <div className="section-label" style={{ padding: "0 0 6px" }}>
          {event.attendees.length + 1} attendees
        </div>
        {/* The signed-in user is always an attendee; backend events list the
            other invitees, seed events fall back to display names only. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 0",
            fontSize: "var(--text-meta)",
          }}
        >
          <Avatar name="You" size={22} />
          <span>You</span>
        </div>
        {apiAttendees.length > 0
          ? apiAttendees.map((attendee) => (
                  <div
                    key={attendee.id ?? attendee.email}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 0",
                      fontSize: "var(--text-meta)",
                    }}
                  >
                    <Avatar
                      name={attendee.displayName ?? attendee.email}
                      size={22}
                    />
                    <span>{attendee.displayName ?? attendee.email}</span>
                    <span
                      className={`chip ${rsvpChipClass(attendee.responseStatus)}`}
                      style={{ marginLeft: "auto" }}
                    >
                      {rsvpLabel(attendee.responseStatus)}
                    </span>
                  </div>
                ))
              : event.attendees.map((name) => (
                  <div
                    key={name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 0",
                      fontSize: "var(--text-meta)",
                    }}
                  >
                    <Avatar name={name} size={22} />
                    <span>{name}</span>
                  </div>
                ))}
      </div>

      <div style={{ height: 1, background: "var(--border)" }} />
      {canRespond ? (
        <div style={{ padding: "10px 14px" }}>
          <div className="section-label" style={{ padding: "0 0 6px" }}>
            RSVP
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {RSVP_OPTIONS.map((option) => (
              <button
                key={option.status}
                className="btn sm"
                style={{ flex: 1 }}
                type="button"
                disabled={respondPending}
                onClick={() => onRespond(event.id, option.status)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ padding: "10px 14px", display: "flex", gap: 6 }}>
          {hasConferencing && (
            <button className="btn primary sm" style={{ flex: 1 }} type="button">
              <Icons.Video size={14} />
              Join
            </button>
          )}
          <button aria-label="Email attendees" className="btn sm" type="button">
            <Icons.Mail size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- event dialog */

function CalendarEventDialog({
  draft,
  calendars,
  pending,
  onSubmit,
  onClose,
}: {
  readonly draft: EventDraft;
  readonly calendars: readonly CalendarSidebarEntry[];
  readonly pending: boolean;
  readonly onSubmit: (draft: EventDraft) => void;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState<EventDraft>(draft);
  const writableCalendars = calendars.filter((calendar) => calendar.writable);

  useEffect(() => {
    const handleKeydown = (domEvent: KeyboardEvent) => {
      if (domEvent.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose]);

  const valid = value.title.trim().length > 0 && value.end > value.start;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={draft.mode === "create" ? "Create event" : "Edit event"}
      data-calendar-dialog
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.35)",
        display: "grid",
        placeItems: "center",
        zIndex: 200,
      }}
      onMouseDown={(domEvent) => {
        if (domEvent.target === domEvent.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        onSubmit={(domEvent) => {
          domEvent.preventDefault();
          if (valid && !pending) {
            onSubmit(value);
          }
        }}
        style={{
          width: 380,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "var(--shadow-lg)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: "var(--text-body-lg)", fontWeight: 600 }}>
            {draft.mode === "create" ? "Create event" : "Edit event"}
          </span>
          <button
            aria-label="Close"
            className="icon-btn"
            type="button"
            onClick={onClose}
            style={{ marginLeft: "auto" }}
          >
            <Icons.X />
          </button>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-meta)" }}>
          <span>Title</span>
          <input
            autoFocus
            value={value.title}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, title: domEvent.target.value }))
            }
            placeholder="Event title"
            style={dialogInputStyle}
            type="text"
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-meta)" }}>
          <span>Date</span>
          <input
            value={value.date}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, date: domEvent.target.value }))
            }
            style={dialogInputStyle}
            type="date"
          />
        </label>

        <div style={{ display: "flex", gap: 8 }}>
          <label
            style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-meta)", flex: 1 }}
          >
            <span>Start</span>
            <input
              value={decimalHourToClock(value.start)}
              onChange={(domEvent) =>
                setValue((current) => ({
                  ...current,
                  start: clockToDecimalHour(domEvent.target.value, current.start),
                }))
              }
              style={dialogInputStyle}
              type="time"
            />
          </label>
          <label
            style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-meta)", flex: 1 }}
          >
            <span>End</span>
            <input
              value={decimalHourToClock(value.end)}
              onChange={(domEvent) =>
                setValue((current) => ({
                  ...current,
                  end: clockToDecimalHour(domEvent.target.value, current.end),
                }))
              }
              style={dialogInputStyle}
              type="time"
            />
          </label>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-meta)" }}>
          <span>Location</span>
          <input
            value={value.location}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, location: domEvent.target.value }))
            }
            placeholder="Optional"
            style={dialogInputStyle}
            type="text"
          />
        </label>

        {writableCalendars.length > 0 && (
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-meta)" }}>
            <span>Calendar</span>
            <select
              value={value.calendarId ?? ""}
              onChange={(domEvent) =>
                setValue((current) => ({
                  ...current,
                  calendarId: domEvent.target.value === "" ? null : domEvent.target.value,
                }))
              }
              style={dialogInputStyle}
            >
              {writableCalendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--text-meta)" }}>
          <span>Description</span>
          <textarea
            value={value.description}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, description: domEvent.target.value }))
            }
            rows={3}
            style={{ ...dialogInputStyle, resize: "vertical" }}
          />
        </label>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button className="btn sm" type="button" onClick={onClose} style={{ flex: 1 }}>
            Cancel
          </button>
          <button
            className="btn sm primary"
            type="submit"
            disabled={!valid || pending}
            style={{ flex: 1 }}
          >
            {pending
              ? "Saving..."
              : draft.mode === "create"
                ? "Create"
                : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

const dialogInputStyle = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
  color: "var(--text)",
  padding: "6px 8px",
  fontSize: "var(--text-meta)",
  outline: "none",
} as const;

/* -------------------------------------------------------------------- helpers */

/** Place the popover beside the anchor, flipping/clamping to stay on screen. */
function computePopoverPosition(anchorRect: DOMRect | null): {
  readonly left: number;
  readonly top: number;
} {
  if (anchorRect === null) {
    return { left: 100, top: 100 };
  }
  let left = anchorRect.right + 8;
  let top = anchorRect.top;
  if (left + POPOVER_WIDTH > window.innerWidth - 16) {
    left = anchorRect.left - POPOVER_WIDTH - 8;
  }
  if (left < 16) {
    left = 16;
  }
  if (top + POPOVER_HEIGHT > window.innerHeight - 16) {
    top = window.innerHeight - POPOVER_HEIGHT - 16;
  }
  if (top < 60) {
    top = 60;
  }
  return { left, top };
}

/** Decimal hour -> `HH:MM` 24h clock string, e.g. 13.5 -> "13:30". */
function decimalHourToClock(decimalHour: number): string {
  const clamped = Math.max(0, Math.min(23.999, decimalHour));
  const hour = Math.floor(clamped);
  const minutes = Math.round((clamped - hour) * 60);
  return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** `HH:MM` 24h clock string -> decimal hour; falls back when unparseable. */
function clockToDecimalHour(clock: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (match === null) {
    return fallback;
  }
  const hour = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hour) || Number.isNaN(minutes)) {
    return fallback;
  }
  return hour + minutes / 60;
}

/** Header label for the visible window, e.g. "May 18 – 24, 2026". */
function formatWindowLabel(startsAt: string | undefined, endsAt: string | undefined): string {
  const start = new Date(startsAt ?? "2026-05-18T00:00:00.000Z");
  const end = new Date(endsAt ?? "2026-05-24T23:59:59.999Z");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Calendar";
  }
  const sameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  const month = (date: Date) =>
    date.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const startMonth = month(start);
  const endMonth = month(end);
  const year = end.getUTCFullYear();
  if (sameDay) {
    return `${startMonth} ${String(start.getUTCDate())}, ${String(year)}`;
  }
  if (startMonth === endMonth) {
    return `${startMonth} ${String(start.getUTCDate())} – ${String(end.getUTCDate())}, ${String(year)}`;
  }
  return `${startMonth} ${String(start.getUTCDate())} – ${endMonth} ${String(end.getUTCDate())}, ${String(year)}`;
}

/** Shift an ISO `yyyy-mm-dd` date by one view-sized step. */
function shiftIsoDate(isoDate: string, view: CalendarRouteView, direction: -1 | 1): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  if (view === "day") {
    date.setUTCDate(date.getUTCDate() + direction);
  } else if (view === "month") {
    date.setUTCMonth(date.getUTCMonth() + direction);
  } else {
    date.setUTCDate(date.getUTCDate() + direction * 7);
  }
  return date.toISOString().slice(0, 10);
}

/** Human date label for the popover, e.g. "2026-05-21" -> "Thu, May 21". */
function formatEventDateLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function rsvpLabel(status: CalendarApiResponseStatus): string {
  switch (status) {
    case "accepted":
      return "Going";
    case "declined":
      return "No";
    case "tentative":
      return "Maybe";
    default:
      return "Invited";
  }
}

function rsvpChipClass(status: CalendarApiResponseStatus): string {
  switch (status) {
    case "accepted":
      return "success";
    case "declined":
      return "danger";
    case "tentative":
      return "warning";
    default:
      return "";
  }
}
