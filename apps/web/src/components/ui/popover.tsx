/* Popover — anchored, non-modal floating panel (event details, quick
   create, snooze picker, hovercards).

   Built on Radix Popover: the trigger gets aria-expanded/aria-controls,
   Escape and outside clicks close, focus moves into the panel on open and back
   to the trigger on close. Give the panel an accessible name with
   `aria-label` or `aria-labelledby`.

   <Popover>
     <PopoverTrigger asChild><Button>Snooze</Button></PopoverTrigger>
     <PopoverContent aria-label="Snooze until">…</PopoverContent>
   </Popover> */

import { Popover as PopoverPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-[var(--radius-lg)] border border-border bg-popover p-3 text-popover-foreground shadow-[var(--shadow-lg)] outline-none data-[state=open]:animate-[ui-pop-in_var(--motion-duration-fast)_var(--motion-ease-enter)]",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
