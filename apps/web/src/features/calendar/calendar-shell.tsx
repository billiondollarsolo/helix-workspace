import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ui/toast";
import { parseAddressList } from "@/features/people/person-ref";
import { sessionUserQueryOptions } from "@/lib/auth";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import { AnchoredPopover, anchorRectOf, type AnchorRect } from "./anchored-popover";
import { CalendarSettingsSheet } from "./calendar-settings-sheet";
import { CalendarSidebar } from "./calendar-sidebar";
import { CalendarToolbar, VIEW_LABELS } from "./calendar-toolbar";
import {
  formatRangeTitle,
  formatZoneLabel,
  gridDays,
  nowHourInZone,
  shiftAnchor,
  todayInZone,
  type CalendarView,
} from "./date-math";
import { EventDetails } from "./event-details";
import { draftFromEvent, newEventDraft, type EventDraft } from "./event-draft";
import { EventEditor } from "./event-editor";
import { selfAttendee, type CalendarOccurrence, type CalendarSource } from "./event-model";
import { MonthView } from "./month-view";
import { TimeFormatProvider, useCalendarPreferences } from "./preferences";
import { calendarQueryKeys } from "./queries";
import { QuickCreate } from "./quick-create";
import { defaultCalendarRouteState, type CalendarRouteState } from "./route-state";
import { ScheduleView } from "./schedule-view";
import { TimeGrid } from "./time-grid";
import { useCalendarData } from "./use-calendar-data";
import { useEventActions } from "./use-event-actions";
import "./calendar.css";

const DESKTOP_VIEWS: readonly CalendarView[] = ["day", "week", "month", "schedule", "3day"];
const COMPACT_VIEWS: readonly CalendarView[] = ["day", "3day", "month", "schedule"];
const COMPACT_QUERY = "(max-width: 640px)";

function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window.matchMedia === "function" && window.matchMedia(COMPACT_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_QUERY);
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

/** The current time, refreshed every minute so "now" and "today" stay true. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  const scheduleTick = useDebouncedCallback(() => setNow(new Date()), { wait: 60_000 });
  useEffect(() => {
    scheduleTick();
  }, [now, scheduleTick]);
  return now;
}

/** Prefilled "new event" intent from another app, e.g. a person's "Schedule a meeting". */
export interface CalendarCreateIntent {
  readonly attendees: readonly string[];
}

export interface CalendarShellProps {
  readonly routeState?: CalendarRouteState;
  readonly onRouteStateChange?: (state: CalendarRouteState) => void;
  readonly createIntent?: CalendarCreateIntent | null;
  readonly onCreateIntentHandled?: () => void;
  readonly onEmailGuests?: (emails: readonly string[]) => void;
  readonly onOpenLink?: (url: string, event: MouseEvent<HTMLAnchorElement>) => void;
}

interface QuickCreateState {
  readonly draft: EventDraft;
  readonly anchor: AnchorRect;
}

