# Drive Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Drive the unifying filesystem — docs/sheets/decks become Drive entries, Drive's "New" dropdown creates them, and the Docs/Sheets/Slides list pages read from Drive.

**Architecture:** Every doc/sheet/deck owns a shared-primary-key `objects` row (`objects.id === content row id`, `kind='file'`, `metadata.app` ∈ {`docs`,`sheets`,`slides`}) — exactly the convention `docs.create` already uses. No schema change. Drive ops already operate on `kind='file'` objects; the work is to make Sheets/Slides create those rows, generalize the trash cascade, add a `drive.create` tool and an `app` filter, and re-platform the web list pages.

**Tech Stack:** Fastify + TypeScript + `postgres` driver (`apps/helix`); React 19 + TanStack Router/Query + Vite (`apps/web`); Vitest.

**Spec:** `docs/superpowers/specs/2026-05-21-drive-unification-design.md`

**Baseline:** helix 1002 tests / web 381 tests green; helix + web typecheck/lint clean.

**Reference pattern:** `docs.create` at `apps/helix/src/platform/docs/store.ts:190-245` — the canonical shared-PK `objects` insert all create paths mirror.

---

## Task 1: Backfill migration for existing sheets & decks

**Files:**
- Create: `apps/helix/src/db/migrations/0027_drive_unification_backfill.sql`
- Test: `apps/helix/src/db/migrations/0027_drive_unification.test.ts`

- [ ] **Step 1: Write the failing test**

Create `0027_drive_unification.test.ts` — apply migrations to a fresh test DB (follow the pattern in an existing migration test, e.g. search `src/db` for `*.test.ts` that runs `runMigrations`), insert a `sheets` row and a `slide_decks` row directly, run the migration, and assert an `objects` row exists with the same `id`, `kind='file'`, and `metadata->>'app'` equal to `sheets`/`slides`. Assert running the migration SQL twice does not error and does not duplicate rows.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/helix && pnpm test src/db/migrations/0027`
Expected: FAIL (migration file does not exist).

- [ ] **Step 3: Write the migration**

```sql
-- 0027_drive_unification_backfill.sql
-- Backfill shared-PK `objects` rows so existing sheets/decks/docs are Drive entries.
-- Pure data migration: no schema/enum change.

insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, deleted_at)
select s.id, s.org_id, s.owner_actor_id, 'file',
       'sheets/' || s.org_id || '/' || s.id,
       'application/vnd.helix.spreadsheet', 0, null,
       jsonb_build_object('app', 'sheets', 'name', s.title, 'title', s.title, 'folderId', null),
       s.deleted_at
from sheets s
on conflict (id) do nothing;

insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, deleted_at)
select d.id, d.org_id, d.owner_actor_id, 'file',
       'slides/' || d.org_id || '/' || d.id,
       'application/vnd.helix.presentation', 0, null,
       jsonb_build_object('app', 'slides', 'name', d.title, 'title', d.title, 'folderId', null),
       d.deleted_at
from slide_decks d
on conflict (id) do nothing;

insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata, deleted_at)
select dd.id, dd.org_id, dd.owner_actor_id, 'file',
       'docs/' || dd.org_id || '/' || dd.id,
       'application/vnd.helix.document', 0, null,
       jsonb_build_object('app', 'docs', 'name', dd.title, 'title', dd.title, 'folderId', null),
       dd.deleted_at
from docs_documents dd
on conflict (id) do nothing;
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/helix && pnpm test src/db/migrations/0027`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/db/migrations/0027_drive_unification_backfill.sql apps/helix/src/db/migrations/0027_drive_unification.test.ts
git commit -m "feat(drive): backfill migration linking sheets/decks/docs to objects"
```

---

## Task 2: Generalize `syncDocsDeletedAt` → `syncTargetDeletedAt`

**Files:**
- Modify: `apps/helix/src/platform/drive/store.ts` (`syncDocsDeletedAt`, ~line 948, and its 3 call sites ~582/621/877)
- Test: `apps/helix/src/platform/drive/store.test.ts` (or the existing drive store/tools test file)

