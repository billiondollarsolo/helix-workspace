import { describe, expect, it } from "vitest";
import {
  InMemoryTenantApiRpsLimiter,
  normalizeApiRpsLimit,
  RedisTenantApiRpsLimiter,
} from "./index.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("Tenant API RPS limiters", () => {
  it("enforces a per-tenant one-second window in memory", async () => {
    const limiter = new InMemoryTenantApiRpsLimiter();
    const at = new Date("2026-05-24T12:00:00.000Z");

    await expect(limiter.consume({ orgId, limit: 1, at })).resolves.toMatchObject({
      allowed: true,
      limit: 1,
      used: 1,
      remaining: 0,
    });

    await expect(
      limiter.consume({ orgId, limit: 1, at: new Date(at.getTime() + 100) }),
    ).resolves.toMatchObject({
      allowed: false,
      limit: 1,
      used: 1,
      remaining: 0,
      retryAfterSeconds: 1,
    });

    await expect(
      limiter.consume({ orgId, limit: 1, at: new Date(at.getTime() + 1_100) }),
    ).resolves.toMatchObject({ allowed: true, used: 1 });
  });

  it("treats a null tenant API RPS limit as unlimited", async () => {
    const limiter = new InMemoryTenantApiRpsLimiter();
    const at = new Date("2026-05-24T12:00:00.000Z");

    await limiter.consume({ orgId, limit: null, at });
    await expect(limiter.consume({ orgId, limit: null, at })).resolves.toMatchObject({
      allowed: true,
      limit: null,
      used: 2,
      remaining: null,
    });
  });

  it("rejects invalid tenant API RPS limits", () => {
    expect(() => normalizeApiRpsLimit(-1)).toThrow("api_rps_limit");
    expect(() => normalizeApiRpsLimit(1.5)).toThrow("api_rps_limit");
  });

  it("uses Redis with an org-scoped key and one-second window", async () => {
    const calls: unknown[][] = [];
    const redis = {
      async eval(...args: unknown[]) {
        calls.push(args);
        return [0, 2, 1];
      },
    };
    const limiter = new RedisTenantApiRpsLimiter(redis, { keyPrefix: "test:rps" });

    await expect(
      limiter.consume({
        orgId: "org.with spaces",
        limit: 2,
        at: new Date("2026-05-24T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      allowed: false,
      limit: 2,
      used: 2,
      retryAfterSeconds: 1,
    });

    expect(calls[0]?.[1]).toBe(1);
    expect(calls[0]?.[2]).toBe("test:rps:{org_with_spaces}");
    expect(calls[0]?.[5]).toBe(2);
  });

  it("uses unique Redis sorted-set members for same-millisecond requests", async () => {
    const calls: unknown[][] = [];
    const redis = {
      async eval(...args: unknown[]) {
        calls.push(args);
        return [1, calls.length, 0];
      },
    };
    const limiter = new RedisTenantApiRpsLimiter(redis);
    const at = new Date("2026-05-24T12:00:00.000Z");

    await limiter.consume({ orgId, limit: 5, at });
    await limiter.consume({ orgId, limit: 5, at });

    expect(calls[0]?.[6]).toEqual(expect.stringMatching(/^1779624000000:/u));
    expect(calls[1]?.[6]).toEqual(expect.stringMatching(/^1779624000000:/u));
    expect(calls[0]?.[6]).not.toBe(calls[1]?.[6]);
  });
});
