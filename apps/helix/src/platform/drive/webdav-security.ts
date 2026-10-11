interface WebDavRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface WebDavRateLimiter {
  consume(key: string, limit: number, windowMs: number): WebDavRateLimitDecision;
  /** Reports whether `key` is exhausted without spending from the bucket. */
  peek(key: string, limit: number, windowMs: number): WebDavRateLimitDecision;
}

export function createWebDavRateLimiter(now: () => number = Date.now): WebDavRateLimiter {
  const buckets = new Map<string, { count: number; startsAt: number }>();
  const exhausted = (key: string, limit: number, windowMs: number, timestamp: number) => {
    const existing = buckets.get(key);
    if (existing === undefined || timestamp - existing.startsAt >= windowMs) return null;
    if (existing.count < limit) return null;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.startsAt + windowMs - timestamp) / 1000)),
    };
  };
  return {
    peek(key, limit, windowMs) {
      return exhausted(key, limit, windowMs, now()) ?? { allowed: true, retryAfterSeconds: 0 };
    },
    consume(key, limit, windowMs) {
      const timestamp = now();
      const existing = buckets.get(key);
      if (existing === undefined || timestamp - existing.startsAt >= windowMs) {
        buckets.set(key, { count: 1, startsAt: timestamp });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const denied = exhausted(key, limit, windowMs, timestamp);
      if (denied !== null) return denied;
      existing.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

export function isSecureWebDavRequest(input: {
  readonly protocol: string;
  readonly forwardedProto?: string;
}): boolean {
  return input.protocol === "https";
}
