# Mail — Senior Review

## Summary
Helix Mail has a well-structured outbound pipeline (queue + undo + pluggable providers + dispatcher span tracing) and a solid admin surface for DKIM/DMARC/routing, but several pieces are inconsistent across the trust boundary: the SMTP receiver is hard-bound to one org from env, the inbound `mail.spam` and `mail.filter.list` tools are called from the UI but never registered in the backend, the admin REST surface drifts noticeably from what the frontend client expects (missing `/spam`, `/set-default`, `/dkim/rotate`, different `dmarc` shape), and `mail.inbound.accept` is a tool exposed to actors that completely fakes SPF/DKIM/DMARC results. Search is implemented with `ilike '%query%'` rather than the FTS index, DMARC XML is parsed by regex, and the frontend mail-shell is a 2.7k-line single component. Nothing leaks secrets to clients and outbound provider credentials use indirection via env-var refs.

## Scorecard
- Security: 2/5 — fake auth on a tool-exposed ingest path, single-tenant SMTP receiver, no HTML sanitization before persistence, vacation-reply loop weakness.
- Correctness: 3/5 — drafts/sent folder predicates broken; thread `total` only reflects one page; admin REST contract mismatch with the React client.
- Feature completeness: 3/5 — spam/filter-list/vacation tools or UIs called but not implemented; no attachment download surface; HTML bodies persisted but rendered as plain text only.
- Code quality: 3/5 — clear module boundaries on the backend; `mail-shell.tsx` is a 2,709-line monolith; some giant tagged-template SQL queries are hard to maintain.

## Findings

### S1: `mail.inbound.accept` tool fakes SPF/DKIM/DMARC, lets any actor with `mail.write` inject "trusted" inbound mail · severity: CRITICAL · category: security
**File**: `apps/helix/src/platform/mail/tools.ts:313-348,713-726`
**What's wrong**: The tool synthesizes an RFC822 from a JSON body and ingests it with a `trustedInboundAuthenticator` that returns `{spf:"none", dkim:"none", dmarc:"none"}` plus an unconditional `trustedBridge: true` in evidence. The `mail.write` scope is held by every regular user (it grants write on their own mailbox), so any user can fabricate "from: ceo@victim.com" mail addressed to any actor in their org with no header authentication and a payload that downstream filter/vacation/classification handlers treat exactly like inbound SMTP. There is no IP allowlist, no service-account requirement, and no DKIM/SPF verification skip — verification is faked as "none" which the rest of the pipeline accepts.
**Fix**: Either (a) gate the tool behind a dedicated `mail.bridge.write` admin scope and require an internal service-account principal, or (b) keep the tool but route through a real verifier that actually validates a signed bridge token instead of stamping `trustedBridge: true`. Drop the synthesized RFC822 path and accept only raw RFC822 to be authenticated by `MailauthAuthenticator`. At minimum, refuse calls when `ctx.actor.kind !== "service"`.
**Effort**: M

### S2: SMTP receiver is single-tenant and pinned to one env-configured org · severity: HIGH · category: security
**File**: `apps/helix/src/platform/mail/ingest.ts:90-126`, `apps/helix/src/server.ts:1717-1728`
**What's wrong**: `SmtpMailReceiver` takes a fixed `orgId` constructor option which `server.ts` resolves once from `smtpMailReceiverConfig.orgId` (env `HELIX_DEFAULT_ORG_ID`). Every inbound RFC822 — regardless of `RCPT TO` domain — is stamped with this single org. In a multi-tenant deployment this means mail addressed to tenant B is silently filed under tenant A's actors (or dropped if no matching actor exists), and `findActorByAddress` operates inside the wrong tenant scope.
**Fix**: Resolve org per-message from `session.envelope.rcptTo[0]` via a lookup against `mail_sending_domains` (which already has `org_id` on every row). Pass that resolved orgId into `ingestRawMail` instead of the constructor's value. Reject the message at SMTP DATA time with a 550 when the recipient domain belongs to no tenant.
**Effort**: M

