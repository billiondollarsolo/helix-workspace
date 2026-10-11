/* SplitButton — a primary action joined to a menu of alternatives, such as
   Send with "Schedule send" behind the arrow.

   Two real buttons in a labelled group: the main action, and a menu trigger
   with its own accessible name (`menuLabel`). The menu content is ordinary
   MenuItem children.

   <SplitButton label="Send" onClick={send} menuLabel="More send options">
     <MenuItem icon={<Clock />} onSelect={openSchedule}>Schedule send</MenuItem>
   </SplitButton> */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

export interface SplitButtonProps {
  /** Visible text of the main action. */
  label: ReactNode;
  /** Runs the main action. */
  onClick: () => void;
  /** Accessible name of the arrow button, e.g. "More send options". */
  menuLabel: string;
  /** MenuItem elements shown when the arrow is pressed. */
  children: ReactNode;
  /** Optional leading icon for the main action. */
  icon?: ReactNode;
  /** "primary" for the filled call to action, "secondary" for outline. */
  variant?: "primary" | "secondary";
  size?: "default" | "sm";
  /** Disables both halves. */
  disabled?: boolean;
  /** Disables only the main action, leaving the alternatives reachable. */
  actionDisabled?: boolean;
  /** Native button type of the main action. */
  type?: "button" | "submit";
  className?: string;
}

export function SplitButton({
  label,
  onClick,
  menuLabel,
  children,
  icon,
  variant = "primary",
  size = "default",
  disabled = false,
  actionDisabled = false,
  type = "button",
  className,
}: SplitButtonProps) {
  const buttonVariant = variant === "primary" ? "default" : "outline";
  return (
    <div role="group" className={cn("inline-flex items-stretch", className)}>
      <Button
        type={type}
        variant={buttonVariant}
        size={size}
        disabled={disabled || actionDisabled}
        onClick={onClick}
        className="rounded-r-none"
      >
        {icon}
        {label}
      </Button>
      <Menu>
        <MenuTrigger asChild disabled={disabled}>
          <Button
            type="button"
            variant={buttonVariant}
            size={size === "sm" ? "icon-xs" : "icon"}
            aria-label={menuLabel}
            className="w-8 rounded-l-none border-l border-l-[color-mix(in_srgb,currentColor_30%,transparent)]"
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">{children}</MenuContent>
      </Menu>
    </div>
  );
}
