import { describe, expect, it } from "vitest";
import {
  SearchMutationWorker,
  SearchShadowReindexWorker,
  type ClaimedSearchMutation,
  type SearchReindexJob,
} from "./durable.js";
import type { SearchReindexSource } from "./reindex.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "./types.js";

describe("SearchMutationWorker", () => {
  it("retries failures and dual-writes active shadows before checkpointing", async () => {
    const mutation: ClaimedSearchMutation = {
      id: 1n,
      orgId: "org-1",
      mutation: { upsert: [{ id: "drive:1", type: "drive" }] },
      attemptCount: 1,
      leaseToken: "lease",
    };
    const completed: bigint[] = [];
    const failed: bigint[] = [];
    let claims = 0;
    const store = {
      claimMutations: async () => (claims++ < 2 ? [mutation] : []),
      activeShadowIndexUids: async () => ["shadow"],
      completeMutation: async (item: ClaimedSearchMutation) => void completed.push(item.id),
      failMutation: async (item: ClaimedSearchMutation) => void failed.push(item.id),
      withTenant: async (_orgId: string, callback: () => Promise<unknown>) => callback(),
      withMutationSwapLock: async (callback: () => Promise<unknown>) => callback(),
    };
    const live = new FakeEngine(true);
    const shadow = new FakeEngine();
    const worker = new SearchMutationWorker({
      store: store as never,
      engine: live,
      shadowEngine: () => shadow,
    });

    await worker.drainOnce();
    await worker.drainOnce();

    expect(failed).toEqual([1n]);
    expect(completed).toEqual([1n]);
    expect(shadow.upserts.flat().map((document) => document.id)).toEqual(["drive:1"]);
  });

  it("creates a queued shadow job's index before mirroring a delete into it", async () => {
    const mutations: ClaimedSearchMutation[] = [1n, 2n].map((id) => ({
      id,
      orgId: "org-1",
      mutation: { delete: [`chat:${String(id)}`] },
      attemptCount: 1,
      leaseToken: "lease",
    }));
    const completed: bigint[] = [];
    const failed: bigint[] = [];
    let claimed = false;
    const store = {
      claimMutations: async () => (claimed ? [] : ((claimed = true), mutations)),
      activeShadowIndexUids: async () => ["helix_search_shadow_queued"],
      completeMutation: async (item: ClaimedSearchMutation) => void completed.push(item.id),
      failMutation: async (item: ClaimedSearchMutation) => void failed.push(item.id),
      withTenant: async (_orgId: string, callback: () => Promise<unknown>) => callback(),
      withMutationSwapLock: async (callback: () => Promise<unknown>) => callback(),
    };
    // Queued by offboarding: the shadow worker has not created the index yet.
    const shadow = new FakeEngine(false, false);
    const worker = new SearchMutationWorker({
      store: store as never,
      engine: new FakeEngine(),
      shadowEngine: () => shadow,
    });

    await worker.drainOnce();

    expect(failed).toEqual([]);
    expect(completed).toEqual([1n, 2n]);
    expect(shadow.deletes).toEqual([["chat:1"], ["chat:2"]]);
    expect(shadow.ensureIndexCalls).toBe(1);
  });
});

describe("SearchShadowReindexWorker", () => {
  it("persists one keyset page at a time, replays the checkpoint, then swaps", async () => {
    const checkpoints: Array<Partial<SearchReindexJob> & { documentCount: number }> = [];
    let job = baseJob();
    let claimed = true;
    const swaps: string[] = [];
    const store = {
      claimJobs: async () => (claimed ? ((claimed = false), [job]) : []),
      checkpointJob: async (input: (typeof checkpoints)[number] & { job: SearchReindexJob }) => {
        checkpoints.push(input);
      },
      replayPage: async () => ({ mutations: [], liveCheckpoint: 0n }),
      completeJob: async () => undefined,
      jobLeaseActive: async () => true,
      withMutationSwapLock: async (callback: () => Promise<unknown>) => callback(),
      failJob: async () => undefined,
    };
    const source: SearchReindexSource = {
      type: "drive",
      collect: async () => [],
      collectPage: async ({ cursor }) => ({
        documents: [{ id: cursor === undefined ? "drive:1" : "drive:2", type: "drive" }],
        cursor: {
          updatedAt: "2026-09-03T00:00:00.000Z",
          id: "00000000-0000-4000-8000-000000000001",
        },
        done: cursor !== undefined,
      }),
    };
    const shadow = new FakeEngine();
    const worker = new SearchShadowReindexWorker({
      store: store as never,
      sources: [source],
      shadowEngine: () => Object.assign(shadow, { ensureIndex: async () => undefined }),
      swap: async (uid) => void swaps.push(uid),
    });

    await worker.drainOnce();
    expect(checkpoints[0]).toMatchObject({ sourceIndex: 0, documentCount: 1 });
    expect(swaps).toEqual([]);

    job = { ...job, sourceCursor: checkpoints[0]?.sourceCursor, attemptCount: 2 };
    claimed = true;
    await worker.drainOnce();
    expect(checkpoints[1]).toMatchObject({ sourceIndex: 1, documentCount: 1 });

    job = { ...job, phase: "replay", sourceIndex: 1, attemptCount: 3 };
    claimed = true;
    await worker.drainOnce();
    expect(checkpoints[2]).toMatchObject({ phase: "swap" });

    job = { ...job, phase: "swap", sourceIndex: 1, attemptCount: 4 };
    claimed = true;
    await worker.drainOnce();
    expect(swaps).toEqual(["shadow"]);
    expect(shadow.upserts.map((batch) => batch.length)).toEqual([1, 1]);
  });
});

function baseJob(): SearchReindexJob {
  return {
    id: "job",
    orgId: "org-1",
    requestedByActorId: "actor-1",
    mode: "shadow",
    types: ["drive"],
    batchSize: 1,
    shadowIndexUid: "shadow",
    pruneStale: false,
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
  };
}

class FakeEngine implements SearchEngine {
  readonly id = "fake";
  readonly upserts: IndexDocument[][] = [];
  readonly deletes: string[][] = [];
  ensureIndexCalls = 0;
  constructor(
    private failOnce = false,
    private exists = true,
  ) {}
  async ensureIndex(): Promise<void> {
    this.ensureIndexCalls += 1;
    this.exists = true;
  }
  async index(document: IndexDocument): Promise<void> {
    await this.upsert([document]);
  }
  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("outage");
    }
    this.upserts.push([...documents]);
  }
  async delete(ids: readonly string[]): Promise<void> {
    if (!this.exists) throw new Error("index_not_found");
    this.deletes.push([...ids]);
  }
  async search(request: SearchRequest): Promise<SearchResponse> {
    return { hits: [], query: request.query };
  }
}
