import { describe, expect, it } from "vitest";
import {
  InMemoryAgentRateCostLimiter,
  resolveAgentLimitBudget,
  usdToMicros,
  type AgentLimitBudget,
} from "./index.js";

const testBudget: AgentLimitBudget = {
  requestsPerMinute: 2,
  requestsPerDay: 3,
  costPerDayUsdMicros: usdToMicros(1),
  costWarningThresholdRatio: 0.8,
};

const scope = {
  orgId: "org-1",
  actorId: "agent-1",
  tier: "business" as const,
  budget: testBudget,
};

describe("agent rate/cost limits", () => {
  it("leaves every security tier unlimited unless an admin sets a budget", () => {
    for (const tier of ["personal", "business", "enterprise", "sovereign"] as const) {
      expect(resolveAgentLimitBudget(tier)).toMatchObject({
        requestsPerMinute: null,
        requestsPerDay: null,
        costPerDayUsdMicros: null,
      });
    }
    expect(resolveAgentLimitBudget("business", { requestsPerMinute: 60 })).toMatchObject({
      requestsPerMinute: 60,
      requestsPerDay: null,
    });
  });

  it("enforces a per-actor sliding request window with retry metadata", async () => {
    const limiter = new InMemoryAgentRateCostLimiter();
    const at = new Date("2026-05-20T12:00:00.000Z");

    expect(await limiter.consume({ ...scope, at })).toMatchObject({ allowed: true });
    expect(await limiter.consume({ ...scope, at: new Date(at.getTime() + 1_000) })).toMatchObject({
      allowed: true,
    });

    const blocked = await limiter.consume({ ...scope, at: new Date(at.getTime() + 2_000) });
    expect(blocked).toMatchObject({
      allowed: false,
      reason: "requests_per_minute",
      retryAfterSeconds: 58,
    });

    const afterWindow = await limiter.consume({ ...scope, at: new Date(at.getTime() + 60_500) });
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.usage.requestsPerMinute.used).toBe(2);
  });

  it("tracks daily actor cost, warns at 80 percent, and blocks estimated overages", async () => {
    const limiter = new InMemoryAgentRateCostLimiter();
    const at = new Date("2026-05-20T12:00:00.000Z");

    const first = await limiter.recordCost({ ...scope, costUsdMicros: usdToMicros(0.79), at });
    expect(first.warningReached).toBe(false);
    expect(first.limitExceeded).toBe(false);

    const warning = await limiter.recordCost({ ...scope, costUsdMicros: usdToMicros(0.01), at });
    expect(warning.warningReached).toBe(true);
    expect(warning.limitExceeded).toBe(false);

    const blocked = await limiter.consume({
      ...scope,
      estimatedCostUsdMicros: usdToMicros(0.21),
      at,
    });

    expect(blocked).toMatchObject({
      allowed: false,
      reason: "cost_per_day",
    });
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("still enforces an admin-configured zero-dollar cap", async () => {
    const limiter = new InMemoryAgentRateCostLimiter();

    const blocked = await limiter.consume({
      orgId: "org-1",
      actorId: "agent-2",
      tier: "sovereign",
      budget: resolveAgentLimitBudget("sovereign", { costPerDayUsdMicros: 0 }),
      estimatedCostUsdMicros: 1,
      at: new Date("2026-05-20T12:00:00.000Z"),
    });

    expect(blocked).toMatchObject({
      allowed: false,
      reason: "cost_per_day",
    });
  });
});
