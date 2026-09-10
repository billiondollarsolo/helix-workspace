import { cn } from "@/lib/utils";
import {
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  X as XIcon,
} from "lucide-react";
import { useState } from "react";
import { type CalendarApiResponseStatus } from "./api";
import { formatCalendarDate } from "./calendar-date-helpers";
import { DayColumn } from "./calendar-day";
import { CalendarEventPopover } from "./calendar-event-popover";
import {
  dateNumberForDay,
  formatHour,
  GRID_HOURS,
  isOnGrid,
  todayDayIndex,
  WEEK_DAY_LABELS,
  type CalendarGridEvent,
} from "./data";
import { type CalendarRouteView } from "./queries";
const VIEW_OPTIONS: readonly CalendarRouteView[] = ["day", "week", "month", "agenda"];

/* ----------------------------------------------------------------- week pane */

export function CalendarWeek({
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

  const gridEvents = events.filter(isOnGrid);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-card relative">
      {/* header */}
      <div className="calendar-toolbar h-11 shrink-0 flex items-center [padding:0_16px] gap-3 [border-bottom:1px_solid_var(--border)]">
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
            <ChevronLeftIcon size={16} />
          </button>
          <button
            aria-label="Next period"
            className="icon-btn"
            type="button"
            onClick={() => onShiftWindow(1)}
          >
            <ChevronRightIcon size={16} />
          </button>
        </div>
        <span className="[font-size:var(--text-body)] font-semibold">{windowLabel}</span>
        {loading && (
          <span role="status" className="[font-size:var(--text-meta)] text-muted-foreground">
            Loading...
          </span>
        )}
        <div className="ml-auto flex gap-1">
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
          className="shrink-0 [padding:6px_16px] [font-size:var(--text-meta)] bg-muted [border-bottom:1px_solid_var(--border)] text-destructive"
        >
          Calendar events unavailable — try again later.
        </div>
      )}

      {actionError !== null && (
        <div
          role="alert"
          className="shrink-0 flex items-center gap-2 [padding:6px_16px] [font-size:var(--text-meta)] bg-muted [border-bottom:1px_solid_var(--border)] text-destructive"
        >
          <span>{actionError}</span>
          <button
            className="icon-btn ml-auto"
            type="button"
            aria-label="Dismiss error"
            onClick={onDismissError}
          >
            <XIcon size={12} />
          </button>
        </div>
      )}

      {view !== "week" ? (
        <CalendarPeriodList
          events={events}
          selectedEvent={selectedEvent}
          onSelect={selectEvent}
          empty={empty}
          view={view}
        />
      ) : (
        <>
          {/* day headers */}
          <div className="grid [grid-template-columns:60px_repeat(7,_1fr)] [border-bottom:1px_solid_var(--border)] shrink-0">
            <div />
            {WEEK_DAY_LABELS.map((label, index) => {
              const isToday = index === todayDayIndex();
              return (
                <div
                  key={label}
                  className="[padding:8px_12px] text-center [border-left:1px_solid_var(--border)]"
                >
                  <div className="[font-size:var(--text-chip)] text-muted-foreground uppercase [letter-spacing:.06em]">
                    {label}
                  </div>
                  <div
                    className={cn(
                      "[font-size:var(--text-h2)] font-semibold mt-0.5 [display:inline-grid] [place-items:center] w-7 h-7 [border-radius:999px]",
                      isToday ? "[background:var(--accent)]" : "bg-transparent",
                      isToday ? "[color:var(--accent-fg)]" : "text-foreground",
                    )}
                  >
                    {dateNumberForDay(weekStartIso, index)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* week grid */}
          <div
            role="region"
            aria-label="Calendar week"
            tabIndex={0}
            className="flex-1 overflow-y-auto grid [grid-template-columns:60px_repeat(7,_1fr)] relative"
          >
            {/* hour gutter */}
            <div>
              {GRID_HOURS.map((hour) => (
                <div
                  key={hour}
                  className="h-14 [font-size:var(--text-chip)] text-muted-foreground text-right pr-2 pt-0.5 [border-bottom:1px_solid_var(--border)]"
                >
                  {hour <= 12 ? hour : hour - 12} {hour < 12 ? "AM" : "PM"}
                </div>
              ))}
            </div>

            {WEEK_DAY_LABELS.map((label, dayIndex) => (
              <DayColumn
                key={label}
                dayIndex={dayIndex}
                events={gridEvents.filter((event) => event.day === dayIndex)}
                selectedEvent={selectedEvent}
                onSelect={selectEvent}
                onMoveEvent={onMoveEvent}
                onDragCreate={onDragCreate}
              />
            ))}

            {empty && (
              <div className="absolute inset-0 grid [place-items:center] pointer-events-none">
                <span className="[font-size:var(--text-body-sm)] text-muted-foreground">
                  No events this week.
                </span>
              </div>
            )}
          </div>
        </>
      )}

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

function CalendarPeriodList({
  events,
  selectedEvent,
  onSelect,
  empty,
  view,
}: {
  readonly events: readonly CalendarGridEvent[];
  readonly selectedEvent: CalendarGridEvent | null;
  readonly onSelect: (event: CalendarGridEvent, target: HTMLElement) => void;
  readonly empty: boolean;
  readonly view: Exclude<CalendarRouteView, "week">;
}) {
  const ordered = [...events].sort(
    (left, right) => left.date.localeCompare(right.date) || left.start - right.start,
  );
  return (
    <div className="flex-1 overflow-y-auto p-4" aria-label={`${view} events`}>
      {empty ? (
        <p className="text-muted-foreground">No events in this {view}.</p>
      ) : (
        ordered.map((event, index) => {
          const showDate = index === 0 || ordered[index - 1]?.date !== event.date;
          return (
            <div key={event.id}>
              {showDate ? (
                <h3 className="[margin:16px_0_6px] [font-size:var(--text-body)]">
                  {formatCalendarDate(event.date)}
                </h3>
              ) : null}
              <button
                type="button"
                className={cn(
                  `btn ${selectedEvent?.id === event.id ? "primary" : ""}`,
                  "grid [grid-template-columns:110px_1fr] w-full mb-1.5 text-left",
                )}
                onClick={(clickEvent) => onSelect(event, clickEvent.currentTarget)}
                style={{ borderLeft: `4px solid ${event.color}` }}
              >
                <span>{event.apiEvent?.allDay === true ? "All day" : formatHour(event.start)}</span>
                <span>
                  <strong>{event.title}</strong>
                  {event.location === undefined ? null : ` · ${event.location}`}
                </span>
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
