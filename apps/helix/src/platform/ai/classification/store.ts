import type { ResourceClassificationRecord, ResourceClassificationStore } from "./types.js";

export class InMemoryResourceClassificationStore implements ResourceClassificationStore {
  readonly #records = new Map<string, ResourceClassificationRecord>();

  async get(input: {
    readonly orgId: string;
    readonly resourceType: string;
    readonly resourceId: string;
  }): Promise<ResourceClassificationRecord | null> {
    return this.#records.get(recordKey(input.orgId, input.resourceType, input.resourceId)) ?? null;
  }

  async set(record: ResourceClassificationRecord): Promise<void> {
    this.#records.set(recordKey(record.orgId, record.resourceType, record.resourceId), record);
  }

  list(): readonly ResourceClassificationRecord[] {
    return [...this.#records.values()].sort((left, right) => {
      const leftKey = recordKey(left.orgId, left.resourceType, left.resourceId);
      const rightKey = recordKey(right.orgId, right.resourceType, right.resourceId);
      return leftKey.localeCompare(rightKey);
    });
  }
}

function recordKey(orgId: string, resourceType: string, resourceId: string): string {
  return `${orgId}:${resourceType}:${resourceId}`;
}
