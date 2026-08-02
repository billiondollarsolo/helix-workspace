/**
 * Meet abuse rate limits (MT.6) for room create and join (JWT mint).
 *
 * Process-local fixed-window limiter keyed by org + actor + action.
 * Production may inject a shared Redis implementation via the same interface.
 */

export type MeetRateLimitAction = "create_room" | "join_room";

export interface MeetRateLimitBudget {
  /** Max creates per window (default 10). */
  readonly createRoomLimit: number;
  /** Max join/mint-token operations per window (default 30). */
  readonly joinRoomLimit: number;
  /** Window length in ms (default 1 hour). */
  readonly windowMs: number;
}

export interface MeetRateLimitConsumeInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly action: MeetRateLimitAction;
  readonly budget?: Partial<MeetRateLimitBudget> | undefined;
}

export interface MeetRateLimitAllowed {
  readonly allowed: true;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetsAt: Date;
}

export interface MeetRateLimitExceeded {
  readonly allowed: false;
  readonly limit: number;
  readonly used: number;
  readonly remaining: 0;
  readonly retryAfterSeconds: number;
  readonly resetsAt: Date;
  readonly action: MeetRateLimitAction;
  readonly code: "meet_rate_limited";
  readonly message: string;
}

export type MeetRateLimitDecision = MeetRateLimitAllowed | MeetRateLimitExceeded;

export interface MeetRateLimiter {
  consume(input: MeetRateLimitConsumeInput): Promise<MeetRateLimitDecision>;
}

export const defaultMeetRateLimitBudget: MeetRateLimitBudget = {
  createRoomLimit: 10,
  joinRoomLimit: 30,
  windowMs: 60 * 60 * 1000,
};

interface WindowRecord {
  count: number;
  resetAt: number;
}

export class InMemoryMeetRateLimiter implements MeetRateLimiter {
  readonly #records = new Map<string, WindowRecord>();
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #defaultBudget: MeetRateLimitBudget;

  constructor(options?: {
    readonly now?: () => number;
    readonly maxKeys?: number;
    readonly budget?: Partial<MeetRateLimitBudget>;
  }) {
    this.#now = options?.now ?? Date.now;
    this.#maxKeys = positiveInteger(options?.maxKeys ?? 10_000, "maxKeys");
    this.#defaultBudget = resolveBudget(options?.budget);
  }

  async consume(input: MeetRateLimitConsumeInput): Promise<MeetRateLimitDecision> {
    const budget = resolveBudget({ ...this.#defaultBudget, ...input.budget });
    const limit = input.action === "create_room" ? budget.createRoomLimit : budget.joinRoomLimit;
    const windowMs = budget.windowMs;
    const now = this.#now();
    const mapKey = `${input.action}:${input.orgId}:${input.actorId}`;
    const current = this.#records.get(mapKey);

    if (current === undefined || current.resetAt <= now) {
      this.#makeRoom(now);
      const resetAt = now + windowMs;
      this.#records.set(mapKey, { count: 1, resetAt });
      return {
        allowed: true,
        limit,
        used: 1,
        remaining: Math.max(limit - 1, 0),
        resetsAt: new Date(resetAt),
      };
    }

    if (current.count >= limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      return {
        allowed: false,
        limit,
        used: current.count,
        remaining: 0,
        retryAfterSeconds,
        resetsAt: new Date(current.resetAt),
        action: input.action,
        code: "meet_rate_limited",
        message:
          input.action === "create_room"
            ? `Meet room create rate limit exceeded (${String(limit)} per window). Retry after ${String(retryAfterSeconds)}s.`
            : `Meet room join rate limit exceeded (${String(limit)} per window). Retry after ${String(retryAfterSeconds)}s.`,
      };
    }

    current.count += 1;
    return {
      allowed: true,
      limit,
      used: current.count,
      remaining: Math.max(limit - current.count, 0),
      resetsAt: new Date(current.resetAt),
    };
  }

  reset(input?: {
    readonly orgId?: string;
    readonly actorId?: string;
    readonly action?: MeetRateLimitAction;
  }): void {
    if (input?.orgId === undefined && input?.actorId === undefined && input?.action === undefined) {
      this.#records.clear();
      return;
    }
    for (const key of [...this.#records.keys()]) {
      const [action, orgId, actorId] = key.split(":");
      if (input.action !== undefined && action !== input.action) {
        continue;
      }
      if (input.orgId !== undefined && orgId !== input.orgId) {
        continue;
      }
      if (input.actorId !== undefined && actorId !== input.actorId) {
        continue;
      }
      this.#records.delete(key);
    }
  }

  #makeRoom(now: number): void {
    if (this.#records.size < this.#maxKeys) {
      return;
    }
    for (const [key, record] of this.#records) {
      if (record.resetAt <= now) {
        this.#records.delete(key);
      }
    }
    while (this.#records.size >= this.#maxKeys) {
      const oldestKey = this.#records.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.#records.delete(oldestKey);
    }
  }
}

export function meetRateLimitError(decision: MeetRateLimitExceeded): Error {
  const error = new Error(decision.message);
  error.name = "MeetRateLimitError";
  Object.assign(error, {
    code: decision.code,
    retryAfterSeconds: decision.retryAfterSeconds,
    action: decision.action,
    limit: decision.limit,
  });
  return error;
}

function resolveBudget(partial?: Partial<MeetRateLimitBudget>): MeetRateLimitBudget {
  return {
    createRoomLimit: positiveInteger(
      partial?.createRoomLimit ?? defaultMeetRateLimitBudget.createRoomLimit,
      "createRoomLimit",
    ),
    joinRoomLimit: positiveInteger(
      partial?.joinRoomLimit ?? defaultMeetRateLimitBudget.joinRoomLimit,
      "joinRoomLimit",
    ),
    windowMs: positiveInteger(partial?.windowMs ?? defaultMeetRateLimitBudget.windowMs, "windowMs"),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
