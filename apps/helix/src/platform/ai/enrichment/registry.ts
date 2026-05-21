import type { EnrichmentHandler } from "./types.js";
import { subjectMatches } from "./subject.js";

export class EnrichmentHandlerRegistry {
  readonly #handlers = new Map<string, EnrichmentHandler>();

  register(handler: EnrichmentHandler): void {
    this.#handlers.set(handler.id, handler);
  }

  unregister(id: string): boolean {
    return this.#handlers.delete(id);
  }

  list(): readonly EnrichmentHandler[] {
    return [...this.#handlers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  matching(subject: string): readonly EnrichmentHandler[] {
    return this.list().filter((handler) => handler.subjects.some((pattern) => subjectMatches(pattern, subject)));
  }
}