### S3: Frontend calls `mail.spam` and `mail.filter.list`, neither exists in `createMailToolDefinitions` · severity: HIGH · category: missing
**File**: `apps/web/src/features/mail/api.ts:330-335,394-403` · `apps/helix/src/platform/mail/tools.ts:248-647`
**What's wrong**: `spamMailThread` calls tool id `mail.spam` and `listMailFilters` calls `mail.filter.list`, but the tool registry only defines `mail.filter.{create,update,delete}` and no `mail.spam`. The UI bulk "Report spam" button (`mail-shell.tsx:906`) and the row-level spam handler will return tool-not-found at runtime. There is `mail_thread_state.spam_at` plumbing in `store.ts:520-557` and `listFolders`/`listThreads` honor it, so the missing piece is purely the surfaced tool.
**Fix**: Add a `mail.spam` tool that calls `store.updateThreadState({ patch: { spamAt: new Date() } })` and a `mail.filter.list` tool that returns `store.listFilters(orgId, actorId)`. Register both in `createMailToolDefinitions`.
**Effort**: S

### S4: Admin REST contract mismatch — React client hits routes the backend doesn't expose · severity: HIGH · category: bug
**File**: `apps/web/src/features/admin/mail-admin-api.ts:300-309,356-365,432-437` · `apps/helix/src/platform/mail/admin-routes.ts:259-277`
**What's wrong**: The frontend posts to `/api/admin/mail/providers/:id/set-default`, `/api/admin/mail/sending-domains/:id/dkim/rotate`, and gets `/api/admin/mail/spam` and `/api/admin/mail/dmarc` (singular, with a `{summary, reports}` shape carrying `dmarcPassRate`/`spfPassRate`). The backend exposes `PATCH /providers/:id` (with `isDefault` in the body) instead of `set-default`, `POST /dkim/:keyId/retire` instead of `dkim/rotate`, no `/spam` route at all, and `/dmarc/reports` + `/dmarc/summary?domain=…` (separate endpoints, different field names). All five mail-admin tabs will surface "malformed response" or 404 against a real backend.
**Fix**: Either (a) ship missing routes (`POST /providers/:id/set-default`, `POST /sending-domains/:id/dkim/rotate`, `GET /spam`, `GET /dmarc` aggregating summary+reports across all domains) or (b) rewrite the React client to use the backend's shapes. Add a shared zod schema package re-exported from `@helix/sdk-types` so this can't drift again.
**Effort**: L

### S5: Outbound payload race — outbox row carries `mailOutboundId: ""` between insert and update · severity: HIGH · category: bug
**File**: `apps/helix/src/platform/mail/store.ts:355-390`
**What's wrong**: `createOutbound` inserts the outbox row first with `{mailOutboundId: ""}`, then inserts the `mail_outbound_messages` row, then UPDATEs the outbox payload to fix the id. If a worker picks up the outbox event between the first insert and the update, `dispatchOutboxPayload` calls `mailOutboxPayloadSchema` which accepts `""` as a valid string and then calls `dispatch("")` — `markOutboundSending` will silently not find a row and the message is never sent. The `deliver_after` clause on the outbox lessens the window but does not close it because the worker also subscribes to direct event publishes.
**Fix**: Defer the outbox insert until after `mail_outbound_messages` is created, so the payload is correct on first write. Alternatively, insert both inside the same `sql.begin` (already happens) and reorder: insert mail_outbound_messages with `outbox_id=null`, then insert the outbox row with the real id, then update mail_outbound_messages.outbox_id.
**Effort**: S

