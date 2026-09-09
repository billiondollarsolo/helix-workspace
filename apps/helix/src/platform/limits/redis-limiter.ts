import { randomUUID } from "node:crypto";
import {
  resolveAgentLimitBudget,
  validateLimitBudget,
  validateNonNegativeInteger,
  type AgentCostDecision,
  type AgentCostRecordInput,
  type AgentLimitBudget,
  type AgentLimitConsumeInput,
  type AgentLimitDecision,
  type AgentLimitReason,
  type AgentLimitUsage,
  type AgentLimitUsageInput,
  type AgentRateCostLimiter,
  type AgentWindowUsage,
} from "./types.js";
import { costUsage, secondsUntilNextUtcDay, utcDayKey } from "./usage-math.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const CONSUME_SCRIPT = `
local minute_key = KEYS[1]
local day_key = KEYS[2]
local cost_key = KEYS[3]

local now_ms = tonumber(ARGV[1])
local minute_window_ms = tonumber(ARGV[2])
local day_window_ms = tonumber(ARGV[3])
local minute_limit = tonumber(ARGV[4])
local day_limit = tonumber(ARGV[5])
local request_count = tonumber(ARGV[6])
local estimated_cost = tonumber(ARGV[7])
local cost_limit = tonumber(ARGV[8])
local cost_ttl_seconds = tonumber(ARGV[9])
local member_base = ARGV[10]

local function prune(key, window_ms)
  redis.call("ZREMRANGEBYSCORE", key, "-inf", now_ms - window_ms)
end

local function retry_after(key, window_ms)
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  if oldest[2] == nil then
    return 1
  end
  local retry = math.ceil((tonumber(oldest[2]) + window_ms - now_ms) / 1000)
  if retry < 1 then
    return 1
  end
  return retry
end

prune(minute_key, minute_window_ms)
prune(day_key, day_window_ms)

local minute_used = tonumber(redis.call("ZCARD", minute_key))
local day_used = tonumber(redis.call("ZCARD", day_key))
local cost_used = tonumber(redis.call("GET", cost_key) or "0")

if minute_limit >= 0 and minute_used + request_count > minute_limit then
  return {0, "requests_per_minute", retry_after(minute_key, minute_window_ms), minute_used, day_used, cost_used}
end

if day_limit >= 0 and day_used + request_count > day_limit then
  return {0, "requests_per_day", retry_after(day_key, day_window_ms), minute_used, day_used, cost_used}
end

if cost_limit >= 0 and cost_used + estimated_cost > cost_limit then
  local ttl = redis.call("TTL", cost_key)
  if ttl < 1 then
    ttl = cost_ttl_seconds
  end
  return {0, "cost_per_day", ttl, minute_used, day_used, cost_used}
end

for index = 1, request_count do
  local member = member_base .. ":" .. tostring(index)
  redis.call("ZADD", minute_key, now_ms, member)
  redis.call("ZADD", day_key, now_ms, member)
end

redis.call("PEXPIRE", minute_key, minute_window_ms * 2)
redis.call("PEXPIRE", day_key, day_window_ms * 2)

return {1, "", 0, minute_used + request_count, day_used + request_count, cost_used}
`;

const RECORD_COST_SCRIPT = `
local cost_key = KEYS[1]
local increment = tonumber(ARGV[1])
local ttl_seconds = tonumber(ARGV[2])
local used = tonumber(redis.call("INCRBY", cost_key, increment))
if ttl_seconds > 0 and redis.call("TTL", cost_key) < 0 then
  redis.call("EXPIRE", cost_key, ttl_seconds)
end
return used
`;

const USAGE_SCRIPT = `
local minute_key = KEYS[1]
local day_key = KEYS[2]
local cost_key = KEYS[3]
local now_ms = tonumber(ARGV[1])
local minute_window_ms = tonumber(ARGV[2])
local day_window_ms = tonumber(ARGV[3])

