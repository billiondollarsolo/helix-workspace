import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  GripVertical,
  HelpCircle,
  MapPin,
  PanelRight,
  Plus,
  Search,
  Trash2,
  Users,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useQuery } from "@tanstack/react-query";
import { SuggestionSlot } from "@helix/sdk-web";
import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  respondToCalendarEvent,
  updateCalendarEvent,
  type CalendarApiEvent,
  type CalendarApiResponseStatus,
} from "./api";
import {
  calendarEventsInputFromRouteState,
  calendarEventsQueryOptions,
  calendarFindTimeQueryOptions,
  defaultCalendarRouteState,
  type CalendarRouteState,
  type CalendarRouteView,
} from "./queries";

type CalendarView = CalendarRouteView;
type RSVPStatus = "yes" | "maybe" | "no" | "pending";
type CalendarSuggestionContext = Parameters<typeof SuggestionSlot>[0]["context"];

interface CalendarSource {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

interface CalendarAttendee {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly response: RSVPStatus;
}

interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly calendarId: string;
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly location: string;
  readonly description: string;
  readonly attendees: readonly CalendarAttendee[];
  readonly conferencing: boolean;
  readonly syncStatus?: "syncing" | "offline";
}

interface CalendarDay {
  readonly date: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly dayNumber: string;
}

interface MonthCell {
  readonly date: string;
  readonly dayNumber: string;
  readonly weekday: string;
  readonly inMonth: boolean;
}

interface DraftSelection {
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

interface FindTimeCandidate {
  readonly id: string;
  readonly date: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly score: string;
  readonly conflicts: readonly string[];
}

const dayStart = 8 * 60;
const dayEnd = 18 * 60;
const slotMinutes = 30;
const totalDayMinutes = dayEnd - dayStart;

const calendarSources: readonly CalendarSource[] = [
  { id: "team", label: "Product team", color: "#0f766e" },
  { id: "personal", label: "My calendar", color: "#4f46e5" },
  { id: "shared", label: "Shared rooms", color: "#d97706" },
];

const weekdayLongLabels = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const weekdayShortLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const monthLongLabels = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Parse an ISO `yyyy-mm-dd` string into a UTC-anchored Date. */
function dateFromIsoDate(value: string): Date {
  const [year = "1970", month = "1", day = "1"] = value.split("-");
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

/** Format a Date back into an ISO `yyyy-mm-dd` string. */
function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function calendarDayFromDate(date: Date): CalendarDay {
  const weekday = date.getUTCDay();
  return {
    date: formatIsoDate(date),
    label: weekdayLongLabels[weekday] ?? "",
    shortLabel: weekdayShortLabels[weekday] ?? "",
    dayNumber: String(date.getUTCDate()),
  };
}

/**
 * Compute the Monday-anchored seven-day window that contains `isoDate`.
 */
function weekDaysForDate(isoDate: string): readonly CalendarDay[] {
  const date = dateFromIsoDate(isoDate);
  const weekday = date.getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = addUtcDays(date, -daysSinceMonday);
  return Array.from({ length: 7 }, (_, index) => calendarDayFromDate(addUtcDays(monday, index)));
}

/**
 * Compute the 6x7 month grid (leading/trailing days included) for the month
 * containing `isoDate`. Weeks are Sunday-anchored to match the weekday header.
 */
function monthCellsForDate(isoDate: string): readonly MonthCell[] {
  const date = dateFromIsoDate(isoDate);
  const firstOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const gridStart = addUtcDays(firstOfMonth, -firstOfMonth.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => {
    const cellDate = addUtcDays(gridStart, index);
    return {
      date: formatIsoDate(cellDate),
      dayNumber: String(cellDate.getUTCDate()),
      weekday: weekdayShortLabels[cellDate.getUTCDay()] ?? "",
      inMonth: cellDate.getUTCMonth() === date.getUTCMonth(),
    };
  });
}

/** Human-readable label for the active period header. */
function periodLabelForView(view: CalendarView, isoDate: string): string {
  const date = dateFromIsoDate(isoDate);
  if (view === "month") {
    return `${monthLongLabels[date.getUTCMonth()] ?? ""} ${String(date.getUTCFullYear())}`;
  }
  if (view === "day") {
    const day = calendarDayFromDate(date);
    return `${day.label}, ${monthLongLabels[date.getUTCMonth()] ?? ""} ${day.dayNumber}, ${String(
      date.getUTCFullYear(),
    )}`;
  }
  const days = weekDaysForDate(isoDate);
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    return "";
  }
  const firstDate = dateFromIsoDate(first.date);
  const lastDate = dateFromIsoDate(last.date);
  const firstMonth = monthLongLabels[firstDate.getUTCMonth()] ?? "";
  const lastMonth = monthLongLabels[lastDate.getUTCMonth()] ?? "";
  const year = String(lastDate.getUTCFullYear());
  if (firstMonth === lastMonth) {
    return `${firstMonth} ${first.dayNumber}-${last.dayNumber}, ${year}`;
  }
  return `${firstMonth} ${first.dayNumber} - ${lastMonth} ${last.dayNumber}, ${year}`;
}

/** Step the active date by one period in the given direction. */
function shiftActiveDate(view: CalendarView, isoDate: string, direction: -1 | 1): string {
  const date = dateFromIsoDate(isoDate);
  if (view === "month") {
    return formatIsoDate(
      new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, date.getUTCDate())),
    );
  }
  return formatIsoDate(addUtcDays(date, (view === "day" ? 1 : 7) * direction));
}

const timeSlots = Array.from(
  { length: totalDayMinutes / slotMinutes },
  (_, index) => dayStart + index * slotMinutes,
);

