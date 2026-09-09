import { withJobSpan } from "../observability/job-span.js";
import type { OrgRecord } from "./orgs.js";

export interface TenantHardDeleteWorkerStore {
  listSoftDeletedTenantsDueForHardDelete(input: {
    readonly before: Date;
    readonly limit?: number | undefined;
  }): Promise<readonly OrgRecord[]>;
  markTenantHardDeleted(input: { readonly orgId: string }): Promise<OrgRecord | null>;
}

export interface TenantHardDeleteStep {
  readonly name: string;
  run(org: OrgRecord): Promise<void>;
}

export interface TenantHardDeleteWorkerOptions {
  readonly store: TenantHardDeleteWorkerStore;
  readonly steps: readonly TenantHardDeleteStep[];
  readonly gracePeriodDays?: number | undefined;
  readonly intervalMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onResult?: (result: TenantHardDeleteWorkerRunResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly onHardDeleted?: (input: {
    readonly previous: OrgRecord;
    readonly updated: OrgRecord;
  }) => Promise<void> | void;
}

export interface TenantHardDeleteWorkerRunResult {
  readonly checked: number;
  readonly purged: number;
  readonly failed: number;
}

const defaultGracePeriodDays = 30;
const defaultIntervalMs = 24 * 60 * 60 * 1000;
const defaultBatchSize = 10;

export class TenantHardDeleteWorker {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly gracePeriodDays: number;
  private readonly now: () => Date;
  private readonly onResult: ((result: TenantHardDeleteWorkerRunResult) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<TenantHardDeleteWorkerRunResult> | undefined;

  constructor(private readonly options: TenantHardDeleteWorkerOptions) {
    this.intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.batchSize = options.batchSize ?? defaultBatchSize;
    this.gracePeriodDays = options.gracePeriodDays ?? defaultGracePeriodDays;
    this.now = options.now ?? (() => new Date());
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runScheduledHardDelete();
    }, this.intervalMs);
    this.timer.unref();
    void this.runScheduledHardDelete();
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

  async runOnce(): Promise<TenantHardDeleteWorkerRunResult> {
    return withJobSpan("tenant-hard-delete", async () => {
      const dueBefore = new Date(this.now().getTime() - this.gracePeriodDays * 24 * 60 * 60 * 1000);
      const dueTenants = await this.options.store.listSoftDeletedTenantsDueForHardDelete({
        before: dueBefore,
        limit: this.batchSize,
      });
      let purged = 0;
      let failed = 0;

      for (const org of dueTenants) {
        try {
          await withJobSpan(
            "tenant-hard-delete.record",
            async () => {
              for (const step of this.options.steps) {
                await step.run(org);
              }
              const updated = await this.options.store.markTenantHardDeleted({ orgId: org.id });
              if (updated === null) {
                failed += 1;
              } else {
                await this.options.onHardDeleted?.({ previous: org, updated });
                purged += 1;
              }
            },
            {
              tenant: {
                orgId: org.id,
                orgSlug: org.slug,
                orgTier: org.tier,
                orgRegion: org.region,
              },
            },
          );
        } catch (error) {
          failed += 1;
          this.onError?.(error);
        }
      }

      return { checked: dueTenants.length, purged, failed };
    });
  }

  private runScheduledHardDelete(): Promise<TenantHardDeleteWorkerRunResult> {
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
        return { checked: 0, purged: 0, failed: 0 };
      })
      .finally(() => {
        this.activeRun = undefined;
      });
    this.activeRun = activeRun;
    return activeRun;
  }
}
