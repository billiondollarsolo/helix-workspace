import type { AICostBudget, AICostUsage, AICostUsageWindow } from "./types.js";

/**
 * Daily-budget window arithmetic shared by every {@link AICostLimiter}
 * implementation (in-memory and Redis) and by the cost guard.
 *
 * These helpers were previously copy-pasted per limiter. Keeping one copy
 * matters for correctness, not just tidiness: the limiters must agree exactly
 * on the day boundary and on the warning threshold, otherwise swapping the
 * in-memory limiter for the Redis one would silently shift when actors are
 * warned and when their budget resets.
 *
 * Intentionally not re-exported from `costs/index.ts` — internal helper.
 */

export function usageWindow(
  usedUsdMicros: number,
  limitUsdMicros: number | null,
  warningThresholdRatio: number,
  at: Date,
): AICostUsageWindow {
  const warningThresholdUsdMicros =
    limitUsdMicros === null ? null : Math.floor(limitUsdMicros * warningThresholdRatio);
  return {
    limitUsdMicros,
    usedUsdMicros,
    remainingUsdMicros:
      limitUsdMicros === null ? null : Math.max(limitUsdMicros - usedUsdMicros, 0),
    resetsAt: nextUtcDay(at).toISOString(),
    warningThresholdUsdMicros,
    warningReached:
      warningThresholdUsdMicros !== null && usedUsdMicros >= warningThresholdUsdMicros,
  };
}

export function costUsage(
  actorUsed: number,
  featureUsed: number,
  budget: AICostBudget,
  at: Date,
): AICostUsage {
  return {
    actorDaily: usageWindow(
      actorUsed,
      budget.actorDailyUsdMicros,
      budget.warningThresholdRatio,
      at,
    ),
    featureDaily: usageWindow(
      featureUsed,
      budget.featureDailyUsdMicros,
      budget.warningThresholdRatio,
      at,
    ),
  };
}

/** True when either daily window has reached or passed its hard limit. */
export function limitExceeded(usage: AICostUsage): boolean {
  return windowExceeded(usage.actorDaily) || windowExceeded(usage.featureDaily);
}

function windowExceeded(window: AICostUsageWindow): boolean {
  return window.limitUsdMicros !== null && window.usedUsdMicros >= window.limitUsdMicros;
}

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function nextUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

export function secondsUntilNextUtcDay(date: Date): number {
  return Math.max(1, Math.ceil((nextUtcDay(date).getTime() - date.getTime()) / 1000));
}
