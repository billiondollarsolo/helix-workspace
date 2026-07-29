import { withJobSpan } from "../observability/job-span.js";
import type { PendingActionRecord, PendingActionStore } from "./registry.js";

export interface PendingActionExpiryRunResult {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly expiredCount: number;
  readonly expired: readonly PendingActionRecord[];
  readonly recoveredUnknownCount: number;
  readonly recoveredUnknown: readonly PendingActionRecord[];
}

export interface PendingActionExpiryWorkerOptions {
  readonly store: PendingActionStore;
  /** How often to sweep for stale pending actions. Defaults to 60s. */
  readonly intervalMs?: number;
  /** Max records expired per sweep. Defaults to 500. */
  readonly batchSize?: number;
  readonly onResult?: (result: PendingActionExpiryRunResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => Date;
}

const defaultIntervalMs = 60_000;
const defaultBatchSize = 500;

/**
 * Leader-gated worker that completes the confirmation flow's timeout path:
 * it periodically transitions `pending_confirmation` actions whose `expiresAt`
 * has passed into the `expired` state (PRD §9.9). Without this worker the
 * `expiresAt` column is decorative and stale approvals never auto-deny.
 *
 * It implements the {@link SupervisedWorker} contract so it can be wrapped by
 * {@link SingletonWorkerSupervisor} — exactly one replica runs the sweep.
 */
export class PendingActionExpiryWorker {
  private readonly store: PendingActionStore;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onResult: ((result: PendingActionExpiryRunResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<PendingActionExpiryRunResult> | undefined;

  constructor(options: PendingActionExpiryWorkerOptions) {
    this.store = options.store;
    this.intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.batchSize = options.batchSize ?? defaultBatchSize;
    this.onResult = options.onResult;
    this.onError = options.onError;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledSweep();
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

  async runOnce(): Promise<PendingActionExpiryRunResult> {
    // P2-6: synthesize a `job.pending-action-expiry` span for each sweep.
    return withJobSpan("pending-action-expiry", async () => {
      const startedAt = this.now();
      const expired = await this.store.expireStale({
        now: startedAt,
        limit: this.batchSize,
      });
      const recoveredUnknown = await this.store.recoverStaleExecutions({
        now: startedAt,
        limit: this.batchSize,
      });
      return {
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        expiredCount: expired.length,
        expired,
        recoveredUnknownCount: recoveredUnknown.length,
        recoveredUnknown,
      };
    });
  }

  private runScheduledSweep(): Promise<PendingActionExpiryRunResult> {
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
        const now = this.now().toISOString();
        return {
          startedAt: now,
          completedAt: now,
          expiredCount: 0,
          expired: [] as readonly PendingActionRecord[],
          recoveredUnknownCount: 0,
          recoveredUnknown: [] as readonly PendingActionRecord[],
        } satisfies PendingActionExpiryRunResult;
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}
