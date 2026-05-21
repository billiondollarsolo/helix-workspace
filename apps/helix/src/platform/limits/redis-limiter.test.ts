import { describe, expect, it } from "vitest";
import {
  RedisAgentRateCostLimiter,
  usdToMicros,
  type AgentLimitBudget,
  type RedisLimitClient,
} from "./index.js";

const testBudget: AgentLimitBudget = {
  requestsPerMinute: 2,
  requestsPerDay: 3,
  costPerDayUsdMicros: usdToMicros(1),
  costWarningThresholdRatio: 0.8,
};

const scope = {
  orgId: "org/redis",
  actorId: "agent{redis}",
  tier: "business" as const,
  budget: testBudget,
};

describe("RedisAgentRateCostLimiter", () => {
  it("enforces request windows against Redis script state with retry metadata", async () => {
    const redis = new FakeRedisLimitClient();
    const limiter = new RedisAgentRateCostLimiter(redis, { keyPrefix: "test:limits" });
    const at = new Date("2026-05-20T12:00:00.000Z");

    await expect(limiter.consume({ ...scope, at })).resolves.toMatchObject({
      allowed: true,
      usage: {
        requestsPerMinute: { limit: 2, used: 1, remaining: 1 },
        requestsPerDay: { limit: 3, used: 1, remaining: 2 },
      },
    });
    await expect(
      limiter.consume({ ...scope, at: new Date(at.getTime() + 1_000) }),
    ).resolves.toMatchObject({
      allowed: true,
      usage: {
        requestsPerMinute: { limit: 2, used: 2, remaining: 0 },
        requestsPerDay: { limit: 3, used: 2, remaining: 1 },
      },
    });

    const blocked = await limiter.consume({
      ...scope,
      at: new Date(at.getTime() + 2_000),
    });

    expect(blocked).toMatchObject({
      allowed: false,
      reason: "requests_per_minute",
      retryAfterSeconds: 58,
      usage: {
        requestsPerMinute: { limit: 2, used: 2, remaining: 0 },
        requestsPerDay: { limit: 3, used: 2, remaining: 1 },
      },
    });
    expect(redis.keysSeen).toContain(
      "test:limits:{org%2Fredis:agent%7Bredis%7D}:requests:minute",
    );
  });

  it("records daily cost and blocks estimated cost overages without incrementing usage", async () => {
    const redis = new FakeRedisLimitClient();
    const limiter = new RedisAgentRateCostLimiter(redis);
    const at = new Date("2026-05-20T12:00:00.000Z");

    await expect(
      limiter.recordCost({ ...scope, costUsdMicros: usdToMicros(0.79), at }),
    ).resolves.toMatchObject({
      warningReached: false,
      limitExceeded: false,
      usage: { usedUsdMicros: usdToMicros(0.79), warningReached: false },
    });
    await expect(
      limiter.recordCost({ ...scope, costUsdMicros: usdToMicros(0.01), at }),
    ).resolves.toMatchObject({
      warningReached: true,
      limitExceeded: false,
      usage: { usedUsdMicros: usdToMicros(0.8), warningReached: true },
    });

    const blocked = await limiter.consume({
      ...scope,
      estimatedCostUsdMicros: usdToMicros(0.21),
      at,
    });

    expect(blocked).toMatchObject({
      allowed: false,
      reason: "cost_per_day",
      usage: {
        costPerDay: {
          limitUsdMicros: usdToMicros(1),
          usedUsdMicros: usdToMicros(0.8),
          remainingUsdMicros: usdToMicros(0.2),
          warningReached: true,
        },
      },
    });
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBe(43_200);
    }

    await expect(limiter.getUsage({ ...scope, at })).resolves.toMatchObject({
      requestsPerMinute: { used: 0, resetsAt: null },
      requestsPerDay: { used: 0, resetsAt: null },
      costPerDay: {
        usedUsdMicros: usdToMicros(0.8),
        resetsAt: "2026-05-21T00:00:00.000Z",
      },
    });
  });
});

