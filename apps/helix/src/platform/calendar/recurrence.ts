import {
  canonicalTimeZone,
  instantToLocalDateTime,
  localDateTimeToFloatingInstant,
  localDateTimeToInstant,
} from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";
import { isJsonRecord as isJsonObject } from "@helix/sdk-types";
import rrule, { type RRuleSet } from "rrule";
import { nonEmptyString as stringValue } from "../util/strings.js";
import type { CalendarEventRecord } from "./types.js";

const maxOccurrences = 10_000;
const maxWindowMs = 10 * 366 * 86_400_000;

export interface CalendarOccurrence {
  readonly eventId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly recurrenceId?: Date | undefined;
}

export interface CalendarRecurrenceOverride {
  readonly recurrenceId: string;
  readonly range: "this" | "this_and_future";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly location?: string | null | undefined;
  readonly sequence: number;
  readonly dtstamp: string;
  readonly attendees: readonly {
    readonly email: string;
    readonly displayName?: string | null | undefined;
    readonly role?: "required" | "optional" | "resource" | undefined;
    readonly responseStatus: "needs_action" | "accepted" | "declined" | "tentative";
  }[];
}

export interface CalendarOccurrencePage {
  readonly occurrences: readonly CalendarOccurrence[];
  readonly nextCursor: string | null;
}

export class CalendarRecurrenceError extends Error {
  override readonly name = "CalendarRecurrenceError";
}

export function expandCalendarEventOccurrences(
  event: RecurringEvent,
  windowStartsAt: Date,
  windowEndsAt: Date,
): readonly CalendarOccurrence[] {
  const page = expandCalendarOccurrencePage(event, windowStartsAt, windowEndsAt, {
    limit: maxOccurrences,
  });
  if (page.nextCursor !== null) {
    throw new CalendarRecurrenceError(`Recurrence exceeds ${String(maxOccurrences)} occurrences.`);
  }
  return page.occurrences;
}

export function expandCalendarOccurrencePage(
  event: RecurringEvent,
  windowStartsAt: Date,
  windowEndsAt: Date,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): CalendarOccurrencePage {
  validateBounds(event, windowStartsAt, windowEndsAt);
  const durationMs = event.endsAt.getTime() - event.startsAt.getTime();
  const overrides = recurrenceOverrides(event.metadata);
  const maximumDurationMs = overrides.reduce(
    (maximum, override) =>
      Math.max(
        maximum,
        new Date(override.endsAt).getTime() - new Date(override.startsAt).getTime(),
      ),
    durationMs,
  );
  const maximumShiftMs = overrides.reduce(
    (maximum, override) =>
      Math.max(
        maximum,
        Math.abs(
          validDate(override.startsAt, "override DTSTART").getTime() -
            validDate(override.recurrenceId, "RECURRENCE-ID").getTime(),
        ),
      ),
    0,
  );
  if (maximumShiftMs > maxWindowMs) {
    throw new CalendarRecurrenceError("Occurrence override cannot shift by more than ten years.");
  }
  const limit = options.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxOccurrences) {
    throw new CalendarRecurrenceError(
      `Occurrence limit must be between 1 and ${String(maxOccurrences)}.`,
    );
  }
  const cursor = options.cursor === undefined ? null : validDate(options.cursor, "cursor");
  const rangeStart = new Date(windowStartsAt.getTime() - maximumDurationMs - maximumShiftMs);
  const rangeEnd = new Date(windowEndsAt.getTime() + maximumShiftMs);
  const recurrence = recurrenceSet(event);
  const queryStart = cursor !== null && cursor > rangeStart ? cursor : rangeStart;
  // RRuleSet visits RDATEs before RRULEs, then sorts its result. Leave room
  // for every RDATE so a far-future addition cannot truncate earlier rule dates.
  const additionalDates = recurrence.set.rdates().length;
  const visible: { startsAt: Date; endsAt: Date; recurrenceId: Date }[] = [];
  recurrence.set.between(
    recurrenceQueryDate(queryStart, recurrence),
    recurrenceQueryDate(rangeEnd, recurrence),
    cursor === null,
    (date, index) => {
      if (index > maxOccurrences + additionalDates) {
        throw new CalendarRecurrenceError(
          `Recurrence scan exceeds ${String(maxOccurrences)} candidates. Narrow the recurrence window.`,
        );
      }
      const startsAt = recurrenceInstant(date, recurrence);
      if (cursor !== null && startsAt <= cursor) return true;
      const override = applicableOverride(overrides, startsAt);
      if (override?.status === "cancelled") return true;
      const occurrenceStartsAt =
        override === undefined
          ? startsAt
          : new Date(
              startsAt.getTime() +
                (validDate(override.startsAt, "override DTSTART").getTime() -
                  validDate(override.recurrenceId, "RECURRENCE-ID").getTime()),
            );
      const occurrenceEndsAt =
        override === undefined
          ? new Date(startsAt.getTime() + durationMs)
          : new Date(
              occurrenceStartsAt.getTime() +
                (validDate(override.endsAt, "override DTEND").getTime() -
                  validDate(override.startsAt, "override DTSTART").getTime()),
            );
      if (occurrenceEndsAt > windowStartsAt && occurrenceStartsAt < windowEndsAt) {
        visible.push({
          startsAt: occurrenceStartsAt,
          endsAt: occurrenceEndsAt,
          recurrenceId: startsAt,
        });
      }
      return visible.length <= limit + additionalDates;
    },
  );
  visible.sort((left, right) => left.recurrenceId.getTime() - right.recurrenceId.getTime());
  const page = visible.slice(0, limit);
  return {
    occurrences: page.map(({ startsAt, endsAt, recurrenceId }) => ({
      eventId: event.id,
      startsAt,
      endsAt,
      ...(event.recurrenceRule === null || event.recurrenceRule === undefined
        ? {}
        : { recurrenceId }),
    })),
    nextCursor: visible.length > limit ? (page.at(-1)?.recurrenceId.toISOString() ?? null) : null,
  };
}