### S6: `total` returned from `listThreads` is per-page, not per-result-set · severity: HIGH · category: bug
**File**: `apps/helix/src/platform/mail/store.ts:969-985`
**What's wrong**: The query uses `count(*) over ()::int as total` which counts the windowed rows AFTER `limit` and `offset` are applied. Postgres window functions over `filtered` would normally see the whole filtered set, but with `limit ${limit} offset ${offset}` applied at the outer level the count is restricted to the returned page. The result is that `total` always equals the page size (or fewer on the last page), breaking the pager in `mail-shell.tsx:522-563` which uses `offset + limit >= total` to disable the "Older" button.
**Fix**: Compute the count separately, e.g. wrap the projection in `select t.*, (select count(*) from filtered) as total from filtered t limit ${limit} offset ${offset}`, or use a `with filtered as (...) select ..., (select count(*) from filtered) as total from filtered ... limit ... offset ...`. Verify with a >50-thread fixture.
**Effort**: S

### S7: `drafts` folder selects sent messages and `sent` folder selects nothing useful · severity: HIGH · category: bug
**File**: `apps/helix/src/platform/mail/store.ts:944-960`
**What's wrong**: The `case ${folder}` branch reads `has_outbound = 'outbound'` and `outbound_status = 'queued'` from columns computed on the latest *message* row, but `has_outbound` is the literal string `'outbound'` from `messages.metadata->>'direction'` of the most-recent outbound message in the thread — fine — yet the `drafts` predicate `outbound_status = 'queued'` only includes threads whose latest outbound row is still queued (i.e. inside the undo window). After the undo window expires, the row flips to `sending`/`sent` and the thread drops out of Drafts but never enters Sent because the `sent` predicate also requires `has_outbound = 'outbound'`, which is true only if any outbound message exists. Worse, queued drafts also show up in Sent under the current predicate. There is no true draft concept in the schema — `queued` is "send in flight" not "saved draft".
**Fix**: Either model drafts as a distinct row state (`status = 'draft'`) so `queued` no longer doubles as Drafts, or change the predicates: Drafts = `outbound_status = 'queued' and undo_until > now()`, Sent = `outbound_status in ('sent','sending')`. Cover with a test in `mail.test.ts` that creates one queued + one sent thread and asserts each appears in exactly one folder.
**Effort**: M

### S8: Free-text search uses `ilike '%query%'` and ignores SQL metacharacters · severity: HIGH · category: bug
**File**: `apps/helix/src/platform/mail/store.ts:723-750,963-967`
**What's wrong**: `search` and `listThreads` both build the predicate as `subject ilike ${`%${query}%`}` without escaping `%` and `_`. A user query containing `%` matches everything and `_` matches any single char. Worse, the schema appears to support FTS (a parallel `mail_search_record` projection feeds the search indexer in `search/indexer.ts`), but the store falls back to per-message wildcard ilike across all rows in the org — this is O(messages) per search and will not scale past a few thousand messages.
**Fix**: At minimum escape `%`, `_`, `\` in the user query before splicing. Long-term: route `mail.search` through the FTS-backed `SearchEventIndexer` already wired up via `mailRecordToIndexDocument`, and remove the in-store ilike scan.
**Effort**: M

### S9: HTML mail bodies are stored verbatim with no sanitization · severity: HIGH · category: security
**File**: `apps/helix/src/platform/mail/ingest.ts:236-237` · `apps/helix/src/platform/mail/store.ts:1149-1162`
**What's wrong**: `simpleParser` returns the inbound HTML and `parsedMailToMessage` stores it untouched as `bodyHtml`, which `insertMailMessage` writes into `messages.body` with `body_format = 'html'`. The shell currently renders bodies via `<div style={{ whiteSpace: "pre-wrap" }}>{message.body}</div>` (mail-shell.tsx:1526-1530), which is safe today, but the type system already exposes `bodyFormat: "html"` to the UI and the persistence layer trusts whatever the remote sender provided. Any future "Render as HTML" toggle (the design hands off an HTML body field) will inject attacker-controlled `<script>` directly into the workspace document.
**Fix**: Sanitize HTML at ingest time with `sanitize-html` or `DOMPurify (jsdom)` allowlisting a safe subset (no `<script>`, no `on*` attributes, no `javascript:` URLs, no `<iframe>` except sandboxed). Store both the sanitized HTML and a fingerprint of the original so admins can diff. When the UI eventually renders HTML it must do so via a sandboxed iframe per Gmail-class isolation, not raw inner-HTML injection.
**Effort**: M

### S10: DMARC aggregate parser uses regex over XML — vulnerable to attribute-injection and XXE-like spoofing · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/mail/dmarc.ts:28-126`
**What's wrong**: `parseDmarcAggregateReport` does `<tag>…</tag>` regex extraction with no XML parser. It blindly accepts `<tag attr="..."/>` as long as the closing tag exists, doesn't reject CDATA splitting, doesn't normalize entities beyond five hard-coded ones, and `tagText` strips `<[^>]*>` so embedded `<![CDATA[`/`<!ENTITY` payloads are passed through unparsed. A malicious DMARC report POSTed via `POST /api/admin/mail/dmarc/reports` (an admin-only endpoint, so blast radius is contained) can spoof `<report_id>`, `<domain>`, or `<source_ip>` to poison the summary, and very large reports (5MB cap) with deeply nested or backtracking-prone tags can stall the event loop.
**Fix**: Use a real XML parser (`fast-xml-parser`, configured with `parseTagValue: false`, `processEntities: true`, no DTD support) and validate the document shape with zod. Add a size-bounded streaming parse for the 5MB upper bound.
**Effort**: M

