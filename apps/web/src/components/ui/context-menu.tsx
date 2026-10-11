/* ContextMenu — right-click menu for rows, cards, and other targets.

   Radix ContextMenu opens on the `contextmenu` event at the pointer and gives
   the same menu semantics as Menu (roving focus, typeahead, submenus). Not
   every platform turns Shift+F10 or the Menu key into a `contextmenu` event,
   so ContextMenuTrigger does it itself, opening the menu at the focused
   target's bottom-left corner. Items share the Menu look.

   <ContextMenu>
     <ContextMenuTrigger asChild><div role="row" tabIndex={0}>…</div></ContextMenuTrigger>
     <ContextMenuContent>
       <ContextMenuItem onSelect={archive}>Archive</ContextMenuItem>
     </ContextMenuContent>
   </ContextMenu> */

import { Check, ChevronRight } from "lucide-react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  menuIndicatorClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
  menuShortcutClass,
  menuSurfaceClass,
} from "./menu-styles";

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

/** True for the keyboard gestures that ask for a context menu. */
export function isContextMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey">): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

export function ContextMenuTrigger({
  onKeyDown,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !isContextMenuKey(event)) {
          return;
        }
        event.preventDefault();
        const target = event.currentTarget;
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + 8,
            clientY: rect.bottom,
          }),
        );
      }}
      {...props}
    />
  );
}

export function ContextMenuContent({
  className,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        collisionPadding={collisionPadding}
        className={cn(menuSurfaceClass, className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export interface ContextMenuItemProps extends ComponentProps<typeof ContextMenuPrimitive.Item> {
  icon?: ReactNode;
  shortcut?: string;
  destructive?: boolean;
}

export function ContextMenuItem({
  className,
  icon,
  shortcut,
  destructive = false,
  children,
  ...props
}: ContextMenuItemProps) {
  return (
    <ContextMenuPrimitive.Item
      data-variant={destructive ? "destructive" : undefined}
      className={cn(menuItemClass, className)}
      {...props}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? (
        <kbd className={menuShortcutClass} aria-hidden="true">
          {shortcut}
        </kbd>
      ) : null}
    </ContextMenuPrimitive.Item>
  );
}

export function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem className={cn(menuItemClass, className)} {...props}>
      <span className={menuIndicatorClass}>
        <ContextMenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cn(menuLabelClass, className)} {...props} />;
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator className={cn(menuSeparatorClass, className)} {...props} />
  );
}

export function ContextMenuSubTrigger({
  className,
  icon,
  children,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { icon?: ReactNode }) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(menuItemClass, "data-[state=open]:bg-[var(--hover)]", className)}
      {...props}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden="true" className="ml-auto" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        collisionPadding={collisionPadding}
        className={cn(menuSurfaceClass, className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}