- [ ] **Step 1: Write the failing test**

Add a test: create a sheet with a shared-PK `objects` row (`metadata.app='sheets'`), call the drive store `trash`, assert `sheets.deleted_at` is set; call `restore`, assert it is cleared. Same for a deck (`metadata.app='slides'`).

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/helix && pnpm test src/platform/drive`
Expected: FAIL (sheet `deleted_at` not synced).

- [ ] **Step 3: Implement**

Replace `syncDocsDeletedAt` with `syncTargetDeletedAt`. It reads the object's `metadata->>'app'` and updates the matching content table by shared PK:

```ts
async function syncTargetDeletedAt(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  action: "restore" | "trash",
): Promise<void> {
  const deletedAt = action === "restore" ? null : new Date();
  // App is read from the object's own metadata.
  const rows = (await sql`
    select metadata->>'app' as app from objects
    where id = ${objectId} and org_id = ${orgId}
  `) as unknown as readonly { readonly app: string | null }[];
  const app = rows[0]?.app ?? null;
  if (app === "docs") {
    await sql`update docs_documents set deleted_at = ${deletedAt}, updated_at = now()
              where id = ${objectId} and org_id = ${orgId}`;
  } else if (app === "sheets") {
    await sql`update sheets set deleted_at = ${deletedAt}, updated_at = now()
              where id = ${objectId} and org_id = ${orgId}`;
  } else if (app === "slides") {
    await sql`update slide_decks set deleted_at = ${deletedAt}, updated_at = now()
              where id = ${objectId} and org_id = ${orgId}`;
  }
}
```

Rename all three call sites (`syncDocsDeletedAt(...)` → `syncTargetDeletedAt(...)`); signatures are identical.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/helix && pnpm test src/platform/drive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/platform/drive/store.ts apps/helix/src/platform/drive/store.test.ts
git commit -m "feat(drive): generalize trash cascade to sheets and slides"
```

---

## Task 3: Sheets store — shared-PK `objects` row on create

**Files:**
- Modify: `apps/helix/src/platform/sheets/store.ts` — Postgres `createSheet` (~line 472) and in-memory `createSheet` (~line 184)
- Test: `apps/helix/src/platform/sheets/store.test.ts`

- [ ] **Step 1: Write the failing test**

Test: call the Postgres `createSheet`, then query `objects` for a row with `id === sheet.id`, `kind='file'`, `metadata->>'app' === 'sheets'`, `metadata->>'name' === title`, `metadata->>'folderId'` equal to the input folderId. Add `folderId?: string | null` to `CreateSheetInput` and assert it lands in `metadata.folderId`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/helix && pnpm test src/platform/sheets`
Expected: FAIL (no `objects` row).

- [ ] **Step 3: Implement**

In the Postgres `createSheet`, inside the existing transaction, after inserting the `sheets` row, insert the shared-PK `objects` row — mirror `docs/store.ts:229-245`:

```ts
await tx`
  insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
  values (
    ${sheet.id}, ${input.orgId}, ${input.actorId}, 'file',
    ${`sheets/${input.orgId}/${sheet.id}`},
    'application/vnd.helix.spreadsheet', 0, null,
    ${tx.json(toSqlJson({ ...(input.metadata ?? {}), app: "sheets", sheetId: sheet.id, name: title, title, folderId: input.folderId ?? null }))}
  )
  on conflict (id) do update set metadata = excluded.metadata, updated_at = now()
`;
```

Also call `grantObjectAccess` for the new object (mirror `docs/store.ts:261-267`). Add `folderId?: string | null` to `CreateSheetInput`. In the in-memory `createSheet`, store `folderId`/`app` into the sheet's `metadata` so in-memory tests stay consistent (no `objects` table in-memory — keep parity by tracking it on the record's metadata).

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/helix && pnpm test src/platform/sheets`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/platform/sheets/
git commit -m "feat(sheets): create shared-PK Drive object on sheet creation"
```

---

## Task 4: Slides store — shared-PK `objects` row on create

**Files:**
- Modify: `apps/helix/src/platform/slides/store.ts` — Postgres `createDeck` (~line 132) and in-memory `createDeck` (~line 610)
- Test: `apps/helix/src/platform/slides/store.test.ts`

- [ ] **Step 1: Write the failing test**

Test: call the Postgres `createDeck`, query `objects` for `id === deck.id`, `kind='file'`, `metadata->>'app' === 'slides'`, `metadata->>'name' === title`, `metadata->>'folderId'` = input folderId. Add `folderId?: string | null` to `CreateSlideDeckInput`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/helix && pnpm test src/platform/slides`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the Postgres `createDeck` transaction, after the `slide_decks` insert:

