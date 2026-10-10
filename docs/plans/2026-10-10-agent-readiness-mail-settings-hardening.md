# Agent readiness, Drive sync, Mail standards, and Settings hardening

Date: 2026-10-10
Status: in progress — Batch 1 being implemented on branch `agent-readiness-hardening`.

## 1. Why

A five-part review covered Drive desktop sync, the CLI and REST API, the MCP server and tool layer,
Mail standards and features, and Settings across every app. The core safety model is sound
(tenant checks, scopes, policy firewall, audit, DLP, malware quarantine, DKIM, SPF/DKIM/DMARC/ARC
verification, nodemailer/mailparser MIME). The problems are in the integration layers: several
headline workflows do not work at all for real users and real agents.

Every P0 below was re-checked by reading the cited code before this plan was written.

## 2. Findings

Severity: **P0** broken, data loss, or security; **P1** serious gap; **P2** consistency; **P3**
polish. "Batch" says when it is fixed (see section 3).

### 2.1 Drive desktop sync (`scripts/helix-drive-sync-setup.mjs`, WebDAV in `platform/drive/routes.ts`)

| ID   | Sev | Finding                                                                                                                                                | Batch                                 |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| DS1  | P0  | Setup builds `https://host/dav/files/`, but the server only routes `/v1/dav/files/`. Sync cannot connect.                                              | 1                                     |
| DS2  | P0  | Every WebDAV request consumes the per-IP `auth:` bucket (20/min). A first sync of 500 files is throttled; all users behind one proxy share the budget. | 1                                     |
| DS3  | P0  | Re-running setup always runs `bisync --resync`, which can resurrect deleted files.                                                                     | 1                                     |
| DS4  | P1  | Password prompt echoes; `rclone obscure <password>` exposes it in `ps`.                                                                                | 1                                     |
| DS5  | P1  | No app-password preset with `drive.delete`; missing scope returns 401 "password required" instead of 403 naming the scope.                             | 1                                     |
| DS6  | P1  | No rclone version check (bisync `--resilient` needs ≥ 1.66).                                                                                           | 1                                     |
| DS7  | P1  | Local path not `~`-expanded or made absolute.                                                                                                          | 1                                     |
| DS8  | P1  | Re-run deletes the working remote before probing the new one.                                                                                          | 1                                     |
| DS9  | P1  | No WebDAV MOVE/COPY/PROPPATCH; renames in mount mode fail, in mirror mode become upload + trash.                                                       | 2                                     |
| DS10 | P1  | Mtime not preserved (`X-OC-Mtime` ignored), no checksums exposed.                                                                                      | 2                                     |
| DS11 | P1  | Uploads buffered in memory, capped at 128 MiB, no chunking; limit undocumented.                                                                        | 1 (docs + `--max-size`), 2 (chunking) |
| DS12 | P1  | Quarantined/pending files listed in PROPFIND but 404 on GET; retried forever.                                                                          | 1                                     |
| DS13 | P2  | No background schedule (launchd/systemd/Task Scheduler), no `--recover`/`--max-lock`/log file.                                                         | 2                                     |
| DS14 | P2  | Mount exit status ignored; no FUSE prerequisite checks.                                                                                                | 2                                     |
| DS15 | P2  | No `--help`, uninstall, or flag mode.                                                                                                                  | 2                                     |
| DS16 | P2  | `http://` accepted silently; probe only lists, so missing write/delete scope goes unnoticed.                                                           | 1                                     |
| DS17 | P2  | Docs say Node 20+ (repo requires 24); docs imply self-service app passwords (admin-issued only).                                                       | 1                                     |
| DS18 | P3  | Fake quota properties; `%` not escaped in `.cmd` helpers; stale helpers after mode switch.                                                             | 2                                     |

### 2.2 CLI and REST API (`packages/cli`, `apps/helix/src/api`, `bootstrap/tool-routes.ts`)

