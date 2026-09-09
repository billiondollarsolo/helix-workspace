import type {
  CalendarAvailabilitySlot,
  CalendarBusyBlock,
  CalendarFindTimeRequest,
  CalendarFindTimeResult,
  CalendarFreeBusyEvent,
  CalendarFreeBusyRequest,
  CalendarFreeBusyStore,
  CalendarWorkingHours,
} from "./types.js";
import { expandCalendarEventOccurrences } from "./recurrence.js";

const minuteMs = 60_000;

export async function getCalendarFreeBusy(
  store: CalendarFreeBusyStore,
  request: CalendarFreeBusyRequest,
): Promise<readonly CalendarBusyBlock[]> {
  return freeBusyEventsToBusyBlocks(await store.listCalendarFreeBusyEvents(request), request);
}

export async function findCalendarMeetingTimes(
  store: CalendarFreeBusyStore,
  request: CalendarFindTimeRequest,
): Promise<CalendarFindTimeResult> {
  const busy = await getCalendarFreeBusy(store, request);
  return {
    busy,
    slots: findAvailableSlots({
      ...request,
      busy,
    }),
  };
}

export function freeBusyEventsToBusyBlocks(
  events: readonly CalendarFreeBusyEvent[],
  window?: Pick<CalendarFreeBusyRequest, "startsAt" | "endsAt">,
): readonly CalendarBusyBlock[] {
  const byActor = new Map<string, CalendarFreeBusyEvent[]>();
  for (const event of events) {
    if (
      event.status === "cancelled" ||
      event.transparency === "transparent" ||
      event.startsAt >= event.endsAt
    ) {
      continue;
    }
    const expanded =
      window === undefined
        ? [event]
        : expandCalendarEventOccurrences(
            {
              id: event.eventId,
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              ...(event.timezone === undefined ? {} : { timezone: event.timezone }),
              ...(event.allDay === undefined ? {} : { allDay: event.allDay }),
              ...(event.timeSemantics === undefined
                ? {}
                : { timeSemantics: event.timeSemantics }),
              ...(event.startsLocal === undefined ? {} : { startsLocal: event.startsLocal }),
              ...(event.recurrenceRule === undefined
                ? {}
                : { recurrenceRule: event.recurrenceRule }),
              metadata: event.metadata ?? {},
            },
            window.startsAt,
            window.endsAt,
          ).map((occurrence) => ({
            ...event,
            eventId: occurrence.eventId,
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt,
          }));
    byActor.set(event.actorId, [...(byActor.get(event.actorId) ?? []), ...expanded]);
  }

  const blocks: CalendarBusyBlock[] = [];
  for (const [actorId, actorEvents] of byActor) {
    const sorted = [...actorEvents].sort(
      (left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
    );
    for (const event of sorted) {
      const last = blocks.at(-1);
      if (last !== undefined && last.actorId === actorId && event.startsAt <= last.endsAt) {
        blocks[blocks.length - 1] = {
          actorId,
          startsAt: last.startsAt,
          endsAt: maxDate(last.endsAt, event.endsAt),
          eventIds: [...last.eventIds, event.eventId],
        };
      } else {
        blocks.push({
          actorId,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          eventIds: [event.eventId],
        });
      }
    }
  }
  return blocks;
}

export function findAvailableSlots(input: {
  readonly actorIds: readonly string[];
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly durationMinutes: number;
  readonly busy: readonly CalendarBusyBlock[];
  readonly incrementMinutes?: number | undefined;
  readonly limit?: number | undefined;
  readonly workingHours?: CalendarWorkingHours | undefined;
  readonly workingHoursByActorId?: Readonly<Record<string, CalendarWorkingHours>> | undefined;
}): readonly CalendarAvailabilitySlot[] {
  if (input.durationMinutes <= 0) {
    throw new RangeError("durationMinutes must be greater than zero.");
  }
  if (input.startsAt >= input.endsAt) {
    throw new RangeError("find-time window startsAt must be before endsAt.");
  }

  const durationMs = input.durationMinutes * minuteMs;
  const incrementMs = (input.incrementMinutes ?? 15) * minuteMs;
  const limit = input.limit ?? 10;
  const slots: CalendarAvailabilitySlot[] = [];

  for (
    let startsAtMs = alignToIncrement(input.startsAt.getTime(), incrementMs);
    startsAtMs + durationMs <= input.endsAt.getTime() && slots.length < limit;
    startsAtMs += incrementMs
  ) {
    const startsAt = new Date(startsAtMs);
    const endsAt = new Date(startsAtMs + durationMs);
    if (
      !calendarSlotWithinWorkingHours(startsAt, endsAt, input.workingHours) ||
      input.actorIds.some(
        (actorId) =>
          !calendarSlotWithinWorkingHours(
            startsAt,
            endsAt,
            input.workingHoursByActorId?.[actorId],
          ),
      )
    ) {
      continue;
    }

    const busyActorIds = input.actorIds.filter((actorId) =>
      input.busy.some(
        (block) =>
          block.actorId === actorId && overlaps(startsAt, endsAt, block.startsAt, block.endsAt),
      ),
    );
    if (busyActorIds.length === 0) {
      slots.push({
        startsAt,
        endsAt,
        availableActorIds: input.actorIds,
        busyActorIds,
      });
    }
  }
  return slots;
}

function alignToIncrement(value: number, incrementMs: number): number {
  return Math.ceil(value / incrementMs) * incrementMs;
}

function overlaps(leftStart: Date, leftEnd: Date, rightStart: Date, rightEnd: Date): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function calendarSlotWithinWorkingHours(
  startsAt: Date,
  endsAt: Date,
  workingHours: CalendarWorkingHours | undefined,
): boolean {
  if (workingHours === undefined) {
    return true;
  }
  const timezone = workingHours.timezone ?? "UTC";
  const start = localSlotParts(startsAt, timezone);
  const end = localSlotParts(new Date(endsAt.getTime() - 1), timezone);
  if (start === null || end === null || start.date !== end.date) return false;
  const day = start.day;
  if (workingHours.daysOfWeek !== undefined && !workingHours.daysOfWeek.includes(day)) {
    return false;
  }
  const startsHour = start.hour + start.minute / 60;
  const endsHour = end.hour + (end.minute + 1 / 60_000) / 60;
  return startsHour >= workingHours.startsAtHour && endsHour <= workingHours.endsAtHour;
}

function localSlotParts(
  value: Date,
  timezone: string,
): { readonly date: string; readonly day: number; readonly hour: number; readonly minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((candidate) => candidate.type === type)?.value;
    const weekday = part("weekday");
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const hour = Number(part("hour"));
    const minute = Number(part("minute"));
    const weekdayIndex = weekday === undefined ? -1 : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    return year === undefined || month === undefined || day === undefined || weekdayIndex < 0
      ? null
      : { date: `${year}-${month}-${day}`, day: weekdayIndex, hour, minute };
  } catch {
    return null;
  }
}

function maxDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}
