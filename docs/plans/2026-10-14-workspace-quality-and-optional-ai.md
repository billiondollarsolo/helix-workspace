# Workspace quality and optional AI

Date: 2026-10-14
Status: Accepted product direction and implementation roadmap. Features below
remain planned unless their acceptance evidence is recorded.

Helix should make communication, shared storage, and work with AI agents easy to
understand and dependable. AI helps people understand ongoing work, prepare the
next action, and review the result. Administrators choose whether to enable it.
Every interface must expose the same permissions, results, and recovery behavior.

This extends the [agent readiness and settings plan](2026-10-10-agent-readiness-mail-settings-hardening.md).
The [current system review](../reviews/2026-10-14-system-quality-review.md) determines
the repair order. The [1.0 release scope](../release/1.0-scope.md) and
[production evidence requirements](../final-release-readiness.md) still govern
production promotion. Calendar and Meet remain separately configured full-profile
capabilities. Passwords is an optional administrator-enabled native KeePass vault.
An existing Vaultwarden service remains available through a legacy link during
the transition; section 1.1 records the implementation and remaining work.
Editors, file viewers, and converters remain outside Helix's product scope.

## 1 Product direction

The strongest experience connects Mail, Chat, Drive, Calendar, meetings, and
authorized agents. A person can see what changed, what was agreed, who owns the
next step, and what still needs a decision. Answers link to their sources, and
proposed changes have a concrete review step.

For example, after a meeting Helix can prepare a sourced recap, identify three
commitments, save the notes in Drive, draft a follow-up email, and propose a
Calendar follow-up. The person reviews the package before publishing its actions.
This complete workflow is a later acceptance target, not a current product claim.

Helix remains free and open source under [ADR-0030](../adr/adr-0030-free-open-source-no-plans-or-limits.md).
AI switches are administrator policy controls. Budgets are optional operator caps;
they are not commercial tiers or imposed usage limits.

### 1.1 Native Passwords experience and shared sign-in

The selected implementation is a native Helix Passwords surface using shared
fields, controls, creation actions, and design tokens. People use their existing
Helix account, then unlock their personal KeePass-compatible vault with a master
password. Existing Vaultwarden accounts are not migrated automatically.

