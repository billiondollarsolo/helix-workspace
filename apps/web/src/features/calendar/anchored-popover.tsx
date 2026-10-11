import type { ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function anchorRectOf(element: Element): AnchorRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** A popover pinned to a screen rectangle, e.g. an event chip or a dragged time range. */
export function AnchoredPopover({
  anchor,
  onClose,
  label,
  className,
  children,
  side = "right",
}: {
  readonly anchor: AnchorRect;
  readonly onClose: () => void;
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
  /** Phones have no room beside the anchor; open below it instead. */
  readonly side?: "right" | "bottom";
}) {
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden="true"
          className="pointer-events-none fixed"
          style={{
            left: anchor.left,
            top: anchor.top,
            width: anchor.width,
            height: anchor.height,
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        aria-label={label}
        side={side}
        align="start"
        className={cn("w-[min(400px,calc(100vw-16px))] p-0", className)}
        onInteractOutside={(event) => {
          // Clicking another event re-targets the popover instead of closing and reopening it.
          if (
            event.target instanceof Element &&
            event.target.closest("[data-calendar-event]") !== null
          ) {
            event.preventDefault();
          }
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
