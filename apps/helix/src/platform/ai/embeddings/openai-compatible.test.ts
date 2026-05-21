import { describe, expect, it } from "vitest";
import { createOpenAICompatibleEmbeddingProvider } from "./openai-compatible.js";

interface FetchStub {
  readonly fetch: typeof fetch;
  readonly calls: FetchCall[];
}

type FetchCall = readonly [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]];

function createFetchStub(): FetchStub {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push([input, init]);
    const body = requestBody(init);
    const inputTexts = Array.isArray(body.input) ? body.input : [];
    const data = inputTexts.map((_, index) => ({
      object: "embedding",
      index,
      embedding: [index + calls.length, index + calls.length + 0.5],
    }));
    return new Response(JSON.stringify({ data: data.reverse() }), { status: 200 });
  };
  return { fetch: fetchImpl, calls };
}

function requestBody(init: Parameters<typeof fetch>[1]): Record<string, unknown> {
  if (init === undefined || typeof init.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

function firstUrl(stub: FetchStub): URL {
  const call = stub.calls[0];
  if (call === undefined || !(call[0] instanceof URL)) {
    throw new Error("Expected fetch URL call");
  }
  return call[0];
}

describe("OpenAI-compatible embedding provider", () => {
  it("batches embedding requests and preserves response index order", async () => {
    const stub = createFetchStub();
    const provider = createOpenAICompatibleEmbeddingProvider({
      id: "openai-embeddings",
      baseUrl: "http://localhost:11434/v1",
      models: [{ id: "nomic-embed-text" }],
      defaultDimensions: 768,
      modelDimensions: { "nomic-embed-text": 768 },
      maxBatchSize: 2,
      fetch: stub.fetch,
    });

    const vectors = await provider.embed(["one", "two", "three"], { dimensions: 128 });

    expect(stub.calls).toHaveLength(2);
    expect(firstUrl(stub).toString()).toBe("http://localhost:11434/v1/embeddings");
    expect(requestBody(stub.calls[0]?.[1])).toMatchObject({
      model: "nomic-embed-text",
      input: ["one", "two"],
      dimensions: 128,
    });
    expect(requestBody(stub.calls[1]?.[1])).toMatchObject({
      input: ["three"],
    });
    expect(vectors).toEqual([
      [1, 1.5],
      [2, 2.5],
      [2, 2.5],
    ]);
    expect(provider.dimensions()).toBe(768);
  });
});
