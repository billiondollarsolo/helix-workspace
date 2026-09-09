import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type {
  SearchEngine,
  SearchIndexer,
  SearchIndexerEvent,
  SearchIndexMutation,
} from "./types.js";
import { applyMutation, type SearchMutationQueue } from "./durable.js";

export interface SearchEventIndexerOptions {
  readonly events: EventBus;
  readonly engine: SearchEngine;
  readonly queue?: SearchMutationQueue | undefined;
  readonly subject?: string;
  readonly onError?: (error: unknown) => void;
  readonly metrics?:
    | {
        recordSearchProjection?(input: {
          readonly indexerId: string;
          readonly status: "success" | "error";
          readonly lagSeconds: number;
        }): void;
      }
    | undefined;
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
    return this.list().filter((indexer) =>
      indexer.subjects.some((pattern) => subjectMatches(pattern, subject)),
    );
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
      const lagSeconds = Math.max(0, (Date.now() - Date.parse(event.occurredAt)) / 1000);
      try {
        const mutation = await indexer.route(indexerEvent);
        const orgId = mutationOrgId(mutation) ?? eventOrgId(indexerEvent);
        if (mutation !== undefined && this.options.queue !== undefined) {
          if (orgId === undefined)
            throw new Error(`Search mutation from ${indexer.id} has no orgId.`);
          await this.options.queue.enqueue({
            orgId,
            indexerId: indexer.id,
            mutation,
            occurredAt: event.occurredAt,
          });
        } else if (mutation !== undefined) {
          await applyMutation(this.options.engine, mutation, orgId);
        }
        this.options.metrics?.recordSearchProjection?.({
          indexerId: indexer.id,
          status: "success",
          lagSeconds,
        });
      } catch (error) {
        this.options.metrics?.recordSearchProjection?.({
          indexerId: indexer.id,
          status: "error",
          lagSeconds,
        });
        this.onError?.(error);
      }
    }
  }
}

function mutationOrgId(mutation: SearchIndexMutation | undefined): string | undefined {
  if (mutation?.orgId !== undefined) return mutation.orgId;
  const orgIds = new Set(
    (mutation?.upsert ?? [])
      .map((document) => document.attributes?.orgId)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  return orgIds.size === 1 ? [...orgIds][0] : undefined;
}

function eventOrgId(event: SearchIndexerEvent): string | undefined {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const orgId = (payload as { readonly orgId?: unknown }).orgId;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
}

function toIndexerEvent<Payload extends JsonValue>(
  event: EventEnvelope<Payload>,
): SearchIndexerEvent<Payload> {
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
