import { describe, expect, it } from "vitest";
import { ChromaVectorStore } from "./chroma.js";
import { MilvusVectorStore } from "./milvus.js";
import { QdrantVectorStore } from "./qdrant.js";
import { WeaviateVectorStore } from "./weaviate.js";

interface FetchStub {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
}

interface FetchCall {
  readonly url: URL;
  readonly init: RequestInit;
}

type FetchResponseFactory = (call: FetchCall) => Response;

function createFetchStub(factory: FetchResponseFactory = () => jsonResponse({ ok: true })): FetchStub {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!(input instanceof URL) || init === undefined) {
      throw new Error("Expected vector adapter to call fetch with URL and init");
    }
    const call = { url: input, init };
    calls.push(call);
    return factory(call);
  };
  return { fetch: fetchImpl, calls };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(call: FetchCall): unknown {
  if (typeof call.init.body !== "string") {
    throw new Error("Expected string JSON body");
  }
  return JSON.parse(call.init.body) as unknown;
}

const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
// The external HTTP adapters tenant-scope by namespacing the collection name
// (see scopedCollectionName in types.ts). The on-the-wire path for org A's
// `docs` becomes `org_<orgA>__docs`. Two tenants reusing `docs` get two
// distinct external collections.
const QDRANT_DOCS_ORG_A = `org_${ORG_A}__docs`;
const CHROMA_DOCS_ORG_A = `org_${ORG_A}__docs`;
const MILVUS_DOCS_ORG_A = `org_${ORG_A}__docs`;
// Weaviate class names cannot contain `-`; the adapter normalizes them to `_`.
const WEAVIATE_DOCS_ORG_A = `Helix_org_${ORG_A.replace(/-/g, "_")}__docs`;