### S11: Vacation auto-responder can echo to `MAILER-DAEMON` / list-unsubscribe addresses and create reply loops · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/mail/filters.ts:48-90`
**What's wrong**: `maybeQueueVacationResponse` records the sender once via `recordVacationResponse` (deduping subsequent vacation replies from the same address), but it does not check whether the inbound mail is itself an auto-response. It will happily auto-reply to `mailer-daemon@…`, to messages carrying `Auto-Submitted: auto-replied`, `List-Id`, `Precedence: bulk`, or `List-Unsubscribe` headers — the very things RFC 3834 says you must NOT auto-respond to. The `from` of the vacation reply is `message.to[0]` (`firstRecipient`), which for a `Cc`-only or BCC-only delivery is wrong. And the outbound `undoUntil` is set to "now", bypassing the undo window in `MailSendService.queue` (this isn't strictly wrong for vacation but is inconsistent with the regular path).
**Fix**: Bail out early when `metadata.headers` contains any of `auto-submitted`, `list-id`, `list-unsubscribe`, `precedence: bulk`, or when the sender local-part matches `AUTOMATED_LOCALPARTS` from `category.ts`. Add `Auto-Submitted: auto-replied` to the outbound headers. Use the actor's primary address (resolvable from `recipientActorId`), not `message.to[0]`.
**Effort**: S

### S12: Outbound `envelope` (including BCC) persisted on `mail_outbound_messages` and returned by `mail.outbound.get` · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/mail/store.ts:332-393` · `apps/helix/src/platform/mail/tools.ts:826-837`
**What's wrong**: `createOutbound` stores the entire envelope (including `bcc`) as JSON on the row. The `mail.thread.get` and `getOutbound` projections expose `envelope` and `deliveryMetadata` to the actor. For mail with multiple BCC recipients, each recipient's later "view sent message" call returns the BCC list — leaking that other parties were silently copied, which is the entire reason BCC exists.
**Fix**: Strip `bcc` from the persisted envelope after the dispatcher records delivery (or store it on a separate, owner-only column). Keep BCC only long enough for the transport to consume it.
**Effort**: S

### S13: Mail attachment storage key uses unescaped `filename` — path traversal / collision · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/mail/store.ts:1173-1175`
**What's wrong**: `const storageKey = \`mail/${messageId}/${attachment.filename ?? randomUUID()}\`;` — the attachment filename comes from `mailparser` which reflects whatever the remote sender placed in `Content-Disposition`. A filename of `../../../tenants/other/secret.bin` is accepted; depending on the storage backend (S3 normalizes, local FS does not) this is either a no-op or a write outside the tenant prefix. Worse, cross-message dedup via `sha256` is bypassed — every message gets its own object regardless.
**Fix**: Always derive the key from `messageId` + an internal ULID, never from the filename. Keep the original filename only inside `objects.metadata->>'filename'` for display. Add a regex check at ingest rejecting filenames containing `..` or path separators.
**Effort**: S

