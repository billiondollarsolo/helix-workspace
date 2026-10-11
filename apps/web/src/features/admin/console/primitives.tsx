/* Shared building blocks for the admin console's pages: the page header,
 * loading, empty and error states, and the status chip.
 *
 * Every section renders inside the console's page container (see
 * `admin-console.tsx`), which supplies the scroll, padding and max-width, so a
 * page is just a `PageHeading` followed by its content. */

import { Skeleton } from "@/components/ui/skeleton";
import { InlineError } from "@/components/ui/inline-error";
import { useRef, type ReactNode } from "react";

/** Loading placeholder. `label` is announced; the shapes are decorative. */
export function LoadingState({
  label,
  variant = "text",
  count = 3,
}: {
  readonly label: string;
  readonly variant?: "row" | "card" | "text";
  readonly count?: number;
}) {
  return <Skeleton variant={variant} count={count} label={label} className="admin-loading" />;
}

/** A neutral, informational note above or beside content. */
export function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <div role="status" className="admin-notice">
      {children}
    </div>
  );
}

/** A failed action or a problem with what was entered. */
export function ErrorNotice({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <InlineError
      variant="compact"
      className="admin-error"
      message={children}
      {...(title === undefined ? {} : { title })}
    />
  );
}

/** A mutation's error, or nothing. React Query clears `error` back to `null`
 *  whenever a mutation is not in its error state. */
export function MutationError({ error }: { readonly error: Error | null }) {
  return error === null ? null : <ErrorNotice>{error.message}</ErrorNotice>;
}

/** The console's status chip: a tone class, the dot, and a label. */
export function StatusChip({
  tone,
  label,
  dot = true,
}: {
  readonly tone: string;
  readonly label: ReactNode;
  readonly dot?: boolean;
}) {
  return (
    <span className={`chip ${tone}`}>
      {dot ? <span className="chip-dot" /> : null}
      {label}
    </span>
  );
}

/** Inline "nothing here" text for a table body or panel that already has its
 *  own frame and heading. For a whole empty section, use `EmptyState`. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return <div className="admin-empty-row">{children}</div>;
}

/** What the console shows while a section's code is still loading: the page's
 *  shape, so content arriving does not shift the layout. */
export function SectionSkeleton() {
  return (
    <div className="admin-skeleton">
      <Skeleton variant="text" count={2} label="Loading section" />
      <Skeleton variant="row" count={6} label="Loading content" />
    </div>
  );
}

/** Id of the page `<h1>`. Exactly one `PageHeading` renders per admin page, so
 *  a constant is safe — and it lets a section name its own landmark from the
 *  heading rather than repeating the title in an `aria-label` that can drift
 *  away from what is on screen. */
export const ADMIN_PAGE_TITLE_ID = "admin-page-title";

export function PageHeading({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: string;
  /** One short sentence on what the page controls. */
  subtitle?: string;
  /** The page's actions; at most one uses the primary button style. */
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="admin-page-header">
      <div className="admin-page-header-row">
        <div className="admin-page-title">
          <h1 id={ADMIN_PAGE_TITLE_ID}>{title}</h1>
          {meta}
        </div>
        {actions ? <div className="admin-page-actions">{actions}</div> : null}
      </div>
      {subtitle ? <p className="admin-page-subtitle">{subtitle}</p> : null}
    </header>
  );
}

/** Heading for a part of a page, such as a tab panel or a card: an `<h2>`
 *  under the page's one `<h1>`. */
export function PanelHeading({
  title,
  subtitle,
  actions,
  id,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly id?: string;
}) {
  return (
    <div className="admin-panel-header">
      <div className="admin-panel-header-text">
        <h2 id={id}>{title}</h2>
        {subtitle === undefined ? null : <p>{subtitle}</p>}
      </div>
      {actions === undefined ? null : <div className="admin-page-actions">{actions}</div>}
    </div>
  );
}

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
   generated message tail — `Failed to load domains (503).`. When the backend
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
 *  the operator's words — "domains", "the directory", "mail routing". */
function describeFailure(error: Error, subject: string): string {
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
 *  can honestly report, the raw message to quote to support, and Retry. */
export function QueryFailureBanner({
  summary,
  subject,
  error,
  isRetrying,
  onRetry,
  children,
}: {
  readonly summary: string;
  /** Surface name used in the cause sentence. */
  readonly subject: string;
  readonly error: Error;
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
  /** What the failure costs the user here — disabled filters, hidden panels. */
  readonly children?: ReactNode;
}) {
  return (
    <InlineError
      className="admin-error"
      title={summary}
      onRetry={onRetry}
      retrying={isRetrying}
      retryLabel={isRetrying ? "Retrying…" : "Retry"}
      message={
        <span className="admin-failure-body">
          <span>{describeFailure(error, subject)}</span>
          {children === undefined ? null : <span>{children}</span>}
          <span className="admin-failure-detail mono">{error.message}</span>
        </span>
      }
    />
  );
}
