/* DateTimePicker — a month grid and a time list, for snooze, schedule send,
   and event times. Usually placed inside a Popover or dialog.

   Month grid (WAI-ARIA date grid): one tab stop; Arrow keys move by day or
   week, Home/End to the start/end of the week, PageUp/PageDown by month,
   Shift+PageUp/PageDown by year, Enter/Space picks. Time list: a listbox
   where Arrow/Home/End move and select. Dates and times before `min` are
   announced as unavailable and cannot be picked.

   <DateTimePicker value={when} onChange={setWhen} min={new Date()} /> */

import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  addDays,
  addMonths,
  isSameDay,
  monthGrid,
  startOfDay,
  startOfWeek,
  timeSlots,
  withTime,
  type WeekStart,
} from "./date-time-math";

export interface DateTimePickerProps {
  value: Date | null;
  onChange: (value: Date) => void;
  /** Earliest selectable moment. */
  min?: Date;
  /** "date" hides the time list. */
  mode?: "datetime" | "date";
  /** Minutes between time options. */
  timeStepMinutes?: number;
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStartsOn?: WeekStart;
  /** Time used when a date is picked before any time. Minutes after midnight. */
  defaultTimeMinutes?: number;
  /** Accessible name of the whole picker. */
  label?: string;
  className?: string;
}

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const WEEKDAY_SHORT = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
const WEEKDAY_LONG = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function gridKeyTarget(event: ReactKeyboardEvent, focused: Date, weekStartsOn: WeekStart) {
  switch (event.key) {
    case "ArrowLeft":
      return addDays(focused, -1);
    case "ArrowRight":
      return addDays(focused, 1);
    case "ArrowUp":
      return addDays(focused, -7);
    case "ArrowDown":
      return addDays(focused, 7);
    case "Home":
      return startOfWeek(focused, weekStartsOn);
    case "End":
      return addDays(startOfWeek(focused, weekStartsOn), 6);
    case "PageUp":
      return addMonths(focused, event.shiftKey ? -12 : -1);
    case "PageDown":
      return addMonths(focused, event.shiftKey ? 12 : 1);
    default:
      return null;
  }
}

