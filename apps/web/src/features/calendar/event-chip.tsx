import type { CSSProperties, KeyboardEvent, PointerEvent, MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { labelFill, labelSoftFill } from "./colors";
import { formatLongDate, formatShortDate, formatTime, formatTimeRange } from "./date-math";
import type { CalendarOccurrence } from "./event-model";
import type { AllDayPlacement, TimedSegment } from "./grid-layout";

export function eventColorStyle(occurrence: CalendarOccurrence): CSSProperties {
  return {
    "--event-bg": labelFill(occurrence.label),
    "--event-soft": labelSoftFill(occurrence.label),
  } as CSSProperties;
}

/** "All day", "9 – 10am", or "Oct 15, 9pm – Oct 16, 1am" across midnight. */
export function occurrenceTimeText(occurrence: CalendarOccurrence): string {
  if (occurrence.event.allDay) return "All day";
  if (occurrence.startDate === occurrence.endDate) {
    return formatTimeRange(occurrence.start, occurrence.end);
  }
  return `${formatShortDate(occurrence.startDate)}, ${formatTime(occurrence.start)} – ${formatShortDate(occurrence.endDate)}, ${formatTime(occurrence.end)}`;
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  needs_action: "Not yet responded",
  tentative: "Maybe",
  declined: "Declined",
};

/** Screen-reader name: title, time, day, place and RSVP. */
/** "Thursday, October 15", or "Oct 15, 2026 – Oct 16, 2026" for multi-day all-day events. */
export function occurrenceDateText(occurrence: CalendarOccurrence): string {
  return occurrence.event.allDay && occurrence.endDate !== occurrence.startDate
    ? `${formatShortDate(occurrence.startDate)} – ${formatShortDate(occurrence.endDate)}`
    : formatLongDate(occurrence.startDate);
}

export function occurrenceAccessibleName(occurrence: CalendarOccurrence): string {
  const parts = [
    occurrence.event.title || "(No title)",
    occurrenceTimeText(occurrence),
    occurrenceDateText(occurrence),
  ];
  if (occurrence.event.location) parts.push(occurrence.event.location);
  if (occurrence.recurring) parts.push("Repeats");
  const status = occurrence.selfStatus === null ? undefined : STATUS_TEXT[occurrence.selfStatus];
  if (status !== undefined) parts.push(status);
  return parts.join(", ");
}

const MOVE_HINT_ID = "cal-move-hint";

/** Hidden instructions shared by every movable event. */
export function MoveHint() {
  return (
    <p id={MOVE_HINT_ID} className="sr-only">
      Press Enter to open. Alt plus Up or Down arrow moves the event by 15 minutes, Alt plus Left or
      Right arrow moves it by a day, and Alt plus Shift plus Up or Down arrow changes its length.
    </p>
  );
}

export interface EventChipHandlers {
  readonly onOpen: (occurrence: CalendarOccurrence, target: HTMLElement) => void;
  /** Keyboard reschedule: shift start and end by minutes. */
  readonly onNudge?: (
    occurrence: CalendarOccurrence,
    startMinutes: number,
    endMinutes: number,
  ) => void;
}

function nudgeFromKey(event: KeyboardEvent, allDay: boolean): readonly [number, number] | null {
  if (!event.altKey) return null;
  const day = 24 * 60;
  switch (event.key) {
    case "ArrowLeft":
      return [-day, -day];
    case "ArrowRight":
      return [day, day];
    case "ArrowUp":
      if (allDay) return null;
      return event.shiftKey ? [0, -15] : [-15, -15];
    case "ArrowDown":
      if (allDay) return null;
      return event.shiftKey ? [0, 15] : [15, 15];
    default:
      return null;
  }
}

function chipKeyDown(
  occurrence: CalendarOccurrence,
  handlers: EventChipHandlers,
  movable: boolean,
) {
  return (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!movable || handlers.onNudge === undefined) return;
    const nudge = nudgeFromKey(event, occurrence.allDay);
    if (nudge === null) return;
    event.preventDefault();
    handlers.onNudge(occurrence, nudge[0], nudge[1]);
  };
}

