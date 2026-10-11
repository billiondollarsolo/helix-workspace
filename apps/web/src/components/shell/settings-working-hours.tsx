/* Working hours: which weekdays you work and one start/end time for them. */

import type { AccountWorkingHours } from "@helix/contracts";
import { useId, useState, type FormEvent } from "react";

const DAYS = [
  { day: 1, short: "Mon", label: "Monday" },
  { day: 2, short: "Tue", label: "Tuesday" },
  { day: 3, short: "Wed", label: "Wednesday" },
  { day: 4, short: "Thu", label: "Thursday" },
  { day: 5, short: "Fri", label: "Friday" },
  { day: 6, short: "Sat", label: "Saturday" },
  { day: 0, short: "Sun", label: "Sunday" },
] as const;

interface Draft {
  readonly enabled: boolean;
  readonly days: readonly number[];
  readonly start: string;
  readonly end: string;
}

function draftFrom(value: AccountWorkingHours | null): Draft {
  const first = value?.days[0];
  return {
    enabled: value?.enabled ?? false,
    days:
      value === null || value.days.length === 0 ? [1, 2, 3, 4, 5] : value.days.map((d) => d.day),
    start: first?.start ?? "09:00",
    end: first?.end ?? "17:00",
  };
}

/** The saved shape: every chosen day shares the start and end time. */
export function workingHoursFromDraft(draft: Draft): AccountWorkingHours {
  return {
    enabled: draft.enabled,
    days: [...draft.days]
      .sort((left, right) => left - right)
      .map((day) => ({ day, start: draft.start, end: draft.end })),
  };
}

export function WorkingHoursEditor({
  value,
  pending,
  onSave,
}: {
  readonly value: AccountWorkingHours | null;
  readonly pending: boolean;
  readonly onSave: (value: AccountWorkingHours) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(value));
  const [error, setError] = useState<string | null>(null);
  const ids = { start: useId(), end: useId(), error: useId() };
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.enabled && draft.days.length === 0) {
      setError("Choose at least one working day.");
      return;
    }
    if (draft.enabled && draft.start >= draft.end) {
      setError("Working hours must end after they start.");
      return;
    }
    onSave(workingHoursFromDraft(draft));
  };

  const describedBy = error === null ? undefined : ids.error;
  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <label className="flex items-center gap-2 type-body-sm font-medium">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
          className="focus-ring accent-[var(--accent)]"
        />
        Show my working hours
      </label>
      <fieldset
        disabled={!draft.enabled}
        className="m-0 grid gap-4 border-0 p-0 disabled:opacity-60"
      >
        <legend className="sr-only">Working hours</legend>
        <fieldset className="m-0 border-0 p-0" aria-describedby={describedBy}>
          <legend className="mb-2 p-0 type-body-sm font-medium">Working days</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map(({ day, short, label }) => {
              const checked = draft.days.includes(day);
              return (
                <label
                  key={day}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border [padding:4px_12px] type-body-sm has-checked:[background:var(--accent-soft)] has-checked:[border-color:var(--accent)]"
                >
                  <input
                    type="checkbox"
                    aria-label={label}
                    checked={checked}
                    onChange={() =>
                      update({
                        days: checked ? draft.days.filter((d) => d !== day) : [...draft.days, day],
                      })
                    }
                    className="focus-ring accent-[var(--accent)]"
                  />
                  <span aria-hidden="true">{short}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <label htmlFor={ids.start} className="type-body-sm font-medium">
              Start
            </label>
            <input
              id={ids.start}
              type="time"
              className="input w-32"
              value={draft.start}
              aria-describedby={describedBy}
              aria-invalid={error === null ? undefined : true}
              onChange={(event) => update({ start: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor={ids.end} className="type-body-sm font-medium">
              End
            </label>
            <input
              id={ids.end}
              type="time"
              className="input w-32"
              value={draft.end}
              aria-describedby={describedBy}
              aria-invalid={error === null ? undefined : true}
              onChange={(event) => update({ end: event.target.value })}
            />
          </div>
        </div>
      </fieldset>
      {error === null ? null : (
        <p id={ids.error} role="alert" className="m-0 type-body-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn primary sm" disabled={pending}>
          Save working hours
        </button>
      </div>
    </form>
  );
}