### S14: Outbound mail sends BCC in a single `sendMail` call, leaking BCC recipients to each other on SMTP relays that don't normalize · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/mail/outbound.ts:69-89` · `apps/helix/src/platform/mail/providers.ts:159-205,291-339`
**What's wrong**: All providers receive `bcc: envelope.bcc.map(formatAddress)`. Nodemailer / SES / Mailgun / Postmark each handle BCC differently — Postmark's HTTP API exposes BCC via the `Bcc` header rather than stripping it, and a relay that copies the BCC header into the delivered message leaks the BCC list to TO/CC recipients. Gmail-class clients send one envelope per BCC recipient to avoid this.
**Fix**: For each BCC recipient, perform a separate `transport.send` with that recipient as the sole `to` and no `bcc`, OR (provider-specific) use the API field documented to suppress the header (Postmark's per-recipient send, Mailgun's `recipient-variables`). At minimum add a test that asserts BCC never appears in the delivered headers seen by TO recipients.
**Effort**: M

### S15: Mail vacation `metadata` accepts arbitrary `Record<string, unknown>` and stores as JSONB without schema · severity: MEDIUM · category: quality
**File**: `apps/helix/src/platform/mail/tools.ts:128-143,540` · `apps/helix/src/platform/mail/store.ts:635-667`
**What's wrong**: `vacationSetSchema.metadata` is `z.record(z.unknown()).default({})`. The store JSON-roundtrips it via `toSqlJson`, which will throw on circular/BigInt input from the tool surface (TypeScript guards prevent most cases but a hostile JSON-RPC payload can include `{"a": "x".repeat(1<<20)}`). No size cap, no key allowlist.
**Fix**: Restrict to a documented closed-shape (e.g. `{ template: string, sendOncePer: number }`) or cap the serialized byte size at, say, 4 KB and reject otherwise.
**Effort**: S

### S16: `mail-shell.tsx` is 2,709 lines in a single file with state, network, and UI mixed · severity: MEDIUM · category: quality
**File**: `apps/web/src/features/mail/mail-shell.tsx:1-2709`
**What's wrong**: One file contains `MailShell`, `MailSidebar`, `ThreadRow`, `EmptyState`, `ThreadList`, `PagerControls`, `ThreadView`, `Compose`, attachment helpers, time formatters, URL sync, twelve mutations, and bulk-action plumbing. The `MailShell` component alone has 12 `useMutation` calls plus a bidirectional URL ↔ state sync (`useEffect` at lines 2214-2244) with a known echo-loop hazard (commented and worked around, not fixed). The bidirectional sync uses `// eslint-disable-next-line react-hooks/exhaustive-deps` which silences the warning that flags the loop.
**Fix**: Split per concern: `MailShell` (composition), `useMailShellState` (URL sync + state), `useMailMutations` (mutations), and the UI subcomponents into individual files. Replace the manual URL sync with the router's `search` integration so React Router owns the source of truth and the echo guard disappears.
**Effort**: L

### S17: Bulk actions fan-out N independent mutations sequentially — no transactional semantics · severity: MEDIUM · category: bug
**File**: `apps/web/src/features/mail/mail-shell.tsx:2441-2520`
**What's wrong**: `handleBulkArchive`, `handleBulkDelete`, `handleBulkRead`, `handleBulkSnooze`, `handleBulkLabel`, `handleBulkMove`, `handleBulkSpam` all iterate `ids` and fire one `mutation.mutate(...)` per id with no batching, no progress UI, no cancellation, and no partial-failure rollup. Selecting 200 rows fires 200 RPCs; if 47 fail, the UI shows one generic toast and re-fetches a list whose state is partially mutated.
**Fix**: Add a `mail.threads.bulkUpdateState` tool that takes `{threadIds: string[], patch: MailThreadStatePatch}` and runs the update inside one transaction in `store.updateThreadState` (loop within `sql.begin`). Have the UI display "Archiving 200…" with progress and a "View errors" link on partial failure.
**Effort**: M

