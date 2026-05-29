import { describe, expect, it } from "vitest";
import {
  InMemorySignupAbuseProtector,
  parseBlockedSignupEmailDomains,
  RedisSignupAbuseProtector,
  type RedisSignupRateLimitClient,
} from "./abuse.js";

describe("InMemorySignupAbuseProtector", () => {
  it("rate limits signup attempts per IP window", async () => {
    const protector = new InMemorySignupAbuseProtector({
      maxSignupsPerWindow: 2,
      windowMs: 60_000,
      clock: () => new Date("2026-05-24T00:00:00.000Z"),
    });

    await expect(
      protector.check({ email: "one@example.com", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: true,
    });
    await expect(
      protector.check({ email: "two@example.com", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: true,
    });
    await expect(
      protector.check({ email: "three@example.com", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: 60,
      limit: 2,
      windowSeconds: 60,
    });
    await expect(
      protector.check({ email: "other@example.com", ip: "203.0.113.11" }),
    ).resolves.toEqual({ allowed: true });
  });

  it("blocks configured disposable email domains after accepting a rate slot", async () => {
    const protector = new InMemorySignupAbuseProtector({
      maxSignupsPerWindow: 2,
      blockedEmailDomains: ["mailinator.test"],
    });

    await expect(
      protector.check({ email: "owner@mailinator.test", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: false,
      reason: "disposable_email_domain",
      domain: "mailinator.test",
    });
    await expect(
      protector.check({ email: "owner@example.com", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: true,
    });
    await expect(
      protector.check({ email: "third@example.com", ip: "203.0.113.10" }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "rate_limited",
    });
  });

});

describe("parseBlockedSignupEmailDomains", () => {
  it("normalizes comma-separated blocked domains", () => {
    expect(parseBlockedSignupEmailDomains(" Mailinator.Test, ,TEMPMAIL.TEST ")).toEqual([
      "mailinator.test",
      "tempmail.test",
    ]);
  });
});

describe("RedisSignupAbuseProtector", () => {
  it("rate limits signup attempts with shared Redis counters", async () => {
    const redis = new FakeRedisSignupRateLimitClient();
    const protector = new RedisSignupAbuseProtector(redis, {
      maxSignupsPerWindow: 2,
      windowMs: 60_000,
      keyPrefix: "test:signup",
    });

    await expect(
      protector.check({ email: "one@example.com", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: true,
    });
    await expect(
      protector.check({ email: "two@example.com", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: true,
    });
    await expect(
      protector.check({ email: "three@example.com", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: 60,
      limit: 2,
      windowSeconds: 60,
    });
    expect(redis.keysSeen).toContain("test:signup:203.0.113.10");
  });

  it("preserves disposable-domain blocking with Redis-backed rate slots", async () => {
    const protector = new RedisSignupAbuseProtector(new FakeRedisSignupRateLimitClient(), {
      maxSignupsPerWindow: 2,
      blockedEmailDomains: ["mailinator.test"],
    });

    await expect(
      protector.check({ email: "owner@mailinator.test", ip: "203.0.113.10" }),
    ).resolves.toEqual({
      allowed: false,
      reason: "disposable_email_domain",
      domain: "mailinator.test",
    });
  });

});

class FakeRedisSignupRateLimitClient implements RedisSignupRateLimitClient {
  readonly #counts = new Map<string, number>();
  readonly keysSeen: string[] = [];

  async evalScript(
    _script: string,
    _numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown> {
    const key = String(args[0]);
    const windowMs = Number(args[1]);
    this.keysSeen.push(key);
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    return [count, windowMs];
  }
}
