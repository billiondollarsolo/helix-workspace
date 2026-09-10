import { localDateTimeToFloatingInstant, localDateTimeToInstant } from "@helix/contracts";
import { type EventDraft, decimalHourToClock } from "./calendar-event-dialog";
import { type CalendarRouteView } from "./queries";

/* -------------------------------------------------------------------- helpers */

export function draftInstants(draft: EventDraft): {
  readonly startsAt: string;
  readonly endsAt: string;
} {
  if (draft.allDay) {
    return {
      startsAt: localDateTimeToFloatingInstant(`${draft.date}T00:00:00`).toISOString(),
      endsAt: localDateTimeToFloatingInstant(
        `${shiftIsoDay(draft.date, 1)}T00:00:00`,
      ).toISOString(),
    };
  }
  const startsLocal = `${draft.date}T${decimalHourToClock(draft.start)}:00`;
  const endsLocal = `${draft.date}T${decimalHourToClock(draft.end)}:00`;
  const resolve = (value: string) =>
    draft.timeSemantics === "floating"
      ? localDateTimeToFloatingInstant(value)
      : localDateTimeToInstant(value, draft.timezone);
  return {
    startsAt: resolve(startsLocal).toISOString(),
    endsAt: resolve(endsLocal).toISOString(),
  };
}

function shiftIsoDay(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Header label for the visible window, e.g. "May 18 – 24, 2026". */
export function formatWindowLabel(
  startsAt: string | undefined,
  endsAt: string | undefined,
): string {
  const start = new Date(startsAt ?? "2026-05-18T00:00:00.000Z");
  const end = new Date(endsAt ?? "2026-05-24T23:59:59.999Z");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Calendar";
  }
  const sameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
  const month = (date: Date) =>
    date.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const startMonth = month(start);
  const endMonth = month(end);
  const year = end.getUTCFullYear();
  if (sameDay) {
    return `${startMonth} ${String(start.getUTCDate())}, ${String(year)}`;
  }
  if (startMonth === endMonth) {
    return `${startMonth} ${String(start.getUTCDate())} – ${String(end.getUTCDate())}, ${String(year)}`;
  }
  return `${startMonth} ${String(start.getUTCDate())} – ${endMonth} ${String(end.getUTCDate())}, ${String(year)}`;
}

/** Shift an ISO `yyyy-mm-dd` date by one view-sized step. */
export function shiftIsoDate(isoDate: string, view: CalendarRouteView, direction: -1 | 1): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  if (view === "day") {
    date.setUTCDate(date.getUTCDate() + direction);
  } else if (view === "month") {
    date.setUTCMonth(date.getUTCMonth() + direction);
  } else if (view === "agenda") {
    date.setUTCDate(date.getUTCDate() + direction * 30);
  } else {
    date.setUTCDate(date.getUTCDate() + direction * 7);
  }
  return date.toISOString().slice(0, 10);
}

export function formatCalendarDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
