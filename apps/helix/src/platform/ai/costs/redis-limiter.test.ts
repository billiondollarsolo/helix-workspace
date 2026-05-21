import { describe, expect, it } from "vitest";
import { aiUsdToMicros } from "./budget.js";
import {
  createAICostGuard,
  type AICostWarningEvent,
} from "./guard.js";
import {
  InMemoryAICostLimitStore,
  type AICostLimitStore,
} from "./limit-store.js";
import {
  RedisAICostLimiter,
  ioredisAICostClient,
  type RedisAICostClient,
} from "./redis-limiter.js";

const scope = {
  orgId: "org-1",
  actorId: "actor-1",
  feature: "mail.compose-help",
  tier: "business" as const,
};

const budget = {
  actorDailyUsdMicros: aiUsdToMicros(1),
  featureDailyUsdMicros: aiUsdToMicros(0.5),
  warningThresholdRatio: 0.8,
};

describe("RedisAICostLimiter", () => {
  it("records durable spend and blocks estimated overages on the actor budget", async () => {
    const redis = new FakeRedisAICostClient();
    const limiter = new RedisAICostLimiter(redis, { keyPrefix: "test:ai-cost" });
    const at = new Date("2026-05-21T12:00:00.000Z");

    await limiter.record({
      ...scope,
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.9),
      budget,
      at,
    });

    const blocked = await limiter.check({
      ...scope,
      estimatedCostUsdMicros: aiUsdToMicros(0.2),
      budget,
      at,
    });
    expect(blocked).toMatchObject({ allowed: false, reason: "actor_daily_cost" });
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(redis.keysSeen.some((key) => key.includes("test:ai-cost"))).toBe(true);
  });

  it("tracks feature budgets independently from the actor budget", async () => {
    const redis = new FakeRedisAICostClient();
    const limiter = new RedisAICostLimiter(redis);
    const at = new Date("2026-05-21T12:00:00.000Z");

    await limiter.record({
      ...scope,
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.45),
      budget,
      at,
    });

    expect(
      await limiter.check({ ...scope, estimatedCostUsdMicros: aiUsdToMicros(0.1), budget, at }),
    ).toMatchObject({ allowed: false, reason: "feature_daily_cost" });

    expect(
      await limiter.check({
        ...scope,
        feature: "docs.summarize",
        estimatedCostUsdMicros: aiUsdToMicros(0.1),
        budget,
        at,
      }),
    ).toMatchObject({ allowed: true });
  });

  it("reports warning and limit flags on the record result", async () => {
    const redis = new FakeRedisAICostClient();
    const limiter = new RedisAICostLimiter(redis);
    const at = new Date("2026-05-21T12:00:00.000Z");

    const first = await limiter.record({
      ...scope,
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.79),
      budget: { ...budget, featureDailyUsdMicros: null },
      at,
    });
    expect(first.warningReached).toBe(false);

    const second = await limiter.record({
      ...scope,
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.05),
      budget: { ...budget, featureDailyUsdMicros: null },
      at,
    });
    expect(second.warningReached).toBe(true);
    expect(second.limitExceeded).toBe(false);

    const usage = await limiter.getUsage({
      ...scope,
      budget: { ...budget, featureDailyUsdMicros: null },
      at,
    });
    expect(usage.actorDaily.usedUsdMicros).toBe(aiUsdToMicros(0.84));
  });

  it("adapts an ioredis-style client through ioredisAICostClient", async () => {
    const calls: unknown[][] = [];
    const fakeIoredis = {
      eval: (...args: unknown[]) => {
        calls.push(args);
        // GET returns nil for fresh keys; INCRBY returns the running total.
        return Promise.resolve([0, 0]);
      },
    };
    const client = ioredisAICostClient(fakeIoredis);
    await client.evalScript("return 1", 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("return 1");
  });
});

