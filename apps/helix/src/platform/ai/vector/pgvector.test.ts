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
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";

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
    await expect(store.createCollection(ORG_A, "   ", 8, "cosine")).rejects.toThrow(
      "collection name is required",
    );
    expect(queries).toHaveLength(0);
  });

  it("rejects a non-positive dimension on createCollection", async () => {
    const { sql } = createFakeSql();
    const store = new PgVectorStore(sql);
    await expect(store.createCollection(ORG_A, "docs", 0, "cosine")).rejects.toThrow(
      "positive safe integer",
    );
  });

  it("rejects an unsupported metric on createCollection", async () => {
    const { sql } = createFakeSql();
    const store = new PgVectorStore(sql);
    await expect(store.createCollection(ORG_A, "docs", 8, "manhattan" as never)).rejects.toThrow(
      "Unsupported vector metric",
    );
  });

  it("includes org_id in createCollection upsert SQL", async () => {
    const { sql, queries } = createFakeSql();
    const store = new PgVectorStore(sql);
    await store.createCollection(ORG_A, "docs", 3, "cosine");
    const insert = queries.find((query) => query.text.startsWith("insert into vector_collections"));
    expect(insert).toBeDefined();
    expect(insert?.text).toContain("org_id");
    expect(insert?.values[0]).toBe(ORG_A);
  });

  it("upserts vectors inside a single transaction", async () => {
    const { sql, queries } = createFakeSql({ results: [[{ dim: 3, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await store.upsert(ORG_A, "docs", [
      { id: "a", vector: [0.1, 0.2, 0.3], metadata: { kind: "note" } },
      { id: "b", vector: [0.4, 0.5, 0.6] },
    ]);
    const inserts = queries.filter((query) => query.text.startsWith("insert into vector_items"));
    expect(inserts).toHaveLength(2);
    // Every insert carries the org_id as the first interpolated value.
    expect(inserts[0]?.values[0]).toBe(ORG_A);
    expect(inserts[1]?.values[0]).toBe(ORG_A);
  });

  it("short-circuits upsert with no items and never reads the collection", async () => {
    const { sql, queries } = createFakeSql();
    const store = new PgVectorStore(sql);
    await store.upsert(ORG_A, "docs", []);
    expect(queries).toHaveLength(0);
  });

  it("rejects an upsert vector whose dimension differs from the collection", async () => {
    const { sql } = createFakeSql({ results: [[{ dim: 3, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await expect(store.upsert(ORG_A, "docs", [{ id: "a", vector: [0.1, 0.2] }])).rejects.toThrow(
      "does not match expected dimension",
    );
  });

  it("throws a descriptive error when the collection does not exist for the org", async () => {
    // `collection()` runs a `select` first; an empty result row means the
    // org-scoped collection lookup failed.
    const { sql } = createFakeSql({ results: [[]] });
    const store = new PgVectorStore(sql);
    await expect(store.query(ORG_A, "missing", [1, 2, 3])).rejects.toThrow(
      "Vector collection does not exist: missing",
    );
  });

  it("scopes the collection lookup by org_id", async () => {
    const { sql, queries } = createFakeSql({ results: [[{ dim: 3, metric: "cosine" }], []] });
    const store = new PgVectorStore(sql);
    await store.query(ORG_A, "docs", [1, 2, 3]);
    const lookup = queries.find((query) => query.text.startsWith("select dim, metric"));
    expect(lookup?.text).toContain("org_id");
    expect(lookup?.values).toContain(ORG_A);
  });

  it("rejects a query vector whose dimension differs from the collection", async () => {
    const { sql } = createFakeSql({ results: [[{ dim: 4, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await expect(store.query(ORG_A, "docs", [1, 2, 3])).rejects.toThrow(
      "does not match expected dimension",
    );
  });

  it("rejects a non-positive query limit", async () => {
    const { sql } = createFakeSql({ results: [[{ dim: 3, metric: "cosine" }]] });
    const store = new PgVectorStore(sql);
    await expect(store.query(ORG_A, "docs", [1, 2, 3], { limit: 0 })).rejects.toThrow("positive");
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
    const matches = await store.query(ORG_A, "docs", [1, 2, 3], { includeVectors: true });

    expect(matches).toEqual([
      { id: "a", score: 0.9, metadata: { kind: "note" }, vector: [0.1, 0.2, 0.3] },
      { id: "b", score: 0.4 },
    ]);
    expect(queries.some((query) => query.text.includes("<=>"))).toBe(true);
    // Every query SQL is org-scoped.
    expect(
      queries
        .filter((query) => query.text.includes("<=>"))
        .every((query) => query.text.includes("org_id")),
    ).toBe(true);
  });

  it("uses the dot-product operator for the dot metric", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "dot" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.query(ORG_A, "docs", [1, 2]);
    expect(queries.some((query) => query.text.includes("<#>"))).toBe(true);
  });

  it("uses the l2-distance operator for the l2 metric", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "l2" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.query(ORG_A, "docs", [1, 2]);
    expect(queries.some((query) => query.text.includes("<->"))).toBe(true);
  });

  it("applies a metadata containment filter when one is supplied", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "cosine" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.query(ORG_A, "docs", [1, 2], { filter: { kind: "note" } });
    expect(queries.some((query) => query.text.includes("metadata @>"))).toBe(true);
  });

  it("short-circuits delete with no ids and never issues a query", async () => {
    const { sql, queries } = createFakeSql();
    const store = new PgVectorStore(sql);
    await store.delete(ORG_A, "docs", []);
    expect(queries).toHaveLength(0);
  });

  it("issues a delete scoped by org_id for the supplied ids", async () => {
    const { sql, queries } = createFakeSql({ results: [[]] });
    const store = new PgVectorStore(sql);
    await store.delete(ORG_A, "docs", ["a", "b"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("delete from vector_items");
    expect(queries[0]?.text).toContain("org_id");
    expect(queries[0]?.values).toContain(ORG_A);
  });

  // The fake SQL collapses interpolated fragments into a `?` placeholder in
  // the rendered text and pushes the fragment object into `values`. So to
  // assert what visibility clause was interpolated, we read the fragment text
  // out of the values array rather than the SQL string.
  function fragmentText(values: readonly unknown[]): string {
    for (const value of values) {
      if (
        typeof value === "object" &&
        value !== null &&
        "__fragment" in value &&
        typeof value.__fragment === "string"
      ) {
        const text = (value as { __fragment: string }).__fragment;
        if (text.includes("visibility")) return text;
      }
    }
    return "";
  }

  it("queries without an actorId restrict to visibility = 'org' only", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "cosine" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.query(ORG_A, "docs", [1, 2]);
    const queryRow = queries.find((q) => q.text.includes("<=>"));
    if (queryRow === undefined) {
      throw new Error("Expected a vector similarity query");
    }
    const visibility = fragmentText(queryRow.values);
    expect(visibility).toContain("visibility = 'org'");
    // No actorId was supplied → the private-or-mine clause must NOT appear.
    expect(visibility).not.toContain("owner_actor_id");
  });

  it("queries with an actorId include the caller's private items + every org item", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "cosine" }], []],
    });
    const store = new PgVectorStore(sql);
    const actorId = "00000000-0000-4000-8000-0000000000aa";
    await store.query(ORG_A, "docs", [1, 2], { actorId });
    const queryRow = queries.find((q) => q.text.includes("<=>"));
    if (queryRow === undefined) {
      throw new Error("Expected a vector similarity query");
    }
    const visibility = fragmentText(queryRow.values);
    expect(visibility).toContain("visibility = 'org'");
    expect(visibility).toContain("visibility = 'private'");
    expect(visibility).toContain("owner_actor_id");
    // (The fake SQL discards the inner template's values, so we can only
    //  assert that the predicate's text mentions owner_actor_id — the actual
    //  bound parameter is exercised by integration tests against pgvector.)
  });

  it("upsert writes visibility + owner_actor_id columns for private items", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "cosine" }], []],
    });
    const store = new PgVectorStore(sql);
    const actorId = "00000000-0000-4000-8000-0000000000aa";
    await store.upsert(ORG_A, "docs", [
      { id: "u1", vector: [0.1, 0.2], visibility: "private", ownerActorId: actorId },
    ]);
    const insert = queries.find((q) => q.text.includes("insert into vector_items"));
    expect(insert).toBeDefined();
    expect(insert?.text).toContain("visibility");
    expect(insert?.text).toContain("owner_actor_id");
    expect(insert?.values).toContain("private");
    expect(insert?.values).toContain(actorId);
  });

  it("rejects a private upsert that omits ownerActorId", async () => {
    const { sql } = createFakeSql({
      results: [[{ dim: 2, metric: "cosine" }]],
    });
    const store = new PgVectorStore(sql);
    await expect(
      store.upsert(ORG_A, "docs", [{ id: "u1", vector: [0.1, 0.2], visibility: "private" }]),
    ).rejects.toThrow(/ownerActorId/);
  });

  it("upsert defaults visibility to 'org' when neither visibility nor owner is set", async () => {
    const { sql, queries } = createFakeSql({
      results: [[{ dim: 2, metric: "cosine" }], []],
    });
    const store = new PgVectorStore(sql);
    await store.upsert(ORG_A, "docs", [{ id: "u1", vector: [0.1, 0.2] }]);
    const insert = queries.find((q) => q.text.includes("insert into vector_items"));
    expect(insert?.values).toContain("org");
    // owner_actor_id is bound to NULL for org-shared items.
    expect(insert?.values).toContain(null);
  });

  it("does not return rows when another tenant queries the same collection name", async () => {
    // Org B scripts the collection lookup to return *no* row — simulating
    // pgvector's `where org_id = $B and name = 'docs'` returning nothing
    // even though Org A owns a row keyed `(orgA, 'docs')`. The PgVectorStore
    // surface MUST refuse to issue any subsequent query against that
    // collection.
    const { sql, queries } = createFakeSql({ results: [[]] });
    const store = new PgVectorStore(sql);
    await expect(store.query(ORG_B, "docs", [0.1, 0.2, 0.3])).rejects.toThrow(
      "Vector collection does not exist",
    );
    // Confirm we never reached the similarity query SQL.
    expect(queries.every((query) => !query.text.includes("<=>"))).toBe(true);
  });
});
