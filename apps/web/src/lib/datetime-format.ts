/* Date and time formatting that follows the person's Language & region
 * settings (`account.preferences`): time zone, 12/24-hour clock, date order
 * and language.
 *
 * Usage
 *   In components: `const format = useDateTimeFormat();` from
 *   `@/features/account/use-date-time-format`, then
 *     format.time(date)          "3:05 PM" or "15:05"
 *     format.date(date)          "Oct 9, 2026" (month and day order follow dateFormat)
 *     format.numericDate(date)   "10/09/2026", "09/10/2026" or "2026-10-09"
 *     format.dateTime(date)      date and time together
 *     format.relative(date)      "Today, 3:05 PM", "Yesterday, 15:05" or the date
 *     format.weekStart           0 = Sunday … 6 = Saturday
 *   Outside React: `createDateTimeFormat(preferences)` with the same API.
 *
 * Unset preferences (null) fall back to the browser: its zone, its locale's
 * clock and date order. Every function takes a Date, an ISO string or epoch
 * milliseconds, and returns "" for an invalid value.
 */

import type { AccountPreferences } from "@helix/contracts";

export type DateTimeFormatPreferences = Pick<
  AccountPreferences,
  "language" | "timeZone" | "dateFormat" | "timeFormat" | "weekStart"
>;

type DateInput = Date | string | number;

export interface DateTimeFormat {
  /** The IANA zone used for every value. */
  readonly timeZone: string;
  readonly locale: string;
  readonly hour12: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekStart: number;
  time(value: DateInput): string;
  date(value: DateInput, options?: { readonly year?: boolean }): string;
  numericDate(value: DateInput): string;
  dateTime(value: DateInput): string;
  relative(value: DateInput, now?: Date): string;
}

/** The browser's IANA zone, or UTC when it cannot be read. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A locale Intl accepts; browsers can report tags such as "en-US@posix". */
function usableLocale(tag: string | null | undefined): string {
  for (const candidate of [tag, tag?.split(/[@_.]/u)[0]]) {
    if (!candidate) continue;
    try {
      const [canonical] = Intl.getCanonicalLocales(candidate);
      if (canonical !== undefined) return canonical;
    } catch {
      // Try the next candidate.
    }
  }
  return "en-US";
}

function browserLocale(): string {
  return usableLocale(typeof navigator === "undefined" ? null : navigator.language);
}

function validZone(zone: string | null): string {
  if (zone === null) return browserTimeZone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return browserTimeZone();
  }
}

function localeHour12(locale: string): boolean {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ?? false;
}

/** The locale's first weekday where the browser exposes it (Intl.Locale weekInfo). */
function localeWeekStart(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    return firstDay === undefined ? 0 : firstDay % 7;
  } catch {
    return 0;
  }
}

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function dayKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
}

export function createDateTimeFormat(
  preferences: Partial<DateTimeFormatPreferences> = {},
): DateTimeFormat {
  const locale =
    preferences.language == null ? browserLocale() : usableLocale(preferences.language);
  const timeZone = validZone(preferences.timeZone ?? null);
  const hour12 =
    preferences.timeFormat === undefined || preferences.timeFormat === null
      ? localeHour12(locale)
      : preferences.timeFormat === "12h";
  const weekStart = preferences.weekStart ?? localeWeekStart(locale);
  const dateOrder = preferences.dateFormat ?? null;

  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12,
  });
  const dateFormatter = (year: boolean) =>
    new Intl.DateTimeFormat(
      dateOrder === "dmy" ? "en-GB" : dateOrder === "mdy" ? "en-US" : locale,
      {
        timeZone,
        month: "short",
        day: "numeric",
        ...(year ? { year: "numeric" } : {}),
      },
    );

  const numericDate = (value: DateInput): string => {
    const date = toDate(value);
    if (date === null) return "";
    if (dateOrder === null) {
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
    }
    const { year = "", month = "", day = "" } = zonedParts(date, timeZone);
    if (dateOrder === "ymd") return `${year}-${month}-${day}`;
    return dateOrder === "dmy" ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
  };

  const date = (value: DateInput, options: { readonly year?: boolean } = {}): string => {
    const parsed = toDate(value);
    if (parsed === null) return "";
    return dateOrder === "ymd"
      ? numericDate(parsed)
      : dateFormatter(options.year ?? true).format(parsed);
  };

  const time = (value: DateInput): string => {
    const parsed = toDate(value);
    return parsed === null ? "" : timeFormatter.format(parsed);
  };

  return {
    timeZone,
    locale,
    hour12,
    weekStart,
    time,
    date,
    numericDate,
    dateTime: (value) => {
      const parsed = toDate(value);
      return parsed === null ? "" : `${date(parsed)}, ${time(parsed)}`;
    },
    relative: (value, now = new Date()) => {
      const parsed = toDate(value);
      if (parsed === null) return "";
      const key = dayKey(parsed, timeZone);
      if (key === dayKey(now, timeZone)) return `Today, ${time(parsed)}`;
      if (key === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) {
        return `Yesterday, ${time(parsed)}`;
      }
      const sameYear = zonedParts(parsed, timeZone).year === zonedParts(now, timeZone).year;
      return date(parsed, { year: !sameYear });
    },
  };
}
