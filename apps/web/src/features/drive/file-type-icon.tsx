import { iconMap as Icons } from "@/components/icon-map";
import type { ReactNode } from "react";

export function FileTypeIcon({
  name,
  icon = "Doc",
  color = "var(--text-3)",
  fallback,
  aspectRatio = "4 / 3",
}: {
  readonly name: string;
  readonly icon?: keyof typeof Icons;
  readonly color?: string;
  readonly fallback?: ReactNode;
  readonly aspectRatio?: string;
}) {
  const Icon = Icons[icon];
  return (
    <div
      aria-label={`File type for ${name}`}
      className="bg-muted grid [place-items:center] [border:1px_solid_var(--border)] rounded-md w-full"
      style={{ aspectRatio, color }}
    >
      {fallback ?? <Icon size={36} />}
    </div>
  );
}
