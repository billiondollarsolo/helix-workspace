/* Local-time calendar arithmetic for DateTimePicker. Everything works on
   local midnight so a DST change never shifts a day. */

export type WeekStart = 0 | 1 | 6;

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Same day-of-month in another month, clamped to that month's last day. */
export function addMonths(date: Date, months: number): Date {
  const firstOfTarget = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth() + 1, 0).getDate();
  return new Date(
    firstOfTarget.getFullYear(),
    firstOfTarget.getMonth(),
    Math.min(date.getDate(), lastDay),
  );
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfWeek(date: Date, weekStartsOn: WeekStart): Date {
  const offset = (date.getDay() - weekStartsOn + 7) % 7;
  return addDays(startOfDay(date), -offset);
}

/** Six full weeks covering the month that contains `date`. */
export function monthGrid(date: Date, weekStartsOn: WeekStart): Date[][] {
  const first = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1), weekStartsOn);
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(first, week * 7 + day)),
  );
}

/** Minutes after midnight for every slot in a day. */
export function timeSlots(stepMinutes: number): number[] {
  const step = Math.max(5, Math.min(60, Math.round(stepMinutes)));
  return Array.from({ length: Math.ceil((24 * 60) / step) }, (_, index) => index * step);
}

export function withTime(day: Date, minutesAfterMidnight: number): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minutesAfterMidnight / 60),
    minutesAfterMidnight % 60,
  );
}
