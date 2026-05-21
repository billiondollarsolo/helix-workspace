import type { EventBus, JsonValue, OutboxMessage, TraceContext } from "@helix/sdk-types";
import { withJobSpan } from "../observability/job-span.js";

export interface StoredOutboxMessage<Payload extends JsonValue = JsonValue> extends OutboxMessage<Payload> {
  readonly id: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly lastError?: string;
}

export interface OutboxStore {
  insert(message: OutboxMessage): Promise<string>;
  claimUndelivered(limit: number): Promise<readonly StoredOutboxMessage[]>;
  markDelivered(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export interface OutboxDrainResult {
  readonly delivered: number;
  readonly failed: number;
}

export interface OutboxWorkerOptions {
  readonly store: OutboxStore;
  readonly events: EventBus;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export class OutboxHelper {
  constructor(
    private readonly store: OutboxStore,
    private readonly events: EventBus,
  ) {}

  enqueue(subject: string, payload: JsonValue, trace?: TraceContext): Promise<string> {
    return this.store.insert({ subject, payload, ...(trace === undefined ? {} : { trace }) });
  }

  drain(limit = 100): Promise<OutboxDrainResult> {
    return drainOutbox(this.store, this.events, limit);
  }
}

export class OutboxWorker {
  private readonly store: OutboxStore;
  private readonly events: EventBus;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activeDrain: Promise<OutboxDrainResult> | undefined;

  constructor(options: OutboxWorkerOptions) {
    this.store = options.store;
    this.events = options.events;
    this.batchSize = options.batchSize ?? 100;
    this.intervalMs = options.intervalMs ?? 1000;
    if (options.onError !== undefined) {
      this.onError = options.onError;
    }
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runScheduledDrain();
    }, this.intervalMs);
    void this.runScheduledDrain();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.activeDrain !== undefined) {
      await this.activeDrain;
    }
  }

  drainOnce(): Promise<OutboxDrainResult> {
    // P2-6: synthesize a `job.outbox-drain` span for each drain cycle.
    return withJobSpan("outbox-drain", () =>
      drainOutbox(this.store, this.events, this.batchSize),
    );
  }

  private runScheduledDrain(): Promise<OutboxDrainResult> {
    if (this.activeDrain !== undefined) {
      return this.activeDrain;
    }

    this.activeDrain = this.drainOnce()
      .catch((error: unknown) => {
        this.onError?.(error);
        return { delivered: 0, failed: 0 };
      })
      .finally(() => {
        this.activeDrain = undefined;
      });

    return this.activeDrain;
  }
}

async function drainOutbox(
  store: OutboxStore,
  events: EventBus,
  limit: number,
): Promise<OutboxDrainResult> {
  const messages = await store.claimUndelivered(limit);
  let delivered = 0;
  let failed = 0;

  for (const message of messages) {
    try {
      await events.publish(message.subject, message.payload, message.trace);
      await store.markDelivered(message.id);
      delivered += 1;
    } catch (error) {
      failed += 1;
      await store.markFailed(message.id, error instanceof Error ? error.message : String(error));
    }
  }

  return { delivered, failed };
}
