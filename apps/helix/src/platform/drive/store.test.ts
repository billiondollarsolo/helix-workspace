/**
 * Integration tests for PostgresDriveStore — specifically the trash/restore
 * cascade to linked content tables (docs_documents, sheets, slide_decks).
 *
 * Requires a live PostgreSQL instance with all migrations applied.
 * Connection is read from the DATABASE_URL environment variable.
 *
 * Tests are skipped automatically when DATABASE_URL is not set, so the
 * unit-test suite stays green in environments without a database.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "./store.js";
import { skipUnlessLiveDatabase } from "../test/live-suite.js";

// Deterministic UUIDs in the f100… range to avoid collision with demo seed
// data (0000...) and the migration test (f000...).
const TEST_ORG_ID = "f1000000-0000-4000-8000-000000000001";
const TEST_ACTOR_ID = "f1000000-0000-4000-8000-000000000002";
const TEST_SHEET_ID = "f1000000-0000-4000-8000-000000000010";
const TEST_DECK_ID = "f1000000-0000-4000-8000-000000000020";
const TEST_DOC_ID = "f1000000-0000-4000-8000-000000000030";

function createSql(): postgres.Sql {
  const url =
    process.env.DATABASE_URL ?? "postgres://helix:helix_dev_password@localhost:28432/helix";
  return postgres(url, { max: 2, prepare: false });
}

describe(
  "PostgresDriveStore — syncTargetDeletedAt cascade",
  {
    skip: skipUnlessLiveDatabase("Drive store (live PostgreSQL)"),
  },
  () => {
    let sql: postgres.Sql;
    let store: PostgresDriveStore;

    beforeAll(async () => {
      sql = createSql();
      store = new PostgresDriveStore(sql);

      // Seed a test actor so FK constraints are satisfied.
      await sql`
        insert into actors (id, org_id, type, display_name, scopes)
        values (${TEST_ACTOR_ID}, ${TEST_ORG_ID}, 'user', 'Drive Store Test Actor', '{}')
        on conflict (id) do nothing
      `;

      // --- Sheet: objects row + sheets row with same PK ---
      await sql`
        insert into sheets (id, org_id, owner_actor_id, title)
        values (${TEST_SHEET_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'Test Sheet')
        on conflict (id) do nothing
      `;
      await sql`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata)
        values (
          ${TEST_SHEET_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID},
          'file', ${"drive/test/sheet"}, ${"application/vnd.helix.sheet"}, ${0},
          ${sql.json({ app: "sheets", name: "Test Sheet", folderId: null, status: "ready" })}
        )
        on conflict (id) do nothing
      `;
      await sql`
        insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
        values (${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'object', ${TEST_SHEET_ID}, 'owner', ${TEST_ACTOR_ID})
        on conflict do nothing
      `;

      // --- Deck: objects row + slide_decks row with same PK ---
      await sql`
        insert into slide_decks (id, org_id, owner_actor_id, title)
        values (${TEST_DECK_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'Test Deck')
        on conflict (id) do nothing
      `;
      await sql`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata)
        values (
          ${TEST_DECK_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID},
          'file', ${"drive/test/deck"}, ${"application/vnd.helix.slides"}, ${0},
          ${sql.json({ app: "slides", name: "Test Deck", folderId: null, status: "ready" })}
        )
        on conflict (id) do nothing
      `;
      await sql`
        insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
        values (${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'object', ${TEST_DECK_ID}, 'owner', ${TEST_ACTOR_ID})
        on conflict do nothing
      `;

      // --- Doc: objects row + docs_documents row with same PK ---
      await sql`
        insert into docs_documents (id, org_id, owner_actor_id, title)
        values (${TEST_DOC_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'Test Doc')
        on conflict (id) do nothing
      `;
      await sql`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata)
        values (
          ${TEST_DOC_ID}, ${TEST_ORG_ID}, ${TEST_ACTOR_ID},
          'file', ${"drive/test/doc"}, ${"application/vnd.helix.doc"}, ${0},
          ${sql.json({ app: "docs", name: "Test Doc", folderId: null, status: "ready" })}
        )
        on conflict (id) do nothing
      `;
      await sql`
        insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
        values (${TEST_ORG_ID}, ${TEST_ACTOR_ID}, 'object', ${TEST_DOC_ID}, 'owner', ${TEST_ACTOR_ID})
        on conflict do nothing
      `;
    });

    afterAll(async () => {
      // Clean up in dependency order.
      await sql`delete from outbox where payload->>'actorId' = ${TEST_ACTOR_ID}`;
      await sql`delete from activity where actor_id = ${TEST_ACTOR_ID}`;
      await sql`delete from permissions where resource_id in (${TEST_SHEET_ID}, ${TEST_DECK_ID}, ${TEST_DOC_ID})`;
      await sql`delete from objects where id in (${TEST_SHEET_ID}, ${TEST_DECK_ID}, ${TEST_DOC_ID})`;
      await sql`delete from sheets where id = ${TEST_SHEET_ID}`;
      await sql`delete from slide_decks where id = ${TEST_DECK_ID}`;
      await sql`delete from docs_documents where id = ${TEST_DOC_ID}`;
      await sql`delete from actors where id = ${TEST_ACTOR_ID}`;
      await sql.end();
    });

    /* Reset all three content rows to a live, untrashed state.
    
       `upload_state` is reset alongside `deleted_at` because `trash()` writes
       both. Resetting only `deleted_at` left the objects `trashed` for every
       subsequent test — which is how the restore cases ended up exercising a
       state the fixture created rather than one the product does. */
    async function resetDeletedAt() {
      await sql`
        update objects
        set deleted_at = null, upload_state = 'active', updated_at = now()
        where id in (${TEST_SHEET_ID}, ${TEST_DECK_ID}, ${TEST_DOC_ID})
      `;
      await sql`update sheets set deleted_at = null where id = ${TEST_SHEET_ID}`;
      await sql`update slide_decks set deleted_at = null where id = ${TEST_DECK_ID}`;
      await sql`update docs_documents set deleted_at = null where id = ${TEST_DOC_ID}`;
    }

    it("restores a file it trashed itself, end to end", async () => {
      /* The gap this closes: every test here drove trash and restore from a
         hand-written row state, so nothing exercised the two against each
         other. `trash()` writes `upload_state = 'trashed'`, and restore's
         object lookup filtered on `upload_state = 'active'` without passing
         `allowTrashed` — so restoring any genuinely trashed file raised
         DriveNotFoundError. Both halves of the round trip must run for that to
         be visible. */
      await resetDeletedAt();

      await store.trash({
        orgId: TEST_ORG_ID,
        actorId: TEST_ACTOR_ID,
        objectId: TEST_SHEET_ID,
      });
      const trashed = await sql<{ upload_state: string }[]>`
        select upload_state from objects where id = ${TEST_SHEET_ID}
      `;
      expect(trashed[0]?.upload_state).toBe("trashed");

      await expect(
        store.restore({
          orgId: TEST_ORG_ID,
          actorId: TEST_ACTOR_ID,
          objectId: TEST_SHEET_ID,
        }),
      ).resolves.not.toBeNull();

      const restored = await sql<{ upload_state: string; deleted_at: Date | null }[]>`
        select upload_state, deleted_at from objects where id = ${TEST_SHEET_ID}
      `;
      expect(restored[0]?.upload_state).toBe("active");
      expect(restored[0]?.deleted_at).toBeNull();
    });

    it("trash sets sheets.deleted_at when object has metadata.app='sheets'", async () => {
      await resetDeletedAt();

      const result = await store.trash({
        orgId: TEST_ORG_ID,
        actorId: TEST_ACTOR_ID,
        objectId: TEST_SHEET_ID,
      });

      expect(result).not.toBeNull();

      const rows = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from sheets where id = ${TEST_SHEET_ID}
      `;
      expect(rows[0]?.deleted_at).not.toBeNull();
    });

    it("restore clears sheets.deleted_at when object has metadata.app='sheets'", async () => {
      /* Trash through the store rather than by hand: hand-setting `deleted_at`
         alone produced a row `trash()` never writes, so the restore path was
         being tested against a state that does not occur. */
      await resetDeletedAt();
      await store.trash({ orgId: TEST_ORG_ID, actorId: TEST_ACTOR_ID, objectId: TEST_SHEET_ID });

      const result = await store.restore({
        orgId: TEST_ORG_ID,
        actorId: TEST_ACTOR_ID,
        objectId: TEST_SHEET_ID,
      });

      expect(result).not.toBeNull();

      const rows = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from sheets where id = ${TEST_SHEET_ID}
      `;
      expect(rows[0]?.deleted_at).toBeNull();
    });

    it("trash sets slide_decks.deleted_at when object has metadata.app='slides'", async () => {
      await resetDeletedAt();

      const result = await store.trash({
        orgId: TEST_ORG_ID,
        actorId: TEST_ACTOR_ID,
        objectId: TEST_DECK_ID,
      });

      expect(result).not.toBeNull();

      const rows = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from slide_decks where id = ${TEST_DECK_ID}
      `;
      expect(rows[0]?.deleted_at).not.toBeNull();
    });

    it("restore clears slide_decks.deleted_at when object has metadata.app='slides'", async () => {
      await sql`update objects set deleted_at = now(), updated_at = now() where id = ${TEST_DECK_ID}`;
      await sql`update slide_decks set deleted_at = now() where id = ${TEST_DECK_ID}`;

      const result = await store.restore({
        orgId: TEST_ORG_ID,
        actorId: TEST_ACTOR_ID,
        objectId: TEST_DECK_ID,
      });

      expect(result).not.toBeNull();

      const rows = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from slide_decks where id = ${TEST_DECK_ID}
      `;
      expect(rows[0]?.deleted_at).toBeNull();
    });

    it("trash sets docs_documents.deleted_at when object has metadata.app='docs'", async () => {
      await resetDeletedAt();

      const result = await store.trash({
        orgId: TEST_ORG_ID,
        actorId: TEST_ACTOR_ID,
        objectId: TEST_DOC_ID,
      });

      expect(result).not.toBeNull();

      const rows = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from docs_documents where id = ${TEST_DOC_ID}
      `;
      expect(rows[0]?.deleted_at).not.toBeNull();
    });

    it("restore clears docs_documents.deleted_at when object has metadata.app='docs'", async () => {
      await sql`update objects set deleted_at = now(), updated_at = now() where id = ${TEST_DOC_ID}`;
      await sql`update docs_documents set deleted_at = now() where id = ${TEST_DOC_ID}`;

      const result = await store.restore({
        orgId: TEST_ORG_ID,
        actorId: TEST_ACTOR_ID,
        objectId: TEST_DOC_ID,
      });

      expect(result).not.toBeNull();

      const rows = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from docs_documents where id = ${TEST_DOC_ID}
      `;
      expect(rows[0]?.deleted_at).toBeNull();
    });
  },
);
