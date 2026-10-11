import { describe, expect, it, vi } from "vitest";
import type { SearchReindexJob } from "./durable.js";
import { SearchInPlaceReindexWorker } from "./in-place-reindex.js";
import type {
  SearchReindexProgress,
  SearchReindexRequest,
  SearchReindexResult,
} from "./reindex.js";

const ORG = "22222222-2222-4222-8222-222222222222";

function job(overrides: Partial<SearchReindexJob> = {}): SearchReindexJob {
  return {
    id: "job-1",
    orgId: ORG,
    requestedByActorId: "actor-1",
    mode: "in_place",
    targetOrgId: ORG,
    types: ["mail", "drive"],
    batchSize: 50,
    shadowIndexUid: null,
    pruneStale: true,
    status: "processing",
    phase: "backfill",
    sourceIndex: 0,
    startMutationId: 0n,
    replayMutationId: 0n,
    totalDocuments: 0n,
    deletedDocuments: 0n,
    counts: {},
    attemptCount: 1,
    leaseToken: "lease",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function result(): SearchReindexResult {
  return {
    status: "completed",
    engineId: "test",
    types: ["mail", "drive"],
    totalDocuments: 3,
    deletedDocuments: 1,
    counts: { mail: 2, chat: 0, drive: 1, calendar: 0 },
    batchSize: 50,
  };
}

function setup(options: {
  readonly claimed?: SearchReindexJob;
  readonly progressAccepted?: boolean;
  readonly reindex?: (input: SearchReindexRequest) => Promise<SearchReindexResult>;
}) {
  const tenants: string[] = [];
  const store = {
    claimJobs: vi.fn(async () => (options.claimed === undefined ? [] : [options.claimed])),
    progressJob: vi.fn(
      async (_job: SearchReindexJob, _progress: SearchReindexProgress, _leaseSeconds: number) =>
        options.progressAccepted ?? true,
    ),
    completeJob: vi.fn(async () => undefined),
    failJob: vi.fn(async () => undefined),
    withTenant: <T>(orgId: string, work: () => Promise<T>): Promise<T> => {
      tenants.push(orgId);
      return work();
    },
  };
  const service = { reindex: vi.fn(options.reindex ?? (async () => result())) };
  const onError = vi.fn();
  const worker = new SearchInPlaceReindexWorker({ store, service, onError });
  return { store, service, worker, tenants, onError };
}

describe("SearchInPlaceReindexWorker", () => {
  it("claims only in-place jobs and does nothing when none are due", async () => {
    const { store, worker } = setup({});
    await expect(worker.drainOnce()).resolves.toBe(0);
    expect(store.claimJobs).toHaveBeenCalledWith(expect.objectContaining({ mode: "in_place" }));
  });

  it("reindexes the job's organization in its tenant context and records the result", async () => {
    const { store, service, worker, tenants } = setup({
      claimed: job(),
      reindex: async (input) => {
        await input.onProgress?.({
          sourceIndex: 0,
          totalDocuments: 2,
          deletedDocuments: 0,
          counts: { mail: 2 },
        });
        return result();
      },
    });

    await expect(worker.drainOnce()).resolves.toBe(1);

    expect(tenants).toEqual([ORG]);
    expect(service.reindex).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        types: ["mail", "drive"],
        batchSize: 50,
        pruneStale: true,
      }),
    );
    expect(store.progressJob.mock.calls.map((call) => call[1])).toEqual([
      { sourceIndex: 0, totalDocuments: 2, deletedDocuments: 0, counts: { mail: 2 } },
      {
        sourceIndex: 2,
        totalDocuments: 3,
        deletedDocuments: 1,
        counts: { mail: 2, chat: 0, drive: 1, calendar: 0 },
      },
    ]);
    expect(store.completeJob).toHaveBeenCalledTimes(1);
    expect(store.failJob).not.toHaveBeenCalled();
  });

  it("stops without failing the job once it was cancelled", async () => {
    const { store, worker, onError } = setup({
      claimed: job(),
      progressAccepted: false,
      reindex: async (input) => {
        await input.onProgress?.({
          sourceIndex: 0,
          totalDocuments: 1,
          deletedDocuments: 0,
          counts: { mail: 1 },
        });
        throw new Error("must not get here");
      },
    });

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(store.completeJob).not.toHaveBeenCalled();
    expect(store.failJob).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("schedules a retry with the error when the reindex fails", async () => {
    const { store, worker, onError } = setup({
      claimed: job({ attemptCount: 2 }),
      reindex: async () => {
        throw new Error("search engine unavailable");
      },
    });

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(store.failJob).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "search engine unavailable",
        retryDelaySeconds: 4,
        maxAttempts: 3,
      }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
