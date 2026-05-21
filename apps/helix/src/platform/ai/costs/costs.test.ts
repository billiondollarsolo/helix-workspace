import { describe, expect, it } from "vitest";
import {
  InMemoryAICostLimiter,
  aiUsdToMicros,
  resolveAICostBudget,
} from "./index.js";

const scope = {
  orgId: "org-1",
  actorId: "actor-1",
  feature: "mail.compose-help",
  tier: "business" as const,
};

describe("AI cost budgets", () => {
  it("resolves PRD tier defaults", () => {
    expect(resolveAICostBudget("personal")).toMatchObject({
      actorDailyUsdMicros: null,
      featureDailyUsdMicros: null,
    });
    expect(resolveAICostBudget("business")).toMatchObject({
      actorDailyUsdMicros: aiUsdToMicros(10),
      featureDailyUsdMicros: null,
    });
    expect(resolveAICostBudget("enterprise")).toMatchObject({
      actorDailyUsdMicros: aiUsdToMicros(50),
      featureDailyUsdMicros: null,
    });
    expect(resolveAICostBudget("sovereign")).toMatchObject({
      actorDailyUsdMicros: 0,
      featureDailyUsdMicros: 0,
    });
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
