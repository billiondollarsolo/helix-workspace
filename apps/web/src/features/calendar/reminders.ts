/* Event notifications as "number + unit before", stored as minutes in
   `metadata.alarms` (the backend reminder worker reads `minutesBefore`). */

export type ReminderUnit = "minutes" | "hours" | "days" | "weeks";

export interface Reminder {
  readonly amount: number;
  readonly unit: ReminderUnit;
}

export const REMINDER_UNITS: readonly ReminderUnit[] = ["minutes", "hours", "days", "weeks"];

const MINUTES_PER: Readonly<Record<ReminderUnit, number>> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10_080,
};

/** The backend accepts reminders up to four weeks ahead. */
export const MAX_REMINDER_MINUTES = 40_320;

export const DEFAULT_REMINDER: Reminder = { amount: 10, unit: "minutes" };

export function reminderToMinutes(reminder: Reminder): number {
  return reminder.amount * MINUTES_PER[reminder.unit];
}

/** The largest unit that represents `minutes` exactly, e.g. 120 → 2 hours. */
export function reminderFromMinutes(minutes: number): Reminder {
  for (const unit of ["weeks", "days", "hours"] as const) {
    if (minutes > 0 && minutes % MINUTES_PER[unit] === 0) {
      return { amount: minutes / MINUTES_PER[unit], unit };
    }
  }
  return { amount: minutes, unit: "minutes" };
}

export function isReminderValid(reminder: Reminder): boolean {
  const minutes = reminderToMinutes(reminder);
  return Number.isInteger(reminder.amount) && minutes >= 0 && minutes <= MAX_REMINDER_MINUTES;
}

/** "10 minutes before", "1 day before" */
export function describeReminder(reminder: Reminder): string {
  const unit = reminder.amount === 1 ? reminder.unit.slice(0, -1) : reminder.unit;
  return `${String(reminder.amount)} ${unit} before`;
}

/** First stored reminder, if any. */
export function reminderFromMetadata(
  metadata: Record<string, unknown> | undefined,
): Reminder | null {
  const alarms = metadata?.alarms;
  if (!Array.isArray(alarms)) return null;
  for (const alarm of alarms as unknown[]) {
    if (typeof alarm === "object" && alarm !== null && "minutesBefore" in alarm) {
      const minutes = alarm.minutesBefore;
      if (typeof minutes === "number") return reminderFromMinutes(minutes);
    }
  }
  return null;
}

export function metadataWithReminder(
  metadata: Record<string, unknown>,
  reminder: Reminder | null,
): Record<string, unknown> {
  return {
    ...metadata,
    alarms: reminder === null ? [] : [{ minutesBefore: reminderToMinutes(reminder) }],
  };
}
