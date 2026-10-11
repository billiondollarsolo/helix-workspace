/* Repeat picker: the common choices in a select, plus a "Custom…" dialog for
   an interval, weekdays and an end. The RRULE is generated behind the scenes. */

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/helix-dialog";
import { addIsoMonths } from "./date-math";
import {
  describeRecurrence,
  presetForRule,
  presetLabels,
  ruleForPreset,
  WEEKDAY_CODES,
  WEEKDAY_NAMES,
  type RecurrenceFrequency,
  type RecurrencePreset,
  type RecurrenceRule,
} from "./recurrence";

const PRESETS: readonly RecurrencePreset[] = [
  "none",
  "daily",
  "weekly",
  "monthly",
  "annually",
  "weekdays",
  "custom",
];

export function RecurrenceField({
  rule,
  preservedRule,
  startDate,
  onChange,
}: {
  readonly rule: RecurrenceRule | null;
  readonly preservedRule: string | null;
  readonly startDate: string;
  readonly onChange: (rule: RecurrenceRule | null) => void;
}) {
  const id = useId();
  const [customOpen, setCustomOpen] = useState(false);
  const labels = presetLabels(startDate);
  const preset =
    preservedRule !== null && rule === null ? "custom" : presetForRule(rule, startDate);
  const customLabel =
    preset === "custom"
      ? rule !== null
        ? describeRecurrence(rule, startDate)
        : "Custom schedule (kept as is)"
      : labels.custom;

  return (
    <>
      <label htmlFor={id} className="sr-only">
        Repeat
      </label>
      <select
        id={id}
        className="cal-field type-body-sm"
        value={preset}
        onChange={(event) => {
          const next = PRESETS.find((candidate) => candidate === event.target.value) ?? "none";
          if (next === "custom") {
            setCustomOpen(true);
            return;
          }
          onChange(ruleForPreset(next, startDate));
        }}
      >
        {PRESETS.map((option) => (
          <option key={option} value={option}>
            {option === "custom" ? customLabel : labels[option]}
          </option>
        ))}
      </select>
      {preset === "custom" ? (
        <Button type="button" variant="link" size="sm" onClick={() => setCustomOpen(true)}>
          Edit repeat
        </Button>
      ) : null}
      {customOpen ? (
        <CustomRecurrenceDialog
          initial={
            rule ?? {
              frequency: "WEEKLY",
              interval: 1,
              weekdays: [],
              end: { kind: "never" },
            }
          }
          startDate={startDate}
          onCancel={() => setCustomOpen(false)}
          onDone={(next) => {
            setCustomOpen(false);
            onChange(next);
          }}
        />
      ) : null}
    </>
  );
}

const UNIT_LABELS: Readonly<Record<RecurrenceFrequency, readonly [string, string]>> = {
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};

