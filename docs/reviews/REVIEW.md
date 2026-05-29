# Helix Senior Review — Master Backlog

_Aggregated from 8 area reviews on 2026-05-27._

## Executive summary

Helix is structurally a credible Google-Workspace competitor: each surface (Mail, Drive, Docs, Sheets, Slides, Meet, Chat, Calendar, Assistant, Admin) has end-to-end wiring through real backends, real persistence, real WS/SSE realtime channels, and a defensible test footprint. The strongest parts are Mail's outbound pipeline (queue + undo + provider abstraction + dispatcher tracing), Sheets' operational-transform engine, Drive's versioning/WebDAV/quota math, Docs' per-doc Yjs auth and pgvector-backed AI orchestrator, and the Admin platform's argon2id-upgrade + hash-chain + immutable-S3 destinations. Tests are extensive (~7k LOC in Drive alone) and types are tight.

The worst risk concentrates in the **trust boundary between tenants and the cross-cutting AI/auth/audit substrate**. The pgvector store has no tenant scoping at all (any caller can read any org's embeddings); SCIM endpoints are unauthenticated; OAuth `/authorize` accepts any redirect_uri and `plain` PKCE; plugins load in-process with full Node privileges; the admin MFA gate trusts a client-supplied header; an `mail.inbound.accept` tool fakes SPF/DKIM/DMARC and lets any user inject "trusted" mail; SMTP receiver is hard-pinned to one org from env; Meet recording webhooks have no HMAC/replay protection and a dev `mock-recorder` ships in production; Slides URL fields accept any scheme.

The single biggest theme is **tenant isolation has been treated as opt-in instead of structural** — many internal stores require callers to remember to pass an `orgId` and silently do the wrong thing if they don't. The second-biggest theme is **stubs presented as features**: model selector, share dialogs, transcripts, presentation chrome, billing CTAs, admin overview, comment notifications, attachment buttons, 2FA enrollment — all are wired into UI as if shipped but no-op behind the click.

The ~5 things to fix first: (1) close cross-tenant data-access vectors (pgvector, SCIM, mail bridge, OAuth redirect, share validation); (2) put real sandboxing/auth on plugins, admin MFA, Meet webhooks; (3) virus-scan + MIME-sniff uploaded content (Drive, Mail attachments); (4) sanitize HTML/URL inputs before re-rendering (Docs PDF Chromium, Slides image URL, Mail HTML body); (5) fix the silent-data-loss bugs (Drive content buffering OOM, Slides concurrent edits overwriting, comment anchors drifting, cost-reservation leaks).

## Scorecard

| Area | Security | Correctness | Features | Quality |
|------|----------|-------------|----------|---------|
| Mail | 2/5 | 3/5 | 3/5 | 3/5 |
| Drive | 2.5/5 | 3/5 | 3/5 | 3/5 |
| Docs | 3/5 | 3/5 | 3/5 | 2/5 |
| Sheets | 4/5 | 3/5 | 3/5 | 2/5 |
| Slides | 2/5 | 2/5 | 2/5 | 2/5 |
| Meet | 2/5 | 3/5 | 2/5 | 3/5 |
| Chat | 3.5/5 | 3/5 | 2.5/5 | 3.5/5 |
| Calendar | 2.5/5 | 2.5/5 | 3/5 | 3/5 |
| AI/Assistant | 2/5 | 3.5/5 | 2.5/5 | 3.5/5 |
| Admin/Platform | 2/5 | 3/5 | 2/5 | 2/5 |

## Prioritized backlog

### 🔴 CRITICAL (ship-blocking security or data-loss)

- **[ai] pgvector store has no tenant scoping** — `apps/helix/src/platform/ai/vector/pgvector.ts:34-94` — any caller that knows a collection name can read or overwrite every tenant's vectors. *Fix effort: M.*
- **[admin] SCIM endpoints public + tenant-enumeration oracle** — `apps/helix/src/platform/auth/scim-routes.ts:22-90` — unauthenticated `/api/scim/v2/:tenantSlug/*`, skips tenancy middleware, 404 vs 501 leaks tenant existence. *Fix effort: M.*
- **[admin] OAuth `/authorize` accepts any redirect_uri and `plain` PKCE** — `apps/helix/src/platform/auth/routes.ts:347-382` — classic auth-code interception; no per-client redirect allowlist. *Fix effort: M.*
- **[mail] `mail.inbound.accept` fakes SPF/DKIM/DMARC and lets any `mail.write` actor inject "trusted" mail** — `apps/helix/src/platform/mail/tools.ts:313-348,713-726` — full impersonation from any normal user. *Fix effort: M.*
- **[slides] concurrent edits to same slide silently overwrite each other** — `apps/helix/src/platform/slides/store.ts:651-708,787-818` — no OT; last writer wipes the other's shape edits. *Fix effort: L.*
- **[docs] Chromium PDF renderer trusts `document.html` and waits for `networkidle`** — `apps/helix/src/platform/docs/export/formats.ts:282-284` + `chromium.ts:56-58` — SSRF/exfil via `<img>`/`<link>`/`<iframe>` to internal hosts. *Fix effort: M.*

### 🟠 HIGH

- **[admin] Plugins load in-process with full Node privileges** — `apps/helix/src/platform/plugins/loader.ts:234-265` — declared `permissions` not enforced; malicious plugin reads all secrets. *Fix effort: L.*
- **[admin] API keys stored as bare SHA-256 (no salt, no work factor)** — `apps/helix/src/platform/auth/credentials.ts:95-97`. *Fix effort: M.*
- **[admin] App-password verify is a per-username password oracle (timing leak + cross-tenant scan)** — `apps/helix/src/platform/auth/app-passwords.ts:281-322`. *Fix effort: M.*
- **[admin] Admin MFA gate trusts client-supplied `x-helix-mfa-verified` header** — `apps/helix/src/platform/auth/mfa.ts:54-60` — Enterprise-tier control is effectively not enforced. *Fix effort: M.*
- **[admin] Primary `activity` audit table is mutable Postgres (WORM only on opt-in shippers)** — `apps/helix/src/platform/audit/store.ts:33-85`. *Fix effort: S.*
- **[admin] Admin audit writes are best-effort and silently swallowed** — `apps/helix/src/platform/admin/console-shared.ts:198-217`. *Fix effort: M.*
- **[admin] `admin.users` scope now implies full admin-console read** — `apps/helix/src/platform/admin/console-shared.ts:28-36` — silent privilege expansion. *Fix effort: S.*
- **[admin] SAML ships metadata only — no ACS, no signature verification** — `apps/helix/src/platform/auth/saml-routes.ts:21-72`. *Fix effort: L.*
- **[admin] No 2FA enrollment flow exists; `security_policies.mfa.allowedMethods` promises unimplemented methods** — `apps/helix/src/platform/auth/better-auth.ts:419-445`. *Fix effort: L.*
- **[admin] Agent-credential `ipAllowlist`/`allowedHours` declared but never enforced** — `apps/helix/src/platform/auth/credentials.ts:45-50`. *Fix effort: M.*
- **[ai] Classification can be downgraded via untrusted request input** — `apps/helix/src/platform/ai/routing.ts:215` + `assistant/tools.ts:42` — caller-supplied `classification` bypasses `assertClassificationAllowed`. *Fix effort: M.*
- **[ai] Provider API keys are process-global, not per-tenant** — `apps/helix/src/platform/ai/providers/*.ts` — no BYOK, no rotation, no audit on key read. *Fix effort: L.*
- **[ai] No prompt-injection / output guardrails before tool execution** — `apps/helix/src/platform/assistant/orchestrator.ts:177-209` — retrieved sources can issue tool calls. *Fix effort: L.*
- **[ai] No PII redaction in prompts or provenance; advertised `redactPIIBeforeSend` not enforced** — `apps/helix/src/platform/ai/routing.ts:516-532`. *Fix effort: M.*
- **[ai] No per-tenant AI rate/concurrency limit (only daily cost)** — `apps/helix/src/platform/ai/costs/`. *Fix effort: M.*
- **[ai] Cost reservation leaks on aborted streams** — `apps/helix/src/platform/ai/routing.ts:237-302` — drift in tenant budget over time. *Fix effort: S.*
- **[ai] Pending-confirmation UI never wired** — `apps/web/src/features/assistant/assistant-surface.tsx` — destructive tool calls hang silently. *Fix effort: M.*
- **[ai] Model selector in composer is fake (hard-coded marketing list, never sent to backend)** — `apps/web/src/features/assistant/assistant-data.ts:93-100`. *Fix effort: M.*
- **[mail] SMTP receiver single-tenant, pinned to env-configured org** — `apps/helix/src/platform/mail/ingest.ts:90-126` + `server.ts:1717-1728` — every inbound mail stamped with one orgId regardless of RCPT TO. *Fix effort: M.*
- **[mail] HTML mail bodies stored verbatim with no sanitization** — `apps/helix/src/platform/mail/ingest.ts:236-237`; future HTML toggle = stored-XSS. *Fix effort: M.*
- **[mail] Frontend calls `mail.spam` and `mail.filter.list` — neither registered** — `apps/web/src/features/mail/api.ts:330-335,394-403` vs `mail/tools.ts:248-647`. *Fix effort: S.*
- **[mail] Admin REST contract mismatch — five tabs 404 or "malformed response"** — `apps/web/src/features/admin/mail-admin-api.ts:300-309,356-365` vs `mail/admin-routes.ts:259-277`. *Fix effort: L.*
- **[mail] Outbox row carries `mailOutboundId: ""` between insert and update** — `apps/helix/src/platform/mail/store.ts:355-390` — race drops sends. *Fix effort: S.*
- **[mail] `listThreads` `total` is per-page, breaks pager** — `apps/helix/src/platform/mail/store.ts:969-985`. *Fix effort: S.*
- **[mail] Drafts/Sent folder predicates broken — queued drafts appear in Sent** — `apps/helix/src/platform/mail/store.ts:944-960`. *Fix effort: M.*
- **[mail] Free-text search uses `ilike '%query%'` with unescaped `%`/`_`** — `apps/helix/src/platform/mail/store.ts:723-750`. *Fix effort: M.*
- **[drive] Server trusts client `mimeType`; no sniffing or nosniff header** — `apps/helix/src/platform/drive/store.ts:340-398` + `tools.ts:236-263`; preview inlines `text/html`. *Fix effort: M.*
- **[drive] No virus / malware scanning on upload** — `apps/helix/src/platform/drive/store.ts:401-501`. *Fix effort: L.*
- **[drive] No public / anonymous share links** — `apps/helix/src/platform/drive/store.ts:706-737` — table-stakes competitor feature. *Fix effort: L.*
- **[drive] Content endpoint buffers entire file into memory — OOM on multi-GB downloads** — `apps/helix/src/server.ts:2576-2627` + `store.ts:686-704,1405-1414`. *Fix effort: M.*
- **[docs] Comment / suggestion anchors are absolute ProseMirror positions — drift on every concurrent edit** — `apps/web/src/features/docs/native-document-anchors.ts:22-71`. *Fix effort: L.*
- **[docs] Quota TOCTOU on `activeDocsSocketCount` admits over-quota editors** — `apps/helix/src/platform/docs/routes.ts:181-188`. *Fix effort: S.*
- **[docs] DOCX import has no zip-bomb / entry-count guard; Mammoth runs in-process** — `apps/helix/src/platform/docs/tools.ts:105-114,1175-1195`. *Fix effort: M.*
- **[docs] `EditorAppBar` `presence` prop never populated — multi-user awareness invisible** — `apps/web/src/features/docs/native-document-shell.tsx:517-537`. *Fix effort: M.*
- **[sheets] Per-operation `delete from sheet_cells` + N inserts** — `apps/helix/src/platform/sheets/store.ts:4055-4089` — perf cliff at any meaningful sheet size. *Fix effort: M.*
- **[sheets] Sync client drops `compacted`/`dropped`/`duplicate`/`reconnectRequired` frames** — `apps/web/src/features/sheets/native-spreadsheet-sync-provider.ts:160-182`. *Fix effort: M.*
- **[slides] No op-log compaction (`slides_op_log` grows forever)** — `apps/helix/src/platform/slides/store.ts:651-708`. *Fix effort: M.*
- **[slides] No cross-node WS fanout — multi-node deployments break collaboration** — `apps/helix/src/platform/slides/routes.ts:112-216`. *Fix effort: M.*
- **[slides] `imageUrl`/`mediaUrl`/`mediaPosterUrl`/`mediaCaptionUrl` accept any URL scheme** — `apps/helix/src/platform/slides/content.ts:44-52` — tracker pixels, SSRF on SVG/PDF export. *Fix effort: S.*
- **[slides] `presentation-chrome.tsx` is a TODO graveyard (43+ inert menu items)** — `apps/web/src/features/slides/native-presentation-chrome.tsx:171-626`. *Fix effort: L.*
- **[slides] PPTX export silently degrades Drive-hosted images to grey placeholders** — `apps/helix/src/platform/slides/export-pptx.ts:337-449`. *Fix effort: M.*
- **[meet] Jitsi JWT signing secret is single shared env constant, no rotation, no `kid`** — `apps/helix/src/platform/meet/jwt.ts`. *Fix effort: L.*
- **[meet] Webhook auth is static shared secret with no HMAC/timestamp/replay protection** — `apps/helix/src/platform/meet/routes.ts:82,179,287`. *Fix effort: M.*
- **[meet] Recording ACL is a SELECT-then-INSERT snapshot; never cascades later attendees, never revokes** — `apps/helix/src/platform/meet/store.ts:1018-1035`. *Fix effort: M.*
- **[meet] `mock-recorder` registers in any env where Meet is enabled** — `apps/helix/src/server.ts:2083-2088` + `mock-recorder.ts:1-12`. *Fix effort: S.*
- **[meet] `attachRecording` matches by `roomName` only; trusts `X-Helix-Org-Id` header** — `apps/helix/src/platform/meet/routes.ts:185-263`. *Fix effort: S.*
- **[meet] Scheduled → active transition not implemented; hub blocks all scheduled meetings** — `apps/helix/src/platform/meet/store.ts:169-240`. *Fix effort: M.*
- **[calendar] RSVP endpoint unauthenticated, unrate-limited, GET-only token** — `apps/helix/src/platform/calendar/routes.ts:40-57`. *Fix effort: S.*
- **[admin] Billing has fake CTAs and `mailto:sales@helix.example` placeholder** — `apps/web/src/features/admin/admin-console.tsx:1586-1727`. *Fix effort: M.*

### 🟡 MEDIUM

- **[mail] DMARC aggregate report parsed by regex over XML** — `apps/helix/src/platform/mail/dmarc.ts:28-126`. *Fix effort: M.*
- **[mail] Vacation auto-responder loops on `MAILER-DAEMON`/list/auto-replied senders** — `apps/helix/src/platform/mail/filters.ts:48-90`. *Fix effort: S.*
- **[mail] Outbound `envelope` including BCC persisted + returned by `mail.outbound.get`** — `apps/helix/src/platform/mail/store.ts:332-393` + `tools.ts:826-837`. *Fix effort: S.*
- **[mail] Attachment storage key uses unescaped filename (path traversal on local FS)** — `apps/helix/src/platform/mail/store.ts:1173-1175`. *Fix effort: S.*
- **[mail] BCC sent in single `sendMail` call; relays that don't strip leak BCC header** — `apps/helix/src/platform/mail/outbound.ts:69-89`. *Fix effort: M.*
- **[mail] SMTP receiver disables AUTH by default; no DMARC-fail rejection** — `apps/helix/src/platform/mail/ingest.ts:93-126`. *Fix effort: M.*
- **[mail] Outbound dispatcher has no transient/permanent retry classification** — `apps/helix/src/platform/mail/outbound.ts:174-182`. *Fix effort: M.*
- **[mail] `findActorByAddress` ignores disabled actor state** — `apps/helix/src/platform/mail/store.ts:306-326`. *Fix effort: S.*
- **[mail] Bulk actions fan-out N sequential mutations, no batching, no progress** — `apps/web/src/features/mail/mail-shell.tsx:2441-2520`. *Fix effort: M.*
- **[drive] Role enum drift — share tool accepts `reader`, store types use `viewer`** — `apps/helix/src/platform/drive/tools.ts:64` vs `types.ts:6`. *Fix effort: S.*
- **[drive] WebDAV locks live in process-local Map (broken across replicas, lost on restart)** — `apps/helix/src/platform/drive/routes.ts:42,172-203`. *Fix effort: M.*
- **[drive] WebDAV PUT body fully buffered (twice) + Fastify default 1MB bodyLimit** — `apps/helix/src/platform/drive/routes.ts:38-40,700-714`. *Fix effort: M.*
- **[drive] `assertStorageQuotaAvailable` does `for update of orgs` + S3 PUT inside transaction** — `apps/helix/src/platform/drive/store.ts:1503-1570` + `425-435`. *Fix effort: M.*
- **[drive] Inline-body dev fallback wired into prod `/content`/`/preview` routes** — `apps/helix/src/server.ts:2612-2626` + `inline-body.ts:24-42`. *Fix effort: S.*
- **[drive] `drive.share` `on conflict do nothing` silently no-ops role upgrades; no `drive.unshare`** — `apps/helix/src/platform/drive/store.ts:721-727`. *Fix effort: S.*
- **[drive] `share` doesn't validate target actor belongs to same org** — `apps/helix/src/platform/drive/store.ts:706-737`. *Fix effort: S.*
- **[drive] Trashing leaves blobs indefinitely; quota math excludes trash** — `apps/helix/src/platform/drive/store.ts:752-780`. *Fix effort: M.*
- **[drive] PROPFIND lists at most 250 children, silently truncates → 404 on PUT in busy folders** — `apps/helix/src/platform/drive/routes.ts:81-87,346-352`. *Fix effort: S.*
- **[drive] `acrossFolders` flag skips folder access check, silently ignores `folderId`** — `apps/helix/src/platform/drive/store.ts:518-574`. *Fix effort: S.*
- **[drive] No file rename / copy / duplicate; no WebDAV MOVE/COPY** — `apps/helix/src/platform/drive/store.ts` + `tools.ts`. *Fix effort: M.*
- **[drive] No drag-and-drop / multi-select / chunked uploads** — `apps/web/src/features/drive/drive-shell.tsx:318-400`. *Fix effort: L.*
- **[drive] Share dialog is a freeform Actor-ID textbox; no people picker** — `apps/web/src/features/drive/drive-shell.tsx:1889-1905`. *Fix effort: M.*
- **[docs] Yjs WS auth fallback puts `access_token` in URL → logged everywhere** — `apps/web/src/features/docs/native-document-yjs-provider.ts:196-204`. *Fix effort: M.*
- **[docs] PDF scaffold silently truncates content to 42×96 chars on Chromium-unavailable fallback** — `apps/helix/src/platform/docs/export/formats.ts:372-391`. *Fix effort: M.*
- **[docs] Per-update `Y.encodeStateAsUpdate(room.doc)` produces O(n²) encoding** — `apps/helix/src/platform/docs/routes.ts:469-479`. *Fix effort: S.*
- **[docs] `markdownInlineToHtml` link allowlist is brittle — one alternation edit enables `javascript:`** — `apps/helix/src/platform/docs/export/formats.ts:1187-1207`. *Fix effort: S.*
- **[docs] `ydocFromStoredState` falls back to treating random bytes as UTF-8 markdown** — `apps/helix/src/platform/docs/routes.ts:574-585`. *Fix effort: S.*
- **[sheets] Comments anchor `JsonObject` not zod-validated; can be out-of-bounds** — `apps/helix/src/platform/sheets/store.ts:139-140`. *Fix effort: S.*
- **[sheets] Optimistic grid never reverts a server-rejected edit** — `apps/web/src/features/sheets/native-spreadsheet-sync-provider.ts:127-153`. *Fix effort: M.*
- **[sheets] Toolbar font/size/underline/strikethrough/wrap/merge/valign all TODO/inert** — `apps/web/src/features/sheets/native-spreadsheet-chrome.tsx:442,449,477,484,568,575,582`. *Fix effort: M.*
- **[sheets] Charts/pivots metadata stored as opaque blobs — no schema validation on persist** — `apps/helix/src/platform/sheets/store.ts:473-527`. *Fix effort: M.*
- **[sheets] Frontend rebase diverges from backend on cross-tab references** — `apps/web/src/features/sheets/native-spreadsheet-sync-provider.ts:211-299`. *Fix effort: M.*
- **[sheets] `SHEET_MAX_ROWS/COLS` enforced only client-side; scripted client can OOM server** — server `store.ts` cell-edit validation. *Fix effort: S.*
- **[sheets] Formula re-eval recomputes whole tab on every cell change** — `apps/helix/src/platform/sheets/formula.ts:77-160`. *Fix effort: M.*
- **[sheets] No real-time presence/awareness frames for sheets (slides has them)** — `apps/helix/src/platform/sheets/routes.ts`. *Fix effort: M.*
- **[slides] PPTX import uses `fast-xml-parser` without explicit DTD/entity opt-out; no zip-bomb cap** — `apps/helix/src/platform/slides/import-pptx.ts:21-25`. *Fix effort: S.*
- **[slides] `update-slide` `??`-merge → lossy partial updates** — `apps/helix/src/platform/slides/store.ts:797-808`. *Fix effort: M (in SL1).*
- **[slides] Socket replies broadcast full deck snapshot on every op** — `apps/helix/src/platform/slides/routes.ts:283-295`. *Fix effort: M.*
- **[slides] No undo/redo at all in slides editor** — `apps/web/src/features/slides/native-presentation-chrome.tsx:171-172`. *Fix effort: M.*
- **[slides] Reorder uses negative-position hack, racy under concurrent reorders** — `apps/helix/src/platform/slides/store.ts:751-762`. *Fix effort: S.*
- **[meet] Presigned PUT TTL fixed at 15min; no cleanup of expired upload IDs; presign accepts any contentType** — `apps/helix/src/platform/meet/routes.ts:139-170`. *Fix effort: M.*
- **[meet] Moderator bit grant-on-create + caller-supplied flag; no demote path** — `apps/helix/src/platform/meet/tools.ts:188` + `jwt.ts:51`. *Fix effort: M.*
- **[meet] "Summary" button inert; no AI summary producer; transcription hard-disabled** — `apps/web/src/features/meet/meet-hub.tsx:496-498`. *Fix effort: L.*
- **[meet] No calendar integration despite schedule flow** — `apps/web/src/features/meet/meet-hub.tsx:541-649`. *Fix effort: M.*
- **[meet] No pre-call device picker, lobby moderation UI, breakout-room controls** — `apps/web/src/features/meet/jitsi-external-api.ts:219-244`. *Fix effort: L.*
- **[meet] No Helix branding (Jitsi watermark/name still leaks)** — `infra/meet/config/web/interface_config.js:12,30,74,103,130`. *Fix effort: M.*
- **[meet] Double `meet.end-room` race between hangup and Leave button** — `apps/web/src/features/meet/meet-call.tsx:84-113`. *Fix effort: S.*
- **[meet] E2E spec references DOM that no longer exists** — `apps/web/tests/e2e/meet-jitsi-embed.spec.ts:42-48`. *Fix effort: S.*
- **[chat] WS frames have no per-connection rate limit or backpressure** — `apps/helix/src/platform/chat/routes.ts:134-148`. *Fix effort: M.*
- **[chat] WS `send` path skips classification; REST `chat.send` enforces it** — `apps/helix/src/platform/chat/routes.ts:211-235`. *Fix effort: M.*
- **[chat] Attachment object IDs accepted with no ownership/scan check** — `apps/helix/src/platform/chat/routes.ts:32` + `tools.ts:38`. *Fix effort: S.*
- **[chat] Edit/delete permission subquery missing `org_id` filter** — `apps/helix/src/platform/chat/store.ts:415-444,446-474`. *Fix effort: S.*
- **[chat] No message ordering guarantee — client dedupes by id only** — `apps/web/src/features/chat/chat-shell.tsx:150-163`. *Fix effort: M.*
- **[chat] No backfill on reconnect — messages lost during shutdown** — `apps/helix/src/platform/chat/routes.ts:105-117`. *Fix effort: M.*
- **[chat] Reactions visible only to actor who added (no realtime fanout, not in projection)** — `apps/web/src/features/chat/chat-shell.tsx:144-148`. *Fix effort: S.*
- **[chat] Thread panel decorative — replies go to room, not a thread** — `apps/web/src/features/chat/chat-shell.tsx:1049-1051`. *Fix effort: L.*
- **[chat] Pinned / Files / About tabs are static empty states; composer toolbar inert** — `apps/web/src/features/chat/chat-shell.tsx:1213-1219,949-992`. *Fix effort: M.*
- **[chat] `chatRealtimeUrl` puts access token in query string → logged** — `apps/web/src/features/chat/api.ts:273-281`. *Fix effort: M.*
- **[chat] `requireSocketRoomAccess` re-hits DB on every WS frame** — `apps/helix/src/platform/chat/routes.ts:182,238,250,267`. *Fix effort: S.*
- **[chat] Search ILIKE-only + permission subquery missing `org_id`** — `apps/helix/src/platform/chat/store.ts:544-572`. *Fix effort: M.*
- **[calendar] ICS parser regex `parseIcsDate` permissive; pins all-day to UTC** — `apps/helix/src/platform/calendar/routes.ts:803-846`. *Fix effort: M.*
- **[calendar] ICS unfolding O(n²) — 5 MB ICS pegs a core** — `apps/helix/src/platform/calendar/routes.ts:754-766`. *Fix effort: S.*
- **[calendar] RRULE expander caps at 3660 iterations, silently truncates** — `apps/helix/src/platform/calendar/recurrence.ts:40-78`. *Fix effort: M.*
- **[calendar] BYDAY weekly recurrence ignores timezone/DST** — `apps/helix/src/platform/calendar/recurrence.ts:140-161`. *Fix effort: M.*
- **[calendar] All-day events stored as `timestamptz`, lossy across user TZs** — `apps/helix/src/platform/calendar/store.ts:251-287`. *Fix effort: M.*
- **[calendar] CalDAV PUT inferred write target silently auto-creates default calendar** — `apps/helix/src/platform/calendar/routes.ts:380-382` + `store.ts:204-205`. *Fix effort: S.*
- **[calendar] CalDAV REPORT time-range parsed by regex over XML** — `apps/helix/src/platform/calendar/routes.ts:384-398`. *Fix effort: S.*
- **[calendar] Find-time returns `busy: []` always; ignores working hours** — `apps/helix/src/platform/calendar/store.ts:432-440,828-856`. *Fix effort: M.*
- **[calendar] RSVP token branch skips org isolation in update** — `apps/helix/src/platform/calendar/store.ts:336-341`. *Fix effort: S.*
- **[calendar] Frontend drag-to-create builds `…Z` ISO from local-clock input** — `apps/web/src/features/calendar/calendar-shell.tsx:307-316`. *Fix effort: S.*
- **[calendar] Grid uses UTC components for placement; cross-TZ users disagree** — `apps/web/src/features/calendar/data.ts:106-109`. *Fix effort: M.*
- **[calendar] `MiniMonth` hard-coded to May 2026** — `apps/web/src/features/calendar/calendar-shell.tsx:579-647`. *Fix effort: S.*
- **[calendar] Recurring events without window match pulled on every list** — `apps/helix/src/platform/calendar/store.ts:464-465`. *Fix effort: M.*
- **[calendar] RSVP URLs leak into mail body, IMAP, forwards** — `apps/helix/src/platform/calendar/ics.ts:247-260`. *Fix effort: M.*
- **[calendar] CardDAV vCard parser doesn't unfold lines; drops folded fields** — `apps/helix/src/platform/carddav/store.ts:317-337`. *Fix effort: S.*
- **[calendar] CardDAV picks first EMAIL ignoring TYPE — unpredictable RSVP routing** — `apps/helix/src/platform/carddav/store.ts:341-354`. *Fix effort: S.*
- **[ai] `maxToolRounds = 3` silently truncates with no signal** — `apps/helix/src/platform/assistant/orchestrator.ts:64,140`. *Fix effort: S.*
- **[ai] Streaming path loses tool calls from non-OpenAI-shaped providers** — `apps/helix/src/platform/assistant/orchestrator.ts:1003-1022`. *Fix effort: S.*
- **[ai] Provider fallback only on errors, not on hung/slow providers; no timeout/AbortController** — `apps/helix/src/platform/ai/routing.ts:303-323`. *Fix effort: M.*
- **[ai] Conversation history truncation is by message count, not tokens** — `apps/helix/src/platform/assistant/orchestrator.ts:65,135`. *Fix effort: M.*
- **[ai] `hashJson(request)` includes caller-supplied metadata (potential secret bleed)** — `apps/helix/src/platform/ai/routing.ts:521,931`. *Fix effort: S.*
- **[ai] Tool message outputs persisted + re-injected into context (PII / signed URLs leak)** — `apps/helix/src/platform/assistant/orchestrator.ts:194-202`. *Fix effort: M.*
- **[ai] Attachment / @mention buttons in composer have no handlers** — `apps/web/src/features/assistant/assistant-surface.tsx:1302-1310`. *Fix effort: M.*
- **[ai] No system-prompt customization / per-tenant persona** — `apps/helix/src/platform/assistant/orchestrator.ts:873-896`. *Fix effort: S.*
- **[ai] No conversation share/export/save** — `apps/helix/src/platform/assistant/tools.ts`. *Fix effort: M.*
- **[ai] AI Observability dashboard mostly hard-coded fake data** — `apps/web/src/features/admin/ai-observability.tsx:44-87`. *Fix effort: M.*
- **[ai] Memory recall has no opt-in check inside `PostgresMemoryStore.recall`** — `apps/helix/src/platform/ai/memory/postgres.ts:42-68`. *Fix effort: S.*
- **[admin] OAuth-app Block/Revoke has no confirmation gate** — `apps/web/src/features/admin/admin-console.tsx:1499-1537`. *Fix effort: S.*
- **[admin] Webhook signatures: single `v1` HMAC, no algo negotiation, no rotation grace** — `apps/helix/src/platform/webhooks/signatures.ts:3-78`. *Fix effort: M.*
- **[admin] Admin Overview tab is a "Telemetry not yet wired" placeholder** — `apps/web/src/features/admin/admin-console.tsx:253-285`. *Fix effort: S.*
- **[admin] No admin-driven session listing/revocation surface** — `apps/helix/src/platform/auth/better-auth.ts:314-375`. *Fix effort: M.*
- **[admin] SCIM/SAML/signup routes bypass tenant context middleware** — `apps/helix/src/platform/tenancy/middleware.ts:50-75`. *Fix effort: S.*
- **[admin] `admin-console.tsx` is 2,339 lines + `withPageScroll(Component)` violates rules of hooks** — `apps/web/src/features/admin/admin-console.tsx:2298-2302`. *Fix effort: L.*
- **[admin] Every admin mutation drops errors with `onError: () => undefined`** — `apps/web/src/features/admin/admin-console.tsx` (many). *Fix effort: M.*
- **[admin] App-password SQL leaks per-tenant existence (no tenant filter)** — `apps/helix/src/platform/auth/app-passwords.ts:281-298`. *Fix effort: S.*
- **[admin] Hash chain not surfaced or alerted on** — `apps/helix/src/platform/audit/verifier.ts`. *Fix effort: M.*
- **[admin] Webhook `compactHeaders` preserves vendor auth headers in plaintext** — `apps/helix/src/platform/webhooks/routes.ts:278-289`. *Fix effort: S.*
- **[admin] Audit-log UI lacks time-range, actor, object-id filters, no export** — `apps/web/src/features/admin/audit-log.tsx:79-200`. *Fix effort: M.*
- **[admin] BetterAuth session cookie options not explicitly set Secure/SameSite/HttpOnly** — `apps/helix/src/platform/auth/better-auth.ts:437-444`. *Fix effort: S.*
- **[admin] SOPS adapter shells out per `get()` with no cache; 30s hangs the request** — `apps/helix/src/platform/secrets/sops.ts:94-106`. *Fix effort: S.*
- **[admin] Plugin admin routes lack defense-in-depth `canAdminPlugins` at route boundary** — `apps/helix/src/platform/plugins/admin-routes.ts:42-144`. *Fix effort: S.*
- **[docs] OnlyOffice removal punch list — backend routes, frontend route, env, compose, types still wired** — see Docs review "OnlyOffice removal audit" section. *Fix effort: L (audit-driven).* 

### 🟢 LOW (polish / quality)

- **[mail] `mail-shell.tsx` is 2,709-line monolith with 12 mutations + URL echo loop** — `apps/web/src/features/mail/mail-shell.tsx:1-2709`. *Fix effort: L.*
- **[mail] Vacation metadata `Record<string, unknown>` accepted unbounded** — `apps/helix/src/platform/mail/tools.ts:128-143`. *Fix effort: S.*
- **[mail] `MailSendService` instantiated twice per `mail.send` request** — `apps/helix/src/platform/mail/tools.ts:230-276`. *Fix effort: S.*
- **[mail] Admin provider zod uses `nullish()` allowing per-kind required fields to slip** — `apps/web/src/features/admin/mail-admin-api.ts:35-43`. *Fix effort: S.*
- **[mail] PAGE_SIZE hard-coded to 50; no keepPreviousData** — `apps/web/src/features/mail/mail-shell.tsx:2193`. *Fix effort: S.*
- **[mail] `evaluateInboundMail` runs vacation before spam routing → auto-reply to spammers** — `apps/helix/src/platform/mail/filters.ts:9-46`. *Fix effort: S.*
- **[mail] `mail_thread_state` upsert clobbers concurrent label adds (no row lock)** — `apps/helix/src/platform/mail/store.ts:520-558`. *Fix effort: S.*
- **[drive] `delete` does S3 deletes inside Postgres transaction** — `apps/helix/src/platform/drive/store.ts:795-850`. *Fix effort: S.*
- **[drive] PROPFIND XML parser is regex-based, fragile against namespaces** — `apps/helix/src/platform/drive/routes.ts:654-669`. *Fix effort: S.*
- **[drive] Metadata from API JSON-merged without allow-list** — `apps/helix/src/platform/drive/store.ts:351-372`. *Fix effort: S.*
- **[drive] No realtime/SSE updates; UI stale until manual refetch** — `apps/web/src/features/drive/drive-shell.tsx`. *Fix effort: M.*
- **[drive] `notifyDriveCommentMentions` resolves recipients by display-name substring; client-controlled mentionsText** — `apps/helix/src/platform/drive/store.ts:1798-1957`. *Fix effort: M.*
- **[drive] Storage-key validation only at finalize override, not prepare path** — `apps/helix/src/platform/drive/store.ts:2180-2203`. *Fix effort: S.*
- **[drive] `formatLabelFromEntry` renders user-set `originalFormat` with no allow-list** — `apps/web/src/features/drive/drive-data.ts:98-108`. *Fix effort: S.*
- **[drive] `app` filter uses `coalesce(... = null)` and no index on `(org_id, metadata->>'app')`** — `apps/helix/src/platform/drive/store.ts:554`. *Fix effort: S.*
- **[drive] Starred/Recent use client-side filter + ILIKE, no indexes** — `apps/helix/src/platform/drive/store.ts:851-883`. *Fix effort: M.*
- **[drive] `drive-shell.tsx` 1,941 LOC + backend `store.ts` 2,460 LOC mixing 6+ concerns** — `apps/web/src/features/drive/drive-shell.tsx` + `apps/helix/src/platform/drive/store.ts`. *Fix effort: M.*
- **[docs] Two oversized monolithic frontend files (1951 + 1730 LOC)** — `apps/web/src/features/docs/native-document-editor.tsx`, `native-document-shell.tsx`. *Fix effort: L.*
- **[docs] `legacy-yjs` engine + migration UI still in production type unions** — `apps/web/src/features/docs/api.ts:75`. *Fix effort: M.*
- **[docs] Comment notifications only on `@mention` (not on replies, owner, resolve)** — `apps/helix/src/platform/docs/store.ts:1985-2064`. *Fix effort: M.*
- **[docs] No optimistic concurrency on title/layout/comment edits** — `apps/helix/src/platform/docs/store.ts`. *Fix effort: M.*
- **[docs] `escapePdfText` strips non-ASCII to `?`** — `apps/helix/src/platform/docs/export/formats.ts:417-419`. *Fix effort: M.*
- **[docs] `// TODO v1` stubs for Share/Rename/Smart compose ship as dead chrome** — `apps/web/src/features/docs/native-document-shell.tsx:23,428-441,533-536`. *Fix effort: S.*
- **[docs] `nativeDocumentSelectionFromAnchor` accepts negative indices → editor crash** — `apps/web/src/features/docs/native-document-anchors.ts:47-71`. *Fix effort: S.*
- **[docs] Yjs awareness encoder swallows generic Error** — `apps/helix/src/platform/docs/routes.ts:383-393`. *Fix effort: S.*
- **[docs] DOCX export comment IDs not stable across exports** — `apps/helix/src/platform/docs/export/formats.ts:421-426`. *Fix effort: S.*
- **[docs] Export endpoint has no per-org bytes/day cap or page-count cap** — `apps/helix/src/platform/docs/tools.ts:446-499`. *Fix effort: M.*
- **[docs] `markdownFromPlainText`/`textFromHtml` strip structure on legacy-HTML exports** — `apps/helix/src/platform/docs/export/formats.ts:170-211`. *Fix effort: M.*
- **[docs] Editor lazy-loaded → CLS on first open** — `apps/web/src/features/docs/native-document-shell.tsx:81-85`. *Fix effort: S.*
- **[sheets] 9,318-line editor component** — `apps/web/src/features/sheets/native-spreadsheet-editor.tsx`. *Fix effort: L.*
- **[sheets] Formula reference regex collides with letter-tab names** — `apps/helix/src/platform/sheets/formula.ts:1371-1372`. *Fix effort: S.*
- **[sheets] Arithmetic parser accepts `1..5` / `.` as numbers** — `apps/helix/src/platform/sheets/formula.ts:1348-1358`. *Fix effort: S.*
- **[sheets] `seed.ts` mis-named (now pure helpers)** — `apps/web/src/features/sheets/seed.ts`. *Fix effort: S.*
- **[sheets] `QUERY` cap 5k cells but no per-tab evaluation budget** — `apps/helix/src/platform/sheets/formula.ts:342-349`. *Fix effort: S.*
- **[sheets] `formulaCellReferencePattern` is `/giu` with potential lastIndex bug** — `apps/helix/src/platform/sheets/formula.ts:278,1371`. *Fix effort: S.*
- **[sheets] Aggregate `args.split(",")` mishandles nested commas / nested calls** — `apps/helix/src/platform/sheets/formula.ts:259-277`. *Fix effort: S.*
- **[slides] 7,476-line editor component + circular import with inspector** — `apps/web/src/features/slides/native-presentation-editor.tsx`. *Fix effort: L.*
- **[slides] `awareness.selectedShapeId` accepts up to 120 chars w/o regex** — `apps/helix/src/platform/slides/routes.ts:99`. *Fix effort: S.*
- **[slides] `presentation-ai.ts` is canned-template marketed as AI** — `apps/web/src/features/slides/presentation-ai.ts:13-82`. *Fix effort: S.*
- **[slides] PPTX import is text-only by design; UI doesn't disclose** — `apps/helix/src/platform/slides/import-pptx.ts:36-39`. *Fix effort: S.*
- **[slides] `seed.ts` mis-named (now types+converters)** — `apps/web/src/features/slides/seed.ts:1-9`. *Fix effort: S.*
- **[slides] PresentationMode caption transcripts in localStorage cross-tenant** — `apps/web/src/features/slides/native-presentation-editor.tsx:2794-2854`. *Fix effort: S.*
- **[slides] Animation/transition panels unwired** — `apps/web/src/features/slides/native-presentation-chrome.tsx:372-378`. *Fix effort: M.*
- **[slides] Slide thumbnail rail re-renders full slide on every keystroke** — `apps/web/src/features/slides/slide-thumbnail-rail.tsx`. *Fix effort: S.*
- **[meet] `store.ts` 1.2k lines, three concerns; jsonb shuttled via `JSON.parse(JSON.stringify(...))`** — `apps/helix/src/platform/meet/store.ts`. *Fix effort: M.*
- **[meet] Webhook payload typing uses `z.passthrough()` and 14 aliased shapes** — `apps/helix/src/platform/meet/routes.ts:8-66`. *Fix effort: S.*
- **[meet] Recording-attached notifications can't be opted out, no body** — `apps/helix/src/platform/meet/store.ts:544-580`. *Fix effort: S.*
- **[meet] `meet.create-room` activity hash not chained to prior hash** — `apps/helix/src/platform/meet/store.ts:1045-1051`. *Fix effort: S.*
- **[chat] Typing indicator absent from thread reply composer** — `apps/web/src/features/chat/chat-shell.tsx:1086-1103`. *Fix effort: S.*
- **[chat] Presence TTL only server-side; UI never expires entries** — `apps/helix/src/platform/chat/realtime.ts:153-167`. *Fix effort: S.*
- **[chat] Read-count UI undercounts when messages arrive between reloads** — `apps/web/src/features/chat/view-model.ts:222-243`. *Fix effort: S.*
- **[chat] WS schema lets `presence` frame probe room existence without subscribe** — `apps/helix/src/platform/chat/routes.ts:268-269`. *Fix effort: S.*
- **[calendar] CalDAV basic-auth comparison short-circuits, leaking email existence via timing** — `apps/helix/src/platform/calendar/routes.ts:251-267`. *Fix effort: S.*
- **[calendar] ICS CANCEL exdates not propagated; clients un-cancel on round-trip** — `apps/helix/src/platform/calendar/ics.ts:143-145`. *Fix effort: M.*
- **[calendar] ICS attendee parser drops non-mailto schemes silently** — `apps/helix/src/platform/calendar/routes.ts:965-980`. *Fix effort: S.*
- **[calendar] CardDAV `parseBasicAuthorization` duplicated, unbounded length** — `apps/helix/src/platform/carddav/routes.ts:517-533`. *Fix effort: S.*
- **[calendar] CardDAV REPORT body parsed with same XML-regex pattern** — `apps/helix/src/platform/carddav/routes.ts:450-457`. *Fix effort: S.*
- **[calendar] `calendar-shell.tsx` 1819 LOC; routes.ts/store.ts 1k+ each; ICS parsing in routes.ts** — refactor. *Fix effort: L.*
- **[ai] AI cost-limits admin UI accepts any UUID actor without existence check** — `apps/web/src/features/admin/ai-cost-limits-management.tsx:302-324`. *Fix effort: S.*
- **[ai] `routing.ts` duplicates ~400 lines between `#chat` and `#chatStream`** — `apps/helix/src/platform/ai/routing.ts:210-330,431-570`. *Fix effort: M.*
- **[ai] `parseEmbeddingResponse` rejects size mismatch with `TypeError`, no retry** — `apps/helix/src/platform/ai/embeddings/openai-compatible.ts:92-106`. *Fix effort: M.*
- **[ai] `assistantToolPendingId` heuristic match-by-toolId is ambiguous** — `apps/web/src/features/assistant/api.ts:422-431`. *Fix effort: S.*
- **[ai] `AICostLimitExceededError.reason` always reports `actor_daily_cost` when allowed** — `apps/helix/src/platform/ai/costs/redis-limiter.ts:246-249`. *Fix effort: S.*
- **[ai] No tests on provider fallback ordering × classification matrix** — `apps/helix/src/platform/ai/routing.test.ts`. *Fix effort: M.*
- **[ai] SSE has no heartbeat/keepalive; idle proxies drop connection** — `apps/web/src/features/assistant/api.ts:192-223`. *Fix effort: S.*
- **[admin] `setOAuthAppStatus(id, 'pending')` unreachable but typed** — `apps/web/src/features/admin/oauth-apps-api.ts:1-211`. *Fix effort: S.*
- **[admin] Activity log payload column unbounded JSON, no PII redaction** — `apps/helix/src/platform/audit/store.ts:64-74`. *Fix effort: S.*
- **[admin] Three `isAdmin?` predicates coexist with different semantics** — `apps/helix/src/platform/admin/console-shared.ts:28` + `plugins/admin-routes.ts:146` + `audit/routes.ts:98`. *Fix effort: S.*
- **[admin] Tenant lifecycle delete lacks confirmation token / grace** — `apps/helix/src/platform/tenancy/lifecycle-routes.ts`. *Fix effort: M.*
- **[admin] `BetterAuthApiSessionVerifier.getSessionUser` no per-request cache** — `apps/helix/src/platform/auth/better-auth.ts:391-402`. *Fix effort: S.*
- **[admin] `providerSignatureHeaders` only maps 3 providers (GitLab etc. fall through)** — `apps/helix/src/platform/webhooks/routes.ts:39-43`. *Fix effort: S.*
- **[admin] Tenant export/import migrations deleted but code paths still reference tables** — gitStatus shows `D apps/helix/src/db/migrations/0055..0058_tenant_*.sql`. *Fix effort: S.*

## Cross-cutting themes

**1. Tenant scoping is opt-in instead of structural.** The pgvector store has no `org_id` at all (A1). The SMTP receiver pins to one env-configured org (mail S2). SCIM/SAML metadata + signup bypass the tenancy middleware (P2). Chat permission subqueries omit `org_id` (C4, C15). Drive `share` doesn't validate target actor's org (drive S11). Calendar RSVP token branch skips org isolation (CAL12). App-password verify scans across tenants (P2). The right fix is a structural one: every internal store method takes `orgId`, and there's a lint rule (or builder pattern) that prevents calling without it. A single missed call leaks across tenants today.

**2. Stubs presented as features in the chrome.** Slides chrome has 43+ inert TODO menu items (SL5). Docs has `// TODO v1` Share/Rename/SmartCompose buttons (S16). Chat has inert Bold/Italic/Link/Code/Paperclip/Smile/Sparkles + Pinned/Files static empty states (C12). Assistant has fake model selector (A15), inert Paperclip/Doc/Users buttons (A16), unwired pending-confirmation UI (A14). Admin has fake Billing CTAs (P1 billing), placeholder Overview (P1), `mailto:sales@helix.example` upgrade link, decorative "Summary" button in Meet hub (M10), unwired AI observability metrics (A19), drive share dialog as a UUID textbox (drive S17). The PRD reads "shipped" — the UI behaves "shipped" — the click is a no-op. Either hide the affordance or wire it.

**3. Oversized monoliths.** `admin-console.tsx` 2,339 LOC. `mail-shell.tsx` 2,709 LOC. `drive-shell.tsx` 1,941 LOC + Drive `store.ts` 2,460 LOC. Docs `native-document-editor.tsx` 1,951 + `native-document-shell.tsx` 1,730. Sheets `native-spreadsheet-editor.tsx` 9,318 LOC + `store.ts` 4,943. Slides `native-presentation-editor.tsx` 7,476. Meet `store.ts` 1.2k. Calendar `calendar-shell.tsx` 1,819 + `routes.ts` 1,016 + `store.ts` 1,033. Chat `store.ts` 964. AI `routing.ts` 1,127 + `orchestrator.ts` 1,022 (with ~400 LOC duplicated between streaming and non-streaming paths). These files are at the point where code review can't catch bugs and codegen-assisted refactors are dangerous.

**4. Unsanitized/unvalidated content piped to powerful renderers.** Docs Chromium PDF renderer trusts `document.html` and waits for `networkidle` (Docs S1, SSRF). Mail HTML bodies stored verbatim (mail S9). Slides URL fields accept any scheme (SL4). Drive trusts client MIME type and preview inlines `text/html` (drive S1). DOCX import has no zip-bomb guard (Docs S4). PPTX import doesn't disable XML entities or cap zip expansion (SL7). DMARC reports parsed by regex over XML (mail S10). CalDAV REPORT time-range and PROPFIND XML parsed by regex (CAL9, drive S23). ICS unfolding O(n²) (CAL4). Webhook headers stored in plaintext (P2). The pattern is consistent: untrusted bytes traverse a Chromium / XML / image / archive engine with no narrowing step.

## Fix-wave proposal

Each wave is one parallelizable PR per area (10 areas × 4 waves = up to 40 sub-PRs, each independently mergeable).

### Wave 1 — Critical security (the 6 CRITICAL items)
1. **[ai]** Add `org_id` to `vector_collections`/`vector_items` and to `VectorStore` interface; backfill + tests.
2. **[admin]** SCIM: require per-tenant SCIM bearer token; identical 401 for unknown/bad-token; remove stub PUT/PATCH/DELETE until implemented.
3. **[admin]** OAuth `/authorize`: add `allowed_redirect_uris` allowlist, exact-match check, reject `code_challenge_method=plain`.
4. **[mail]** Gate `mail.inbound.accept` behind `mail.bridge.write` admin scope + service-actor requirement; route through real `MailauthAuthenticator`; remove `trustedBridge:true`.
5. **[slides]** Migrate slide editing to per-shape ops (`update-shape`/`delete-shape`/`reorder-shape`) so concurrent edits no longer wipe each other.
6. **[docs]** Sanitize `document.html` before Chromium; switch to `domcontentloaded`; configure `page.route('**', r => r.abort())` and sandbox args.

### Wave 2 — Correctness + RBAC tightening
- **[admin]** Plugin sandbox (worker thread / Node permission model) + enforce declared permissions; defense-in-depth `canAdminPlugins` at route boundary.
- **[admin]** API keys argon2id, app-password parallel verify + label-prefixed username, MFA header → BetterAuth-AAL or HMAC, audit appends in same tx, immutable trigger on `activity`, narrow `admin.users` scope.
- **[admin]** IP allowlist enforcement for agent credentials; agent rate-limit (RPS + concurrency) per tenant.
- **[mail]** Per-message org resolution from `RCPT TO` in SMTP receiver; sanitize HTML bodies; register `mail.spam`/`mail.filter.list`; unify admin REST contracts via shared zod; fix outbox race + Drafts/Sent predicates + pager total + ILIKE escaping + disabled-actor alias.
- **[drive]** Server-side MIME sniff + `X-Content-Type-Options: nosniff`; streaming `getStream(key, {range})`; per-org-allowlist storage-key validation; share-org validation; role enum unification.
- **[docs]** Comment/suggestion anchors → `Y.RelativePosition`; quota TOCTOU fix via reserve-then-check; DOCX import zip-bomb guard via worker_thread.
- **[sheets]** Sync client handles `compacted`/`dropped`/`duplicate`/`reconnectRequired`; server-side cell-bounds enforcement; optimistic-grid rollback on rejection.
- **[slides]** Op-log compaction; cross-node fanout for `slides.sync`; URL scheme allowlist on content/media URLs; PPTX import processEntities=false + zip cap.
- **[meet]** Webhook HMAC + timestamp + replay table + `uploadId↔(orgId,roomId)` binding; gate `mock-recorder` on `NODE_ENV` + admin scope; recording ACL via joined permissions; moderator bit derived from `meet_room` `owner/admin` perm; remove header `orgId` trust.
- **[chat]** Per-connection rate limit; classification on WS `send` path; attachment ownership/scan; `org_id` filter in edit/delete/search subqueries; monotonic `seq` for ordering; reactions in projection + bus.
- **[calendar]** RSVP POST + confirmation page + rate-limit; ICS parser swap to `ical.js`; RRULE timezone correctness; all-day storage; CalDAV write target validation + XML REPORT via real parser; org-scoped RSVP update; frontend TZ-aware date construction.
- **[ai]** Classification computed server-side (ignore client value); per-tenant rate limit + concurrency cap; cost reservation finally-record; provider timeout + AbortController; memory recall opt-in check.

### Wave 3 — Feature gaps + stubs
- **[admin]** Replace Admin Overview placeholder with `security-tier-readiness` + last-10-audit; sessions list/revoke surface; audit-log filters + NDJSON export; 2FA enrollment (BetterAuth twoFactor); real SAML ACS or remove option; hide fake billing CTAs.
- **[mail]** Bulk-action transactional fan-out; provider retry classification with transient/permanent + delivery_attempts; BCC per-recipient transport; DMARC parser swap.
- **[drive]** Virus scanning hook in finalize/WebDAV PUT; public/anonymous share links + tokenized `/d/:token`; rename/copy/duplicate + WebDAV MOVE/COPY; chunked + drag-and-drop folder uploads; real share dialog with people picker + role.
- **[docs]** Populate `EditorAppBar` presence; ship comment notifications for replies/owner/resolve; optimistic concurrency on title/layout/comment; per-org export bytes/page cap; OnlyOffice removal audit punch list.
- **[sheets]** Wire toolbar font/size/underline/strikethrough/wrap/merge/valign to existing `format`; charts/pivots zod validation; presence/awareness frames.
- **[slides]** Implement presentation-chrome menu items (or hide); PPTX export Drive-image fetcher; undo/redo (op-log inverses); transitions/animations panels.
- **[meet]** Implement scheduled→active transition; calendar integration on schedule; pre-call device picker + lobby moderation + breakout-room controls; Helix branding via `dynamicBrandingUrl`; AI summary producer + transcript pipeline.
- **[chat]** Real thread model (`parent_id`); attachment + emoji + formatting toolbar; pinned/files tabs; backfill-on-reconnect with `since` cursor.
- **[calendar]** Find-time working hours + per-attendee busy detail; `MiniMonth` driven by `state.date`; CardDAV PREF/TYPE handling; vCard line unfolding.
- **[ai]** Wire pending-confirmation UI; real model selector (load from providers + pass `metadata.model`); attachment/@mention buttons; per-tenant system prompt; conversation share/export; per-tool `redactOutput` hook; AI observability live data.

### Wave 4 — Code quality + decomposition
- **[admin]** Split `admin-console.tsx` per section; replace `withPageScroll(Component)` with proper child render; project-wide mutation error sink; centralize scope catalog; consolidate `parseBasicAuthorization`.
- **[mail]** Split `mail-shell.tsx` per concern; replace bidirectional URL sync with router search.
- **[drive]** Split `store.ts` into comments/PDF-form/search-projection/audit modules; split `drive-shell.tsx`; promote `starred` to per-actor table + pg_trgm index; metadata key allow-list; SSE drive updates.
- **[docs]** Split editor + shell into composable modules; drop `legacy-yjs` engine + migration UI; OnlyOffice removal cleanup; lazy-load CLS fix.
- **[sheets]** Split editor into `grid/`/`model/`/`inspectors/`/`clipboard/`/`controller/`; share OT/rebase package between client+server; rename `seed.ts`; per-tab evaluation budget; incremental formula re-eval.
- **[slides]** Split editor; rename `seed.ts`; thumbnail rail memoization; awareness shape-id regex; rename `presentation-ai`.
- **[meet]** Split `store.ts` into `store-postgres`/`store-in-memory`/`store-projections`/`store-helpers`; strict webhook payload schema; refresh stale E2E spec; chained audit hash.
- **[chat]** Cache room-access in subscriptions map; presence heartbeat; thread reply composer typing; Zod schema for WS frames on client.
- **[calendar]** Split `calendar-shell.tsx` (sidebar/week/popover/dialog); lift ICS read/write into `calendar/ics.ts`; consolidate duplicated helpers across CalDAV/CardDAV; cache `getSessionUser` per request.
- **[ai]** Extract shared `#executeAttempt` between `#chat`/`#chatStream`; fallback ordering tests; SSE heartbeat; provider tool-call serialization parity; conversation history by token budget; `hashJson` allow-list.

## Out-of-scope / acknowledged-but-deferred

- **Full OOXML parity** for Sheets (XLSX read/write) and Slides (PPTX visual round-trip beyond data-URI images, animations, transitions, masters). Current scope is first-pass text + native format.
- **Live presentation broadcast / Meet streaming to non-attendees** (no producer pipeline exists).
- **Real-time billing/invoicing flow** (Stripe integration deferred; current admin surface is mailto/contact-sales).
- **Native mobile apps** (Drive uploader, Mail composer, Chat client, Calendar). Mobile DnD folder upload, mobile camera capture, push notifications.
- **AI/Assistant tier-2 features**: voice mode, screenshare understanding, multi-agent collaboration, fine-tuned tenant models.
- **CardDAV write CRUD** beyond the read pipeline used for calendar attendee resolution.
- **CalDAV journals / scheduling outbox** (only event collections are exposed).
- **SAML JIT provisioning + advanced attribute mapping** (out-of-scope until ACS lands).
- **SCIM groups + nested groups + advanced filters** (deferred until base CRUD ships).
- **Tenant hard-delete / GDPR-grade erasure** UX (lifecycle hooks exist; admin UX deferred).
- **Plugin marketplace + signature verification chain** (loader exists; marketplace/store deferred).
- **Full DLP / content-moderation pipeline** (virus scan is the first step; classification-based redaction deferred to a later AI/governance wave).
- **Cross-region replication / multi-region failover** for storage and Postgres.
