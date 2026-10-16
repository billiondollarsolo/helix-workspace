import { createAICostGuard } from "./guard.js";
import { InMemoryAICostLimitStore } from "./limit-store.js";
import { describe, expect, it } from "vitest";
import { InMemoryAICostLimiter, aiUsdToMicros, resolveAICostBudget } from "./index.js";

const scope = {
  orgId: "org-1",
  actorId: "actor-1",
  feature: "mail.compose-help",
  tier: "business" as const,
};

describe("AI cost budgets", () => {
  it("leaves every security tier unlimited unless an admin sets a budget", () => {
    for (const tier of ["personal", "business", "enterprise", "sovereign"] as const) {
      expect(resolveAICostBudget(tier)).toMatchObject({
        actorDailyUsdMicros: null,
        featureDailyUsdMicros: null,
      });
    }
    expect(
      resolveAICostBudget("business", { actorDailyUsdMicros: aiUsdToMicros(10) }),
    ).toMatchObject({ actorDailyUsdMicros: aiUsdToMicros(10), featureDailyUsdMicros: null });
  });
});

describe("InMemoryAICostLimiter", () => {
  it("hard-stops estimated calls over an actor daily budget", async () => {
    const limiter = new InMemoryAICostLimiter();
    const at = new Date("2026-05-20T12:00:00.000Z");
    await limiter.record({
      ...scope,
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.8),
      budget: { actorDailyUsdMicros: aiUsdToMicros(1) },
      at,
    });

    const decision = await limiter.check({
      ...scope,
      estimatedCostUsdMicros: aiUsdToMicros(0.21),
      budget: { actorDailyUsdMicros: aiUsdToMicros(1) },
      at,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "actor_daily_cost",
    });
    if (!decision.allowed) {
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("tracks per-feature budgets independently for the same actor", async () => {
    const limiter = new InMemoryAICostLimiter();
    const at = new Date("2026-05-20T12:00:00.000Z");
    const budget = {
      actorDailyUsdMicros: aiUsdToMicros(10),
      featureDailyUsdMicros: aiUsdToMicros(1),
    };

    await limiter.record({
      ...scope,
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.9),
      budget,
      at,
    });

    expect(
      await limiter.check({
        ...scope,
        estimatedCostUsdMicros: aiUsdToMicros(0.2),
        budget,
        at,
      }),
    ).toMatchObject({
      allowed: false,
      reason: "feature_daily_cost",
    });

    expect(
      await limiter.check({
        ...scope,
        feature: "docs.summarize",
        estimatedCostUsdMicros: aiUsdToMicros(0.2),
        budget,
        at,
      }),
    ).toMatchObject({
      allowed: true,
    });
  });

  it("emits audit-friendly cost records and dashboard summaries", async () => {
    const limiter = new InMemoryAICostLimiter();
    const at = new Date("2026-05-20T12:00:00.000Z");
    const result = await limiter.record({
      ...scope,
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.8),
      inputTokens: 100,
      outputTokens: 50,
      classification: "standard",
      trace: { traceId: "trace-1", spanId: "span-1" },
      metadata: { route: "primary" },
      budget: { actorDailyUsdMicros: aiUsdToMicros(1) },
      at,
    });

    expect(result.warningReached).toBe(true);
    expect(result.record).toMatchObject({
      orgId: "org-1",
      actorId: "actor-1",
      feature: "mail.compose-help",
      providerId: "openai",
      model: "gpt",
      costUsdMicros: aiUsdToMicros(0.8),
      inputTokens: 100,
      outputTokens: 50,
      classification: "standard",
      traceId: "trace-1",
      actorDailyUsedUsdMicros: aiUsdToMicros(0.8),
      warningReached: true,
    });

    expect(limiter.summarize({ orgId: "org-1" })).toEqual([
      {
        orgId: "org-1",
        actorId: "actor-1",
        feature: "mail.compose-help",
        costUsdMicros: aiUsdToMicros(0.8),
        inputTokens: 100,
        outputTokens: 50,
        callCount: 1,
      },
    ]);
  });
});

it("enforces saved limits immediately and reserves concurrent spending until settlement", async () => {
  const limiter = new InMemoryAICostLimiter();
  const limitStore = new InMemoryAICostLimitStore();
  const actor = { id: scope.actorId, orgId: scope.orgId, type: "user" as const };
  const guard = createAICostGuard({ limiter, limitStore, tier: "business" });
  const input = {
    actor,
    feature: scope.feature,
    providerId: "test",
    model: "test",
    estimatedCostCents: 60,
  };
  await limitStore.upsert({
    orgId: actor.orgId,
    actorId: actor.id,
    actorDailyUsdMicros: 1000000,
    featureDailyUsdMicros: null,
  });
  const results = await Promise.allSettled([guard.reserve(input), guard.reserve(input)]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  const reserved = results.find((result) => result.status === "fulfilled");
  if (reserved?.status !== "fulfilled" || !reserved.value) throw new Error("Missing reservation");
  await guard.record({ ...input, costCents: 20, reservation: reserved.value });
  expect((await limiter.getUsage(scope)).actorDaily.usedUsdMicros).toBe(200000);
  await limitStore.upsert({
    orgId: actor.orgId,
    actorId: actor.id,
    actorDailyUsdMicros: 0,
    featureDailyUsdMicros: null,
  });
  await expect(guard.reserve({ ...input, estimatedCostCents: 0 })).rejects.toThrow(
    "budget exceeded",
  );
});
