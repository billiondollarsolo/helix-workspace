import { describe, expect, it } from "vitest";
import type { AgentLimitBudget } from "../limits/types.js";
import {
  applyRateLimitOverrides,
  resolveConfirmationWithOverride,
} from "./credential-overrides.js";

const baseBudget: AgentLimitBudget = {
  requestsPerMinute: 60,
  requestsPerDay: 5_000,
  costPerDayUsdMicros: 10_000_000,
  costWarningThresholdRatio: 0.8,
};

describe("applyRateLimitOverrides", () => {
  it("returns the base budget when there are no overrides", () => {
    expect(applyRateLimitOverrides(baseBudget, undefined)).toEqual(baseBudget);
  });

  it("overrides individual limits and inherits the rest", () => {
    const result = applyRateLimitOverrides(baseBudget, { requestsPerMinute: 10 });
    expect(result.requestsPerMinute).toBe(10);
    expect(result.requestsPerDay).toBe(5_000);
    expect(result.costPerDayUsdMicros).toBe(10_000_000);
  });

  it("removes a limit when the override is explicitly null", () => {
    const result = applyRateLimitOverrides(baseBudget, { requestsPerDay: null });
    expect(result.requestsPerDay).toBeNull();
  });
});

describe("resolveConfirmationWithOverride", () => {
  it("inherits the tier decision when the override is inherit or absent", () => {
    expect(resolveConfirmationWithOverride(true, "inherit")).toBe(true);
    expect(resolveConfirmationWithOverride(false, "inherit")).toBe(false);
    expect(resolveConfirmationWithOverride(true, undefined)).toBe(true);
  });

  it("forces confirmation on with always", () => {
    expect(resolveConfirmationWithOverride(false, "always")).toBe(true);
  });

  it("forces confirmation off with never", () => {
    expect(resolveConfirmationWithOverride(true, "never")).toBe(false);
  });
});
