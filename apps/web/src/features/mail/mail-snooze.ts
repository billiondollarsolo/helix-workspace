/* Snooze presets: Later today, Tomorrow, This weekend, Next week. Times
   follow the person's working hours when they set them (account
   preferences): mornings start when the working day starts and "later
   today" is the end of today's working day. Without them, 8:00 and 18:00. */

import type { AccountWorkingHours } from "@helix/contracts";

type SnoozePresetId = "later-today" | "tomorrow" | "weekend" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** e.g. "6:00 PM" or "Sat 8:00 AM". */
  readonly detail: string;
  readonly until: Date;
}

const DEFAULT_MORNING = 8 * 60;
const DEFAULT_EVENING = 18 * 60;
/** "Later today" needs at least this much of the day left to be worth offering. */
const MIN_LATER_TODAY_MS = 60 * 60 * 1000;

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
}

function workingDay(hours: AccountWorkingHours | null, day: number) {
  return hours?.enabled === true ? hours.days.find((entry) => entry.day === day) : undefined;
}

/** Start of the working day for that weekday; the earliest start on days off. */
function morningMinutes(hours: AccountWorkingHours | null, day: number): number {
  const today = workingDay(hours, day);
  if (today !== undefined) return minutes(today.start);
  if (hours?.enabled === true && hours.days.length > 0) {
    return Math.min(...hours.days.map((entry) => minutes(entry.start)));
  }
  return DEFAULT_MORNING;
}

function at(date: Date, dayOffset: number, minutesOfDay: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + dayOffset);
  next.setHours(Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0);
  return next;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function snoozePresets(
  now: Date,
  workingHours: AccountWorkingHours | null = null,
): readonly SnoozePreset[] {
  const presets: SnoozePreset[] = [];
  const weekday = now.getDay();
  const todayHours = workingDay(workingHours, weekday);
  const evening = at(now, 0, todayHours === undefined ? DEFAULT_EVENING : minutes(todayHours.end));
  if (evening.getTime() - now.getTime() >= MIN_LATER_TODAY_MS) {
    presets.push({
      id: "later-today",
      label: "Later today",
      detail: TIME.format(evening),
      until: evening,
    });
  }
  const tomorrow = at(now, 1, morningMinutes(workingHours, (weekday + 1) % 7));
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    detail: DAY_TIME.format(tomorrow),
    until: tomorrow,
  });
  // Saturday, offered on weekdays only.
  if (weekday >= 1 && weekday <= 5) {
    const weekend = at(now, 6 - weekday, morningMinutes(workingHours, 6));
    presets.push({
      id: "weekend",
      label: "This weekend",
      detail: DAY_TIME.format(weekend),
      until: weekend,
    });
  }
  const daysToMonday = (8 - weekday) % 7 || 7;
  const nextWeek = at(now, daysToMonday, morningMinutes(workingHours, 1));
  if (nextWeek.getTime() === tomorrow.getTime()) return presets;
  presets.push({
    id: "next-week",
    label: "Next week",
    detail: DAY_TIME.format(nextWeek),
    until: nextWeek,
  });
  return presets;
}

/** Default time for a picked date: the start of the working day. */
export function snoozeDefaultTimeMinutes(workingHours: AccountWorkingHours | null): number {
  return morningMinutes(workingHours, 1);
}
