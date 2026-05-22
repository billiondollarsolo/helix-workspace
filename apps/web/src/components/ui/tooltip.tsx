/* Tooltip — CSS-only hover label. Ported from the design handoff
   (components.jsx). Uses the `.rail-tip` style: a small dark label that fades
   in on hover. `side` controls placement relative to the trigger. */

import type { CSSProperties, ReactNode } from "react";

export interface TooltipProps {
  /** Text shown on hover. */
  label: ReactNode;
  /** The trigger element(s). */
  children: ReactNode;
  /** Placement of the label. Defaults to "right". */
  side?: "right" | "bottom";
}

const wrapperStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex",
};

const bottomStyle: CSSProperties = {
  left: "50%",
  top: "100%",
  transform: "translateX(-50%)",
  marginTop: 6,
};

export function Tooltip({ label, children, side = "right" }: TooltipProps) {
  return (
    <span style={wrapperStyle}>
      {children}
      <span className="rail-tip" role="tooltip" style={side === "bottom" ? bottomStyle : undefined}>
        {label}
      </span>
    </span>
  );
}
