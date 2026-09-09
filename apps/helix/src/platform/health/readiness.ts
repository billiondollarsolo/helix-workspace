import type { FastifyInstance } from "fastify";

export interface ReadinessProbe {
  readonly id: string;
  readonly check: () => Promise<void>;
}

export interface ReadinessResult {
  readonly ok: boolean;
  readonly failedProbeIds: readonly string[];
  readonly checkedAt: string;
}

export interface ReadinessMonitorOptions {
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const defaultCacheMs = 5_000;
const defaultTimeoutMs = 2_000;

/** Runs required dependency probes concurrently, with a short shared cache. */
export class ReadinessMonitor {
  readonly #cacheMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  #cached: { readonly expiresAt: number; readonly result: ReadinessResult } | undefined;
  #inFlight: Promise<ReadinessResult> | undefined;

  constructor(
    private readonly probes: readonly ReadinessProbe[],
    options: ReadinessMonitorOptions = {},
  ) {
    this.#cacheMs = nonNegativeInteger(options.cacheMs ?? defaultCacheMs, "cacheMs");
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? defaultTimeoutMs, "timeoutMs");
    this.#now = options.now ?? (() => new Date());
  }

  check(): Promise<ReadinessResult> {
    const now = this.#now().getTime();
    if (this.#cached !== undefined && now < this.#cached.expiresAt) {
      return Promise.resolve(this.#cached.result);
    }
    this.#inFlight ??= this.#run();
    return this.#inFlight;
  }

  async #run(): Promise<ReadinessResult> {
    try {
      const outcomes = await Promise.all(
        this.probes.map(async (probe) => ({
          id: probe.id,
          ok: await probeSucceeded(probe.check, this.#timeoutMs),
        })),
      );
      const checkedAt = this.#now();
      const failedProbeIds = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.id);
      const result: ReadinessResult = {
        ok: failedProbeIds.length === 0,
        failedProbeIds,
        checkedAt: checkedAt.toISOString(),
      };
      this.#cached = { result, expiresAt: checkedAt.getTime() + this.#cacheMs };
      return result;
    } finally {
      this.#inFlight = undefined;
    }
  }
}

/** Public probes intentionally expose one bit and no dependency diagnostics. */
export function registerHealthRoutes(app: FastifyInstance, monitor: ReadinessMonitor): void {
  app.get("/healthz", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { ok: true };
  });
  app.get("/readyz", async (_request, reply) => {
    const result = await monitor.check();
    reply.header("cache-control", "no-store");
    return reply.code(result.ok ? 200 : 503).send({ ok: result.ok });
  });
}

async function probeSucceeded(check: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timeout.addEventListener(
          "abort",
          () => {
            reject(new Error("Readiness probe timed out"));
          },
          { once: true },
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}
