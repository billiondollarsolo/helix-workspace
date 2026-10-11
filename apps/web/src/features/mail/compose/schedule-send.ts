/* Schedule-send presets: Tomorrow morning, Tomorrow afternoon, Monday
   morning. Times are wall-clock times in the person's time zone
   (account preferences), starting at their working hours on that day. */

import {
  instantToLocalDateTime,
  localDateTimeToInstant,
  type AccountPreferences,
} from "@helix/contracts";

export interface ScheduleSendPreset {
  readonly id: "tomorrow-morning" | "tomorrow-afternoon" | "monday-morning";
  readonly label: string;
  readonly at: Date;
}

type SchedulePreferences = Pick<AccountPreferences, "timeZone" | "workingHours">;

const DEFAULT_MORNING = "08:00";
const AFTERNOON = "13:00";

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `YYYY-MM-DD` plus `days`, using UTC date math so DST never shifts the day. */
function addDaysToDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function workingDay(preferences: SchedulePreferences | undefined, day: number) {
  const hours = preferences?.workingHours;
  if (hours?.enabled !== true) return null;
  return hours.days.find((entry) => entry.day === day) ?? null;
}

function morningTime(preferences: SchedulePreferences | undefined, day: number): string {
  return workingDay(preferences, day)?.start ?? DEFAULT_MORNING;
}

function afternoonTime(preferences: SchedulePreferences | undefined, day: number): string {
  const hours = workingDay(preferences, day);
  if (hours === null) return AFTERNOON;
  // A day that starts after 1 PM, or ends before it, schedules at its start.
  return hours.start <= AFTERNOON && hours.end > AFTERNOON ? AFTERNOON : hours.start;
}

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** `Tue, Oct 13, 8:00 AM` in the person's zone. */
export function formatScheduleTime(at: Date, timeZone?: string | null): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...TIME_FORMAT,
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

export function scheduleSendPresets(
  now: Date,
  preferences?: SchedulePreferences,
): readonly ScheduleSendPreset[] {
  const zone = preferences?.timeZone ?? browserTimeZone();
  const today = instantToLocalDateTime(now, zone).slice(0, 10);
  const tomorrow = addDaysToDate(today, 1);
  const tomorrowDay = weekday(tomorrow);
  const daysToMonday = (1 - weekday(today) + 7) % 7 || 7;
  const monday = addDaysToDate(today, daysToMonday);
  const at = (date: string, time: string) => localDateTimeToInstant(`${date}T${time}:00`, zone);
  const presets: ScheduleSendPreset[] = [
    {
      id: "tomorrow-morning",
      label: "Tomorrow morning",
      at: at(tomorrow, morningTime(preferences, tomorrowDay)),
    },
    {
      id: "tomorrow-afternoon",
      label: "Tomorrow afternoon",
      at: at(tomorrow, afternoonTime(preferences, tomorrowDay)),
    },
  ];
  if (monday !== tomorrow) {
    presets.push({
      id: "monday-morning",
      label: "Monday morning",
      at: at(monday, morningTime(preferences, 1)),
    });
  }
  return presets;
}
