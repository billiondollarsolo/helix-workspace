import { describe, expect, it } from "vitest";
import {
  MeilisearchSearchEngine,
  type MeilisearchClientLike,
  type MeilisearchIndexLike,
  type MeilisearchSearchResponse,
} from "./meilisearch.js";
import type { IndexDocument } from "./types.js";

describe("MeilisearchSearchEngine", () => {
  it("creates the configured index when requested", async () => {
    const client = new FakeMeilisearchClient();
    const engine = new MeilisearchSearchEngine(client, { indexUid: "helix_search" });

    await engine.ensureIndex();

    expect(client.createdIndexes).toEqual([{ uid: "helix_search", primaryKey: "_key" }]);
    expect(client.index("helix_search").settings).toEqual([
      {
        filterableAttributes: ["type", "attributes.orgId", "attributes.allowedActorIds"],
        searchableAttributes: ["title", "body"],
      },
    ]);
    expect(client.waitedTasks).toEqual([1, 2]);
  });

  it("indexes a single document through upsert", async () => {
    const client = new FakeMeilisearchClient();
    const engine = new MeilisearchSearchEngine(client, { indexUid: "helix_search" });
    const document = { id: "mail:1", type: "mail", title: "Hello" } satisfies IndexDocument;

    await engine.index(document);

    expect(client.index("helix_search").addedDocuments[0]?.[0]).toMatchObject(document);
    expect(client.index("helix_search").addedDocuments[0]?.[0]?._key).toMatch(/^h_[a-f0-9]{64}$/u);
  });

  it("upserts and deletes batches without network access", async () => {
    const client = new FakeMeilisearchClient();
    const engine = new MeilisearchSearchEngine(client, { indexUid: "helix_search" });
    const documents = [
      { id: "mail:1", type: "mail", title: "Hello" },
      { id: "chat:1", type: "chat", body: "Project update" },
    ] satisfies readonly IndexDocument[];

    await engine.upsert(documents);
    await engine.delete(["mail:1"]);

    const index = client.index("helix_search");
    expect(
      index.addedDocuments[0]?.map(({ id, type, title, body }) => ({ id, type, title, body })),
    ).toEqual(documents);
    expect(
      index.addedDocuments[0]?.every((document) => /^h_[a-f0-9]{64}$/u.test(document._key ?? "")),
    ).toBe(true);
    expect(index.deletedIds[0]?.[0]).toMatch(/^h_[a-f0-9]{64}$/u);
    expect(client.waitedTasks).toEqual([3, 4]);
  });

  it("skips empty upsert and delete batches", async () => {
    const client = new FakeMeilisearchClient();
    const engine = new MeilisearchSearchEngine(client, { indexUid: "helix_search" });

    await engine.upsert([]);
    await engine.delete([]);

    const index = client.index("helix_search");
    expect(index.addedDocuments).toEqual([]);
    expect(index.deletedIds).toEqual([]);
  });

  it("writes a shadow index and waits for its atomic swap", async () => {
    const client = new FakeMeilisearchClient();
    const live = new MeilisearchSearchEngine(client, { indexUid: "helix_search" });
    const shadow = live.forIndex("helix_search_shadow_job");

    await shadow.upsert([{ id: "drive:1", type: "drive" }]);
    await live.swapWith("helix_search_shadow_job");

    expect(client.index("helix_search_shadow_job").addedDocuments).toHaveLength(1);
    expect(client.swaps).toEqual([["helix_search", "helix_search_shadow_job"]]);
    expect(client.waitedTasks).toEqual([3, 5]);
  });

  it("maps search requests and Meilisearch hits into engine responses", async () => {
    const client = new FakeMeilisearchClient();
    const index = client.index("helix_search");
    index.nextSearchResponse = {
      hits: [
        {
          id: "mail:1",
          type: "mail",
          title: "Hello",
          _rankingScore: 0.93,
          _formatted: { title: "<em>Hello</em>" },
        },
      ],
      query: "hello",
      estimatedTotalHits: 1,
      processingTimeMs: 3,
    };
    const engine = new MeilisearchSearchEngine(client, { indexUid: "helix_search" });

    const response = await engine.search({
      query: "hello",
      types: ["mail", "chat"],
      limit: 10,
      offset: 20,
      filter: "attributes.orgId = org_1",
      attributesToRetrieve: ["id", "type", "title"],
    });

    expect(index.searches).toEqual([
      {
        query: "hello",
        options: {
          limit: 10,
          offset: 20,
          filter: ['type IN ["mail", "chat"]', "attributes.orgId = org_1"],
          attributesToRetrieve: ["id", "type", "title"],
        },
      },
    ]);
    expect(response).toEqual({
      hits: [
        {
          id: "mail:1",
          type: "mail",
          title: "Hello",
          score: 0.93,
          highlights: { title: "<em>Hello</em>" },
        },
      ],
      query: "hello",
      estimatedTotalHits: 1,
      processingTimeMs: 3,
    });
  });
});

class FakeMeilisearchClient implements MeilisearchClientLike {
  readonly createdIndexes: Array<{
    readonly uid: string;
    readonly primaryKey: string | undefined;
  }> = [];
  readonly indexes = new Map<string, FakeMeilisearchIndex>();
  readonly waitedTasks: number[] = [];
  readonly swaps: Array<readonly [string, string]> = [];

  index(uid: string): FakeMeilisearchIndex {
    const existing = this.indexes.get(uid);
    if (existing !== undefined) {
      return existing;
    }

    const index = new FakeMeilisearchIndex();
    this.indexes.set(uid, index);
    return index;
  }

  async createIndex(uid: string, options?: { readonly primaryKey?: string }): Promise<unknown> {
    this.createdIndexes.push({ uid, primaryKey: options?.primaryKey });
    return { taskUid: 1 };
  }

  async waitForTask(uid: number): Promise<void> {
    this.waitedTasks.push(uid);
  }

  async swapIndexes(indexes: readonly [string, string]): Promise<unknown> {
    this.swaps.push(indexes);
    return { taskUid: 5 };
  }
}

class FakeMeilisearchIndex implements MeilisearchIndexLike {
  readonly addedDocuments: Array<Array<IndexDocument & { readonly _key?: string }>> = [];
  readonly deletedIds: string[][] = [];
  readonly searches: Array<{ readonly query: string; readonly options: unknown }> = [];
  nextSearchResponse: MeilisearchSearchResponse = { hits: [] };
  readonly settings: unknown[] = [];

  async updateSettings(settings: unknown): Promise<unknown> {
    this.settings.push(settings);
    return { taskUid: 2 };
  }

  async addDocuments(documents: readonly IndexDocument[]): Promise<unknown> {
    this.addedDocuments.push([...documents]);
    return { taskUid: 3 };
  }

  async deleteDocuments(ids: readonly string[]): Promise<unknown> {
    this.deletedIds.push([...ids]);
    return { taskUid: 4 };
  }

  async search(query: string, options?: unknown): Promise<MeilisearchSearchResponse> {
    this.searches.push({ query, options });
    return this.nextSearchResponse;
  }
}
