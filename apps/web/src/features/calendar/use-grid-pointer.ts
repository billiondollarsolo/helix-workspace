/* Pointer interactions on the time grid, snapped to 15 minutes:
   - drag on an empty slot to choose a time range (a click picks one hour);
   - drag an event to move it, across days too;
   - drag an event's bottom edge to change its length.
   Touch keeps native scrolling: a tap on an empty slot creates, a tap on an
   event opens it. Keyboard alternatives live on the event chips. */

import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { AnchorRect } from "./anchored-popover";
import { isoDayDiff, snapHour } from "./date-math";
import type { CalendarOccurrence } from "./event-model";
import type { TimedSegment } from "./grid-layout";

export type GridDrag =
  | { readonly kind: "create"; readonly day: string; readonly from: number; readonly to: number }
  | {
      readonly kind: "move" | "resize";
      readonly occurrence: CalendarOccurrence;
      readonly day: string;
      readonly start: number;
      readonly end: number;
    };

export interface GridPointerCallbacks {
  readonly onCreate: (day: string, start: number, end: number, anchor: AnchorRect) => void;
  readonly onReschedule: (
    occurrence: CalendarOccurrence,
    startMinutes: number,
    endMinutes: number,
  ) => void;
}

interface Column {
  readonly day: string;
  readonly rect: DOMRect;
}

const DRAG_THRESHOLD_PX = 4;
const TAP_SLOP_PX = 10;

function columnsOf(body: HTMLElement | null): Column[] {
  if (body === null) return [];
  return [...body.querySelectorAll<HTMLElement>("[data-day]")].map((element) => ({
    day: element.dataset.day ?? "",
    rect: element.getBoundingClientRect(),
  }));
}

function columnAt(columns: readonly Column[], clientX: number): Column | undefined {
  return (
    columns.find((column) => clientX >= column.rect.left && clientX < column.rect.right) ??
    (clientX < (columns[0]?.rect.left ?? 0) ? columns[0] : columns.at(-1))
  );
}

function hourAt(rect: DOMRect, clientY: number): number {
  if (rect.height <= 0) return 0;
  return Math.min(24, Math.max(0, ((clientY - rect.top) / rect.height) * 24));
}

function slotAnchor(rect: DOMRect, from: number, to: number): AnchorRect {
  return {
    left: rect.left,
    top: rect.top + (from / 24) * rect.height,
    width: rect.width,
    height: Math.max(18, ((to - from) / 24) * rect.height),
  };
}

export function useGridPointer(
  bodyRef: RefObject<HTMLElement | null>,
  callbacks: GridPointerCallbacks,
) {
  const [drag, setDrag] = useState<GridDrag | null>(null);
  const suppressClick = useRef(false);
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  const track = useCallback(
    (
      down: PointerEvent<HTMLElement>,
      onMove: (event: globalThis.PointerEvent, moved: boolean) => void,
      onUp: (event: globalThis.PointerEvent, moved: boolean) => void,
    ) => {
      const originX = down.clientX;
      const originY = down.clientY;
      const threshold = down.pointerType === "touch" ? TAP_SLOP_PX : DRAG_THRESHOLD_PX;
      let moved = false;
      const handleMove = (event: globalThis.PointerEvent) => {
        if (Math.hypot(event.clientX - originX, event.clientY - originY) > threshold) moved = true;
        onMove(event, moved);
      };
      const finish = (event: globalThis.PointerEvent) => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        onUp(event, moved);
      };
      const cancel = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        setDrag(null);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
    },
    [],
  );

  /** Pointer down on an empty part of a day column. */
  const onColumnPointerDown = useCallback(
    (day: string, down: PointerEvent<HTMLElement>) => {
      if (down.button !== 0) return;
      if (down.target instanceof Element && down.target.closest("[data-calendar-event]")) return;
      const columns = columnsOf(bodyRef.current);
      const column = columns.find((candidate) => candidate.day === day);
      if (column === undefined) return;
      const touch = down.pointerType === "touch";
      if (!touch) down.preventDefault();
      const anchorHour = hourAt(column.rect, down.clientY);
      const clickStart = Math.min(23, Math.floor(anchorHour * 2) / 2);
      track(
        down,
        (event, moved) => {
          if (touch || !moved) return;
          const to = snapHour(hourAt(column.rect, event.clientY));
          setDrag({ kind: "create", day, from: snapHour(anchorHour), to });
        },
        (event, moved) => {
          setDrag(null);
          if (touch && moved) return;
          let from = clickStart;
          let to = Math.min(24, clickStart + 1);
          if (moved) {
            const a = snapHour(anchorHour);
            const b = snapHour(hourAt(column.rect, event.clientY));
            from = Math.min(a, b);
            to = Math.max(a, b);
            if (to - from < 0.25) to = Math.min(24, from + 0.25);
          }
          callbacksRef.current.onCreate(day, from, to, slotAnchor(column.rect, from, to));
        },
      );
    },
    [bodyRef, track],
  );

  /** Pointer down on an event (mode "move") or its bottom edge (mode "resize"). */
  const onEventPointerDown = useCallback(
    (segment: TimedSegment, down: PointerEvent<HTMLElement>, mode: "move" | "resize") => {
      if (down.button !== 0 || down.pointerType === "touch") return;
      const columns = columnsOf(bodyRef.current);
      const origin = columns.find((candidate) => candidate.day === segment.day);
      if (origin === undefined) return;
      down.preventDefault();
      const originHour = hourAt(origin.rect, down.clientY);
      const span = segment.end - segment.start;
      const target = (event: globalThis.PointerEvent) => {
        const column = (mode === "move" ? columnAt(columns, event.clientX) : origin) ?? origin;
        const delta = snapHour(hourAt(column.rect, event.clientY) - originHour);
        if (mode === "resize") {
          const end = Math.min(24, Math.max(segment.start + 0.25, segment.end + delta));
          return {
            day: segment.day,
            start: segment.start,
            end,
            startDelta: 0,
            endDelta: end - segment.end,
          };
        }
        const start = Math.min(24 - Math.min(span, 24), Math.max(0, segment.start + delta));
        const hours = isoDayDiff(segment.day, column.day) * 24 + (start - segment.start);
        return { day: column.day, start, end: start + span, startDelta: hours, endDelta: hours };
      };
      track(
        down,
        (event, moved) => {
          if (!moved) return;
          const next = target(event);
          setDrag({
            kind: mode,
            occurrence: segment.occurrence,
            day: next.day,
            start: next.start,
            end: next.end,
          });
        },
        (event, moved) => {
          setDrag(null);
          if (!moved) return;
          suppressClick.current = true;
          const next = target(event);
          if (next.startDelta === 0 && next.endDelta === 0) return;
          callbacksRef.current.onReschedule(
            segment.occurrence,
            Math.round(next.startDelta * 60),
            Math.round(next.endDelta * 60),
          );
        },
      );
    },
    [bodyRef, track],
  );

  /** True (once) when the click that follows a drag should not open the event. */
  const consumeDragClick = useCallback(() => {
    const suppressed = suppressClick.current;
    suppressClick.current = false;
    return suppressed;
  }, []);

  return { drag, onColumnPointerDown, onEventPointerDown, consumeDragClick };
}
