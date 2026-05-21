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
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

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