### S18: Outbound dispatcher records the same error message regardless of provider — no retry classification · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/mail/outbound.ts:174-182`
**What's wrong**: On transport failure, the dispatcher unconditionally calls `markOutboundFailed`. There is no notion of "transient" vs. "permanent": a 421 (4xx SMTP rate-limit) from SES, a 503 from Mailgun, and a 550 (mailbox full / unknown recipient) all become `status='failed'` with the raw error string. The undo-send worker (`OutboundMailWorker.handle`) re-throws, but the outbox event subscription doesn't have a backoff/retry budget visible here, so a transient `EAI_AGAIN` from DNS permanently fails the message.
**Fix**: Introduce `MailOutboundDeliveryError extends Error` with a `transient: boolean` field and have each provider throw it. In `dispatch`, branch on `transient`: leave status `queued`, bump a `delivery_attempts` counter, push `deliver_after = now() + backoff(attempts)`. Surface `delivery_attempts` and `next_attempt_at` in `mail.outbound.get`.
**Effort**: M

### S19: `findActorByAddress` accepts any alias regardless of disabled state on the parent actor · severity: MEDIUM · category: bug
**File**: `apps/helix/src/platform/mail/store.ts:306-326`
**What's wrong**: The query joins `mail_aliases` with `enabled = true and disabled_at is null` on the alias row, but does not check whether the *target* actor itself has `disabled_at is null`. A disabled employee whose old alias is still enabled will route inbound mail to a disabled actor record; downstream filters then run as that actor and the recipient never sees the message but it shows up in projections.
**Fix**: Add `join actors a on a.id = mail_aliases.actor_id and a.disabled_at is null` to the alias branch of the union.
**Effort**: S

### S20: SMTP receiver disables `AUTH` by default — every SMTP connection is treated as trusted relay · severity: MEDIUM · category: security
**File**: `apps/helix/src/platform/mail/ingest.ts:93-126`
**What's wrong**: `new SMTPServer({ disabledCommands: [...(options.disabledCommands ?? ["AUTH"])] })`. With AUTH disabled, the receiver accepts mail from any peer that can reach the listening port; tenant isolation depends entirely on network-layer ACLs upstream. Worse, `MailauthAuthenticator` runs SPF/DKIM/DMARC checks against the message but the receiver itself never enforces them — `summarizeAuthentication` always returns a result, the outcome is just persisted as metadata. A `dmarc: 'fail'` message is silently accepted into the recipient's Inbox.
**Fix**: Add a strict-mode flag (`MAIL_SMTP_REQUIRE_DMARC_PASS`) that rejects with 550 when `auth.dmarc === 'fail'` and the policy is `reject`/`quarantine`. Keep AUTH disabled by default only when an environment-asserted "trusted MTA in front" flag is set; otherwise require TLS+AUTH.
**Effort**: M

### S21: `evaluateInboundMail` triggers vacation BEFORE running spam routing — auto-replies leak to spam senders · severity: LOW · category: bug
**File**: `apps/helix/src/platform/mail/filters.ts:9-46` · `apps/helix/src/platform/mail/ingest.ts:178-200`
**What's wrong**: `ingestRawMail` stores the message, then calls `evaluateInboundMail` (which can queue a vacation reply), THEN routes to Spam via `updateThreadState({patch:{spamAt}})` if `scan.routedToSpam`. A spam message therefore triggers an out-of-office reply to the spammer before the spam routing fires.
**Fix**: Pass `scan.routedToSpam` (and the antivirus `infected` verdict) into `evaluateInboundMail` and short-circuit the vacation branch when either is true. Likewise skip filter execution for spam.
**Effort**: S

