import type { SecurityTier } from "@helix/sdk-types";
import type { AICostBudget } from "./types.js";

export const AI_USD_MICROS = 1_000_000;

/**
 * Helix has no plan limits: no security tier carries a default AI spend cap.
 * Admin-configured budgets (`override`) still apply, and sovereign's
 * local-only AI posture is enforced by the AI routing policy.
 */
const unlimitedAICostBudget: AICostBudget = {
  actorDailyUsdMicros: null,
  featureDailyUsdMicros: null,
  warningThresholdRatio: 0.8,
};

const tierAICostBudgets: Record<SecurityTier, AICostBudget> = {
  personal: unlimitedAICostBudget,
  business: unlimitedAICostBudget,
  enterprise: unlimitedAICostBudget,
  sovereign: unlimitedAICostBudget,
};

export function resolveAICostBudget(
  tier: SecurityTier,
  override?: Partial<AICostBudget>,
): AICostBudget {
  const base = tierAICostBudgets[tier];
  return validateAICostBudget({
    actorDailyUsdMicros: override?.actorDailyUsdMicros ?? base.actorDailyUsdMicros,
    featureDailyUsdMicros: override?.featureDailyUsdMicros ?? base.featureDailyUsdMicros,
    warningThresholdRatio: override?.warningThresholdRatio ?? base.warningThresholdRatio,
  });
}

export function aiUsdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error("USD cost must be a non-negative finite number");
  }
  return Math.round(usd * AI_USD_MICROS);
}

function validateAICostBudget(budget: AICostBudget): AICostBudget {
  validateNullableInteger("actorDailyUsdMicros", budget.actorDailyUsdMicros);
  validateNullableInteger("featureDailyUsdMicros", budget.featureDailyUsdMicros);
  if (
    !Number.isFinite(budget.warningThresholdRatio) ||
    budget.warningThresholdRatio <= 0 ||
    budget.warningThresholdRatio > 1
  ) {
    throw new Error("warningThresholdRatio must be greater than 0 and less than or equal to 1");
  }
  return budget;
}

export function validateNonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function validateNullableInteger(name: string, value: number | null): void {
  if (value !== null) {
    validateNonNegativeInteger(name, value);
  }
}
