import { type CalendarTimeSemantics } from "@helix/contracts";
import { X as XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type CalendarSidebarEntry } from "./data";

/** Draft consumed by the create/edit dialog. */
export interface EventDraft {
  readonly mode: "create" | "edit";
  readonly eventId?: string;
  readonly calendarId: string | null;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly attendeeEmails: string;
  readonly recurrenceRule: string;
  readonly reminderMinutes: string;
  readonly metadata: Record<string, unknown>;
  /** ISO date `yyyy-mm-dd`. */
  readonly date: string;
  /** Decimal hour. */
  readonly start: number;
  /** Decimal hour. */
  readonly end: number;
  readonly timezone: string;
  readonly allDay: boolean;
  readonly timeSemantics: CalendarTimeSemantics;
}

/* --------------------------------------------------------------- event dialog */

export function CalendarEventDialog({
  draft,
  calendars,
  pending,
  onSubmit,
  onClose,
}: {
  readonly draft: EventDraft;
  readonly calendars: readonly CalendarSidebarEntry[];
  readonly pending: boolean;
  readonly onSubmit: (draft: EventDraft) => void;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState<EventDraft>(draft);
  const writableCalendars = calendars.filter((calendar) => calendar.writable);
  const timeZones = useMemo(() => supportedTimeZones(value.timezone), [value.timezone]);

  useEffect(() => {
    const handleKeydown = (domEvent: KeyboardEvent) => {
      if (domEvent.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [onClose]);

  const attendeesValid =
    attendeeInputs(value.attendeeEmails).length === splitAttendees(value.attendeeEmails).length;
  const reminder = Number(value.reminderMinutes);
  const reminderValid =
    value.reminderMinutes === "" ||
    (Number.isInteger(reminder) && reminder >= 0 && reminder <= 40_320);
  const valid =
    value.title.trim().length > 0 &&
    (value.allDay || value.end > value.start) &&
    attendeesValid &&
    reminderValid;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={draft.mode === "create" ? "Create event" : "Edit event"}
      data-calendar-dialog
      className="fixed inset-0 [background:rgba(0,_0,_0,_0.35)] grid [place-items:center] [z-index:200]"
      onMouseDown={(domEvent) => {
        if (domEvent.target === domEvent.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        onSubmit={(domEvent) => {
          domEvent.preventDefault();
          if (valid && !pending) {
            onSubmit(value);
          }
        }}
        className="w-95 bg-card [border:1px_solid_var(--border)] [border-radius:12px] [box-shadow:var(--shadow-lg)] p-4 flex flex-col gap-2.5"
      >
        <div className="flex items-center">
          <span className="[font-size:var(--text-body-lg)] font-semibold">
            {draft.mode === "create" ? "Create event" : "Edit event"}
          </span>
          <button aria-label="Close" className="icon-btn ml-auto" type="button" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>

        <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
          <span>Title</span>
          <input
            autoFocus
            value={value.title}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, title: domEvent.target.value }))
            }
            placeholder="Event title"
            className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            type="text"
          />
        </label>

        <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
          <span>Attendees</span>
          <input
            value={value.attendeeEmails}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, attendeeEmails: domEvent.target.value }))
            }
            placeholder="name@example.com, teammate@example.com"
            className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            type="text"
            aria-invalid={!attendeesValid}
          />
        </label>

        <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
          <span>Repeat rule</span>
          <input
            value={value.recurrenceRule}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, recurrenceRule: domEvent.target.value }))
            }
            placeholder="FREQ=WEEKLY;BYDAY=MO"
            className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            type="text"
          />
        </label>

        <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
          <span>Reminder (minutes before)</span>
          <input
            value={value.reminderMinutes}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, reminderMinutes: domEvent.target.value }))
            }
            min="0"
            max="40320"
            className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            type="number"
          />
        </label>

        <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
          <span>Date</span>
          <input
            value={value.date}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, date: domEvent.target.value }))
            }
            className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            type="date"
          />
        </label>

        <label className="flex gap-1.5 items-center [font-size:var(--text-meta)]">
          <input
            checked={value.allDay}
            onChange={(domEvent) =>
              setValue((current) => ({
                ...current,
                allDay: domEvent.target.checked,
                timeSemantics: domEvent.target.checked ? "all_day" : "zoned",
              }))
            }
            type="checkbox"
          />
          <span>All day</span>
        </label>

        {!value.allDay && (
          <div className="flex gap-2">
            <label className="flex flex-col gap-1 [font-size:var(--text-meta)] flex-1">
              <span>Start</span>
              <input
                value={decimalHourToClock(value.start)}
                onChange={(domEvent) =>
                  setValue((current) => ({
                    ...current,
                    start: clockToDecimalHour(domEvent.target.value, current.start),
                  }))
                }
                className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
                type="time"
              />
            </label>
            <label className="flex flex-col gap-1 [font-size:var(--text-meta)] flex-1">
              <span>End</span>
              <input
                value={decimalHourToClock(value.end)}
                onChange={(domEvent) =>
                  setValue((current) => ({
                    ...current,
                    end: clockToDecimalHour(domEvent.target.value, current.end),
                  }))
                }
                className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
                type="time"
              />
            </label>
          </div>
        )}

        {!value.allDay && (
          <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
            <span>Time behavior</span>
            <select
              value={value.timeSemantics}
              onChange={(domEvent) =>
                setValue((current) => ({
                  ...current,
                  timeSemantics: domEvent.target.value as "zoned" | "floating",
                }))
              }
              className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            >
              <option value="zoned">Fixed time zone</option>
              <option value="floating">Floating (same local time)</option>
            </select>
          </label>
        )}

        {value.timeSemantics === "zoned" && (
          <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
            <span>Time zone</span>
            <select
              value={value.timezone}
              onChange={(domEvent) =>
                setValue((current) => ({ ...current, timezone: domEvent.target.value }))
              }
              className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            >
              {timeZones.map((timeZone) => (
                <option key={timeZone} value={timeZone}>
                  {timeZone}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
          <span>Location</span>
          <input
            value={value.location}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, location: domEvent.target.value }))
            }
            placeholder="Optional"
            className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            type="text"
          />
        </label>

        {writableCalendars.length > 0 && (
          <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
            <span>Calendar</span>
            <select
              value={value.calendarId ?? ""}
              onChange={(domEvent) =>
                setValue((current) => ({
                  ...current,
                  calendarId: domEvent.target.value === "" ? null : domEvent.target.value,
                  ...(current.mode === "create"
                    ? {
                        timezone:
                          writableCalendars.find(
                            (calendar) => calendar.id === domEvent.target.value,
                          )?.timezone ?? current.timezone,
                      }
                    : {}),
                }))
              }
              className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none"
            >
              {writableCalendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 [font-size:var(--text-meta)]">
          <span>Description</span>
          <textarea
            value={value.description}
            onChange={(domEvent) =>
              setValue((current) => ({ ...current, description: domEvent.target.value }))
            }
            rows={3}
            className="[border:1px_solid_var(--border)] rounded-md bg-muted text-foreground [padding:6px_8px] [font-size:var(--text-meta)] outline-none [resize:vertical]"
          />
        </label>

        <div className="flex gap-2 mt-1">
          <button className="btn sm flex-1" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn sm primary flex-1" type="submit" disabled={!valid || pending}>
            {pending ? "Saving..." : draft.mode === "create" ? "Create" : "Save changes"}
          </button>
        </div>
      </form>
    </div>
  );
}

function splitAttendees(value: string): readonly string[] {
  return value
    .split(/[;,]/u)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function attendeeInputs(value: string) {
  return splitAttendees(value)
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
    .map((email) => ({ email }));
}

export function calendarReminderMinutes(metadata: Record<string, unknown> | undefined): string {
  const alarms = metadata?.alarms;
  if (!Array.isArray(alarms)) return "";
  const alarm = alarms.find(
    (value): value is { readonly minutesBefore: number } =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { readonly minutesBefore?: unknown }).minutesBefore === "number",
  );
  return alarm === undefined ? "" : String(alarm.minutesBefore);
}

export function calendarReminderMetadata(
  value: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  if (value === "") return { ...metadata, alarms: [] };
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 40_320
    ? { ...metadata, alarms: [{ minutesBefore: minutes }] }
    : metadata;
}

function supportedTimeZones(selected: string): readonly string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  const zones = intl.supportedValuesOf?.("timeZone") ?? ["UTC"];
  return zones.includes(selected) ? zones : [selected, ...zones];
}

/** Decimal hour -> `HH:MM` 24h clock string, e.g. 13.5 -> "13:30". */
export function decimalHourToClock(decimalHour: number): string {
  const clamped = Math.max(0, Math.min(23.999, decimalHour));
  const hour = Math.floor(clamped);
  const minutes = Math.round((clamped - hour) * 60);
  return `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** `HH:MM` 24h clock string -> decimal hour; falls back when unparseable. */
export function clockToDecimalHour(clock: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (match === null) {
    return fallback;
  }
  const hour = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hour) || Number.isNaN(minutes)) {
    return fallback;
  }
  return hour + minutes / 60;
}
