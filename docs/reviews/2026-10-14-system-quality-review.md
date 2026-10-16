# System quality review

Date: 2026-10-14
Source baseline: `aa4d2da67c37a851a3ce1a89c24fd307073f5be1` plus the current
working tree. This review includes the existing development deployment fixes;
it does not describe the baseline commit alone.

**What this repo does:** Helix owns a self-hosted communication and storage
workspace, its browser app, platform APIs, MCP interface, CLI, integration SDKs,
and deployment tooling. Mail, Drive, Chat, Assistant, and Admin form the current
pilot; Calendar and Meet belong to the separately configured full profile, and
Passwords links to an optional Vaultwarden installation. The assumed load is the
documented invite-only 5–50-user pilot with simultaneous agents, hostile public
email, and the existing 100-socket Chat release profile.

The system has substantial working foundations and broad tests. It does not yet
meet the complete quality requirements in the
[workspace quality and optional AI plan](../plans/2026-10-14-workspace-quality-and-optional-ai.md).
The confirmed defects below need repairs; future AI experiences remain planned.

## Validation follow-up — 2026-10-15

The current development tree and live stack were validated again after native
KeePass Passwords was added. The dated findings below remain the original review;
they are not all resolved by passing builds or browser tests. Current results and
limits are recorded in [validation evidence](evidence/2026-10-15-system-validation.json).

Validation found and repaired one live regression: native vault routes declared
session authentication before Swagger had that security scheme, so OpenAPI
returned 500 and CLI OpenAPI discovery failed. The shared cookie scheme is now
registered before schema generation, covered by a real Fastify/Swagger regression,
and deployed as `helix/workspace-development:validation-r5-openapi`. Public
OpenAPI and CLI discovery now pass. An unused approval-helper export was made
private. Two browser assertions were corrected: Assistant is intentionally pinned,
and a settings mutation must finish before the fixture's request is asserted.
The full accessibility matrix checked 306 configurations; two missing Admin
fixtures initially covered error states. Loaded-state checks then exposed invalid
definition-list markup in Agent controls. The fixture responses and markup are
corrected, and both Admin routes pass again across all viewports and themes. The web fix
is deployed as `helix/workspace-web-development:validation-r5-accessibility`.
The final default suite passes 5,515 tests; 26 relevant PostgreSQL cases run
separately, and 211 browser cases pass across the full run and focused corrections.

The live pass covers scoped MCP discovery, reads, resources and prompts; CLI REST,
MCP, OpenAPI and both stdio framing formats; encrypted file readback and quarantine
access denial; a fresh external-email approval request cancelled without sending;
real configured AI generation, persistence and temporary-credential revocation;
trusted HTTPS, origin restrictions, DNS, SMTP STARTTLS and authenticated TURN.
SDK export files and server-package imports pass; the browser SDK is validated
through the web bundler, not advertised as a Node HTTP client. Atlas is preserved.
Its actor-wide usage correctly hit a narrower temporary automation budget, so the
AI positive test used an audited disposable identity rather than resetting Atlas
or raising its standing limits. That fixture is disabled and its key revoked.

The repeated isolated probes still demonstrate missing MCP source provenance,
resource reads outside the tool budget/read audit, unbounded Mail resources,
malformed/suspended REST responses rejected by the shared error contract, a rejected
email-code resend invalidating the delivered code, and stale forwarded SMTP
identity on a reused connection. These remain open defects, with synthetic fixtures
and no external mail sent by the probes. Native SES feedback ingestion, complete
WebDAV sync, and some blocking creation dialogs also remain incomplete.

The external Mail human-review journey from finding 5 now exists and has separate
browser, live cancellation and earlier human-approved delivery evidence. This
closes that missing Mail destination; it does not certify every kind of external
agent action or its email-notification journey. Native Passwords now provides the
personal-vault UI; the earlier Vaultwarden description is historical.

This pass does not certify two-participant live Meet media, recording, a new
backup restore, restart recovery, desktop/mobile KeePass sync, soak/load behavior,
public SDK/CLI distribution, or production image promotion. Port 25 timed out from
the local runner; trusted inbound SMTP TLS passed from the deployment server,
while the earlier Gmail inbound/outbound delivery evidence remains separately dated.

## Defect repairs — 2026-10-15

The later repair pass supersedes the open **defect** statuses in the historical
review below. The implementation and its limits are recorded in
[repair evidence](evidence/2026-10-15-defect-repairs.json). Future product work and
production acceptance remain separate; a passing suite does not close those gaps.

