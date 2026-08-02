import { describe, expect, it } from "vitest";
import { LOAD_SOAK_BUDGETS, evaluateLoadSoakMeasurement } from "./load-soak-budget.mjs";

describe("load/soak budget (V3)", () => {
  it("exports budgets and fails over-threshold measurements", () => {
    expect(LOAD_SOAK_BUDGETS.apiP95Ms).toBe(500);
    const fail = evaluateLoadSoakMeasurement({
      apiP95Ms: 900,
      errorRate: 0.05,
      durationMinutes: 5,
      successfulRequests: 10,
    });
    expect(fail.ok).toBe(false);
    expect(fail.reasons.length).toBeGreaterThan(0);
  });

  it("passes in-budget synthetic measurement", () => {
    const pass = evaluateLoadSoakMeasurement({
      apiP95Ms: 200,
      apiP99Ms: 400,
      errorRate: 0.001,
      durationMinutes: 45,
      successfulRequests: 5_000,
    });
    expect(pass.ok).toBe(true);
    expect(pass.reasons).toEqual([]);
  });
});
