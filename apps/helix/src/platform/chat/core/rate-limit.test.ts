import { describe, expect, it } from "vitest";
import { consumeToken, createBucket, type TokenBucketConfig } from "./rate-limit.js";

describe("chat token-bucket rate limit", () => {
  const config: TokenBucketConfig = { capacity: 3, refillPerSecond: 1 };

  it("drains after capacity frames", () => {
    const now = 1_000;
    const clock = { now: () => now };
    const bucket = createBucket(config, clock);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(false);
  });

  it("refills at refillPerSecond as the clock advances", () => {
    let now = 0;
    const clock = { now: () => now };
    const bucket = createBucket(config, clock);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(false);

    now = 1_000; // +1s → +1 token
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(false);
  });

  it("never exceeds capacity when idle", () => {
    let now = 0;
    const clock = { now: () => now };
    const bucket = createBucket(config, clock);
    now = 60_000;
    // Consume exactly capacity after a long idle.
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(true);
    expect(consumeToken(bucket, config, clock)).toBe(false);
  });
});
