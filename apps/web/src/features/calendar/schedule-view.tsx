import { CalendarDays } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { addIsoDays, formatMonthShort, formatWeekdayShort, isoDayDiff } from "./date-math";
import {
  eventColorStyle,
  occurrenceAccessibleName,
  occurrenceTimeText,
  type EventChipHandlers,
} from "./event-chip";
import type { CalendarOccurrence } from "./event-model";
import { occurrencesOnDay } from "./grid-layout";
import { useTimeFormat } from "./preferences";

/** Schedule view: the upcoming days that have events, each with its agenda. */
export function ScheduleView({
  start,
  end,
  occurrences,
  today,
  selectedKey,
  handlers,
  onOpenDay,
  emptyAction,
}: {
  readonly start: string;
  readonly end: string;
  readonly occurrences: readonly CalendarOccurrence[];
  readonly today: string;
  readonly selectedKey: string | null;
  readonly handlers: EventChipHandlers;
  readonly onOpenDay: (day: string) => void;
  readonly emptyAction: ReactNode;
}) {
  const format = useTimeFormat();
  const days = useMemo(() => {
    const count = isoDayDiff(start, end) + 1;
    return Array.from({ length: count }, (_, index) => addIsoDays(start, index))
      .map((day) => ({ day, items: occurrencesOnDay(occurrences, day) }))
      .filter(({ items }) => items.length > 0);
  }, [start, end, occurrences]);

  if (days.length === 0) {
    return (
      <div className="cal-schedule">
        <EmptyState
          icon={<CalendarDays />}
          title="Nothing scheduled"
          body="There are no events in the next 30 days."
          action={emptyAction}
          size="inline"
        />
      </div>
    );
  }

  return (
    <div className="cal-schedule" role="region" aria-label="Schedule">
      {days.map(({ day, items }) => {
        const isToday = day === today;
        return (
          <section key={day} className="cal-schedule-day" aria-labelledby={`cal-schedule-${day}`}>
            <h2 id={`cal-schedule-${day}`} className="m-0 flex items-start gap-2">
              <button
                type="button"
                className="cal-day-number type-h3 focus-ring"
                data-today={isToday}
                aria-current={isToday ? "date" : undefined}
                aria-label={`${formatWeekdayShort(day)} ${formatMonthShort(day)} ${String(Number(day.slice(8)))}${isToday ? ", today" : ""}. Show this day`}
                onClick={() => onOpenDay(day)}
              >
                {String(Number(day.slice(8)))}
              </button>
              <span
                className="type-caption uppercase text-muted-foreground pt-3"
                aria-hidden="true"
              >
                {formatMonthShort(day)}, {formatWeekdayShort(day)}
              </span>
            </h2>
            <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
              {items.map((occurrence) => (
                <li key={occurrence.key}>
                  <button
                    type="button"
                    data-calendar-event
                    data-occurrence-key={occurrence.key}
                    data-selected={occurrence.key === selectedKey}
                    aria-label={occurrenceAccessibleName(occurrence, format)}
                    className="cal-schedule-row type-body-sm"
                    style={eventColorStyle(occurrence)}
                    onClick={(event) => handlers.onOpen(occurrence, event.currentTarget)}
                  >
                    <span aria-hidden="true" className="cal-dot" />
                    <span className="text-muted-foreground">
                      {occurrenceTimeText(occurrence, format)}
                    </span>
                    <span className="truncate">
                      <strong>{occurrence.event.title || "(No title)"}</strong>
                      {occurrence.event.location ? ` · ${occurrence.event.location}` : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