| Finding | Repair and remaining boundary                                                                                                                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | External agents retain tenant/actor-scoped source identifiers across requests and restarts. REST and MCP use server-owned context; unknown context and destructive/external communication require human review even under standing automation. Pending execution preserves context and revalidates the current credential and policy.                                   |
| 2       | MCP content resource reads use the shared tool permission, feature, request-budget, audit, and input/output data-policy path. URI/resource labels must agree. A warned read can resume only with a matching, executed, unexpired approval, while current access and blocking policy are checked again. Resource discovery remains discovery, not a content read.        |
| 3       | Email MFA publishes a replacement challenge only after delivery succeeds. A database lock serializes resends across instances, a failed send rolls back its cooldown reservation, and slow delivery starts the new code's lifetime at publication. Rejected resends preserve the old usable code.                                                                       |
| 4       | Product REST framework and legacy domain errors now use the shared envelope. Supported domain codes retain their identity; unknown server errors are sanitized. OAuth, JSON-RPC and DAV keep their protocol formats.                                                                                                                                                    |
| 5       | Every pending tool action has a browser review URL through REST/MCP and notifications. People see a concrete redacted action preview and source identifiers; Mail retains its detailed message review. Approval still executes as the requester, never the reviewer. A dedicated global action queue, navigation count and email reminders remain planned enhancements. |
| 6       | Mail resources query at most 20 messages per page, bound bodies in SQL, omit Bcc and attachment payloads, and enforce a serialized UTF-8 byte cap. Explicit truncation and continuation preserve actor visibility and do not skip excluded rows. Human mailbox reads retain their existing complete content.                                                            |
| 7       | Native signed SES SNS delivery/bounce/complaint/delay events now feed the existing correlated, deduplicated delivery and suppression store. Verified subscriptions are supported. Tenant provider setup exposes the topic ARN and webhook URL. Live AWS topic wiring and simulator delivery are still operator configuration and have not been certified.               |
| 8       | SMTP consumes forwarded identity once per message and falls back to the immutable physical peer. Missing HELO cannot inherit the preceding sender's value. A real reused loopback SMTP connection covers forwarded, unavailable and absent handoffs.                                                                                                                    |
| 9       | WebDAV reports authorized measured usage and configured remaining quota; unknown available capacity is unsupported instead of an invented 10 TiB. Tests cover populated, unlimited, capped and exhausted cases.                                                                                                                                                         |
| 10      | Full desktop sync remains a planned feature: MOVE/COPY/PROPPATCH and larger resumable/streaming compatibility are not supplied by this repair. The existing bounded protocol claim remains explicit.                                                                                                                                                                    |
| 11      | Source installation and SDK purpose remain documented; pending review links are part of the client contract. Independent package distribution remains a separate release decision.                                                                                                                                                                                      |
| 12      | Shared nonblocking panels replace current creation/editing dialogs across Drive, Chat, Calendar, Contacts, Assistant, Mail and Admin. They preserve failed drafts and background interaction, focus the first field, and avoid duplicate page landmarks. Confirmations and concrete review decisions retain blocking dialogs.                                           |

The repair also fixes SES provider creation/editing: required SMTP connection
fields and tenant secret handles are represented, and editing preserves TLS,
custom ports and regional provider endpoints. Maintained dependency patches
remove the advisories detected by the earlier audit. No dependency severity
exception or enlarged source-size budget was added.

## Coverage and method

The review mapped README, release scope, architecture decisions, package exports,
server bootstrap, web routes, tool definitions, contracts, infrastructure gates,
and current deployment records. It traced the costly paths: authentication and
MFA, tenant/actor resolution, tool authorization and confirmation, MCP resources,
Mail delivery and feedback, Drive protocol access and scanning, background jobs,
and recovery requirements. It compared existing UI and client behavior with the
shared registry rather than treating a visible control as completed functionality.