```ts
await tx`
  insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
  values (
    ${deck.id}, ${input.orgId}, ${input.actorId}, 'file',
    ${`slides/${input.orgId}/${deck.id}`},
    'application/vnd.helix.presentation', 0, null,
    ${tx.json(toSqlJson({ ...(input.metadata ?? {}), app: "slides", deckId: deck.id, name: input.title, title: input.title, folderId: input.folderId ?? null }))}
  )
  on conflict (id) do update set metadata = excluded.metadata, updated_at = now()
`;
```

Add `grantObjectAccess` for the deck object. Add `folderId?: string | null` to `CreateSlideDeckInput`. Update the in-memory `createDeck` to track `folderId`/`app` on the deck metadata for parity.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/helix && pnpm test src/platform/slides`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/platform/slides/
git commit -m "feat(slides): create shared-PK Drive object on deck creation"
```

---

## Task 5: `drive.list` — `app` filter and `app` on entries

**Files:**
- Modify: `apps/helix/src/platform/drive/store.ts` (`list`, ~line 338; `mapObjectEntry`)
- Modify: `apps/helix/src/platform/drive/types.ts` (`DriveEntryRecord`)
- Modify: `apps/helix/src/platform/drive/tools.ts` (`drive.list` input schema)
- Test: `apps/helix/src/platform/drive/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Test: seed a folder containing one plain file, one `app='docs'` object, one `app='sheets'` object. Call `drive.list` with no filter → all three returned, each entry carrying its `app` (plain file: `app` null/absent). Call with `app: "docs"` → only the doc entry.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/helix && pnpm test src/platform/drive`
Expected: FAIL (no `app` filter / field).

- [ ] **Step 3: Implement**

In `list`, add `app?: string` to the input type. In the `fileRows` query add a predicate: `and (${input.app ?? null}::text is null or coalesce(o.metadata->>'app','file') = ${input.app ?? null})`. In `mapObjectEntry`, include `app: stringMetadata(row.metadata, "app") ?? null` on the returned record. Add `app: string | null` to `DriveEntryRecord` in `types.ts`. Add an optional `app` field to the `drive.list` tool input schema in `tools.ts`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/helix && pnpm test src/platform/drive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/platform/drive/
git commit -m "feat(drive): app filter and app field on drive.list entries"
```

---

## Task 6: `drive.create` tool

**Files:**
- Modify: `apps/helix/src/platform/drive/tools.ts` (register `drive.create`)
- Modify: `apps/helix/src/platform/drive/store.ts` (a `createEntry` method, or delegate)
- Test: `apps/helix/src/platform/drive/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Test: call `drive.create` with `kind:"document"`, `folderId`, `name` → returns `{ id, app:"docs" }`; assert a `docs_documents` row and a shared-PK `objects` row exist with `metadata.folderId` set. Repeat for `spreadsheet`→sheets, `presentation`→slides, and `folder`→`drive_folders`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/helix && pnpm test src/platform/drive`
Expected: FAIL (tool not registered).

- [ ] **Step 3: Implement**

Register `drive.create` in `tools.ts` mirroring an existing tool's shape. Input: `{ kind: "folder"|"document"|"spreadsheet"|"presentation", folderId?: string|null, name: string }`. Dispatch:
- `folder` → existing `createFolder`.
- `document` → docs store `create({ orgId, actorId, title: name, folderId })` → `{ id, app:"docs" }`.
- `spreadsheet` → sheets store `createSheet({ orgId, actorId, title: name, folderId })` → `{ id, app:"sheets" }`.
- `presentation` → slides store `createDeck({ orgId, actorId, title: name, folderId })` → `{ id, app:"slides" }`.

The drive tools module must have access to the docs/sheets/slides stores — wire them through the same dependency-injection the existing tool registration uses (check how `tools.ts` receives its store; pass the others in alongside).

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/helix && pnpm test src/platform/drive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/helix/src/platform/drive/ apps/helix/src/server.ts
git commit -m "feat(drive): unified drive.create tool for folder/doc/sheet/deck"
```