The owner selected KeePass after reviewing the client SDK licensing. Use the MIT-licensed
[`kdbxweb`](https://github.com/keeweb/kdbxweb) library: Helix authenticates the
person and authorizes encrypted storage, while the browser unlocks and edits a
KDBX vault. The first personal-vault flow is implemented and tested. Browser-side
Argon2 uses MIT-licensed `hash-wasm` 4.12.0; `kdbxweb` does not bundle it. Do not invent
cryptographic primitives or downgrade a user's KDF to avoid that requirement.
The dependency graph and browser resource limits were reviewed before adoption. The registry currently publishes 2.1.1 with older
XML/compression dependencies, while the source tree identifies itself as 2.2.0;
do not assume the source tree and the published package are interchangeable.
The implementation pins `kdbxweb` 2.1.1 with scoped overrides to
`@xmldom/xmldom` 0.8.15 and `fflate` 0.8.3. Native files use KDBX 4, Argon2id
(32 MiB, 3 iterations, parallelism 2), and no compression. All database operations
run in a disposable worker, with a 60-second operation timeout. Worker failure
or timeout also locks the visible vault and clears decrypted fields. Loads refuse
compressed files, AES-KDF, and Argon2 settings outside tested resource bounds.
The published production dependency audit reports no vulnerabilities in the
new vault dependencies; seven existing moderate advisories elsewhere remain.

Alternatives reviewed on 2026-10-14:

- Vaultwarden can remain a separate service without embedding Bitwarden code
  into Helix. Bitwarden's SDK has both GPL-licensed components and a restricted
  SDK license; these are different licensing paths. Its restricted
  [SDK agreement](https://github.com/bitwarden/sdk-internal/blob/main/LICENSE_SDK.txt)
  limits compatible applications and distribution, while section 3.5 leaves
  open-source components under their own licenses. Do not add either package
  casually to the Apache-licensed web app. Its
  [README](https://github.com/bitwarden/sdk-internal#readme) also describes the
  password-manager SDK as unsupported for public use with an unstable interface.
  An independent client instead takes
  responsibility for changing protocol, KDF, key, and ciphertext formats.
- Psono's community
  [server](https://github.com/psono/psono-server/blob/master/LICENSE.md) and
  [client](https://github.com/psono/psono-client/blob/master/LICENSE.md) are
  Apache-2.0. However, its supported OIDC/SAML and audit logging are
  [enterprise features](https://doc.psono.com/admin/overview/supported-features.html),
  which conflict with requiring those capabilities to be freely available to
  every Helix deployment. Do not treat a small-team free enterprise allowance
  as unrestricted community functionality.
- Passbolt and Padloc are alternatives with copyleft licensing; they do not
  remove the need to review client integration obligations. Padloc identifies
  its [license as AGPL](https://github.com/padloc/padloc#licensing).

Do not migrate, delete, or disable existing Vaultwarden accounts during this
evaluation. A KDBX implementation would use KeePass-compatible clients and
import/export rather than Bitwarden server compatibility. Explain that change
before migration, and validate an explicit import/export and recovery flow.
The unfinished independent Vaultwarden client prototype was removed before
integration or deployment. No Bitwarden SDK dependency was installed.

Use the selected engine's supported interfaces for encrypted CRUD and synchronization.
Unlock, key derivation, encryption, and decryption happen in the browser using
a supported, license-compatible client implementation with tested protocol
vectors. Helix servers, logs, agents, and generic search never receive plaintext
vault passwords, master passwords, or decrypted vault keys. Do not copy vendor
UI or implement unreviewed cryptographic primitives to make the page look native.

For a native KDBX vault, reuse the existing Helix identity and session instead
of creating another account or identity provider. Keep storage authorization
tenant- and actor-scoped. Keep encrypted vault objects out of ordinary Drive
sharing, generic search, and agent discovery. Use conditional writes and tested
conflict recovery so concurrent tabs cannot overwrite each other's changes.

If retaining Vaultwarden, use OpenID Connect for shared authentication and automatic vault onboarding.
Helix currently consumes enterprise OIDC for sign-in and exposes its own OAuth
agent flows; this does not establish that it is a complete OIDC issuer. Verify
or implement discovery, signed ID tokens, stable subject identity, verified
email claims, exact client/redirect binding, PKCE, and session lifecycle before
connecting Vaultwarden. Avoid email-only account linking and preserve existing
accounts. A shared sign-in still has a separate vault-unlock boundary;
Vaultwarden's supported OIDC flow requires a master password. See its
[SSO documentation](https://github.com/dani-garcia/vaultwarden/wiki/Enabling-SSO-support-using-OpenId-Connect).

Acceptance:

- Passwords appears in the desktop rail when installed and enabled, and under
  phone More navigation when core apps fill the main slots. Disabled installs
  expose no working link. The current sidebar change has browser evidence.
- First use starts from an authenticated Helix user and provisions or links only
  the matching verified identity; a session alone cannot unlock encrypted data.
- The chosen format has cross-client create/read/edit and synchronization
  evidence. Existing Vaultwarden remains usable until an explicit migration;
  do not claim KDBX is compatible with Bitwarden's server API. Passwords,
  secure notes, lock/unlock, wrong-password handling,
  logout, cross-account denial, and account suspension have live evidence.
- Browser-only secrets are cleared on lock and logout. Output, crash reports,
  analytics, MCP catalogs, Mail content, and ordinary Drive metadata cannot
  disclose vault content. A future agent secret handoff needs its own explicit,
  narrow, audited grant; workspace membership is insufficient.
- Master-password/KDF changes, existing account migration, revoked sessions,
  concurrent saves, import/export, backup restore, and supported external
  clients have recovery tests.
- Creation/editing use native Helix panels or pages. Blocking modals are reserved
  for confirmations. Keyboard, phone, light/dark, and accessibility checks pass.

Delivered first slice: create/unlock a personal vault, create/read/edit login
fields and secure notes, move entries to the encrypted recycle bin, lock on
visibility change/navigation/5-minute inactivity, encrypted export, previous
revision export, safe retries, and stale-save refusal. Storage is private to the
human actor and tenant, outside Drive/search/MCP, with audit metadata only.
Requests also bind the actor that opened the page to the live session, preventing
stale tabs from writing after an account switch.
One current and one previous encrypted revision are retained. This is a recovery
convenience, not long-term retention or an off-server backup. The 1 MiB file cap
is an operational request limit. Worker secrets and decrypted UI state are
cleared on lock; an encrypted save candidate can still be downloaded after lock.

Evidence: unit encryption/reopen/edit/recycle/wrong-password/tampering tests;
real PostgreSQL RLS and two-writer conflict checks; 12 browser checks including
phone, light/dark, accessibility, failed-save recovery, identity changes, worker failure and production worker CSP;
independent PyKeePass read/edit/save round trip. Production recovery, sharing,
imports, automatic merges, master-password changes, key files, and external
mobile/extension synchronization remain unimplemented or untested. Do not present
this slice as a complete replacement for all password-manager capabilities.

## 2 Optional AI experiences

| ID  | Experience             | Behavior                                                                                                                                                                    | Delivery order                     |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| AI1 | Mail assistance        | Summarize the full thread, draft a contextual reply, rewrite tone or length, and translate selected text. The result remains editable before sending.                       | First                              |
| AI2 | Suggested action items | Extract decisions, requests, open questions, owners, and dates. Identify missing information instead of inventing commitments.                                              | First                              |
| AI3 | Catch me up            | Explain changes since the person's previous visit, unanswered requests, and work waiting on someone else. Link every item to authorized Mail and Chat sources.              | Second                             |
| AI4 | Meeting recaps         | Generate a transcript, concise summary, decisions, unresolved questions, and suggested action items from an authorized recording. Include speaker and timestamp references. | Third, after Meet capture is ready |
| AI5 | Ask your workspace     | Answer questions across authorized emails, conversations, files, calendar items, and meeting notes with source citations.                                                   | Expand alongside AI3 and AI4       |
| AI6 | Agent handoffs         | Assign bounded work to an identified agent, show progress and questions, and review its proposed changes and completion evidence.                                           | Expand the existing agent workflow |

### 2.1 Mail assistance

Put a concise summary action near the conversation subject. Offer drafting,
rewriting, and translation within compose and reply. Keep controls small and
contextual, and remove their entry points when the capability is disabled.

Reuse the existing `mail.compose-help`, `mail.summarize-thread`, and
`mail.suggest-reply` provider hooks. Fetch context on the server under the caller's
current permissions. A caller-supplied thread ID or classification is not authority
to read content or send it to a provider.

Acceptance:

- A summary covers the actual authorized thread and cites the messages supporting
  decisions or suggested tasks.
- A generated reply preserves intent and does not invent dates, commitments,
  attachments, or facts. Uncertain information is visibly marked for review.
- Generation does not send mail. A reviewed send uses the existing sender checks,
  scanning, suppression, approval, delivery, and audit path.
- Empty input, provider outages, cancelled generation, expired access, and budget
  exhaustion produce useful states without losing the person's draft.
- Keyboard, screen-reader, phone, light-theme, and dark-theme use work.

### 2.2 Catch me up and workspace answers

Start with a short, user-triggered catch-up view. Separate items needing a reply,
decisions made, open questions, and work awaiting someone else. Store the visit
boundary so the next catch-up explains changes rather than repeating everything.

Keep private summaries private to their authorized reader. A shared meeting recap
must not silently absorb private email used to prepare for that meeting. Source
access changes must affect later retrieval and generated-artifact access.

Acceptance:

- Every factual claim has a usable citation to an accessible source.
- Revoked, quarantined, held, deleted, and foreign-tenant content obey existing
  access, scanning, and retention policy.
- The result explains incomplete context and missing information.
- Repeated requests avoid unnecessary provider work where the authorized content,
  policy, and model version have not changed.
- No source message, document, transcript, or search result can authorize a tool
  call, alter permissions, or redefine the agent's instructions.

### 2.3 Meeting capture and recaps

Recording and transcription have separate controls from general AI. The meeting
shows clear participant notice and consent state. The operator configures access,
retention, deletion, and the permitted transcription provider.

Meet still requires configured Jitsi credentials and recorder health. Preserve
recording authorization, validated artifact promotion, malware checks, retention,
and deployment evidence. Uploaded recordings must pass the same access and
storage controls. Existing recording and summary storage alone does not satisfy
the automatic recap requirement.

Acceptance:

- An authorized recording produces a transcript and a recap through a bounded,
  retryable job with visible queued, running, failed, and completed states.
- Decisions and action items link to speaker/timestamp passages. Missing owners
  or dates remain unspecified until a person confirms them.
- The original transcript and reviewed corrections remain distinguishable from
  AI-generated interpretation.
- Publishing notes, sending follow-up mail, and scheduling an event are separate
  proposals subject to permissions and approval.
- Recording revocation, deletion, retention, and legal hold apply to transcripts,
  recaps, embeddings, and other derived artifacts as well as the recording.

### 2.4 Agent handoffs

An agent has its own identity, credential, mailbox where assigned, resource
permissions, and audit identity. Connecting to MCP does not create these grants.
Keep external agent access separate from Helix's built-in AI generation controls.
An external agent can use the platform without a Helix model connection.

Acceptance:

- Admin-created agents and resource access requests have complete instructions
  and observable status through the web, REST, MCP, and CLI.
- Registration, identity approval, resource grants, and action approval remain
  separate decisions. General first-time self-enrollment is a future flow until
  its identity and abuse controls are implemented.
- Delegated agents remain agents and never become a human principal. Preserve
  the earlier decision that delegated writes require the user's approval.
- Approval cards show the agent, intended change, recipients or targets, source
  context, expiry, and applicable policy. Agents cannot approve themselves.
- Expiry, revocation, policy changes, duplicate requests, cancellation, and
  completion are understandable to both a person and an automated client.

## 3 Administrator controls

Use the existing AI provider and cost-control foundation. Add only controls that
are enforced in their execution paths.

| Control                      | Required behavior                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable built-in AI           | New installations require explicit administrator setup and enablement. Core communication and storage remain usable when AI is off.                      |
| Enable individual features   | Mail assistance, catch-up, workspace retrieval, transcription, meeting recaps, and automation can be enabled independently.                              |
| Choose provider and model    | Permit supported hosted or private providers according to security-tier and data-classification policy. Validate connectivity before claiming readiness. |
| Control who can use AI       | Apply actor permissions and administrator policy to every surface, including direct API calls.                                                           |
| Control data sent externally | Enforce classification and allowed sources before provider requests. Show useful explanations when a source cannot be used.                              |
| Set spending limits          | Show usage and allow explicit workspace and actor caps, with consistent handling of exhaustion. No imposed commercial budget.                            |
| Choose automation level      | Offer suggestions, proposals awaiting approval, and explicitly delegated routine actions bounded by the existing policy model.                           |
| Control meeting capture      | Require recording/transcription settings, participant notice/consent, access, and retention configuration.                                               |

Disabling a feature must prevent direct API, MCP, CLI, SDK, and background-worker
execution. A hidden button is insufficient. Provider credentials remain outside
browser responses, agent prompts, source control, and audit payloads.

## 4 Quality requirements across the system

The review assumes the documented invite-only 5–50-user pilot, simultaneous
agents, the existing 100-socket Chat release profile, and hostile public mail.
Multi-tenant invariants remain mandatory even though public SaaS readiness is
outside the current release.

| Surface                    | Completion evidence                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web UI                     | Complete common workflows; semantic labels and keyboard focus; accessible light/dark themes; phone layouts; meaningful empty, loading, error, and recovery states; no inert controls.                    |
| Backend and jobs           | Correct tenant/actor authorization; durable writes; bounded memory and work; safe concurrency and retries; cancellation and crash recovery; useful operational errors.                                   |
| REST and contracts         | Published paths and schemas match runtime; consistent errors and pagination; authentication versus authorization distinguished; idempotency and version behavior tested.                                 |
| MCP                        | Standard client initialization and discovery; precise tool schemas; explicit pending-action states; bounded resource content; provenance and untrusted-content safeguards; expiry and revocation checks. |
| SDK                        | Accurate exported types and supported entry points; runnable examples; documented distribution and runtime requirements; compatibility with live API/tool contracts.                                     |
| CLI                        | Discoverable commands; correct exit codes and JSON mode; secure credential handling; approval continuation; safe retries; useful errors; install and upgrade instructions.                               |
| Mail and storage protocols | Real delivery and reply evidence; recipient/relay checks; provider feedback; attachment and scan paths; WebDAV/S3 behavior and documented limitations; retention and holds.                              |
| Infrastructure             | Pinned supported dependencies; verified TLS; encrypted storage; repeatable configuration; health and metrics; recoverable backups and explicit production evidence.                                      |
| Documentation              | One supported product scope; correct public endpoints; current admin and agent onboarding; provider/deployment troubleshooting; examples that execute against the implemented interfaces.                |

For each important workflow, follow the same input through the UI, API, MCP, CLI,
and supported SDK interface. Compare permissions, validation, pending approvals,
results, and failure states. Avoid implementing independent versions of business
rules for each channel.

### 4.1 Complete everyday journeys

- **Mail:** Keep the familiar conversation layout, readable white message canvas
  within either shell theme, clear sender and recipient details, and expandable
  quoted history. Support verified sender addresses and display names in the
  actual From header; a recipient client's display or spam placement remains
  outside Helix's direct control. Preserve drafts through delivery failures and
  expose meaningful queued, accepted, failed, and delivery-feedback states.
- **Drive and Chat:** Make upload progress, scan status, sharing permissions,
  room membership, unread state, failed sends, and recovery understandable.
  Confirm persisted results through a later request. Drive stays a storage
  product; downloading a file does not require adding a viewer or converter.
- **Calendar and Meet:** Verify time zones, daylight-saving transitions,
  invitations, responses, join links, and duplicate/retry behavior in the full
  profile. Unconfigured Meet explains the operator step required and preserves
  its credential, consent, recorder, and deployment gates.
- **Admin and account:** Connect invitation, first sign-in, optional authenticator
  QR setup, verified external-email MFA, recovery, and offboarding. Guided setup
  shows exact DNS records and independently checks delegation, domain identity,
  outbound signing/delivery, inbound delivery, storage/scanning, and backups.
  A saved setting reads back its effective state and distinguishes a pending
  restart from an applied change; concurrent updates cannot silently erase work.
- **Assistant and agents:** Clearly identify sources, actor permissions,
  generation state, pending proposals, expiry, completion, and failure. A human
  can review an external agent's action without assembling an API request.
  A disabled or unconfigured feature offers the appropriate setup explanation
  and has no executable bypass through another channel.

The [administrator guide](../../apps/web/public/admin-setup.md),
[agent guide](../../apps/web/public/agent-setup.md), and
[client installation reference](../reference/clients.md) must agree with these
journeys and the deployed interfaces. The provider-connection popup and delegated
AWS/Cloudflare changes remain in their separate proposal until implemented.

### 4.2 Visual refinement and component rules

Keep Helix's existing layout, Geist font, icon family, theme choices, and familiar
Mail composition/conversation structure. Apply the
[Taste existing-project skill](https://github.com/Leonxlnx/taste-skill/blob/main/skills/redesign-skill/SKILL.md)
as a focused refinement guide. Proposed polish improves sender/subject hierarchy,
row spacing, toolbar alignment, surface contrast, and clear loading/error states.
These suggestions do not authorize a new visual identity or a wholesale redesign.

The operator's component requirements are explicit:

- Use shared global CSS tokens for color, typography, spacing, radius, focus, and
  interaction states. Feature layout rules belong in the established styling
  system; repeated control styling should move to shared components/classes.
- Reuse the existing Button, Input, field, dialog, and layout primitives. Forms
  need consistent styled controls, labels, help, validation, and inline errors;
  native browser defaults must not become the product's form presentation.
- Use consistent, labelled **+ New** or **+ Add** actions for creation. Give icon
  controls accessible names and usable targets, including in collapsed navigation.
- Use inline editing, dedicated pages, or nonblocking panels for entering and
  editing data. Use modal dialogs for concrete confirmation and review decisions.
- Keep background updates local to the affected data. Preserve drafts, focus,
  selection, and scroll position; reserve skeletons for initial content loading.
- Verify light/dark themes and phone/tablet/desktop layouts in the browser, with
  keyboard focus and reduced motion. Reuse existing dependencies and tokens.

The sandboxed email document needs its own stylesheet because it cannot inherit
app CSS across the isolated iframe boundary. This serves the readable white mail
canvas and content-security policy; it is not permission to duplicate app controls
or introduce inline application styling.

### Cross-page live updates

Use one authenticated, actor-scoped workspace event stream per browser tab for
Mail, Chat unread counts, notifications, approvals, and app availability. Keep
the Chat WebSocket for typing, presence, and room interaction. Events should
invalidate only affected queries and preserve drafts, focus, selection, and
scroll. Reconnect must reconcile missed changes through a cursor or fresh reads;
polling remains a recovery fallback. Verify tenant and recipient isolation, role
changes, reconnects, and updates while another app is open.

The current implementation has Mail SSE and active-room Chat WebSockets, while
background Chat and notification counts poll every 30 seconds. The global badge
and startup-availability fixes improve this behavior, but a unified workspace
stream remains an implementation task; its instant cross-app behavior is not yet
claimed as delivered.

### Human action queue

Add a persistent **Action required** item with a pending count in the workspace
navigation and a nonblocking queue usable from any app. Show the requesting
agent, proposed action, safe preview, expiry, and its review link. Count current
authorized actions, independently of whether their notification was read.
Opening a notification or queue row never approves an action. Concrete review
offers Approve/Deny; expired requests leave the active queue. The backend must
limit every list, count, and decision to the human's authorized tenant and
approval role, then revalidate the requester and proposed action at execution.
Use the shared workspace event stream for queue updates and reconcile after
reconnect. Cover missed notifications, multiple agents, concurrent decisions,
expiry, mobile navigation, keyboard access, and preservation of open drafts.

The current bell receives approval notifications and all pending tool actions now
have a human review page, safe preview and source context. A dedicated action
queue, persistent navigation count and email reminders remain to be implemented.

## 5 Delivery sequence

### 5.1 Repairs identified in the current review

These are implementation batches with explicit evidence. The October 15 repair
follow-up in the system review records implemented fixes and remaining boundaries.
Finding numbers refer to the dated system review. The responsible maintainer
role identifies who needs to close each batch; no individual owner is assigned.

| Batch | Findings                   | Responsible role               | Acceptance evidence                                                                                                                                                                                                      | Status                                                                                   |
| ----- | -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Q1    | 1, 2, 6                    | Platform/agent maintainer      | Server-owned provenance after external reads; sensitive automation obeys policy; resource and tool reads share configured budgets and audit; bounded Mail pages and bytes.                                               | Implemented; source, shared-limit, audit and bounded-page regressions                    |
| Q2    | 3, 4                       | Authentication/API maintainer  | Rejected or failed OTP resends retain the usable challenge; concurrent requests cannot silently replace it; actual REST failures parse through the shared contract.                                                      | Implemented; maintained-plugin, PostgreSQL concurrency and HTTP regressions              |
| Q3    | 5, 11                      | Web/agent/client maintainer    | External agent request reaches its owner's browser review inbox; usable review URL, notifications, expiry and cancellation; runnable source-install CLI/SDK instructions.                                                | Review destinations and client docs implemented; dedicated queue/email reminders planned |
| Q4    | 7                          | Mail/provider maintainer       | Verified SES feedback correlates messages, deduplicates events, updates delivery state and enforces bounce/complaint suppression.                                                                                        | Adapter and provider UI implemented; live SNS topic configuration still required         |
| Q5    | 8, 9, 10                   | Mail/Drive protocol maintainer | Immutable SMTP peer fallback; measured or unsupported WebDAV quota properties; accepted sync methods, bounded streaming and real-client recovery scenarios.                                                              | SMTP identity and quota defects fixed; full desktop-sync feature remains planned         |
| Q6    | Production acceptance gaps | Operator/release maintainer    | Configured live-service and tenant-isolation suites; recurring encrypted off-server backups; restore of the selected artifact; dependency/image gates; load and soak; gated Meet media evidence when enabled.            | Development deferral; mandatory for relevant production claims                           |
| Q7    | 12                         | Web/component maintainer       | Creation/editing use inline forms, pages, or shared nonblocking panels; labelled + New/+ Add actions; shared styled controls and tokens; confirmation modals; keyboard, theme, responsive and draft-preservation checks. | Implemented; shared nonblocking panels and draft/focus/accessibility checks              |

The audit repaired the browser security-test collection regression, canonical
endpoint documentation, obsolete preview-conversion wording, and stale
third-party notices. These narrow corrections do not close Q1–Q6.

The reported SES conversation split and Mail reconnect catch-up were also fixed
and deployed to development. The existing conversation was repaired with audit
and rollback evidence; bounded reference anchors protect future SES replies.
Real PostgreSQL tests cover threading and repaired-link actor/tenant isolation;
browser tests cover new-mail and reconnect updates without reloading the page.
The review distinguishes these proofs from a fresh external Gmail round trip.

### 5.2 Feature delivery

1. **Repair current reliability and safety gaps.** Reproduce and resolve the
   highest-ranked findings in the dated system review. Preserve existing local
   work and the development deployment's explicit scope.
2. **Complete agent and administrator journeys.** Make setup, credentials,
   approvals, resource requests, error recovery, and machine-readable examples
   dependable before adding more autonomous behavior.
3. **Deliver Mail assistance and action suggestions.** Implement AI1 and AI2
   using existing hooks and common backend authorization, provenance, budgets,
   and approval paths.
4. **Deliver catch-up and sourced workspace answers.** Implement AI3 and expand
   AI5 with access-aware retrieval and reviewed sharing.
5. **Configure and prove meeting capture.** Complete the independently gated
   Jitsi/recorder deployment and transcript/recap pipeline before enabling AI4.
6. **Expand bounded workflows.** Deliver the combined recap-to-file-to-draft-to-
   Calendar workflow and AI6 handoffs using proven permissions and approvals.

Autonomous external sending and always-on recording are deferred from the first
AI release. Provider-assisted AWS/Cloudflare setup follows its
[separate proposal](../architecture/provider-assisted-setup.md).

## 6 Completion gates

Run focused regressions for every behavior changed, then the repository's required
`pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and
`pnpm quality:boundaries`. Web changes also require relevant Playwright and
accessibility checks. Validate supported tenant modes and real services where a
mock cannot prove the behavior.

Record each finding as open, fixed with evidence, or an explicit owned and bounded
deferral. Do not mark a planned feature complete because a type, hook, mock, UI
control, or documentation entry exists. Release claims require their complete
user journey and the corresponding live evidence.

For AI generation, keep a small reviewed evaluation set covering real thread
summaries, multilingual replies, unsupported commitments, missing owners/dates,
incorrect citations, private-source sharing, and prompt-injection attempts.
Evaluate it before provider/model changes as well as before a release. Record
quality failures separately from delivery or authorization failures.

The current Hetzner environment remains development. This plan does not authorize
production promotion or replace the signed production evidence, recurring
off-server backup contract, restore drill, load/soak, and dependency gates.

## Provider administration refinement — 2026-10-15

AI providers and their models use the shared TanStack Admin table, with search, sortable columns,
status, explicit row actions, and nonblocking add/edit panels. Preserve server-seeded drafts,
write-only credentials, provider protocols and cloud-managed settings. Native Anthropic currently
supports text chat; tool-calling parity still requires implementation and provider-backed tests.
Bedrock and Vertex deployment-managed connections remain visible without offering an incomplete
credential editor. Additional OpenAI-compatible endpoints can use the existing URL/model setup.

Mail providers receive the same list/panel treatment, plus Resend and SendGrid SMTP setup presets.
Native feedback adapters and provider-account authorization/DNS automation remain separate roadmap
work, with scoped credentials and reviewable changes. Do not describe SMTP presets as native API
integrations.

Spam decisions retain dedicated Clef/Jev settings, independent credentials, shadow/enforce modes,
confidence thresholds and reporting. The optional LLM spam route now has explicit provider/model
controls on the same Mail settings page. Provider failures must preserve local safety decisions;
malformed responses cannot become trusted verdicts. Evaluate false positives on a labelled mail
corpus before enabling enforcement. Contract tests and synthetic fixtures do not establish real-world
classification accuracy or prove live provider access.

## Review repairs and mail AI — 2026-10-15

Mail assistance now has a shared `mail.ai.suggest` tool for compose, rewrite,
reply, and summary. The web composer and conversation view use the same tool
as MCP and REST. CLI clients can invoke it with `helix tool call`; input/output
schemas and TypeScript types live in `@helix/contracts`. Enable **AI email
assistance** in Admin → Mail → General after configuring a provider. It defaults
to off and also gates background mail entity extraction. Spam classification
remains under its separate administrator policy.

The server loads the caller's own thread, checks stored and content-derived
sensitivity, and refuses oversized or truncated context instead of silently
summarizing a partial thread. Attachments are not included. Output is plain text
for review; it does not send or save. The UI preserves a changed draft and asks
for regeneration before replacement. `mail.draft.save`, `mail.send`, and
`mail.reply` retain their existing authorization and human-approval policies.

Agent example:

```sh
helix tool call mail.ai.status --json '{}'
helix tool call mail.ai.suggest --json '{"action":"reply","threadId":"YOUR_THREAD_UUID","instructions":"Keep it brief; do not promise a date."}'
```

Use `action: "compose"` with `subject`, `body`, and optional `instructions` to
start a message; `rewrite` edits existing text, and `summarize` requires a thread.
There is no client-supplied classification or mailbox-owner override.

Interrupted outbound deliveries now enter the existing dead-letter review list.
Before replaying, check the provider's delivery evidence: SMTP cannot guarantee
exactly-once delivery, and a replay may send a duplicate. Known transient SMTP
rejections remain retryable. A lost worker lease is never evidence of rejection.

The review also repairs private event delivery, permission-bound result replay,
commit-before-success ordering, transient MCP errors, saved AI budgets, and
atomic AI cost reservations. Unknown provider charges retain their estimate;
actual usage replaces it when reported. This is spending control, not a promise
that a provider's final bill cannot differ from an estimate. Translation,
meeting recaps, workspace catch-up, and the remaining AI roadmap are not marked
complete by this change.

## Protocol and desktop sync validation — 2026-10-15

Real rclone testing found and fixed unsupported request content types, missed same-size
edits, unsafe configuration replacement on cancelled setup, and conflict handling that
assumed WebDAV MOVE/COPY support. Setup now preserves the working connection until the
replacement succeeds. Mirror sync checks contents, keeps conflicting versions, and can
recover after a killed process once its stale lock expires. Existing comparison baselines
require an explicit resync; the helper does not silently resurrect deleted files.

Live AWS SDK S3 tests cover signatures, permission denials, reads/writes, pagination,
presigned URLs, ranges, copy, multipart complete/abort and deletion. Cloudflare's workspace
API cache-bypass rule fixes signed HEAD conversion. The deployment accepts 100 MiB in
one request and rejects 101 MiB at Cloudflare; multipart passes at Helix's 128 MiB maximum
and rejects a cumulative 129 MiB. WebDAV and S3 EICAR fixtures were detected and quarantined
by ClamAV. Scanning is shared with the HTTP/MCP upload path.

CalDAV/CardDAV tests exposed proxy compression changing strong ETags and an ungrouped
CardDAV address-book predicate bypassing resource/deletion filters. Both are repaired;
conditional edits, stale-edit rejection, incremental sync and deletion now pass. The
CardDAV regression also runs against PostgreSQL with multiple contacts to ensure a
delete affects only its target. WebSocket authentication, rejected private-chat generic
subscriptions, mailbox SSE, and live Assistant SSE pass.

The five-minute authenticated MCP read test completed 1,525 requests without errors
(p95 324 ms). AI compose/rewrite/reply/summary and CLI generation used the configured
provider; a zero-budget check blocked the call with an actionable error. Temporary
credentials were revoked, test actors disabled, and pending test approvals cancelled.
Atlas remains active. Full results, test counts, backup-restore scope and outstanding
acceptance limits are in [protocol validation evidence](../reviews/evidence/2026-10-15-protocol-sync-validation.json).

The desktop helper remains a command-line setup with manual or scheduled sync, not an
installed background service. Hash comparison over plain WebDAV downloads files and can
consume significant bandwidth. A hard-stop recovery can preserve both versions as a
conflict requiring review. Native Windows/macOS mounts and multi-participant Meet media
still need separate device acceptance tests.

## Authorization and development recovery — 2026-10-15

Deployed API `security-r12` closes the stream authorization gaps found in the
Internet-exposure review. Mail SSE rejects anonymous access and caps connections;
Mail, generic events and Chat refresh credentials before relevant delivery or
incoming frames. Chat requires current read/post scopes as appropriate. Browser
session resolution bypasses per-request caching on long-lived transports. Public
revocation checks passed, as did 56 configured database security checks and all
required repository checks. Atlas remains available for continued testing.

Encrypted daily backups now run from the operator's machine at 03:30 UTC with up
to five minutes of jitter. They briefly stop the development services, stream the
snapshot over SSH directly into age encryption, authenticate the resulting
archive and restart services. The first run and a subsequent host reboot/unlock
check passed. Storage keys remain off-server; reboot recovery therefore requires
the operator's machine. These are development recovery measures, not completion
of the production backup and failover gates.

Operator commands on the machine holding the keys:

```sh
systemctl --user list-timers helix-development-backup.timer
systemctl --user status helix-development-backup.service
journalctl --user -u helix-development-backup.service
python3 ~/.local/share/helix-workspace/89.167.14.138/bin/recover-after-reboot.py
```

The recovery command is for an already rebooted server reachable over SSH; it
unlocks the existing encrypted volume and starts the services. It does not
restore an archive. Backup status and encrypted archives live under
`~/.local/share/helix-workspace/89.167.14.138/evidence/` and `backups/`. Preserve
the local `keys/` directory securely. The timer catches up after the local user
service manager starts, so a missed backup may pause development services outside
the normal window. Backups currently accumulate without automatic pruning.

Still required for production acceptance: an independently available backup
destination, actionable failure alerts, a full application restore drill, an
agreed reboot/unlock availability policy, the remaining cross-interface sharing
matrix and fresh image/host scanning. Keep production gates enabled and prove
their requirements before switching this deployment out of development mode.
See [stream and recovery evidence](../reviews/evidence/2026-10-15-stream-security-validation.json).

## Mail storage growth — implementation, 2026-10-15

Full immutable mail text/HTML now use compressed, verified objects in the existing
tenant storage path. PostgreSQL retains private content references, mailbox and
thread metadata, previews and active drafts. Runtime reads cover mail rendering,
REST/MCP/CLI, delivery queues, scheduled sends, spam decisions, AI and search.
Inbox lists remain metadata-only. Durable search mutations and optional vector
metadata no longer retain another full copy of new message bodies.

The resumable backfill preserves existing journal/review evidence and legal holds;
new journal and eDiscovery snapshots include body references and integrity hashes.
Retention cleanup, quota accounting, tenant storage migration and backup inventories
include the new representation. See the [migration runbook](../runbooks/mail-body-storage.md)
for rollback requirements, search semantics and operational limits.

[Validation and deployment results](../reviews/evidence/2026-10-15-mail-body-storage-validation.json)
confirm the live `mail-storage-r15` deployment, migration of 24 original messages,
agent access and isolated database/body recovery. This change does not
make the development installation production-ready or eliminate metadata, vector,
retained audit or object-store growth. Separate database instances and sharding
remain deferred until measured workload requires them.

## Development validation progress — 2026-10-15

The earlier open core application restore, fresh image/host scanning and expanded
S3/WebDAV sharing checks now have results in the
[development completion evidence](../reviews/evidence/2026-10-15-development-completion-validation.json).
API `security-r13` and patched optional service images are deployed. This closes
those development validation tasks, with explicit limits: same-host core recovery,
fixture-backed sharing tests alongside earlier live protocol evidence, and
remaining upstream High/Critical vulnerabilities. The mail resolver's post-reboot
startup cycle was also repaired; recovery now verifies mail DNS.

Do not mark the full production gate or future feature roadmap complete. Independent
backup availability/alerts/pruning, new-host recovery, multi-participant media,
long-duration load, upstream vulnerability resolution and release promotion remain.

## Mail migration index recovery — 2026-10-15

Deployed `mail-storage-r16`: backfill now queues a search refresh atomically with
each migrated message, so canonical plain text also replaces old HTML search
content and AI passage offsets. Refresh references remain body-free and scoped
to authorized mailboxes. All 25 live projections refreshed; MCP/CLI and human
reads passed. See [validation evidence](../reviews/evidence/2026-10-15-mail-index-recovery-validation.json).

## Prepared-reply concurrency qualification — 2026-10-19

Four new PostgreSQL integration cases use the real mailbox, draft and artifact
stores under the runtime RLS role, with a controlled AI boundary. They prove one
model call across concurrent preparation, preservation of a separately edited
human draft, rejection after new mail arrives, AI-off rechecking before persistence,
and a lease replacement that prevents stale workers overwriting current output.
Another mailbox actor cannot read the private artifact or prepare that thread.

All 37 targeted PostgreSQL cases passed. The full ordinary suite passed 5,732
tests with 442 environment-gated skips; format, type, lint, build and dependency
boundary checks passed. These checks do not activate hosted native AI or qualify
real provider generation, attachment filing/scanning after folder revocation,
or live meeting transcription/recaps. Private logs are under
`~/.local/share/helix-recovery/20261019/integration-completion/productivity-*`.

## Destination revocation during filing — 2026-10-19

Real PostgreSQL regressions exposed that a prepared upload's creator could still
publish it after losing access to its destination folder, including during an
asynchronous scan. The shared upload authorization now rechecks permission to add
children until a first Drive version is committed. This covers attachment filing,
ordinary finalization, multipart completion and scan commits. An infected verdict
cannot erase the restriction; successful existing files retain their ownership
and idempotent receipts.

Four new runtime-role database cases passed, with controlled storage and scanner
verdicts; 45 targeted database tests passed in total. The full ordinary suite passed
5,732 tests with 446 environment-gated skips; format/type/lint/build/boundaries passed.
API `cab9432` is deployed and ready, with an authenticated encrypted rollback dump.
No schema migration or web-image change was needed. Native AI remains off; this
does not qualify provider generation, an entire live filing workflow, or Meet media.