| Surface                 | Evidence reviewed or exercised                                                                                                                                    | Limits of that evidence                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Mail UI                 | Conversation, compose/reply, addresses, settings, attachment states, keyboard use, mobile layouts, white reading canvas in both themes; full mocked browser suite | Today's browser run uses fixtures. Earlier real SES/Gmail and inbound round trips remain separately dated development evidence. |
| Drive UI and backend    | Upload lifecycle, sharing, versions, resource access, scanning, WebDAV/S3 paths, unit/component/browser checks                                                    | No new 5 GiB sync, object-store outage, or simultaneous desktop-client load test.                                               |
| Chat                    | Room/message operations, realtime access and reconnect paths, browser workflows, existing negative tests                                                          | No fresh multi-node or 100-socket load run.                                                                                     |
| Calendar and Meet       | Calendar browser flows; Meet configured/unavailable states, guest/recording authorization paths and existing tests                                                | No live Jitsi/Jibri deployment, capture, or transcript generation in this review.                                               |
| Assistant and AI        | Tool policy, provider routing/cost foundations, pending decisions, attachment states, Mail suggestion hooks                                                       | Mail assist and automatic meeting recap journeys are not wired end to end.                                                      |
| Admin and account       | Invitations, agent credentials/controls, domains, settings, optional MFA, offboarding and recovery UI checks                                                      | No complete global approval inbox or first-time external-agent enrollment journey.                                              |
| REST and contracts      | Versioned bootstrap, schemas, HTTP error handler, tenant errors, OpenAPI route checks                                                                             | Two real response shapes fail the published error schema; recorded below.                                                       |
| MCP                     | Initialization/discovery, invocation/idempotency, confirmations, resources, source provenance; isolated executable probes                                         | No fresh external vendor-client certification. Prior scoped API-key/OAuth development tests remain separate evidence.           |
| SDK and CLI             | Package exports, command parsing, credentials, retries, JSON/error handling, existing package tests                                                               | Workspace packages are private; no independently installable public HTTP SDK was found.                                         |
| Infrastructure and docs | Current stack listeners, canonical API routes, encryption/backup records, dependency audit, boundary/dependency/mail-edge checks, runbooks and guides             | No new production promotion, image vulnerability scan, 24-hour soak, reboot recovery, or complete restore drill.                |

The probes use real Helix handlers with isolated fixtures. The email resend probe
uses the installed Better Auth plugin with its memory adapter and a simulated
database cooldown; it sends no external mail. The SMTP probe uses a loopback-only
plaintext server to inspect connection reuse; it does not exercise or change the
deployed TLS listener. Safe observations are saved in
[interface probe evidence](evidence/2026-10-14-interface-probes.json).
The later threading repair, browser/accessibility results, active development
images, and recovery-copy checks are recorded separately in
[quality validation evidence](evidence/2026-10-14-quality-validation.json).

## Must fix

### 1. MCP discards source provenance before automation decisions

- **What this is:** Provenance records which source content an agent used, including
  untrusted incoming email or documents. The firewall can block high-risk work
  after such content is read.
