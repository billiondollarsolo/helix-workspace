import { QUERY_RETRY_DEFAULTS } from "@/lib/query-retry";

/* Mirrors the verified-human browser allowance. Integration API quotas do not
 * delay browser queries; ordinary page loads fit in one burst. */
export const CLIENT_STARTUP_REQUEST_BUDGET = 120;
export const CLIENT_REQUEST_WINDOW_MS = 10_000;

/** What the app shell spends before a section renders anything.
 *
 *  Two shared queries run on a cold load with the notifications panel closed:
 *
 *    /api/core-apps                        (rail + launcher, use-enabled-apps.ts)
 *    /api/tools/notifications.unread-count (bell badge, surface-frame.tsx)
 *
 *  The feed loads when opened. Session reads are exempt from this limit. */
export const SHELL_BASELINE_REQUESTS = 2;

/** How many requests a section may fire in one second without help. */
export const SECTION_REQUEST_BUDGET = CLIENT_STARTUP_REQUEST_BUDGET - SHELL_BASELINE_REQUESTS;

/* ------------------------------------------------------------------ */
/* Freshness tiers                                                     */
/* ------------------------------------------------------------------ */

/** Named rather than a literal per file. Ten modules said 30s, one said 5s,
 *  one said 60s, three said 15s and eleven said nothing at all — with no stated
 *  reason for any of it. These three names carry the reason. */
export const ADMIN_STALE_TIME = {
  /** Changes on its own between two glances — kill switches, live status. */
  volatile: 5_000,
  /** Normal operator data: directories, policies, configuration. */
  normal: 30_000,
  /** Catalogues and capability lists that change on deploys, not on use. */
  static: 60_000,
} as const;

/** TanStack's default is 5 minutes, which means a section revisited after a
 *  coffee is fully cold and re-fires its whole burst against the same ceiling.
 *  An admin console is a place operators leave open and come back to. */
const ADMIN_GC_TIME = 15 * 60_000;

/* ------------------------------------------------------------------ */
/* Shared query defaults                                               */
/* ------------------------------------------------------------------ */

/** Spread first in every admin `queryOptions` factory.
 *
 *  `throwOnError: false` is here because the global default in `main.tsx` is
 *  `true`, and that default is inverted for this whole feature area: the
 *  console's error UX (`useQueryFailure` → `QueryFailureBanner` →
 *  `describeFailure`, in `console/primitives.tsx`) can only run if the query
 *  *returns* its error instead of throwing it to an error boundary. Twenty-four
 *  factories used to opt out one line at a time, so the global default only
 *  ever fired for a factory someone forgot — turning an inline banner with a
 *  Retry button into "the whole admin surface is replaced by an error page",
 *  silently, with nothing in the type system to catch it. */
export const ADMIN_QUERY_DEFAULTS = {
  throwOnError: false,
  gcTime: ADMIN_GC_TIME,
  staleTime: ADMIN_STALE_TIME.normal,
  ...QUERY_RETRY_DEFAULTS,
} as const;

/* ------------------------------------------------------------------ */
/* Release pacing                                                      */
/* ------------------------------------------------------------------ */

/** Pace only batches larger than a full browser request window. */
export function releaseIntervalMs(count: number): number {
  if (count <= SECTION_REQUEST_BUDGET) return 0;
  const windows = Math.ceil(count / SECTION_REQUEST_BUDGET);
  return Math.ceil((windows * CLIENT_REQUEST_WINDOW_MS) / count) + 50;
}