redis.call("ZREMRANGEBYSCORE", minute_key, "-inf", now_ms - minute_window_ms)
redis.call("ZREMRANGEBYSCORE", day_key, "-inf", now_ms - day_window_ms)

local minute_oldest = redis.call("ZRANGE", minute_key, 0, 0, "WITHSCORES")
local day_oldest = redis.call("ZRANGE", day_key, 0, 0, "WITHSCORES")

return {
  tonumber(redis.call("ZCARD", minute_key)),
  minute_oldest[2] or "",
  tonumber(redis.call("ZCARD", day_key)),
  day_oldest[2] or "",
  tonumber(redis.call("GET", cost_key) or "0")
}
`;

export interface RedisLimitClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<unknown>;
}

export interface RedisAgentRateCostLimiterOptions {
  readonly keyPrefix?: string;
}

export class RedisAgentRateCostLimiter implements AgentRateCostLimiter {
  readonly #keyPrefix: string;

  constructor(
    private readonly redis: RedisLimitClient,
    options: RedisAgentRateCostLimiterOptions = {},
  ) {
    this.#keyPrefix = options.keyPrefix ?? "helix:limits";
  }

  async consume(input: AgentLimitConsumeInput): Promise<AgentLimitDecision> {
    const at = input.at ?? new Date();
    const budget = input.budget ?? resolveAgentLimitBudget(input.tier);
    validateLimitBudget(budget);
    const requestCount = validateNonNegativeInteger("requestCount", input.requestCount ?? 1);
    const estimatedCostUsdMicros = validateNonNegativeInteger(
      "estimatedCostUsdMicros",
      input.estimatedCostUsdMicros ?? 0,
    );
    const keys = this.#keys(input.orgId, input.actorId, at);
    const raw = await this.redis.eval(
      CONSUME_SCRIPT,
      3,
      keys.minuteRequests,
      keys.dayRequests,
      keys.dailyCost,
      at.getTime(),
      MINUTE_MS,
      DAY_MS,
      budget.requestsPerMinute ?? -1,
      budget.requestsPerDay ?? -1,
      requestCount,
      estimatedCostUsdMicros,
      budget.costPerDayUsdMicros ?? -1,
      secondsUntilNextUtcDay(at),
      `${String(at.getTime())}:${randomUUID()}`,
    );
    const response = consumeScriptResponse(raw);
    const usage = this.#usageFromScriptResponse({
      minuteUsed: response.minuteUsed,
      dayUsed: response.dayUsed,
      costUsed: response.costUsed,
      budget,
      at,
      minuteOldestMs: null,
      dayOldestMs: null,
    });

    if (response.allowed) {
      return { allowed: true, usage };
    }

    return {
      allowed: false,
      reason: response.reason,
      retryAfterSeconds: response.retryAfterSeconds,
      usage,
    };
  }

  async recordCost(input: AgentCostRecordInput): Promise<AgentCostDecision> {
    const at = input.at ?? new Date();
    const budget = input.budget ?? resolveAgentLimitBudget(input.tier);
    validateLimitBudget(budget);
    const costUsdMicros = validateNonNegativeInteger("costUsdMicros", input.costUsdMicros);
    const keys = this.#keys(input.orgId, input.actorId, at);
    const raw = await this.redis.eval(
      RECORD_COST_SCRIPT,
      1,
      keys.dailyCost,
      costUsdMicros,
      secondsUntilNextUtcDay(at),
    );
    const usedUsdMicros = scriptNumber(raw, "record cost response");
    const usage = costUsage(usedUsdMicros, budget, at);
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
    const keys = this.#keys(input.orgId, input.actorId, at);
    const raw = await this.redis.eval(
      USAGE_SCRIPT,
      3,
      keys.minuteRequests,
      keys.dayRequests,
      keys.dailyCost,
      at.getTime(),
      MINUTE_MS,
      DAY_MS,
    );
    const response = usageScriptResponse(raw);
    return this.#usageFromScriptResponse({
      ...response,
      budget,
      at,
    });
  }

  #keys(orgId: string, actorId: string, at: Date): RedisLimiterKeys {
    const tag = `${keyPart(orgId)}:${keyPart(actorId)}`;
    const base = `${this.#keyPrefix}:{${tag}}`;
    return {
      minuteRequests: `${base}:requests:minute`,
      dayRequests: `${base}:requests:day`,
      dailyCost: `${base}:cost:${utcDayKey(at)}`,
    };
  }

  #usageFromScriptResponse(input: {
    readonly minuteUsed: number;
    readonly minuteOldestMs: number | null;
    readonly dayUsed: number;
    readonly dayOldestMs: number | null;
    readonly costUsed: number;
    readonly budget: AgentLimitBudget;
    readonly at: Date;
  }): AgentLimitUsage {
    return {
      requestsPerMinute: windowUsage(
        input.minuteUsed,
        input.minuteOldestMs,
        input.budget.requestsPerMinute,
        MINUTE_MS,
      ),
      requestsPerDay: windowUsage(
        input.dayUsed,
        input.dayOldestMs,
        input.budget.requestsPerDay,
        DAY_MS,
      ),
      costPerDay: costUsage(input.costUsed, input.budget, input.at),
    };
  }
}