describe("AI cost warning notification", () => {
  it("fires the warning callback once per actor per day when the 80% threshold trips", async () => {
    const redis = new FakeRedisAICostClient();
    const limiter = new RedisAICostLimiter(redis);
    const warnings: AICostWarningEvent[] = [];
    const at = new Date("2026-05-21T12:00:00.000Z");
    const guard = createAICostGuard({
      limiter,
      tier: "business",
      budget: { actorDailyUsdMicros: aiUsdToMicros(1), featureDailyUsdMicros: null },
      now: () => at,
      onWarning: (event) => {
        warnings.push(event);
      },
    });
    const actor = { id: "actor-1", orgId: "org-1", type: "user" as const };

    // 50 cents spent of a 1 USD budget; below the 80% threshold => no warning.
    await guard.record({
      actor,
      feature: "mail.compose-help",
      providerId: "openai",
      model: "gpt",
      costCents: 50,
    });
    expect(warnings).toHaveLength(0);

    // Crosses 80% (85 cents spent of a 1 USD budget) => warning fires.
    await guard.record({
      actor,
      feature: "mail.compose-help",
      providerId: "openai",
      model: "gpt",
      costCents: 35,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.actor.id).toBe("actor-1");

    // Further spend the same day does not re-fire the warning.
    await guard.record({
      actor,
      feature: "mail.compose-help",
      providerId: "openai",
      model: "gpt",
      costCents: 5,
    });
    expect(warnings).toHaveLength(1);
  });
});

describe("AICostLimitStore", () => {
  it("upserts, reads, lists, and removes per-user overrides", async () => {
    const store: AICostLimitStore = new InMemoryAICostLimitStore();
    await store.upsert({
      orgId: "org-1",
      actorId: "actor-1",
      actorDailyUsdMicros: aiUsdToMicros(25),
      featureDailyUsdMicros: null,
      updatedByActorId: "admin-1",
    });

    expect(await store.get({ orgId: "org-1", actorId: "actor-1" })).toMatchObject({
      actorDailyUsdMicros: aiUsdToMicros(25),
      featureDailyUsdMicros: null,
      updatedByActorId: "admin-1",
    });
    expect(await store.list({ orgId: "org-1" })).toHaveLength(1);
    expect(await store.remove({ orgId: "org-1", actorId: "actor-1" })).toBe(true);
    expect(await store.get({ orgId: "org-1", actorId: "actor-1" })).toBeNull();
  });
});

/**
 * Minimal in-memory fake of the Redis surface used by the AI cost limiter.
 * Interprets the three Lua scripts (`check`, `record`, `usage`) by content.
 */
class FakeRedisAICostClient implements RedisAICostClient {
  readonly keysSeen: string[] = [];
  readonly #strings = new Map<string, number>();

  async evalScript(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys).map(String);
    this.keysSeen.push(...keys);
    const argv = args.slice(numberOfKeys);
    if (script.includes("INCRBY")) {
      return this.record(keys, argv);
    }
    if (script.includes("estimated")) {
      return this.check(keys, argv);
    }
    return this.usage(keys);
  }

  private check(keys: readonly string[], argv: readonly (string | number)[]): unknown[] {
    const actorUsed = this.#strings.get(String(keys[0])) ?? 0;
    const featureUsed = this.#strings.get(String(keys[1])) ?? 0;
    const actorLimit = Number(argv[0]);
    const featureLimit = Number(argv[1]);
    const estimated = Number(argv[2]);
    if (actorLimit >= 0 && actorUsed + estimated > actorLimit) {
      return [0, "actor_daily_cost", actorUsed, featureUsed];
    }
    if (featureLimit >= 0 && featureUsed + estimated > featureLimit) {
      return [0, "feature_daily_cost", actorUsed, featureUsed];
    }
    return [1, "", actorUsed, featureUsed];
  }

  private record(keys: readonly string[], argv: readonly (string | number)[]): unknown[] {
    const cost = Number(argv[0]);
    const actorKey = String(keys[0]);
    const featureKey = String(keys[1]);
    const actorUsed = (this.#strings.get(actorKey) ?? 0) + cost;
    const featureUsed = (this.#strings.get(featureKey) ?? 0) + cost;
    this.#strings.set(actorKey, actorUsed);
    this.#strings.set(featureKey, featureUsed);
    return [actorUsed, featureUsed];
  }

  private usage(keys: readonly string[]): unknown[] {
    return [
      this.#strings.get(String(keys[0])) ?? 0,
      this.#strings.get(String(keys[1])) ?? 0,
    ];
  }
}
