/* The admin console's shared request policy.
 *
 * Every assertion here guards a rule the console got wrong once already:
 * the 429 detector must never match a non-429 (it would turn a reported 403
 * into a silent retry loop), the release spacing must be derived from the real
 * tenant ceiling rather than the 250 ms someone guessed, and the shared
 * defaults must keep queries *returning* their errors so the console's inline
 * banners can render them. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_QUERY_DEFAULTS,
  isRateLimited,
  rateLimitBackoff,
  releaseIntervalMs,
  SECTION_REQUEST_BUDGET,
  SHELL_BASELINE_REQUESTS,
  TENANT_API_RPS_LIMIT,
} from "./request-budget";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isRateLimited", () => {
  it("matches both message tails the admin clients actually produce", () => {
    /* `parseResponse` in the schema-validating clients (security-policies-api,
       domains-api, identity-api) ends with `(429).`; the hand-rolled ones
       (admin-users, admin-services, audit-log, tier-readiness/api) end with
       `with 429`. Both are the same refusal. */
    expect(isRateLimited(new Error("Failed to load security policies (429)."))).toBe(true);
    expect(isRateLimited(new Error("Admin users failed with 429"))).toBe(true);
    expect(isRateLimited(new Error("Platform config request failed with 429"))).toBe(true);
  });

  it("does not match a backend error string that carries no trailing status", () => {
    /* This is the load-bearing half: the clients prefer the backend's own
       `error` field, so most failures arrive as prose. Matching one of those
       would add retries to — and hide — a genuine, reported failure. */
    expect(isRateLimited(new Error("Permission denied."))).toBe(false);
    expect(isRateLimited(new Error("Domain admin permission denied."))).toBe(false);
    expect(isRateLimited(new Error(""))).toBe(false);
  });

  it("does not match any other status", () => {
    expect(isRateLimited(new Error("Failed to load domains (403)."))).toBe(false);
    expect(isRateLimited(new Error("Admin services failed with 500"))).toBe(false);
    expect(isRateLimited(new Error("Failed to load users (409)."))).toBe(false);
  });
});

describe("rateLimitBackoff", () => {
  it("grows with the failure count", () => {
    /* Pinned so the growth is measured, not the jitter. */
    vi.spyOn(Math, "random").mockReturnValue(0);

    const delays = [0, 1, 2].map((failureCount) => rateLimitBackoff(failureCount));

    expect(delays[1]).toBeGreaterThan(delays[0] as number);
    expect(delays[2]).toBeGreaterThan(delays[1] as number);
  });

  it("jitters, because requests refused in the same second must not return in the same second", () => {
    const random = vi.spyOn(Math, "random");

    random.mockReturnValue(0);
    const floor = rateLimitBackoff(0);
    random.mockReturnValue(0.999);
    const ceiling = rateLimitBackoff(0);

    expect(ceiling).toBeGreaterThan(floor);
    /* Still past the limiter's one-second window at its lowest. */
    expect(floor).toBeGreaterThan(1_000);
  });
});

describe("releaseIntervalMs", () => {
  it("does not pace a section that already fits the budget", () => {
    expect(SECTION_REQUEST_BUDGET).toBe(TENANT_API_RPS_LIMIT - SHELL_BASELINE_REQUESTS);

    for (let count = 0; count <= SECTION_REQUEST_BUDGET; count += 1) {
      expect(releaseIntervalMs(count)).toBe(0);
    }
  });

  it("spaces an over-budget section so no one-second window exceeds the ceiling", () => {
    /* The arithmetic, not a remembered constant: the old hardcoded 250 ms put
       2 shell + 4 checks inside one window and earned the fourth check a 429
       on every cold load. */
    for (let count = SECTION_REQUEST_BUDGET + 1; count <= 12; count += 1) {
      const interval = releaseIntervalMs(count);
      expect(interval).toBeGreaterThan(0);
      expect(maxRequestsPerSecond(count, interval)).toBeLessThanOrEqual(SECTION_REQUEST_BUDGET);
      expect(maxRequestsPerSecond(count, interval) + SHELL_BASELINE_REQUESTS).toBeLessThanOrEqual(
        TENANT_API_RPS_LIMIT,
      );
    }
  });

  it("would fail the ceiling at the interval the console used to hardcode", () => {
    /* Guards the regression itself: 250 ms is still a plausible-looking number
       for someone to reintroduce. */
    expect(maxRequestsPerSecond(5, 250)).toBeGreaterThan(SECTION_REQUEST_BUDGET);
  });
});

describe("ADMIN_QUERY_DEFAULTS", () => {
  it("keeps the error on the query instead of throwing it to an error boundary", () => {
    /* `main.tsx` sets `throwOnError: true` globally. The console's error UX —
       `useQueryFailure` → `QueryFailureBanner` — can only run if the query
       returns its error, so this inversion must survive every refactor. */
    expect(ADMIN_QUERY_DEFAULTS.throwOnError).toBe(false);
  });

  it("retries only rate limits, and backs off when it does", () => {
    expect(ADMIN_QUERY_DEFAULTS.retry(0, new Error("Admin users failed with 429"))).toBe(true);
    expect(ADMIN_QUERY_DEFAULTS.retry(0, new Error("Permission denied."))).toBe(false);
    expect(ADMIN_QUERY_DEFAULTS.retry(0, new Error("Admin users failed with 500"))).toBe(false);
    /* Bounded: a limiter that never clears must not be retried forever. */
    expect(ADMIN_QUERY_DEFAULTS.retry(99, new Error("Admin users failed with 429"))).toBe(false);
    expect(ADMIN_QUERY_DEFAULTS.retryDelay).toBe(rateLimitBackoff);
  });
});

/** The most releases that land inside any one-second sliding window when
 *  `count` requests leave `interval` ms apart — the limiter's own accounting
 *  (`apps/helix/src/platform/limits/api-rps.ts`). */
function maxRequestsPerSecond(count: number, interval: number): number {
  const releases = Array.from({ length: count }, (_, index) => index * interval);
  return releases.reduce((worst, start) => {
    const inWindow = releases.filter((at) => at >= start && at < start + 1_000).length;
    return Math.max(worst, inWindow);
  }, 0);
}
