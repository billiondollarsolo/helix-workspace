import type { EventBus, EventEnvelope, JsonValue, TraceContext, Unsubscribe } from "@helix/sdk-types";

export interface InMemoryEventBusOptions {
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly clock?: (() => Date) | undefined;
}

type EventHandler = (event: EventEnvelope) => Promise<void>;

export class InMemoryEventBus implements EventBus {
  readonly #subscriptions = new Map<string, Set<EventHandler>>();
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #clock: () => Date;

  constructor(options: InMemoryEventBusOptions = {}) {
    this.#onError = options.onError;
    this.#clock = options.clock ?? (() => new Date());
  }

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const envelope: EventEnvelope = {
      subject,
      payload,
      ...(trace === undefined ? {} : { trace }),
      occurredAt: this.#clock().toISOString(),
    };

    const handlers = [...this.#subscriptions.entries()]
      .filter(([filter]) => subjectMatches(filter, subject))
      .flatMap(([, subjectHandlers]) => [...subjectHandlers]);
    const results = await Promise.allSettled(handlers.map((handler) => handler(envelope)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.#onError?.(result.reason);
      }
    }
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    const wrapped = handler as EventHandler;
    let handlers = this.#subscriptions.get(subject);
    if (handlers === undefined) {
      handlers = new Set();
      this.#subscriptions.set(subject, handlers);
    }
    handlers.add(wrapped);

    return () => {
      const current = this.#subscriptions.get(subject);
      current?.delete(wrapped);
      if (current?.size === 0) {
        this.#subscriptions.delete(subject);
      }
    };
  }

  async close(): Promise<void> {
    this.#subscriptions.clear();
  }
}

export function subjectMatches(filter: string, subject: string): boolean {
  const filterParts = filter.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < filterParts.length; index += 1) {
    const filterPart = filterParts[index];
    if (filterPart === ">") {
      return index === filterParts.length - 1 && subjectParts.length > index;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (filterPart !== "*" && filterPart !== subjectParts[index]) {
      return false;
    }
  }

  return filterParts.length === subjectParts.length;
}
