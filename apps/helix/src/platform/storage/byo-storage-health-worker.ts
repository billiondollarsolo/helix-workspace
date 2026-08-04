import { withJobSpan } from "../observability/job-span.js";
import {
  type PersistedTenantStorageHealth,
  persistedTenantStorageHealth,
  testTenantStorageConnection,
} from "./health.js";
import type { TenantStorageResolver } from "./tenant-resolver.js";

export interface UpdateByoStorageHealthInput {
  readonly orgId: string;
  readonly health: PersistedTenantStorageHealth;
  readonly reason?: string | undefined;
}

export interface ByoStorageHealthStore {
  listByoStorageOrgIds(input?: { readonly limit?: number | undefined }): Promise<readonly string[]>;
  updateByoStorageHealth(input: UpdateByoStorageHealthInput): Promise<unknown>;
}

export interface ByoStorageHealthWorkerRunResult {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly checkedCount: number;
  readonly healthyCount: number;
  readonly degradedCount: number;
  readonly errorCount: number;
}

export interface ByoStorageHealthWorkerOptions {
  readonly store: ByoStorageHealthStore;
  readonly storageResolver: TenantStorageResolver | undefined;
  readonly intervalMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly onResult?: (result: ByoStorageHealthWorkerRunResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => Date;
}

const defaultIntervalMs = 60 * 60 * 1000;
const defaultBatchSize = 100;

export class ByoStorageHealthWorker {
  private readonly store: ByoStorageHealthStore;
  private readonly storageResolver: TenantStorageResolver | undefined;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly onResult: ((result: ByoStorageHealthWorkerRunResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<ByoStorageHealthWorkerRunResult> | undefined;

  constructor(options: ByoStorageHealthWorkerOptions) {
    this.store = options.store;
    this.storageResolver = options.storageResolver;
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
      void this.runScheduledRefresh();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledRefresh();
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

  async runOnce(): Promise<ByoStorageHealthWorkerRunResult> {
    return withJobSpan("byo-storage-health-refresh", async () => {
      const startedAt = this.now();
      const orgIds = await this.store.listByoStorageOrgIds({ limit: this.batchSize });
      let healthyCount = 0;
      let degradedCount = 0;
      let errorCount = 0;

      for (const orgId of orgIds) {
        try {
          await withJobSpan("byo-storage-health-refresh.tenant", async () => {
            const health = await testTenantStorageConnection({
              orgId,
              storageResolver: this.storageResolver,
              refresh: true,
            });
            await this.store.updateByoStorageHealth({
              orgId,
              health: persistedTenantStorageHealth(health),
              reason: "byo-storage-health-worker",
            });
            /* Tally after the write lands, not before. The `catch` below sits
               outside this callback, so incrementing first meant a tenant whose
               persist threw was counted twice — once as healthy/degraded here
               and again as an error there — and the three counts could sum to
               more than `checkedCount`. Each tenant owes exactly one outcome. */
            if (health.status === "healthy") {
              healthyCount += 1;
            } else {
              degradedCount += 1;
            }
          });
        } catch (error) {
          errorCount += 1;
          this.onError?.(error);
        }
      }

      return {
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        checkedCount: orgIds.length,
        healthyCount,
        degradedCount,
        errorCount,
      };
    });
  }

  private runScheduledRefresh(): Promise<ByoStorageHealthWorkerRunResult> {
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
          checkedCount: 0,
          healthyCount: 0,
          degradedCount: 0,
          errorCount: 1,
        } satisfies ByoStorageHealthWorkerRunResult;
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}
