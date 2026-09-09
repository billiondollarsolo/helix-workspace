export type SmtpRateLimitScope = "connection" | "message";

export interface SmtpRateLimitStore {
  consume(input: {
    readonly scope: SmtpRateLimitScope;
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
  }): Promise<boolean>;
}

interface WindowRecord {
  count: number;
  resetAt: number;
}

/**
 * Bounded process-local fixed-window limiter.
 *
 * Production may inject a shared Redis implementation through the same
 * interface. The default still prevents a single listener process from being
 * used as an unbounded SMTP sink.
 */
export class InMemorySmtpRateLimitStore implements SmtpRateLimitStore {
  readonly #records = new Map<string, WindowRecord>();
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(options?: { readonly now?: () => number; readonly maxKeys?: number }) {
    this.#now = options?.now ?? Date.now;
    this.#maxKeys = positiveInteger(options?.maxKeys ?? 10_000, "maxKeys");
  }

  async consume(input: {
    readonly scope: SmtpRateLimitScope;
    readonly key: string;
    readonly limit: number;
    readonly windowMs: number;
  }): Promise<boolean> {
    const limit = positiveInteger(input.limit, "limit");
    const windowMs = positiveInteger(input.windowMs, "windowMs");
    const now = this.#now();
    const mapKey = `${input.scope}:${input.key}`;
    const current = this.#records.get(mapKey);
    if (current === undefined || current.resetAt <= now) {
      this.#makeRoom(now);
      this.#records.set(mapKey, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (current.count >= limit) {
      return false;
    }
    current.count += 1;
    return true;
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
