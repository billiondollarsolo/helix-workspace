import type { SecurityTier } from "@helix/sdk";

export const USD_MICROS = 1_000_000;

export type AgentLimitReason = "requests_per_minute" | "requests_per_day" | "cost_per_day";

export interface AgentLimitBudget {
  readonly requestsPerMinute: number | null;
  readonly requestsPerDay: number | null;
  readonly costPerDayUsdMicros: number | null;
  readonly costWarningThresholdRatio: number;
}

export interface AgentLimitScope {
  readonly orgId: string;
  readonly actorId: string;
  readonly tier: SecurityTier;
}

export interface AgentLimitConsumeInput extends AgentLimitScope {
  readonly budget?: AgentLimitBudget;
  readonly requestCount?: number;
  readonly estimatedCostUsdMicros?: number;
  readonly at?: Date;
}

export interface AgentCostRecordInput extends AgentLimitScope {
  readonly budget?: AgentLimitBudget;
  readonly costUsdMicros: number;
  readonly at?: Date;
}

export interface AgentLimitUsageInput extends AgentLimitScope {
  readonly budget?: AgentLimitBudget;
  readonly at?: Date;
}

export interface AgentWindowUsage {
  readonly limit: number | null;
  readonly used: number;
  readonly remaining: number | null;
  readonly resetsAt: string | null;
}

export interface AgentCostUsage {
  readonly limitUsdMicros: number | null;
  readonly usedUsdMicros: number;
  readonly remainingUsdMicros: number | null;
  readonly resetsAt: string;
  readonly warningThresholdUsdMicros: number | null;
  readonly warningReached: boolean;
}

export interface AgentLimitUsage {
  readonly requestsPerMinute: AgentWindowUsage;
  readonly requestsPerDay: AgentWindowUsage;
  readonly costPerDay: AgentCostUsage;
}

export interface AgentLimitExceeded {
  readonly allowed: false;
  readonly reason: AgentLimitReason;
  readonly retryAfterSeconds: number;
  readonly usage: AgentLimitUsage;
}

export interface AgentLimitAllowed {
  readonly allowed: true;
  readonly usage: AgentLimitUsage;
}

export type AgentLimitDecision = AgentLimitAllowed | AgentLimitExceeded;

export interface AgentCostDecision {
  readonly usage: AgentLimitUsage["costPerDay"];
  readonly warningReached: boolean;
  readonly limitExceeded: boolean;
}

export interface AgentRateCostLimiter {
  consume(input: AgentLimitConsumeInput): Promise<AgentLimitDecision>;
  recordCost(input: AgentCostRecordInput): Promise<AgentCostDecision>;
  getUsage(input: AgentLimitUsageInput): Promise<AgentLimitUsage>;
}

export const tierAgentLimitBudgets: Record<SecurityTier, AgentLimitBudget> = {
  personal: {
    requestsPerMinute: null,
    requestsPerDay: null,
    costPerDayUsdMicros: null,
    costWarningThresholdRatio: 0.8,
  },
  business: {
    requestsPerMinute: 60,
    requestsPerDay: 5_000,
    costPerDayUsdMicros: 10 * USD_MICROS,
    costWarningThresholdRatio: 0.8,
  },
  enterprise: {
    requestsPerMinute: 60,
    requestsPerDay: 5_000,
    costPerDayUsdMicros: 50 * USD_MICROS,
    costWarningThresholdRatio: 0.8,
  },
  sovereign: {
    requestsPerMinute: 30,
    requestsPerDay: 1_000,
    costPerDayUsdMicros: 0,
    costWarningThresholdRatio: 0.8,
  },
};

export function resolveAgentLimitBudget(
  tier: SecurityTier,
  override?: Partial<AgentLimitBudget>,
): AgentLimitBudget {
  const base = tierAgentLimitBudgets[tier];
  return {
    requestsPerMinute: override?.requestsPerMinute ?? base.requestsPerMinute,
    requestsPerDay: override?.requestsPerDay ?? base.requestsPerDay,
    costPerDayUsdMicros: override?.costPerDayUsdMicros ?? base.costPerDayUsdMicros,
    costWarningThresholdRatio: override?.costWarningThresholdRatio ?? base.costWarningThresholdRatio,
  };
}

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error("USD cost must be a non-negative finite number");
  }
  return Math.round(usd * USD_MICROS);
}

export function validateLimitBudget(budget: AgentLimitBudget): AgentLimitBudget {
  validateNullableInteger("requestsPerMinute", budget.requestsPerMinute);
  validateNullableInteger("requestsPerDay", budget.requestsPerDay);
  validateNullableInteger("costPerDayUsdMicros", budget.costPerDayUsdMicros);
  if (
    !Number.isFinite(budget.costWarningThresholdRatio) ||
    budget.costWarningThresholdRatio <= 0 ||
    budget.costWarningThresholdRatio > 1
  ) {
    throw new Error("costWarningThresholdRatio must be greater than 0 and less than or equal to 1");
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