---

## Task 7: Web — Drive "New" dropdown

**Files:**
- Modify: `apps/web/src/features/drive/api.ts` (add `createDriveEntry`)
- Modify: `apps/web/src/features/drive/drive-shell.tsx` (the "New" button → dropdown)
- Test: `apps/web/src/features/drive/drive-shell.test.tsx`

- [ ] **Step 1: Write the failing test**

Test: render `DriveShell`, click "New", assert a menu with "New folder / Document / Spreadsheet / Presentation / Upload file" appears; click "Document" → asserts `POST /api/tools/drive.create` fires with `kind:"document"` and the current folderId.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/web && pnpm test src/features/drive`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `createDriveEntry({ kind, folderId, name })` to `api.ts` (POST `/api/tools/drive.create`). In `drive-shell.tsx`, make "New" open a dropdown menu (reuse the existing menu primitive used elsewhere in the shell — e.g. the file kebab menu). Folder → existing create-folder flow. Document/Spreadsheet/Presentation → `createDriveEntry` then `navigate` to `/docs/$id` | `/sheets/$id` | `/slides/$id`. Upload → existing upload flow. Use a `useMutation` with `onMutate`/`onError` (the `helix/mutation-discipline` rule) and invalidate `driveQueryKeys.all`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/web && pnpm test src/features/drive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/drive/
git commit -m "feat(web): Drive New dropdown creates folder/doc/sheet/deck"
```

---

## Task 8: Web — Drive entries open the right editor

**Files:**
- Modify: `apps/web/src/features/drive/drive-data.ts` (entry → view-model: carry `app`)
- Modify: `apps/web/src/features/drive/drive-shell.tsx` (clicking a doc/sheet/deck entry)
- Test: `apps/web/src/features/drive/drive-shell.test.tsx`

- [ ] **Step 1: Write the failing test**

Test: `drive.list` mock returns a file with `app:"docs"`; clicking that entry navigates to `/docs/<id>`; an entry with `app:"sheets"` → `/sheets/<id>`; a plain file (no `app`) still opens the details panel as today.

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/web && pnpm test src/features/drive`
Expected: FAIL.

- [ ] **Step 3: Implement**

Thread `app` through the `DriveApiEntry` type and the entry view-model in `drive-data.ts`. In `drive-shell.tsx`, when a file entry is clicked: if `app` is `docs`/`sheets`/`slides`, `navigate` to the editor route; otherwise keep the current details-panel behavior. Give doc/sheet/deck entries the appropriate type icon.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/web && pnpm test src/features/drive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/drive/
git commit -m "feat(web): Drive entries open their editor by app type"
```

---

## Task 9: Web — re-platform Docs/Sheets/Slides list pages onto `drive.list`

**Files:**
- Modify: `apps/web/src/features/docs/queries.ts` + `api.ts` + the docs list component
- Modify: `apps/web/src/features/sheets/queries.ts` + `api.ts` + `sheets-list.tsx`
- Modify: `apps/web/src/features/slides/queries.ts` + `api.ts` + `slides-list.tsx`
- Test: the three features' existing list-page test files

