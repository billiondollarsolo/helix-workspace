import type { DriveVirusScanRetryBatchResult } from "./store.js";

export interface DriveVirusScanRetryStore {
  runVirusScanRetryBatch(input: {
    readonly limit: number;
    readonly leaseMs: number;
    readonly includeVirusScans?: boolean;
  }): Promise<DriveVirusScanRetryBatchResult>;
}

export interface DriveVirusScanRetryWorkerOptions {
  readonly store: DriveVirusScanRetryStore;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly virusScansEnabled?: boolean;
  readonly onResult?: (result: DriveVirusScanRetryBatchResult) => void;
  readonly onError?: (error: unknown) => void;
}

/** Singleton-supervised durable retry worker for scans and quarantine cleanup. */
export class DriveVirusScanRetryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<DriveVirusScanRetryBatchResult> | undefined;

  constructor(private readonly options: DriveVirusScanRetryWorkerOptions) {}

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    await this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce().catch(() => undefined),
      this.options.intervalMs,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  async runOnce(): Promise<DriveVirusScanRetryBatchResult> {
    if (this.running !== undefined) return this.running;
    const run = this.options.store
      .runVirusScanRetryBatch({
        limit: this.options.batchSize,
        leaseMs: this.options.leaseMs,
        ...(this.options.virusScansEnabled === false ? { includeVirusScans: false } : {}),
      })
      .then((result) => {
        this.options.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        this.options.onError?.(error);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = run;
    return run;
  }
}
