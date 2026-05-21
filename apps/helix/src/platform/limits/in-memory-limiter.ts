import {
  resolveAgentLimitBudget,
  validateLimitBudget,
  validateNonNegativeInteger,
  type AgentCostDecision,
  type AgentCostRecordInput,
  type AgentCostUsage,
  type AgentLimitBudget,
  type AgentLimitConsumeInput,
  type AgentLimitDecision,
  type AgentLimitReason,
  type AgentLimitUsage,
  type AgentLimitUsageInput,
  type AgentRateCostLimiter,
  type AgentWindowUsage,
} from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ActorState {
  readonly minuteRequests: number[];
  readonly dayRequests: number[];
  readonly dailyCosts: Map<string, number>;
}

export class InMemoryAgentRateCostLimiter implements AgentRateCostLimiter {
  readonly #states = new Map<string, ActorState>();

  async consume(input: AgentLimitConsumeInput): Promise<AgentLimitDecision> {
    const at = input.at ?? new Date();
    const budget = input.budget ?? resolveAgentLimitBudget(input.tier);
    validateLimitBudget(budget);
    const requestCount = validateNonNegativeInteger("requestCount", input.requestCount ?? 1);
    const estimatedCostUsdMicros = validateNonNegativeInteger(
      "estimatedCostUsdMicros",
      input.estimatedCostUsdMicros ?? 0,
    );
    const state = this.#stateFor(input.orgId, input.actorId);
    this.#prune(state, at.getTime());

    const blocked = this.#blockedReason({
      state,
      budget,
      requestCount,
      estimatedCostUsdMicros,
      at,
    });
    if (blocked !== null) {
      return {
        allowed: false,
        reason: blocked.reason,
        retryAfterSeconds: blocked.retryAfterSeconds,
        usage: this.#usageFromState(state, budget, at),
      };
    }

    for (let index = 0; index < requestCount; index += 1) {
      state.minuteRequests.push(at.getTime());
      state.dayRequests.push(at.getTime());
    }

    return { allowed: true, usage: this.#usageFromState(state, budget, at) };
  }

  async recordCost(input: AgentCostRecordInput): Promise<AgentCostDecision> {
    const at = input.at ?? new Date();
    const budget = input.budget ?? resolveAgentLimitBudget(input.tier);
    validateLimitBudget(budget);
    const costUsdMicros = validateNonNegativeInteger("costUsdMicros", input.costUsdMicros);
    const state = this.#stateFor(input.orgId, input.actorId);
    const costKey = utcDayKey(at);
    state.dailyCosts.set(costKey, (state.dailyCosts.get(costKey) ?? 0) + costUsdMicros);

    const usage = costUsage(state.dailyCosts.get(costKey) ?? 0, budget, at);
    return {
      usage,
      warningReached: usage.warningReached,
      limitExceeded: usage.limitUsdMicros !== null && usage.usedUsdMicros >= usage.limitUsdMicros,
    };
  }

  async getUsage(input: AgentLimitUsageInput): Promise<AgentLimitUsage> {
    const at = input.at ?? new Date();
    const budget = input.budget ?? resolveAgentLimitBudget(input.tier);
    validateLimitBudget(budget);
    const state = this.#stateFor(input.orgId, input.actorId);
    this.#prune(state, at.getTime());
    return this.#usageFromState(state, budget, at);
  }

  reset(input: { readonly orgId: string; readonly actorId: string }): void {
    this.#states.delete(actorStateKey(input.orgId, input.actorId));
  }

  #stateFor(orgId: string, actorId: string): ActorState {
    const key = actorStateKey(orgId, actorId);
    const existing = this.#states.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const state: ActorState = {
      minuteRequests: [],
      dayRequests: [],
      dailyCosts: new Map<string, number>(),
    };
    this.#states.set(key, state);
    return state;
  }

  #prune(state: ActorState, nowMs: number): void {
    pruneWindow(state.minuteRequests, nowMs - MINUTE_MS);
    pruneWindow(state.dayRequests, nowMs - DAY_MS);
  }

  #blockedReason(input: {
    readonly state: ActorState;
    readonly budget: AgentLimitBudget;
    readonly requestCount: number;
    readonly estimatedCostUsdMicros: number;
    readonly at: Date;
  }): { readonly reason: AgentLimitReason; readonly retryAfterSeconds: number } | null {
    if (
      input.budget.requestsPerMinute !== null &&
      input.state.minuteRequests.length + input.requestCount > input.budget.requestsPerMinute
    ) {
      return {
        reason: "requests_per_minute",
        retryAfterSeconds: retryAfterSeconds(input.state.minuteRequests[0] ?? input.at.getTime(), MINUTE_MS, input.at),
      };
    }

    if (
      input.budget.requestsPerDay !== null &&
      input.state.dayRequests.length + input.requestCount > input.budget.requestsPerDay
    ) {
      return {
        reason: "requests_per_day",
        retryAfterSeconds: retryAfterSeconds(input.state.dayRequests[0] ?? input.at.getTime(), DAY_MS, input.at),
      };
    }

    const costLimit = input.budget.costPerDayUsdMicros;
    const costUsed = input.state.dailyCosts.get(utcDayKey(input.at)) ?? 0;
    if (costLimit !== null && costUsed + input.estimatedCostUsdMicros > costLimit) {
      return {
        reason: "cost_per_day",
        retryAfterSeconds: secondsUntilNextUtcDay(input.at),
      };
    }

    return null;
  }

  #usageFromState(state: ActorState, budget: AgentLimitBudget, at: Date): AgentLimitUsage {
    return {
      requestsPerMinute: windowUsage(state.minuteRequests, budget.requestsPerMinute, MINUTE_MS),
      requestsPerDay: windowUsage(state.dayRequests, budget.requestsPerDay, DAY_MS),
      costPerDay: costUsage(state.dailyCosts.get(utcDayKey(at)) ?? 0, budget, at),
    };
  }
}

