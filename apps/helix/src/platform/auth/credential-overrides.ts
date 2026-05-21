import type { AgentLimitBudget } from "../limits/types.js";
import type { ConfirmationOverride, RateLimitOverrides } from "./credentials.js";

/**
 * Bridges per-credential policy overrides (PRD §9.2) into the platform's
 * confirmation gate and rate / cost limiter so they actually affect the
 * request path.
 */

/**
 * Apply a credential's {@link RateLimitOverrides} on top of a tier budget.
 * `undefined` override fields inherit the tier value; explicit `null` removes
 * the limit. The result is a partial budget suitable for passing as the
 * `agentLimitBudget` override to the tool registry / rate limiter.
 */
export function applyRateLimitOverrides(
  base: AgentLimitBudget,
  overrides: RateLimitOverrides | undefined,
): AgentLimitBudget {
  if (overrides === undefined) {
    return base;
  }
  return {
    requestsPerMinute:
      overrides.requestsPerMinute === undefined
        ? base.requestsPerMinute
        : overrides.requestsPerMinute,
    requestsPerDay:
      overrides.requestsPerDay === undefined ? base.requestsPerDay : overrides.requestsPerDay,
    costPerDayUsdMicros:
      overrides.costPerDayUsdMicros === undefined
        ? base.costPerDayUsdMicros
        : overrides.costPerDayUsdMicros,
    costWarningThresholdRatio: base.costWarningThresholdRatio,
  };
}

/**
 * Resolve whether a side-effecting tool invocation must be confirmed, given
 * the tier's default decision and a credential's {@link ConfirmationOverride}.
 *
 * - `"always"` forces confirmation on.
 * - `"never"` forces confirmation off.
 * - `"inherit"` keeps the tier default.
 */
export function resolveConfirmationWithOverride(
  tierRequiresConfirmation: boolean,
  override: ConfirmationOverride | undefined,
): boolean {
  switch (override) {
    case "always":
      return true;
    case "never":
      return false;
    case "inherit":
    case undefined:
      return tierRequiresConfirmation;
  }
}
