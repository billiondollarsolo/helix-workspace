export type CalendarTimeSemantics = "zoned" | "floating" | "all_day";

export class CalendarTimeError extends Error {
  override readonly name = "CalendarTimeError";
}

export function canonicalTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new CalendarTimeError(`Invalid IANA time zone: ${timeZone}`);
  }
}

export function instantToLocalDateTime(value: Date | string, timeZone: string): string {
  const instant = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(instant.getTime())) throw new CalendarTimeError("Invalid calendar instant.");
  const parts = zonedParts(instant, canonicalTimeZone(timeZone));
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/** Resolve local wall time with Temporal-compatible overlap behavior: choose the earlier instant. */
export function localDateTimeToInstant(localDateTime: string, timeZone: string): Date {
  const wanted = parseLocalDateTime(localDateTime);
  const zone = canonicalTimeZone(timeZone);
  const wallClockUtc = Date.UTC(
    wanted.year,
    wanted.month - 1,
    wanted.day,
    wanted.hour,
    wanted.minute,
    wanted.second,
  );
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = new Date(wallClockUtc + hours * 3_600_000);
    const local = zonedParts(probe, zone);
    offsets.add(
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
        probe.getTime(),
    );
  }
  const candidates = [...offsets]
    .map((offset) => new Date(wallClockUtc - offset))
    .filter((candidate) => sameParts(zonedParts(candidate, zone), wanted))
    .sort((left, right) => left.getTime() - right.getTime());
  const resolved = candidates[0];
  if (resolved === undefined) {
    throw new CalendarTimeError(`${localDateTime} does not exist in ${zone} because of DST.`);
  }
  return resolved;
}

/** A floating/all-day value represented with UTC fields, never shifted by a viewer zone. */
export function localDateTimeToFloatingInstant(localDateTime: string): Date {
  const value = parseLocalDateTime(localDateTime);
  return new Date(
    Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second),
  );
}

interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function parseLocalDateTime(value: string): DateTimeParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);
  if (match === null) throw new CalendarTimeError("Local time must use YYYY-MM-DDTHH:mm:ss.");
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const check = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
  );
  if (
    check.getUTCFullYear() !== parts.year ||
    check.getUTCMonth() + 1 !== parts.month ||
    check.getUTCDate() !== parts.day ||
    check.getUTCHours() !== parts.hour ||
    check.getUTCMinutes() !== parts.minute ||
    check.getUTCSeconds() !== parts.second
  ) {
    throw new CalendarTimeError("Invalid local calendar date-time.");
  }
  return parts;
}

function zonedParts(value: Date, timeZone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(value);
  const numberPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (part === undefined) throw new CalendarTimeError("Unable to resolve calendar time.");
    return Number(part);
  };
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
    second: numberPart("second"),
  };
}

function sameParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}