function actorStateKey(orgId: string, actorId: string): string {
  return `${orgId}:${actorId}`;
}

function pruneWindow(timestamps: number[], minimumTimestamp: number): void {
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

function windowUsage(timestamps: readonly number[], limit: number | null, windowMs: number): AgentWindowUsage {
  const oldest = timestamps.at(0);
  const resetsAt = oldest === undefined ? null : new Date(oldest + windowMs).toISOString();
  return {
    limit,
    used: timestamps.length,
    remaining: limit === null ? null : Math.max(limit - timestamps.length, 0),
    resetsAt,
  };
}

function costUsage(usedUsdMicros: number, budget: AgentLimitBudget, at: Date): AgentCostUsage {
  const warningThresholdUsdMicros =
    budget.costPerDayUsdMicros === null
      ? null
      : Math.floor(budget.costPerDayUsdMicros * budget.costWarningThresholdRatio);

  return {
    limitUsdMicros: budget.costPerDayUsdMicros,
    usedUsdMicros,
    remainingUsdMicros:
      budget.costPerDayUsdMicros === null ? null : Math.max(budget.costPerDayUsdMicros - usedUsdMicros, 0),
    resetsAt: nextUtcDay(at).toISOString(),
    warningThresholdUsdMicros,
    warningReached: warningThresholdUsdMicros !== null && usedUsdMicros >= warningThresholdUsdMicros,
  };
}

function retryAfterSeconds(oldestTimestamp: number, windowMs: number, at: Date): number {
  return Math.max(1, Math.ceil((oldestTimestamp + windowMs - at.getTime()) / 1000));
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

function secondsUntilNextUtcDay(date: Date): number {
  return Math.max(1, Math.ceil((nextUtcDay(date).getTime() - date.getTime()) / 1000));
}
