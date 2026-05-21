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
    expect(index.addedDocuments[0]?.map(({ id, type, title, body }) => ({ id, type, title, body }))).toEqual(documents);
    expect(index.addedDocuments[0]?.every((document) => /^h_[a-f0-9]{64}$/u.test(document._key ?? ""))).toBe(true);
    expect(index.deletedIds[0]?.[0]).toMatch(/^h_[a-f0-9]{64}$/u);
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
  readonly createdIndexes: Array<{ readonly uid: string; readonly primaryKey: string | undefined }> = [];
  readonly indexes = new Map<string, FakeMeilisearchIndex>();

  index(uid: string): FakeMeilisearchIndex {
    const existing = this.indexes.get(uid);
    if (existing !== undefined) {
      return existing;
    }

    const index = new FakeMeilisearchIndex();
    this.indexes.set(uid, index);
    return index;
  }

  async createIndex(uid: string, options?: { readonly primaryKey?: string }): Promise<void> {
    this.createdIndexes.push({ uid, primaryKey: options?.primaryKey });
  }
}

class FakeMeilisearchIndex implements MeilisearchIndexLike {
  readonly addedDocuments: Array<Array<IndexDocument & { readonly _key?: string }>> = [];
  readonly deletedIds: string[][] = [];
  readonly searches: Array<{ readonly query: string; readonly options: unknown }> = [];
  nextSearchResponse: MeilisearchSearchResponse = { hits: [] };

  async addDocuments(documents: readonly IndexDocument[]): Promise<void> {
    this.addedDocuments.push([...documents]);
  }

  async deleteDocuments(ids: readonly string[]): Promise<void> {
    this.deletedIds.push([...ids]);
  }

  async search(query: string, options?: unknown): Promise<MeilisearchSearchResponse> {
    this.searches.push({ query, options });
    return this.nextSearchResponse;
  }
}