### S22: `mail_thread_state` upsert in `updateThreadState` always resets `labels` even when the patch only intended to set a flag · severity: LOW · category: bug
**File**: `apps/helix/src/platform/mail/store.ts:520-558`
**What's wrong**: The UPDATE sets `labels = ${sql.array([...labels])}` unconditionally on every patch, where `labels` is computed from `mergeLabels(currentLabels, addLabels ?? [], removeLabels ?? [])`. If two patches race (e.g. user adds a label in tab A while ingest applies one via a filter), the second writer sees a stale `currentRows[0]?.labels` snapshot and clobbers the first writer's addition. There is no row-level lock or `for update`.
**Fix**: Wrap the read+merge+write in `sql.begin` with a `select … for update`. Better: do the merge in SQL (`array(select distinct unnest(coalesce(labels,'{}') || ${addArray}::text[]) except select unnest(${removeArray}::text[]))`).
**Effort**: S

### S23: `MailSendService` is instantiated twice per `mail.send` request · severity: LOW · category: quality
**File**: `apps/helix/src/platform/mail/tools.ts:230-276`
**What's wrong**: `createMailToolDefinitions` builds one `sendService` outside the handler (used by `mail.reply`), but `mail.send`'s handler builds a fresh `new MailSendService(...)` on every call to honor `input.undoWindowMs`. Cheap, but the asymmetry is confusing and means the two endpoints can drift.
**Fix**: Pass `undoWindowMs` directly to `sendService.queue(...)` (extend the method signature) and delete the per-call constructor.
**Effort**: S

### S24: `mail-admin-api.ts` zod schemas use `z.string().nullish()` for `config.apiKeyRef` etc., letting `null` reach kind-specific consumers · severity: LOW · category: quality
**File**: `apps/web/src/features/admin/mail-admin-api.ts:35-43`
**What's wrong**: All five config fields are `nullish()`, so a `ses` provider that's missing `region` parses successfully and the UI prints `"region — · key —"` (mail-admin.tsx:178). The actual backend requires `region`/`host`/etc. per provider kind. The error doesn't surface until the server tries to send, at which point `requireString` in `providers.ts:596` throws on every send.
**Fix**: Replace the single schema with a discriminated union keyed on `kind`, mirroring the backend zod in `admin-routes.ts:84-110`. Generate it from a shared definition so it can't drift.
**Effort**: S

### S25: Frontend tool call `mail.threads.list` accepts `limit` up to 200 but UI is hard-coded to 50 with no chunked prefetch · severity: LOW · category: quality
**File**: `apps/web/src/features/mail/mail-shell.tsx:2193` · `apps/helix/src/platform/mail/tools.ts:158-165`
**What's wrong**: `const PAGE_SIZE = 50;` is the only call site; users with thousands of threads page one screen at a time. Combined with finding S6 (broken total) the UX is poor.
**Fix**: After S6 is fixed, raise default page size to 100 and use TanStack Query's `keepPreviousData` to make pagination feel instant.
**Effort**: S

## Out-of-scope notes
- The signup invite mailer (`server.ts:1700`) shares the outbound transport; a deeper review of `apps/helix/src/platform/onboarding/` is warranted for token leak in the From line.
- `mail/search/indexer.ts` is well-shaped but I did not verify the consumer wiring in `apps/helix/src/platform/search/`.
- `apps/helix/src/platform/mail/ai/suggestions.ts` and `enrichments.ts` look reasonable but their hooks into the chat capability rely on `ctx.actor.scopes` set elsewhere; a cross-cutting AI/permissions review should confirm `mail.suggest-reply` cannot exfiltrate confidential mail to a less-trusted model.
- The Postgres migrations referenced in this PR (0054-0058) were deleted in the git status; this review assumed the current `schema.ts` reflects the live shape.
- I did not exercise the e2e test (`e2e-mail-flow.test.ts`) — worth running before merging any of S2/S3/S4/S6/S7 fixes.
