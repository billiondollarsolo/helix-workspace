/* The admin console's shared request policy.
 *
 * Every request outside `/api/auth` is metered against the tenant's
 * `api_rps_limit` quota — five per second on the default plan
 * (`packages/contracts/src/tenant-config.ts`), counted per org over a hard
 * one-second sliding window (`apps/helix/src/platform/limits/api-rps.ts`,
 * refusing when `state.length + 1 > limit`).
 *
 * This module exists because that policy used to live in exactly one section
 * file. `sections/overview.tsx` discovered the problem the expensive way — its
 * five checks left in the same tick, one came back 429, and because every admin
 * `queryOptions` set `retry: false` the refusal was *permanent* until the
 * operator clicked Retry. The console's front door was raising a red alarm
 * about a limit it had tripped itself, on every cold load.
 *
 * Overview then grew a release queue and a 429-only retry, and kept them
 * private. Meanwhile Billing (3 queries), Webhooks (3), Drive, Tier readiness,
 * Audit, Groups, App passwords and Agent credentials (2 each) sit at or over
 * the same ceiling once the shell's two are counted, with no retry at all. The
 * mitigation belongs where every section can reach it. */

import { useEffect, useState } from "react";
import { useQueuer } from "@tanstack/react-pacer";

/* ------------------------------------------------------------------ */
/* The budget                                                          */
/* ------------------------------------------------------------------ */

/** The tenant's default per-second request ceiling. Mirrors
 *  `api_rps_limit` in `packages/contracts/src/tenant-config.ts`. */
export const TENANT_API_RPS_LIMIT = 5;

/** What the app shell spends before a section renders anything.
 *
 *  Three, measured against a running workspace rather than counted from the
 *  source — the source undercounted twice. Overview's original comment assumed
 *  one; reading the code suggested two; a real cold load of `/admin/overview`
 *  shows three metered requests landing inside 20 ms of each other:
 *
 *    /api/core-apps                        (rail + launcher, use-enabled-apps.ts)
 *    /api/tools/notifications.unread-count (bell badge, surface-frame.tsx)
 *    /api/tools/notifications.list         (notifications panel)
 *
 *  `/api/auth/get-session` also fires twice and is genuinely exempt
 *  (`installTenantApiRpsLimitHook` skips `/api/auth/*`), which is what made the
 *  earlier estimates plausible.
 *
 *  If the shell ever stops fetching one of these, lower the number — it exists
 *  to be an honest count, and an inflated one costs every section latency it
 *  does not need to pay. */
export const SHELL_BASELINE_REQUESTS = 3;

/** How many requests a section may fire in one second without help. */
export const SECTION_REQUEST_BUDGET = TENANT_API_RPS_LIMIT - SHELL_BASELINE_REQUESTS;

/* ------------------------------------------------------------------ */
/* Rate-limit retry                                                    */
/* ------------------------------------------------------------------ */

/* 429 is the one status where retrying is the correct client behaviour: it
   means "ask again later", and the limiter's window is a single second, so a
   request that waits it out gets a real answer. Every other status is reported
   to the operator instead — auto-retrying a 403 or a 500 only hides a real
   fault behind a spinner. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 1_100;
const RATE_LIMIT_JITTER_MS = 400;

/* These clients throw plain `Error`s, so an HTTP status only survives in the
   message tail — `… (429).` from the schema-validating clients, `… with 429`
   from the hand-rolled ones. A backend `error` string ("Permission denied.")
   carries no trailing number and correctly does not match, which is why this
   only ever *adds* a retry and can never suppress a reported failure.

   Anchored on the left as well as the right. Unanchored, any message ending in
   a number whose last three digits happen to be 429 matched — "Failed to load
   audit page 1429" would have been read as a rate limit and silently retried
   three times instead of being reported. */
const TRAILING_STATUS = /(?:\((\d{3})\)|(?:^|\s)(\d{3}))\.?\s*$/u;

export function isRateLimited(error: Error): boolean {
  const match = TRAILING_STATUS.exec(error.message);
  return (match?.[1] ?? match?.[2]) === "429";
}

/** Jittered, because requests refused in the same second must not come back in
 *  the same second either — that synchronised burst is what earned the refusal
 *  in the first place. */
export function rateLimitBackoff(failureCount: number): number {
  return RATE_LIMIT_BACKOFF_MS * 2 ** failureCount + Math.random() * RATE_LIMIT_JITTER_MS;
}

function retryOnlyRateLimits(failureCount: number, error: Error): boolean {
  return failureCount < RATE_LIMIT_RETRIES && isRateLimited(error);
}

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
export const ADMIN_GC_TIME = 15 * 60_000;

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
  retry: retryOnlyRateLimits,
  retryDelay: rateLimitBackoff,
} as const;

/* ------------------------------------------------------------------ */
/* Release pacing                                                      */
/* ------------------------------------------------------------------ */

/** Spacing that keeps `count` requests inside the section budget.
 *
 *  Derived rather than guessed. Overview hardcoded 250 ms against an assumed
 *  one-request shell; with the real two-request shell that still overflows the
 *  window. */
export function releaseIntervalMs(count: number): number {
  if (count <= SECTION_REQUEST_BUDGET) {
    return 0;
  }
  /* Spread `count` releases over as many whole seconds as the budget needs,
     with a small margin so rounding cannot put one extra request in the window. */
  const seconds = Math.ceil(count / SECTION_REQUEST_BUDGET);
  return Math.ceil((seconds * 1_000) / count) + 50;
}

/** Releases queries one at a time and reports how many may start.
 *
 *  Callers gate each query on `enabled: order < released`. A disabled query
 *  still serves whatever is already in the cache, which is what makes a warm
 *  section render instantly and never wait its turn — only a genuinely cold
 *  console pays for the pacing.
 *
 *  Moved here from `sections/overview.tsx` intact. Two details are load-bearing
 *  and must not be "simplified":
 *   - `Math.max(current, order + 1)` — React remounts effects in development,
 *     so the same release can be enqueued twice and must not skip a query or
 *     count one twice.
 *   - `queue.start()` inside the effect — the unmount half of that development
 *     remount stops the queue, so a re-entered effect has to start it again or
 *     the remaining queries never leave.
 *
 *  The queue owns its timer and stops on unmount, so navigating away mid-release
 *  cannot leave requests firing at a page nobody is on (house rule
 *  `helix/pacer-discipline`: scheduled work goes through Pacer, never a bare
 *  `setTimeout`). */
export function useReleaseSchedule(count: number): number {
  const [released, setReleased] = useState(0);
  const queue = useQueuer<number>(
    (order) => {
      setReleased((current) => Math.max(current, order + 1));
    },
    { wait: releaseIntervalMs(count) },
  );

  useEffect(() => {
    queue.start();
    for (let order = 0; order < count; order += 1) {
      queue.addItem(order);
    }
  }, [count, queue]);

  return released;
}

/** What a paced check adds on top of its section's own `queryOptions`: its
 *  place in the release order. The 429 retry already comes from
 *  `ADMIN_QUERY_DEFAULTS`. */
export function pacedQueryOptions(released: number, order: number) {
  return { enabled: order < released };
}
