import type { JsonObject, SecurityTier, TraceContext } from "@helix/sdk-types";
import type { DataClassification } from "../classification/index.js";

export interface AICostBudget {
  readonly actorDailyUsdMicros: number | null;
  readonly featureDailyUsdMicros: number | null;
  readonly warningThresholdRatio: number;
}

export interface AICostScope {
  readonly orgId: string;
  readonly actorId: string;
  readonly feature: string;
  readonly tier: SecurityTier;
  readonly budget?: Partial<AICostBudget> | undefined;
}

export interface AICostLimitCheckInput extends AICostScope {
  readonly estimatedCostUsdMicros?: number | undefined;
  readonly at?: Date | undefined;
}

export interface AICostRecordInput extends AICostScope {
  readonly providerId: string;
  readonly model: string;
  readonly costUsdMicros: number;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly classification?: DataClassification | undefined;
  readonly trace?: TraceContext | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly at?: Date | undefined;
}

export type AICostLimitReason = "actor_daily_cost" | "feature_daily_cost";

export interface AICostUsageWindow {
  readonly limitUsdMicros: number | null;
  readonly usedUsdMicros: number;
  readonly remainingUsdMicros: number | null;
  readonly resetsAt: string;
  readonly warningThresholdUsdMicros: number | null;
  readonly warningReached: boolean;
}

export interface AICostUsage {
  readonly actorDaily: AICostUsageWindow;
  readonly featureDaily: AICostUsageWindow;
}

export interface AICostLimitAllowed {
  readonly allowed: true;
  readonly usage: AICostUsage;
}

export interface AICostLimitDenied {
  readonly allowed: false;
  readonly reason: AICostLimitReason;
  readonly retryAfterSeconds: number;
  readonly usage: AICostUsage;
}

export type AICostLimitDecision = AICostLimitAllowed | AICostLimitDenied;

export interface AICostRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly feature: string;
  readonly providerId: string;
  readonly model: string;
  readonly costUsdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly classification?: DataClassification | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly occurredAt: string;
  readonly actorDailyUsedUsdMicros: number;
  readonly featureDailyUsedUsdMicros: number;
  readonly actorDailyLimitUsdMicros: number | null;
  readonly featureDailyLimitUsdMicros: number | null;
  readonly warningReached: boolean;
  readonly limitExceeded: boolean;
  readonly metadata?: JsonObject | undefined;
}

export interface AICostRecordResult {
  readonly record: AICostRecord;
  readonly usage: AICostUsage;
  readonly warningReached: boolean;
  readonly limitExceeded: boolean;
}

export interface AICostUsageInput extends AICostScope {
  readonly at?: Date | undefined;
}

export interface AICostLimiter {
  check(input: AICostLimitCheckInput): Promise<AICostLimitDecision>;
  record(input: AICostRecordInput): Promise<AICostRecordResult>;
  getUsage(input: AICostUsageInput): Promise<AICostUsage>;
}

export interface AICostSummaryQuery {
  readonly orgId?: string | undefined;
  readonly actorId?: string | undefined;
  readonly feature?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface AICostSummaryRow {
  readonly orgId: string;
  readonly actorId: string;
  readonly feature: string;
  readonly costUsdMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly callCount: number;
}
