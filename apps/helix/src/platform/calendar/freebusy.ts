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
import { zonedDayOfWeek, zonedHourOfDay } from "./timezone.js";

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
              recurrenceRule: event.recurrenceRule,
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
    if (!withinWorkingHours(startsAt, endsAt, input.workingHours)) {
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

function withinWorkingHours(
  startsAt: Date,
  endsAt: Date,
  workingHours: CalendarWorkingHours | undefined,
): boolean {
  if (workingHours === undefined) {
    return true;
  }
  const timeZone = workingHours.timezone ?? "UTC";
  const day = timeZone === "UTC" ? startsAt.getUTCDay() : zonedDayOfWeek(startsAt, timeZone);
  if (day === null) {
    return false;
  }
  if (workingHours.daysOfWeek !== undefined && !workingHours.daysOfWeek.includes(day)) {
    return false;
  }
  // UTC skips the Intl round-trip; slot bounds are minute-aligned so dropping
  // seconds here matches what `zonedHourOfDay` would return.
  const hourOfDay = (value: Date): number | null =>
    timeZone === "UTC"
      ? value.getUTCHours() + value.getUTCMinutes() / 60
      : zonedHourOfDay(value, timeZone);
  const startsHour = hourOfDay(startsAt);
  const endsHour = hourOfDay(endsAt);
  if (startsHour === null || endsHour === null) {
    return false;
  }
  return startsHour >= workingHours.startsAtHour && endsHour <= workingHours.endsAtHour;
}

function maxDate(left: Date, right: Date): Date {
  return left > right ? left : right;
}
