import { randomUUID } from "node:crypto";
import { errorMessage } from "../util/errors.js";
import type { PostgresSearchDurabilityStore } from "./durable.js";
import type { SearchReindexProgress, SearchReindexRunner } from "./reindex.js";

const LEASE_SECONDS = 300;
/** Progress is written at most this often; each write also renews the lease. */
const PROGRESS_INTERVAL_MS = 2_000;

/** The job was cancelled or its lease lost while it ran. */
class SearchReindexJobStopped extends Error {}

type InPlaceJobStore = Pick<
  PostgresSearchDurabilityStore,
  "claimJobs" | "progressJob" | "completeJob" | "failJob" | "withTenant"
>;

/**
 * Runs queued in-place reindex jobs (`POST /api/admin/search/reindex`): one
 * organization into the live index, in that organization's tenant context.
 * Progress reports renew the job's lease; a worker that stops mid-run lets the
 * lease expire and the job is claimed again from the start, which is safe
 * because indexing is idempotent. A cancelled job stops at its next report.
 */
export class SearchInPlaceReindexWorker {
  private readonly owner = `search-in-place-reindex-${randomUUID()}`;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<number> | undefined;

  constructor(
    private readonly options: {
      readonly store: InPlaceJobStore;
      readonly service: SearchReindexRunner;
      readonly intervalMs?: number | undefined;
      readonly maxAttempts?: number | undefined;
      readonly onError?: ((error: unknown) => void) | undefined;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.runScheduled(), this.options.intervalMs ?? 1_000);
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }

  async drainOnce(): Promise<number> {
    const [job] = await this.options.store.claimJobs({
      owner: this.owner,
      mode: "in_place",
      limit: 1,
      leaseSeconds: LEASE_SECONDS,
    });
    if (job === undefined) return 0;
    let lastReportAt = 0;
    const report = async (progress: SearchReindexProgress, final: boolean): Promise<void> => {
      if (!final && Date.now() - lastReportAt < PROGRESS_INTERVAL_MS) return;
      lastReportAt = Date.now();
      if (!(await this.options.store.progressJob(job, progress, LEASE_SECONDS))) {
        throw new SearchReindexJobStopped();
      }
    };
    try {
      const orgId = job.targetOrgId;
      if (orgId === undefined) throw new Error("An in-place reindex job needs its organization.");
      const result = await this.options.store.withTenant(orgId, () =>
        this.options.service.reindex({
          orgId,
          types: job.types,
          batchSize: job.batchSize,
          pruneStale: job.pruneStale,
          onProgress: (progress) => report(progress, false),
        }),
      );
      await report(
        {
          sourceIndex: job.types.length,
          totalDocuments: result.totalDocuments,
          deletedDocuments: result.deletedDocuments,
          counts: result.counts,
        },
        true,
      );
      await this.options.store.completeJob(job);
    } catch (error) {
      if (error instanceof SearchReindexJobStopped) return 1;
      await this.options.store.failJob({
        job,
        error: errorMessage(error),
        retryDelaySeconds: Math.min(3600, 2 ** job.attemptCount),
        maxAttempts: this.options.maxAttempts ?? 3,
      });
      this.options.onError?.(error);
    }
    return 1;
  }

  private runScheduled(): Promise<number> {
    if (this.active !== undefined) return this.active;
    this.active = this.drainOnce()
      .catch((error: unknown) => {
        this.options.onError?.(error);
        return 0;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}
