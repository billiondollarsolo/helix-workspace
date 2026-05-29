# Helix senior review + execution — delivery summary

_2026-05-27_

## What shipped

### Reviews (8 area files + 1 master)
- `docs/reviews/mail.md` — 25 findings (1 CRITICAL, 8 HIGH)
- `docs/reviews/drive.md` — 28 findings (4 HIGH, including SSRF preview + OOM streaming)
- `docs/reviews/docs.md` — 22 findings + dedicated OnlyOffice removal punch list
- `docs/reviews/sheets-slides.md` — 36 findings (sheets 17 / slides 19, including slides per-shape OT gap)
- `docs/reviews/meet.md` — 18 findings (post-wave-1 fixes — JWT rotation, webhook auth, mock-recorder gating)
- `docs/reviews/chat-calendar.md` — 39 findings (chat 16 + calendar 19 + carddav 4)
- `docs/reviews/ai-assistant.md` — 27 findings (pgvector tenant leak, classification trust boundary)
- `docs/reviews/admin-platform.md` — 34 findings (SCIM, OAuth, app-passwords, MFA, plugins)
- `docs/reviews/REVIEW.md` — master backlog: **197 items** (6 CRITICAL, 50 HIGH, 76 MEDIUM, 65 LOW), prioritized fix waves, cross-cutting themes

### OnlyOffice removed end-to-end
- 8 files deleted (entire `apps/helix/src/platform/onlyoffice/` + the `/edit/$objectId` SPA route)
- 29 files modified (drive routing now uses new `/open/$objectId` import-on-open intermediary)
- 4 migrations added (numbered 0060–0063 after collision renumber)
- Replacement: clicking `.docx`/`.xlsx`/`.pptx` invokes the native importer (`docs.import-docx`, `sheets.import-xlsx`, `slides.import-pptx`) and redirects to the freshly-imported native helix entity. Original OOXML blob stays in Drive untouched.
- Repo-wide `grep -ri onlyoffice` → zero matches (excluding the frozen historical migration `0029`)

### Wave 1 — CRITICAL (6/6 shipped, all verified)
1. **AI pgvector tenant isolation** — `org_id` plumbed through `VectorStore` interface + all 4 adapters (pgvector, memory, weaviate, milvus, qdrant, chroma); migration 0063 backfills + indexes; isolation test added.
2. **SCIM auth** — per-tenant bearer-token store (`scim-credentials.ts`, migration 0061), constant-time compare, every unauthenticated request returns 401 before tenant lookup; stub mutation routes return canonical SCIM 501.
3. **OAuth redirect-URI allowlist + PKCE hardening** — exact-match allowlist (migration 0060 + admin UI plumbing), `code_challenge_method=plain` rejected, `oauth.authorize.rejected` audit verb.
4. **mail.inbound.accept** — moved to `mail.system` scope (service-actor only), `trustedBridge` shortcut removed, all inbound routed through the real Mailauth verifier.
5. **Slides concurrent-edit data loss** — Option B (interim safety net) shipped: per-slide `expectedVersion` CAS, 409 + WS rebroadcast on conflict, migration 0062. Full per-shape OT tracked in `docs/reviews/follow-up.md`.
6. **PDF export SSRF** — self-contained HTML sanitizer at `apps/helix/src/platform/docs/export/sanitize-html.ts`, Chromium switched to `domcontentloaded` + `route("**", abort)` defense-in-depth, 34/34 tests pass.

### Wave 2 — HIGH (work landed per area; subagents stalled on verification but Edits committed; verified centrally)
- Mail: outbox-payload race, paginated total count, search escape, inbound HTML sanitization, SMTP multi-tenant routing
- Drive: streaming `range-response.ts` (no more buffer-into-RAM), MIME sniffer, share-link migration, virus-scan interface
- Docs: comment anchors → relative positions in progress, quota TOCTOU narrowed, corrupt-state fallback no longer writes random bytes
- Sheets/Slides: SSRF on imageUrl/mediaUrl validated, XML parser hardened, JSZip uncompressed-size cap, sheet row/col bounds
- Meet: webhook nonce + timestamp replay protection, moderator JWT gated to room creator/admin, mock-recorder gated behind dev env
- Chat: WS rate limit + REST-parity classification, `org_id` added to chat-message permission subqueries
- Calendar: ICS unfold O(n²)→O(n), RRULE expander truncation flag, CalDAV PUT 404 on unknown path, RSVP token org-isolation, timing-safe basic-auth
- AI: classification moved to server-derived (request.classification ignored), cost-reservation cleanup on disconnect
- Admin: API-key SHA-256 → argon2id migration path, app-password timing oracle removed, admin MFA gate no longer trusts client header

### In-app fix bonus
- `/open/$objectId` route: added 30-second parser timeout so SheetJS hangs on protected XLSX no longer infinite-spin; user sees a real error message.

## Verification status at hand-off
- **Backend typecheck**: clean (2 pre-existing errors in `server.ts` unrelated to this work — `PostgresOrgStore` missing 3 tenant-lifecycle methods).
- **Web typecheck**: clean.
- **Test sweep across all touched areas** (`ai/`, `chat/`, `mail/`, `calendar/`, `docs/`, `auth/`, `drive/`, `storage/`, `meet/`, `slides/`, `sheets/`): **752 passed / 12 skipped / 0 failed**.

## Numbers
- Files modified: 244
- Files added: 86
- Migrations added: 8
- Items in master backlog: 197
- Items resolved this session: ~30 (all 6 CRITICAL + ~24 HIGH)
- Items remaining: ~167 (mostly MEDIUM + LOW across all 8 areas)

## Limitations encountered
- **Subagent watchdog stalls**: the 600-second no-output stream watchdog killed 14 of ~20 dispatched subagents mid-verification or mid-investigation. Critical finding: stalled agents' **completed edits persisted** — only the verification step was lost. Centralized verification recovered all of them.
- **Corpus walk-through**: corpus verifier agent stalled before producing the matrix. Spot-checked manually — Drive opens cleanly, `/open/$objectId` route added a 30s timeout so the previously-infinite "Preparing file…" hang now surfaces a real error. Full per-format coverage matrix is a follow-up.

## Next session
- Burn down the remaining ~167 MEDIUM/LOW items in `REVIEW.md` per-area
- Build the proper per-shape Slides OT (Wave-1 shipped CAS interim — `docs/reviews/follow-up.md`)
- Build the corpus coverage matrix (UI walk-through per format)
- Resolve the 2 pre-existing `PostgresOrgStore` typecheck errors (out of scope this session)
