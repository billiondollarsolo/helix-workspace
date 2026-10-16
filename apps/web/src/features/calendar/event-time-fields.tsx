/* Date, time, all-day, time zone and repeat fields of the event editor. */

import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  addIsoDays,
  formatShortDate,
  formatTime,
  isoDayDiff,
  pickerWeekStart,
  type WeekStartDay,
} from "./date-math";
import type { EventDraft } from "./event-draft";
import { useTimeFormat } from "./preferences";
import { RecurrenceField } from "./recurrence-field";

const SLOTS = Array.from({ length: 96 }, (_, index) => index / 4);

function durationText(hours: number): string {
  if (hours < 1) return `${String(Math.round(hours * 60))} mins`;
  const rounded = Math.round(hours * 100) / 100;
  return `${String(rounded)} ${rounded === 1 ? "hr" : "hrs"}`;
}

function isoToLocalDate(iso: string): Date {
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function localDateToIso(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function supportedTimeZones(selected: string): readonly string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  const zones = intl.supportedValuesOf?.("timeZone") ?? ["UTC"];
  return zones.includes(selected) ? zones : [selected, ...zones];
}

/** Moving the start keeps the event's length, like most calendars. */
export function withStart(draft: EventDraft, date: string, time: number): EventDraft {
  const days = isoDayDiff(draft.startDate, date);
  const length = draft.allDay ? 0 : draft.endTime - draft.startTime;
  let endDate = addIsoDays(draft.endDate, days);
  let endTime = draft.endTime;
  if (!draft.allDay && draft.startDate === draft.endDate) {
    const end = time + length;
    endTime = end >= 24 ? end - 24 : end;
    endDate = end >= 24 ? addIsoDays(date, 1) : date;
  }
  return { ...draft, startDate: date, startTime: time, endDate, endTime };
}

function withAllDay(draft: EventDraft, allDay: boolean): EventDraft {
  if (allDay) {
    const endsAtMidnight = draft.endTime === 0 && draft.endDate > draft.startDate;
    return {
      ...draft,
      allDay,
      endDate: endsAtMidnight ? addIsoDays(draft.endDate, -1) : draft.endDate,
    };
  }
  const empty = draft.startDate === draft.endDate && draft.endTime <= draft.startTime;
  return {
    ...draft,
    allDay,
    endTime: empty ? Math.min(23.75, draft.startTime + 1) : draft.endTime,
  };
}

function DateButton({
  label,
  value,
  weekStartsOn,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly weekStartsOn: WeekStartDay;
  readonly onChange: (iso: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${label}: ${formatShortDate(value)}`}
        >
          {formatShortDate(value)}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={label} className="w-auto">
        <DateTimePicker
          mode="date"
          label={label}
          value={isoToLocalDate(value)}
          weekStartsOn={pickerWeekStart(weekStartsOn)}
          onChange={(date) => {
            onChange(localDateToIso(date));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function EventTimeFields({
  draft,
  weekStartsOn,
  onChange,
}: {
  readonly draft: EventDraft;
  readonly weekStartsOn: WeekStartDay;
  readonly onChange: (draft: EventDraft) => void;
}) {
  const ids = useId();
  const format = useTimeFormat();
  const zones = useMemo(() => supportedTimeZones(draft.timeZone), [draft.timeZone]);
  const sameDay = draft.startDate === draft.endDate;
  const endSlots = sameDay ? SLOTS.filter((slot) => slot > draft.startTime) : SLOTS;

  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-3">
      <legend className="sr-only">Date and time</legend>
      <div className="flex flex-wrap items-center gap-2">
        <DateButton
          label="Start date"
          value={draft.startDate}
          weekStartsOn={weekStartsOn}
          onChange={(date) => onChange(withStart(draft, date, draft.startTime))}
        />
        {!draft.allDay ? (
          <>
            <label htmlFor={`${ids}-start`} className="sr-only">
              Start time
            </label>
            <select
              id={`${ids}-start`}
              className="input type-body-sm"
              value={String(draft.startTime)}
              onChange={(event) =>
                onChange(withStart(draft, draft.startDate, Number(event.target.value)))
              }
            >
              {SLOTS.map((slot) => (
                <option key={slot} value={String(slot)}>
                  {formatTime(slot, format)}
                </option>
              ))}
            </select>
            <span aria-hidden="true">–</span>
            <label htmlFor={`${ids}-end`} className="sr-only">
              End time
            </label>
            <select
              id={`${ids}-end`}
              className="input type-body-sm"
              value={String(draft.endTime)}
              onChange={(event) => onChange({ ...draft, endTime: Number(event.target.value) })}
            >
              {!endSlots.includes(draft.endTime) ? (
                <option value={String(draft.endTime)}>{formatTime(draft.endTime, format)}</option>
              ) : null}
              {endSlots.map((slot) => (
                <option key={slot} value={String(slot)}>
                  {sameDay
                    ? `${formatTime(slot, format)} (${durationText(slot - draft.startTime)})`
                    : formatTime(slot, format)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span aria-hidden="true">–</span>
        )}
        <DateButton
          label="End date"
          value={draft.endDate}
          weekStartsOn={weekStartsOn}
          onChange={(date) =>
            onChange({ ...draft, endDate: date < draft.startDate ? draft.startDate : date })
          }
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 type-body-sm">
          <input
            type="checkbox"
            checked={draft.allDay}
            onChange={(event) => onChange(withAllDay(draft, event.target.checked))}
          />
          All day
        </label>
        {!draft.allDay ? (
          <label className="flex items-center gap-2 type-body-sm">
            Time zone
            <select
              className="input type-body-sm max-w-56"
              value={draft.timeZone}
              onChange={(event) => onChange({ ...draft, timeZone: event.target.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="flex items-center gap-1">
          <RecurrenceField
            rule={draft.recurrence}
            preservedRule={draft.preservedRule}
            startDate={draft.startDate}
            onChange={(recurrence) => onChange({ ...draft, recurrence, preservedRule: null })}
          />
        </div>
      </div>
    </fieldset>
  );
}
