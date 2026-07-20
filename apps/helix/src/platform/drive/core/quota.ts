export interface ProjectQuotaInput {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly byteDelta: number;
}

export interface ProjectQuotaResult {
  readonly projectedBytes: number;
  readonly exceeded: boolean;
}

/** Pure quota projection: used + delta vs limit. */
export function projectQuota(input: ProjectQuotaInput): ProjectQuotaResult {
  const projectedBytes = input.usedBytes + input.byteDelta;
  return {
    projectedBytes,
    exceeded: Number.isFinite(projectedBytes) && projectedBytes > input.limitBytes,
  };
}

/** Sum distinct storage-key byte sizes (content-addressed / version reuse). */
export function distinctStoredBytes(
  objects: readonly { readonly storageKey: string; readonly byteSize: number }[],
): number {
  const bytesByStorageKey = new Map<string, number>();
  for (const object of objects) {
    if (!bytesByStorageKey.has(object.storageKey)) {
      bytesByStorageKey.set(object.storageKey, object.byteSize);
    }
  }
  return [...bytesByStorageKey.values()].reduce((sum, byteSize) => sum + byteSize, 0);
}