| ID   | Sev | Finding                                                                                                                                     | Batch                                  |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| CA1  | P0  | `helix mail list` calls `mail.list`, which does not exist (server has `mail.threads.list`). Tests mock the wrong id.                        | 1                                      |
| CA2  | P0  | `helix mail search` sends `cursor`/`mailbox`/`label`; the server schema silently strips them. Paging agents loop on page 1.                 | 1                                      |
| CA3  | P0  | REST idempotency is get→invoke→set (not atomic): concurrent retries double-send. Results < 500 (including 401/403/429) are pinned for 24 h. | 1                                      |
| CA4  | P1  | Invalid/expired OAuth bearer → 403, not 401.                                                                                                | 1                                      |
| CA5  | P1  | Tool catalogue publishes `{type:"object", additionalProperties:true}` for ~300 tools (shared with MC1).                                     | 1                                      |
| CA6  | P1  | 202 pending confirmation exits 0 in the CLI.                                                                                                | 1                                      |
| CA7  | P1  | `helix login` does not persist credentials; client secret only via argv.                                                                    | 2                                      |
| CA8  | P1  | Global 120 s fetch timeout aborts uploads; no retry/backoff on 429/5xx; no per-part retry.                                                  | 1 (retry/backoff, timeout), 2 (resume) |
| CA9  | P1  | CLI never sends `Idempotency-Key`.                                                                                                          | 1                                      |
| CA10 | P1  | Upload resume after approval does not unwrap `{status, output}`.                                                                            | 1                                      |
| CA11 | P2  | 30+ error codes not in the contracts enum; tool validation errors lack structured `details.issues`.                                         | 1 (issues), 2 (enum)                   |
| CA12 | P2  | Fastify body-limit / bad JSON / bad media type bypass the error envelope.                                                                   | 2                                      |
| CA13 | P2  | No `RateLimit-*` headers; pagination shapes differ per app; API version tied to package major.                                              | 2                                      |
| CA14 | P2  | Coarse exit codes; `--json` reads a TTY stdin and hangs; errors not JSON in JSON mode.                                                      | 1                                      |
| CA15 | P3  | Subcommand `--help` exits 1 with global usage; command gaps; Calendar/Meet verbs exposed.                                                   | 2                                      |

### 2.3 MCP and tool layer (`api/mcp.ts`, `api/mcp-resources.ts`, `bootstrap/agent-api.ts`)

| ID   | Sev | Finding                                                                                                                                                             | Batch                                                                          |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| MC1  | P0  | All core tools publish empty input/output schemas (`zodToolSchema` returns the placeholder).                                                                        | 1                                                                              |
| MC2  | P0  | Agent writes require non-standard `params._meta.idempotencyKey`; stock clients cannot write.                                                                        | 1                                                                              |
| MC3  | P0  | Pending approvals are unusable: no approval URL, no owner notification, no approvals inbox, no `actions.get` tool.                                                  | 1 (URL, instructions, `actions.get`), 2 (inbox UI, notifications, elicitation) |
| MC4  | P0  | User-delegated OAuth tokens rejected (`credential.actorId === actor.id`); relaxing it naively would make agent writes look human.                                   | 2 (needs auth design review)                                                   |
| MC5  | P0  | No 401 + `WWW-Authenticate`, no RFC 9728 metadata, no dynamic registration, no audience binding.                                                                    | 1 (401 + header + metadata), 2 (DCR, audience)                                 |
| MC6  | P1  | Streamable HTTP gaps: notifications get error bodies (should be 202), GET 404 (should be 405), no session/protocol-version headers, progress lacks `progressToken`. | 1                                                                              |
| MC7  | P1  | Tool failures returned as JSON-RPC errors, not `isError` results; 404 mapped to -32601; `retryAfter` dropped.                                                       | 1                                                                              |
| MC8  | P1  | Non-standard annotations; no `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`.                                                                     | 1                                                                              |
| MC9  | P1  | No prompt-injection boundary: `containsUntrustedContext:false` hard-coded; raw HTML `source` returned with body.                                                    | 2                                                                              |
| MC10 | P1  | Resource reads bypass registry audit/rate limit/DLP; no size caps.                                                                                                  | 2                                                                              |
| MC11 | P1  | Automation-policy bounds ignore some fields (`role`, `actorRefs`, `mailboxActorId`).                                                                                | 2                                                                              |
| MC12 | P2  | Coverage: no `mail.forward`, attachment read, drive text read, inline upload.                                                                                       | 1 (`mail.forward`), 2 (rest)                                                   |
| MC13 | P2  | Every tool mirrored as a prompt (~170).                                                                                                                             | 1                                                                              |
| MC14 | P2  | Thin tool descriptions; deadline does not cancel work; inconsistent pagination.                                                                                     | 2                                                                              |

