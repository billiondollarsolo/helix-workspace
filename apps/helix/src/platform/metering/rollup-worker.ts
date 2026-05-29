import { withJobSpan } from "../observability/job-span.js";
import type { MeteringRollupRunResult, MeteringRollupStore } from "./store.js";

export interface MeteringRollupWorkerOptions {
  readonly store: MeteringRollupStore;
  readonly intervalMs?: number;
  readonly periodBatchSize?: number;
  readonly onResult?: (result: MeteringRollupWorkerRunResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => Date;
}

export interface MeteringRollupWorkerRunResult extends MeteringRollupRunResult {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly cutoff: string;
}

const defaultIntervalMs = 24 * 60 * 60 * 1000;
const defaultPeriodBatchSize = 250;

export class MeteringRollupWorker {
  private readonly intervalMs: number;
  private readonly periodBatchSize: number;
  private readonly onResult: ((result: MeteringRollupWorkerRunResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<MeteringRollupWorkerRunResult> | undefined;

  constructor(private readonly options: MeteringRollupWorkerOptions) {
    this.intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.periodBatchSize = options.periodBatchSize ?? defaultPeriodBatchSize;
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runScheduledRollup();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledRollup();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activeRun !== undefined) {
      await this.activeRun;
    }
  }

  runOnce(): Promise<MeteringRollupWorkerRunResult> {
    return withJobSpan("metering-rollup-nightly", async () => {
      const startedAt = this.now();
      const cutoff = startOfUtcDay(startedAt);
      const result = await this.options.store.rollupCompletedPeriods({
        cutoff,
        periodLimit: this.periodBatchSize,
      });
      return {
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        cutoff: cutoff.toISOString(),
        ...result,
      };
    });
  }

  private runScheduledRollup(): Promise<MeteringRollupWorkerRunResult> {
    if (this.activeRun !== undefined) {
      return this.activeRun;
    }
    const activeRun = this.runOnce()
      .then((result) => {
        this.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        this.onError?.(error);
        const now = this.now();
        const timestamp = now.toISOString();
        return {
          startedAt: timestamp,
          completedAt: timestamp,
          cutoff: startOfUtcDay(now).toISOString(),
          periodCount: 0,
          rollupCount: 0,
          eventCount: 0,
        };
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}
