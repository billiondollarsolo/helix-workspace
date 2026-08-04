import { describe, expect, it } from "vitest";
import type { JsonObject } from "@helix/sdk-types";
import type {
  VectorOrgScope,
  VectorStore,
  VectorItem,
  VectorMatch,
  VectorMetric,
  VectorQueryOpts,
} from "../ai/vector/index.js";
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
  it("indexes documents into keyword search and per-org vector storage", async () => {
    const keyword = new FakeSearchEngine();
    const embeddings = new FakeEmbeddingProvider();
    const vectorStore = new FakeVectorStore();
    const engine = new SemanticSearchEngine({ keyword, embeddings, vectorStore });

    await engine.upsert(docs);

    expect(keyword.upserts).toEqual([docs]);
    expect(embeddings.texts).toEqual([
      [
        "Launch mail\nPlanning notes for the product launch",
        "Roadmap deck\nQuarterly launch roadmap",
      ],
    ]);
    expect(vectorStore.collections).toEqual([
      { orgId: "org-1", name: "helix_search", dim: 3, metric: "cosine" },
    ]);
    expect(vectorStore.upserts).toEqual([
      {
        orgId: "org-1",
        collection: "helix_search",
        ids: ["mail:1", "drive:1"],
      },
    ]);
  });

  it("groups vector upserts by tenant when batches mix orgs", async () => {
    const keyword = new FakeSearchEngine();
    const embeddings = new FakeEmbeddingProvider();
    const vectorStore = new FakeVectorStore();
    const engine = new SemanticSearchEngine({ keyword, embeddings, vectorStore });

    await engine.upsert([
      { id: "mail:a", type: "mail", title: "Org A note", attributes: { orgId: "org-a" } },
      { id: "mail:b", type: "mail", title: "Org B note", attributes: { orgId: "org-b" } },
    ]);

    // The two tenants must produce two distinct collection/upsert pairs —
    // never a shared one. Tenant A and B never get a combined call.
    const orgsTouched = vectorStore.upserts.map((upsert) => upsert.orgId).sort();
    expect(orgsTouched).toEqual(["org-a", "org-b"]);
    expect(vectorStore.upserts).toHaveLength(2);
  });

  it("skips vector indexing for documents missing an orgId attribute", async () => {
    const keyword = new FakeSearchEngine();
    const embeddings = new FakeEmbeddingProvider();
    const vectorStore = new FakeVectorStore();
    const engine = new SemanticSearchEngine({ keyword, embeddings, vectorStore });

    await engine.upsert([{ id: "orphan:1", type: "mail", title: "No org", body: "" }]);

    // Keyword side still receives the document but the vector store sees
    // nothing — that prevents an orphan document from being keyed by a
    // tenant id we don't know.
    expect(keyword.upserts).toEqual([
      [{ id: "orphan:1", type: "mail", title: "No org", body: "" }],
    ]);
    expect(vectorStore.upserts).toEqual([]);
    expect(vectorStore.collections).toEqual([]);
  });

  it("paginates the keyword fallback when embeddings return nothing", async () => {
    /* `search` deliberately over-fetches the keyword side — `limit + offset`
       rows starting at 0 — and every path that returns those rows owes the
       caller a slice. Two fallbacks did. The third, taken when the embedding
       provider yields no vector, returned the raw over-fetched response: the
       caller asked for 2 rows starting at 2 and got all 5 starting at 0, so
       page two repeated page one. An outage in embeddings silently became a
       pagination bug in every paged search. */
    const paged = Array.from({ length: 5 }, (_, index) => ({
      id: `mail:${String(index)}`,
      type: "mail",
      title: `Message ${String(index)}`,
      attributes: { orgId: "org-1" },
    })) satisfies readonly IndexDocument[];
    const keyword = new FakeSearchEngine(paged);
    const engine = new SemanticSearchEngine({
      keyword,
      embeddings: new EmptyEmbeddingProvider(),
      vectorStore: new FakeVectorStore(),
    });

    const response = await engine.search({
      query: "message",
      limit: 2,
      offset: 2,
      filter: 'attributes.orgId = "org-1"',
    });

    expect(response.hits.map((hit) => hit.id)).toEqual(["mail:2", "mail:3"]);
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
    expect(vectorStore.queries).toEqual([
      { orgId: "org-1", collection: "helix_search", vector: [0.1, 0.2, 0.3], limit: 50 },
    ]);
    expect(response.hits.map((hit) => hit.id)).toEqual(["mail:1", "chat:1"]);
    expect(response.hits.some((hit) => hit.id === "mail:other")).toBe(false);
    expect(response.hits.some((hit) => hit.id === "drive:1")).toBe(false);
  });

  it("refuses to query the vector store when no tenant filter is supplied", async () => {
    // Without an explicit tenant filter the engine MUST NOT issue a vector
    // query — that would let an unscoped caller fan out across every
    // tenant's embeddings.
    const keyword = new FakeSearchEngine([
      { id: "mail:1", type: "mail", title: "Mail", attributes: { orgId: "org-1" } },
    ]);
    const embeddings = new FakeEmbeddingProvider();
    const vectorStore = new FakeVectorStore();
    const engine = new SemanticSearchEngine({ keyword, embeddings, vectorStore });

    await engine.search({ query: "anything", limit: 5 });

    expect(vectorStore.queries).toEqual([]);
  });

  it("deletes from keyword search; vector deletes are deferred", async () => {
    // A blanket delete cannot run against the vector store without a tenant
    // context, so the engine intentionally no-ops on the vector side.
    const keyword = new FakeSearchEngine();
    const vectorStore = new FakeVectorStore();
    const engine = new SemanticSearchEngine({
      keyword,
      embeddings: new FakeEmbeddingProvider(),
      vectorStore,
    });

    await engine.delete(["mail:1"]);

    expect(keyword.deletes).toEqual([["mail:1"]]);
    expect(vectorStore.deletes).toEqual([]);
  });
});