- [ ] **Step 1: Write the failing tests**

For each surface, update its list-page test so the mock serves `POST /api/tools/drive.list` with `app:"docs"` (resp. sheets/slides) and asserts the list renders those entries and links each to its editor by shared id.

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd apps/web && pnpm test src/features/docs src/features/sheets src/features/slides`
Expected: FAIL.

- [ ] **Step 3: Implement**

In each feature, change the list query to call `drive.list` with the `app` filter instead of `docs.list`/`sheets.list`/`slides.deck.list`. Map the returned `DriveEntry` (`id`, `name`, `app`, `updatedAt`, owner) into the existing list view-model so the list components need minimal change. Each row links to its editor via the shared `id`. Leave the editor screens and their own `*.get` queries untouched.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd apps/web && pnpm test src/features/docs src/features/sheets src/features/slides`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/docs/ apps/web/src/features/sheets/ apps/web/src/features/slides/
git commit -m "feat(web): Docs/Sheets/Slides list pages read from Drive"
```

---

## Task 10: Seed — born-unified content in folders

**Files:**
- Modify: `apps/helix/src/db/seed-workspace.ts`
- Test: re-run `pnpm db:seed:workspace` and verify counts

- [ ] **Step 1: Update the seed**

For every doc/sheet/deck the seed creates, also insert its shared-PK `objects` row (`kind='file'`, `metadata.app`, `metadata.name=title`, `metadata.folderId` = a real seeded folder id — distribute across Engineering/Finance/Marketing/Product). Keep it idempotent (the seed already clears `metadata.source='workspace-seed'`; include these objects rows in that cleanup).

- [ ] **Step 2: Run the seed**

Run: `cd apps/helix && pnpm db:seed:workspace`
Expected: completes; re-running gives identical counts.

- [ ] **Step 3: Verify**

Run a `psql` count: `objects` rows with `metadata->>'app' in ('docs','sheets','slides')` ≥ the doc+sheet+deck count.

- [ ] **Step 4: Commit**

```bash
git add apps/helix/src/db/seed-workspace.ts
git commit -m "feat(seed): seed docs/sheets/decks as Drive entries in folders"
```

---

## Task 11: Full validation & browser e2e

**Files:** none (verification only)

- [ ] **Step 1: Backend gate**

Run: `cd apps/helix && pnpm typecheck && pnpm lint && pnpm test`
Expected: clean; ≥ 1002 tests pass (new tests added).

- [ ] **Step 2: Web gate**

Run: `cd apps/web && pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: clean; ≥ 381 tests pass.

- [ ] **Step 3: Apply migration + seed against the running DB**

Run: `cd apps/helix && pnpm db:migrate && pnpm db:seed:logins && pnpm db:seed:workspace`
Expected: migration `0027` applied; seed completes.

- [ ] **Step 4: Browser e2e**

Log in at `http://localhost:5174/login` (Admin demo button). Verify:
- Drive "New" → dropdown → "Document" → blank doc editor opens; type a title.
- Return to Drive → the new document appears as a file in the current folder with a doc icon; clicking it reopens the editor.
- The Docs list page shows the same document (Drive-backed).
- Trash the document from Drive → it disappears from both Drive and the Docs list.
- Repeat the create+appear check for Spreadsheet and Presentation.

- [ ] **Step 5: Commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(drive): validate drive unification end-to-end"
```

---

## Notes for the executor

- **Do not commit** unless the user has authorized it — the repo convention is commit only on request. Treat the `git commit` steps as checkpoints; stage and report instead if unauthorized.
- The dev stack is already running (web :5174, backend :3000). Source `/tmp/helix-dev.env` before backend commands that need the DB.
- Each content store has **two implementations** (in-memory + Postgres) — change both, or in-memory tests drift.
- Mirror `docs/store.ts:190-245` for every shared-PK `objects` insert — it is the proven pattern.
