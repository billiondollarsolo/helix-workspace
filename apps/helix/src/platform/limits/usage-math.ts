import type { AgentCostUsage, AgentLimitBudget } from "./types.js";

// Shared pure helpers for the limiter backends. The in-memory and Redis agent
// limiters are two implementations of the same limiter contract, so their
// window/day/cost arithmetic must stay identical by construction rather than by
// two copies happening to agree.

export function pruneWindow(timestamps: number[], minimumTimestamp: number): void {
  let removeCount = 0;
  for (const timestamp of timestamps) {
    if (timestamp > minimumTimestamp) {
      break;
    }
    removeCount += 1;
  }
  if (removeCount > 0) {
    timestamps.splice(0, removeCount);
  }
}

export function costUsage(
  usedUsdMicros: number,
  budget: AgentLimitBudget,
  at: Date,
): AgentCostUsage {
  const warningThresholdUsdMicros =
    budget.costPerDayUsdMicros === null
      ? null
      : Math.floor(budget.costPerDayUsdMicros * budget.costWarningThresholdRatio);

  return {
    limitUsdMicros: budget.costPerDayUsdMicros,
    usedUsdMicros,
    remainingUsdMicros:
      budget.costPerDayUsdMicros === null
        ? null
        : Math.max(budget.costPerDayUsdMicros - usedUsdMicros, 0),
    resetsAt: nextUtcDay(at).toISOString(),
    warningThresholdUsdMicros,
    warningReached:
      warningThresholdUsdMicros !== null && usedUsdMicros >= warningThresholdUsdMicros,
  };
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