describe("HTTP vector adapters", () => {
  it("maps Qdrant collection, point, search, and delete requests", async () => {
    const stub = createFetchStub((call) => {
      if (call.url.pathname.endsWith("/points/search")) {
        return jsonResponse({
          result: [{ id: "doc-1", score: 0.82, payload: { type: "doc" }, vector: [0.1, 0.2] }],
        });
      }
      return jsonResponse({ result: true });
    });
    const store = new QdrantVectorStore({ baseUrl: "http://qdrant.local", apiKey: "secret", fetch: stub.fetch });

    await store.createCollection(ORG_A, "docs", 2, "cosine");
    await store.upsert(ORG_A, "docs", [{ id: "doc-1", vector: [0.1, 0.2], metadata: { type: "doc" } }]);
    const matches = await store.query(ORG_A, "docs", [0.1, 0.2], { limit: 3, filter: { type: "doc" }, includeVectors: true });
    await store.delete(ORG_A, "docs", ["doc-1"]);

    expect(stub.calls.map((call) => [call.init.method, call.url.pathname + call.url.search])).toEqual([
      ["PUT", `/collections/${encodeURIComponent(QDRANT_DOCS_ORG_A)}`],
      ["PUT", `/collections/${encodeURIComponent(QDRANT_DOCS_ORG_A)}/points?wait=true`],
      ["POST", `/collections/${encodeURIComponent(QDRANT_DOCS_ORG_A)}/points/search`],
      ["POST", `/collections/${encodeURIComponent(QDRANT_DOCS_ORG_A)}/points/delete?wait=true`],
    ]);
    expect(requestBody(stub.calls[0] ?? failCall())).toEqual({ vectors: { size: 2, distance: "Cosine" } });
    expect(requestBody(stub.calls[2] ?? failCall())).toMatchObject({ limit: 3, with_payload: true, with_vector: true });
    expect(matches).toEqual([{ id: "doc-1", score: 0.82, metadata: { type: "doc" }, vector: [0.1, 0.2] }]);
  });

  it("isolates tenants by namespacing Qdrant collection names", async () => {
    const stub = createFetchStub(() => jsonResponse({ result: true }));
    const store = new QdrantVectorStore({ baseUrl: "http://qdrant.local", fetch: stub.fetch });

    await store.createCollection(ORG_A, "docs", 2, "cosine");
    await store.createCollection(ORG_B, "docs", 2, "cosine");

    const paths = stub.calls.map((call) => call.url.pathname);
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths[0]).toContain(ORG_A);
    expect(paths[1]).toContain(ORG_B);
  });

  it("maps Milvus REST requests and responses", async () => {
    const stub = createFetchStub((call) => {
      if (call.url.pathname.endsWith("/entities/search")) {
        return jsonResponse({ data: { data: [{ id: "doc-1", score: 0.7, metadata: { type: "doc" }, vector: [1, 2] }] } });
      }
      return jsonResponse({ code: 0 });
    });
    const store = new MilvusVectorStore({ baseUrl: "http://milvus.local", fetch: stub.fetch });

    await store.createCollection(ORG_A, "docs", 2, "dot");
    await store.upsert(ORG_A, "docs", [{ id: "doc-1", vector: [1, 2], metadata: { type: "doc" } }]);
    const matches = await store.query(ORG_A, "docs", [1, 2], { includeVectors: true });
    await store.delete(ORG_A, "docs", ["doc-1"]);

    expect(stub.calls.map((call) => call.url.pathname)).toEqual([
      "/v2/vectordb/collections/create",
      "/v2/vectordb/entities/upsert",
      "/v2/vectordb/entities/search",
      "/v2/vectordb/entities/delete",
    ]);
    expect(requestBody(stub.calls[0] ?? failCall())).toMatchObject({ collectionName: MILVUS_DOCS_ORG_A, dimension: 2, metricType: "IP" });
    expect(matches).toEqual([{ id: "doc-1", score: 0.7, metadata: { type: "doc" }, vector: [1, 2] }]);
  });

  it("maps Chroma collection, upsert, query, and delete requests", async () => {
    const stub = createFetchStub((call) => {
      if (call.url.pathname.endsWith("/query")) {
        return jsonResponse({
          ids: [["doc-1"]],
          distances: [[0.25]],
          metadatas: [[{ type: "doc" }]],
          embeddings: [[[1, 2]]],
        });
      }
      return jsonResponse({ id: "docs" });
    });
    const store = new ChromaVectorStore({ baseUrl: "http://chroma.local", fetch: stub.fetch });

    await store.createCollection(ORG_A, "docs", 2, "l2");
    await store.upsert(ORG_A, "docs", [{ id: "doc-1", vector: [1, 2], metadata: { type: "doc" } }]);
    const matches = await store.query(ORG_A, "docs", [1, 2], { includeVectors: true });
    await store.delete(ORG_A, "docs", ["doc-1"]);

    expect(stub.calls.map((call) => call.url.pathname)).toEqual([
      "/api/v1/collections",
      `/api/v1/collections/${encodeURIComponent(CHROMA_DOCS_ORG_A)}/upsert`,
      `/api/v1/collections/${encodeURIComponent(CHROMA_DOCS_ORG_A)}/query`,
      `/api/v1/collections/${encodeURIComponent(CHROMA_DOCS_ORG_A)}/delete`,
    ]);
    expect(requestBody(stub.calls[2] ?? failCall())).toMatchObject({ n_results: 10, include: ["metadatas", "distances", "embeddings"] });
    expect(matches).toEqual([{ id: "doc-1", score: 0.8, metadata: { type: "doc" }, vector: [1, 2] }]);
  });

  it("maps Weaviate schema, batch, GraphQL, and object delete requests", async () => {
    const stub = createFetchStub((call) => {
      if (call.url.pathname === "/v1/graphql") {
        return jsonResponse({
          data: {
            Get: {
              [WEAVIATE_DOCS_ORG_A]: [{ helixId: "doc-1", metadata: { type: "doc" }, vector: [1, 2], _additional: { score: 0.9 } }],
            },
          },
        });
      }
      return jsonResponse({ ok: true });
    });
    const store = new WeaviateVectorStore({ baseUrl: "http://weaviate.local", fetch: stub.fetch });

    await store.createCollection(ORG_A, "docs", 2, "cosine");
    await store.upsert(ORG_A, "docs", [{ id: "doc-1", vector: [1, 2], metadata: { type: "doc" } }]);
    const matches = await store.query(ORG_A, "docs", [1, 2], { filter: { type: "doc" }, includeVectors: true });
    await store.delete(ORG_A, "docs", ["doc-1"]);

    expect(stub.calls.map((call) => [call.init.method, call.url.pathname])).toEqual([
      ["POST", "/v1/schema"],
      ["POST", "/v1/batch/objects"],
      ["POST", "/v1/graphql"],
      ["DELETE", `/v1/objects/${WEAVIATE_DOCS_ORG_A}/doc-1`],
    ]);
    expect(requestBody(stub.calls[0] ?? failCall())).toMatchObject({ class: WEAVIATE_DOCS_ORG_A, vectorizer: "none" });
    expect(matches).toEqual([{ id: "doc-1", score: 0.9, metadata: { type: "doc" }, vector: [1, 2] }]);
  });
});

function failCall(): FetchCall {
  throw new Error("Expected fetch call");
}

