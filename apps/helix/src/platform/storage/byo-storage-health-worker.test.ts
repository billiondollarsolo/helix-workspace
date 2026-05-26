import { describe, expect, it, vi } from "vitest";
import { ByoStorageHealthWorker, type ByoStorageHealthStore } from "./byo-storage-health-worker.js";
import type { TenantStorageClient } from "./tenant-resolver.js";

describe("ByoStorageHealthWorker", () => {
  it("refreshes BYO storage credentials and persists bounded health for each tenant", async () => {
    const store = new RecordingByoStorageHealthStore(["org-a", "org-b"]);
    const resolverInputs: unknown[] = [];
    const worker = new ByoStorageHealthWorker({
      store,
      batchSize: 2,
      now: fixedNow(),
      storageResolver: async (input) => {
        resolverInputs.push(input);
        return { client: new RecordingStorageClient(), managedBy: "byo", prefix: "helix/" };
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({
      startedAt: "2026-05-24T00:00:00.000Z",
      completedAt: "2026-05-24T00:00:00.000Z",
      checkedCount: 2,
      healthyCount: 2,
      degradedCount: 0,
      errorCount: 0,
    });

    expect(store.listInputs).toEqual([{ limit: 2 }]);
    expect(resolverInputs).toEqual([
      { orgId: "org-a", refresh: true },
      { orgId: "org-b", refresh: true },
    ]);
    const firstCheckedAt = store.healthUpdates[0]?.health.checked_at;
    const secondCheckedAt = store.healthUpdates[1]?.health.checked_at;
    if (firstCheckedAt === undefined || secondCheckedAt === undefined) {
      throw new Error("Expected both BYO storage health updates to include checked_at.");
    }
    expect(firstCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(secondCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(store.healthUpdates).toEqual([
      {
        orgId: "org-a",
        health: {
          status: "healthy",
          checked_at: firstCheckedAt,
          message: "Tenant object storage write/read/delete probe succeeded.",
        },
        reason: "byo-storage-health-worker",
      },
      {
        orgId: "org-b",
        health: {
          status: "healthy",
          checked_at: secondCheckedAt,
          message: "Tenant object storage write/read/delete probe succeeded.",
        },
        reason: "byo-storage-health-worker",
      },
    ]);
  });

  it("continues after one tenant update fails", async () => {
    const errors: unknown[] = [];
    const store = new RecordingByoStorageHealthStore(["org-a", "org-b"], new Set(["org-a"]));
    const worker = new ByoStorageHealthWorker({
      store,
      now: fixedNow(),
      onError: (error) => errors.push(error),
      storageResolver: async ({ orgId }) =>
        orgId === "org-a"
          ? undefined
          : { client: new RecordingStorageClient(), managedBy: "byo", prefix: "helix/" },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      checkedCount: 2,
      healthyCount: 1,
      degradedCount: 1,
      errorCount: 1,
    });

    expect(errors).toHaveLength(1);
    expect(store.healthUpdates.map((update) => update.orgId)).toEqual(["org-b"]);
  });

  it("guards overlapping scheduled runs", async () => {
    vi.useFakeTimers();
    try {
      const store = new RecordingByoStorageHealthStore(["org-a"]);
      let resolveList: ((value: readonly string[]) => void) | undefined;
      const listByoStorageOrgIds = vi.fn(
        () =>
          new Promise<readonly string[]>((resolve) => {
            resolveList = resolve;
          }),
      );
      store.listByoStorageOrgIds = listByoStorageOrgIds;
      const results: unknown[] = [];
      const worker = new ByoStorageHealthWorker({
        store,
        intervalMs: 1000,
        onResult: (result) => results.push(result),
        storageResolver: async () => ({
          client: new RecordingStorageClient(),
          managedBy: "byo",
          prefix: "",
        }),
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(listByoStorageOrgIds).toHaveBeenCalledTimes(1);
      resolveList?.(["org-a"]);
      await Promise.resolve();
      await Promise.resolve();
      await worker.stop();

      expect(results).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function fixedNow(): () => Date {
  return () => new Date("2026-05-24T00:00:00.000Z");
}

class RecordingByoStorageHealthStore implements ByoStorageHealthStore {
  readonly listInputs: unknown[] = [];
  readonly healthUpdates: Parameters<ByoStorageHealthStore["updateByoStorageHealth"]>[0][] = [];

  constructor(
    private readonly orgIds: readonly string[],
    private readonly failingOrgIds: ReadonlySet<string> = new Set(),
  ) {}

  async listByoStorageOrgIds(input?: { readonly limit?: number }): Promise<readonly string[]> {
    this.listInputs.push(input);
    return this.orgIds.slice(0, input?.limit);
  }

  async updateByoStorageHealth(
    input: Parameters<ByoStorageHealthStore["updateByoStorageHealth"]>[0],
  ): Promise<unknown> {
    if (this.failingOrgIds.has(input.orgId)) {
      throw new Error(`update failed for ${input.orgId}`);
    }
    this.healthUpdates.push(input);
    return {};
  }
}

class RecordingStorageClient implements TenantStorageClient {
  #objects = new Map<string, Uint8Array>();

  async put(object: { readonly key: string; readonly body: Uint8Array }): Promise<void> {
    this.#objects.set(object.key, object.body);
  }

  async get(key: string): Promise<{ readonly key: string; readonly body: Uint8Array } | null> {
    const body = this.#objects.get(key);
    return body === undefined ? null : { key, body };
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }
}
