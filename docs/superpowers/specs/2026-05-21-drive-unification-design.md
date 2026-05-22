# Drive Unification — Design

**Date:** 2026-05-21
**Branch:** `ui-overhaul`
**Status:** Revised after exhaustive codebase validation (2026-05-21)

## Problem

Helix ships Drive, Docs, Sheets, and Slides as four independent surfaces with four
independent backends. A document created in Docs is invisible to Drive; Drive's
"New" button cannot create a doc/sheet/deck; there is no single filesystem.

Google's model is the opposite: **Drive is the filesystem**, and Docs/Sheets/Slides
are editors for file types that all live as Drive entries. This spec unifies Helix
to that model ("Level B — true unification").

## Goals

- Drive's "New" button opens a Google-style dropdown: New folder · Document ·
  Spreadsheet · Presentation · Upload.
- Creating a doc/sheet/deck (from Drive or from a typed surface) produces a real
  Drive entry that is editable from scratch in the browser.
- Doc/sheet/deck entries appear in the Drive listing with type icons; clicking one
  opens its editor.
- Move / trash / restore / delete / share behave identically for every entry type —
  one code path, no drift.
- The Docs / Sheets / Slides list pages become filtered views over Drive.

## Non-goals

- No change to the editing UIs (the doc/sheet/slide editors themselves).
- No change to the Yjs collaboration model for Docs.
- No new sharing/permission semantics beyond what `drive.share` already does.

## Architecture

### Chosen approach: shared-PK Drive object (extend the existing docs convention)

Helix already routes Drive placement, move, trash, restore, delete, and share
through the generic `objects` table; folder placement lives in
`objects.metadata.folderId`. **Docs already participate in this**: `docs.create`
inserts an `objects` row whose **primary key equals the `docs_documents` row's id**
(`objects.id === docs_documents.id`), with **`kind='file'`** and a
`metadata.app='docs'` discriminator (`metadata.name`, `metadata.docId`,
`metadata.folderId` also set). The helper `syncDocsDeletedAt` relies on that
shared PK. Because the object is `kind='file'`, it already flows through
`drive.list`, `drive.trash`, etc. with no special handling.

Unification therefore means **extending the convention docs already uses to
Sheets and Slides** — not inventing a new linkage and not touching the schema.
Every doc/sheet/deck owns one `kind='file'` `objects` row that shares its primary
key; `metadata.app` ∈ {`docs`,`sheets`,`slides`} marks which editor it belongs
to (plain uploads have no `app`). That row is its **Drive identity** (folder,
owner, sharing, trash state). The `docs_documents` / `sheets` / `slide_decks`
tables remain pure **content** stores.

Rejected alternatives:
- **New `object_kind` enum values / `target_id` column** — unnecessary: the
  `kind='file'` + `metadata.app` convention docs already uses needs no schema
  change. Rejected after codebase review.
- **`folderId` column on each editor table** — turns `drive.list` into a 4-table
  union and forces every Drive operation to branch by type.
- **New polymorphic `drive_entries` table** — a third table over both, maximizing
  code and drift surface.

## Data model

- **No schema change.** Doc/sheet/deck Drive objects are `kind='file'`, exactly
  like plain uploads; the `metadata.app` field discriminates.
- The Drive object and its content row **share a primary key** (same UUID).
- Drive placement uses the existing `objects.metadata.folderId` convention;
  display name uses `objects.metadata.name`, synced on rename.
- `metadata.app` values: `docs`, `sheets`, `slides`. Absent ⇒ a plain uploaded
  file. `metadata.app` is the routing key the web layer uses to open the right
  editor.

## Migration & backfill

One migration file, **`0027_drive_unification_backfill.sql`** — pure data, no
schema/enum change, so the runner's per-file transaction is fine:

- For every existing `sheets` and `slide_decks` row, insert a shared-PK
  `objects` row (`id` = content id, `kind='file'`, `owner_actor_id`,
  `storage_key` = `sheets/<org>/<id>` resp. `slides/<org>/<id>`, `mime_type` =
  `application/vnd.helix.spreadsheet` resp. `application/vnd.helix.presentation`,
  `byte_size = 0`, `sha256 = null`, `metadata` = `{ app, name: title, title,
  folderId: null }`). Mirror `deleted_at` from the content row.
- Idempotent: `on conflict (id) do nothing`.
- Also defensively inserts `objects` rows for any `docs_documents` that lack one
  (seeded docs were inserted directly, bypassing `docs.create`).

The workspace seed (`seed-workspace.ts`) is updated so its docs/sheets/decks are
*born* with shared-PK `objects` rows filed into sensible folders (Engineering,
Finance, Marketing, Product) rather than landing at root.

## Create flow

