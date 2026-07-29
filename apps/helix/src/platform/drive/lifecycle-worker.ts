export interface DriveLifecycleGcStore {
  collectOrphans(input: {
    readonly olderThan: Date;
    readonly dryRun: boolean;
    readonly limit: number;
  }): Promise<{ readonly candidates: number; readonly collected: number }>;
}

export class DriveLifecycleGcWorker {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(
    private readonly options: {
      readonly store: DriveLifecycleGcStore;
      readonly intervalMs: number;
      readonly orphanGraceHours: number;
      readonly batchSize: number;
      readonly now?: () => Date;
      readonly onResult?: (result: {
        readonly candidates: number;
        readonly collected: number;
      }) => void;
      readonly onError?: (error: unknown) => void;
    },
  ) {}

  async start(): Promise<void> {
    if (this.#timer !== undefined) return;
    await this.runOnce();
    this.#timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = this.options.now?.() ?? new Date();
      const result = await this.options.store.collectOrphans({
        olderThan: new Date(now.getTime() - this.options.orphanGraceHours * 60 * 60 * 1000),
        dryRun: false,
        limit: this.options.batchSize,
      });
      this.options.onResult?.(result);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.#running = false;
    }
  }
}
