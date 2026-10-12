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
  /**
   * Called when the set of failing probes changes, for the operator's log.
   * The public probe still answers one bit; the reason is never sent to clients.
   */
  readonly onChange?: (failures: readonly ReadinessProbeFailure[]) => void;
}

export interface ReadinessProbeFailure {
  readonly id: string;
  readonly reason: string;
}

const defaultCacheMs = 5_000;
const defaultTimeoutMs = 2_000;

/** Runs required dependency probes concurrently, with a short shared cache. */
export class ReadinessMonitor {
  readonly #cacheMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #onChange: ((failures: readonly ReadinessProbeFailure[]) => void) | undefined;
  #reported = "";
  #cached: { readonly expiresAt: number; readonly result: ReadinessResult } | undefined;
  #inFlight: Promise<ReadinessResult> | undefined;

  constructor(
    private readonly probes: readonly ReadinessProbe[],
    options: ReadinessMonitorOptions = {},
  ) {
    this.#cacheMs = nonNegativeInteger(options.cacheMs ?? defaultCacheMs, "cacheMs");
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? defaultTimeoutMs, "timeoutMs");
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange;
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
          failure: await probeFailure(probe.check, this.#timeoutMs),
        })),
      );
      const checkedAt = this.#now();
      const failures = outcomes.flatMap((outcome) =>
        outcome.failure === undefined ? [] : [{ id: outcome.id, reason: outcome.failure }],
      );
      const failedProbeIds = failures.map((failure) => failure.id);
      const signature = failedProbeIds.join(",");
      if (signature !== this.#reported) {
        this.#reported = signature;
        this.#onChange?.(failures);
      }
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

/** Undefined when the probe passed; otherwise why it failed. */
async function probeFailure(
  check: () => Promise<void>,
  timeoutMs: number,
): Promise<string | undefined> {
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
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Readiness probe failed";
    // Connection errors can echo a URL; never log embedded credentials.
    return reason.replace(/\/\/[^@\s/]+@/gu, "//***@");
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
