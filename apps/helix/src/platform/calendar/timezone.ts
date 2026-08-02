/**
 * Pure timezone helpers for Calendar (CAL.7).
 *
 * Wall-clock local → UTC conversion uses iterative offset correction via
 * `Intl.DateTimeFormat` so DST transitions are handled without external libs.
 */

export interface ZonedDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** Convert a local civil datetime in `timeZone` to a UTC `Date`. */
export function zonedLocalDateToUtc(input: ZonedDateParts, timeZone: string): Date {
  let date = new Date(
    Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = utcToZonedParts(date, timeZone);
    if (local === null) {
      return new Date(Number.NaN);
    }
    const wantedUtc = Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour,
      input.minute,
      input.second,
    );
    const actualUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const delta = wantedUtc - actualUtc;
    if (delta === 0) {
      return date;
    }
    date = new Date(date.getTime() + delta);
  }
  return date;
}

/** Project a UTC instant into civil parts for `timeZone`. */
export function utcToZonedParts(date: Date, timeZone: string): ZonedDateParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
    const numberPart = (type: Intl.DateTimeFormatPartTypes): number | null => {
      const value = parts.find((candidate) => candidate.type === type)?.value;
      return value === undefined ? null : Number(value);
    };
    const year = numberPart("year");
    const month = numberPart("month");
    const day = numberPart("day");
    const hour = numberPart("hour");
    const minute = numberPart("minute");
    const second = numberPart("second");
    if (
      year === null ||
      month === null ||
      day === null ||
      hour === null ||
      minute === null ||
      second === null
    ) {
      return null;
    }
    return { year, month, day, hour, minute, second };
  } catch {
    return null;
  }
}

/**
 * Format a UTC instant as a local ICS wall-clock string `YYYYMMDDTHHMMSS`
 * for the given IANA zone. Returns null when the zone is invalid.
 */
export function formatZonedIcsLocalDate(value: Date, timeZone: string): string | null {
  const parts = utcToZonedParts(value, timeZone);
  if (parts === null) {
    return null;
  }
  return (
    String(parts.year).padStart(4, "0") +
    String(parts.month).padStart(2, "0") +
    String(parts.day).padStart(2, "0") +
    "T" +
    String(parts.hour).padStart(2, "0") +
    String(parts.minute).padStart(2, "0") +
    String(parts.second).padStart(2, "0")
  );
}

/** Fractional hour-of-day in `timeZone` (e.g. 9.5 for 09:30). */
export function zonedHourOfDay(date: Date, timeZone: string): number | null {
  const parts = utcToZonedParts(date, timeZone);
  if (parts === null) {
    return null;
  }
  return parts.hour + parts.minute / 60 + parts.second / 3600;
}

/** Day-of-week (0=Sunday … 6=Saturday) in `timeZone`. */
export function zonedDayOfWeek(date: Date, timeZone: string): number | null {
  const parts = utcToZonedParts(date, timeZone);
  if (parts === null) {
    return null;
  }
  // Reconstruct a UTC date from local civil parts solely to read getUTCDay().
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

/** True when `timeZone` is a valid IANA identifier accepted by Intl. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