export function recurrenceExceptionDates(metadata: JsonObject): readonly string[] {
  return recurrenceMetadataDates(metadata, "exdate");
}

export function recurrenceOverrides(metadata: JsonObject): readonly CalendarRecurrenceOverride[] {
  const caldav = metadata.caldav;
  if (!isJsonObject(caldav) || !Array.isArray(caldav.overrides)) return [];
  if (caldav.overrides.length > 1_000) {
    throw new CalendarRecurrenceError("Recurring event exceeds 1000 overrides.");
  }
  return caldav.overrides.flatMap((candidate) => parseOverride(candidate));
}

function parseOverride(value: unknown): readonly CalendarRecurrenceOverride[] {
  if (!isJsonObject(value)) return [];
  const recurrenceId = stringValue(value.recurrenceId);
  const startsAt = stringValue(value.startsAt);
  const endsAt = stringValue(value.endsAt);
  const dtstamp = stringValue(value.dtstamp);
  const status = value.status;
  const range = value.range;
  const sequence = value.sequence;
  if (
    recurrenceId === undefined ||
    startsAt === undefined ||
    endsAt === undefined ||
    dtstamp === undefined ||
    (status !== "confirmed" && status !== "tentative" && status !== "cancelled") ||
    (range !== "this" && range !== "this_and_future") ||
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Array.isArray(value.attendees)
  ) {
    return [];
  }
  validDate(recurrenceId, "RECURRENCE-ID");
  const start = validDate(startsAt, "override DTSTART");
  const end = validDate(endsAt, "override DTEND");
  validDate(dtstamp, "override DTSTAMP");
  if (end <= start) throw new CalendarRecurrenceError("Override DTEND must be after DTSTART.");
  const attendees = value.attendees.flatMap(parseOverrideAttendee);
  if (attendees.length !== value.attendees.length) return [];
  const title = optionalString(value.title);
  const description = optionalNullableString(value.description);
  const location = optionalNullableString(value.location);
  if (title === false || description === false || location === false) return [];
  return [
    {
      recurrenceId,
      range,
      startsAt,
      endsAt,
      status,
      sequence,
      dtstamp,
      attendees,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(location === undefined ? {} : { location }),
    },
  ];
}

function parseOverrideAttendee(
  value: unknown,
): readonly CalendarRecurrenceOverride["attendees"][number][] {
  if (!isJsonObject(value)) return [];
  const email = stringValue(value.email);
  const responseStatus = value.responseStatus;
  const role = value.role;
  const displayName = optionalNullableString(value.displayName);
  if (
    email === undefined ||
    (responseStatus !== "needs_action" &&
      responseStatus !== "accepted" &&
      responseStatus !== "declined" &&
      responseStatus !== "tentative") ||
    (role !== undefined && role !== "required" && role !== "optional" && role !== "resource") ||
    displayName === false
  )
    return [];
  return [
    {
      email,
      responseStatus,
      ...(role === undefined ? {} : { role }),
      ...(displayName === undefined ? {} : { displayName }),
    },
  ];
}

function optionalString(value: unknown): string | undefined | false {
  return value === undefined ? undefined : typeof value === "string" ? value : false;
}

function optionalNullableString(value: unknown): string | null | undefined | false {
  return value === undefined || value === null ? value : typeof value === "string" ? value : false;
}

function applicableOverride(
  overrides: readonly CalendarRecurrenceOverride[],
  recurrenceId: Date,
): CalendarRecurrenceOverride | undefined {
  const target = recurrenceId.getTime();
  const exact = overrides.find(
    (candidate) => new Date(candidate.recurrenceId).getTime() === target,
  );
  if (exact !== undefined && exact.range === "this") return exact;
  return overrides
    .filter(
      (candidate) =>
        candidate.range === "this_and_future" &&
        new Date(candidate.recurrenceId).getTime() <= target,
    )
    .sort(
      (left, right) =>
        new Date(right.recurrenceId).getTime() - new Date(left.recurrenceId).getTime(),
    )[0];
}

