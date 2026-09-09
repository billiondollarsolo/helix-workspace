import type { ReactNode } from "react";
import { Icons } from "@/components/icons";

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
      style={{
        aspectRatio,
        background: "var(--surface-2)",
        display: "grid",
        placeItems: "center",
        color,
        border: "1px solid var(--border)",
        borderRadius: 6,
        width: "100%",
      }}
    >
      {fallback ?? <Icon size={36} />}
    </div>
  );
}