const findTimeCandidates: readonly FindTimeCandidate[] = [
  {
    id: "candidate-1",
    date: "2026-05-21",
    startMinute: 10 * 60,
    endMinute: 10 * 60 + 30,
    score: "Best fit",
    conflicts: [],
  },
  {
    id: "candidate-2",
    date: "2026-05-22",
    startMinute: 13 * 60,
    endMinute: 14 * 60,
    score: "Good",
    conflicts: ["Elena has tentative hold"],
  },
  {
    id: "candidate-3",
    date: "2026-05-25",
    startMinute: 9 * 60 + 30,
    endMinute: 10 * 60,
    score: "Backup",
    conflicts: ["Sam out of office starts at 10:30"],
  },
];

const sampleCalendarEvents: readonly CalendarEvent[] = [
  {
    id: "evt-sample-design-review",
    title: "Drive layout review",
    calendarId: "team",
    date: "2026-05-20",
    startMinute: 10 * 60,
    endMinute: 11 * 60,
    location: "Meet",
    description: "Review Drive, Docs, and Mail density against the Google reference screens.",
    conferencing: true,
    attendees: [
      { id: "maya", name: "Maya Chen", email: "maya@helix.local", response: "yes" },
      { id: "sam", name: "Sam Patel", email: "sam@helix.local", response: "pending" },
      { id: "ari", name: "Ari Morgan", email: "ari@helix.local", response: "maybe" },
    ],
  },
  {
    id: "evt-sample-vendor-renewal",
    title: "Vendor renewal check-in",
    calendarId: "shared",
    date: "2026-05-20",
    startMinute: 13 * 60,
    endMinute: 13 * 60 + 45,
    location: "Conference Room B",
    description: "Finalize owners for contracts that expire before the end of the quarter.",
    conferencing: false,
    attendees: [
      { id: "maya", name: "Maya Chen", email: "maya@helix.local", response: "yes" },
      { id: "jordan", name: "Jordan Lee", email: "jordan@helix.local", response: "yes" },
    ],
  },
  {
    id: "evt-sample-family-call",
    title: "Dad healthcare update",
    calendarId: "personal",
    date: "2026-05-21",
    startMinute: 16 * 60 + 30,
    endMinute: 17 * 60,
    location: "Phone",
    description: "Review notes in Drive and update the shared folder after the call.",
    conferencing: false,
    attendees: [
      { id: "maya", name: "Maya Chen", email: "maya@helix.local", response: "yes" },
      { id: "riley", name: "Riley Brooks", email: "riley@helix.local", response: "pending" },
    ],
  },
];

const viewItems: ReadonlyArray<{
  readonly id: CalendarView;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { id: "week", label: "Week", icon: CalendarDays },
  { id: "month", label: "Month", icon: CalendarDays },
  { id: "day", label: "Day", icon: Clock },
];

