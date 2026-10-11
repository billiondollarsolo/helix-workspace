/* Find a time: everyone's busy blocks side by side for one day, with the
   proposed slot highlighted and a few suggested free times. Picking a free
   spot moves the event there. External guests have no shared availability. */

import { instantToLocalDateTime, localDateTimeToInstant } from "@helix/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import type { PersonRef } from "@/features/people/person-ref";
import type { CalendarBusyBlock } from "./api";
import {
  addIsoDays,
  clockToHour,
  formatHourLabel,
  formatLongDate,
  formatTimeRange,
  hourToClock,
  snapHour,
} from "./date-math";
import type { EventDraft } from "./event-draft";
import { useTimeFormat, type WorkingHours } from "./preferences";
import { calendarFindTimeQueryOptions, calendarFreeBusyQueryOptions } from "./queries";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface Column {
  readonly key: string;
  readonly name: string;
  readonly actorId: string | null;
}

/** Busy hours of one person on `day`, clipped to the day. */
function busyHoursOnDay(
  blocks: readonly CalendarBusyBlock[],
  actorId: string,
  day: string,
  timeZone: string,
): { readonly start: number; readonly end: number }[] {
  return blocks
    .filter((block) => block.actorId === actorId)
    .map((block) => {
      const start = instantToLocalDateTime(block.startsAt, timeZone);
      const end = instantToLocalDateTime(block.endsAt, timeZone);
      return {
        start: start.slice(0, 10) < day ? 0 : clockToHour(start.slice(11, 16)),
        end: end.slice(0, 10) > day ? 24 : clockToHour(end.slice(11, 16)),
        touches: start.slice(0, 10) <= day && end.slice(0, 10) >= day,
      };
    })
    .filter((range) => range.touches && range.end > range.start)
    .map(({ start, end }) => ({ start, end }));
}

