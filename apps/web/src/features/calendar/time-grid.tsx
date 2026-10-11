/* Day, 3-day and Week views: a 24-hour scrollable grid with sticky day
   headers and an all-day row. Opens scrolled to the current time on today,
   otherwise to just before the working day. */

import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { labelFill, labelSoftFill, DEFAULT_CALENDAR_LABEL } from "./colors";
import {
  formatHourLabel,
  formatLongDate,
  formatTimeRange,
  formatWeekdayShort,
  isWeekend,
} from "./date-math";
import {
  AllDayEventChip,
  eventColorStyle,
  MoveHint,
  TimedEventChip,
  type EventChipHandlers,
} from "./event-chip";
import type { CalendarOccurrence } from "./event-model";
import { allDayPlacements, timedSegmentsForDay } from "./grid-layout";
import { useGridPointer, type GridPointerCallbacks } from "./use-grid-pointer";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface PendingSlot {
  readonly day: string;
  readonly start: number;
  readonly end: number;
}

export interface TimeGridProps {
  readonly days: readonly string[];
  readonly occurrences: readonly CalendarOccurrence[];
  readonly today: string;
  readonly nowHour: number;
  readonly zoneLabel: string;
  /** Hour to scroll to when the visible days change and today is not shown. */
  readonly workdayStart: number;
  readonly selectedKey: string | null;
  readonly pendingSlot: PendingSlot | null;
  readonly canModify: (occurrence: CalendarOccurrence) => boolean;
  readonly handlers: EventChipHandlers & GridPointerCallbacks;
  readonly onOpenDay: (day: string) => void;
  readonly label: string;
}

export function TimeGrid({
  days,
  occurrences,
  today,
  nowHour,
  zoneLabel,
  workdayStart,
  selectedKey,
  pendingSlot,
  canModify,
  handlers,
  onOpenDay,
  label,
}: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { drag, onColumnPointerDown, onEventPointerDown, consumeDragClick } = useGridPointer(
    bodyRef,
    handlers,
  );
  const placements = useMemo(() => allDayPlacements(occurrences, days), [occurrences, days]);
  const segmentsByDay = useMemo(
    () => new Map(days.map((day) => [day, timedSegmentsForDay(occurrences, day)])),
    [occurrences, days],
  );
  const showsToday = days.includes(today);
  const daysKey = days.join(",");

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const column = bodyRef.current?.querySelector<HTMLElement>("[data-day]");
    if (scroller === null || column === null || column === undefined) return;
    const hourHeight = column.offsetHeight / 24;
    const target = showsToday ? Math.max(0, nowHour - 1.5) : Math.max(0, workdayStart - 1);
    scroller.scrollTop = Math.round(target * hourHeight);
    // Re-run only when the visible days change, not every minute as "now" moves.
  }, [daysKey]);

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      className="cal-grid focus-ring"
      style={{ "--cal-cols": days.length } as CSSProperties}
    >
      <MoveHint />
      <div className="cal-grid-head">
        <div className="cal-grid-columns">
          <div className="cal-gutter-label type-caption" title="Time zone">
            {zoneLabel}
          </div>
          {days.map((day) => {
            const isToday = day === today;
            return (
              <div
                key={day}
                className="cal-day-head"
                data-weekend={isWeekend(day) && days.length > 1}
              >
                <span className="cal-day-weekday type-chip uppercase" data-today={isToday}>
                  {formatWeekdayShort(day)}
                </span>
                <button
                  type="button"
                  className="cal-day-number type-h2 focus-ring"
                  data-today={isToday}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={`${formatLongDate(day)}${isToday ? ", today" : ""}. Show this day`}
                  onClick={() => onOpenDay(day)}
                >
                  {String(Number(day.slice(8)))}
                </button>
              </div>
            );
          })}
        </div>
        <div role="group" aria-label="All-day events" className="cal-all-day min-h-7">
          <div className="cal-all-day-gutter type-caption" aria-hidden="true" />
          {placements.map((placement) => (
            <AllDayEventChip
              key={placement.occurrence.key}
              placement={placement}
              selected={placement.occurrence.key === selectedKey}
              movable={canModify(placement.occurrence)}
              handlers={handlers}
            />
          ))}
        </div>
      </div>

      <div ref={bodyRef} className="cal-grid-columns cal-grid-body">
        <div className="cal-hours" aria-hidden="true">
          {HOURS.map((hour) => (
            <div key={hour} className="cal-hour-label type-caption">
              <span>{formatHourLabel(hour)}</span>
            </div>
          ))}
        </div>
        {days.map((day) => (
          <div
            key={day}
            data-day={day}
            data-weekend={isWeekend(day) && days.length > 1}
            className="cal-day-col"
            onPointerDown={(event) => onColumnPointerDown(day, event)}
          >
            {(segmentsByDay.get(day) ?? []).map((segment) => {
              const movable = canModify(segment.occurrence);
              return (
                <TimedEventChip
                  key={`${segment.occurrence.key}:${day}`}
                  segment={segment}
                  selected={segment.occurrence.key === selectedKey}
                  movable={movable}
                  dragging={
                    drag !== null &&
                    drag.kind !== "create" &&
                    drag.occurrence.key === segment.occurrence.key
                  }
                  handlers={handlers}
                  onPointerDown={(event, mode) => onEventPointerDown(segment, event, mode)}
                  onClick={(event) => {
                    if (consumeDragClick()) return;
                    handlers.onOpen(segment.occurrence, event.currentTarget);
                  }}
                />
              );
            })}
            {drag !== null && drag.kind !== "create" && drag.day === day ? (
              <div
                aria-hidden="true"
                data-ghost="true"
                className="cal-event cal-timed-event type-caption"
                style={
                  {
                    ...eventColorStyle(drag.occurrence),
                    "--start": drag.start,
                    "--span": drag.end - drag.start,
                    "--col": 0,
                    "--cols": 1,
                  } as CSSProperties
                }
              >
                <span className="cal-event-title">
                  {drag.occurrence.event.title || "(No title)"}
                </span>
                <span className="cal-event-meta">{formatTimeRange(drag.start, drag.end)}</span>
              </div>
            ) : null}
            {drag?.kind === "create" && drag.day === day && drag.from !== drag.to ? (
              <SlotPreview
                start={Math.min(drag.from, drag.to)}
                end={Math.max(drag.from, drag.to)}
              />
            ) : null}
            {pendingSlot !== null && pendingSlot.day === day && drag === null ? (
              <SlotPreview start={pendingSlot.start} end={pendingSlot.end} />
            ) : null}
            {day === today ? (
              <div
                aria-hidden="true"
                className="cal-now-line"
                style={{ "--now": nowHour } as CSSProperties}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function SlotPreview({ start, end }: { readonly start: number; readonly end: number }) {
  return (
    <div
      aria-hidden="true"
      className="cal-event cal-draft-slot type-caption"
      style={
        {
          "--event-bg": labelFill(DEFAULT_CALENDAR_LABEL),
          "--event-soft": labelSoftFill(DEFAULT_CALENDAR_LABEL),
          "--start": start,
          "--span": end - start,
        } as CSSProperties
      }
    >
      <span className="cal-event-title">(No title)</span>
      <span className="cal-event-meta">{formatTimeRange(start, end)}</span>
    </div>
  );
}
