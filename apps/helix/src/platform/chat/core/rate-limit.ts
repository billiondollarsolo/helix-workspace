/**
 * Pure token-bucket rate limiter (G5). Injectable clock for unit tests.
 */

export interface TokenBucketConfig {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketClock {
  now(): number;
}

const wallClock: TokenBucketClock = {
  now: () => Date.now(),
};

export function createBucket(
  config: TokenBucketConfig,
  clock: TokenBucketClock = wallClock,
): TokenBucket {
  return { tokens: config.capacity, lastRefillMs: clock.now() };
}

/** Returns true when a token was available and consumed. */
export function consumeToken(
  bucket: TokenBucket,
  config: TokenBucketConfig,
  clock: TokenBucketClock = wallClock,
): boolean {
  const now = clock.now();
  const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
  if (elapsedSeconds > 0) {
    bucket.tokens = Math.min(
      config.capacity,
      bucket.tokens + elapsedSeconds * config.refillPerSecond,
    );
    bucket.lastRefillMs = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

export const DEFAULT_CHAT_WS_RATE_LIMIT: TokenBucketConfig = {
  capacity: 30,
  refillPerSecond: 3,
};
