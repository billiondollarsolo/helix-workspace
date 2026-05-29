# Follow-up tracker

Items extracted out of REVIEW.md fixes that intentionally ship as interim
safety nets and need a follow-up PR to land the proper solution.

## Slides — per-shape OT (replaces interim per-slide CAS)

**Context.** `REVIEW.md` CRITICAL-5 flagged that concurrent edits to the same
slide would silently last-write-win the entire slide-content JSON blob. The
fix shipped in this branch is **Option B (interim safety net)**: a per-slide
`revision` integer in `slides`, sent back as `expectedRevision` on
`update-slide` / `delete-slide` sync ops, and a new `slide-conflict` WS frame
that delivers the authoritative snapshot to the rejected client. No data is
lost, but two users editing different shapes on the same slide still serialize
(the second user's edit is rejected and discarded until they touch the slide
again on the fresh snapshot).

Files where the interim sits (search for `TODO(slides-ot)` or
"interim safety net"):

- `apps/helix/src/platform/slides/store.ts` — CAS check inside
  `applyOperation`, revision bumps inside `#applySyncOperation`.
- `apps/helix/src/platform/slides/routes.ts` — `slide-conflict` frame.
- `apps/helix/src/platform/slides/types.ts` — `SlideRecord.revision`.
- `apps/helix/src/db/migrations/0060_slides_per_slide_revision.sql` — column.
- `apps/web/src/features/slides/native-presentation-sync-provider.ts` —
  conflict-frame handling.
- `apps/web/src/features/slides/native-presentation-editor.tsx` —
  `expectedRevision` send sites + `onConflict` callback.

**Option A — what the proper fix looks like.**

1. Introduce a `SlideOperation` discriminated union of atomic shape mutations:
   `insert-shape`, `delete-shape`, `transform-shape`, `set-text`, `set-style`,
   `reorder-shapes`, plus per-layout typed-field mutations
   (`set-title`, `set-eyebrow`, `set-bullet-item`, `replace-stats-entry`, …).
2. Replace `update-slide` (full-content write) on the WS protocol with a
   sequence of these atomic ops. Keep `update-slide` available on the REST
   tool surface for bulk imports (PPTX, AI generation) but funnel realtime
   collaboration exclusively through the new ops.
3. Server-side per-op `apply` walks the existing `SlideContent` discriminated
   union and applies the op atomically. Concurrent non-overlapping ops (two
   users editing different shapes) succeed both. Overlapping ops (two users
   editing the same shape's text) resolve via OT/rebase like sheets.
4. Op-log compaction (mirror `sheets.compactOperations`) — `slides_op_log`
   today grows forever (REVIEW HIGH item). The migration should add
   `slide_decks.compacted_through_revision` (or equivalent metadata) and a
   compaction job triggered from the WS room same way sheets does it.
5. Cross-node WS fanout via `EventBus`. Slides currently has none (REVIEW
   HIGH item); copy the pattern from `apps/helix/src/platform/sheets/routes.ts`
   (`publishSheetsFanout` / `handleSheetsFanoutEvent`).
6. Client switches to optimistic per-op apply with server-rebase on `ahead`
   or `conflict`. Undo/redo (REVIEW MEDIUM item) falls out of the op-log
   inverses.

**Suggested order.**

1. Land Option A's op-log compaction + cross-node fanout first — they share
   plumbing with the new ops and unblock multi-node deployments today.
2. Add the new `SlideOperation` shape mutations alongside `update-slide`;
   migrate the client one op at a time (start with `set-text` since that's
   where data loss bites hardest in practice).
3. Remove the interim per-slide CAS once all realtime edits go through atomic
   ops and the `update-slide` WS path is gone.

**Tests to write up-front** (so the interim doesn't regress while Option A is
in flight):

- Two clients edit different shapes on the same slide simultaneously: both
  edits survive after Option A lands; with the interim only one survives but
  neither is silently dropped.
- Op-log compaction trims at threshold, replays correctly.
- Cross-node: an op published on node A is received and broadcast on node B's
  room.
