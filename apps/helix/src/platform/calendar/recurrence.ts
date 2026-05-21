import type { JsonObject } from "@helix/sdk-types";
import type { CalendarEventRecord } from "./types.js";

const dayMs = 86_400_000;
const weekdayNumbers = new Map([
  ["SU", 0],
  ["MO", 1],
  ["TU", 2],
  ["WE", 3],
  ["TH", 4],
  ["FR", 5],
  ["SA", 6],
]);

export interface CalendarOccurrence {
  readonly eventId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly recurrenceId?: Date | undefined;
}

export function expandCalendarEventOccurrences(
  event: Pick<CalendarEventRecord, "id" | "startsAt" | "endsAt" | "recurrenceRule" | "metadata">,
  windowStartsAt: Date,
  windowEndsAt: Date,
): readonly CalendarOccurrence[] {
  if (event.endsAt <= event.startsAt || windowEndsAt <= windowStartsAt) {
    return [];
  }
  const durationMs = event.endsAt.getTime() - event.startsAt.getTime();
  const rule = parseRecurrenceRule(event.recurrenceRule ?? null);
  if (rule === null) {
    return event.endsAt > windowStartsAt && event.startsAt < windowEndsAt
      ? [{ eventId: event.id, startsAt: event.startsAt, endsAt: event.endsAt }]
      : [];
  }

  const excludedStarts = new Set(recurrenceExceptionDates(event.metadata));
  const occurrences: CalendarOccurrence[] = [];
  const maxIterations = Math.max((rule.count ?? 0) + 366, 3660);
  let generated = 0;
  let iterations = 0;
  let cursor = new Date(event.startsAt);

  while (iterations < maxIterations) {
    iterations += 1;
    if (rule.until !== undefined && cursor > rule.until) {
      break;
    }
    if (rule.count !== undefined && generated >= rule.count) {
      break;
    }

    const starts = occurrenceStartsForCursor(event.startsAt, cursor, rule);
    for (const startsAt of starts) {
      if (startsAt < event.startsAt) {
        continue;
      }
      if (rule.until !== undefined && startsAt > rule.until) {
        continue;
      }
      if (rule.count !== undefined && generated >= rule.count) {
        break;
      }
      generated += 1;
      const endsAt = new Date(startsAt.getTime() + durationMs);
      if (excludedStarts.has(startsAt.toISOString())) {
        continue;
      }
      if (endsAt > windowStartsAt && startsAt < windowEndsAt) {
        occurrences.push({ eventId: event.id, startsAt, endsAt, recurrenceId: startsAt });
      }
      if (startsAt >= windowEndsAt && rule.count === undefined) {
        return occurrences;
      }
    }
    cursor = nextCursor(cursor, rule);
  }

  return occurrences;
}

export function recurrenceExceptionDates(metadata: JsonObject): readonly string[] {
  const caldav = metadata["caldav"];
  if (!isJsonObject(caldav)) {
    return [];
  }
  const exdate = caldav["exdate"];
  if (!Array.isArray(exdate)) {
    return [];
  }
  return exdate.filter((value): value is string => typeof value === "string");
}

interface ParsedRecurrenceRule {
  readonly freq: "DAILY" | "WEEKLY" | "MONTHLY";
  readonly interval: number;
  readonly count?: number | undefined;
  readonly until?: Date | undefined;
  readonly byDay?: readonly number[] | undefined;
}

function parseRecurrenceRule(value: string | null): ParsedRecurrenceRule | null {
  if (value === null) {
    return null;
  }
  const parts = new Map(
    value
      .split(";")
      .map((part) => part.split("="))
      .filter((part): part is [string, string] => part.length === 2)
      .map(([key, partValue]) => [key.toUpperCase(), partValue.toUpperCase()]),
  );
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    return null;
  }
  const intervalValue = Number(parts.get("INTERVAL") ?? "1");
  const interval = Number.isInteger(intervalValue) && intervalValue > 0 ? intervalValue : 1;
  const countValue = parts.get("COUNT");
  const count = countValue === undefined ? undefined : Number(countValue);
  const untilValue = parts.get("UNTIL");
  const until = untilValue === undefined ? undefined : parseIcsDate(untilValue);
  const byDay = parts
    .get("BYDAY")
    ?.split(",")
    .flatMap((day) => {
      const weekday = weekdayNumbers.get(day.replace(/^[+-]?\d+/u, ""));
      return weekday === undefined ? [] : [weekday];
    });
  return {
    freq,
    interval,
    ...(count === undefined || !Number.isInteger(count) || count < 1 ? {} : { count }),
    ...(until === undefined ? {} : { until }),
    ...(byDay === undefined || byDay.length === 0 ? {} : { byDay }),
  };
}

function occurrenceStartsForCursor(
  eventStartsAt: Date,
  cursor: Date,
  rule: ParsedRecurrenceRule,
): readonly Date[] {
  if (rule.freq !== "WEEKLY" || rule.byDay === undefined) {
    return [new Date(cursor)];
  }
  const weekStart = startOfUtcWeek(cursor);
  return rule.byDay
    .map((day) => {
      const startsAt = new Date(weekStart.getTime() + day * dayMs);
      startsAt.setUTCHours(
        eventStartsAt.getUTCHours(),
        eventStartsAt.getUTCMinutes(),
        eventStartsAt.getUTCSeconds(),
        eventStartsAt.getUTCMilliseconds(),
      );
      return startsAt;
    })
    .sort((left, right) => left.getTime() - right.getTime());
}

function nextCursor(cursor: Date, rule: ParsedRecurrenceRule): Date {
  const next = new Date(cursor);
  if (rule.freq === "DAILY") {
    next.setUTCDate(next.getUTCDate() + rule.interval);
  } else if (rule.freq === "WEEKLY") {
    next.setUTCDate(next.getUTCDate() + rule.interval * 7);
  } else {
    next.setUTCMonth(next.getUTCMonth() + rule.interval);
  }
  return next;
}

function startOfUtcWeek(date: Date): Date {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  return start;
}

function parseIcsDate(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  const date = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4] ?? "23"),
      Number(match[5] ?? "59"),
      Number(match[6] ?? "59"),
    ),
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
