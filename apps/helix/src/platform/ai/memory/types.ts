import type { Actor, JsonObject } from "@helix/sdk-types";

export interface MemoryEmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface MemoryInput {
  readonly content: string;
  readonly source?: string;
  readonly metadata?: JsonObject;
  readonly embedding?: readonly number[];
  readonly expiresAt?: string;
}

export interface MemoryItem {
  readonly id: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly source: string;
  readonly content: string;
  readonly score?: number;
  readonly metadata?: JsonObject;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface ForgetCriteria {
  readonly ids?: readonly string[];
  readonly olderThan?: string;
  readonly all?: boolean;
}

export interface MemoryStore {
  readonly id: string;
  recall(actor: Actor, query: string, k: number): Promise<readonly MemoryItem[]>;
  store(actor: Actor, item: MemoryInput): Promise<MemoryItem>;
  forget(actor: Actor, criteria: ForgetCriteria): Promise<number>;
}

export function validateMemoryText(text: string, label: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return trimmed;
}

export function validateRecallLimit(k: number): number {
  if (!Number.isSafeInteger(k) || k <= 0) {
    throw new TypeError("Memory recall limit must be a positive safe integer");
  }
  return k;
}

