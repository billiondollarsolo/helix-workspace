/* Human units for the admin console: sizes, durations, counts and times
 * read the way a person says them ("5 GB", "2 minutes", "12,345",
 * "3 hours ago"), never as raw bytes, seconds or ISO strings. */

const BYTE_UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"] as const;

/** `5368709120` → "5 GB". Binary multiples, at most one decimal, no trailing ".0". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return bytes === 1 ? "1 byte" : `${formatCount(bytes)} bytes`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${formatCount(rounded)} ${BYTE_UNITS[unit] ?? "bytes"}`;
}

/** Thousands separators: 12345 → "12,345". */
export function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

/** Plural-aware "1 day" / "3 days". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

const DURATION_UNITS = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
] as const;

/** `120` → "2 minutes", `5400` → "1 hour 30 minutes". Two largest units at most. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "—";
  }
  const seconds = Math.round(totalSeconds);
  if (seconds === 0) {
    return "0 seconds";
  }
  const parts: string[] = [];
  let remaining = seconds;
  for (const [unit, size] of DURATION_UNITS) {
    if (parts.length === 2) break;
    const amount = Math.floor(remaining / size);
    if (amount > 0) {
      parts.push(pluralize(amount, unit));
      remaining -= amount * size;
    } else if (parts.length > 0) {
      break;
    }
  }
  return parts.join(" ");
}

const ABSOLUTE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const RELATIVE_STEPS = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const satisfies readonly (readonly [Intl.RelativeTimeFormatUnit, number])[];

function parseDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 11, 2026, 1:25 AM". Falls back to the input when it is not a date. */
export function formatAbsoluteTime(value: string | Date): string {
  const date = parseDate(value);
  return date === null ? String(value) : ABSOLUTE_FORMAT.format(date);
}

/** "3 hours ago", "in 2 days", "just now". */
export function formatRelativeTime(value: string | Date, now: Date = new Date()): string {
  const date = parseDate(value);
  if (date === null) {
    return String(value);
  }
  const deltaSeconds = (date.getTime() - now.getTime()) / 1000;
  const magnitude = Math.abs(deltaSeconds);
  if (magnitude < 45) {
    return "just now";
  }
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_STEPS) {
    if (magnitude >= size || unit === "minute") {
      return formatter.format(Math.round(deltaSeconds / size), unit);
    }
  }
  return formatter.format(Math.round(deltaSeconds / 60), "minute");
}
