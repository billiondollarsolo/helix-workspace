/* Writes from the calendar: save a draft (creating a video call first when
   asked), move or resize with Undo, delete with Undo, and RSVP. Moves update
   the visible window immediately and roll back if the server refuses. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { notify } from "@/components/ui/toast";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  respondToCalendarEvent,
  updateCalendarEvent,
  type CalendarApiEvent,
  type CalendarApiResponseStatus,
} from "./api";
import { clockToHour, formatLongDate, formatTimeRange, type TimeFormat } from "./date-math";
import {
  draftFromEvent,
  draftInstants,
  draftLocalBounds,
  draftToEventInput,
  type EventDraft,
} from "./event-draft";
import { addLocalMinutes } from "./event-model";
import { calendarQueryKeys } from "./queries";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

/** The draft with its start and end shifted by whole minutes. */
export function shiftDraft(
  draft: EventDraft,
  startMinutes: number,
  endMinutes: number,
): EventDraft {
  const bounds = draftLocalBounds(draft);
  const start = addLocalMinutes(bounds.start, startMinutes);
  const end = addLocalMinutes(bounds.end, endMinutes);
  if (draft.allDay) {
    return {
      ...draft,
      startDate: start.slice(0, 10),
      endDate: addLocalMinutes(end, -24 * 60).slice(0, 10),
    };
  }
  return {
    ...draft,
    startDate: start.slice(0, 10),
    startTime: clockToHour(start.slice(11, 16)),
    endDate: end.slice(0, 10),
    endTime: clockToHour(end.slice(11, 16)),
  };
}

function patchedEvent(event: CalendarApiEvent, draft: EventDraft): CalendarApiEvent {
  const { startsAt, endsAt } = draftInstants(draft);
  const bounds = draftLocalBounds(draft);
  return { ...event, startsAt, endsAt, startsLocal: bounds.start, endsLocal: bounds.end };
}

export function useEventActions({
  announce,
  timeFormat,
}: {
  /** Polite screen-reader announcement. */
  readonly announce: (message: string) => void;
  readonly timeFormat: TimeFormat;
}) {
  const queryClient = useQueryClient();
  const [hiddenEventIds, setHiddenEventIds] = useState<ReadonlySet<string>>(new Set());
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: calendarQueryKeys.eventsRoot }),
    [queryClient],
  );

  const save = useMutation({
    mutationFn: async (draft: EventDraft) => {
      const { conference, ...input } = draftToEventInput(draft);
      if (draft.mode === "edit" && draft.eventId !== undefined) {
        // An event stays on its calendar; the API has no move-between-calendars.
        return updateCalendarEvent({
          eventId: draft.eventId,
          patch: { ...input, calendarId: undefined },
          ...(conference === undefined ? {} : { conference }),
        });
      }
      return createCalendarEvent({ ...input, ...(conference === undefined ? {} : { conference }) });
    },
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (event, draft) => {
      notify({ message: draft.mode === "create" ? "Event created" : "Event saved" });
      announce(`${event.title} saved`);
    },
    onSettled: invalidate,
  });

  const reschedule = useMutation({
    mutationFn: (input: {
      readonly eventId: string;
      readonly startsAt: string;
      readonly endsAt: string;
    }) =>
      updateCalendarEvent({
        eventId: input.eventId,
        patch: { startsAt: input.startsAt, endsAt: input.endsAt },
      }),
    onMutate: () => undefined,
    onError: (error) => {
      notify({
        tone: "error",
        message: "Couldn't move the event",
        description: errorText(error, "Try again."),
      });
    },
    onSettled: invalidate,
  });

  /** Shift an event (every occurrence, for a series) by minutes, with Undo. */
  const moveEvent = useCallback(
    (event: CalendarApiEvent, startMinutes: number, endMinutes: number, undoable = true) => {
      const before = draftFromEvent(event);
      const after = shiftDraft(before, startMinutes, endMinutes);
      let next: CalendarApiEvent;
      try {
        next = patchedEvent(event, after);
      } catch (error) {
        notify({
          tone: "error",
          message: errorText(error, "That time does not exist in this time zone."),
        });
        return;
      }
      queryClient.setQueriesData<readonly CalendarApiEvent[]>(
        { queryKey: calendarQueryKeys.eventsRoot },
        (current) => current?.map((candidate) => (candidate.id === event.id ? next : candidate)),
      );
      reschedule.mutate({ eventId: event.id, startsAt: next.startsAt, endsAt: next.endsAt });
      const when = after.allDay
        ? formatLongDate(after.startDate)
        : `${formatLongDate(after.startDate)}, ${formatTimeRange(after.startTime, after.endTime || 24, timeFormat)}`;
      announce(`${event.title || "Event"} moved to ${when}`);
      if (undoable) {
        notify({
          message: startMinutes === endMinutes ? "Event moved" : "Event updated",
          action: {
            label: "Undo",
            onAction: () => {
              queryClient.setQueriesData<readonly CalendarApiEvent[]>(
                { queryKey: calendarQueryKeys.eventsRoot },
                (current) =>
                  current?.map((candidate) => (candidate.id === event.id ? event : candidate)),
              );
              reschedule.mutate({
                eventId: event.id,
                startsAt: event.startsAt,
                endsAt: event.endsAt,
              });
            },
          },
        });
      }
    },
    [announce, queryClient, reschedule],
  );

  /** Hide now; delete when the Undo toast goes away without Undo. */
  const deleteEvent = useCallback(
    (event: CalendarApiEvent) => {
      setHiddenEventIds((current) => new Set([...current, event.id]));
      const restore = () =>
        setHiddenEventIds((current) => new Set([...current].filter((id) => id !== event.id)));
      announce(`${event.title || "Event"} deleted`);
      notify({
        message: event.recurrenceRule ? "All events in the series deleted" : "Event deleted",
        action: { label: "Undo", onAction: restore },
        onClose: (reason) => {
          if (reason === "action") return;
          deleteCalendarEvent({ eventId: event.id })
            .then(() => invalidate())
            .catch((error: unknown) => {
              restore();
              notify({
                tone: "error",
                message: "Couldn't delete the event",
                description: errorText(error, "Try again."),
              });
            });
        },
      });
    },
    [announce, invalidate],
  );

  const respond = useMutation({
    mutationFn: (input: {
      readonly eventId: string;
      readonly status: Exclude<CalendarApiResponseStatus, "needs_action">;
    }) => respondToCalendarEvent({ eventId: input.eventId, responseStatus: input.status }),
    onMutate: () => undefined,
    onError: (error) => {
      notify({
        tone: "error",
        message: "Couldn't send your reply",
        description: errorText(error, "Try again."),
      });
    },
    onSettled: invalidate,
  });

  return {
    save,
    saveError: save.isError ? errorText(save.error, "Something went wrong. Try again.") : null,
    moveEvent,
    deleteEvent,
    respond,
    hiddenEventIds,
  };
}