interface RedisLimiterKeys {
  readonly minuteRequests: string;
  readonly dayRequests: string;
  readonly dailyCost: string;
}

interface ConsumeScriptResponse {
  readonly allowed: boolean;
  readonly reason: AgentLimitReason;
  readonly retryAfterSeconds: number;
  readonly minuteUsed: number;
  readonly dayUsed: number;
  readonly costUsed: number;
}

interface UsageScriptResponse {
  readonly minuteUsed: number;
  readonly minuteOldestMs: number | null;
  readonly dayUsed: number;
  readonly dayOldestMs: number | null;
  readonly costUsed: number;
}

function consumeScriptResponse(value: unknown): ConsumeScriptResponse {
  const parts = scriptArray(value, "consume response");
  const allowed = scriptNumber(parts[0], "consume allowed") === 1;
  const reason = allowed ? "requests_per_minute" : scriptReason(parts[1]);
  return {
    allowed,
    reason,
    retryAfterSeconds: scriptNumber(parts[2], "consume retryAfterSeconds"),
    minuteUsed: scriptNumber(parts[3], "consume minuteUsed"),
    dayUsed: scriptNumber(parts[4], "consume dayUsed"),
    costUsed: scriptNumber(parts[5], "consume costUsed"),
  };
}

function usageScriptResponse(value: unknown): UsageScriptResponse {
  const parts = scriptArray(value, "usage response");
  return {
    minuteUsed: scriptNumber(parts[0], "usage minuteUsed"),
    minuteOldestMs: scriptNullableNumber(parts[1], "usage minuteOldestMs"),
    dayUsed: scriptNumber(parts[2], "usage dayUsed"),
    dayOldestMs: scriptNullableNumber(parts[3], "usage dayOldestMs"),
    costUsed: scriptNumber(parts[4], "usage costUsed"),
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

function scriptNullableNumber(value: unknown, name: string): number | null {
  if (value === "") {
    return null;
  }
  return scriptNumber(value, name);
}

function scriptReason(value: unknown): AgentLimitReason {
  if (value === "requests_per_minute" || value === "requests_per_day" || value === "cost_per_day") {
    return value;
  }
  throw new Error("Invalid Redis consume reason");
}

function windowUsage(
  used: number,
  oldestMs: number | null,
  limit: number | null,
  windowMs: number,
): AgentWindowUsage {
  return {
    limit,
    used,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    resetsAt: oldestMs === null ? null : new Date(oldestMs + windowMs).toISOString(),
  };
}

function keyPart(value: string): string {
  return encodeURIComponent(value).replaceAll("{", "%7B").replaceAll("}", "%7D");
}
