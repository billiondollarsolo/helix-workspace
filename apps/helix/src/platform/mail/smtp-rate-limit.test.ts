import { describe, expect, it } from "vitest";
import { InMemorySmtpRateLimitStore } from "./smtp-rate-limit.js";

describe("InMemorySmtpRateLimitStore", () => {
  it("limits independently by scope and key, then resets the window", async () => {
    let now = 1_000;
    const limiter = new InMemorySmtpRateLimitStore({ now: () => now });
    const input = { scope: "connection" as const, key: "203.0.113.1", limit: 2, windowMs: 60_000 };
    await expect(limiter.consume(input)).resolves.toBe(true);
    await expect(limiter.consume(input)).resolves.toBe(true);
    await expect(limiter.consume(input)).resolves.toBe(false);
    await expect(limiter.consume({ ...input, scope: "message" })).resolves.toBe(true);
    await expect(limiter.consume({ ...input, key: "203.0.113.2" })).resolves.toBe(true);

    now += 60_000;
    await expect(limiter.consume(input)).resolves.toBe(true);
  });

  it("validates limits instead of silently disabling protection", async () => {
    const limiter = new InMemorySmtpRateLimitStore();
    await expect(
      limiter.consume({ scope: "message", key: "ip", limit: 0, windowMs: 1_000 }),
    ).rejects.toThrow("limit");
  });
});
