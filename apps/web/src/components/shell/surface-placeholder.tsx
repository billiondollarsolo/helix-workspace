/* SurfacePlaceholder — minimal stand-in surface body.
   Each of the 10 workspace surfaces ships with this placeholder; the surface
   agents replace it with the real surface built on top of <SurfaceFrame>. */

import type { ReactNode } from "react";
import { SurfaceFrame } from "@/components/shell/surface-frame";

export interface SurfacePlaceholderProps {
  /** App id (e.g. "mail") — used for the surface title. */
  title: string;
  /** TopBar icon. */
  icon?: ReactNode;
}

export function SurfacePlaceholder({ title, icon }: SurfacePlaceholderProps) {
  return (
    <SurfaceFrame title={title} icon={icon}>
      <div className="flex-1" style={{ overflow: "auto" }}>
        <div className="empty" style={{ minHeight: "100%" }}>
          <strong style={{ fontSize: 15, color: "var(--text-2)" }}>{title}</strong>
          <div>This surface is being rebuilt on the new Helix design system.</div>
        </div>
      </div>
    </SurfaceFrame>
  );
}
