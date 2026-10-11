/* Placement maths for the time grid: overlapping timed events share a day
   column side by side, and all-day events stack into lanes that may span
   several day columns. */

import { occursOn, type CalendarOccurrence } from "./event-model";

/** The part of a timed occurrence drawn in one day column. */
export interface TimedSegment {
  readonly occurrence: CalendarOccurrence;
  readonly day: string;
  /** Decimal hours within `day`, 0-24. */
  readonly start: number;
  readonly end: number;
  /** 0-based column among overlapping segments, and the column count of its group. */
  readonly column: number;
  readonly columns: number;
}

/** Timed occurrences in one day, clipped to the day and laid out in columns. */
export function timedSegmentsForDay(
  occurrences: readonly CalendarOccurrence[],
  day: string,
): TimedSegment[] {
  const pieces = occurrences
    .filter((occurrence) => !occurrence.allDay && occursOn(occurrence, day))
    .map((occurrence) => ({
      occurrence,
      day,
      start: occurrence.startDate === day ? occurrence.start : 0,
      end: occurrence.endDate === day ? occurrence.end : 24,
    }))
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const placed: TimedSegment[] = [];
  let group: { start: number; end: number; columnEnds: number[]; members: number[] } | null = null;
  const closeGroup = () => {
    if (group === null) return;
    for (const index of group.members) {
      const segment = placed[index];
      if (segment !== undefined) placed[index] = { ...segment, columns: group.columnEnds.length };
    }
  };
  for (const piece of pieces) {
    if (group === null || piece.start >= group.end) {
      closeGroup();
      group = { start: piece.start, end: piece.end, columnEnds: [], members: [] };
    }
    let column = group.columnEnds.findIndex((columnEnd) => columnEnd <= piece.start);
    if (column === -1) {
      column = group.columnEnds.length;
      group.columnEnds.push(piece.end);
    } else {
      group.columnEnds[column] = piece.end;
    }
    group.end = Math.max(group.end, piece.end);
    group.members.push(placed.length);
    placed.push({ ...piece, column, columns: 1 });
  }
  closeGroup();
  return placed;
}

/** An all-day occurrence placed in the all-day row. */
export interface AllDayPlacement {
  readonly occurrence: CalendarOccurrence;
  /** First and last visible column index (inclusive). */
  readonly first: number;
  readonly last: number;
  readonly lane: number;
  /** The event continues before the first or after the last visible day. */
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
}

/** Stack all-day occurrences into lanes across the visible `days`. */
export function allDayPlacements(
  occurrences: readonly CalendarOccurrence[],
  days: readonly string[],
): AllDayPlacement[] {
  const laneEnds: number[] = [];
  const result: AllDayPlacement[] = [];
  const candidates = occurrences
    .filter((occurrence) => occurrence.allDay)
    .map((occurrence) => ({
      occurrence,
      first: days.findIndex((day) => day >= occurrence.startDate),
      last: days.findLastIndex((day) => day <= occurrence.endDate),
    }))
    .filter(({ first, last }) => first !== -1 && last !== -1 && first <= last)
    .sort((left, right) => left.first - right.first || right.last - left.last);
  for (const candidate of candidates) {
    let lane = laneEnds.findIndex((end) => end < candidate.first);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(candidate.last);
    } else {
      laneEnds[lane] = candidate.last;
    }
    result.push({
      ...candidate,
      lane,
      continuesBefore: candidate.occurrence.startDate < (days[candidate.first] ?? ""),
      continuesAfter: candidate.occurrence.endDate > (days[candidate.last] ?? ""),
    });
  }
  return result;
}

/** Occurrences touching `day`: all-day first, then by start time. */
export function occurrencesOnDay(
  occurrences: readonly CalendarOccurrence[],
  day: string,
): CalendarOccurrence[] {
  return occurrences
    .filter((occurrence) => occursOn(occurrence, day))
    .sort(
      (left, right) =>
        Number(right.allDay) - Number(left.allDay) ||
        left.startsLocal.localeCompare(right.startsLocal),
    );
}
