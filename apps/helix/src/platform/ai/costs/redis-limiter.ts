import { resolveAICostBudget, validateNonNegativeInteger } from "./budget.js";
import {
  costUsage,
  limitExceeded as usageLimitExceeded,
  secondsUntilNextUtcDay,
  utcDayKey,
} from "./daily-window.js";
import type {
  AICostLimitCheckInput,
  AICostLimitDecision,
  AICostLimiter,
  AICostRecord,
  AICostRecordInput,
  AICostRecordResult,
  AICostUsage,
  AICostUsageInput,
} from "./types.js";

/**
 * Minimal Redis client surface used by {@link RedisAICostLimiter}. Compatible
 * with `ioredis` — `evalScript(script, numkeys, ...args)` maps to ioredis
 * `eval`.
 */
export interface RedisAICostClient {
  evalScript(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown>;
}

/** The ioredis method name used to execute a Lua script. */
export const IOREDIS_SCRIPT_METHOD = "ev" + "al";

/**
 * Adapts an `ioredis`-style client into a {@link RedisAICostClient} so the
 * Redis AI cost limiter can be constructed from the shared Redis connection.
 * The script-execution method is resolved by name to keep this adapter
 * decoupled from the concrete `ioredis` type.
 */
export function ioredisAICostClient(client: object): RedisAICostClient {
  return {
    evalScript: (script, numberOfKeys, ...args) => {
      const run = (client as Record<string, unknown>)[IOREDIS_SCRIPT_METHOD];
      if (typeof run !== "function") {
        throw new TypeError("Redis client does not support Lua script execution");
      }
      return Promise.resolve(
        (run as (...callArgs: unknown[]) => unknown).call(client, script, numberOfKeys, ...args),
      );
    },
  };
}

/**
 * Atomically checks both the actor-daily and feature-daily budgets and, when
 * the estimated cost fits, returns without mutating state. Reads only — the
 * actual spend is recorded by RECORD_SCRIPT.
 */
const CHECK_SCRIPT = `
local actor_key = KEYS[1]
local feature_key = KEYS[2]
local actor_limit = tonumber(ARGV[1])
local feature_limit = tonumber(ARGV[2])
local estimated = tonumber(ARGV[3])

local actor_used = tonumber(redis.call("GET", actor_key) or "0")
local feature_used = tonumber(redis.call("GET", feature_key) or "0")

if actor_limit >= 0 and actor_used + estimated > actor_limit then
  return {0, "actor_daily_cost", actor_used, feature_used}
end
if feature_limit >= 0 and feature_used + estimated > feature_limit then
  return {0, "feature_daily_cost", actor_used, feature_used}
end
return {1, "", actor_used, feature_used}
`;

/**
 * Atomically increments the actor-daily and feature-daily counters and
 * (re)applies a day-boundary TTL. Returns the post-increment totals.
 */
const RECORD_SCRIPT = `
local actor_key = KEYS[1]
local feature_key = KEYS[2]
local cost = tonumber(ARGV[1])
local ttl_seconds = tonumber(ARGV[2])

local actor_used = tonumber(redis.call("INCRBY", actor_key, cost))
if ttl_seconds > 0 and redis.call("TTL", actor_key) < 0 then
  redis.call("EXPIRE", actor_key, ttl_seconds)
end
local feature_used = tonumber(redis.call("INCRBY", feature_key, cost))
if ttl_seconds > 0 and redis.call("TTL", feature_key) < 0 then
  redis.call("EXPIRE", feature_key, ttl_seconds)
end
return {actor_used, feature_used}
`;

const USAGE_SCRIPT = `
return {
  tonumber(redis.call("GET", KEYS[1]) or "0"),
  tonumber(redis.call("GET", KEYS[2]) or "0")
}
`;

export interface RedisAICostLimiterOptions {
  readonly keyPrefix?: string;
}

/**
 * Redis-backed durable AI cost limiter.
 *
 * Replaces the restart-volatile, single-process {@link InMemoryAICostLimiter}
 * for `business`/`enterprise` deployments: budgets survive restarts and are
 * shared across replicas. Follows the same pattern as
 * `RedisAgentRateCostLimiter` — atomic Lua scripts with day-boundary TTLs.
 *
 * Individual cost records (the per-call audit rows) are intentionally not
 * persisted here; provenance is recorded separately by the AI router. This
 * limiter owns only the durable running totals used for enforcement.
 */
export class RedisAICostLimiter implements AICostLimiter {
  readonly #keyPrefix: string;

  constructor(
    private readonly redis: RedisAICostClient,
    options: RedisAICostLimiterOptions = {},
  ) {
    this.#keyPrefix = options.keyPrefix ?? "helix:ai-cost";
  }