function CustomRecurrenceDialog({
  initial,
  startDate,
  onCancel,
  onDone,
}: {
  readonly initial: RecurrenceRule;
  readonly startDate: string;
  readonly onCancel: () => void;
  readonly onDone: (rule: RecurrenceRule) => void;
}) {
  const ids = useId();
  const weekdayFallback = WEEKDAY_CODES[new Date(`${startDate}T00:00:00Z`).getUTCDay()] ?? "MO";
  const [frequency, setFrequency] = useState(initial.frequency);
  const [interval, setIntervalText] = useState(String(initial.interval));
  const [weekdays, setWeekdays] = useState(
    initial.weekdays.length > 0 ? [...initial.weekdays] : [weekdayFallback],
  );
  const [endKind, setEndKind] = useState(initial.end.kind);
  const [until, setUntil] = useState(
    initial.end.kind === "on" ? initial.end.until : addIsoMonths(startDate, 3),
  );
  const [count, setCount] = useState(String(initial.end.kind === "after" ? initial.end.count : 13));
  const intervalValue = Number(interval);
  const countValue = Number(count);
  const valid =
    Number.isInteger(intervalValue) &&
    intervalValue >= 1 &&
    intervalValue <= 99 &&
    (frequency !== "WEEKLY" || weekdays.length > 0) &&
    (endKind !== "after" ||
      (Number.isInteger(countValue) && countValue >= 1 && countValue <= 730)) &&
    (endKind !== "on" || until >= startDate);
  const rule: RecurrenceRule = {
    frequency,
    interval: valid ? intervalValue : 1,
    weekdays: frequency === "WEEKLY" ? weekdays : [],
    end:
      endKind === "on"
        ? { kind: "on", until }
        : endKind === "after"
          ? { kind: "after", count: valid ? countValue : 1 }
          : { kind: "never" },
  };

  return (
    <Dialog
      title="Custom repeat"
      onClose={onCancel}
      width="min(400px, calc(100vw - 32px))"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={!valid} onClick={() => onDone(rule)}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 type-body-sm">
        <fieldset className="m-0 p-0 border-0 flex items-center gap-2 flex-wrap">
          <legend className="mb-1.5 font-medium">Repeat every</legend>
          <input
            aria-label="Interval"
            type="number"
            min={1}
            max={99}
            className="cal-field w-16"
            value={interval}
            onChange={(event) => setIntervalText(event.target.value)}
          />
          <select
            aria-label="Unit"
            className="cal-field"
            value={frequency}
            onChange={(event) => {
              const next = (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).find(
                (candidate) => candidate === event.target.value,
              );
              if (next !== undefined) setFrequency(next);
            }}
          >
            {(Object.keys(UNIT_LABELS) as RecurrenceFrequency[]).map((option) => (
              <option key={option} value={option}>
                {UNIT_LABELS[option][intervalValue === 1 ? 0 : 1]}
              </option>
            ))}
          </select>
        </fieldset>

        {frequency === "WEEKLY" ? (
          <fieldset className="m-0 p-0 border-0">
            <legend className="mb-1.5 font-medium">Repeat on</legend>
            <div className="flex gap-1">
              {WEEKDAY_CODES.map((code, index) => {
                const pressed = weekdays.includes(code);
                return (
                  <Button
                    key={code}
                    type="button"
                    size="icon-xs"
                    variant={pressed ? "default" : "outline"}
                    className="rounded-full"
                    aria-pressed={pressed}
                    aria-label={WEEKDAY_NAMES[index]}
                    onClick={() =>
                      setWeekdays((current) =>
                        pressed ? current.filter((day) => day !== code) : [...current, code],
                      )
                    }
                  >
                    {(WEEKDAY_NAMES[index] ?? "").charAt(0)}
                  </Button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
          <legend className="mb-1.5 font-medium">Ends</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={`${ids}-end`}
              checked={endKind === "never"}
              onChange={() => setEndKind("never")}
            />
            Never
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 w-16">
              <input
                type="radio"
                name={`${ids}-end`}
                checked={endKind === "on"}
                onChange={() => setEndKind("on")}
              />
              On
            </label>
            <input
              aria-label="End date"
              type="date"
              className="cal-field"
              min={startDate}
              value={until}
              disabled={endKind !== "on"}
              onChange={(event) => setUntil(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 w-16">
              <input
                type="radio"
                name={`${ids}-end`}
                checked={endKind === "after"}
                onChange={() => setEndKind("after")}
              />
              After
            </label>
            <input
              aria-label="Number of occurrences"
              type="number"
              min={1}
              max={730}
              className="cal-field w-20"
              value={count}
              disabled={endKind !== "after"}
              onChange={(event) => setCount(event.target.value)}
            />
            <span>occurrences</span>
          </div>
        </fieldset>
        <p className="m-0 text-muted-foreground" aria-live="polite">
          {valid ? describeRecurrence(rule, startDate) : "Check the highlighted values."}
        </p>
      </div>
    </Dialog>
  );
}