export function FindTimePanel({
  draft,
  selfActorId,
  timeZone,
  workingHours,
  onPick,
}: {
  readonly draft: EventDraft;
  readonly selfActorId: string | null;
  readonly timeZone: string;
  readonly workingHours: WorkingHours;
  readonly onPick: (day: string, start: number) => void;
}) {
  const [day, setDay] = useState(draft.startDate);
  const format = useTimeFormat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = useMemo<Column[]>(
    () => [
      ...(selfActorId === null ? [] : [{ key: "self", name: "You", actorId: selfActorId }]),
      ...draft.guests
        .filter((guest: PersonRef) => guest.actorId !== selfActorId)
        .map((guest) => ({
          key: guest.actorId ?? guest.email ?? guest.displayName,
          name: guest.displayName,
          actorId: guest.actorId,
        })),
    ],
    [draft.guests, selfActorId],
  );
  const actorIds = columns.flatMap((column) => (column.actorId === null ? [] : [column.actorId]));
  const freeBusyWindow = useMemo(
    () => ({
      windowStartsAt: localDateTimeToInstant(`${day}T00:00:00`, timeZone).toISOString(),
      windowEndsAt: localDateTimeToInstant(
        `${addIsoDays(day, 1)}T00:00:00`,
        timeZone,
      ).toISOString(),
    }),
    [day, timeZone],
  );
  const busy = useQuery(calendarFreeBusyQueryOptions({ actorIds, ...freeBusyWindow }));
  const length = draft.allDay ? 1 : Math.max(0.25, draft.endTime - draft.startTime || 1);
  const suggestions = useQuery(
    calendarFindTimeQueryOptions({
      attendeeActorIds: actorIds.filter((id) => id !== selfActorId),
      attendeeEmails: draft.guests.flatMap((guest) =>
        guest.actorId === null && guest.email !== null ? [guest.email] : [],
      ),
      windowStartsAt: localDateTimeToInstant(
        `${day}T${hourToClock(workingHours.start)}:00`,
        timeZone,
      ).toISOString(),
      windowEndsAt: localDateTimeToInstant(
        `${day}T${hourToClock(workingHours.end)}:00`,
        timeZone,
      ).toISOString(),
      durationMinutes: Math.round(length * 60),
      stepMinutes: 30,
      limit: 3,
    }),
  );

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const column = scroller?.querySelector<HTMLElement>("[data-free-busy]");
    if (scroller && column)
      scroller.scrollTop = (column.offsetHeight / 24) * (workingHours.start - 1);
  }, [workingHours.start]);

  const proposed = draft.startDate === day && !draft.allDay ? draft.startTime : null;

  return (
    <section aria-label="Find a time" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Previous day"
          onClick={() => setDay(addIsoDays(day, -1))}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Next day"
          onClick={() => setDay(addIsoDays(day, 1))}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <h3 className="type-body font-semibold m-0" aria-live="polite">
          {formatLongDate(day)}
        </h3>
      </div>

      {busy.isError ? (
        <InlineError
          variant="compact"
          title="Couldn't load availability"
          message="Busy times for guests are not available right now."
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2 type-body-sm">
        <span className="text-muted-foreground">Suggested times:</span>
        {suggestions.isLoading ? <span className="text-muted-foreground">Looking…</span> : null}
        {(suggestions.data ?? []).map((slot) => {
          const local = instantToLocalDateTime(slot.startsAt, timeZone);
          const start = clockToHour(local.slice(11, 16));
          return (
            <Button
              key={slot.startsAt}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onPick(local.slice(0, 10), start)}
            >
              {formatTimeRange(start, start + length, format)}
            </Button>
          );
        })}
        {suggestions.data?.length === 0 ? (
          <span className="text-muted-foreground">No common free time in working hours.</span>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="cal-find-time"
        role="group"
        aria-label={`Availability on ${formatLongDate(day)}`}
        style={{ "--cal-cols": columns.length } as CSSProperties}
      >
        <div className="sticky top-0 z-[2] bg-[var(--surface)] border-b border-border" />
        {columns.map((column) => (
          <div
            key={column.key}
            className="sticky top-0 z-[2] bg-[var(--surface)] border-b border-l border-border px-2 py-1.5 type-caption font-semibold truncate"
          >
            {column.name}
            {column.actorId === null ? (
              <span className="block font-normal text-muted-foreground">
                Availability not shared
              </span>
            ) : null}
          </div>
        ))}
        <div aria-hidden="true">
          {HOURS.map((hour) => (
            <div key={hour} className="cal-hour-label type-caption">
              <span>{formatHourLabel(hour, format)}</span>
            </div>
          ))}
        </div>
        {columns.map((column) => {
          const ranges =
            column.actorId === null
              ? []
              : busyHoursOnDay(busy.data ?? [], column.actorId, day, timeZone);
          return (
            <div
              key={column.key}
              data-free-busy
              className="cal-day-col cursor-pointer"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const hour = ((event.clientY - rect.top) / rect.height) * 24;
                onPick(day, Math.min(24 - length, Math.max(0, snapHour(hour - 0.25, 30))));
              }}
            >
              <div
                className="cal-off-hours top-0"
                style={{ height: `${String((workingHours.start / 24) * 100)}%` }}
              />
              <div
                className="cal-off-hours bottom-0"
                style={{ top: `${String((workingHours.end / 24) * 100)}%` }}
              />
              {ranges.map((range) => (
                <div
                  key={`${String(range.start)}-${String(range.end)}`}
                  className="cal-busy-block type-caption"
                  style={
                    { "--start": range.start, "--span": range.end - range.start } as CSSProperties
                  }
                >
                  Busy
                  <span className="sr-only">
                    {` ${column.name}, ${formatTimeRange(range.start, range.end, format)}`}
                  </span>
                </div>
              ))}
              {proposed !== null ? (
                <div
                  className="cal-proposed-slot"
                  style={{ "--start": proposed, "--span": length } as CSSProperties}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="m-0 type-caption text-muted-foreground">
        Click a free time to move the event there. Shaded hours are outside working hours.
      </p>
    </section>
  );
}
