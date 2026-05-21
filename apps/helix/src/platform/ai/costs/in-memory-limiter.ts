import { randomUUID } from "node:crypto";
import {
  resolveAICostBudget,
  validateNonNegativeInteger,
} from "./budget.js";
import type {
  AICostBudget,
  AICostLimitCheckInput,
  AICostLimitDecision,
  AICostLimiter,
  AICostRecord,
  AICostRecordInput,
  AICostRecordResult,
  AICostSummaryQuery,
  AICostSummaryRow,
  AICostUsage,
  AICostUsageInput,
  AICostUsageWindow,
} from "./types.js";

export class InMemoryAICostLimiter implements AICostLimiter {
  readonly #actorDailyCosts = new Map<string, number>();
  readonly #featureDailyCosts = new Map<string, number>();
  readonly #records: AICostRecord[] = [];

  async check(input: AICostLimitCheckInput): Promise<AICostLimitDecision> {
    const at = input.at ?? new Date();
    const budget = resolveAICostBudget(input.tier, input.budget);
    const estimatedCostUsdMicros = validateNonNegativeInteger(
      "estimatedCostUsdMicros",
      input.estimatedCostUsdMicros ?? 0,
    );
    const actorUsed = this.#actorUsed(input.orgId, input.actorId, at);
    const featureUsed = this.#featureUsed(input.orgId, input.actorId, input.feature, at);
    const usage = costUsage({ actorUsed, featureUsed, budget, at });

    if (budget.actorDailyUsdMicros !== null && actorUsed + estimatedCostUsdMicros > budget.actorDailyUsdMicros) {
      return {
        allowed: false,
        reason: "actor_daily_cost",
        retryAfterSeconds: secondsUntilNextUtcDay(at),
        usage,
      };
    }

    if (budget.featureDailyUsdMicros !== null && featureUsed + estimatedCostUsdMicros > budget.featureDailyUsdMicros) {
      return {
        allowed: false,
        reason: "feature_daily_cost",
        retryAfterSeconds: secondsUntilNextUtcDay(at),
        usage,
      };
    }

    return {
      allowed: true,
      usage,
    };
  }

