// Read queries may recover from a tenant rate limit; other failures remain visible.
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 1_100;
const RATE_LIMIT_JITTER_MS = 400;

// Legacy clients retain status only in their message tail. Match whole status
// tokens so a resource number such as 1429 cannot trigger a retry.
const TRAILING_STATUS = /(?:\((\d{3})\)|(?:^|\s)(\d{3}))\.?\s*$/u;

export function isRateLimited(error: Error): boolean {
  if ("status" in error && typeof error.status === "number") return error.status === 429;
  const match = TRAILING_STATUS.exec(error.message);
  return (match?.[1] ?? match?.[2]) === "429";
}

/** Wait at least Retry-After, with exponential jitter to spread refused bursts. */
export function rateLimitBackoff(failureCount: number, error?: Error): number {
  const delay = RATE_LIMIT_BACKOFF_MS * 2 ** failureCount;
  const retryAfter =
    error !== undefined &&
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number" &&
    Number.isFinite(error.retryAfterMs)
      ? error.retryAfterMs
      : 0;
  return Math.max(delay, retryAfter) + Math.random() * RATE_LIMIT_JITTER_MS;
}

function retryOnlyRateLimits(failureCount: number, error: Error): boolean {
  return failureCount < RATE_LIMIT_RETRIES && isRateLimited(error);
}

export const QUERY_RETRY_DEFAULTS = {
  retry: retryOnlyRateLimits,
  retryDelay: rateLimitBackoff,
} as const;