export function TimedEventChip({
  segment,
  selected,
  movable,
  dragging,
  handlers,
  onPointerDown,
  onClick,
}: {
  readonly segment: TimedSegment;
  readonly selected: boolean;
  readonly movable: boolean;
  readonly dragging: boolean;
  readonly handlers: EventChipHandlers;
  readonly onPointerDown?: (event: PointerEvent<HTMLElement>, mode: "move" | "resize") => void;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { occurrence } = segment;
  const span = segment.end - segment.start;
  const compact = span < 0.75;
  return (
    <button
      type="button"
      data-calendar-event
      data-occurrence-key={occurrence.key}
      data-status={occurrence.selfStatus ?? undefined}
      data-selected={selected}
      data-compact={compact}
      data-dragging={dragging}
      aria-label={occurrenceAccessibleName(occurrence)}
      aria-describedby={movable ? MOVE_HINT_ID : undefined}
      className={cn("cal-event cal-timed-event type-caption", movable && "cursor-grab")}
      style={
        {
          ...eventColorStyle(occurrence),
          "--start": segment.start,
          "--span": span,
          "--col": segment.column,
          "--cols": segment.columns,
        } as CSSProperties
      }
      onPointerDown={movable ? (event) => onPointerDown?.(event, "move") : undefined}
      onClick={onClick}
      onKeyDown={chipKeyDown(occurrence, handlers, movable)}
    >
      <span className="cal-event-title">{occurrence.event.title || "(No title)"}</span>
      <span className="cal-event-meta">
        {occurrenceTimeText(occurrence)}
        {!compact && occurrence.event.location ? ` · ${occurrence.event.location}` : null}
      </span>
      {movable && segment.occurrence.endDate === segment.day ? (
        <span
          aria-hidden="true"
          className="cal-resize-handle"
          onPointerDown={(event) => {
            event.stopPropagation();
            onPointerDown?.(event, "resize");
          }}
        />
      ) : null}
    </button>
  );
}

export function AllDayEventChip({
  placement,
  selected,
  movable,
  handlers,
}: {
  readonly placement: AllDayPlacement;
  readonly selected: boolean;
  readonly movable: boolean;
  readonly handlers: EventChipHandlers;
}) {
  const { occurrence } = placement;
  return (
    <button
      type="button"
      data-calendar-event
      data-occurrence-key={occurrence.key}
      data-status={occurrence.selfStatus ?? undefined}
      data-selected={selected}
      data-continues-before={placement.continuesBefore}
      data-continues-after={placement.continuesAfter}
      aria-label={occurrenceAccessibleName(occurrence)}
      aria-describedby={movable ? MOVE_HINT_ID : undefined}
      className="cal-event cal-all-day-event type-caption"
      style={{
        ...eventColorStyle(occurrence),
        gridColumn: `${String(placement.first + 2)} / span ${String(placement.last - placement.first + 1)}`,
        gridRow: placement.lane + 1,
      }}
      onClick={(event) => handlers.onOpen(occurrence, event.currentTarget)}
      onKeyDown={chipKeyDown(occurrence, handlers, movable)}
    >
      <span className="cal-event-title">{occurrence.event.title || "(No title)"}</span>
    </button>
  );
}

/** Compact list item: all-day as a filled bar, timed as a dot with its start time. */
export function EventListItem({
  occurrence,
  selected,
  handlers,
}: {
  readonly occurrence: CalendarOccurrence;
  readonly selected: boolean;
  readonly handlers: EventChipHandlers;
}) {
  const open = (event: MouseEvent<HTMLButtonElement>) =>
    handlers.onOpen(occurrence, event.currentTarget);
  if (occurrence.allDay) {
    return (
      <button
        type="button"
        data-calendar-event
        data-occurrence-key={occurrence.key}
        data-status={occurrence.selfStatus ?? undefined}
        data-selected={selected}
        aria-label={occurrenceAccessibleName(occurrence)}
        className="cal-event type-caption w-full"
        style={eventColorStyle(occurrence)}
        onClick={open}
      >
        <span className="cal-event-title">{occurrence.event.title || "(No title)"}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-calendar-event
      data-occurrence-key={occurrence.key}
      data-selected={selected}
      aria-label={occurrenceAccessibleName(occurrence)}
      className="cal-dot-event type-caption"
      style={eventColorStyle(occurrence)}
      onClick={open}
    >
      <span aria-hidden="true" className="cal-dot" />
      <span>
        {formatTime(occurrence.start)} <strong>{occurrence.event.title || "(No title)"}</strong>
      </span>
    </button>
  );
}
