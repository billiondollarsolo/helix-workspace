import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PgVectorStore } from "./pgvector.js";

/**
 * A minimal fake of the `postgres.Sql` tagged-template client. It records
 * every executed query and replays scripted result rows in order. This lets
 * us exercise {@link PgVectorStore} — which is otherwise untested — without a
 * live Postgres/pgvector instance.
 */
interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeSqlOptions {
  /** Result rows returned in FIFO order, one entry per tagged-template call. */
  readonly results?: readonly (readonly unknown[])[];
}

interface FakeSql {
  readonly sql: postgres.Sql;
  readonly queries: RecordedQuery[];
}

const SQL_VERB = /\b(select|insert|update|delete)\b/iu;

function createFakeSql(options: FakeSqlOptions = {}): FakeSql {
  const queries: RecordedQuery[] = [];
  const results = [...(options.results ?? [])];

  const tag = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = strings.join("?").replace(/\s+/gu, " ").trim();
    // `postgres` lets a tagged-template call be interpolated into another as a
    // SQL fragment (e.g. `sql`embedding::text``). Such fragments carry no SQL
    // verb; treat only verb-bearing calls as executed queries that consume a
    // scripted result row.
    if (!SQL_VERB.test(text)) {
      return { __fragment: text };
    }
    queries.push({ text, values });
    return Promise.resolve(results.shift() ?? []);
  };

  const sql = tag as unknown as Record<string, unknown>;
  sql.begin = async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
    callback(sql);
  sql.json = (value: unknown): unknown => ({ __json: value });
  sql.array = (value: unknown): unknown => ({ __array: value });

  return { sql: sql as unknown as postgres.Sql, queries };
}

describe("PgVectorStore", () => {
  it("exposes a stable store id", () => {
    const { sql } = createFakeSql();
    expect(new PgVectorStore(sql).id).toBe("pgvector");
  });

  it("rejects a blank collection name before issuing any query", async () => {
    const { sql, queries } = createFakeSql();
    const store = new PgVectorStore(sql);
    await expect(store.createCollection("   ", 8, "cosine")).rejects.toThrow(
      "collection name is required",
    );
    expect(queries).toHaveLength(0);
  });

  it("rejects a non-positive dimension on createCollection", async () => {
    const { sql } = createFakeSql();
    const store = new PgVectorStore(sql);
    await expect(store.createCollection("docs", 0, "cosine")).rejects.toThrow(
      "positive safe integer",
    );
  });

  it("rejects an unsupported metric on createCollection", async () => {
    const { sql } = createFakeSql();
    const store = new PgVectorStore(sql);
    await expect(
      store.createCollection("docs", 8, "manhattan" as never),
    ).rejects.toThrow("Unsupported vector metric");
  });

  it("upserts vectors inside a single transaction", async () => {
    const { sql, queries } = createFakeSql({ results: [[{ dim: 3, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await store.upsert("docs", [
      { id: "a", vector: [0.1, 0.2, 0.3], metadata: { kind: "note" } },
      { id: "b", vector: [0.4, 0.5, 0.6] },
    ]);
    const inserts = queries.filter((query) => query.text.startsWith("insert into vector_items"));
    expect(inserts).toHaveLength(2);
  });

  it("short-circuits upsert with no items and never reads the collection", async () => {
    const { sql, queries } = createFakeSql();
    const store = new PgVectorStore(sql);
    await store.upsert("docs", []);
    expect(queries).toHaveLength(0);
  });

  it("rejects an upsert vector whose dimension differs from the collection", async () => {
    const { sql } = createFakeSql({ results: [[{ dim: 3, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await expect(
      store.upsert("docs", [{ id: "a", vector: [0.1, 0.2] }]),
    ).rejects.toThrow("does not match expected dimension");
  });

  it("throws a descriptive error when the collection does not exist", async () => {
    const { sql } = createFakeSql({ results: [[]] });
    const store = new PgVectorStore(sql);
    await expect(store.query("missing", [1, 2, 3])).rejects.toThrow(
      "Vector collection does not exist: missing",
    );
  });

  it("rejects a query vector whose dimension differs from the collection", async () => {
    const { sql } = createFakeSql({ results: [[{ dim: 4, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await expect(store.query("docs", [1, 2, 3])).rejects.toThrow(
      "does not match expected dimension",
    );
  });

  it("rejects a non-positive query limit", async () => {
    const { sql } = createFakeSql({ results: [[{ dim: 3, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await expect(store.query("docs", [1, 2, 3], { limit: 0 })).rejects.toThrow("positive");
  });

  it("maps cosine query rows and parses string-encoded vectors", async () => {
    const { sql, queries } = createFakeSql({
      results: [
        [{ dim: 3, metric: "cosine" }],
        [
          { id: "a", metadata: { kind: "note" }, embedding: "[0.1,0.2,0.3]", score: 0.9 },
          { id: "b", metadata: {}, embedding: null, score: 0.4 },
        ],
      ],
    });
    const store = new PgVectorStore(sql);
    const matches = await store.query("docs", [1, 2, 3], { includeVectors: true });

    expect(matches).toEqual([
      { id: "a", score: 0.9, metadata: { kind: "note" }, vector: [0.1, 0.2, 0.3] },
      { id: "b", score: 0.4 },
    ]);
    expect(queries.some((query) => query.text.includes("<=>"))).toBe(true);
  });

  it("uses the dot-product operator for the dot metric", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "dot" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.query("docs", [1, 2]);
    expect(queries.some((query) => query.text.includes("<#>"))).toBe(true);
  });

  it("uses the l2-distance operator for the l2 metric", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "l2" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.query("docs", [1, 2]);
    expect(queries.some((query) => query.text.includes("<->"))).toBe(true);
  });

  it("applies a metadata containment filter when one is supplied", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "cosine" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.query("docs", [1, 2], { filter: { kind: "note" } });
    expect(queries.some((query) => query.text.includes("metadata @>"))).toBe(true);
  });

  it("short-circuits delete with no ids and never issues a query", async () => {
    const { sql, queries } = createFakeSql();
    const store = new PgVectorStore(sql);
    await store.delete("docs", []);
    expect(queries).toHaveLength(0);
  });

  it("issues a delete for the supplied ids", async () => {
    const { sql, queries } = createFakeSql({ results: [[]] });
    const store = new PgVectorStore(sql);
    await store.delete("docs", ["a", "b"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("delete from vector_items");
  });
});
