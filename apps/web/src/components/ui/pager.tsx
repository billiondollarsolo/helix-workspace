/* Pager — "1–50 of 1,234  ‹ ›" for paged lists.

   Renders nothing for an empty list (the list shows an EmptyState instead)
   and a placeholder while the first page loads, so it never claims
   "No results" before it knows. When the server only knows there is more,
   pass `total={undefined}` with `hasMore` and the range reads "of many".

   <Pager start={0} pageSize={50} total={1234} onPrevious={prev} onNext={next} /> */

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PagerProps {
  /** Zero-based offset of the first item on this page. */
  start: number;
  /** Items on this page (the last page may be short). */
  pageCount: number;
  /** Total items, or undefined when unknown. */
  total: number | undefined;
  /** With an unknown total: whether another page exists. */
  hasMore?: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** True while the page is loading; hides the range and disables buttons. */
  loading?: boolean;
  previousLabel?: string;
  nextLabel?: string;
  className?: string;
}

const COUNT = new Intl.NumberFormat();

/** The visible range text, or null when there is nothing to page. */
export function pagerRange({
  start,
  pageCount,
  total,
}: Pick<PagerProps, "start" | "pageCount" | "total">): string | null {
  if (pageCount <= 0 || total === 0) return null;
  const first = COUNT.format(start + 1);
  const last = COUNT.format(start + pageCount);
  return `${first}–${last} of ${total === undefined ? "many" : COUNT.format(total)}`;
}

export function Pager({
  start,
  pageCount,
  total,
  hasMore = false,
  onPrevious,
  onNext,
  loading = false,
  previousLabel = "Newer",
  nextLabel = "Older",
  className,
}: PagerProps) {
  const range = pagerRange({ start, pageCount, total });
  if (!loading && range === null) return null;
  const canGoBack = !loading && start > 0;
  const canGoForward = !loading && (total === undefined ? hasMore : start + pageCount < total);

  return (
    <nav
      aria-label="Pagination"
      data-slot="pager"
      className={cn("inline-flex items-center gap-1 type-meta text-muted-foreground", className)}
    >
      <span aria-live="polite" className="tabular-nums whitespace-nowrap px-1">
        {loading ? (
          <span aria-hidden="true" className="ui-skeleton-bar inline-block h-3 w-20 rounded" />
        ) : (
          range
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={previousLabel}
        title={previousLabel}
        disabled={!canGoBack}
        onClick={onPrevious}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={nextLabel}
        title={nextLabel}
        disabled={!canGoForward}
        onClick={onNext}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </nav>
  );
}
