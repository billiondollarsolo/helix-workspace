/* Audit log filters: date range, actor, event and outcome. Every filter runs
 * on the server across the whole log. */

import { CalendarDays as CalendarIcon } from "lucide-react";
import { useState } from "react";
import { PeoplePicker } from "@/components/people/people-picker";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PersonRef } from "@/features/people/person-ref";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import type { AuditOutcome } from "./audit-api";

type DatePreset = "any" | "24h" | "7d" | "30d" | "custom";

export interface AuditFilterState {
  readonly datePreset: DatePreset;
  /** Start of the first day, for a custom range. */
  readonly from: Date | null;
  /** Start of the last day, for a custom range (inclusive of that whole day). */
  readonly to: Date | null;
  readonly actor: PersonRef | null;
  readonly verb: string;
  readonly outcome: AuditOutcome | "any";
}

export const EMPTY_AUDIT_FILTERS: AuditFilterState = {
  datePreset: "any",
  from: null,
  to: null,
  actor: null,
  verb: "",
  outcome: "any",
};

const PRESET_HOURS: Record<Exclude<DatePreset, "any" | "custom">, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** The `since`/`until` ISO bounds a filter state asks the server for. */
export function auditDateBounds(
  state: AuditFilterState,
  now: Date = new Date(),
): { readonly since?: string; readonly until?: string } {
  if (state.datePreset === "any") {
    return {};
  }
  if (state.datePreset === "custom") {
    const until =
      state.to === null ? undefined : new Date(state.to.getTime() + 24 * 3_600_000).toISOString();
    return {
      ...(state.from === null ? {} : { since: state.from.toISOString() }),
      ...(until === undefined ? {} : { until }),
    };
  }
  return {
    since: new Date(now.getTime() - PRESET_HOURS[state.datePreset] * 3_600_000).toISOString(),
  };
}

export function isFiltered(state: AuditFilterState): boolean {
  return (
    state.datePreset !== "any" ||
    state.actor !== null ||
    state.verb.trim().length > 0 ||
    state.outcome !== "any"
  );
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function DayPicker({
  label,
  value,
  min,
  onChange,
}: {
  readonly label: string;
  readonly value: Date | null;
  readonly min?: Date;
  readonly onChange: (value: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${label}: ${value === null ? "not set" : DAY_FORMAT.format(value)}`}
        >
          <CalendarIcon aria-hidden="true" />
          {value === null ? label : DAY_FORMAT.format(value)}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={label} align="start">
        <DateTimePicker
          mode="date"
          label={label}
          value={value}
          {...(min === undefined ? {} : { min })}
          onChange={(next) => {
            onChange(startOfDay(next));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function AuditFilters({
  value,
  onChange,
  verbSuggestions,
}: {
  readonly value: AuditFilterState;
  readonly onChange: (next: AuditFilterState) => void;
  /** Event names seen on the loaded page, offered as suggestions. */
  readonly verbSuggestions: readonly string[];
}) {
  const [verbDraft, setVerbDraft] = useState(value.verb);
  const commitVerb = () => {
    if (verbDraft.trim() !== value.verb) onChange({ ...value, verb: verbDraft.trim() });
  };
  return (
    <div className="admin-audit-filters" role="group" aria-label="Audit log filters">
      <AdminField label="Date">
        <AdminSelect
          value={value.datePreset}
          onChange={(event) => onChange({ ...value, datePreset: event.target.value as DatePreset })}
        >
          <option value="any">Any time</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="custom">Custom range</option>
        </AdminSelect>
      </AdminField>
      {value.datePreset === "custom" ? (
        <div className="admin-audit-range" role="group" aria-label="Custom date range">
          <DayPicker
            label="From"
            value={value.from}
            onChange={(from) => onChange({ ...value, from })}
          />
          <span aria-hidden="true">–</span>
          <DayPicker
            label="To"
            value={value.to}
            {...(value.from === null ? {} : { min: value.from })}
            onChange={(to) => onChange({ ...value, to })}
          />
        </div>
      ) : null}
      <div className="admin-audit-actor">
        <PeoplePicker
          label="Actor"
          value={value.actor === null ? [] : [value.actor]}
          onChange={(people) => onChange({ ...value, actor: people.at(-1) ?? null })}
          max={1}
          placeholder="Anyone"
        />
      </div>
      <AdminField label="Event">
        <AdminInput
          value={verbDraft}
          list="audit-event-suggestions"
          placeholder="Any event"
          onChange={(event) => setVerbDraft(event.target.value)}
          onBlur={commitVerb}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitVerb();
            }
          }}
        />
      </AdminField>
      <datalist id="audit-event-suggestions">
        {verbSuggestions.map((verb) => (
          <option key={verb} value={verb} />
        ))}
      </datalist>
      <AdminField label="Outcome">
        <AdminSelect
          value={value.outcome}
          onChange={(event) =>
            onChange({ ...value, outcome: event.target.value as AuditOutcome | "any" })
          }
        >
          <option value="any">Any outcome</option>
          <option value="success">Succeeded</option>
          <option value="failure">Failed</option>
          <option value="denied">Denied</option>
        </AdminSelect>
      </AdminField>
      {isFiltered(value) ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-end"
          onClick={() => {
            setVerbDraft("");
            onChange(EMPTY_AUDIT_FILTERS);
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
