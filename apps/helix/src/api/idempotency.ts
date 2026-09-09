import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { sha256Hex } from "../platform/crypto/index.js";
import type { ToolInvokeResult } from "../platform/tool-registry.js";

/**
 * Idempotency-Key support for mutating tool calls (P1-10). A client supplies an
 * `Idempotency-Key` header on `POST /api/tools/:id`; the first request executes
 * and its result is stored, and any duplicate request with the same key (within
 * the TTL window) replays the stored result instead of re-executing the tool.
 *
 * Replay is scoped per actor + tool + request-payload fingerprint so a reused
 * key with a different payload is rejected as a conflict rather than silently
 * returning a stale result.
 */
export interface IdempotencyRecord {
  /** Serialized tool-invocation result captured on the first execution. */
  readonly result: ToolInvokeResult;
  /** HTTP status code that was returned for the first execution. */
  readonly statusCode: number;
  /** Fingerprint of the original request payload. */
  readonly requestHash: string;
  /** Epoch millis at which this record expires. */
  readonly expiresAt: number;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
  claim(key: string, requestHash: string, ttlMs: number): Promise<IdempotencyClaimOutcome>;
  complete(key: string, claimToken: string, record: IdempotencyRecord): Promise<void>;
  release(key: string, claimToken: string): Promise<void>;
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyClaimOutcome =
  | { readonly kind: "claimed"; readonly claimToken: string }
  | { readonly kind: "in_progress" }
  | { readonly kind: "replay"; readonly record: IdempotencyRecord }
  | { readonly kind: "conflict" };

/** Builds the namespaced storage key for an idempotency entry. */
export function idempotencyStorageKey(input: {
  readonly orgId: string;
  readonly actorId: string;
  readonly toolId: string;
  readonly idempotencyKey: string;
}): string {
  return `idem:${input.orgId}:${input.actorId}:${input.toolId}:${input.idempotencyKey}`;
}

/** Stable fingerprint of a request payload, used to detect key reuse. */
export function fingerprintRequestPayload(payload: unknown): string {
  return sha256Hex(JSON.stringify(payload ?? null));
}

/**
 * Process-local idempotency store. Suitable for single-replica deployments and
 * tests; a Redis-backed store can be swapped in for multi-replica setups.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyRecord>();
  private readonly claims = new Map<
    string,
    { readonly requestHash: string; readonly claimToken: string; readonly expiresAt: number }
  >();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.entries.get(key);
    if (record === undefined) {
      return undefined;
    }
    if (record.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return record;
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    this.entries.set(key, record);
  }

  async claim(key: string, requestHash: string, ttlMs: number): Promise<IdempotencyClaimOutcome> {
    const record = await this.get(key);
    if (record !== undefined) {
      return record.requestHash === requestHash ? { kind: "replay", record } : { kind: "conflict" };
    }
    const existingClaim = this.claims.get(key);
    if (existingClaim !== undefined && existingClaim.expiresAt > this.now()) {
      return existingClaim.requestHash === requestHash
        ? { kind: "in_progress" }
        : { kind: "conflict" };
    }
    const claimToken = randomUUID();
    this.claims.set(key, {
      requestHash,
      claimToken,
      expiresAt: this.now() + ttlMs,
    });
    return { kind: "claimed", claimToken };
  }

  async complete(key: string, claimToken: string, record: IdempotencyRecord): Promise<void> {
    const claim = this.claims.get(key);
    if (claim?.claimToken !== claimToken) {
      throw new Error("Idempotency claim ownership was lost before completion.");
    }
    this.entries.set(key, record);
    this.claims.delete(key);
  }

  async release(key: string, claimToken: string): Promise<void> {
    if (this.claims.get(key)?.claimToken === claimToken) {
      this.claims.delete(key);
    }
  }
}

const REDIS_CLAIM_SCRIPT = `
local result = redis.call("GET", KEYS[1])
local storedHash = redis.call("GET", KEYS[2])
if result then
  if storedHash == ARGV[1] then
    return {"replay", result}
  end
  return {"conflict"}
end
if storedHash and storedHash ~= ARGV[1] then
  return {"conflict"}
end
if not storedHash then
  redis.call("SET", KEYS[2], ARGV[1], "PX", ARGV[3])
end
local claimed = redis.call("SET", KEYS[3], ARGV[2], "NX", "PX", ARGV[3])
if claimed then
  return {"claimed"}
end
return {"in_progress"}
`;

const REDIS_COMPLETE_SCRIPT = `
if redis.call("GET", KEYS[3]) ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2], "PX", ARGV[3])
redis.call("PEXPIRE", KEYS[2], ARGV[3])
redis.call("DEL", KEYS[3])
return 1
`;

const REDIS_RELEASE_SCRIPT = `
if redis.call("GET", KEYS[3]) ~= ARGV[1] then
  return 0
end
redis.call("DEL", KEYS[1], KEYS[2], KEYS[3])
return 1
`;

/**
 * Cluster-wide idempotency store. Redis scripts atomically bind a request hash,
 * claim ownership, and the completed response so two application replicas
 * cannot independently execute the same mutation.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const serialized = await this.redis.get(this.resultKey(key));
    if (serialized === null) {
      return undefined;
    }
    return parseStoredRecord(serialized);
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    const ttlMs = Math.max(1, record.expiresAt - Date.now());
    await this.redis
      .multi()
      .set(this.resultKey(key), JSON.stringify(record), "PX", ttlMs)
      .set(this.hashKey(key), record.requestHash, "PX", ttlMs)
      .exec();
  }

  async claim(key: string, requestHash: string, ttlMs: number): Promise<IdempotencyClaimOutcome> {
    const claimToken = randomUUID();
    const response = await this.redis.eval(
      REDIS_CLAIM_SCRIPT,
      3,
      this.resultKey(key),
      this.hashKey(key),
      this.claimKey(key),
      requestHash,
      claimToken,
      Math.max(1, ttlMs),
    );
    if (!Array.isArray(response) || typeof response[0] !== "string") {
      throw new Error("Redis returned an invalid idempotency claim response.");
    }
    switch (response[0]) {
      case "claimed":
        return { kind: "claimed", claimToken };
      case "in_progress":
        return { kind: "in_progress" };
      case "conflict":
        return { kind: "conflict" };
      case "replay": {
        if (typeof response[1] !== "string") {
          throw new Error("Redis returned an invalid idempotency replay response.");
        }
        return { kind: "replay", record: parseStoredRecord(response[1]) };
      }
      default:
        throw new Error("Redis returned an unknown idempotency claim response.");
    }
  }

  async complete(key: string, claimToken: string, record: IdempotencyRecord): Promise<void> {
    const ttlMs = Math.max(1, record.expiresAt - Date.now());
    const completed = await this.redis.eval(
      REDIS_COMPLETE_SCRIPT,
      3,
      this.resultKey(key),
      this.hashKey(key),
      this.claimKey(key),
      claimToken,
      JSON.stringify(record),
      ttlMs,
    );
    if (completed !== 1) {
      throw new Error("Idempotency claim ownership was lost before completion.");
    }
  }

  async release(key: string, claimToken: string): Promise<void> {
    await this.redis.eval(
      REDIS_RELEASE_SCRIPT,
      3,
      this.resultKey(key),
      this.hashKey(key),
      this.claimKey(key),
      claimToken,
    );
  }

  private resultKey(key: string): string {
    return `${this.keyBase(key)}:result`;
  }

  private hashKey(key: string): string {
    return `${this.keyBase(key)}:hash`;
  }

  private claimKey(key: string): string {
    return `${this.keyBase(key)}:claim`;
  }

  private keyBase(key: string): string {
    // The hash tag keeps all Lua keys in one Redis Cluster slot and avoids
    // exposing a caller-supplied raw idempotency value in key names.
    return `helix:idempotency:{${sha256Hex(key)}}`;
  }
}

function parseStoredRecord(serialized: string): IdempotencyRecord {
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Stored idempotency record is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.requestHash !== "string" ||
    typeof record.statusCode !== "number" ||
    typeof record.expiresAt !== "number" ||
    typeof record.result !== "object" ||
    record.result === null
  ) {
    throw new Error("Stored idempotency record is invalid.");
  }
  return {
    result: record.result as ToolInvokeResult,
    statusCode: record.statusCode,
    requestHash: record.requestHash,
    expiresAt: record.expiresAt,
  };
}

export type IdempotencyOutcome =
  | { readonly kind: "miss" }
  | { readonly kind: "replay"; readonly record: IdempotencyRecord }
  | { readonly kind: "conflict" };

/**
 * Resolves the idempotency state for an incoming request: a cache miss (proceed
 * and store), a replay (return the stored result), or a conflict (the key was
 * reused with a different payload).
 */
export async function resolveIdempotency(
  store: IdempotencyStore,
  key: string,
  requestHash: string,
): Promise<IdempotencyOutcome> {
  const record = await store.get(key);
  if (record === undefined) {
    return { kind: "miss" };
  }
  if (record.requestHash !== requestHash) {
    return { kind: "conflict" };
  }
  return { kind: "replay", record };
}
