/* Shared building blocks for the admin console's page bodies.
 *
 * Every section used to reimplement its own header, scroll container, and
 * loading/error banner — three different page headers and four different empty
 * states across one console. Layout lives in `styles.css` under `.admin-page*`
 * so it can carry a max-width and media queries; the console surface is wide,
 * and without a cap a hostname field stretches to 1350px and a toggle ends up
 * 1400px from the label it controls. */

import { useRef, type ReactNode } from "react";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";

export const INPUT_STYLE: React.CSSProperties = {
  height: 30,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  padding: "0 8px",
  fontSize: "var(--text-meta)",
};

export function StateBanner({
  kind,
  children,
}: {
  kind: "loading" | "error" | "info";
  children: ReactNode;
}) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className="admin-banner" data-kind={kind}>
      {children}
    </div>
  );
}

/** Inline "nothing here" text for a table body or panel that already has its
 *  own frame and heading. For a whole empty section, use `EmptyState`. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return <div className="admin-empty-row">{children}</div>;
}

/** The console's one empty state: what this surface holds, why it's blank, and
 *  the action that fills it. Replaces four different bare-grey-text panels. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  /** Defaults to a neutral mark; pass the section's own icon where it helps. */
  icon?: ReactNode;
  title: string;
  /** One sentence on what lives here — an empty table is not self-explanatory. */
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="admin-empty">
      <span className="admin-empty-icon" aria-hidden="true">
        {icon ?? <Icons.Circle />}
      </span>
      <p className="admin-empty-title">{title}</p>
      {children ? <p className="admin-empty-body">{children}</p> : null}
      {action ? <div className="admin-empty-action">{action}</div> : null}
    </div>
  );
}

export function PageScroll({ children }: { children: ReactNode }) {
  return (
    <div className="admin-page">
      <div className="admin-page-inner">{children}</div>
    </div>
  );
}

export function PageHeading({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="admin-page-header">
      <div className="admin-page-header-row">
        {/* Always h1: this is the page for `/admin/<section>`, and sections
            previously started at h1, h2, or h3 depending on their vintage. */}
        <h1>{title}</h1>
        {meta}
        {actions ? <div className="admin-page-actions">{actions}</div> : null}
      </div>
      {subtitle ? <p className="admin-page-subtitle">{subtitle}</p> : null}
    </header>
  );
}

export const HEADER_CELL: React.CSSProperties = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: ".06em",
};

/* ------------------------------------------------------------------ */
/* Recoverable failures                                                */
/* ------------------------------------------------------------------ */

export interface QueryFailure {
  readonly error: Error;
  readonly isRetrying: boolean;
  readonly retry: () => void;
}

/** A failure that survives its own retry.
 *
 *  React Query clears `error` and drops a data-less query back to `pending`
 *  the moment a refetch starts, so a banner rendered straight off
 *  `query.isError` disappears mid-retry and the page flashes empty. Holding
 *  the last error keeps the banner on screen until the retry actually
 *  succeeds. */
export function useQueryFailure(
  query: {
    readonly error: Error | null;
    readonly isSuccess: boolean;
    readonly isFetching: boolean;
  },
  retry: () => void,
): QueryFailure | null {
  const lastError = useRef<Error | null>(null);
  if (query.error !== null) {
    lastError.current = query.error;
  } else if (query.isSuccess) {
    lastError.current = null;
  }

  const error = lastError.current;
  if (error === null) {
    return null;
  }
  return { error, isRetrying: query.isFetching, retry };
}

/* Clients here throw plain `Error`s, so an HTTP status only survives in the
   generated message tail — `Failed to load invoices (503).`. When the backend
   sends its own `error` string instead there is no status to read, and
   guessing one would put a cause on screen that we do not actually know. */
const TRAILING_HTTP_STATUS = /\((\d{3})\)\.?$/;

function failureStatus(error: Error): number | null {
  const match = TRAILING_HTTP_STATUS.exec(error.message);
  if (match === null) {
    return null;
  }
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

/** Best honest reading of why a request failed. `subject` names the surface in
 *  the operator's words — "billing", "the directory", "mail routing". */
export function describeFailure(error: Error, subject: string): string {
  const status = failureStatus(error);
  if (status === 401 || status === 403) {
    return `Your account may not have permission to read ${subject} — ask a workspace owner for access.`;
  }
  if (status === 404) {
    return `The service returned HTTP 404; ${subject} may not be enabled for this workspace.`;
  }
  if (status !== null) {
    return `The service returned HTTP ${String(status)}, so it is reachable but not serving ${subject}.`;
  }
  return `The service did not return a usable response for ${subject} — it may be unreachable.`;
}

/** The console's one recoverable-error state: what broke, the closest cause we
 *  can honestly report, the raw message to quote to support, and a working
 *  retry. Replaces the "unavailable — try again later." dead ends, which told
 *  an operator to reload the page and gave support nothing to work with. */
export function QueryFailureBanner({
  summary,
  subject,
  error,
  isRetrying,
  onRetry,
  retryVariant = "outline",
  children,
}: {
  readonly summary: string;
  /** Surface name used in the cause sentence. */
  readonly subject: string;
  readonly error: Error;
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
  /** A page-level failure is the only action on the page; panel-level ones sit
   *  beside live content and must not outrank it. */
  readonly retryVariant?: "default" | "outline";
  /** What the failure costs the user here — disabled filters, hidden panels. */
  readonly children?: ReactNode;
}) {
  return (
    <StateBanner kind="error">
      <div className="admin-failure">
        <div className="admin-failure-body">
          <span className="admin-failure-summary">{summary}</span>
          <span>{describeFailure(error, subject)}</span>
          {children === undefined ? null : <span>{children}</span>}
          {/* The raw message is the only thing support can act on when the
              status alone does not explain the failure. */}
          <span className="admin-failure-detail mono">{error.message}</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant={retryVariant}
          disabled={isRetrying}
          onClick={onRetry}
        >
          <Icons.Refresh /> {isRetrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    </StateBanner>
  );
}

/* A sub-view's heading inside a section that already has a `PageHeading`.
   One step down in the hierarchy: same shape, smaller type, no page chrome. */
export function SubviewHeading({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0">
        <h2 className="m-0 font-semibold [font-size:var(--text-body-lg)]">{title}</h2>
        <p className="mt-1 mb-0 max-w-[76ch] text-[var(--text-3)] [font-size:var(--text-body-sm)]">
          {subtitle}
        </p>
      </div>
      {actions ? <div className="ml-auto flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}