export function CalendarShell({
  initialEventId,
  onRouteStateChange,
  routeState,
}: {
  readonly initialEventId?: string;
  readonly onRouteStateChange?: (state: CalendarRouteState) => void;
  readonly routeState?: CalendarRouteState;
} = {}) {
  const [localEvents, setLocalEvents] = useState<readonly CalendarEvent[]>([]);
  const [backendEventOverrides, setBackendEventOverrides] = useState<
    ReadonlyMap<string, CalendarEvent>
  >(new Map());
  const [deletedBackendEventIds, setDeletedBackendEventIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [timeCandidates, setTimeCandidates] =
    useState<readonly FindTimeCandidate[]>(findTimeCandidates);
  const [localView, setLocalView] = useState<CalendarView>(defaultCalendarRouteState.view);
  const [localQuery, setLocalQuery] = useState<string>(defaultCalendarRouteState.query);
  const [localActiveDate, setLocalActiveDate] = useState<string>(defaultCalendarRouteState.date);
  const [localSelectedEventId, setLocalSelectedEventId] = useState(initialEventId ?? "");
  const [draftSelection, setDraftSelection] = useState<DraftSelection | null>(null);
  const [draggedEventId, setDraggedEventId] = useState<string | null>(null);
  const [enabledCalendars, setEnabledCalendars] = useState<Readonly<Record<string, boolean>>>({
    team: true,
    personal: true,
    shared: true,
  });
  const [selectedCandidateId, setSelectedCandidateId] = useState("candidate-1");
  const view = routeState?.view ?? localView;
  const query = routeState?.query ?? localQuery;
  const activeDate = routeState?.date ?? localActiveDate;
  const selectedEventId = routeState?.eventId ?? localSelectedEventId;
  const eventsInput = useMemo(
    () => calendarEventsInputFromRouteState({ date: activeDate, view }),
    [activeDate, view],
  );
  const eventsQuery = useQuery(calendarEventsQueryOptions(eventsInput));
  const findTimeQuery = useQuery(calendarFindTimeQueryOptions());

  const sourceById = useMemo(
    () => new Map(calendarSources.map((source) => [source.id, source])),
    [],
  );
  const backendEvents = useMemo(() => {
    const eventsFromBackend = eventsQuery.data?.map(eventFromApiEvent) ?? [];
    const backendIds = new Set(eventsFromBackend.map((event) => event.id));
    const overriddenBackendEvents = eventsFromBackend
      .filter((event) => !deletedBackendEventIds.has(event.id))
      .map((event) => backendEventOverrides.get(event.id) ?? event);
    const createdBackendEvents = [...backendEventOverrides.values()].filter(
      (event) => !backendIds.has(event.id) && !deletedBackendEventIds.has(event.id),
    );
    return [...overriddenBackendEvents, ...createdBackendEvents];
  }, [backendEventOverrides, deletedBackendEventIds, eventsQuery.data]);
  const events = useMemo(() => {
    const seededEvents =
      backendEvents.length === 0 && localEvents.length === 0 ? sampleCalendarEvents : [];
    return [...backendEvents, ...localEvents, ...seededEvents].sort(compareEvents);
  }, [backendEvents, localEvents]);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0];
  const [debouncedQuery] = useDebouncedValue(query, { wait: 300 });
  const normalizedQuery = debouncedQuery.trim().toLowerCase();
  const visibleEvents = useMemo(
    () =>
      events.filter((event) => {
        const enabled = enabledCalendars[event.calendarId] ?? true;
        const matchesQuery =
          normalizedQuery.length === 0 ||
          `${event.title} ${event.location} ${event.description}`
            .toLowerCase()
            .includes(normalizedQuery);
        return enabled && matchesQuery;
      }),
    [enabledCalendars, events, normalizedQuery],
  );
  const upcomingEvents = useMemo(
    () =>
      [...visibleEvents]
        .filter((event) => event.date >= defaultCalendarRouteState.date)
        .sort(compareEvents)
        .slice(0, 5),
    [visibleEvents],
  );
  const weekDays = useMemo(() => weekDaysForDate(activeDate), [activeDate]);
  const monthCells = useMemo(() => monthCellsForDate(activeDate), [activeDate]);
  const activeDay = useMemo(
    () => calendarDayFromDate(dateFromIsoDate(activeDate)),
    [activeDate],
  );
  const visibleDays = view === "day" ? [activeDay] : weekDays;
  const periodLabel = periodLabelForView(view, activeDate);
  const selectedCandidate =
    timeCandidates.find((candidate) => candidate.id === selectedCandidateId) ?? timeCandidates[0];
  const scheduleSuggestionContext = calendarScheduleSuggestionContext(
    selectedEvent,
    timeCandidates,
  );
  const agendaSuggestionContext = calendarAgendaSuggestionContext(selectedEvent);

  useEffect(() => {
    if (initialEventId !== undefined && initialEventId.length > 0) {
      updateRouteState({ eventId: initialEventId });
    }
  }, [initialEventId]);

  useEffect(() => {
    if (!eventsQuery.isFetched) {
      return;
    }
    if (events.length === 0) {
      updateRouteState({ eventId: "" });
      return;
    }
    if (!events.some((event) => event.id === selectedEventId)) {
      updateRouteState({ eventId: events[0]?.id ?? "" });
    }
  }, [events, eventsQuery.isFetched, selectedEventId]);

  useEffect(() => {
    const selected = events.find((event) => event.id === selectedEventId);
    if (selected !== undefined && selected.date !== activeDate) {
      updateRouteState({ date: selected.date });
    }
  }, [activeDate, events, selectedEventId]);

  const updateRouteState = (patch: Partial<CalendarRouteState>) => {
    const nextState: CalendarRouteState = {
      eventId: selectedEventId,
      date: activeDate,
      view,
      query,
      ...patch,
    };
    setLocalSelectedEventId(nextState.eventId);
    setLocalActiveDate(nextState.date);
    setLocalView(nextState.view);
    setLocalQuery(nextState.query);
    onRouteStateChange?.(nextState);
  };

  useEffect(() => {
    const slots = findTimeQuery.data;
    if (slots === undefined || slots.length === 0) {
      return;
    }

    const nextCandidates = slots.map((slot, index) => candidateFromFindTimeSlot(slot, index));
    setTimeCandidates(nextCandidates);
    setSelectedCandidateId(nextCandidates[0]?.id ?? "candidate-1");
  }, [findTimeQuery.data]);

  useEffect(() => {
    if (findTimeQuery.isError) {
      setTimeCandidates(findTimeCandidates);
    }
  }, [findTimeQuery.isError]);

  const createEvent = (date = activeDate, startMinute = 9 * 60, endMinute = 10 * 60) => {
    const event: CalendarEvent = {
      id: `evt-local-${Date.now()}`,
      title: "New event",
      calendarId: "team",
      date,
      startMinute,
      endMinute,
      location: "Add location",
      description: "Draft event awaiting calendar backend sync.",
      conferencing: true,
      syncStatus: "syncing",
      attendees: [
        { id: "maya", name: "Maya Chen", email: "maya@helix.test", response: "yes" },
        { id: "sam", name: "Sam Patel", email: "sam@helix.test", response: "pending" },
      ],
    };
    setLocalEvents((current) => [...current, event]);
    updateRouteState({ date, eventId: event.id });
    void createCalendarEvent(eventToCreateInput(event))
      .then((backendEvent) => {
        const mappedEvent = eventFromApiEvent(backendEvent);
        setLocalEvents((current) => current.filter((candidate) => candidate.id !== event.id));
        setBackendEventOverrides((current) => {
          const next = new Map(current);
          next.set(mappedEvent.id, mappedEvent);
          return next;
        });
        setDeletedBackendEventIds((current) => {
          if (!current.has(mappedEvent.id)) {
            return current;
          }
          const next = new Set(current);
          next.delete(mappedEvent.id);
          return next;
        });
        updateRouteState({ date: mappedEvent.date, eventId: mappedEvent.id });
      })
      .catch(() => {
        setLocalEvents((current) =>
          current.map((candidate) =>
            candidate.id === event.id
              ? {
                  ...candidate,
                  description:
                    "Offline/local draft. Calendar backend create failed, so this event exists only in this browser session.",
                  syncStatus: "offline",
                }
              : candidate,
          ),
        );
      });
  };

  const commitDraftSelection = () => {
    if (!draftSelection) {
      return;
    }
    const startMinute = Math.min(draftSelection.startMinute, draftSelection.endMinute);
    const endMinute = Math.max(draftSelection.startMinute, draftSelection.endMinute) + slotMinutes;
    createEvent(draftSelection.date, startMinute, endMinute);
    setDraftSelection(null);
  };

  const moveEvent = (eventId: string, date: string, startMinute: number) => {
    const eventToMove = events.find((event) => event.id === eventId);
    if (eventToMove === undefined) {
      return;
    }
    const duration = eventToMove.endMinute - eventToMove.startMinute;
    const patch: Pick<CalendarEvent, "date" | "startMinute" | "endMinute"> = {
      date,
      startMinute,
      endMinute: Math.min(dayEnd, startMinute + duration),
    };
    patchEvent(eventId, patch);
    updateRouteState({ date, eventId });
    setDraggedEventId(null);
    if (isBackendEventId(eventId)) {
      void updateCalendarEvent({
        eventId,
        patch: {
          startsAt: dateMinuteToIso(patch.date, patch.startMinute),
          endsAt: dateMinuteToIso(patch.date, patch.endMinute),
        },
        sendInvitations: false,
      }).catch(() => undefined);
    }
  };

  const moveEventToDate = (eventId: string, date: string) => {
    const eventToMove = events.find((event) => event.id === eventId);
    if (eventToMove === undefined) {
      return;
    }
    const patch: CalendarEvent = { ...eventToMove, date };
    replaceEvent(eventId, patch);
    updateRouteState({ date, eventId });
    setDraggedEventId(null);
    if (isBackendEventId(eventId)) {
      void updateCalendarEvent({
        eventId,
        patch: {
          startsAt: dateMinuteToIso(patch.date, patch.startMinute),
          endsAt: dateMinuteToIso(patch.date, patch.endMinute),
        },
        sendInvitations: false,
      }).catch(() => undefined);
    }
  };

  const updateAttendeeResponse = (eventId: string, attendeeId: string, response: RSVPStatus) => {
    const attendeeEmail =
      events
        .find((event) => event.id === eventId)
        ?.attendees.find((attendee) => attendee.id === attendeeId)?.email ?? null;
    patchEvent(eventId, (event) => ({
      attendees: event.attendees.map((attendee) =>
        attendee.id === attendeeId ? { ...attendee, response } : attendee,
      ),
    }));
    const responseStatus = apiResponseFromRsvp(response);
    if (attendeeEmail !== null && responseStatus !== "needs_action" && isBackendEventId(eventId)) {
      void respondToCalendarEvent({
        eventId,
        attendeeEmail,
        responseStatus,
      })
        .then((backendEvent) => {
          const mappedEvent = eventFromApiEvent(backendEvent);
          replaceEvent(eventId, mappedEvent);
        })
        .catch(() => undefined);
    }
  };

  const deleteEvent = (eventId: string) => {
    const eventToDelete = events.find((event) => event.id === eventId);
    if (eventToDelete === undefined) {
      return;
    }
    if (isBackendEventId(eventId)) {
      setDeletedBackendEventIds((current) => {
        const next = new Set(current);
        next.add(eventId);
        return next;
      });
      setBackendEventOverrides((current) => {
        if (!current.has(eventId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(eventId);
        return next;
      });
    } else {
      setLocalEvents((current) => current.filter((event) => event.id !== eventId));
    }
    const nextEvents = events.filter((event) => event.id !== eventId);
    updateRouteState({ eventId: nextEvents[0]?.id ?? "" });
    if (isBackendEventId(eventId)) {
      void deleteCalendarEvent({ eventId, sendCancellation: false }).catch(() => undefined);
    }
  };

  const replaceEvent = (eventId: string, nextEvent: CalendarEvent) => {
    if (isBackendEventId(eventId)) {
      setBackendEventOverrides((current) => {
        const next = new Map(current);
        next.set(nextEvent.id, nextEvent);
        if (nextEvent.id !== eventId) {
          next.delete(eventId);
        }
        return next;
      });
      return;
    }

    setLocalEvents((current) =>
      current.map((event) => (event.id === eventId ? { ...nextEvent, id: eventId } : event)),
    );
  };

  const patchEvent = (
    eventId: string,
    patch: Partial<CalendarEvent> | ((event: CalendarEvent) => Partial<CalendarEvent>),
  ) => {
    const currentEvent = events.find((event) => event.id === eventId);
    if (currentEvent === undefined) {
      return;
    }
    const resolvedPatch = typeof patch === "function" ? patch(currentEvent) : patch;
    replaceEvent(eventId, { ...currentEvent, ...resolvedPatch });
  };

  const toggleCalendar = (calendarId: string) => {
    setEnabledCalendars((current) => ({
      ...current,
      [calendarId]: !(current[calendarId] ?? true),
    }));
  };

  const handleSlotPointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    date: string,
    minute: number,
  ) => {
    if (event.button !== 0) {
      return;
    }
    setDraftSelection({ date, startMinute: minute, endMinute: minute });
  };

  const handleSlotPointerEnter = (date: string, minute: number) => {
    setDraftSelection((current) =>
      current && current.date === date ? { ...current, endMinute: minute } : current,
    );
  };

  const handleSlotDrop = (event: DragEvent<HTMLButtonElement>, date: string, minute: number) => {
    event.preventDefault();
    const eventId = event.dataTransfer.getData("text/plain") || draggedEventId;
    if (eventId) {
      moveEvent(eventId, date, minute);
    }
  };

  const handleMonthDrop = (event: DragEvent<HTMLDivElement>, date: string) => {
    event.preventDefault();
    const eventId = event.dataTransfer.getData("text/plain") || draggedEventId;
    if (eventId) {
      moveEventToDate(eventId, date);
    }
  };

  return (
    <section className="calendar-page">
      <aside className="calendar-sidebar" aria-label="Calendar navigation">
        <button className="calendar-create-button" onClick={() => createEvent()} type="button">
          <Plus aria-hidden="true" size={18} />
          New event
        </button>

        <nav className="calendar-nav" aria-label="Calendar views">
          {viewItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-current={view === item.id ? "page" : undefined}
                className={view === item.id ? "calendar-nav-item active" : "calendar-nav-item"}
                key={item.id}
                onClick={() => updateRouteState({ view: item.id })}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="calendar-source-list" aria-label="Calendars">
          <h2>Calendars</h2>
          {calendarSources.map((source) => (
            <label className="calendar-source" key={source.id}>
              <input
                checked={enabledCalendars[source.id] ?? true}
                onChange={() => toggleCalendar(source.id)}
                type="checkbox"
              />
              <span
                className="calendar-source-dot"
                style={{ "--calendar-source-color": source.color } as CSSProperties}
              />
              {source.label}
            </label>
          ))}
        </div>

        <div className="calendar-mini-agenda">
          <strong>Today</strong>
          <span>{formatLongDate(defaultCalendarRouteState.date)}</span>
          {upcomingEvents.slice(0, 3).map((event) => (
            <button
              key={event.id}
              onClick={() => updateRouteState({ date: event.date, eventId: event.id })}
              type="button"
            >
              <span>{formatTimeRange(event)}</span>
              <strong>{event.title}</strong>
            </button>
          ))}
        </div>
      </aside>

      <div className="calendar-workspace" role="main" aria-labelledby="calendar-title">
        <header className="calendar-header">
          <div>
            <h1 id="calendar-title">Calendar</h1>
            <p>{periodLabel}</p>
          </div>
          <div className="calendar-header-actions">
            <button
              className="icon-button"
              aria-label="Previous period"
              onClick={() => updateRouteState({ date: shiftActiveDate(view, activeDate, -1) })}
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={17} />
            </button>
            <button
              className="helix-button helix-button-secondary"
              onClick={() => updateRouteState({ date: defaultCalendarRouteState.date })}
              type="button"
            >
              Today
            </button>
            <button
              className="icon-button"
              aria-label="Next period"
              onClick={() => updateRouteState({ date: shiftActiveDate(view, activeDate, 1) })}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={17} />
            </button>
            <button className="helix-button" onClick={() => createEvent()} type="button">
              <Plus aria-hidden="true" size={16} />
              Create
            </button>
          </div>
        </header>

        <div className="calendar-toolbar">
          <label className="calendar-search">
            <Search aria-hidden="true" size={17} />
            <span className="sr-only">Search Calendar</span>
            <input
              onChange={(event) => updateRouteState({ query: event.target.value })}
              placeholder="Search events"
              type="search"
              value={query}
            />
          </label>
          <div className="calendar-view-toggle" aria-label="Calendar view">
            {viewItems.map((item) => (
              <button
                className={view === item.id ? "active" : ""}
                key={item.id}
                onClick={() => updateRouteState({ view: item.id })}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="calendar-drag-hint">
            <GripVertical aria-hidden="true" size={15} />
            Drag slots to create, drag events to move
          </span>
        </div>

        <div className="calendar-content">
          <div className="calendar-board" aria-label="Calendar board">
            {eventsQuery.isError ? (
              <div className="calendar-backend-state" role="status">
                <strong>Calendar backend offline</strong>
                <span>
                  Backend events could not be loaded. Offline/local drafts from this session are
                  shown separately.
                </span>
              </div>
            ) : null}
            {view === "month" ? (
              <MonthView
                activeDate={activeDate}
                events={visibleEvents}
                monthCells={monthCells}
                onDragEnd={() => setDraggedEventId(null)}
                onDragStart={setDraggedEventId}
                onDrop={handleMonthDrop}
                onSelectDate={(date) => updateRouteState({ date })}
                onSelectEvent={(eventId) => updateRouteState({ eventId })}
                sourceById={sourceById}
              />
            ) : (
              <TimeGrid
                activeDate={activeDate}
                days={visibleDays}
                draftSelection={draftSelection}
                events={visibleEvents}
                onDragEnd={() => setDraggedEventId(null)}
                onDragStart={setDraggedEventId}
                onDropSlot={handleSlotDrop}
                onPointerDownSlot={handleSlotPointerDown}
                onPointerEnterSlot={handleSlotPointerEnter}
                onPointerUpSlot={commitDraftSelection}
                onSelectDate={(date) => updateRouteState({ date })}
                onSelectEvent={(eventId) => updateRouteState({ eventId })}
                selectedEventId={selectedEventId}
                sourceById={sourceById}
              />
            )}
          </div>

          <section className="calendar-side-panel" aria-label="Calendar details">
            <FindTimePanel
              candidates={timeCandidates}
              onCreateHold={(candidate) =>
                createEvent(candidate.date, candidate.startMinute, candidate.endMinute)
              }
              onSelectCandidate={setSelectedCandidateId}
              selectedCandidate={selectedCandidate}
              suggestionContext={scheduleSuggestionContext}
            />
            <EventDetails
              event={selectedEvent}
              onDelete={deleteEvent}
              onRespond={updateAttendeeResponse}
              source={selectedEvent ? sourceById.get(selectedEvent.calendarId) : undefined}
              suggestionContext={agendaSuggestionContext}
            />
          </section>
        </div>
      </div>
    </section>
  );
}

function TimeGrid({
  activeDate,
  days,
  draftSelection,
  events,
  onDragEnd,
  onDragStart,
  onDropSlot,
  onPointerDownSlot,
  onPointerEnterSlot,
  onPointerUpSlot,
  onSelectDate,
  onSelectEvent,
  selectedEventId,
  sourceById,
}: {
  readonly activeDate: string;
  readonly days: readonly CalendarDay[];
  readonly draftSelection: DraftSelection | null;
  readonly events: readonly CalendarEvent[];
  readonly onDragEnd: () => void;
  readonly onDragStart: (eventId: string) => void;
  readonly onDropSlot: (event: DragEvent<HTMLButtonElement>, date: string, minute: number) => void;
  readonly onPointerDownSlot: (
    event: PointerEvent<HTMLButtonElement>,
    date: string,
    minute: number,
  ) => void;
  readonly onPointerEnterSlot: (date: string, minute: number) => void;
  readonly onPointerUpSlot: () => void;
  readonly onSelectDate: (date: string) => void;
  readonly onSelectEvent: (eventId: string) => void;
  readonly selectedEventId: string;
  readonly sourceById: ReadonlyMap<string, CalendarSource>;
}) {
  return (
    <div
      className="calendar-time-grid"
      style={{ "--calendar-day-count": days.length } as CSSProperties}
    >
      <div className="calendar-time-spacer" />
      {days.map((day) => (
        <button
          className={
            activeDate === day.date ? "calendar-day-heading active" : "calendar-day-heading"
          }
          key={day.date}
          onClick={() => onSelectDate(day.date)}
          type="button"
        >
          <span>{day.shortLabel}</span>
          <strong>{day.dayNumber}</strong>
        </button>
      ))}

      <div className="calendar-time-rail" aria-hidden="true">
        {timeSlots
          .filter((minute) => minute % 60 === 0)
          .map((minute) => (
            <span key={minute}>{formatMinute(minute)}</span>
          ))}
      </div>

      {days.map((day) => {
        const dayEvents = events.filter((event) => event.date === day.date);
        return (
          <div className="calendar-day-column" key={day.date}>
            <div className="calendar-slot-layer">
              {timeSlots.map((minute) => (
                <button
                  aria-label={`${day.label} ${formatMinute(minute)}`}
                  className={slotClassName(draftSelection, day.date, minute)}
                  disabled={isSlotOccupied(dayEvents, minute)}
                  key={`${day.date}-${minute}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => onDropSlot(event, day.date, minute)}
                  onPointerDown={(event) => onPointerDownSlot(event, day.date, minute)}
                  onPointerEnter={() => onPointerEnterSlot(day.date, minute)}
                  onPointerUp={onPointerUpSlot}
                  type="button"
                />
              ))}
            </div>
            <div className="calendar-event-layer">
              {dayEvents.map((event) => (
                <EventBlock
                  event={event}
                  key={event.id}
                  onDragEnd={onDragEnd}
                  onDragStart={onDragStart}
                  onSelect={onSelectEvent}
                  selected={event.id === selectedEventId}
                  source={sourceById.get(event.calendarId)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthView({
  activeDate,
  events,
  monthCells,
  onDragEnd,
  onDragStart,
  onDrop,
  onSelectDate,
  onSelectEvent,
  sourceById,
}: {
  readonly activeDate: string;
  readonly events: readonly CalendarEvent[];
  readonly monthCells: readonly MonthCell[];
  readonly onDragEnd: () => void;
  readonly onDragStart: (eventId: string) => void;
  readonly onDrop: (event: DragEvent<HTMLDivElement>, date: string) => void;
  readonly onSelectDate: (date: string) => void;
  readonly onSelectEvent: (eventId: string) => void;
  readonly sourceById: ReadonlyMap<string, CalendarSource>;
}) {
  return (
    <div className="calendar-month">
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday) => (
        <div className="calendar-month-weekday" key={weekday}>
          {weekday}
        </div>
      ))}
      {monthCells.map((cell) => {
        const dayEvents = events.filter((event) => event.date === cell.date);
        return (
          <div
            className={monthCellClassName(cell, activeDate)}
            key={cell.date}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, cell.date)}
          >
            <button
              className="calendar-month-date"
              onClick={() => onSelectDate(cell.date)}
              type="button"
            >
              <span>{cell.weekday}</span>
              <strong>{cell.dayNumber}</strong>
            </button>
            <div className="calendar-month-events">
              {dayEvents.slice(0, 3).map((event) => (
                <button
                  className="calendar-month-event"
                  draggable
                  key={event.id}
                  onClick={() => onSelectEvent(event.id)}
                  onDragEnd={onDragEnd}
                  onDragStart={(dragEvent) => {
                    dragEvent.dataTransfer.setData("text/plain", event.id);
                    onDragStart(event.id);
                  }}
                  style={
                    {
                      "--calendar-event-color":
                        sourceById.get(event.calendarId)?.color ?? "#0f766e",
                    } as CSSProperties
                  }
                  type="button"
                >
                  <span>{formatMinute(event.startMinute)}</span>
                  {event.title}
                </button>
              ))}
              {dayEvents.length > 3 ? (
                <span className="calendar-month-more">+{dayEvents.length - 3} more</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventBlock({
  event,
  onDragEnd,
  onDragStart,
  onSelect,
  selected,
  source,
}: {
  readonly event: CalendarEvent;
  readonly onDragEnd: () => void;
  readonly onDragStart: (eventId: string) => void;
  readonly onSelect: (eventId: string) => void;
  readonly selected: boolean;
  readonly source: CalendarSource | undefined;
}) {
  const top = ((event.startMinute - dayStart) / totalDayMinutes) * 100;
  const height = ((event.endMinute - event.startMinute) / totalDayMinutes) * 100;
  return (
    <button
      className={selected ? "calendar-event-block selected" : "calendar-event-block"}
      draggable
      onClick={() => onSelect(event.id)}
      onDragEnd={onDragEnd}
      onDragStart={(dragEvent) => {
        dragEvent.dataTransfer.setData("text/plain", event.id);
        onDragStart(event.id);
      }}
      style={
        {
          "--calendar-event-color": source?.color ?? "#0f766e",
          "--calendar-event-top": `${top}%`,
          "--calendar-event-height": `${height}%`,
        } as CSSProperties
      }
      type="button"
    >
      <span>{formatTimeRange(event)}</span>
      <strong>{event.title}</strong>
      <small>
        {event.syncStatus ? `${eventSyncLabel(event)} - ${event.location}` : event.location}
      </small>
    </button>
  );
}

function FindTimePanel({
  candidates,
  onCreateHold,
  onSelectCandidate,
  selectedCandidate,
  suggestionContext,
}: {
  readonly candidates: readonly FindTimeCandidate[];
  readonly onCreateHold: (candidate: FindTimeCandidate) => void;
  readonly onSelectCandidate: (candidateId: string) => void;
  readonly selectedCandidate: FindTimeCandidate | undefined;
  readonly suggestionContext: CalendarSuggestionContext;
}) {
  return (
    <section className="calendar-find-time" aria-labelledby="calendar-find-time-title">
      <header>
        <div>
          <h2 id="calendar-find-time-title">Find time</h2>
          <p>4 attendees, 30-60 min</p>
        </div>
        <Users aria-hidden="true" size={18} />
      </header>
      <div className="calendar-candidates">
        {candidates.map((candidate) => (
          <button
            className={
              selectedCandidate?.id === candidate.id
                ? "calendar-candidate selected"
                : "calendar-candidate"
            }
            key={candidate.id}
            onClick={() => onSelectCandidate(candidate.id)}
            type="button"
          >
            <span>{candidate.score}</span>
            <strong>
              {formatShortDate(candidate.date)} · {formatMinute(candidate.startMinute)}-
              {formatMinute(candidate.endMinute)}
            </strong>
            <small>
              {candidate.conflicts.length === 0
                ? "Everyone is free"
                : candidate.conflicts.join(", ")}
            </small>
          </button>
        ))}
      </div>
      <button
        className="helix-button helix-button-secondary"
        disabled={!selectedCandidate}
        onClick={() => {
          if (selectedCandidate) {
            onCreateHold(selectedCandidate);
          }
        }}
        type="button"
      >
        <PanelRight aria-hidden="true" size={16} />
        Hold selected time
      </button>
      <SuggestionSlot
        className="calendar-suggestion-slot"
        context={suggestionContext}
        emptyFallback={<div className="calendar-suggestion-empty">No time suggestions</div>}
        loadingFallback={<div className="calendar-suggestion-empty">Loading time suggestions</div>}
        slotId="calendar.suggest-meeting-time"
      />
    </section>
  );
}

function EventDetails({
  event,
  onDelete,
  onRespond,
  source,
  suggestionContext,
}: {
  readonly event: CalendarEvent | undefined;
  readonly onDelete: (eventId: string) => void;
  readonly onRespond: (eventId: string, attendeeId: string, response: RSVPStatus) => void;
  readonly source: CalendarSource | undefined;
  readonly suggestionContext: CalendarSuggestionContext | undefined;
}) {
  if (!event) {
    return (
      <section className="calendar-event-details empty" aria-label="Event details">
        <CalendarDays aria-hidden="true" size={24} />
        <h2>No event selected</h2>
        <p>Select an event to review RSVP state and meeting details.</p>
      </section>
    );
  }

  return (
    <section className="calendar-event-details" aria-labelledby="calendar-event-details-title">
      <header>
        <span
          className="calendar-detail-color"
          style={{ "--calendar-event-color": source?.color ?? "#0f766e" } as CSSProperties}
        />
        <div>
          <h2 id="calendar-event-details-title">{event.title}</h2>
          <p>
            {event.syncStatus
              ? `${eventSyncLabel(event)} - ${source?.label ?? "Calendar"}`
              : (source?.label ?? "Calendar")}
          </p>
        </div>
      </header>

      <dl className="calendar-detail-list">
        <div>
          <dt>
            <Clock aria-hidden="true" size={15} />
            Time
          </dt>
          <dd>
            {formatLongDate(event.date)}, {formatTimeRange(event)}
          </dd>
        </div>
        <div>
          <dt>
            <MapPin aria-hidden="true" size={15} />
            Where
          </dt>
          <dd>{event.location}</dd>
        </div>
        {event.conferencing ? (
          <div>
            <dt>
              <Video aria-hidden="true" size={15} />
              Meet
            </dt>
            <dd>Helix Meet room ready</dd>
          </div>
        ) : null}
      </dl>

      <p className="calendar-event-notes">{event.description}</p>

      <SuggestionSlot
        className="calendar-suggestion-slot"
        context={suggestionContext}
        emptyFallback={<div className="calendar-suggestion-empty">No agenda draft</div>}
        loadingFallback={<div className="calendar-suggestion-empty">Loading agenda draft</div>}
        slotId="calendar.draft-agenda"
      />

      <div className="calendar-rsvp-summary" aria-label="RSVP summary">
        <ResponsePill icon={Check} label="Yes" value={countResponses(event, "yes")} />
        <ResponsePill icon={HelpCircle} label="Maybe" value={countResponses(event, "maybe")} />
        <ResponsePill icon={X} label="No" value={countResponses(event, "no")} />
      </div>

      <div className="calendar-attendees">
        <h3>Attendees</h3>
        {event.attendees.map((attendee) => (
          <article className="calendar-attendee" key={attendee.id}>
            <div>
              <span className={`calendar-response-dot ${attendee.response}`} />
              <strong>{attendee.name}</strong>
              <small>{attendee.email}</small>
            </div>
            <div className="calendar-rsvp-actions" aria-label={`${attendee.name} RSVP`}>
              {(["yes", "maybe", "no"] as const).map((response) => (
                <button
                  aria-pressed={attendee.response === response}
                  className={attendee.response === response ? "active" : ""}
                  key={response}
                  onClick={() => onRespond(event.id, attendee.id, response)}
                  type="button"
                >
                  {response}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>

      <button
        className="helix-button helix-button-destructive"
        onClick={() => onDelete(event.id)}
        type="button"
      >
        <Trash2 aria-hidden="true" size={16} />
        Delete event
      </button>
    </section>
  );
}

function ResponsePill({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: number;
}) {
  return (
    <span>
      <Icon aria-hidden="true" size={14} />
      {value} {label}
    </span>
  );
}

function calendarScheduleSuggestionContext(
  event: CalendarEvent | undefined,
  candidates: readonly FindTimeCandidate[],
): CalendarSuggestionContext {
  const durationMinutes =
    event !== undefined
      ? Math.max(slotMinutes, event.endMinute - event.startMinute)
      : Math.max(
          slotMinutes,
          (candidates[0]?.endMinute ?? dayStart + slotMinutes) -
            (candidates[0]?.startMinute ?? dayStart),
        );
  return {
    routePath: "/calendar",
    ...(event !== undefined
      ? {
          resource: {
            id: event.id,
            type: "calendar.event",
            label: event.title,
          },
        }
      : {}),
    classification: "standard",
    input: event?.title ?? "Find an available meeting time",
    metadata: {
      title: event?.title,
      purpose: event?.description,
      durationMinutes,
      timezone: "UTC",
      attendees:
        event?.attendees.map((attendee) => ({
          name: attendee.name,
          email: attendee.email,
          response: attendee.response,
        })) ?? [],
      slots: candidates.map((candidate) => ({
        startsAt: dateMinuteToIso(candidate.date, candidate.startMinute),
        endsAt: dateMinuteToIso(candidate.date, candidate.endMinute),
        score: candidate.score,
        conflicts: candidate.conflicts,
      })),
    },
  };
}

function calendarAgendaSuggestionContext(event: CalendarEvent | undefined): CalendarSuggestionContext {
  if (event === undefined) {
    return undefined;
  }
  return {
    routePath: "/calendar",
    resource: {
      id: event.id,
      type: "calendar.event",
      label: event.title,
    },
    classification: "standard",
    input: `${event.title}\n${event.description}`.trim(),
    metadata: {
      title: event.title,
      purpose: event.description,
      notes: event.description,
      startsAt: dateMinuteToIso(event.date, event.startMinute),
      endsAt: dateMinuteToIso(event.date, event.endMinute),
      timezone: "UTC",
      location: event.location,
      attendees: event.attendees.map((attendee) => ({
        name: attendee.name,
        email: attendee.email,
        response: attendee.response,
      })),
    },
  };
}

function slotClassName(draftSelection: DraftSelection | null, date: string, minute: number) {
  if (!draftSelection || draftSelection.date !== date) {
    return "calendar-slot";
  }
  const startMinute = Math.min(draftSelection.startMinute, draftSelection.endMinute);
  const endMinute = Math.max(draftSelection.startMinute, draftSelection.endMinute);
  return minute >= startMinute && minute <= endMinute ? "calendar-slot drafting" : "calendar-slot";
}

function isSlotOccupied(events: readonly CalendarEvent[], minute: number) {
  return events.some((event) => minute >= event.startMinute && minute < event.endMinute);
}

function monthCellClassName(cell: MonthCell, activeDate: string) {
  const classes = ["calendar-month-cell"];
  if (!cell.inMonth) {
    classes.push("muted");
  }
  if (cell.date === activeDate) {
    classes.push("active");
  }
  if (cell.date === defaultCalendarRouteState.date) {
    classes.push("today");
  }
  return classes.join(" ");
}

function countResponses(event: CalendarEvent, response: RSVPStatus) {
  return event.attendees.filter((attendee) => attendee.response === response).length;
}

function eventToCreateInput(event: CalendarEvent) {
  return {
    calendarId: null,
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: dateMinuteToIso(event.date, event.startMinute),
    endsAt: dateMinuteToIso(event.date, event.endMinute),
    timezone: "UTC",
    allDay: false,
    attendees: event.attendees.map((attendee) => ({
      email: attendee.email,
      displayName: attendee.name,
      responseStatus: apiResponseFromRsvp(attendee.response),
      metadata: { localId: attendee.id },
    })),
    metadata: { source: "web.calendar" },
    sendInvitations: false,
  };
}

function eventFromApiEvent(event: CalendarApiEvent): CalendarEvent {
  const startsAt = new Date(event.startsAt);
  const endsAt = new Date(event.endsAt);
  return {
    id: event.id,
    title: event.title,
    calendarId: calendarSources.some((source) => source.id === event.calendarId)
      ? event.calendarId
      : "team",
    date: event.startsAt.slice(0, 10),
    startMinute: dateToMinute(startsAt),
    endMinute: dateToMinute(endsAt),
    location: event.location ?? "Add location",
    description: event.description ?? "",
    conferencing: event.metadata?.conferencing === true,
    attendees: event.attendees.map((attendee, index) => ({
      id: attendee.id ?? attendee.actorId ?? attendee.email ?? `attendee-${index}`,
      name: attendee.displayName ?? attendee.email,
      email: attendee.email,
      response: rsvpFromApiResponse(attendee.responseStatus),
    })),
  };
}

function candidateFromFindTimeSlot(
  slot: { readonly startsAt: string; readonly endsAt: string; readonly busy: readonly unknown[] },
  index: number,
): FindTimeCandidate {
  const startsAt = new Date(slot.startsAt);
  const endsAt = new Date(slot.endsAt);
  return {
    id: `backend-candidate-${index}`,
    date: slot.startsAt.slice(0, 10),
    startMinute: dateToMinute(startsAt),
    endMinute: dateToMinute(endsAt),
    score: index === 0 ? "Best fit" : "Available",
    conflicts: slot.busy.length === 0 ? [] : [`${slot.busy.length} conflict`],
  };
}

function apiResponseFromRsvp(response: RSVPStatus): CalendarApiResponseStatus {
  if (response === "yes") {
    return "accepted";
  }
  if (response === "maybe") {
    return "tentative";
  }
  if (response === "no") {
    return "declined";
  }
  return "needs_action";
}

function rsvpFromApiResponse(response: CalendarApiResponseStatus): RSVPStatus {
  if (response === "accepted") {
    return "yes";
  }
  if (response === "tentative") {
    return "maybe";
  }
  if (response === "declined") {
    return "no";
  }
  return "pending";
}

function dateMinuteToIso(date: string, minute: number) {
  const hour = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${date}T${hour.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:00.000Z`;
}

function dateToMinute(date: Date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function isBackendEventId(eventId: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    eventId,
  );
}

function compareEvents(first: CalendarEvent, second: CalendarEvent) {
  return `${first.date}-${first.startMinute}`.localeCompare(`${second.date}-${second.startMinute}`);
}

function formatTimeRange(event: CalendarEvent) {
  return `${formatMinute(event.startMinute)}-${formatMinute(event.endMinute)}`;
}

function formatMinute(minute: number) {
  const hour = Math.floor(minute / 60);
  const minutes = minute % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minutes.toString().padStart(2, "0")} ${suffix}`;
}

function formatShortDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }
  const day = calendarDayFromDate(dateFromIsoDate(date));
  return `${day.shortLabel} ${day.dayNumber}`;
}

function formatLongDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }
  const parsed = dateFromIsoDate(date);
  const day = calendarDayFromDate(parsed);
  return `${day.label}, ${monthLongLabels[parsed.getUTCMonth()] ?? ""} ${day.dayNumber}`;
}

function eventSyncLabel(event: CalendarEvent) {
  return event.syncStatus === "offline" ? "Offline/local" : "Saving to backend";
}
