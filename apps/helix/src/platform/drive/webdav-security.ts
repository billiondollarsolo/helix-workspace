export interface WebDavRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface WebDavRateLimiter {
  consume(key: string, limit: number, windowMs: number): WebDavRateLimitDecision;
}

export function createWebDavRateLimiter(now: () => number = Date.now): WebDavRateLimiter {
  const buckets = new Map<string, { count: number; startsAt: number }>();
  return {
    consume(key, limit, windowMs) {
      const timestamp = now();
      const existing = buckets.get(key);
      if (existing === undefined || timestamp - existing.startsAt >= windowMs) {
        buckets.set(key, { count: 1, startsAt: timestamp });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (existing.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((existing.startsAt + windowMs - timestamp) / 1000),
          ),
        };
      }
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

export function isSecureWebDavRequest(input: {
  readonly protocol: string;
  readonly forwardedProto?: string;
}): boolean {
  const forwarded = input.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  return forwarded === "https" || (forwarded === undefined && input.protocol === "https");
}
