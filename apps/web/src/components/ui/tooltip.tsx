/* Tooltip — CSS-only hover label. Ported from the design handoff
   (components.jsx). Uses the `.rail-tip` style: a small dark label that fades
   in on hover. `side` controls placement relative to the trigger. */

import type { ReactNode } from "react";

export interface TooltipProps {
  /** Text shown on hover. */
  label: ReactNode;
  /** The trigger element(s). */
  children: ReactNode;
  /** Placement of the label. Defaults to "right". */
  side?: "right" | "bottom";
}

export function Tooltip({ label, children, side = "right" }: TooltipProps) {
  return (
    <span className="relative inline-flex">
      {children}
      <span
        className={
          side === "bottom" ? "rail-tip left-1/2 top-full -translate-x-1/2 mt-1.5" : "rail-tip"
        }
        role="tooltip"
      >
        {label}
      </span>
    </span>
  );
}
