import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { SearchEngine, SearchIndexer, SearchIndexerEvent, SearchIndexMutation } from "./types.js";

export interface SearchEventIndexerOptions {
  readonly events: EventBus;
  readonly engine: SearchEngine;
  readonly subject?: string;
  readonly onError?: (error: unknown) => void;
}

export class SearchIndexerRegistry {
  readonly #indexers = new Map<string, SearchIndexer>();

  register(indexer: SearchIndexer): void {
    this.#indexers.set(indexer.id, indexer);
  }

  unregister(id: string): boolean {
    return this.#indexers.delete(id);
  }

  list(): readonly SearchIndexer[] {
    return [...this.#indexers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  matching(subject: string): readonly SearchIndexer[] {
    return this.list().filter((indexer) => indexer.subjects.some((pattern) => subjectMatches(pattern, subject)));
  }
}

export class SearchEventIndexer {
  private readonly subject: string;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: Unsubscribe | undefined;

  readonly registry = new SearchIndexerRegistry();

  constructor(private readonly options: SearchEventIndexerOptions) {
    this.subject = options.subject ?? "activity.>";
    this.onError = options.onError;
  }

  register(indexer: SearchIndexer): void {
    this.registry.register(indexer);
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

  async handle(event: EventEnvelope): Promise<void> {
    const indexerEvent = toIndexerEvent(event);
    for (const indexer of this.registry.matching(event.subject)) {
      try {
        await this.applyMutation(await indexer.route(indexerEvent));
      } catch (error) {
        this.onError?.(error);
      }
    }
  }

  private async applyMutation(mutation: SearchIndexMutation | undefined): Promise<void> {
    if (mutation === undefined) {
      return;
    }
    if (mutation.upsert !== undefined && mutation.upsert.length > 0) {
      await this.options.engine.upsert(mutation.upsert);
    }
    if (mutation.delete !== undefined && mutation.delete.length > 0) {
      await this.options.engine.delete(mutation.delete);
    }
  }
}

function toIndexerEvent<Payload extends JsonValue>(event: EventEnvelope<Payload>): SearchIndexerEvent<Payload> {
  return {
    subject: event.subject,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

function subjectMatches(pattern: string, subject: string): boolean {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return index === patternParts.length - 1;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
}