class FakeRedisLimitClient implements RedisLimitClient {
  readonly keysSeen: string[] = [];
  readonly #sortedSets = new Map<string, Map<string, number>>();
  readonly #strings = new Map<string, number>();
  readonly #ttlSeconds = new Map<string, number>();

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys).map(String);
    this.keysSeen.push(...keys);
    const argv = args.slice(numberOfKeys);
    if (script.includes("request_count")) {
      return this.consume(keys, argv);
    }
    if (script.includes("INCRBY")) {
      return this.recordCost(keys, argv);
    }
    return this.usage(keys, argv);
  }

  private consume(keys: readonly string[], argv: readonly (string | number)[]): unknown[] {
    const minuteKey = redisKey(keys, 0);
    const dayKey = redisKey(keys, 1);
    const costKey = redisKey(keys, 2);
    const nowMs = Number(argv[0]);
    const minuteWindowMs = Number(argv[1]);
    const dayWindowMs = Number(argv[2]);
    const minuteLimit = Number(argv[3]);
    const dayLimit = Number(argv[4]);
    const requestCount = Number(argv[5]);
    const estimatedCost = Number(argv[6]);
    const costLimit = Number(argv[7]);
    const costTtlSeconds = Number(argv[8]);
    const memberBase = String(argv[9]);

    this.prune(minuteKey, nowMs, minuteWindowMs);
    this.prune(dayKey, nowMs, dayWindowMs);

    const minuteUsed = this.zcard(minuteKey);
    const dayUsed = this.zcard(dayKey);
    const costUsed = this.#strings.get(costKey) ?? 0;

    if (minuteLimit >= 0 && minuteUsed + requestCount > minuteLimit) {
      return [
        0,
        "requests_per_minute",
        this.retryAfter(minuteKey, minuteWindowMs, nowMs),
        minuteUsed,
        dayUsed,
        costUsed,
      ];
    }
    if (dayLimit >= 0 && dayUsed + requestCount > dayLimit) {
      return [
        0,
        "requests_per_day",
        this.retryAfter(dayKey, dayWindowMs, nowMs),
        minuteUsed,
        dayUsed,
        costUsed,
      ];
    }
    if (costLimit >= 0 && costUsed + estimatedCost > costLimit) {
      return [
        0,
        "cost_per_day",
        this.ttl(costKey) ?? costTtlSeconds,
        minuteUsed,
        dayUsed,
        costUsed,
      ];
    }

    for (let index = 1; index <= requestCount; index += 1) {
      this.zadd(minuteKey, nowMs, `${memberBase}:${String(index)}`);
      this.zadd(dayKey, nowMs, `${memberBase}:${String(index)}`);
    }

    return [1, "", 0, minuteUsed + requestCount, dayUsed + requestCount, costUsed];
  }

  private recordCost(keys: readonly string[], argv: readonly (string | number)[]): number {
    const costKey = redisKey(keys, 0);
    const increment = Number(argv[0]);
    const ttlSeconds = Number(argv[1]);
    const used = (this.#strings.get(costKey) ?? 0) + increment;
    this.#strings.set(costKey, used);
    if (ttlSeconds > 0 && !this.#ttlSeconds.has(costKey)) {
      this.#ttlSeconds.set(costKey, ttlSeconds);
    }
    return used;
  }

  private usage(keys: readonly string[], argv: readonly (string | number)[]): unknown[] {
    const minuteKey = redisKey(keys, 0);
    const dayKey = redisKey(keys, 1);
    const costKey = redisKey(keys, 2);
    const nowMs = Number(argv[0]);
    const minuteWindowMs = Number(argv[1]);
    const dayWindowMs = Number(argv[2]);

    this.prune(minuteKey, nowMs, minuteWindowMs);
    this.prune(dayKey, nowMs, dayWindowMs);

    return [
      this.zcard(minuteKey),
      this.oldestScore(minuteKey) ?? "",
      this.zcard(dayKey),
      this.oldestScore(dayKey) ?? "",
      this.#strings.get(costKey) ?? 0,
    ];
  }

  private zadd(key: string, score: number, member: string): void {
    const set = this.#sortedSets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.#sortedSets.set(key, set);
  }

  private zcard(key: string): number {
    return this.#sortedSets.get(key)?.size ?? 0;
  }

  private prune(key: string, nowMs: number, windowMs: number): void {
    const set = this.#sortedSets.get(key);
    if (set === undefined) {
      return;
    }
    for (const [member, score] of set) {
      if (score <= nowMs - windowMs) {
        set.delete(member);
      }
    }
  }

  private retryAfter(key: string, windowMs: number, nowMs: number): number {
    const oldest = this.oldestScore(key);
    if (oldest === undefined) {
      return 1;
    }
    return Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
  }

  private oldestScore(key: string): number | undefined {
    const scores = [...(this.#sortedSets.get(key)?.values() ?? [])];
    return scores.length === 0 ? undefined : Math.min(...scores);
  }

  private ttl(key: string): number | undefined {
    return this.#ttlSeconds.get(key);
  }
}

function redisKey(keys: readonly string[], index: number): string {
  const key = keys[index];
  if (key === undefined) {
    throw new Error(`Fake Redis script missing key ${String(index)}`);
  }
  return key;
}
