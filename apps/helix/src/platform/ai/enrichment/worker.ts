import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import { EnrichmentHandlerRegistry } from "./registry.js";
import type {
  EnrichmentEvent,
  EnrichmentHandler,
  EnrichmentResult,
  EnrichmentWorkerErrorHandler,
  EnrichmentWorkerSummary,
} from "./types.js";

export interface EnrichmentWorkerOptions {
  readonly events: EventBus;
  readonly subject?: string | undefined;
  readonly onResult?: ((result: EnrichmentResult, event: EventEnvelope) => Promise<void> | void) | undefined;
  readonly onError?: EnrichmentWorkerErrorHandler | undefined;
}

export class EnrichmentWorker {
  private readonly subject: string;
  private readonly onResult: ((result: EnrichmentResult, event: EventEnvelope) => Promise<void> | void) | undefined;
  private readonly onError: EnrichmentWorkerErrorHandler | undefined;
  private unsubscribe: Unsubscribe | undefined;

  readonly registry = new EnrichmentHandlerRegistry();

  constructor(private readonly options: EnrichmentWorkerOptions) {
    this.subject = options.subject ?? "activity.*";
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  register(handler: EnrichmentHandler): void {
    this.registry.register(handler);
  }

  unregister(id: string): boolean {
    return this.registry.unregister(id);
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      return;
    }

    this.unsubscribe = await this.options.events.subscribe(this.subject, async (event) => {
      await this.handle(event);
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe === undefined) {
      return;
    }

    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe();
  }

  async handle(event: EventEnvelope): Promise<EnrichmentWorkerSummary> {
    const matching = this.registry.matching(event.subject);
    const results = await Promise.all(matching.map((handler) => this.runHandler(handler, event)));
    return summarize(results);
  }

  private async runHandler(
    handler: EnrichmentHandler,
    event: EventEnvelope,
  ): Promise<EnrichmentResult | undefined> {
    try {
      const result = await handler.enrich(toEnrichmentEvent(event));
      if (result !== undefined) {
        await this.onResult?.(result, event);
      }
      return result;
    } catch (error) {
      this.onError?.(error, event, handler);
      return {
        handlerId: handler.id,
        feature: handler.feature,
        status: "failed",
        metadata: {
          subject: event.subject,
          error: errorMessage(error),
        },
      };
    }
  }
}

function toEnrichmentEvent<Payload extends JsonValue>(event: EventEnvelope<Payload>): EnrichmentEvent<Payload> {
  return {
    subject: event.subject,
    payload: event.payload,
    occurredAt: event.occurredAt,
    ...(event.trace?.traceId === undefined ? {} : { traceId: event.trace.traceId }),
  };
}

function summarize(results: readonly (EnrichmentResult | undefined)[]): EnrichmentWorkerSummary {
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of results) {
    if (result === undefined) {
      skipped += 1;
    } else if (result.status === "applied") {
      applied += 1;
    } else if (result.status === "failed") {
      failed += 1;
    } else {
      skipped += 1;
    }
  }

  return {
    attempted: results.length,
    applied,
    skipped,
    failed,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
