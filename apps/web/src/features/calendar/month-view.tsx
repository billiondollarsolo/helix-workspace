import { useMemo, useState } from "react";
import { AnchoredPopover, anchorRectOf, type AnchorRect } from "./anchored-popover";
import {
  formatLongDate,
  formatMonthShort,
  formatWeekdayShort,
  monthWeeks,
  type WeekStartDay,
} from "./date-math";
import { EventListItem, type EventChipHandlers } from "./event-chip";
import type { CalendarOccurrence } from "./event-model";
import { occurrencesOnDay } from "./grid-layout";

const MAX_ITEMS = 3;

export function MonthView({
  anchor,
  weekStartsOn,
  occurrences,
  today,
  selectedKey,
  handlers,
  onOpenDay,
  onCreateOnDay,
}: {
  readonly anchor: string;
  readonly weekStartsOn: WeekStartDay;
  readonly occurrences: readonly CalendarOccurrence[];
  readonly today: string;
  readonly selectedKey: string | null;
  readonly handlers: EventChipHandlers;
  readonly onOpenDay: (day: string) => void;
  readonly onCreateOnDay: (day: string, anchor: AnchorRect) => void;
}) {
  const weeks = useMemo(() => monthWeeks(anchor, weekStartsOn), [anchor, weekStartsOn]);
  const month = anchor.slice(0, 7);
  const [overflow, setOverflow] = useState<{ day: string; anchor: AnchorRect } | null>(null);

  return (
    <div className="cal-month" role="region" aria-label="Month">
      <div className="cal-month-weekdays" aria-hidden="true">
        {(weeks[0] ?? []).map((day) => (
          <div key={day} className="type-chip uppercase">
            {formatWeekdayShort(day)}
          </div>
        ))}
      </div>
      <div className="cal-month-grid">
        {weeks.flat().map((day, index) => {
          const items = occurrencesOnDay(occurrences, day);
          const visible = items.length > MAX_ITEMS ? items.slice(0, MAX_ITEMS - 1) : items;
          const hidden = items.length - visible.length;
          const isToday = day === today;
          const firstOfMonth = day.endsWith("-01");
          return (
            <div
              key={day}
              className="cal-month-cell"
              data-outside={day.slice(0, 7) !== month}
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  onCreateOnDay(day, anchorRectOf(event.currentTarget));
                }
              }}
            >
              <button
                type="button"
                className="cal-month-date type-caption font-semibold focus-ring"
                data-today={isToday}
                aria-current={isToday ? "date" : undefined}
                aria-label={`${formatLongDate(day)}${isToday ? ", today" : ""}. ${String(items.length)} ${items.length === 1 ? "event" : "events"}. Show this day`}
                onClick={() => onOpenDay(day)}
              >
                {index < 7 || firstOfMonth
                  ? `${firstOfMonth ? `${formatMonthShort(day)} ` : ""}${String(Number(day.slice(8)))}`
                  : String(Number(day.slice(8)))}
              </button>
              {visible.map((occurrence) => (
                <EventListItem
                  key={occurrence.key}
                  occurrence={occurrence}
                  selected={occurrence.key === selectedKey}
                  handlers={handlers}
                />
              ))}
              {hidden > 0 ? (
                <button
                  type="button"
                  className="cal-more type-caption focus-ring"
                  aria-label={`${String(hidden)} more events on ${formatLongDate(day)}`}
                  onClick={(event) =>
                    setOverflow({ day, anchor: anchorRectOf(event.currentTarget) })
                  }
                >
                  +{hidden} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {overflow !== null ? (
        <AnchoredPopover
          anchor={overflow.anchor}
          label={`Events on ${formatLongDate(overflow.day)}`}
          onClose={() => setOverflow(null)}
          className="w-64 p-2"
        >
          <h2 className="type-body-sm font-semibold mb-1 px-1.5">{formatLongDate(overflow.day)}</h2>
          <div className="flex flex-col gap-0.5">
            {occurrencesOnDay(occurrences, overflow.day).map((occurrence) => (
              <EventListItem
                key={occurrence.key}
                occurrence={occurrence}
                selected={occurrence.key === selectedKey}
                handlers={{
                  ...handlers,
                  onOpen: (picked, target) => {
                    setOverflow(null);
                    handlers.onOpen(picked, target);
                  },
                }}
              />
            ))}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}