export function CalendarShell({
  routeState,
  onRouteStateChange,
  createIntent = null,
  onCreateIntentHandled,
  onEmailGuests,
  onOpenLink,
}: CalendarShellProps = {}) {
  const queryClient = useQueryClient();
  const [localState, setLocalState] = useState(routeState ?? defaultCalendarRouteState);
  const state = routeState ?? localState;
  const updateState = useCallback(
    (patch: Partial<CalendarRouteState>) => {
      const next = { ...state, ...patch };
      setLocalState(next);
      onRouteStateChange?.(next);
    },
    [onRouteStateChange, state],
  );

  const { preferences, setShowWeekends } = useCalendarPreferences();
  const compact = useCompactLayout();
  const view: CalendarView = compact && state.view === "week" ? "3day" : state.view;
  const now = useNow();
  const today = todayInZone(preferences.timeZone, now);
  const session = useQuery(sessionUserQueryOptions()).data;
  const viewer = useMemo(
    () => ({ actorId: session?.actorId ?? null, email: session?.email ?? null }),
    [session?.actorId, session?.email],
  );
  const [announcement, setAnnouncement] = useState("");
  const actions = useEventActions({
    announce: setAnnouncement,
    timeFormat: preferences.timeFormat,
  });
  const data = useCalendarData({
    view,
    anchor: state.date,
    preferences,
    viewer,
    query: state.query,
    hiddenEventIds: actions.hiddenEventIds,
  });

  const [selected, setSelected] = useState<{ key: string; anchor: AnchorRect } | null>(null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);
  const [editor, setEditor] = useState<{ draft: EventDraft; id: number } | null>(null);
  const [settingsFor, setSettingsFor] = useState<CalendarSource | null>(null);

  const selectedOccurrence = useMemo<CalendarOccurrence | null>(() => {
    if (state.eventId === "") return null;
    return (
      data.occurrences.find((occurrence) => occurrence.key === selected?.key) ??
      data.occurrences.find((occurrence) => occurrence.event.id === state.eventId) ??
      null
    );
  }, [data.occurrences, selected?.key, state.eventId]);

  // A deep link (?event=…) has no clicked chip; anchor on the drawn chip, or the centre.
  useLayoutEffect(() => {
    if (selectedOccurrence === null || selected?.key === selectedOccurrence.key) return;
    const chip = document.querySelector(
      `[data-occurrence-key="${CSS.escape(selectedOccurrence.key)}"]`,
    );
    setSelected({
      key: selectedOccurrence.key,
      anchor:
        chip === null
          ? { left: window.innerWidth / 2 - 200, top: 120, width: 0, height: 0 }
          : anchorRectOf(chip),
    });
  }, [selected?.key, selectedOccurrence]);

  const writableCalendar = data.calendars.find((calendar) => calendar.writable) ?? null;
  const canModify = useCallback(
    (occurrence: CalendarOccurrence) =>
      data.calendarsById.get(occurrence.event.calendarId)?.writable === true,
    [data.calendarsById],
  );

  const closeEvent = useCallback(() => {
    setSelected(null);
    if (state.eventId !== "") updateState({ eventId: "" });
  }, [state.eventId, updateState]);

  const openOccurrence = useCallback(
    (occurrence: CalendarOccurrence, target: HTMLElement) => {
      setQuickCreate(null);
      setSelected({ key: occurrence.key, anchor: anchorRectOf(target) });
      updateState({ eventId: occurrence.event.id });
    },
    [updateState],
  );

  const draftFor = useCallback(
    (seed: {
      date: string;
      start?: number;
      end?: number;
      allDay?: boolean;
      guests?: EventDraft["guests"];
    }) =>
      newEventDraft({
        ...seed,
        calendarId: writableCalendar?.id ?? null,
        timeZone: preferences.timeZone,
      }),
    [preferences.timeZone, writableCalendar?.id],
  );

  const openEditor = useCallback(
    (draft: EventDraft) => {
      setQuickCreate(null);
      closeEvent();
      setEditor({ draft, id: Date.now() });
    },
    [closeEvent],
  );

  /** "Create" and the c key: the next whole hour today, or 9am on the shown day. */
  const createNew = useCallback(() => {
    const date = view === "month" || view === "schedule" ? today : state.date;
    const start =
      date === today ? Math.min(23, Math.floor(nowHourInZone(preferences.timeZone, now)) + 1) : 9;
    openEditor(draftFor({ date, start }));
  }, [draftFor, now, openEditor, preferences.timeZone, state.date, today, view]);

  const handledIntent = useRef<CalendarCreateIntent | null>(null);
  useEffect(() => {
    if (createIntent === null || handledIntent.current === createIntent) return;
    handledIntent.current = createIntent;
    const guests = parseAddressList(createIntent.attendees.join(","));
    openEditor(draftFor({ date: today, start: 9, guests }));
    onCreateIntentHandled?.();
  }, [createIntent, draftFor, onCreateIntentHandled, openEditor, today]);

  const startQuickCreate = useCallback(
    (draft: EventDraft, anchor: AnchorRect) => {
      closeEvent();
      if (compact) {
        openEditor(draft);
        return;
      }
      setQuickCreate({ draft, anchor });
    },
    [closeEvent, compact, openEditor],
  );

  const saveDraft = (draft: EventDraft, after: () => void) => {
    actions.save.mutate(draft, {
      onSuccess: after,
      onError: (error) => {
        if (quickCreate !== null) {
          notify({
            tone: "error",
            message: "Couldn't create the event",
            description: error instanceof Error ? error.message : "Try again.",
          });
        }
      },
    });
  };

  const setView = (next: CalendarView) => updateState({ view: next });
  const goToday = () => updateState({ date: today });
  const shift = (direction: -1 | 1) =>
    updateState({ date: shiftAnchor(view, state.date, direction) });
  const openDay = (day: string) => updateState({ view: "day", date: day });
  const editSelected =
    selectedOccurrence !== null && canModify(selectedOccurrence)
      ? () => openEditor(draftFromEvent(selectedOccurrence.event))
      : undefined;
  const deleteSelected =
    selectedOccurrence !== null && canModify(selectedOccurrence)
      ? () => {
          const event = selectedOccurrence.event;
          closeEvent();
          actions.deleteEvent(event);
        }
      : undefined;
  const browsing = editor === null;

  useShortcuts("calendar", {
    "calendar.view-day": browsing ? () => setView("day") : undefined,
    "calendar.view-3day": browsing ? () => setView("3day") : undefined,
    "calendar.view-week": browsing ? () => setView("week") : undefined,
    "calendar.view-month": browsing ? () => setView("month") : undefined,
    "calendar.view-schedule": browsing ? () => setView("schedule") : undefined,
    "calendar.today": browsing ? goToday : undefined,
    "calendar.next": browsing ? () => shift(1) : undefined,
    "calendar.previous": browsing ? () => shift(-1) : undefined,
    "calendar.create": browsing ? createNew : undefined,
    "calendar.edit": browsing ? editSelected : undefined,
    "calendar.delete": browsing ? deleteSelected : undefined,
    "calendar.close":
      editor !== null
        ? (event) => {
            // Esc leaves the editor only from outside its fields, so typing is never lost.
            const target = event.target;
            if (target instanceof HTMLElement && target.closest("input, textarea, select"))
              return false;
            setEditor(null);
          }
        : selectedOccurrence !== null || quickCreate !== null
          ? () => {
              setQuickCreate(null);
              closeEvent();
            }
          : undefined,
  });

  const range = data.range;
  const title = formatRangeTitle(view, range.start, range.end);
  const handlers = {
    onOpen: openOccurrence,
    onNudge: (occurrence: CalendarOccurrence, startMinutes: number, endMinutes: number) =>
      actions.moveEvent(occurrence.event, startMinutes, endMinutes),
    onCreate: (day: string, start: number, end: number, anchor: AnchorRect) =>
      startQuickCreate(draftFor({ date: day, start, end }), anchor),
    onReschedule: (occurrence: CalendarOccurrence, startMinutes: number, endMinutes: number) =>
      actions.moveEvent(occurrence.event, startMinutes, endMinutes),
  };
  const createButton = (
    <Button onClick={createNew}>
      <Plus aria-hidden="true" />
      Create event
    </Button>
  );

  let body;
  if (data.eventsQuery.isLoading) {
    body = <Skeleton variant="row" count={8} label="Loading events" className="p-4" />;
  } else if (view === "month") {
    body = (
      <MonthView
        anchor={state.date}
        weekStartsOn={preferences.weekStartsOn}
        occurrences={data.occurrences}
        today={today}
        selectedKey={selectedOccurrence?.key ?? null}
        handlers={handlers}
        onOpenDay={openDay}
        onCreateOnDay={(day, anchor) =>
          startQuickCreate(draftFor({ date: day, allDay: true }), anchor)
        }
      />
    );
  } else if (view === "schedule") {
    body = (
      <ScheduleView
        start={range.start}
        end={range.end}
        occurrences={data.occurrences}
        today={today}
        selectedKey={selectedOccurrence?.key ?? null}
        handlers={handlers}
        onOpenDay={openDay}
        emptyAction={createButton}
      />
    );
  } else {
    body = (
      <TimeGrid
        days={gridDays(view, state.date, preferences)}
        occurrences={data.occurrences}
        today={today}
        nowHour={nowHourInZone(preferences.timeZone, now)}
        zoneLabel={formatZoneLabel(preferences.timeZone, now)}
        workdayStart={preferences.workingHours.start}
        selectedKey={selectedOccurrence?.key ?? null}
        pendingSlot={
          quickCreate === null || quickCreate.draft.allDay
            ? null
            : {
                day: quickCreate.draft.startDate,
                start: quickCreate.draft.startTime,
                end:
                  quickCreate.draft.endDate > quickCreate.draft.startDate
                    ? 24
                    : quickCreate.draft.endTime,
              }
        }
        canModify={canModify}
        handlers={handlers}
        onOpenDay={openDay}
        label={`${VIEW_LABELS[view]}, ${title}`}
      />
    );
  }

  return (
    <TimeFormatProvider value={preferences.timeFormat}>
      <section className="cal-page">
        <h1 className="sr-only">Calendar</h1>
        <CalendarSidebar
          anchor={state.date}
          weekStartsOn={preferences.weekStartsOn}
          calendars={data.calendars}
          loading={data.calendarsQuery.isLoading}
          error={data.calendarsQuery.isError}
          retrying={data.calendarsQuery.isFetching}
          hidden={data.hiddenCalendars}
          onCreate={createNew}
          onPickDate={(date) => updateState({ date })}
          onToggleCalendar={data.toggleCalendar}
          onShowOnly={data.showOnlyCalendar}
          onOpenSettings={setSettingsFor}
          onRetry={() =>
            void queryClient.invalidateQueries({ queryKey: calendarQueryKeys.calendars })
          }
        />
        <div className="cal-main">
          {editor !== null ? (
            <EventEditor
              key={editor.id}
              initial={editor.draft}
              calendars={data.calendars}
              weekStartsOn={preferences.weekStartsOn}
              workingHours={preferences.workingHours}
              viewerTimeZone={preferences.timeZone}
              selfActorId={viewer.actorId}
              pending={actions.save.isPending}
              error={actions.saveError}
              onSave={(draft) => saveDraft(draft, () => setEditor(null))}
              onClose={() => setEditor(null)}
            />
          ) : (
            <>
              <CalendarToolbar
                title={title}
                view={view}
                views={compact ? COMPACT_VIEWS : DESKTOP_VIEWS}
                today={today}
                showWeekends={preferences.showWeekends}
                onToday={goToday}
                onShift={shift}
                onViewChange={setView}
                onShowWeekendsChange={setShowWeekends}
              />
              {data.eventsQuery.isError ? (
                <InlineError
                  className="m-3"
                  title="Couldn't load events"
                  message="Your calendar may be missing events. Check your connection and try again."
                  onRetry={() =>
                    void queryClient.invalidateQueries({ queryKey: calendarQueryKeys.eventsRoot })
                  }
                  retrying={data.eventsQuery.isFetching}
                />
              ) : null}
              {body}
              <Button className="cal-fab" size="lg" aria-label="Create event" onClick={createNew}>
                <Plus aria-hidden="true" />
                Create
              </Button>
            </>
          )}
        </div>

        {selectedOccurrence !== null && selected !== null && editor === null ? (
          <AnchoredPopover
            anchor={selected.anchor}
            side={compact ? "bottom" : "right"}
            label={`Event: ${selectedOccurrence.event.title || "(No title)"}`}
            onClose={closeEvent}
          >
            <EventDetails
              occurrence={selectedOccurrence}
              calendarName={
                data.calendarsById.get(selectedOccurrence.event.calendarId)?.name ?? null
              }
              viewer={viewer}
              selfName={session?.name.trim() || null}
              canEdit={canModify(selectedOccurrence)}
              canRespond={(() => {
                const self = selfAttendee(selectedOccurrence.event, viewer);
                return self !== null && self.isOrganizer !== true;
              })()}
              respondPending={actions.respond.isPending}
              onEdit={() => editSelected?.()}
              onDelete={() => deleteSelected?.()}
              onRespond={(status) =>
                actions.respond.mutate({ eventId: selectedOccurrence.event.id, status })
              }
              {...(onEmailGuests === undefined ? {} : { onEmailGuests })}
              {...(onOpenLink === undefined ? {} : { onOpenLink })}
              onClose={closeEvent}
            />
          </AnchoredPopover>
        ) : null}

        {quickCreate !== null ? (
          <AnchoredPopover
            anchor={quickCreate.anchor}
            label="Create event"
            onClose={() => setQuickCreate(null)}
          >
            <QuickCreate
              draft={quickCreate.draft}
              pending={actions.save.isPending}
              onSave={(draft) => saveDraft(draft, () => setQuickCreate(null))}
              onMoreOptions={openEditor}
              onClose={() => setQuickCreate(null)}
            />
          </AnchoredPopover>
        ) : null}

        {settingsFor !== null ? (
          <CalendarSettingsSheet calendar={settingsFor} onClose={() => setSettingsFor(null)} />
        ) : null}

        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </section>
    </TimeFormatProvider>
  );
}