New unified tool **`drive.create`**:

- Input: `{ kind: "folder" | "document" | "spreadsheet" | "presentation",
  folderId?: string | null, name: string }`.
- For folder: inserts a `drive_folders` row (existing path).
- For doc/sheet/deck: in one transaction, inserts the content row **and** the
  shared-PK `kind='file'` `objects` row (same UUID, `metadata.app`,
  `metadata.folderId`, `metadata.name`) — mirroring exactly what `docs.create`
  already does.
- Output: `{ id, app }` — `id` is the shared UUID used for both the Drive entry
  and the editor route; `app` selects the editor.

Because each content store has **two implementations** (in-memory + Postgres),
the shared-PK insert is added to both for sheets and slides (docs already does
it in its Postgres store; its in-memory store is updated to match).

Web: the Drive "New" dropdown calls `drive.create`, then routes to the editor
(`/docs/$id`, `/sheets/$id`, `/slides/$id`) so the user edits the blank item
immediately. The existing standalone "New doc / New sheet / New deck" buttons on
the typed surfaces also route through `drive.create`.

## Unified Drive operations

No predicate widening is needed — doc/sheet/deck objects are `kind='file'`, so
`drive.list` / `trash` / `delete` / `move` / `restore` / `search` already operate
on them. The required changes are:

- **`drive.list`** — add an optional `app?` filter (`docs`/`sheets`/`slides`/
  `file` for plain uploads) so the re-platformed list pages can request one
  category. Ensure the returned `DriveEntryRecord` exposes `metadata.app` so the
  web layer can pick the editor route.
- **Trash cascade** — generalize the existing `syncDocsDeletedAt` helper into
  `syncTargetDeletedAt`, which updates `docs_documents`, `sheets`, or
  `slide_decks` (chosen by `metadata.app`) using the shared PK. It is already
  called from `trash`/`delete`/`restore`; only its body changes.
- **`drive.share`**, **`drive.move`** — unchanged; they already operate on the
  `kind='file'` `objects` row.

## Re-platformed list pages

- The Docs / Sheets / Slides **list pages** query `drive.list` with the new
  `app` filter (`docs` / `sheets` / `slides`) instead of `docs.list` /
  `sheets.list` / `slides.deck.list`.
- Each entry links to its editor via `metadata.app` + the shared `id`.
- The editing UIs are untouched.
- `docs.list` / `sheets.list` / `slides.deck.list` remain available for
  programmatic/API use but are no longer the web list source of truth.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `0027_drive_unification_backfill.sql` | Shared-PK `objects` rows for existing sheets/decks/docs | existing schema |
| `drive.create` tool | Atomic content-row + shared-PK object-row creation | drive store, docs/sheets/slides stores (both impls) |
| Sheets/Slides stores | Shared-PK `objects` insert on create (in-memory + Postgres) | `objects` |
| `syncTargetDeletedAt` | Trash/restore cascade by `metadata.app` | `objects`, content tables |
| `drive.list` | New `app?` filter; expose `metadata.app` on entries | `objects`, `drive_folders` |
| Drive "New" dropdown (web) | Menu → `drive.create` → route to editor | `drive.create` |
| Re-platformed list pages (web) | Docs/Sheets/Slides lists over `drive.list` | `drive.list` |
| `seed-workspace.ts` | Seeds content rows with shared-PK `objects` rows in folders | all of the above |

## Error handling

- `drive.create` is transactional — a failed content insert rolls back the object
  insert and vice-versa.
- Trash/restore cascade (`syncTargetDeletedAt`) runs in the same transaction as
  the object update.
- A `drive.list` entry whose paired content row is missing (dangling shared PK)
  renders as a non-clickable stale file rather than a broken editor link.

## Testing

- Migration `0027` backfill test: existing `sheets`/`slide_decks` gain exactly
  one shared-PK `objects` row each; re-running is idempotent
  (`on conflict do nothing`); docs missing an object row also get one.
- `drive.create` per kind: content row + shared-PK `objects` row created with
  matching id and correct `metadata.app`, in both the in-memory and Postgres
  store implementations.
- Trash cascade: trashing a sheet- or deck-object sets `sheets.deleted_at` /
  `slide_decks.deleted_at` via `syncTargetDeletedAt`; restore reverses it.
- `drive.list` `app` filter returns only the requested category; entries expose
  `metadata.app`.
- Re-platformed list-page component tests (Docs/Sheets/Slides) render Drive-backed
  data.
- E2e: create a document from Drive → edit it → confirm it appears both in the
  Drive listing and on the Docs surface.

## Rollout

Single migration + coordinated backend/web change on the `ui-overhaul` branch.
The seed is re-run after the migration. No feature flag — the change is internally
consistent once landed.
