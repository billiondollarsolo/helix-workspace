import { describe, expect, it, vi } from "vitest";
import { chunkDocument, documentText, hydrateChunk, retrievalChunkSettings } from "./chunks.js";
import { SemanticSearchEngine } from "./semantic.js";
import type { IndexDocument, SearchEngine } from "./types.js";
import type { VectorItem, VectorStore } from "../ai/vector/types.js";

const document: IndexDocument = {
  id: "drive:file",
  type: "drive",
  title: "Long document",
  body: "Opening details. ".repeat(200) + "The final launch code is blue-sparrow.",
  url: "/drive/file",
  attributes: { orgId: "tenant", allowedActorIds: ["alice"] },
};

describe("retrieval passages", () => {
  it("covers the entire source with bounded overlapping Unicode-safe passages and stable citations", () => {
    const source = { ...document, body: "word 😀 ".repeat(100) + "Final answer" };
    const chunks = chunkDocument(source, { size: 64, overlap: 10 });
    const text = documentText(source);
    let end = 0;
    for (const chunk of chunks) {
      const start = chunk.document.attributes.chunkStart;
      expect(start).toBeLessThanOrEqual(end);
      expect(chunk.text.length).toBeLessThanOrEqual(64);
      expect(new TextDecoder().decode(new TextEncoder().encode(chunk.text))).toBe(chunk.text);
      expect(chunk.text).toBe(text.slice(start, chunk.document.attributes.chunkEnd));
      expect(chunk.document.id).toBe(source.id);
      expect(chunk.document.url).toBe(source.url);
      end = chunk.document.attributes.chunkEnd;
    }
    expect(end).toBe(text.length);
    expect(chunks.at(-1)?.text).toContain("Final answer");
    const last = chunks.at(-1);
    if (last === undefined) throw new Error("Expected document chunks");
    expect(hydrateChunk(source, last.document.attributes)?.body).toBe(last.text);
    expect(
      hydrateChunk({ ...source, body: "Changed content" }, last.document.attributes),
    ).toBeNull();
    expect(hydrateChunk(source, { ...last.document.attributes, chunkStart: -1 })).toBeNull();
    expect(hydrateChunk(source, undefined)).toEqual(source);
    expect(chunkDocument({ id: "empty", type: "drive" }, { size: 64, overlap: 0 })).toEqual([]);
    expect(() =>
      chunkDocument({ ...source, body: "x".repeat(3000) }, { size: 64, overlap: 63 }),
    ).toThrow("2048 chunks");
  });

  it("validates chunk size and overlap without silently replacing invalid values", () => {
    expect(retrievalChunkSettings()).toEqual({ size: 1024, overlap: 153 });
    expect(retrievalChunkSettings({ maxInputChars: 64, chunkOverlapChars: 0 })).toEqual({
      size: 64,
      overlap: 0,
    });
    for (const value of [0, 63, 32769, 1.5, "1024"])
      expect(() => retrievalChunkSettings({ maxInputChars: value })).toThrow("Chunk size");
    for (const value of [-1, 64, 0.5, "1"])
      expect(() => retrievalChunkSettings({ maxInputChars: 64, chunkOverlapChars: value })).toThrow(
        "Chunk overlap",
      );
  });

  it("retrieves a late passage, deduplicates sources, removes old passages on shrink/delete and keeps prior vectors on embedding failure", async () => {
    const items = new Map<string, VectorItem>();
    const remove = vi.fn(
      async (_org: string | null, _collection: string, ids: readonly string[]) => {
        for (const [id, item] of items)
          if (ids.includes((item.metadata?.document as { id: string }).id)) items.delete(id);
      },
    );
    const vectorStore: VectorStore = {
      id: "test",
      createCollection: async () => {},
      delete: async () => {},
      deleteByDocumentIds: remove,
      upsert: async (_org, _collection, batch) => {
        batch.forEach((item) => items.set(item.id, item));
      },
      query: async () =>
        [...items.values()]
          .sort((a, b) => (b.vector[0] ?? 0) - (a.vector[0] ?? 0))
          .map((item) => ({ ...item, score: item.vector[0] ?? 0 })),
    };
    const keyword: SearchEngine = {
      id: "keyword",
      index: async () => {},
      upsert: async () => {},
      delete: async () => {},
      search: async (request) => ({ query: request.query, hits: [document] }),
    };
    const embed = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => [text.includes("blue-sparrow") ? 1 : 0, 1]),
    );
    const engine = new SemanticSearchEngine({
      keyword,
      vectorStore,
      embeddings: { embed },
      chunking: { size: 128, overlap: 20 },
    });
    await engine.index(document);
    expect(items.size).toBeGreaterThan(20);
    expect(embed.mock.calls.every(([batch]) => batch.length <= 32)).toBe(true);
    const result = await engine.search({
      query: "launch code",
      forOrgId: "tenant",
      forActorId: "alice",
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.body).toContain("blue-sparrow");
    expect(result.hits[0]?.attributes?.searchProvenance).toBe("hybrid");
    expect(hydrateChunk(document, result.hits[0]?.attributes)?.body).toContain("blue-sparrow");
    expect(
      (await engine.search({ query: "launch code", forOrgId: "other", forActorId: "alice" })).hits,
    ).toEqual([]);
    expect(
      (await engine.search({ query: "launch code", forOrgId: "tenant", forActorId: "bob" })).hits,
    ).toEqual([]);
    const size = items.size;
    embed.mockRejectedValueOnce(new Error("Embedding unavailable"));
    await expect(engine.index({ ...document, body: "replacement" })).rejects.toThrow(
      "Embedding unavailable",
    );
    expect(items.size).toBe(size);
    await engine.index({ ...document, body: "replacement" });
    expect(items.size).toBe(1);
    await engine.delete([document.id], "tenant");
    expect(items.size).toBe(0);
    expect(remove).toHaveBeenLastCalledWith("tenant", "helix_search", [document.id]);
  });
});