interface RecurrenceSet {
  readonly set: RRuleSet;
  readonly timeSemantics: "zoned" | "floating" | "all_day";
  readonly timezone: string;
}

function recurrenceSet(event: RecurringEvent): RecurrenceSet {
  const set = new rrule.RRuleSet(true);
  const timeSemantics = event.allDay ? "all_day" : (event.timeSemantics ?? "zoned");
  const timezone = canonicalTimeZone(event.timezone ?? "UTC");
  const intentZone = timeSemantics === "zoned" ? timezone : "UTC";
  const recurrenceStart = localDateTimeToFloatingInstant(
    event.startsLocal ?? instantToLocalDateTime(event.startsAt, intentZone),
  );
  if (event.recurrenceRule !== null && event.recurrenceRule !== undefined) {
    if (
      event.recurrenceRule.length > 4_096 ||
      /(?:^|\n)(?:DTSTART|RRULE|RDATE|EXDATE)[:;]/iu.test(event.recurrenceRule)
    ) {
      throw new CalendarRecurrenceError("recurrenceRule must contain one RRULE value.");
    }
    try {
      const parsed = rrule.RRule.parseString(event.recurrenceRule);
      if (parsed.freq === undefined) throw new Error("FREQ is required");
      if ((parsed.count ?? 0) > maxOccurrences || (parsed.interval ?? 1) > maxOccurrences) {
        throw new Error("COUNT or INTERVAL exceeds the supported bound");
      }
      set.rrule(
        new rrule.RRule(
          {
            ...parsed,
            dtstart: recurrenceStart,
          },
          true,
        ),
      );
    } catch (error) {
      throw new CalendarRecurrenceError(
        `Invalid recurrence rule: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
  set.rdate(recurrenceStart);
  for (const value of recurrenceMetadataDates(event.metadata, "rdate")) {
    set.rdate(recurrenceDate(validDate(value, "RDATE"), intentZone));
  }
  for (const value of recurrenceExceptionDates(event.metadata)) {
    set.exdate(recurrenceDate(validDate(value, "EXDATE"), intentZone));
  }
  return { set, timeSemantics, timezone };
}

type RecurringEvent = Pick<
  CalendarEventRecord,
  "id" | "startsAt" | "endsAt" | "recurrenceRule" | "metadata"
> &
  Partial<Pick<CalendarEventRecord, "timezone" | "allDay" | "timeSemantics" | "startsLocal">>;

function recurrenceDate(value: Date, intentZone: string): Date {
  return localDateTimeToFloatingInstant(instantToLocalDateTime(value, intentZone));
}

function recurrenceQueryDate(value: Date, recurrence: RecurrenceSet): Date {
  return recurrence.timeSemantics === "zoned" && recurrence.timezone !== "UTC"
    ? recurrenceDate(value, recurrence.timezone)
    : value;
}

function recurrenceInstant(value: Date, recurrence: RecurrenceSet): Date {
  return recurrence.timeSemantics === "zoned" && recurrence.timezone !== "UTC"
    ? localDateTimeToInstant(instantToLocalDateTime(value, "UTC"), recurrence.timezone)
    : value;
}

function recurrenceMetadataDates(
  metadata: JsonObject,
  name: "rdate" | "exdate",
): readonly string[] {
  const caldav = metadata.caldav;
  if (!isJsonObject(caldav)) return [];
  const values = caldav[name];
  if (!Array.isArray(values)) return [];
  if (values.length > maxOccurrences) {
    throw new CalendarRecurrenceError(
      `${name.toUpperCase()} exceeds ${String(maxOccurrences)} values.`,
    );
  }
  return values.filter((value): value is string => typeof value === "string");
}

function validateBounds(
  event: Pick<CalendarEventRecord, "startsAt" | "endsAt">,
  windowStartsAt: Date,
  windowEndsAt: Date,
): void {
  if (
    !validInstant(event.startsAt) ||
    !validInstant(event.endsAt) ||
    !validInstant(windowStartsAt) ||
    !validInstant(windowEndsAt) ||
    event.endsAt <= event.startsAt ||
    windowEndsAt <= windowStartsAt
  ) {
    throw new CalendarRecurrenceError(
      "Event and recurrence windows require valid increasing dates.",
    );
  }
  if (windowEndsAt.getTime() - windowStartsAt.getTime() > maxWindowMs) {
    throw new CalendarRecurrenceError("Recurrence window cannot exceed ten years.");
  }
}

function validDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!validInstant(date)) throw new CalendarRecurrenceError(`${label} must be an ISO date-time.`);
  return date;
}

function validInstant(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}
