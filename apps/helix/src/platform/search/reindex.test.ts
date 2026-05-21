import { describe, expect, it } from "vitest";
import { SearchReindexService, type SearchReindexSource } from "./reindex.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "./types.js";

describe("SearchReindexService", () => {
  it("reindexes selected sources in batches", async () => {
    const engine = new FakeSearchEngine();
    const service = new SearchReindexService({
      engine,
      batchSize: 2,
      sources: [
        source("mail", ["mail:1", "mail:2", "mail:3"]),
        source("drive", ["drive:1"]),
        source("docs", ["docs:1"]),
      ],
    });

    await expect(service.reindex({ types: ["mail", "drive"] })).resolves.toEqual({
      status: "completed",
      engineId: "fake-search",
      types: ["mail", "drive"],
      totalDocuments: 4,
      deletedDocuments: 0,
      counts: {
        mail: 3,
        chat: 0,
        docs: 0,
        drive: 1,
        calendar: 0,
      },
      batchSize: 2,
    });

    expect(engine.batches.map((batch) => batch.map((document) => document.id))).toEqual([
      ["mail:1", "mail:2"],
      ["mail:3"],
      ["drive:1"],
    ]);
    expect(engine.searches.map((search) => search.types)).toEqual([["mail"], ["drive"]]);
    expect(engine.deletes).toEqual([]);
  });

  it("prunes stale indexed documents after current rows are reindexed", async () => {
    const engine = new FakeSearchEngine([
      { id: "mail:1", type: "mail" },
      { id: "mail:stale", type: "mail" },
      { id: "drive:stale", type: "drive" },
    ]);
    const service = new SearchReindexService({
      engine,
      batchSize: 2,
      sources: [source("mail", ["mail:1", "mail:2"]), source("drive", [])],
    });

    await expect(
      service.reindex({ types: ["mail", "drive"], orgId: "11111111-1111-4111-8111-111111111111" }),
    ).resolves.toMatchObject({
      totalDocuments: 2,
      deletedDocuments: 2,
      counts: {
        mail: 2,
        drive: 0,
      },
    });

    expect(engine.deletes).toEqual([["mail:stale", "drive:stale"]]);
    expect(engine.searches).toEqual([
      {
        query: "",
        types: ["mail"],
        limit: 1000,
        offset: 0,
        filter: 'attributes.orgId = "11111111-1111-4111-8111-111111111111"',
        attributesToRetrieve: ["id", "type", "attributes"],
      },
      {
        query: "",
        types: ["drive"],
        limit: 1000,
        offset: 0,
        filter: 'attributes.orgId = "11111111-1111-4111-8111-111111111111"',
        attributesToRetrieve: ["id", "type", "attributes"],
      },
    ]);
  });

  it("can skip stale pruning for callers that only want an upsert backfill", async () => {
    const engine = new FakeSearchEngine([{ id: "mail:stale", type: "mail" }]);
    const service = new SearchReindexService({
      engine,
      sources: [source("mail", ["mail:1"])],
    });

    await expect(service.reindex({ types: ["mail"], pruneStale: false })).resolves.toMatchObject({
      totalDocuments: 1,
      deletedDocuments: 0,
    });
    expect(engine.searches).toEqual([]);
    expect(engine.deletes).toEqual([]);
  });

  it("streams source batches without materializing all documents up front", async () => {
    const engine = new FakeSearchEngine();
    const collected: number[] = [];
    const service = new SearchReindexService({
      engine,
      batchSize: 2,
      sources: [
        {
          type: "mail",
          collect: async () => {
            throw new Error("collect should not be called when collectBatches is available");
          },
          async *collectBatches({ batchSize }) {
            collected.push(batchSize);
            yield [
              { id: "mail:1", type: "mail" },
              { id: "mail:2", type: "mail" },
            ];
            yield [{ id: "mail:3", type: "mail" }];
          },
        },
      ],
    });

    await expect(service.reindex({ types: ["mail"] })).resolves.toMatchObject({
      totalDocuments: 3,
      deletedDocuments: 0,
    });
    expect(collected).toEqual([2]);
    expect(engine.batches.map((batch) => batch.map((document) => document.id))).toEqual([
      ["mail:1", "mail:2"],
      ["mail:3"],
    ]);
  });

  it("passes org scoping to sources and defaults to every searchable type", async () => {
    const engine = new FakeSearchEngine();
    const calls: string[] = [];
    const service = new SearchReindexService({
      engine,
      sources: [
        ...(["mail", "chat", "docs", "drive", "calendar"] as const).map((type) => ({
          type,
          collect: async ({ orgId }: { readonly orgId?: string | undefined }) => {
            calls.push(`${type}:${orgId ?? "all"}`);
            return [{ id: `${type}:1`, type, title: type }];
          },
        })),
      ],
    });

    const result = await service.reindex({ orgId: "11111111-1111-4111-8111-111111111111" });

    expect(result.totalDocuments).toBe(5);
    expect(result.deletedDocuments).toBe(0);
    expect(result.types).toEqual(["mail", "chat", "docs", "drive", "calendar"]);
    expect(calls).toEqual([
      "mail:11111111-1111-4111-8111-111111111111",
      "chat:11111111-1111-4111-8111-111111111111",
      "docs:11111111-1111-4111-8111-111111111111",
      "drive:11111111-1111-4111-8111-111111111111",
      "calendar:11111111-1111-4111-8111-111111111111",
    ]);
  });
});

function source(type: SearchReindexSource["type"], ids: readonly string[]): SearchReindexSource {
  return {
    type,
    collect: async () => ids.map((id) => ({ id, type, title: id })),
  };
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly batches: readonly IndexDocument[][] = [];
  readonly deletes: readonly string[][] = [];
  readonly searches: SearchRequest[] = [];

  constructor(private readonly indexedDocuments: readonly IndexDocument[] = []) {}

  async index(document: IndexDocument): Promise<void> {
    await this.upsert([document]);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    (this.batches as IndexDocument[][]).push([...documents]);
  }

  async delete(ids: readonly string[]): Promise<void> {
    (this.deletes as string[][]).push([...ids]);
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    this.searches.push(request);
    const types = new Set(request.types ?? []);
    return {
      hits: this.indexedDocuments.filter((document) => types.size === 0 || types.has(document.type)),
      query: request.query,
    };
  }
}
