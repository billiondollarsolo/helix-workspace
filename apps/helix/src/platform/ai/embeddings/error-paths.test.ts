import { describe, expect, it } from "vitest";
import { createOpenAICompatibleEmbeddingProvider } from "./openai-compatible.js";

/**
 * Error-path coverage for the OpenAI-compatible embedding provider. The
 * happy path lives in `openai-compatible.test.ts`; this file covers config
 * validation, HTTP failure, and malformed-response handling.
 */

type FetchFactory = () => Response | Promise<Response>;

function fetchReturning(factory: FetchFactory): typeof fetch {
  return async () => factory();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseConfig = {
  id: "embeddings",
  baseUrl: "http://localhost:11434/v1",
  models: [{ id: "nomic-embed-text" }],
  defaultDimensions: 768,
};

describe("OpenAI-compatible embedding provider — error paths", () => {
  it("rejects a non-positive defaultDimensions at construction", () => {
    expect(() =>
      createOpenAICompatibleEmbeddingProvider({ ...baseConfig, defaultDimensions: 0 }),
    ).toThrow("defaultDimensions must be a positive integer");
  });

  it("rejects a non-integer defaultDimensions at construction", () => {
    expect(() =>
      createOpenAICompatibleEmbeddingProvider({ ...baseConfig, defaultDimensions: 1.5 }),
    ).toThrow("defaultDimensions must be a positive integer");
  });

  it("rejects a non-positive maxBatchSize at construction", () => {
    expect(() =>
      createOpenAICompatibleEmbeddingProvider({ ...baseConfig, maxBatchSize: 0 }),
    ).toThrow("maxBatchSize must be a positive integer");
  });

  it("returns an empty array for empty input without calling fetch", async () => {
    let called = false;
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...baseConfig,
      fetch: fetchReturning(() => {
        called = true;
        return jsonResponse({ data: [] });
      }),
    });
    await expect(provider.embed([])).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("throws an AIProviderRequestError on a non-2xx response", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...baseConfig,
      fetch: fetchReturning(() => new Response("rate limited", { status: 429 })),
    });
    await expect(provider.embed(["hello"])).rejects.toThrow("429");
  });

  it("throws when the response body is not a JSON object", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...baseConfig,
      fetch: fetchReturning(() => jsonResponse([1, 2, 3])),
    });
    await expect(provider.embed(["hello"])).rejects.toThrow("must be an object");
  });

  it("throws when the vector count does not match the input count", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...baseConfig,
      fetch: fetchReturning(() =>
        jsonResponse({ data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }] }),
      ),
    });
    await expect(provider.embed(["one", "two"])).rejects.toThrow(
      "1 vectors for 2 inputs",
    );
  });

  it("drops rows with non-finite embedding values and surfaces a count mismatch", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...baseConfig,
      fetch: fetchReturning(() =>
        jsonResponse({
          data: [{ object: "embedding", index: 0, embedding: [Number.NaN] }],
        }),
      ),
    });
    await expect(provider.embed(["one"])).rejects.toThrow("0 vectors for 1 inputs");
  });

  it("reorders out-of-order response rows by their index field", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...baseConfig,
      fetch: fetchReturning(() =>
        jsonResponse({
          data: [
            { object: "embedding", index: 1, embedding: [9, 9] },
            { object: "embedding", index: 0, embedding: [1, 1] },
          ],
        }),
      ),
    });
    await expect(provider.embed(["a", "b"])).resolves.toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it("resolves declared dimensions per model and falls back to the default", () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      ...baseConfig,
      modelDimensions: { "nomic-embed-text": 768, "big-model": 1536 },
    });
    expect(provider.dimensions("big-model")).toBe(1536);
    expect(provider.dimensions("unknown-model")).toBe(768);
  });
});
