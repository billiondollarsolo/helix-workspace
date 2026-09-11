import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import {
  validateMemoryText,
  validateRecallLimit,
  type ForgetCriteria,
  type MemoryInput,
  type MemoryItem,
  type MemoryStore,
} from "./types.js";

/** Process-local memory used by Assistant tool tests. */
export class InMemoryMemoryStore implements MemoryStore {
  readonly id = "in-memory";
  readonly #items = new Map<string, MemoryItem>();

  async recall(actor: Actor, query: string, k: number): Promise<readonly MemoryItem[]> {
    const needle = validateMemoryText(query, "Memory recall query").toLowerCase();
    const limit = validateRecallLimit(k);
    return this.owned(actor)
      .filter((item) => item.content.toLowerCase().includes(needle))
      .slice(0, limit);
  }

  async list(actor: Actor, limit: number): Promise<readonly MemoryItem[]> {
    return this.owned(actor).slice(0, validateRecallLimit(limit));
  }

  async store(actor: Actor, item: MemoryInput): Promise<MemoryItem> {
    const stored: MemoryItem = {
      id: randomUUID(),
      actorId: actor.id,
      orgId: actor.orgId,
      source: validateMemoryText(item.source ?? "assistant.conversation", "Memory source"),
      content: validateMemoryText(item.content, "Memory content"),
      ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
      createdAt: new Date().toISOString(),
      ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
    };
    this.#items.set(stored.id, stored);
    return stored;
  }

  async replace(actor: Actor, id: string, item: MemoryInput): Promise<MemoryItem | null> {
    const existing = this.#items.get(id);
    if (existing === undefined || existing.orgId !== actor.orgId || existing.actorId !== actor.id)
      return null;
    const stored: MemoryItem = {
      ...existing,
      content: validateMemoryText(item.content, "Memory content"),
      ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    };
    this.#items.set(id, stored);
    return stored;
  }

  async forget(actor: Actor, criteria: ForgetCriteria): Promise<number> {
    const owned = this.owned(actor);
    const remove = owned.filter((item) => {
      if (criteria.all === true) return true;
      if (criteria.ids?.includes(item.id) === true) return true;
      if (criteria.olderThan !== undefined && item.createdAt < criteria.olderThan) return true;
      return false;
    });
    for (const item of remove) this.#items.delete(item.id);
    return remove.length;
  }

  private owned(actor: Actor): MemoryItem[] {
    return [...this.#items.values()]
      .filter((item) => item.orgId === actor.orgId && item.actorId === actor.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}
