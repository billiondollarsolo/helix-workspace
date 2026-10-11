/* Shared surface and item classes for Menu, ContextMenu, and SplitButton so
   every menu in the product looks and behaves the same. Radix sets
   `data-highlighted` on the roving-focus item and `data-disabled` on disabled
   ones; styling hangs off those rather than :hover. */

export const menuSurfaceClass =
  "z-50 min-w-48 max-w-80 overflow-y-auto overscroll-contain rounded-[var(--radius-lg)] border border-border bg-popover py-1.5 text-popover-foreground shadow-[var(--shadow-lg)] outline-none max-h-[var(--radix-dropdown-menu-content-available-height,var(--radix-context-menu-content-available-height,70vh))] data-[state=open]:animate-[ui-pop-in_var(--motion-duration-fast)_var(--motion-ease-enter)]";

export const menuItemClass =
  "relative flex min-h-8 cursor-default select-none items-center gap-3 px-3 py-1.5 type-body-sm text-foreground outline-none data-[highlighted]:bg-[var(--hover-strong)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-destructive [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-[var(--text-2)]";

export const menuLabelClass = "px-3 pt-2 pb-1 type-caption font-semibold text-muted-foreground";

export const menuSeparatorClass = "my-1.5 h-px bg-border";

export const menuShortcutClass = "ml-auto pl-4 type-caption tracking-wide text-muted-foreground";

export const menuIndicatorClass = "flex size-4 items-center justify-center";