/** Yields no vector at all, so `search` falls back to keyword-only results.
 *  Mirrors a real embedding provider being unavailable or returning nothing. */
class EmptyEmbeddingProvider {
  async embed(): Promise<readonly (readonly number[])[]> {
    return [];
  }
}

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
  readonly collections: Array<{
    readonly orgId: VectorOrgScope;
    readonly name: string;
    readonly dim: number;
    readonly metric: VectorMetric;
  }> = [];
  readonly upserts: Array<{
    readonly orgId: VectorOrgScope;
    readonly collection: string;
    readonly ids: readonly string[];
  }> = [];
  readonly deletes: Array<{
    readonly orgId: VectorOrgScope;
    readonly collection: string;
    readonly ids: readonly string[];
  }> = [];
  readonly queries: Array<{
    readonly orgId: VectorOrgScope;
    readonly collection: string;
    readonly vector: readonly number[];
    readonly limit: number | undefined;
  }> = [];
  matches: readonly VectorMatch[] = [];

  async createCollection(
    orgId: VectorOrgScope,
    name: string,
    dim: number,
    metric: VectorMetric,
  ): Promise<void> {
    this.collections.push({ orgId, name, dim, metric });
  }

  async upsert(
    orgId: VectorOrgScope,
    collection: string,
    items: readonly VectorItem[],
  ): Promise<void> {
    this.upserts.push({ orgId, collection, ids: items.map((item) => item.id) });
  }

  async query(
    orgId: VectorOrgScope,
    collection: string,
    vector: readonly number[],
    opts?: VectorQueryOpts,
  ): Promise<readonly VectorMatch[]> {
    this.queries.push({ orgId, collection, vector, limit: opts?.limit });
    return this.matches;
  }

  async delete(orgId: VectorOrgScope, collection: string, ids: readonly string[]): Promise<void> {
    this.deletes.push({ orgId, collection, ids: [...ids] });
  }
}

function failDocument(): IndexDocument {
  throw new Error("Expected document");
}

function toJsonObject(document: IndexDocument): JsonObject {
  return JSON.parse(JSON.stringify(document)) as JsonObject;
}
