import { randomUUID } from "node:crypto";
import { validateNonNegativeInteger } from "./types.js";
import type { RedisLimitClient } from "./redis-limiter.js";

const HOUR_MS = 60 * 60 * 1000;

const CONSUME_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, "-inf", now_ms - window_ms)
local used = tonumber(redis.call("ZCARD", key))
local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local oldest_score = now_ms
if oldest[2] ~= nil then
  oldest_score = tonumber(oldest[2])
end
if limit >= 0 and used + 1 > limit then
  local retry = 1
  if oldest_score ~= nil then
    retry = math.ceil((oldest_score + window_ms - now_ms) / 1000)
  end
  if retry < 1 then
    retry = 1
  end
  return {0, used, retry, oldest_score}
end

redis.call("ZADD", key, now_ms, member)
redis.call("PEXPIRE", key, window_ms * 2)
return {1, used + 1, 0, oldest_score}
`;

export interface TenantHourlyQuotaInput {
  readonly orgId: string;
  readonly quota: string;
  readonly limit: number | null;
  readonly at?: Date;
}

export interface TenantHourlyQuotaAllowed {
  readonly allowed: true;
  readonly quota: string;
  readonly limit: number | null;
  readonly used: number;
  readonly remaining: number | null;
  readonly resetsAt: string | null;
}

export interface TenantHourlyQuotaExceeded {
  readonly allowed: false;
  readonly quota: string;
  readonly limit: number;
  readonly used: number;
  readonly remaining: 0;
  readonly retryAfterSeconds: number;
  readonly resetsAt: string;
}

export type TenantHourlyQuotaDecision = TenantHourlyQuotaAllowed | TenantHourlyQuotaExceeded;

export interface TenantHourlyQuotaLimiter {
  consume(input: TenantHourlyQuotaInput): Promise<TenantHourlyQuotaDecision>;
}

export class InMemoryTenantHourlyQuotaLimiter implements TenantHourlyQuotaLimiter {
  readonly #states = new Map<string, number[]>();

  async consume(input: TenantHourlyQuotaInput): Promise<TenantHourlyQuotaDecision> {
    const at = input.at ?? new Date();
    const limit = normalizeTenantHourlyQuotaLimit(input.quota, input.limit);
    const state = this.#stateFor(input.orgId, input.quota);
    pruneWindow(state, at.getTime() - HOUR_MS);

    if (limit !== null && state.length + 1 > limit) {
      const oldest = state[0] ?? at.getTime();
      return {
        allowed: false,
        quota: input.quota,
        limit,
        used: state.length,
        remaining: 0,
        retryAfterSeconds: retryAfterSeconds(oldest, at),
        resetsAt: new Date(oldest + HOUR_MS).toISOString(),
      };
    }

    state.push(at.getTime());
    const oldest = state[0];
    return {
      allowed: true,
      quota: input.quota,
      limit,
      used: state.length,
      remaining: limit === null ? null : Math.max(limit - state.length, 0),
      resetsAt: oldest === undefined ? null : new Date(oldest + HOUR_MS).toISOString(),
    };
  }

  reset(orgId: string, quota: string): void {
    this.#states.delete(stateKey(orgId, quota));
  }

  #stateFor(orgId: string, quota: string): number[] {
    const key = stateKey(orgId, quota);
    const existing = this.#states.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const state: number[] = [];
    this.#states.set(key, state);
    return state;
  }
}

export interface RedisTenantHourlyQuotaLimiterOptions {
  readonly keyPrefix?: string;
}

export class RedisTenantHourlyQuotaLimiter implements TenantHourlyQuotaLimiter {
  readonly #keyPrefix: string;

  constructor(
    private readonly redis: RedisLimitClient,
    options: RedisTenantHourlyQuotaLimiterOptions = {},
  ) {
    this.#keyPrefix = options.keyPrefix ?? "helix:tenant-hourly-quota";
  }

  async consume(input: TenantHourlyQuotaInput): Promise<TenantHourlyQuotaDecision> {
    const at = input.at ?? new Date();
    const limit = normalizeTenantHourlyQuotaLimit(input.quota, input.limit);
    const raw = await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      `${this.#keyPrefix}:{${keyPart(input.orgId)}}:${keyPart(input.quota)}`,
      at.getTime(),
      HOUR_MS,
      limit ?? -1,
      `${String(at.getTime())}:${randomUUID()}`,
    );
    const response = redisConsumeResponse(raw);
    const resetsAt = new Date(response.oldestTimestamp + HOUR_MS).toISOString();
    if (!response.allowed && limit !== null) {
      return {
        allowed: false,
        quota: input.quota,
        limit,
        used: response.used,
        remaining: 0,
        retryAfterSeconds: response.retryAfterSeconds,
        resetsAt,
      };
    }
    return {
      allowed: true,
      quota: input.quota,
      limit,
      used: response.used,
      remaining: limit === null ? null : Math.max(limit - response.used, 0),
      resetsAt: response.used === 0 ? null : resetsAt,
    };
  }
}

export function normalizeTenantHourlyQuotaLimit(
  quota: string,
  value: number | null,
): number | null {
  if (value === null) {
    return null;
  }
  return validateNonNegativeInteger(quota, value);
}

function stateKey(orgId: string, quota: string): string {
  return `${orgId}:${quota}`;
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

function retryAfterSeconds(oldestTimestamp: number, at: Date): number {
  return Math.max(1, Math.ceil((oldestTimestamp + HOUR_MS - at.getTime()) / 1000));
}

function redisConsumeResponse(raw: unknown): {
  readonly allowed: boolean;
  readonly used: number;
  readonly retryAfterSeconds: number;
  readonly oldestTimestamp: number;
} {
  if (!Array.isArray(raw) || raw.length < 4) {
    throw new Error("Unexpected Redis tenant hourly quota limiter response.");
  }
  return {
    allowed: Number(raw[0]) === 1,
    used: Number(raw[1]),
    retryAfterSeconds: Number(raw[2]),
    oldestTimestamp: Number(raw[3]),
  };
}

function keyPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}
