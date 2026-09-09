export interface MeetLifecycleWorkerStore {
  expireEmptyRooms(input: { readonly emptyBefore: Date; readonly limit: number }): Promise<number>;
}

export interface MeetLifecycleWorkerOptions {
  readonly store: MeetLifecycleWorkerStore;
  readonly intervalMs?: number;
  readonly emptyTimeoutMs?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly onResult?: (ended: number) => void;
  readonly onError?: (error: unknown) => void;
}

/** Ends calls whose media bridge vanished after every participant left. */
export class MeetLifecycleWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  constructor(private readonly options: MeetLifecycleWorkerOptions) {}

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    await this.runOnce();
    this.timer = setInterval(
      () => void this.runOnce().catch(() => undefined),
      this.options.intervalMs ?? 30_000,
    );
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(): Promise<number> {
    if (this.running !== undefined) return this.running;
    const now = (this.options.now ?? (() => new Date()))();
    const run = this.options.store
      .expireEmptyRooms({
        emptyBefore: new Date(now.getTime() - (this.options.emptyTimeoutMs ?? 120_000)),
        limit: this.options.batchSize ?? 100,
      })
      .then((ended) => {
        this.options.onResult?.(ended);
        return ended;
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
