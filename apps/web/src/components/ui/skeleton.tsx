/* Skeleton — placeholder shapes while content loads, instead of "Loading…"
   text. The wrapper is one polite status region with an accessible label;
   the shapes themselves are hidden from assistive technology. The shimmer
   stops under prefers-reduced-motion (the motion tokens collapse to 0ms).

   <Skeleton variant="row" count={8} label="Loading conversations" /> */

import { cn } from "@/lib/utils";

type SkeletonVariant = "row" | "card" | "text";

export interface SkeletonProps {
  /** row: avatar + two lines (list rows); card: tile; text: paragraph lines. */
  variant?: SkeletonVariant;
  /** How many rows, cards, or lines to draw. */
  count?: number;
  /** Announced to screen readers. */
  label?: string;
  className?: string;
}

const BAR = "ui-skeleton-bar block rounded-[var(--radius)]";

/** Deterministic widths so rows do not look like a ruler. */
const WIDTHS = ["w-11/12", "w-4/5", "w-3/5", "w-5/6", "w-2/3"] as const;

function width(index: number): string {
  return WIDTHS[index % WIDTHS.length] ?? "w-full";
}

function Shape({ variant, index }: { variant: SkeletonVariant; index: number }) {
  if (variant === "text") {
    return <span className={cn(BAR, "h-3", width(index))} />;
  }
  if (variant === "card") {
    return (
      <span className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border p-3">
        <span className={cn(BAR, "aspect-[4/3] w-full")} />
        <span className={cn(BAR, "h-3", width(index))} />
        <span className={cn(BAR, "h-2.5 w-1/2")} />
      </span>
    );
  }
  return (
    <span className="flex h-[var(--rd-list-row-h)] items-center gap-3 px-[var(--rd-row-px)]">
      <span className={cn(BAR, "size-[var(--rd-avatar)] shrink-0 rounded-full")} />
      <span className={cn(BAR, "h-3 w-32 shrink-0")} />
      <span className={cn(BAR, "h-3 flex-1", width(index))} />
      <span className={cn(BAR, "h-3 w-10 shrink-0")} />
    </span>
  );
}

export function Skeleton({
  variant = "text",
  count = 3,
  label = "Loading",
  className,
}: SkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      data-slot="skeleton"
      data-variant={variant}
      className={cn(
        variant === "card"
          ? "grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3"
          : "flex flex-col",
        variant === "text" && "gap-2",
        className,
      )}
    >
      {Array.from({ length: count }, (_, index) => (
        <span key={index} aria-hidden="true" className="contents">
          <Shape variant={variant} index={index} />
        </span>
      ))}
    </div>
  );
}