### 2.4 Mail standards (`platform/mail/**`, `apps/web/src/features/mail/**`)

| ID   | Sev | Finding                                                                                                                                                | Batch                                      |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| ML1  | P0  | Display-name quoting escapes `"` but not `\`: a crafted name injects extra envelope recipients, reachable by an outside sender via the vacation reply. | 1                                          |
| ML2  | P0  | Mailgun and Postmark providers silently drop attachments.                                                                                              | 1                                          |
| ML3  | P0  | Vacation replies: inbound headers not stored so Auto-Submitted/Precedence checks never fire; no `Auto-Submitted: auto-replied`; replies to spam.       | 1                                          |
| ML4  | P0  | Web reply-all only replies to the last sender; forward is a `Re:` reply without the original; no In-Reply-To/References on replies.                    | 1                                          |
| ML5  | P1  | Inbound To/Cc trimmed to Helix recipients only.                                                                                                        | 1                                          |
| ML6  | P1  | Mixed internal/external sends strip internal recipients from visible headers.                                                                          | 1                                          |
| ML7  | P1  | Tenant SES/SMTP transports allow STARTTLS downgrade (`requireTLS` not set).                                                                            | 1                                          |
| ML8  | P1  | SPF likely evaluated against the mail-edge IP (unverified end to end).                                                                                 | 2 (needs live evidence)                    |
| ML9  | P1  | No inline (cid) images in either direction.                                                                                                            | 2                                          |
| ML10 | P1  | Provider Message-ID overrides may break threading.                                                                                                     | 2                                          |
| ML11 | P2  | No RFC 3464 DSN parsing; Reply-To not supported on send; promotions category never fires; SMTPUTF8/IDN rejected; search operators limited.             | 1 (Reply-To, headers → category), 2 (rest) |
| ML12 | P3  | No MDN, outbound List-Unsubscribe, mbox export, compose autocomplete.                                                                                  | 2                                          |

Out of scope by product decision (1.0 non-claims): IMAP/POP/JMAP/SMTP submission. Recommended
minimum for 1.x: documented mbox/EML export.

### 2.5 Settings (`platform/admin/**`, `platform/tenancy/orgs.ts`, `components/shell/settings-*.tsx`)

| ID   | Sev | Finding                                                                                                                                     | Batch                                  |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| ST1  | P0  | Saving any admin feature flag replaces the whole `feature_flags` JSON (same for `quotas`); other flags such as `byo_storage` are lost.      | 1                                      |
| ST2  | P1  | `mail.settings.set` replaces the record; a partial agent call wipes blocked senders.                                                        | 1                                      |
| ST3  | P1  | Web signature form always sends `signatureHtml: null`.                                                                                      | 1                                      |
| ST4  | P1  | "Filter messages like these" creates a filter with no actions; no filter management UI.                                                     | 1 (require action), 2 (UI)             |
| ST5  | P1  | No optimistic concurrency on any settings write.                                                                                            | 2                                      |
| ST6  | P1  | Vacation responder has no web UI.                                                                                                           | 2                                      |
| ST7  | P2  | Notifications section is a disabled mock, including editor rows (violates product boundary).                                                | 1 (remove editor rows), 2 (real prefs) |
| ST8  | P2  | User-level Helix AI section is a disabled fake config.                                                                                      | 2                                      |
| ST9  | P2  | Language/region all disabled; no per-user time zone.                                                                                        | 2                                      |
| ST10 | P2  | Signature form re-seeds from stale cache after save.                                                                                        | 1                                      |
| ST11 | P2  | Security section: unlabeled inputs, errors in `role=status`, swallowed passkey list errors; no sessions list or self-service app passwords. | 1 (a11y, errors), 2 (sessions)         |
| ST12 | P2  | One signature per user, not per alias; missing standard mail prefs.                                                                         | 2                                      |
| ST13 | P3  | Appearance only in `localStorage`; no reset/export.                                                                                         | 2                                      |

## 3. Batches

**Batch 1 (this branch):** every P0 that does not need an auth design decision, plus the
contained P1/P2 items marked "1" above. Work is split by area so changes do not overlap:

- **A. Drive sync + WebDAV:** DS1–DS8, DS11 (docs, `--max-size`), DS12, DS16, DS17.
- **B. CLI + REST API:** CA1–CA4, CA6, CA8 (retry/timeout), CA9, CA10, CA11 (issues), CA14.
- **C. MCP + tool schemas:** MC1/CA5, MC2, MC3 (URL, instructions, `actions.get`), MC5 (401 +
  metadata), MC6, MC7, MC8, MC13.
- **D. Mail:** ML1–ML7, ML11 (Reply-To, header capture), MC12 (`mail.forward`).
- **E. Settings:** ST1–ST3, ST4 (require action), ST7 (remove editor rows), ST10, ST11 (a11y,
  errors).

**Batch 2 (follow-up, needs decisions or larger design):** MC4 delegated OAuth, DCR and token
audience; approvals inbox UI and notifications; prompt-injection boundary; resource reads through
the registry; WebDAV MOVE/COPY/mtime/checksums/chunking; background sync scheduling; settings
concurrency and the missing settings sections; inline images; DSN parsing; pagination unification.

## 4. Rules for every change

- Each fix has a test that fails without it.
- No new dependencies. Tool JSON Schemas come from an in-repo zod (v3) converter.
- Files stay within `.file-size-baseline.json` (new files ≤ 800 lines); never raise a ceiling.
- Preserve tenant isolation, actor-scoped authorization, malware scanning, retention, audit.
- Actionable errors. Semantic, labelled, keyboard-reachable UI.

## 5. Validation

Per area: focused vitest, eslint, and tsc. Whole branch: `pnpm format:check`, `pnpm typecheck`,
`pnpm lint`, `pnpm test`, `pnpm build`, `pnpm quality:boundaries`, Drive/Mail Playwright specs,
`pnpm audit:a11y`. Known failures already on `main` (seed and Assistant type errors, three
unformatted files, two seed lint errors) are reported separately, not hidden.

## 6. Batch 2 recommendations

### Decisions (product owner, 2026-10-10)

| #   | Question                                               | Decision                                                                                   |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| D1  | Can an agent acting for a user ever skip confirmation? | No. Delegated agents never act as the user; writes always queue for the user's approval.   |
| D2  | Do new MCP clients need admin approval?                | Clients from trusted hosts (admin-maintained allowlist) skip approval; all others need it. |
| D3  | Approval expiry                                        | 1 hour default (configurable per automation policy). Email alerts on by default (opt-out). |
| D4  | Maximum desktop-sync file size                         | 5 GiB, with chunked upload.                                                                |
| D5  | Browser push notifications                             | In 1.0, alongside in-app and email.                                                        |
| D6  | Native mail clients                                    | Support standard desktop mail apps over **IMAP and POP3**. No custom Helix mail apps.      |

D6 reverses a documented 1.0 non-claim ("no Helix-hosted IMAP server" in `README.md`,
`docs/release/1.0-scope.md`, `docs/product-claims-mvp.md`, `docs/mail-security-and-reliability.md`).
Those documents change when the feature ships with release evidence, not before.

Each item: the recommendation, why, and the decision needed from the product owner.

### 6.1 User-delegated OAuth tokens (MC4)

- A token a user grants to an agent becomes a principal of **type `agent`** with
  `onBehalfOf = user`, `approvalOwner = user`, and `clientId`. It is never treated as the human.
- Effective permissions are the **intersection** of the user's permissions, the token's scopes,
  and the scopes the client is allowed to request.
- Writes go through the policy firewall as agent writes, so they queue for the user's approval.
- Match credentials by (client id, user id, token hash), not by actor id. Audit records both the
  agent client and the user.
- Access tokens 1 h; refresh tokens 30 days, rotated on use, with reuse detection that revokes
  the whole grant.
- Users see and revoke "Connected apps"; admins can disable a client for the whole org.
- **Decision:** confirm "agent acting for a user" is never allowed to act as the user without
  confirmation (recommended: yes, never).

### 6.2 MCP client registration and token audience (MC5)

- Support **Client ID Metadata Documents** (preferred in the current MCP spec) and **dynamic
  client registration**, but new clients land in a **pending** state until an admin approves
  them. Optionally pre-approve known hosts (for example claude.ai, and localhost redirect URIs for
  desktop clients).
- Require the RFC 8707 `resource` parameter; tokens carry `aud` = the MCP resource URL, and
  `/mcp` rejects tokens for any other audience.
- **Decision:** admin approval required for every new client (recommended), or an allowlist of
  trusted hosts that skip approval.

### 6.3 Approvals inbox and notifications (MC3)

- An **Approvals** page in the shell with a badge count. Each card shows the agent, the user it
  acts for, a plain-language summary ("Send email to ana@acme.com, subject 'Q3 numbers', 1
  attachment"), the full arguments on expand, when it was requested, and when it expires.
- Approve / Reject; re-authentication for high-risk actions (external email, sharing outside the
  org, delete).
- Notify the approval owner in-app (always) and by email (opt-out). The MCP result carries an
  `approvalUrl` deep link; use MCP elicitation when the client supports it.
- Default expiry 1 hour (today 10 minutes), configurable per automation policy.
- Allow "approve similar actions from this agent for the next 15 minutes", bounded by the
  existing automation-policy limits (action, target, time window, rate) and audited.
- **Decision:** default expiry and whether email notifications are on by default.

### 6.4 Prompt-injection boundary (MC9)

- Treat mail bodies, chat messages from others, file text, and web results as **untrusted**.
  Return them in clearly delimited blocks with provenance (`source`, `sender`, `external`).
- Return plain text by default; drop raw HTML `source`; strip hidden text; cap sizes with
  continuation cursors.
- Mark the agent session **tainted** after it reads untrusted content. While tainted,
  high-risk writes always require confirmation, even if an automation policy would allow them.
- Show the taint on the approval card ("proposed after reading an external email from X").
- Do not rely on a classifier as a gate; the confirmation is the control.
- **Decision:** none needed; recommended as default behaviour.

### 6.5 WebDAV completeness (DS9–DS11)

- **MOVE / COPY** mapped to the existing rename, move, and copy store operations, so renames keep
  version history and share links. Honour `Destination` and `Overwrite`.
- **Modification times:** accept `X-OC-Mtime` on PUT (reply `X-OC-MTime: accepted`) and store it
  as the client mtime shown in `getlastmodified`.
- **Checksums:** compute MD5 and SHA-1 while streaming the upload (SHA-256 already exists) and
  expose `oc:checksums`; switch the rclone remote to `vendor=owncloud`.
- **Large files:** stream PUT bodies to object storage instead of buffering; then add Nextcloud
  chunked upload v2 for files above the single-request limit.
- **Decision:** the maximum file size to support for sync (recommended: 5 GiB with chunking).

### 6.6 Background desktop sync (DS13–DS15)

- Setup installs a per-user schedule: macOS LaunchAgent, Linux `systemd --user` timer, Windows
  Task Scheduler. Every 5 minutes, with `--recover --max-lock 2m --resilient
--conflict-resolve newer --conflict-loser num --log-file`, plus a run lock.
- Subcommands: `status`, `sync-now`, `pause`, `resume`, `logs`, `uninstall`.
- Move the tool into the Helix CLI (`helix drive sync setup`) so users don't need a repo clone.
- Keep rclone as the engine for 1.x; a native client is not justified yet.
- **Decision:** none needed.

### 6.7 Settings concurrency (ST5) and one settings pattern

- Every settings read returns a `version`; writes accept `expectedVersion`. A mismatch returns
  409 with the current value, and the UI offers "Reload" or "Overwrite".
- Agents may omit `expectedVersion`; partial updates (Batch 1) already keep them from wiping
  unrelated fields.
- One server helper (partial merge, version, audit) and one web `useSettingsForm` hook (dirty,
  saving, saved, `role=alert` errors) used by every settings form.
- **Decision:** none needed.

### 6.8 Missing settings screens (ST6, ST7, ST9, ST12)

- **Vacation responder (Mail settings):** on/off, start and end in the user's time zone, subject,
  message, "only reply to people in my organization", and reply at most once per sender every 7
  days (RFC 3834 guidance). Reuses the existing `mail.vacation.*` tools.
- **Filters:** list, edit, enable/disable, delete; reuses existing tools.
- **Signatures per alias**, default reply vs. reply-all, external images (ask / always for
  trusted senders / never), undo-send delay.
- **Language and region:** locale, time zone (detected from the browser and confirmed), week
  start, date format; stored on the profile. Used by vacation schedules, scheduled send, and
  digests.
- **Notifications:** real preferences per category (mentions, direct messages, shares,
  approvals) and channel (in-app, email, browser push), plus quiet hours. Approval notifications
  in-app cannot be turned off.
- **Decision:** whether browser push is in 1.x (recommended: later; in-app and email first).

### 6.9 Inbound SPF behind the mail edge (ML8)

- Have the edge pass the original client IP to Helix: Postfix `smtp_send_xforward_command = yes`
  on the edge relay, and accept `XFORWARD` in Helix's SMTP server **only** from the edge's
  address. SPF then evaluates the real sender IP. (To verify against the installed smtp-server
  version before building.)
- Alternative: verify SPF/DKIM/DMARC at the edge (Rspamd) and trust its Authentication-Results
  header only from the edge.
- **Decision:** none needed; recommended XFORWARD.

### 6.10 Standard mail client access (D6: IMAP and POP3)

Desktop mail apps need three things: read (IMAP or POP3), send (SMTP submission), and sign-in
(app passwords). Receiving IMAP/POP alone would leave Thunderbird, Apple Mail, and Outlook unable
to send, so **SMTP submission is included**.

- **Architecture:** a Helix-native mail access service on top of the existing Postgres mail
  store, not a separate mail store. Running Dovecot against its own Maildir would duplicate every
  message and need two-way sync with labels, threads, retention, and legal hold, which is the
  wrong trade for 5–50 users.
- **Sign-in:** app passwords with a new `mail.imap` / `mail.pop` / `mail.submit` scope (existing
  app-password infrastructure, already used by CardDAV and WebDAV). `AUTHENTICATE PLAIN` and
  `LOGIN` over TLS only; per-IP failed-auth limits as in DS2. Admins can disable each protocol.
- **IMAP4rev2 (RFC 9051) with IMAP4rev1 compatibility:** CAPABILITY, STARTTLS/implicit TLS (993),
  LOGIN/AUTHENTICATE, LIST/STATUS (including SPECIAL-USE: Sent, Drafts, Trash, Junk, Archive),
  SELECT/EXAMINE, FETCH/UID FETCH (BODY[], BODYSTRUCTURE, ENVELOPE, FLAGS), STORE (\Seen,
  \Flagged, \Deleted, \Answered, \Draft), SEARCH/UID SEARCH, COPY/MOVE, EXPUNGE/UID EXPUNGE,
  APPEND (Sent and Drafts), IDLE, ENABLE, NAMESPACE, ID. Then CONDSTORE/QRESYNC for fast resync.
- **Mapping:** Helix folders become IMAP mailboxes; labels appear as additional mailboxes (Gmail
  style) so a message can live in several; stable UIDVALIDITY per mailbox and monotonically
  increasing UIDs stored in a new table; flags map to existing read/star/draft state.
- **POP3 (RFC 1939 + RFC 2449 CAPA, RFC 2595 STLS, port 995):** Inbox only; "delete after
  download" honours retention and legal hold (a deleted message moves to Trash rather than being
  purged if a hold applies).
- **SMTP submission (RFC 6409, port 587 STARTTLS / 465 implicit TLS):** uses the existing
  `smtp-server` dependency and the existing outbound pipeline, so DKIM, suppression, malware
  scanning, attachment limits, aliases/send-as authorization, and audit all apply unchanged.
  The sender must be the user's own address or an authorized alias.
- **Safety:** every protocol session is audited (login, mailbox opened, messages deleted/sent);
  connection and command rate limits; maximum literal size; idle timeouts.
- **Infrastructure:** Caddy does not proxy raw TCP, so ports 993/995/587/465 are exposed by the
  mail edge or a TCP proxy with TLS certificates from the same ACME source; compose, Helm, and
  firewall docs updated.
- **Delivery order:** (1) app-password scopes + SMTP submission, (2) IMAP read-only core
  (LIST/SELECT/FETCH/SEARCH/IDLE), (3) IMAP writes (STORE/COPY/MOVE/EXPUNGE/APPEND), (4) POP3,
  (5) CONDSTORE/QRESYNC. Each stage is tested against Thunderbird, Apple Mail, and Outlook and
  with a protocol conformance suite (for example imaptest).
- **Effort:** this is the largest Batch 2 item — a multi-week project, not a patch.
- **Also:** mbox export and import stay in scope for migration.

## Validation log

Filled in when Batch 1 lands.
