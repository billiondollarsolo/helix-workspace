/* Menu — the one dropdown menu primitive.

   Built on Radix DropdownMenu, which supplies the WAI-ARIA menu pattern:
   role="menu"/"menuitem*", roving focus with Arrow/Home/End, typeahead by
   item text, submenus on ArrowRight/ArrowLeft, Escape to close, and focus
   returned to the trigger. This file adds only the Helix look and the icon /
   shortcut / destructive affordances.

   <Menu>
     <MenuTrigger asChild><Button>Move to</Button></MenuTrigger>
     <MenuContent>
       <MenuItem icon={<Archive />} shortcut="e" onSelect={archive}>Archive</MenuItem>
       <MenuSub>
         <MenuSubTrigger>Label as</MenuSubTrigger>
         <MenuSubContent>…</MenuSubContent>
       </MenuSub>
     </MenuContent>
   </Menu> */

import { Check, ChevronRight, Dot } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  menuIndicatorClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
  menuShortcutClass,
  menuSurfaceClass,
} from "./menu-styles";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;
export const MenuSub = MenuPrimitive.Sub;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;

export function MenuContent({
  className,
  sideOffset = 4,
  align = "start",
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="menu-content"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cn(menuSurfaceClass, className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export interface MenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  /** Leading icon, decorative. */
  icon?: ReactNode;
  /** Keyboard shortcut hint shown at the trailing edge, e.g. "e" or "⌘⇧U". */
  shortcut?: string;
  /** Paint the item as a destructive action. */
  destructive?: boolean;
}

export function MenuItem({
  className,
  icon,
  shortcut,
  destructive = false,
  children,
  ...props
}: MenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
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
    </MenuPrimitive.Item>
  );
}

export function MenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(menuItemClass, className)} {...props}>
      <span className={menuIndicatorClass}>
        <MenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" />
        </MenuPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </MenuPrimitive.CheckboxItem>
  );
}

export function MenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(menuItemClass, className)} {...props}>
      <span className={menuIndicatorClass}>
        <MenuPrimitive.ItemIndicator>
          <Dot aria-hidden="true" className="size-6" />
        </MenuPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn(menuLabelClass, className)} {...props} />;
}

export function MenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(menuSeparatorClass, className)} {...props} />;
}

export function MenuSubTrigger({
  className,
  icon,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger> & { icon?: ReactNode }) {
  return (
    <MenuPrimitive.SubTrigger
      className={cn(menuItemClass, "data-[state=open]:bg-[var(--hover)]", className)}
      {...props}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden="true" className="ml-auto" />
    </MenuPrimitive.SubTrigger>
  );
}

export function MenuSubContent({
  className,
  sideOffset = 2,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(menuSurfaceClass, className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}
