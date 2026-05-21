import { describe, expect, it } from "vitest";
import type { JsonObject } from "@helix/sdk-types";
import type { VectorStore, VectorItem, VectorMatch, VectorMetric, VectorQueryOpts } from "../ai/vector/index.js";
import { SemanticSearchEngine } from "./semantic.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "./types.js";

const docs = [
  {
    id: "mail:1",
    type: "mail",
    title: "Launch mail",
    body: "Planning notes for the product launch",
    attributes: { orgId: "org-1" },
  },
  {
    id: "drive:1",
    type: "drive",
    title: "Roadmap deck",
    body: "Quarterly launch roadmap",
    attributes: { orgId: "org-1" },
  },
] satisfies readonly IndexDocument[];

describe("SemanticSearchEngine", () => {
  it("indexes documents into keyword search and vector storage", async () => {
    const keyword = new FakeSearchEngine();
    const embeddings = new FakeEmbeddingProvider();
    const vectorStore = new FakeVectorStore();
    const engine = new SemanticSearchEngine({ keyword, embeddings, vectorStore });

    await engine.upsert(docs);

    expect(keyword.upserts).toEqual([docs]);
    expect(embeddings.texts).toEqual([
      ["Launch mail\nPlanning notes for the product launch", "Roadmap deck\nQuarterly launch roadmap"],
    ]);
    expect(vectorStore.collections).toEqual([{ name: "helix_search", dim: 3, metric: "cosine" }]);
    expect(vectorStore.upserts).toEqual([
      {
        collection: "helix_search",
        ids: ["mail:1", "drive:1"],
      },
    ]);
  });

  it("embeds the query and fuses semantic results without leaking other orgs", async () => {
    const keyword = new FakeSearchEngine([
      docs[0] ?? failDocument(),
      {
        id: "chat:1",
        type: "chat",
        title: "Chat launch",
        attributes: { orgId: "org-1" },
      },
    ]);
    const embeddings = new FakeEmbeddingProvider();
    const vectorStore = new FakeVectorStore();
    vectorStore.matches = [
      {
        id: "drive:1",
        score: 0.97,
        metadata: {
          document: toJsonObject(docs[1] ?? failDocument()),
          type: "drive",
          orgId: "org-1",
        },
      },
      {
        id: "mail:other",
        score: 0.99,
        metadata: {
          document: {
            id: "mail:other",
            type: "mail",
            title: "Other org",
            attributes: { orgId: "org-2" },
          },
          type: "mail",
          orgId: "org-2",
        },
      },
    ];
    const engine = new SemanticSearchEngine({ keyword, embeddings, vectorStore });

    const response = await engine.search({
      query: "roadmap",
      types: ["mail", "drive"],
      limit: 5,
      filter: 'attributes.orgId = "org-1"',
    });

    expect(keyword.searches).toEqual([
      {
        query: "roadmap",
        types: ["mail", "drive"],
        limit: 5,
        offset: 0,
        filter: 'attributes.orgId = "org-1"',
      },
    ]);
    expect(vectorStore.queries).toEqual([{ collection: "helix_search", vector: [0.1, 0.2, 0.3], limit: 50 }]);
    expect(response.hits.map((hit) => hit.id)).toEqual(["mail:1", "chat:1"]);
    expect(response.hits.some((hit) => hit.id === "mail:other")).toBe(false);
    expect(response.hits.some((hit) => hit.id === "drive:1")).toBe(false);
  });

  it("deletes from both keyword and vector indexes", async () => {
    const keyword = new FakeSearchEngine();
    const vectorStore = new FakeVectorStore();
    const engine = new SemanticSearchEngine({
      keyword,
      embeddings: new FakeEmbeddingProvider(),
      vectorStore,
    });

    await engine.delete(["mail:1"]);

    expect(keyword.deletes).toEqual([["mail:1"]]);
    expect(vectorStore.deletes).toEqual([{ collection: "helix_search", ids: ["mail:1"] }]);
  });
});

class FakeEmbeddingProvider {
  readonly texts: readonly string[][] = [];

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    (this.texts as string[][]).push([...texts]);
    return texts.map(() => [0.1, 0.2, 0.3]);
  }
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "keyword";
  readonly upserts: readonly IndexDocument[][] = [];
  readonly deletes: readonly string[][] = [];
  readonly searches: readonly SearchRequest[] = [];

  constructor(private readonly hits: readonly IndexDocument[] = []) {}

  async index(document: IndexDocument): Promise<void> {
    await this.upsert([document]);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    (this.upserts as IndexDocument[][]).push([...documents]);
  }

  async delete(ids: readonly string[]): Promise<void> {
    (this.deletes as string[][]).push([...ids]);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    (this.searches as SearchRequest[]).push(request);
    return {
      hits: this.hits,
      query: request.query,
      estimatedTotalHits: this.hits.length,
    };
  }
}

class FakeVectorStore implements VectorStore {
  readonly id = "vector";
  readonly collections: Array<{ readonly name: string; readonly dim: number; readonly metric: VectorMetric }> = [];
  readonly upserts: Array<{ readonly collection: string; readonly ids: readonly string[] }> = [];
  readonly deletes: Array<{ readonly collection: string; readonly ids: readonly string[] }> = [];
  readonly queries: Array<{ readonly collection: string; readonly vector: readonly number[]; readonly limit: number | undefined }> = [];
  matches: readonly VectorMatch[] = [];

  async createCollection(name: string, dim: number, metric: VectorMetric): Promise<void> {
    this.collections.push({ name, dim, metric });
  }

  async upsert(collection: string, items: readonly VectorItem[]): Promise<void> {
    this.upserts.push({ collection, ids: items.map((item) => item.id) });
  }

  async query(collection: string, vector: readonly number[], opts?: VectorQueryOpts): Promise<readonly VectorMatch[]> {
    this.queries.push({ collection, vector, limit: opts?.limit });
    return this.matches;
  }

  async delete(collection: string, ids: readonly string[]): Promise<void> {
    this.deletes.push({ collection, ids: [...ids] });
  }
}

function failDocument(): IndexDocument {
  throw new Error("Expected document");
}

function toJsonObject(document: IndexDocument): JsonObject {
  return JSON.parse(JSON.stringify(document)) as JsonObject;
}
