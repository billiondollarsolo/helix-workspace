import { randomUUID } from "node:crypto";
import type { RedisLimitClient } from "./redis-limiter.js";
import { validateNonNegativeInteger } from "./types.js";
import { pruneWindow } from "./usage-math.js";

const SECOND_MS = 1_000;

const CONSUME_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call("ZREMRANGEBYSCORE", key, "-inf", now_ms - window_ms)
local used = tonumber(redis.call("ZCARD", key))
if limit >= 0 and used + 1 > limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retry = 1
  if oldest[2] ~= nil then
    retry = math.ceil((tonumber(oldest[2]) + window_ms - now_ms) / 1000)
    if retry < 1 then
      retry = 1
    end
  end
  return {0, used, retry}
end

redis.call("ZADD", key, now_ms, member)
redis.call("PEXPIRE", key, window_ms * 2)
return {1, used + 1, 0}
`;

export interface TenantApiRpsLimitInput {
  readonly orgId: string;
  readonly limit: number | null;
  readonly at?: Date;
  /** Server-selected partition; omitted for the shared integration API quota. */
  readonly bucket?: string;
  readonly windowMs?: number;
}

interface TenantApiRpsLimitAllowed {
  readonly allowed: true;
  readonly limit: number | null;
  readonly used: number;
  readonly remaining: number | null;
  readonly resetsAt: string | null;
}

interface TenantApiRpsLimitExceeded {
  readonly allowed: false;
  readonly limit: number;
  readonly used: number;
  readonly remaining: 0;
  readonly retryAfterSeconds: number;
  readonly resetsAt: string;
}

export type TenantApiRpsLimitDecision = TenantApiRpsLimitAllowed | TenantApiRpsLimitExceeded;

export interface TenantApiRpsLimiter {
  consume(input: TenantApiRpsLimitInput): Promise<TenantApiRpsLimitDecision>;
}

export class InMemoryTenantApiRpsLimiter implements TenantApiRpsLimiter {
  readonly #states = new Map<string, number[]>();

  async consume(input: TenantApiRpsLimitInput): Promise<TenantApiRpsLimitDecision> {
    const at = input.at ?? new Date();
    const limit = normalizeApiRpsLimit(input.limit);
    const windowMs = requestWindowMs(input.windowMs);
    const state = this.#stateFor(
      input.bucket === undefined ? input.orgId : `${input.orgId}:${input.bucket}`,
    );
    pruneWindow(state, at.getTime() - windowMs);

    if (limit !== null && state.length + 1 > limit) {
      const oldest = state[0] ?? at.getTime();
      return {
        allowed: false,
        limit,
        used: state.length,
        remaining: 0,
        retryAfterSeconds: retryAfterSeconds(oldest, at, windowMs),
        resetsAt: new Date(oldest + windowMs).toISOString(),
      };
    }

    state.push(at.getTime());
    const oldest = state[0];
    return {
      allowed: true,
      limit,
      used: state.length,
      remaining: limit === null ? null : Math.max(limit - state.length, 0),
      resetsAt: oldest === undefined ? null : new Date(oldest + windowMs).toISOString(),
    };
  }

  reset(orgId: string): void {
    for (const key of this.#states.keys())
      if (key === orgId || key.startsWith(`${orgId}:`)) this.#states.delete(key);
  }

  #stateFor(orgId: string): number[] {
    const existing = this.#states.get(orgId);
    if (existing !== undefined) {
      return existing;
    }
    const state: number[] = [];
    this.#states.set(orgId, state);
    return state;
  }
}

export interface RedisTenantApiRpsLimiterOptions {
  readonly keyPrefix?: string;
}

export class RedisTenantApiRpsLimiter implements TenantApiRpsLimiter {
  readonly #keyPrefix: string;

  constructor(
    private readonly redis: RedisLimitClient,
    options: RedisTenantApiRpsLimiterOptions = {},
  ) {
    this.#keyPrefix = options.keyPrefix ?? "helix:tenant-api-rps";
  }

  async consume(input: TenantApiRpsLimitInput): Promise<TenantApiRpsLimitDecision> {
    const at = input.at ?? new Date();
    const limit = normalizeApiRpsLimit(input.limit);
    const windowMs = requestWindowMs(input.windowMs);
    const raw = await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      `${this.#keyPrefix}:{${keyPart(input.orgId)}}${input.bucket === undefined ? "" : `:${encodeURIComponent(input.bucket)}`}`,
      at.getTime(),
      windowMs,
      limit ?? -1,
      `${String(at.getTime())}:${randomUUID()}`,
    );
    const response = redisConsumeResponse(raw);
    const oldestResetsAt = new Date(
      at.getTime() + (response.allowed ? windowMs : response.retryAfterSeconds * SECOND_MS),
    ).toISOString();
    if (!response.allowed && limit !== null) {
      return {
        allowed: false,
        limit,
        used: response.used,
        remaining: 0,
        retryAfterSeconds: response.retryAfterSeconds,
        resetsAt: oldestResetsAt,
      };
    }
    return {
      allowed: true,
      limit,
      used: response.used,
      remaining: limit === null ? null : Math.max(limit - response.used, 0),
      resetsAt: response.used === 0 ? null : oldestResetsAt,
    };
  }
}

export function normalizeApiRpsLimit(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return validateNonNegativeInteger("api_rps_limit", value);
}

function retryAfterSeconds(oldestTimestamp: number, at: Date, windowMs: number): number {
  return Math.max(1, Math.ceil((oldestTimestamp + windowMs - at.getTime()) / SECOND_MS));
}

function requestWindowMs(value = SECOND_MS): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError("Rate limit windowMs must be a positive integer.");
  return value;
}

function redisConsumeResponse(raw: unknown): {
  readonly allowed: boolean;
  readonly used: number;
  readonly retryAfterSeconds: number;
} {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error("Unexpected Redis tenant API RPS limiter response.");
  }
  return {
    allowed: Number(raw[0]) === 1,
    used: Number(raw[1]),
    retryAfterSeconds: Number(raw[2]),
  };
}

function keyPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}
