/* InlineError — an actionable failure message where the content would have
   been, with Retry. Use it instead of bare red text or an "Offline" label.

   <InlineError
     title="Couldn't load conversations"
     message={errorMessage(query.error)}
     onRetry={() => void query.refetch()}
     retrying={query.isFetching}
   /> */

import { CircleAlert, RotateCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface InlineErrorProps {
  /** What failed, in plain words. */
  title?: string;
  /** Why it failed or what to do next. */
  message: ReactNode;
  /** Shows a Retry button when provided. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Disables Retry and shows progress while a retry runs. */
  retrying?: boolean;
  /** Extra actions next to Retry (e.g. "Open settings"). */
  actions?: ReactNode;
  /** "banner" spans a pane; "compact" sits inside a form or panel. */
  variant?: "banner" | "compact";
  className?: string;
}

export function InlineError({
  title,
  message,
  onRetry,
  retryLabel = "Retry",
  retrying = false,
  actions,
  variant = "banner",
  className,
}: InlineErrorProps) {
  return (
    <div
      role="alert"
      data-slot="inline-error"
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius-lg)] border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[var(--danger-soft)] text-foreground",
        variant === "banner" ? "p-4" : "p-2.5",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        {title ? <p className="m-0 type-body-sm font-semibold">{title}</p> : null}
        <div className="type-body-sm text-[var(--text-2)]">{message}</div>
        {onRetry || actions ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onRetry}
                disabled={retrying}
                aria-busy={retrying || undefined}
              >
                <RotateCw
                  aria-hidden="true"
                  className={cn(retrying && "motion-safe:animate-spin")}
                />
                {retryLabel}
              </Button>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
