/**
 * A11 — cost limit denial via shipped in-memory limiter (tool registry path).
 */
import { describe, expect, it } from "vitest";
import { InMemoryAgentRateCostLimiter, usdToMicros } from "./index.js";

const budget = {
  requestsPerMinute: 100,
  requestsPerDay: 10_000,
  costPerDayUsdMicros: usdToMicros(1),
  costWarningThresholdRatio: 0.8,
};

describe("agent cost limit enforcement (A11)", () => {
  it("denies when estimated cost would exceed daily budget", async () => {
    const limiter = new InMemoryAgentRateCostLimiter();
    const scope = {
      orgId: "org-1",
      actorId: "agent-1",
      tier: "business" as const,
      budget,
    };
    const at = new Date("2026-08-02T12:00:00.000Z");

    const first = await limiter.consume({
      ...scope,
      at,
      estimatedCostUsdMicros: usdToMicros(0.6),
    });
    expect(first.allowed).toBe(true);
    await limiter.recordCost({ ...scope, costUsdMicros: usdToMicros(0.6), at });

    const second = await limiter.consume({
      ...scope,
      at,
      estimatedCostUsdMicros: usdToMicros(0.5),
    });
    expect(second.allowed).toBe(false);
    expect(second).toMatchObject({ reason: expect.stringMatching(/cost/i) });
  });

  it("isolates cost budgets per org (cross-tenant)", async () => {
    const limiter = new InMemoryAgentRateCostLimiter();
    const at = new Date("2026-08-02T12:00:00.000Z");
    await limiter.recordCost({
      orgId: "org-a",
      actorId: "agent-1",
      tier: "business",
      budget,
      costUsdMicros: usdToMicros(1),
      at,
    });
    const otherOrg = await limiter.consume({
      orgId: "org-b",
      actorId: "agent-1",
      tier: "business",
      budget,
      estimatedCostUsdMicros: usdToMicros(1),
      at,
    });
    expect(otherOrg.allowed).toBe(true);
  });
});