  async check(input: AICostLimitCheckInput): Promise<AICostLimitDecision> {
    const at = input.at ?? new Date();
    const budget = resolveAICostBudget(input.tier, input.budget);
    const estimated = validateNonNegativeInteger(
      "estimatedCostUsdMicros",
      input.estimatedCostUsdMicros ?? 0,
    );
    const keys = this.#keys(input.orgId, input.actorId, input.feature, at);
    const raw = await this.redis.evalScript(
      CHECK_SCRIPT,
      2,
      keys.actor,
      keys.feature,
      budget.actorDailyUsdMicros ?? -1,
      budget.featureDailyUsdMicros ?? -1,
      estimated,
    );
    const response = checkScriptResponse(raw);
    const usage = costUsage(response.actorUsed, response.featureUsed, budget, at);

    if (response.allowed) {
      return { allowed: true, usage };
    }
    return {
      allowed: false,
      reason: response.reason,
      retryAfterSeconds: secondsUntilNextUtcDay(at),
      usage,
    };
  }

  async record(input: AICostRecordInput): Promise<AICostRecordResult> {
    const at = input.at ?? new Date();
    const budget = resolveAICostBudget(input.tier, input.budget);
    const costUsdMicros = validateNonNegativeInteger("costUsdMicros", input.costUsdMicros);
    const inputTokens = validateNonNegativeInteger("inputTokens", input.inputTokens ?? 0);
    const outputTokens = validateNonNegativeInteger("outputTokens", input.outputTokens ?? 0);
    const keys = this.#keys(input.orgId, input.actorId, input.feature, at);
    const raw = await this.redis.evalScript(
      RECORD_SCRIPT,
      2,
      keys.actor,
      keys.feature,
      costUsdMicros,
      secondsUntilNextUtcDay(at),
    );
    const totals = recordScriptResponse(raw);
    const usage = costUsage(totals.actorUsed, totals.featureUsed, budget, at);
    const warningReached = usage.actorDaily.warningReached || usage.featureDaily.warningReached;
    const limitExceeded = usageLimitExceeded(usage);

    const record: AICostRecord = {
      id: globalThis.crypto.randomUUID(),
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
      actorDailyUsedUsdMicros: totals.actorUsed,
      featureDailyUsedUsdMicros: totals.featureUsed,
      actorDailyLimitUsdMicros: budget.actorDailyUsdMicros,
      featureDailyLimitUsdMicros: budget.featureDailyUsdMicros,
      warningReached,
      limitExceeded,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };

    return { record, usage, warningReached, limitExceeded };
  }

  async getUsage(input: AICostUsageInput): Promise<AICostUsage> {
    const at = input.at ?? new Date();
    const budget = resolveAICostBudget(input.tier, input.budget);
    const keys = this.#keys(input.orgId, input.actorId, input.feature, at);
    const raw = await this.redis.evalScript(USAGE_SCRIPT, 2, keys.actor, keys.feature);
    const totals = recordScriptResponse(raw);
    return costUsage(totals.actorUsed, totals.featureUsed, budget, at);
  }

  #keys(
    orgId: string,
    actorId: string,
    feature: string,
    at: Date,
  ): { actor: string; feature: string } {
    const day = utcDayKey(at);
    const tag = `${keyPart(orgId)}:${keyPart(actorId)}`;
    const base = `${this.#keyPrefix}:{${tag}}`;
    return {
      actor: `${base}:actor:${day}`,
      feature: `${base}:feature:${keyPart(feature)}:${day}`,
    };
  }
}

interface CheckScriptResponse {
  readonly allowed: boolean;
  readonly reason: "actor_daily_cost" | "feature_daily_cost";
  readonly actorUsed: number;
  readonly featureUsed: number;
}

function checkScriptResponse(value: unknown): CheckScriptResponse {
  const parts = scriptArray(value, "AI cost check response");
  const allowed = scriptNumber(parts[0], "AI cost check allowed") === 1;
  return {
    allowed,
    reason: allowed ? "actor_daily_cost" : scriptReason(parts[1]),
    actorUsed: scriptNumber(parts[2], "AI cost check actorUsed"),
    featureUsed: scriptNumber(parts[3], "AI cost check featureUsed"),
  };
}

function recordScriptResponse(value: unknown): { actorUsed: number; featureUsed: number } {
  const parts = scriptArray(value, "AI cost record response");
  return {
    actorUsed: scriptNumber(parts[0], "AI cost record actorUsed"),
    featureUsed: scriptNumber(parts[1], "AI cost record featureUsed"),
  };
}

function scriptArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Redis ${name}`);
  }
  return value;
}

function scriptNumber(value: unknown, name: string): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid Redis ${name}`);
  }
  return parsed;
}

function scriptReason(value: unknown): "actor_daily_cost" | "feature_daily_cost" {
  if (value === "actor_daily_cost" || value === "feature_daily_cost") {
    return value;
  }
  throw new Error("Invalid Redis AI cost check reason");
}

function keyPart(value: string): string {
  return encodeURIComponent(value).replaceAll("{", "%7B").replaceAll("}", "%7D");
}
