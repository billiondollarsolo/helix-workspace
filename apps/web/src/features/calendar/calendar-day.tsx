import { cn } from "@/lib/utils";
import { useRef, useState } from "react";
import {
  GRID_HOURS,
  GRID_HOUR_COUNT,
  GRID_START_HOUR,
  HOUR_HEIGHT,
  formatCardTime,
  nowDecimalHour,
  todayDayIndex,
  type CalendarGridEvent,
} from "./data";

/** One day column: hour cells, event cards, drag-to-create + drag-to-move. */
export function DayColumn({
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
      className="relative [border-left:1px_solid_var(--border)]"
    >
      {GRID_HOURS.map((hour) => (
        <div key={hour} className="h-14 [border-bottom:1px_solid_var(--border)]" />
      ))}

      {dragRange !== null && dragRange.to !== dragRange.from && (
        <div
          aria-hidden="true"
          className="absolute left-1 right-1 [background:var(--accent-soft)] [border:1px_dashed_var(--accent)] rounded [z-index:1]"
          style={{
            top: (Math.min(dragRange.from, dragRange.to) - GRID_START_HOUR) * HOUR_HEIGHT,
            height: Math.abs(dragRange.to - dragRange.from) * HOUR_HEIGHT,
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
      className={cn(
        "absolute left-1 right-1 [color:#ffffff] rounded [padding:4px_6px] [font-size:var(--text-caption)] [line-height:1.3] overflow-hidden [border-left:3px_solid_rgba(0,_0,_0,_0.2)] text-left",
        movable ? "[cursor:grab]" : "cursor-pointer",
        dragOffset !== 0 ? "[z-index:3]" : "",
      )}
      style={{
        top: top + dragOffset,
        height,
        background: event.color,
        boxShadow: selected
          ? `0 0 0 2px var(--surface), 0 0 0 4px ${event.color}`
          : "0 1px 2px rgba(0, 0, 0, 0.1)",
      }}
      type="button"
    >
      <div className="font-semibold">{event.title}</div>
      <div className="[opacity:0.85] [font-size:var(--text-chip)]">
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
      className="absolute left-0 right-0 [border-top:2px_solid_var(--danger)] [z-index:2]"
      style={{ top: (nowDecimalHour() - GRID_START_HOUR) * HOUR_HEIGHT }}
    >
      <div className="w-2 h-2 [border-radius:999px] [background:var(--danger)] [margin-top:-5px] [margin-left:-4px]" />
    </div>
  );
}
