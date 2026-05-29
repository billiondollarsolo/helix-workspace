import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createConfiguredVectorStore } from "./config.js";

describe("vector store runtime config", () => {
  it("returns undefined when AI or vector store config is disabled", () => {
    expect(createConfiguredVectorStore(undefined, { sql: fakeSql() })).toBeUndefined();
    expect(
      createConfiguredVectorStore(
        {
          enabled: false,
          vectorStore: { plugin: "com.helix.vector-pgvector" },
        },
        { sql: fakeSql() },
      ),
    ).toBeUndefined();
  });

  it("creates pgvector from platform AI config", () => {
    const store = createConfiguredVectorStore(
      {
        vectorStore: {
          plugin: "com.helix.vector-pgvector@^1.0.0",
        },
      },
      { sql: fakeSql() },
    );

    expect(store?.id).toBe("pgvector");
  });

  it("creates HTTP vector adapters and resolves apiKeyEnv", async () => {
    const calls: { readonly input: URL; readonly init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!(input instanceof URL)) {
        throw new Error("Expected URL input");
      }
      calls.push({ input, init });
      return new Response(JSON.stringify({ result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const store = createConfiguredVectorStore(
      {
        vectorStore: {
          plugin: "com.helix.vector-qdrant@^1.0.0",
          config: {
            baseUrl: "http://qdrant.local",
            apiKeyEnv: "QDRANT_API_KEY",
          },
        },
      },
      { sql: fakeSql(), env: { QDRANT_API_KEY: "qdrant-secret" }, fetch: fetchImpl },
    );

    expect(store?.id).toBe("qdrant");
    const orgId = "00000000-0000-4000-8000-0000000000a1";
    await store?.createCollection(orgId, "docs", 768, "cosine");
    expect(calls[0]?.input.toString()).toBe(
      `http://qdrant.local/collections/${encodeURIComponent(`org_${orgId}__docs`)}`,
    );
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer qdrant-secret",
    });
  });

  it("supports the configured HTTP vector store plugin family", () => {
    const plugins = [
      ["com.helix.vector-milvus", "milvus"],
      ["com.helix.vector-chroma", "chroma"],
      ["com.helix.vector-weaviate", "weaviate"],
    ] as const;

    for (const [plugin, id] of plugins) {
      expect(
        createConfiguredVectorStore(
          {
            vectorStore: {
              plugin,
              config: { baseUrl: `http://${id}.local` },
            },
          },
          { sql: fakeSql(), fetch: async () => new Response("{}") },
        )?.id,
      ).toBe(id);
    }
  });

  it("fails closed for incomplete or unsupported vector store config", () => {
    expect(() =>
      createConfiguredVectorStore(
        {
          vectorStore: { plugin: "com.helix.vector-qdrant" },
        },
        { sql: fakeSql() },
      ),
    ).toThrow("Qdrant vector store requires config.baseUrl");

    expect(() =>
      createConfiguredVectorStore(
        {
          vectorStore: { plugin: "com.helix.vector-unknown" },
        },
        { sql: fakeSql() },
      ),
    ).toThrow("Unsupported vector store plugin");
  });
});

function fakeSql(): postgres.Sql {
  return (() => Promise.resolve([])) as unknown as postgres.Sql;
}