export function DateTimePicker({
  value,
  onChange,
  min,
  mode = "datetime",
  timeStepMinutes = 30,
  weekStartsOn = 0,
  defaultTimeMinutes = 8 * 60,
  label = mode === "date" ? "Date" : "Date and time",
  className,
}: DateTimePickerProps) {
  const headingId = useId();
  const optionIdPrefix = useId();
  const [focused, setFocused] = useState(() => startOfDay(value ?? min ?? new Date()));
  const moveFocusRef = useRef(false);
  const gridRef = useRef<HTMLTableElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const today = startOfDay(new Date());
  const minDay = min ? startOfDay(min) : null;
  const weeks = useMemo(() => monthGrid(focused, weekStartsOn), [focused, weekStartsOn]);
  const slots = useMemo(() => timeSlots(timeStepMinutes), [timeStepMinutes]);
  const selectedMinutes = value ? value.getHours() * 60 + value.getMinutes() : null;

  useEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [focused]);

  useEffect(() => {
    // Centre the chosen time inside the list without scrolling the page.
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && active) {
      list.scrollTop = active.offsetTop - (list.clientHeight - active.offsetHeight) / 2;
    }
  }, [selectedMinutes]);

  const dayDisabled = (day: Date) => minDay !== null && day < minDay;
  const slotDisabled = (minutes: number) => {
    if (!min) return false;
    const day = value ?? focused;
    return withTime(day, minutes) < min;
  };

  const pickDay = (day: Date) => {
    if (dayDisabled(day)) return;
    setFocused(day);
    const minutes = selectedMinutes ?? defaultTimeMinutes;
    let next = withTime(day, mode === "date" ? 0 : minutes);
    if (min && mode === "datetime" && next < min) {
      const firstOpen = slots.find((slot) => withTime(day, slot) >= min);
      next = firstOpen === undefined ? next : withTime(day, firstOpen);
    }
    onChange(next);
  };

  const pickSlot = (minutes: number) => {
    if (slotDisabled(minutes)) return;
    onChange(withTime(value ?? focused, minutes));
  };

  const onGridKeyDown = (event: ReactKeyboardEvent) => {
    const target = gridKeyTarget(event, focused, weekStartsOn);
    if (!target) return;
    event.preventDefault();
    moveFocusRef.current = true;
    setFocused(target);
  };

  const onListKeyDown = (event: ReactKeyboardEvent) => {
    const enabled = slots.filter((slot) => !slotDisabled(slot));
    if (enabled.length === 0) return;
    const current = selectedMinutes === null ? -1 : enabled.indexOf(selectedMinutes);
    let index: number;
    switch (event.key) {
      case "ArrowDown":
        index = Math.min(enabled.length - 1, current + 1);
        break;
      case "ArrowUp":
        index = current === -1 ? 0 : Math.max(0, current - 1);
        break;
      case "Home":
        index = 0;
        break;
      case "End":
        index = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const minutes = enabled[index];
    if (minutes !== undefined) pickSlot(minutes);
  };

  const activeSlotId =
    selectedMinutes !== null && slots.includes(selectedMinutes)
      ? `${optionIdPrefix}-${selectedMinutes}`
      : undefined;

  return (
    <div
      role="group"
      aria-label={label}
      data-slot="date-time-picker"
      className={cn("flex flex-wrap gap-3", className)}
    >
      <div className="w-64">
        <div className="mb-1 flex items-center gap-1">
          <div id={headingId} aria-live="polite" className="flex-1 px-1 type-body-sm font-semibold">
            {MONTH.format(focused)}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous month"
            onClick={() => setFocused(addMonths(focused, -1))}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next month"
            onClick={() => setFocused(addMonths(focused, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
        <table
          ref={gridRef}
          role="grid"
          aria-labelledby={headingId}
          className="w-full border-collapse"
          onKeyDown={onGridKeyDown}
        >
          <thead>
            <tr>
              {weeks[0]?.map((day) => (
                <th
                  key={day.getDay()}
                  scope="col"
                  abbr={WEEKDAY_LONG.format(day)}
                  className="h-7 type-caption font-medium text-muted-foreground"
                >
                  {WEEKDAY_SHORT.format(day)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={week[0]?.toISOString()}>
                {week.map((day) => {
                  const selected = value !== null && isSameDay(day, value);
                  const isFocused = isSameDay(day, focused);
                  const outside = day.getMonth() !== focused.getMonth();
                  const disabled = dayDisabled(day);
                  return (
                    <td
                      key={day.toISOString()}
                      aria-selected={selected}
                      className="p-0 text-center"
                    >
                      <button
                        type="button"
                        tabIndex={isFocused ? 0 : -1}
                        aria-label={DAY_LABEL.format(day)}
                        aria-current={isSameDay(day, today) ? "date" : undefined}
                        aria-disabled={disabled || undefined}
                        onClick={() => pickDay(day)}
                        className={cn(
                          "mx-auto grid size-8 place-items-center rounded-full type-meta tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]",
                          outside ? "text-[var(--cal-outside-month-fg)]" : "text-foreground",
                          !selected && !disabled && "hover:bg-[var(--hover-strong)]",
                          isSameDay(day, today) && !selected && "font-semibold text-primary",
                          selected && "bg-primary font-semibold text-primary-foreground",
                          disabled && "cursor-not-allowed opacity-40",
                        )}
                      >
                        {day.getDate()}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mode === "datetime" ? (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Time"
          tabIndex={0}
          aria-activedescendant={activeSlotId}
          onKeyDown={onListKeyDown}
          className="relative h-48 w-full overflow-y-auto sm:h-64 sm:w-28 overscroll-contain rounded-[var(--radius)] border border-border py-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-color)]"
        >
          {slots.map((minutes) => {
            const selected = minutes === selectedMinutes;
            const disabled = slotDisabled(minutes);
            return (
              <div
                key={minutes}
                id={`${optionIdPrefix}-${minutes}`}
                role="option"
                aria-selected={selected}
                aria-disabled={disabled || undefined}
                onClick={() => pickSlot(minutes)}
                className={cn(
                  "cursor-default px-3 py-1 type-meta tabular-nums",
                  selected
                    ? "bg-[var(--accent-soft)] font-semibold text-primary"
                    : "hover:bg-[var(--hover)]",
                  disabled && "cursor-not-allowed opacity-40",
                )}
              >
                {TIME.format(withTime(focused, minutes))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