- **Problem:** [MCP invocation](../../apps/helix/src/api/mcp-tools.ts#L160) always
  supplies empty sources and `containsUntrustedContext: false`. A fixture reads
  external mail and then executes an external write under standing authorization;
  its audit still reports no sources and trusted context, while the
  [firewall](../../apps/helix/src/platform/tools/policy-firewall.ts#L112) denies the
  same category when actual untrusted provenance and its blocking option are supplied.
- **Fix:** Retain server-owned provenance for external agent reads and apply the
  existing firewall before subsequent sensitive calls. Make unknown provenance
  require review before widening automation, and preserve the earlier rule that
  delegated-agent writes need human approval.
- **If we skip it:** The planned prompt-injection safeguard cannot operate on
  MCP automation. Default agent writes still require approval; this finding does
  not demonstrate a bypass of tenant or recipient grants.

Status: open. Repair batch Q1. Close with a read-to-write regression through REST
and MCP, including policy changes, credential revocation, expiry, and retries.

### 2. MCP resource reads bypass the agent audit and request budget

- **What this is:** Agents can retrieve Mail, Chat, Calendar, and Drive content
  through MCP resources as well as tools.
- **Problem:** [Resource dispatch](../../apps/helix/src/api/mcp.ts#L158) calls
  [store-backed resources](../../apps/helix/src/bootstrap/agent-api.ts#L167)
  directly. A probe exhausts an explicit one-request-per-minute agent tool budget,
  receives a tool denial, then reads the same Mail resource twice successfully
  with zero additional audit records.
- **Fix:** Apply shared read authorization, configured request limits, applicable
  data policy, and credential-correlated auditing to resources without counting
  one request twice. Keep actor-scoped store checks and safe content handling.
- **If we skip it:** Operators cannot rely on an optional agent budget or complete
  read audit across both MCP paths. Store-level tenant and actor checks still
  apply; mutation-only emergency controls intentionally leave reads available.

Status: open. Repair batch Q1. Close when equivalent tool/resource reads obey the
same configured budget and produce attributable audit evidence.

### 3. A rejected email-code resend invalidates the delivered sign-in code

- **What this is:** Optional email MFA sends a six-digit second-step code to a
  verified external inbox after the password succeeds.
- **Problem:** [The delivery callback](../../apps/helix/src/platform/auth/external-email-mfa.ts#L178)
  applies its 60-second cooldown after the maintained plugin creates the new OTP
  verification record. The isolated plugin probe succeeds with the first code
  in a control case; a second send returns 429, delivers nothing, and makes the
  original delivered code fail with 401 `INVALID_CODE`.
- **Fix:** Reject or reserve the resend before replacing the challenge. Preserve
  the existing valid challenge when cooldown or delivery failure prevents a new
  code from reaching the user, including concurrent resend requests.
- **If we skip it:** Clicking Send again can strand someone with an unusable code
  and a cooldown. This is a sign-in reliability defect, not an MFA bypass.

Status: open. Repair batch Q2. Add a maintained-plugin regression for first send,
rejected resend, successful later resend, delivery failure, and single use.

### 4. REST errors do not consistently satisfy the published contract

- **What this is:** Clients use a stable error envelope to choose reauthentication,
  permission, validation, and retry behavior.
- **Problem:** [The HTTP handler](../../apps/helix/src/bootstrap/http.ts#L87)
  rethrows framework errors: malformed JSON returns Fastify's flat response.
  A suspended tenant returns 423 with `tenant-suspended`, which the
  [contract enum](../../packages/contracts/src/errors.ts#L10) rejects; several
  [mail feedback routes](../../apps/helix/src/platform/mail/delivery-events.ts#L423)
  also return `{ error: "text" }` directly.
- **Fix:** Inventory emitted domain codes, add their supported status mappings,
  and normalize REST framework/domain failures through one envelope. Keep
  standards-specific OAuth, WebDAV, SMTP, and JSON-RPC errors in their native formats.
- **If we skip it:** Typed clients reject legitimate responses and cannot
  consistently distinguish a suspended workspace from invalid JSON or a server
  outage. Passing package type checks does not prove runtime compatibility.

Status: open. Repair batch Q2. Close with actual HTTP responses parsed by the
shared schema for validation, oversized/unsupported bodies, authentication,
authorization, tenant state, missing resources, rate limits, and internal errors.

### 5. External-agent actions lack a complete human review destination

- **What this is:** An agent queues a proposed write and asks its human owner to
  review and approve it.
- **Problem:** [MCP returns an approval POST endpoint](../../apps/helix/src/api/mcp-tools.ts#L473),
  not a browser review page. The
  [Assistant panel](../../apps/web/src/features/assistant/pending-approvals.tsx#L39)
  derives cards from its own conversation turns; no global external-agent approval
  route or list was found. The
  [platform event](../../apps/helix/src/bootstrap/tools.ts#L218) exists, but it does
  not by itself provide that inbox or the planned email notification journey.
- **Fix:** Add a scoped pending-action list and a human review page using the
  existing confirmation gate. Return a usable review URL, show the concrete
  action and sources, and connect in-app/email notifications and expiry recovery.
- **If we skip it:** A normal administrator receiving an external agent's action
  ID still needs an API/CLI workaround. Existing Assistant approvals and authorized
  API approvals work; agents still cannot approve themselves.

Status: open. Repair batch Q3. Close with a fresh external MCP request that its
owner reviews in the browser, plus denial, expiry, cancellation, and revocation.

## Should fix

### 6. Mail MCP resources have no content-size or message-page bound

- **What this is:** A Mail thread resource converts every visible message into
  one response for an agent.
- **Problem:** [Mail serialization](../../apps/helix/src/api/mcp-resources.ts#L337)
  traverses the entire thread, and
  [the store query](../../apps/helix/src/platform/mail/store-threads.ts#L105)
  has no message limit. Twenty 128 KiB fixture bodies produce a 2,622,836-byte
  response; the same path has no output cap or continuation cursor.
- **Fix:** Add an actor-scoped message page and byte limit before full materialization,
  with a visible continuation/truncation result and a clear text representation.
  Reuse the bounded-content approach already present for streamed Drive resources.
- **If we skip it:** Long threads can consume excessive memory and model context,
  increasing latency and generation cost. Drive's runtime stream path already
  caps text at 1 MiB; this finding is specific to Mail.

Status: open. Repair batch Q1. Close with long-thread and multibyte-text tests,
including consistent access checks on every page.

### 7. SES feedback has no native ingestion adapter

- **What this is:** Delivery, bounce, and complaint events update message status
  and suppress recipients who should no longer receive mail.
- **Problem:** [The managed webhook](../../apps/helix/src/platform/mail/provider-webhook-routes.ts#L99)
  accepts only Mailgun. The
  [generic signed delivery endpoint](../../apps/helix/src/platform/mail/delivery-events.ts#L396)
  can consume normalized events, but no SES SNS verification/normalization adapter
  was found or configured for the selected development provider.
- **Fix:** Adapt verified SES feedback into the existing tenant-scoped delivery
  store, with deduplication, message correlation, suppression, and replay handling.
  Keep SMTP acceptance and final delivery states distinguishable.
- **If we skip it:** A message SES accepts can later bounce or receive a complaint
  without Helix updating its local status and suppression state. Close this before
  expanding automated external mail volume or promoting this provider to production.

Status: open. Repair batch Q4. Close with controlled delivered, transient failure,
hard bounce, complaint, duplicate, and invalid-signature vectors.

### 8. Reused SMTP handoff connections can retain a previous sender IP

- **What this is:** A trusted private Postfix handoff forwards the original client
  IP for authentication checks and sender-specific rate limits.
- **Problem:** [Client identity fallback](../../apps/helix/src/platform/mail/smtp-transport-security.ts#L115)
  uses `session.remoteAddress`. A real loopback SMTP probe forwards
  `203.0.113.77`, completes DATA, then forwards `[UNAVAILABLE]`; the second message
  is still attributed to `203.0.113.77` rather than the physical peer or an explicitly
  unknown source. The receiver already saves the physical
  [connection address](../../apps/helix/src/platform/mail/ingest.ts#L340).
- **Fix:** Use that immutable connection identity when forwarded information is
  missing and avoid retaining a previous message's HELO. Test valid, unavailable,
  and repeated forwarded identities on one connection.
- **If we skip it:** Unavailable-source handoffs can receive another sender's SPF
  or rate-limit treatment. Normal handoffs with a valid forwarded address passed
  earlier live testing; the public edge does not expose XFORWARD to arbitrary clients.

Status: open. Repair batch Q5. Close with the reused-connection protocol vector
while preserving the trusted-peer allowlist and verified private STARTTLS.

### 9. WebDAV advertises invented storage quota values

- **What this is:** Desktop clients ask WebDAV how much storage is used and available.
- **Problem:** [The property builder](../../apps/helix/src/platform/drive/routes.ts#L728)
  always advertises 10 TiB available and reports an individual entry's byte length
  as quota usage; a collection therefore reports zero even with stored files.
  These values do not represent the configured optional quota or storage capacity.
- **Fix:** Report measured, authorized quota values when known; otherwise return
  the appropriate unsupported property result. Do not invent a product usage limit.
- **If we skip it:** Clients show misleading capacity information and cannot
  anticipate a real administrative quota or storage exhaustion.

Status: open. Repair batch Q5. Close with an unlimited workspace, a capped
workspace, a populated collection, and an exhausted capacity case.

### 10. Accepted desktop-sync behavior remains incomplete

- **What this is:** A full sync client needs rename, copy, metadata updates,
  resumable transfer, and trustworthy conflict handling.
- **Problem:** [Registered WebDAV methods](../../apps/helix/src/platform/drive/routes.ts#L205)
  omit MOVE, COPY, and PROPPATCH. PUT remains a documented buffered 128 MiB
  compatibility path and GET uses `readFile`; the earlier accepted desktop-sync
  plan calls for larger resumable transfers and streaming.
- **Fix:** Complete the already accepted protocol subset through the existing
  Drive authorization, locking, scanning, retention, and audit paths. Stream
  transfers and test real client rename/conflict/restart behavior before claiming
  broad desktop-sync compatibility.
- **If we skip it:** Clients that depend on these operations cannot complete the
  intended sync workflow. The current bounded compatibility limit is documented;
  this is an accepted completion gap, not a claim that today's browser upload path
  buffers large files through the API.

Status: planned, incomplete. Repair batch Q5; retain the narrower current claim
until actual client interoperability evidence exists.

### 11. Client installation and SDK purpose needed clearer instructions

- **What this is:** Operators must give local and remote agent runners a repeatable
  way to install and use the supported CLI or SDK.
- **Problem:** Before this review, [the agent guide](../../apps/web/public/agent-setup.md#L22)
  assumed an installed CLI. [CLI](../../packages/cli/package.json) and
  [SDK](../../packages/sdk/package.json) packages are private workspace packages;
  SDK exports are integration capabilities and database/feature/metering helpers,
  rather than a public typed HTTP client for workspace actions.
- **Fix:** The guide now includes the source-checkout installation, and
  [client integration instructions](../reference/clients.md) explain runtime versions,
  package purpose, and a scoped example. Decide on
  independent CLI/client distribution explicitly before advertising package-manager
  installs or a general public HTTP SDK.
- **If we skip it:** An administrator can configure an endpoint and credential
  yet leave their runner without a working executable or a clear SDK entry point.
  This does not imply that the existing internal integration SDK is broken.

Status: current installation and package-purpose documentation fixed in this
working tree; CLI build and help invocation verified. Independent distribution
remains a separate packaging decision and is not advertised as implemented.

### 12. Several creation flows still use blocking dialogs

- **What this is:** Routine creation and editing should remain in the page or a
  nonblocking panel; modal interruptions are reserved for confirmation and review.
- **Problem:** [New-folder/rename](../../apps/web/src/features/drive/drive-dialogs.tsx),
  [new Chat/space](../../apps/web/src/features/chat/new-chat.tsx), and
  [user invitation](../../apps/web/src/features/admin/sections/user-invite-dialog.tsx)
  currently collect data inside the blocking shared Dialog. Existing global
  tokens, styled fields, and controls are substantial foundations, but these
  journeys do not meet the operator's clarified interaction requirement.
- **Fix:** Move data entry into the current page or a shared nonblocking panel,
  retaining labelled + New/+ Add triggers, form validation, pending/error states,
  focus return, and mobile layout. Keep irreversible actions and permission
  decisions in confirmation dialogs. Consolidate repeated control styling into
  the existing primitives rather than replacing the established visual design.
- **If we skip it:** The app keeps inconsistent creation interactions despite
  passing accessibility checks. A passing accessibility audit does not prove
  conformity with the requested interaction style.

Status: open. Repair batch Q7. The conventions are now explicit in the root agent
guide and plan; this review does not claim those existing flows were migrated.

## Current fixes and validation

The review corrected narrow regressions or stale records:

- The full Playwright suite could not collect tests because the security-header
  spec imported the renderer's inline CSS through Node. The
  [spec now loads the real renderer through Vite](../../apps/web/tests/e2e/security-headers.spec.ts#L7)
  and targets the quote toggle by its accessible label. Its focused production-CSP
  test and the full browser suite pass.
- [The documentation index](../README.md#L39) now uses the canonical `/v1` paths.
  Read-only probes inside the active server returned unversioned OpenAPI/MCP 404,
  versioned OpenAPI 200, and versioned MCP GET 405 as expected.
- The Drive recovery runbook no longer claims preview conversion, which is
  outside the product. Third-party notices were regenerated to include the
  added QR-code dependency after the dependency-policy gate detected stale notices.
- The accessibility audit now waits for the authenticated page's main content.
  Its initial full run captured loading skeletons on two mobile/light pages and
  reported four landmark/heading violations; both affected pages passed a focused
  six-configuration rerun. The full rerun with the readiness check is recorded below.
- Current CLI installation and SDK package-purpose instructions are now documented,
  as described in finding 11. The updated public agent guide is deployed and was
  checked at `https://workspace.helixapps.si/agent-setup.md` in the shared browser.
- SES replaces outbound Message-ID. The selected Mail Manager relay's acceptance
  response does not give the final delivered SES ID. Outbound SES transports now
  preserve the local ID as a bounded References anchor, which a reply can inherit;
  ordinary SMTP retains its existing headers. Provider/fallback regressions and
  five real-PostgreSQL threading tests passed, including same-tenant actor and
  cross-tenant denial for repaired links. A fresh external Gmail round trip with
  these new headers has not been observed yet.
- The reported live conversation was repaired using a narrowly guarded privileged
  maintenance transaction with an exclusive table lock and rollback snapshot.
  The canonical-content trigger was restored before commit; fingerprints verify
  the original message's other fields were unchanged. The audit and update events
  were appended in the same transaction. Both original and reply now appear at
  the supplied thread link, and the previous link resolves to it through the
  actor-scoped alias. Runtime roles cannot perform this privileged repair.
- Mail already receives live SSE updates. Its open/reconnect handler now refreshes
  the mail cache after missed events. Browser regressions verify new mail and
  reconnect catch-up without a document reload; the reader, current draft, and
  shell are retained. The updated API and web images are active on the development
  server and readiness passed.

| Check                                                  | Result                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                    | Passed; rerun after final evidence updates                                                                           |
| `pnpm typecheck`                                       | Passed                                                                                                               |
| `pnpm lint`                                            | Passed                                                                                                               |
| `pnpm test`                                            | Passed; package results total 5,479 tests passed, 389 skipped; unchanged package results may use Turbo cache         |
| `pnpm build`                                           | Passed                                                                                                               |
| `pnpm quality:boundaries`                              | Passed                                                                                                               |
| Full default Playwright suite                          | 193 passed, 1 skipped; SMTP/Mailpit scenario requires live-backend mode                                              |
| Focused Mail/realtime and security-header Playwright   | 14 passed; new-mail/reconnect updates preserve the draft, focus, selection, and document                             |
| E2E type check and changed-spec lint                   | Passed                                                                                                               |
| Full route accessibility/visual audit                  | Passed; 306 route/theme/viewport configurations, zero accessibility violations, visual findings, or execution errors |
| Production package dependency audit                    | Passed configured severity gate; 0 critical, 0 high, 7 moderate advisories                                           |
| Dependency policy/unused imports/deduplication         | Passed after notices regeneration                                                                                    |
| Launch documentation fidelity                          | Passed                                                                                                               |
| Mail-edge configuration validation                     | Passed                                                                                                               |
| Isolated interface, OTP resend, SMTP connection probes | Confirmed the findings above; no external sends or live-user mutations                                               |

## Production acceptance and future features

The Hetzner stack remains development. Existing encrypted storage, private TLS,
mail delivery, scanned storage uploads, credential revocation, and an updated local
encrypted recovery copy are useful development evidence. The latest copy passed
age authentication and archive inspection; it has not had a new isolated restore.
These checks do not satisfy the signed production artifact, recurring off-server backup, exact-copy restore,
dependency, migration, load, and 24-hour soak requirements in
[final release readiness](../final-release-readiness.md).

The default unit run skips 389 tests, including live database integrations. The
mocked browser run skips the live SMTP scenario and excludes the dedicated
performance and live Meet media configurations. Run the required live service,
tenant-isolation, recovery, and media suites against isolated configured targets
before making the corresponding release claim. Earlier session proofs cover
specific real services, not this entire matrix.

Mail drafting, contextual replies, translation, action extraction, catch-up,
workspace answers, transcript-based recaps, and agent handoffs are recorded as
AI1–AI6 in the new plan. Current provider hooks and `attachSummary` storage are
foundations; they are not complete automatic generation journeys. Provider-assisted
AWS/Cloudflare setup remains its separate proposal. Native SMTP submission is
implemented and gated; a Helix incoming IMAP/JMAP service is not currently supplied.

**Verdict:** Keep the development pilot, fix MCP control consistency and the
authentication/error defects first, then complete human approvals and provider
feedback before expanding automation. Broad passing tests are useful evidence,
but the system is not yet uniformly complete or production-ready.

**Not checked:** Every source line, every optional integration, fresh external
MCP client compatibility, the entire live-database suite in both tenant modes,
production image rescanning, real Jitsi/Jibri capture, model-output quality,
large desktop-client sync, a new load/soak run, host reboot/unlock recovery, and a
restore of the newest encrypted archive. No source/dependency deletion savings
were asserted without evidence.

## Review repairs, AI and protocol follow-up — 2026-10-15

The current development API is `review-fixes-r11`, with web `review-fixes-r9`.
The shared plan records the repairs for event privacy, replay authorization, transaction
ordering, SMTP uncertain outcomes, AI budgets/reservations, transient MCP errors and
optional mail assistance. Live sync and protocol testing also repaired WebDAV client
compatibility, same-size edit detection, conflict/recovery handling, proxy ETags and
CardDAV predicate grouping. The earlier dated findings above are historical evidence;
use the [latest validation report](evidence/2026-10-15-protocol-sync-validation.json) for
what was actually tested, what was fixed and what remains outside this pass.

## Stream authorization and recovery follow-up — 2026-10-15

The development API is now `security-r12`; web remains `review-fixes-r9`. Mail SSE
rejects anonymous requests, limits concurrent streams, and rechecks authorization
before delivery. Generic event WebSockets also recheck authentication before
delivery. Long-lived browser requests no longer reuse the session actor cached at
connection time. Chat checks the current browser session and `chat.read` scope
when connecting and receiving events, and requires current `chat.post` permission
before accepting a message. Existing tenant, mailbox and room filters remain.
Revocation closes these connections on their next relevant event or frame; an
idle connection is not promised an immediate disconnect.

Public HTTPS/WSS verification confirmed anonymous Mail SSE returns 401, an
authorized temporary agent receives its event, and revocation stops both existing
streams before another event is delivered. Subsequent authentication returns 401.
The test credential was revoked and its actor disabled; Atlas remains active.

All required repository checks passed: formatting, types, lint, build, boundaries,
and the default tests (5,598 passed, 400 skipped; some unchanged packages cached).
An additional configured PostgreSQL run passed 56 security and isolation tests in
15 files, including cross-tenant storage, private mail, delegation, vault access,
sharing, session freshness, account suspension, chat grants and forced RLS. The
stale generic-event transaction fixture now uses an allowed health event. The
disposable database was removed. This pass changed no application UI.

SSH password authentication is disabled; a fresh key-only login succeeded. A daily
encrypted off-server development backup is scheduled on the operator's machine
at 03:30 UTC, with up to five minutes of jitter. The verified archive contains the
database, deployment configuration and object encryption key. This is a cold
backup: services pause during the snapshot and resume afterward. A server-side
recovery timer also restarts them if the backup connection is interrupted.

A controlled reboot installed the pending kernel update. Storage remained locked
until the operator's off-server key was supplied over SSH, after which all 17
running containers recovered, public readiness passed and Atlas authenticated.
This verifies reboot/unlock recovery, not restoration onto a replacement server.

The stack remains development. Backups depend on the operator's machine and user
service manager; a missed timer runs when that manager next starts. There is no
independent backup destination or proactive backup-failure notification yet.
Future reboots require the operator's unlock procedure. The newest archive has
been authenticated and inspected, not restored as a complete application. The
exhaustive cross-interface role matrix, fresh container/host vulnerability scan,
independent penetration test and production acceptance gates remain outstanding.
See [validation evidence](evidence/2026-10-15-stream-security-validation.json).

## Development completion follow-up — 2026-10-15

API `security-r13` also filters private Calendar, Contacts, Assistant, Meet and
Passwords subjects from the generic event WebSocket, which has no resource ACL
context. It cleans up subscriptions when a client disconnects during asynchronous
authentication/subscription setup. The public Calendar filtering and credential
revocation probes passed; Atlas remains enabled. Dedicated authorized transports
continue to serve their own resources.

The default suite passes 5,608 tests with 401 environment-gated skips. Configured
PostgreSQL runs pass 427 tests in each tenancy mode; the large demo-seed scenario
remains skipped. The new real HTTP S3/WebDAV sharing regression covers private
resources, reader/editor grants, cross-protocol updates, share revocation and
revocation of an already-issued signed URL. Its object backing and scanner are
fixtures, so it does not replace the earlier live RustFS/ClamAV protocol evidence.

The encrypted daily archive was restored into nine isolated services on the same
host, with outbound networking blocked. Readiness, Atlas MCP discovery (137 tools)
and CLI reads of Mail, Drive, Calendar, Chat and Assistant passed. All 38 active
stored objects (2,112,180 bytes), including mail evidence and attachments, matched
database sizes and SHA-256 hashes after TLS/SSE-KMS reads. This proves core data and
application recovery, not new-host failover, Meet media recovery or vault unlock.
The restored services, scratch data, tunnel and disposable test database were removed.

Fresh Trivy scans found substantial inherited OS/runtime advisories in optional
Meet and inbound-mail images. The development patch recipe updates distribution
packages, rebuilds the existing Go helper versions with patched dependencies and
removes unused npm installations. Six patched images are deployed with immutable
local image IDs and rollback configurations. All available fixes for their reported
High/Critical findings were applied, but vendor-unfixed High/Critical findings
remain. TURN has no reported vulnerabilities; API r13 has no High/Critical findings.
The production JavaScript dependency audit reports zero advisories. Host curl was
patched; current-kernel and virtualization findings remain, plus advisories against
the installed older fallback kernel. These are not accepted production exceptions.

SMTP validation also found a post-reboot DNS outage: Unbound depended on Docker,
while Docker depended on the name-service target ordered after Unbound. Remove that
cycle and use Unbound's private-address `ip-freebind` setting so it can start before
the Docker bridge exists. DNS lookup, SMTP STARTTLS and recipient checks are part of
the recorded follow-up; the operator recovery helper now also checks mail DNS.
See [development completion evidence](evidence/2026-10-15-development-completion-validation.json)
for exact outcomes and remaining limits. Production readiness is still incomplete.