  async record(input: AICostRecordInput): Promise<AICostRecordResult> {
    const at = input.at ?? new Date();
    const budget = resolveAICostBudget(input.tier, input.budget);
    const costUsdMicros = validateNonNegativeInteger("costUsdMicros", input.costUsdMicros);
    const inputTokens = validateNonNegativeInteger("inputTokens", input.inputTokens ?? 0);
    const outputTokens = validateNonNegativeInteger("outputTokens", input.outputTokens ?? 0);

    const actorKey = actorDailyKey(input.orgId, input.actorId, at);
    const featureKey = featureDailyKey(input.orgId, input.actorId, input.feature, at);
    const actorUsed = (this.#actorDailyCosts.get(actorKey) ?? 0) + costUsdMicros;
    const featureUsed = (this.#featureDailyCosts.get(featureKey) ?? 0) + costUsdMicros;
    this.#actorDailyCosts.set(actorKey, actorUsed);
    this.#featureDailyCosts.set(featureKey, featureUsed);

    const usage = costUsage({ actorUsed, featureUsed, budget, at });
    const warningReached = usage.actorDaily.warningReached || usage.featureDaily.warningReached;
    const limitExceeded =
      (usage.actorDaily.limitUsdMicros !== null && usage.actorDaily.usedUsdMicros >= usage.actorDaily.limitUsdMicros) ||
      (usage.featureDaily.limitUsdMicros !== null &&
        usage.featureDaily.usedUsdMicros >= usage.featureDaily.limitUsdMicros);
    const record: AICostRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      actorId: input.actorId,
      feature: input.feature,
      providerId: input.providerId,
      model: input.model,
      costUsdMicros,
      inputTokens,
      outputTokens,
      ...(input.classification === undefined ? {} : { classification: input.classification }),
      ...(input.trace?.traceId === undefined ? {} : { traceId: input.trace.traceId }),
      ...(input.trace?.spanId === undefined ? {} : { spanId: input.trace.spanId }),
      occurredAt: at.toISOString(),
      actorDailyUsedUsdMicros: actorUsed,
      featureDailyUsedUsdMicros: featureUsed,
      actorDailyLimitUsdMicros: budget.actorDailyUsdMicros,
      featureDailyLimitUsdMicros: budget.featureDailyUsdMicros,
      warningReached,
      limitExceeded,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    this.#records.push(record);

    return {
      record,
      usage,
      warningReached,
      limitExceeded,
    };
  }

  async getUsage(input: AICostUsageInput): Promise<AICostUsage> {
    const at = input.at ?? new Date();
    const budget = resolveAICostBudget(input.tier, input.budget);
    return costUsage({
      actorUsed: this.#actorUsed(input.orgId, input.actorId, at),
      featureUsed: this.#featureUsed(input.orgId, input.actorId, input.feature, at),
      budget,
      at,
    });
  }

  listRecords(query: AICostSummaryQuery = {}): readonly AICostRecord[] {
    return this.#records.filter((record) => recordMatches(record, query));
  }

  summarize(query: AICostSummaryQuery = {}): readonly AICostSummaryRow[] {
    const rows = new Map<string, MutableAICostSummaryRow>();
    for (const record of this.listRecords(query)) {
      const key = summaryKey(record.orgId, record.actorId, record.feature);
      const existing =
        rows.get(key) ??
        ({
          orgId: record.orgId,
          actorId: record.actorId,
          feature: record.feature,
          costUsdMicros: 0,
          inputTokens: 0,
          outputTokens: 0,
          callCount: 0,
        } satisfies MutableAICostSummaryRow);
      existing.costUsdMicros += record.costUsdMicros;
      existing.inputTokens += record.inputTokens;
      existing.outputTokens += record.outputTokens;
      existing.callCount += 1;
      rows.set(key, existing);
    }

    return [...rows.values()].sort((left, right) => summaryKey(left.orgId, left.actorId, left.feature).localeCompare(
      summaryKey(right.orgId, right.actorId, right.feature),
    ));
  }

  reset(): void {
    this.#actorDailyCosts.clear();
    this.#featureDailyCosts.clear();
    this.#records.splice(0, this.#records.length);
  }

  #actorUsed(orgId: string, actorId: string, at: Date): number {
    return this.#actorDailyCosts.get(actorDailyKey(orgId, actorId, at)) ?? 0;
  }

  #featureUsed(orgId: string, actorId: string, feature: string, at: Date): number {
    return this.#featureDailyCosts.get(featureDailyKey(orgId, actorId, feature, at)) ?? 0;
  }
}

interface CostUsageInput {
  readonly actorUsed: number;
  readonly featureUsed: number;
  readonly budget: AICostBudget;
  readonly at: Date;
}

interface MutableAICostSummaryRow {
  readonly orgId: string;
  readonly actorId: string;
  readonly feature: string;
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

function costUsage(input: CostUsageInput): AICostUsage {
  return {
    actorDaily: usageWindow(input.actorUsed, input.budget.actorDailyUsdMicros, input.budget.warningThresholdRatio, input.at),
    featureDaily: usageWindow(
      input.featureUsed,
      input.budget.featureDailyUsdMicros,
      input.budget.warningThresholdRatio,
      input.at,
    ),
  };
}

function usageWindow(
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
    remainingUsdMicros: limitUsdMicros === null ? null : Math.max(limitUsdMicros - usedUsdMicros, 0),
    resetsAt: nextUtcDay(at).toISOString(),
    warningThresholdUsdMicros,
    warningReached: warningThresholdUsdMicros !== null && usedUsdMicros >= warningThresholdUsdMicros,
  };
}

function recordMatches(record: AICostRecord, query: AICostSummaryQuery): boolean {
  const occurredAt = Date.parse(record.occurredAt);
  return (
    (query.orgId === undefined || record.orgId === query.orgId) &&
    (query.actorId === undefined || record.actorId === query.actorId) &&
    (query.feature === undefined || record.feature === query.feature) &&
    (query.from === undefined || occurredAt >= query.from.getTime()) &&
    (query.to === undefined || occurredAt < query.to.getTime())
  );
}

function actorDailyKey(orgId: string, actorId: string, at: Date): string {
  return `${orgId}:${actorId}:${utcDayKey(at)}`;
}

function featureDailyKey(orgId: string, actorId: string, feature: string, at: Date): string {
  return `${orgId}:${actorId}:${feature}:${utcDayKey(at)}`;
}

function summaryKey(orgId: string, actorId: string, feature: string): string {
  return `${orgId}:${actorId}:${feature}`;
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
