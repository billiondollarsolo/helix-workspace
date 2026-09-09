/**
 * Integration test for migration 0027_drive_unification_backfill.sql.
 *
 * Requires a live PostgreSQL instance with all prior migrations applied.
 * Connection is read from the DATABASE_URL environment variable (set by
 * `/tmp/helix-dev.env` in development, or injected by CI).
 *
 * The test inserts isolated rows (using deterministic UUIDs that are very
 * unlikely to clash with seeded demo data), runs the migration SQL, then
 * asserts the expected `objects` rows are present. It cleans up after itself
 * so the dev DB is left untouched.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../platform/test/live-suite.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE = join(currentDir, "0027_drive_unification_backfill.sql");

// Deterministic test UUIDs — all in the f000… range to avoid collision with
// demo seed data which uses the 0000…0100/0200/etc. ranges.
const TEST_ORG_ID = "f0000000-0000-4000-8000-000000000001";
const TEST_ACTOR_ID = "f0000000-0000-4000-8000-000000000002";
const TEST_SHEET_ID = "f0000000-0000-4000-8000-000000000010";
const TEST_DECK_ID = "f0000000-0000-4000-8000-000000000020";
const TEST_DOC_ID = "f0000000-0000-4000-8000-000000000030";

function createSql(): postgres.Sql {
  const url =
    process.env.DATABASE_URL ?? "postgres://helix:helix_dev_password@localhost:28432/helix";
  return postgres(url, { max: 2, prepare: false });
}

describe(
  "migration 0027_drive_unification_backfill",
  {
    // Skip the entire suite when no DATABASE_URL is configured.
    skip: skipUnlessLiveDatabase("migration 0027 drive unification"),
  },
  () => {
    let sql: postgres.Sql;
    let migrationSql: string;

    beforeAll(async () => {
      sql = createSql();
      migrationSql = await readFile(MIGRATION_FILE, "utf8");

      // Seed an actor and org so FK constraints are satisfied.
      await sql`
        insert into actors (id, org_id, type, display_name, scopes)
        values (
          ${TEST_ACTOR_ID}, ${TEST_ORG_ID}, 'user', 'Migration Test Actor', '{}'
        )
        on conflict (id) do nothing
      `;

      // Seed a sheets row.
      await sql`
        insert into sheets (id, org_id, owner_actor_id, title)
        values (${TEST_SHEET_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'Test Spreadsheet')
        on conflict (id) do nothing
      `;

      // Seed a slide_decks row.
      await sql`
        insert into slide_decks (id, org_id, owner_actor_id, title)
        values (${TEST_DECK_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'Test Deck')
        on conflict (id) do nothing
      `;

      // Seed a docs_documents row (no thread_id required — it is nullable).
      await sql`
        insert into docs_documents (id, org_id, owner_actor_id, title)
        values (${TEST_DOC_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'Test Document')
        on conflict (id) do nothing
      `;

      // Run the backfill migration once after seeding so every `it` block
      // observes a consistent state, even when run individually.
      await sql.unsafe(migrationSql);
    });

    afterAll(async () => {
      // Remove test data in dependency order.
      await sql`delete from objects where id in (${TEST_SHEET_ID}, ${TEST_DECK_ID}, ${TEST_DOC_ID})`;
      await sql`delete from sheets where id = ${TEST_SHEET_ID}`;
      await sql`delete from slide_decks where id = ${TEST_DECK_ID}`;
      await sql`delete from docs_documents where id = ${TEST_DOC_ID}`;
      await sql`delete from actors where id = ${TEST_ACTOR_ID}`;
      await sql.end();
    });

    it("creates an objects row for the test sheet with kind='file' and app='sheets'", async () => {
      const rows = await sql<{ id: string; kind: string; app: string }[]>`
        select id, kind, metadata->>'app' as app
        from objects
        where id = ${TEST_SHEET_ID}
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("file");
      expect(rows[0]?.app).toBe("sheets");
    });

    it("creates an objects row for the test deck with kind='file' and app='slides'", async () => {
      const rows = await sql<{ id: string; kind: string; app: string }[]>`
        select id, kind, metadata->>'app' as app
        from objects
        where id = ${TEST_DECK_ID}
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("file");
      expect(rows[0]?.app).toBe("slides");
    });

    it("creates an objects row for the test doc with kind='file' and app='docs'", async () => {
      const rows = await sql<{ id: string; kind: string; app: string }[]>`
        select id, kind, metadata->>'app' as app
        from objects
        where id = ${TEST_DOC_ID}
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("file");
      expect(rows[0]?.app).toBe("docs");
    });

    it("is idempotent: running the migration SQL twice does not error and does not duplicate rows", async () => {
      // Run the migration a second time — all three inserts use ON CONFLICT DO NOTHING.
      await expect(sql.unsafe(migrationSql)).resolves.not.toThrow();

      const [sheetCount, deckCount, docCount] = await Promise.all([
        sql<{ n: string }[]>`select count(*) as n from objects where id = ${TEST_SHEET_ID}`,
        sql<{ n: string }[]>`select count(*) as n from objects where id = ${TEST_DECK_ID}`,
        sql<{ n: string }[]>`select count(*) as n from objects where id = ${TEST_DOC_ID}`,
      ]);

      expect(Number(sheetCount[0]?.n)).toBe(1);
      expect(Number(deckCount[0]?.n)).toBe(1);
      expect(Number(docCount[0]?.n)).toBe(1);
    });
  },
);

describe("migration 0027_drive_unification_backfill SQL file", () => {
  it("contains ON CONFLICT DO NOTHING clauses for all three inserts", async () => {
    const sql = await readFile(MIGRATION_FILE, "utf8");

    const matches = sql.match(/on conflict \(id\) do nothing/gi);
    expect(matches).toHaveLength(3);
  });

  it("backfills sheets, slide_decks, and docs_documents", async () => {
    const sql = await readFile(MIGRATION_FILE, "utf8");

    expect(sql).toContain("from sheets");
    expect(sql).toContain("from slide_decks");
    expect(sql).toContain("from docs_documents");
  });

  it("sets kind to 'file' for all three content types", async () => {
    const sql = await readFile(MIGRATION_FILE, "utf8");

    const kindMatches = sql.match(/'file'/g);
    expect(kindMatches?.length).toBeGreaterThanOrEqual(3);
  });
});
