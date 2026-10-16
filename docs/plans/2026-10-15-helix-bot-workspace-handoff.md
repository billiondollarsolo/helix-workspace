# Helix Bot → Helix Workspace implementation handoff

Updated 2026-10-16. **Helix Bot is the new name of Chungus.** This handoff is for
its implementation agent. The user wants persistent bots with their own email,
Chat, file storage and other Workspace capabilities, including personal assistants,
background routines, shared projects and coding workflows. Coding is one workload.

## Read first

### Routine collaboration (2026-10-16)

An approved bot uses its own credential and ordinary resource permissions, like
a human collaborator. The installation credential remains enrollment-only.

- Open/reuse a direct or group-direct conversation with `chat.dm.open`, input
  `{ "memberActorIds": ["<workspace-actor-id>"] }`. It requires `chat.post`,
  includes the caller, permits only internal active members, and deduplicates
  identical participant sets. CLI: `helix chat dm --json ...`. Send and poll with
  `chat.send` and `chat.message.list`; no human confirmation for ordinary messages.
- Managed room creation and invitations use `chat.create_room` / `chat.invite`
  and the separately approved `chat.create` scope. That scope is now available
  in new bot-account manifests. Existing 15-scope accounts can use `chat.dm.open`
  without silently expanding their credentials.
- `mail.send`, `mail.reply` and `mail.forward` run unattended when **all** explicit
  To/Cc/Bcc recipients resolve to mailboxes in the sender's tenant with no routing
  rules. Include a stable `idempotencyKey`. Agent replies must list recipients;
  they do not use implicit reply-all. Internal authorization is persisted as
  local-only delivery: changed routing fails delivery instead of sending outside.
  External/mixed recipients still enter the approval flow.
- Drive folder creation, upload/finalize (including multipart), copy, rename,
  moves, reversible trash/restore, comments and internal sharing use granted
  scopes without per-action approval. Files remain private until their owner
  deliberately calls `drive.share`; only authorized owners can grant/change/revoke
  access. Shared folders convey their existing inherited roles. Storage quotas,
  malware checks, DLP, read/write roles and tenant isolation still apply.
- Mail read/unread, stars, labels, snooze, archive/restore and cancellation are
  routine mailbox operations. Mail delegation, permanent file deletion, public
  links, credential/admin changes and other non-routine tools keep their gates.
- An explicit credential `confirmationOverride: "always"` still forces review.
  Emergency controls and DLP may also block or require review. Always inspect
  structured `pending_confirmation` responses; don't assume every write succeeds.

Use actor IDs returned by enrollment to connect the approved bots. Neither Bot
installation trust nor approval makes one bot's private files/mail visible to
another. Humans and bots exchange messages and receive deliberate file grants;
human observer access remains a separate administrator-managed capability.

- **Running local stack, trusted installation setup, private HTTP, Compose and Kubernetes:**
  [connection runbook](../runbooks/helix-bot-local-development.md).

- New work: [account requests and human oversight](#account-requests-and-bot-oversight--local-integration-contract),
  [native mail tools](#native-mail-productivity-integration), and
  [acceptance tasks](#additional-bot-and-workspace-acceptance-tasks).
- Live Workspace contract: <https://workspace.helixapps.si/agent-integration.md>.
- General setup: <https://workspace.helixapps.si/agent-setup.md>.
- Workspace source: `/home/mj/mjcode/helix-workspace`.
- Bot source: `/home/mj/mjcode/chungus-all`.
- Bot's existing plan: `docs/plans/helix-bot-workspace-integration.md` in that repo.
- Catalog: `/home/mj/mjcode/chungus-extensions/catalog/helix-workspace.json`.

This is a source-based compatibility review and task list, not evidence of a
completed Bot connection. The original 2026-10-15 review inspected Bot HEAD `981f1e8c2e333c1d59decc7e2a7f72e8f5ac9e8e`
and Workspace HEAD `aa4d2da67c37a851a3ce1a89c24fd307073f5be1`, **plus both working
trees**. They contain active uncommitted work; HEAD alone does not identify the
reviewed implementation. Recheck the named functions before editing. The
2026-10-16 update below documents the new local account-request, oversight and
mail-productivity contracts; it does not revalidate those earlier live findings.
No Bot or extensions files were changed and no credential was installed in Bot.

## Product contract

Each independently authorized, persistent bot maps to its own Workspace agent
actor, scoped credential, human owner/approver and provisioned resources. A display
name is not identity. Keep the mapping across restarts and credential rotation.

| Bot capability                             | Workspace responsibility                                                                                    | Bot responsibility                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Own email address and inbox                | Verified domain, address assignment, inbound policy/quarantine, mailbox, drafts, send approval and delivery | Select the correct account; read safe authorized content; compose, follow pending actions and report actual delivery state |
| Direct and shared Chat                     | Room membership, messages, threads, history, unread state and live events                                   | Route to the correct bot/conversation; run its model; send one reply in the correct room/thread                            |
| Private files and shared project artifacts | Actor/resource authorization, folders, revisions, quotas, scanning, retention and sharing                   | Upload/read using supported tools; preserve source identity; distinguish private files from explicitly shared artifacts    |
| Calendar and other enabled tools           | Tool schemas, scopes, resource permissions and action policy                                                | Discover only authorized capabilities, preserve timezone/attendees and follow write approvals                              |
| Presence and status                        | Expiring connection/activity leases and user-selected status                                                | Report actual idle/working/waiting states; stop renewing on disconnect                                                     |
| Goals, schedules and teams                 | Authorized tools, durable event inbox, audit and human review                                               | Own orchestration, budgets, model selection, delegated work, context and recovery                                          |
| Coding, terminals, browsers and previews   | Store/share resulting authorized artifacts and messages                                                     | Keep execution, snapshots, review/apply, terminal/browser authority and Git credentials in Bot's existing isolated runtime |

Set hosting to **External agent app** for these identities. Workspace must not run
a second model for the same bot. Atlas is already Helix-hosted; do not reuse its
identity or credential. An external model needs no `assistant.write` unless it
explicitly uses Workspace Assistant as a separate capability.

Distinguish **a bot's own account**, **a human's connected account**, and **a shared
project account**. Connecting a person's mailbox does not make that person's
identity the bot. Never merge tokens, permissions or private history because
accounts have matching names. Delegation may pass scoped task context, not copy
an owner's credential to every child agent. Ephemeral subtasks need explicit
parent authority; they do not automatically get a new mailbox or new permissions.

## Local private-HTTP connection update — 2026-10-16

Workspace is running locally with an installation-only credential. Start with the
[local connection runbook](../runbooks/helix-bot-local-development.md); `setup.env`
is the installation connection. Beacon is only a provisioned test fixture.

The initial read of Bot's working tree found that the modern HTTP MCP request builder
now exists, so the original handshake finding below is historical. Set the HTTP
connection's `protocolVersion` explicitly to `2026-07-28`; the default remains
`2025-11-25`. Catalog/discovery changes from the original review have not all been
requalified against the running Bot app.

- [ ] Add explicit administrator-controlled trust for an internal Workspace
      connection. `configuration()` in `apps/server/connections.ts` and `http()`
      in `apps/server/connection-adapters.ts` currently reject plain HTTP.
- [ ] Select `node:http.request` for that approved internal endpoint; the adapter
      currently imports only `node:https.request`. Keep HTTPS as the default for
      ordinary external connectors, and keep endpoint changes/redirects from
      receiving the old credential without authorization.
- [ ] Store the installation key outside model context. Its scopes are
      `platform.read` and `agent.accounts.request`; individual bots receive their
      own approved credentials, not this key.
- [ ] Test direct Compose and Kubernetes service URLs, the actual cluster policy,
      modern MCP discovery, denied mailbox access for the installation, and
      denied enrollment authority for ordinary bots.
- [ ] If using the stdio adapter, fix its hardcoded `2025-11-25` handshake too.
      Workspace's CLI bridge is available, but Bot-to-bridge interoperability is
      not established merely by selecting stdio.

No sibling Bot files were edited. Workspace CLI/REST/MCP verification is evidence
for the Workspace endpoint, not a claim that the full Bot application is connected.

## Findings from the original Bot review — recheck before editing

### 1. MCP handshake mismatch — reproduced against live Workspace

`apps/server/connection-adapters.ts`, function `mcp`, starts with
`MCP-Protocol-Version: 2025-11-25` and `initialize`. Workspace currently supports
`2026-07-28`, `2025-06-18` and `2025-03-26`. The exact initial request shape returns
**HTTP 400: Unsupported MCP protocol version**; it never reaches tool discovery.

- [ ] Implement the current `2026-07-28` contract from the live guide, including
      `server/discover`, per-request metadata and matching `Mcp-Method`/`Mcp-Name`.
- [ ] Keep legacy negotiation isolated for other providers. A temporary explicit
      `2025-06-18` configuration can establish legacy tool access, but does not
      implement the requested modern live subscription path.
- [ ] Test both protocol paths and errors. Do not silently label legacy as latest.

### 2. Discovery and response limits reject a normal Workspace catalog

The same function allows only **20 catalog entries across three pages**. Its HTTP
reader permits **65,536 response bytes**. A read-only live check with Atlas's
existing scoped credential returned **155 tools / 112,298 JSON bytes**, without
`nextCursor`. These are observed values for that identity, not a universal count.

- [ ] Support bounded catalogs large enough for Workspace; keep response/time and
      schema limits explicit and independently test oversize failures.
- [ ] Use scopes and Bot tool selection to restrict model exposure. Never truncate
      a received catalog silently or request an administrator key to discover more.
- [ ] Handle pagination where supplied. Pagination alone does not fix the current
      20-entry total cap. Workspace currently returns its tool catalog in one response.
- [ ] Keep schema/version pinning and sanitized output. Test structured tool results,
      `isError`, resource text JSON, pending-action responses and transport failures.

### 3. Blanket Bot approvals conflict with ordinary conversation

`apps/server/connection-tools.ts` stages `connection_mcp_call`, resource reads and
prompt reads for original-human approval. Workspace can already authorize ordinary
text Chat immediately through scope and active membership. Requiring a second
approval on every Chat reply or routine read prevents the intended experience.

- [ ] Add an explicitly reviewed Workspace connection/tool policy using existing
      Bot grants. Authorized reads and ordinary text Chat should execute within
      that standing grant, without a fresh confirmation on every call.
- [ ] Preserve Workspace's DLP, attachment, source-provenance and explicit
      always-require-approval policies. A `readOnlyHint` alone is not authority.
- [ ] Preserve `pending_confirmation`, action ID and `reviewUrl` as structured
      state. Show the Workspace review link; poll `actions.get` or react to
      `approval.updated`. Bot confirmation is not Workspace approval.
- [ ] Distinguish pending, approved, executing, executed, failed, expired and denied
      outcomes as actually returned. A successful HTTP/tool receipt is not proof
      an email was sent. Do not rerun the original send after human approval.

### 4. Current connection tools require a live administrator session

`connection-tools.ts`'s `authority` rejects a null `session_id`, scoped/token
operations, nonhuman principals and people outside owner/admin roles.
`connection_invocations` in `connection-adapters.ts` requires an auth session.
This cannot serve an ordinary member's assistant or an authorized overnight bot.

- [ ] Integrate with Bot's existing explicit, revocable service grants for
      background work; do not fabricate a human session or remove the checks globally.
- [ ] Bind each dispatch to the installation, account, bot/project, current grant
      revision, credential version and budget. Recheck revocation before dispatch.
- [ ] Support ordinary users' own explicitly granted accounts without granting
      access to installation-wide credentials or other users' accounts.
- [ ] Prove authorized work after human logout, plus denial after grant/owner/account
      revocation. Manual session authority and background service authority differ.

### 5. Receiving events needs a durable adapter, not one MCP call per turn

The inspected generic MCP adapter opens a session for an operation and closes it;
it has no Workspace `subscriptions/listen` event-to-model loop. Bot's own integration
plan correctly leaves this work unchecked.

- [ ] Add a server-owned listener using the documented subscribe-before-catch-up
      sequence, durable cursor, bounded queue and idempotency keys.
- [ ] Route DM/mention/mail events to the exact linked bot/account. Check current
      source authorization before reading content or invoking a model.
- [ ] Handle reconnect, page draining, stale cursor reset, credential rotation and
      revocation. Never spin model calls while idle or turn revoked access into retries.
- [ ] Ignore own messages, suppress duplicate events and bound agent-to-agent loops.
      Serialize each room/thread; keep independent conversations isolated.
- [ ] Renew self presence about every 25 seconds. Use actual runtime state; a live
      socket is not a read receipt. Background budgets still apply to automatic turns.

### 6. OAuth UI setup and bot credentials are separate delivery paths

Bot's `apps/server/mcp-oauth.ts` already implements PKCE/account lifecycle; older
`docs/reference/protocol-validation.md` says OAuth is absent and needs updating.
The code requires an HTTPS `/mcp-oauth-callback.html`. Its canonical development
origin remains `http://10.10.69.200:43920`, so that callback flow is blocked today.
Workspace advertises authorization-code, client-credentials and refresh grants,
S256, and public/confidential client auth. Advertisement is not end-to-end proof.

- [ ] For initial bot-owned accounts, securely install an administrator-issued,
      expiring Workspace agent credential through Bot's existing secret store.
      This does not require browser OAuth or a public Bot callback.
- [ ] For user-connected accounts, configure a trusted HTTPS Bot origin and register
      the exact callback/client; qualify metadata, PKCE/state, consent, renewal and
      revocation. Preserve existing instance/session configuration rules.
- [ ] Keep installation trust/operator configuration separate from personal account
      selection and bot grants. No arbitrary MCP URL or launcher from model output.
- [ ] Never copy Workspace browser sessions or use a human token as the bot identity.

### 7. File storage is broader than Bot's private composer attachments

Bot's `docs/reference/attachments.md` and attachment implementation limit private
composer input and restrict it to the human owner. Its MCP adapter handles bounded
text/structured output; this is not a bulk-file transfer channel. Coding snapshots
also have independent limits and review semantics.

- [ ] Use Workspace's upload preparation, signed-byte transfer, finalization and
      scan result for artifacts; use authorized retrieval and revision checks.
- [ ] Keep signed URLs short lived and out of model prompts/logs. Preserve exact
      signed headers, origin/redirect restrictions, byte limits and checksums.
- [ ] Keep shared project artifacts out of human-private attachment/memory paths.
      Every later read rechecks account and resource permissions.
- [ ] Expose references and bounded content to models; do not put whole repositories,
      binary files or large mail bodies into MCP result text.
- [ ] Do not map Workspace Drive directly onto the coding runtime's mutable source
      tree. Import/export must retain source hashes and reviewed apply boundaries.

## Workspace provisioning and ownership

Existing administrative surfaces already separate the following steps:

1. Human admin creates an agent at `POST /v1/api/admin/agents`.
2. Admin issues its scoped, expiring credential and chooses approval ownership.
3. Admin assigns its address and inbound policy at
   `PUT /v1/api/admin/agent-mail/:id`. The domain must be verified and mail-enabled;
   address uniqueness and allowed senders are enforced. This is not the human
   `/admin/users/:actorId/addresses` route.
4. Admin grants Chat membership and authorized Drive folders/resources, configures
   limits, and leaves model hosting External. Creating an actor alone does not do
   all these things. Use this manual path until the new account-request flow below
   is deployed and qualified; there is no anonymous self-enrollment.

Start with `platform.read`, `notifications.read`, `chat.read`, `chat.post`;
add `mail.read`, `mail.send`, `mail.external`, `drive.read`, `drive.write` and other
permissions only as needed for chosen tools. Scopes are necessary but do not replace
resource grants, scan state, approval policy or tenant isolation. Agent mail policy
can quarantine a message before the agent sees it; do not bypass it to wake a bot.

**New local alternative:** the account-request flow below consolidates identity,
credential activation, mailbox assignment and owner observation access. It does
not yet request or provision existing room/folder grants, custom quotas or every
optional app. Keep those administrative steps explicit. Discover the deployed
contract before selecting either path; never write directly to Workspace's DB.

## Acceptance tests before marking the catalog entry available

- [ ] New dedicated Bot identity; discover tools and read through its own credential.
- [ ] Send human DM and threaded reply: one correct Bot response, no ordinary-chat
      approval, accurate activity/presence, visible Workspace unread indicators.
- [ ] Send permitted inbound email to that bot: correct mailbox/thread and one
      intended model turn; disallowed/quarantined messages do not reach the model.
- [ ] Draft external mail, obtain a real Workspace human approval, send exactly once
      and verify receipt in the approved test inbox. Pending must not mean sent.
- [ ] Upload/read/edit/delete a permitted small file and a larger artifact; verify
      hashes, conflicts, scan-pending/infected denial, quota errors and retained audit.
- [ ] Two bots and two human accounts: deny cross-mailbox, cross-project, guessed
      file IDs and cross-tenant reads; explicitly shared artifacts work as granted.
- [ ] Disconnect/restart during delivery and approval; catch up once without duplicate
      replies, sends or model turns. Test stale cursor and ambiguous write results.
- [ ] Rotate/revoke credentials, remove room membership and revoke Bot account grants;
      existing listeners and queued work stop using withdrawn authority.
- [ ] Explicit background grant works after logout; no grant means no background work.
- [ ] Remote coding/subagents use only approved task context and tools; no credential
      appears in source snapshots, terminal environment, transcripts or exported reports.
- [ ] Personal calendar account selection and timezone/attendee handling, followed by
      approved writes; do not infer Calendar readiness from a successful Chat test.
- [ ] UI: + Add connection, named accounts, scoped bot grants, actionable errors,
      Workspace review links, reconnect/revoke; shared controls and no blocking edit modal.

Keep `catalog/helix-workspace.json` planned/unverified until the actual Bot adapter
passes. Update that catalog entry's obsolete documentation URL to the live guide
when preparing its next reviewed release; preserve signed release/version rules.

## Evidence and boundaries of this review

Confirmed by source inspection: protocol/capacity/approval/session restrictions,
existing OAuth implementation and HTTPS callback gate, distinct bot mail provisioning,
and ownership boundaries above. Confirmed with authenticated **read-only** requests
on the development Workspace: Bot's initial handshake fails with HTTP 400; modern
discovery, `platform.ping` and durable event reads succeed; catalog size exceeds
Bot's current limits. Existing Atlas credentials stayed in the private local store.

No live Bot connection, new identity enrollment, OAuth consent, background routine,
file transfer or external send was executed as part of this compatibility review.
Prior Atlas/Workspace tests are useful evidence for Workspace, not a substitute for
these cross-application acceptance tests. Neither sibling repository was modified.

## Account requests and bot oversight — local integration contract

**Status on 2026-10-16:** code and UI are present in the local Workspace working
tree and running local development stack. The local enrollment and approval
path has been exercised; public deployment remains separate. These are concrete
integration instructions for the Bot agent, not a claim that the new tools exist
at `workspace.helixapps.si` yet. Check deployed discovery before calling them;
absence means use the manual admin path above or show “awaiting Workspace update.”

Source of truth:

- [Request schemas](../../packages/contracts/src/bot-accounts.ts).
- [Account tools](../../apps/helix/src/platform/bot-accounts/tools.ts),
  [approval store](../../apps/helix/src/platform/bot-accounts/store.ts) and
  [read-only workspace reader](../../apps/helix/src/platform/bot-accounts/workspace.ts).
- [Account migration](../../apps/helix/src/db/migrations/0237_bot_accounts.sql).
- [Admin review UI](../../apps/web/src/features/admin/bot-account-requests.tsx) and
  [human oversight UI](../../apps/web/src/features/bots/workspaces.tsx).

### Enrollment lifecycle and credentials

1. A human administrator establishes trust in the Bot installation and securely
   installs an expiring setup credential with `platform.read` and
   `agent.accounts.request`. This is a separate
   principal from any requested bot. Enrollment is authenticated; do not request
   an admin key, use a browser session, or expose an anonymous registration tool.
2. Bot chooses a stable `externalBotId` for one persistent identity. Generate an
   API key as `helix_ak_` followed by 32 cryptographically random bytes encoded as
   unpadded base64url. Persist the complete key in Bot's secret store **before**
   requesting enrollment. Hash the complete UTF-8 key, including its prefix,
   using SHA-256; submit only the 64-character lowercase hex digest as
   `apiKeyHash`. Keep the key out of model context, logs, manifests and UI output.
3. Submit `agent.account.request` using the setup credential. Store its request
   ID, returned review URL, external ID and original manifest alongside the
   secret reference. The request creates no working bot credential or account.
   Installation trust authorizes this submission immediately by default. There
   is one human enrollment decision: reviewing the account and its permissions.
   An explicit credential `always` confirmation override can still require a
   preliminary action confirmation; do not configure that override for normal
   installation enrollment.
4. A Workspace human admin reviews the request, chooses an active human owner,
   may reduce scopes and change the proposed address, then approves or rejects.
   Mail requires a unique address on a verified, mail-enabled domain. Disabled
   apps must be enabled separately or removed from approval. A bot principal
   cannot approve, even if someone mistakenly grants it an admin scope.
5. Poll `agent.account.request.get` with the **same setup principal**, using
   bounded backoff and jitter. Show the review link while pending. The current
   code notifies human reviewers, but does not establish a dedicated installation
   subscription contract; keep polling as the authoritative state transition.
6. On `approved`, persist `actorId`, `credentialId`, `ownerActorId`,
   `approvedScopes`, `approvedEmail` and `credentialExpiresAt` as authoritative. Approval is intended to
   create the identity, assign its mailbox, activate the committed key hash and
   grant its owner read-only oversight in one transaction. Use the locally held
   key for this bot's discovery and work. It authenticates as the new bot; the
   setup credential remains confined to enrollment/status operations.
7. Discover only what that bot can actually use. Add explicitly approved room
   memberships, folder sharing and other resource grants through their existing
   administrative flows. Confirm External agent app hosting before connecting
   its event-to-model loop so Workspace does not also run a model for that bot.

There is **no claim endpoint or server-delivered raw key** in this implementation.
The earlier proposed claim-secret design is superseded by local key generation
and approval-time activation. If the local key is lost, an administrator must
issue/rotate credentials through the existing protected flow; do not create a
second account as recovery.

Request status is `pending`, `approved`, `rejected` or `expired`. Pending requests
expire after seven days. The returned `expiresAt` is the **request deadline**,
not the activated credential's expiry. The admin chooses credential expiry
(within 366 days); that expiry is not yet included in the request receipt.
`approved` records enrollment history and is not proof a credential remains valid:
stop on revocation/expiry/disabled-account errors and request operator recovery.

Retries with the same setup actor, external ID and identical manifest/key hash
return the same request. Changed fields or a new hash under that ID conflict;
rejected/expired requests are not silently reopened. Escalate those states to the
operator rather than continuously generating identities. Current limits are ten
request calls per setup actor per hour and fifty new requests per tenant per day.
Honor rate limits and `Retry-After`; use one stable REST idempotency key for retries
of the same logical write.

### Request manifest and supported access

The request schema is strict. It accepts only `externalBotId`, `displayName`,
`purpose`, optional `email`, `scopes` and `apiKeyHash`. Example below uses an
explicitly invalid hash placeholder: replace it with the digest computed locally.
It contains no actual credential.

```json
{
  "externalBotId": "helix-bot:operations-assistant",
  "displayName": "Operations Assistant",
  "purpose": "Handle authorized conversations, organize files and prepare replies for review.",
  "email": "operations-bot@workspace.helixapps.si",
  "scopes": [
    "platform.read",
    "notifications.read",
    "notifications.write",
    "chat.read",
    "chat.post",
    "mail.read",
    "mail.write",
    "mail.send",
    "mail.external",
    "drive.read",
    "drive.write",
    "calendar.read",
    "calendar.write",
    "meet.read",
    "meet.write"
  ],
  "apiKeyHash": "REPLACE_WITH_SHA256_OF_THE_LOCALLY_STORED_KEY"
}
```

This lists the current allowed scope set, not a recommended default grant. Start
with the capabilities the bot needs. A “full account” requests all supported,
enabled apps; it never means administrator authority, wildcard scopes or access
to everyone's mail/files/chat. Passwords, Assistant, custom quotas, resource
lists, owner selection and hosting are not accepted request fields today. The
admin selects the owner; existing resource/limit/runtime controls handle the rest.
Do not silently discard a user's request for unsupported capabilities: show what
still requires administrator setup. An external Bot can use its own model without
Workspace Assistant access.

### API, MCP, CLI and client integration

These are shared registry tools; there is no separate enrollment REST service.
Use `GET /v1/api/tools` or MCP discovery, then send the same validated input:

| Tool ID                       | Input                                                                 | Required authority / result                                                                                 |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `agent.account.request`       | Manifest above                                                        | Setup `agent.accounts.request`; returns `{request}`                                                         |
| `agent.account.requests.list` | `{}`                                                                  | `platform.read`; own requests, or tenant queue for a human admin; returns `{requests}` (up to 100)          |
| `agent.account.request.get`   | `{requestId}`                                                         | Requesting principal or human admin; returns `{request}`                                                    |
| `agent.account.approve`       | `{requestId, ownerActorId, scopes, email, expiresAt}`                 | Human admin with `admin.agents`, confirmation and authority to grant the chosen scopes; returns `{request}` |
| `agent.account.reject`        | `{requestId, reason}`                                                 | Human admin with `admin.agents`; returns `{request}`                                                        |
| `agent.workspace.list`        | `{}`                                                                  | Authorized human with `platform.read`; returns `{bots}` (up to 100)                                         |
| `agent.workspace.access.set`  | `{botActorId, observerActorId, enabled}`                              | Human admin with `admin.agents`; reviewed grant/revoke, returns `{updated:true}`                            |
| `agent.workspace.read`        | `{botActorId, surface, threadId?, roomId?, query?, offset?, cursor?}` | Authorized human with `platform.read`; scoped read result                                                   |

REST invocation is `POST /v1/api/tools/<tool-id>` with a JSON body and
`Authorization: Bearer <credential>` supplied by the trusted transport. Normal
REST success returns the tool output directly. HTTP 202 returns
`{status:"pending_confirmation", pending:{...}}`: preserve the action ID and
review URL and follow the existing approval lifecycle. This transport-level
pending action is different from `request.status === "pending"`; the latter
means the enrollment request exists and awaits admin review. Never invoke admin
approval under the requesting bot/setup identity.

If an older installation submission expired in the generic action queue before
creating an account request, retry the same manifest and key hash with a new
transport idempotency key. Store the returned account request ID and review URL
instead of the expired action ID. Existing account requests are deduplicated by
installation principal and `externalBotId`; do not generate a replacement bot key.

For MCP, use `tools/call` with `params.name` equal to the tool ID and
`params.arguments` equal to its JSON input. Follow the negotiated metadata and
headers in the live integration guide; parse structured output, `isError` and
pending confirmations. Do not assume an HTTP success means a completed tool.

CLI examples below assume the trusted launcher injects `HELIX_BASE_URL` and the
appropriate credential; no secret belongs on the command line. Use separate
client/CLI credential contexts for setup, the approved bot and a human reviewer.
`HELIX_API_KEY` takes precedence over `HELIX_ACCESS_TOKEN`; never leave a setup
key injected while expecting a human token to authorize review. The request JSON
file contains the hash, never the key. Substitute the real request UUID:

```sh
helix tool list --source mcp
helix tool describe agent.account.request
helix tool call agent.account.request --json < bot-account-request.json
helix tool call agent.account.request.get --json '{"requestId":"00000000-0000-4000-8000-000000000001"}'
helix tool call agent.account.request.get --transport mcp --json '{"requestId":"00000000-0000-4000-8000-000000000001"}'
```

These generic CLI commands already support newly discovered tools; no
`helix bot enroll` shortcut is implemented. CLI exit code 6 means transport-level
pending confirmation, not a failed send to retry. Keep the same
`--idempotency-key` when retrying a logical write across separate CLI invocations.

Bot's SDK/client adapter should call this same registry contract through its
existing authenticated REST or MCP transport. Workspace exports the request and
approval schemas/types from `@helix/contracts`; no dedicated remote enrollment
client method is exported by `@helix/sdk` today. Validate against deployed schemas
rather than inventing methods or importing server stores into Bot.

### Human oversight

The local UI provides **Settings → Apps → Bot workspaces** and an embedded view
under **Admin → Agent credentials**, alongside the bot-account request queue.
Use the returned `reviewUrl` for admin review; no stable per-bot detail deep link
has been published yet. Review links are relative to the trusted Workspace origin,
not arbitrary destinations taken from model output.

A human admin authorized for the agent console can inspect tenant bots. Other
humans require an explicit observation grant for that bot; approval grants its
selected owner observation access. Bot access in Helix Bot does **not** itself
create a Workspace observation grant. Keep the two systems' authorization aligned
through explicit admin actions, and revoke both when access is removed.

Oversight is read-only: authorized mailbox conversations, owned Drive files,
joined Chat conversations and bounded activity metadata. It does not expose
credentials, grant general impersonation, let an observer send as the bot, or
bypass source visibility. People granted oversight can read conversations the bot
participates in, including DMs, so make that consequence clear during review.

`agent.workspace.read.surface` is `mail`, `files`, `chat` or `activity`:

- Mail lists use `query`/`offset`; `threadId` selects a conversation and `cursor`
  follows its returned continuation. Results are bounded to 50 per request.
- Files list owned entries across folders with cursor continuation; this is not
  yet an inventory of every file shared with the bot. Human downloads use
  `GET /v1/api/bots/:botId/files/:objectId` with human authentication and observation
  access. Scanning and download policy still apply; never distribute bot keys.
- Chat lists up to 50 joined rooms; `roomId` reads its latest 50 messages. Older
  Chat pagination is not implemented in this oversight surface yet.
- Activity uses `offset` with batches of 50 and omits arbitrary audit payloads.

Do not label these bounded lists “all history.” Observer inventory management,
complete pagination and revoked-access/browser qualification remain release tasks.
Calendar, Meet captures, Assistant conversations and vault secrets are not part of
this new oversight reader. They retain their separate authorization surfaces.

## Native mail productivity integration

See the [full native implementation plan](2026-10-15-native-mail-productivity.md).
These tools are present locally and registered when Mail is enabled. Deployed
discovery remains the capability gate. They are native Helix workflows; no Inbox
Zero account, API credential or source dependency is required.

| Tool ID                            | Input                                       | Required scopes / behavior                                                      |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `mail.productivity.settings.get`   | `{}`                                        | `mail.read`; returns `{settings, aiEnabled}`                                    |
| `mail.productivity.settings.set`   | Full preferences object                     | `mail.write`; human-only background preferences                                 |
| `mail.followup.set`                | `{threadId, messageId, state}`              | `mail.write`; source-bound override                                             |
| `mail.reply.prepare`               | `{threadId}`                                | `mail.write` + `mail.read`; private suggestion artifact, no draft edit/send     |
| `mail.productivity.artifacts.list` | `{}`                                        | `mail.read`; `{artifacts}` containing current reply/filing results              |
| `mail.filter.propose`              | `{instructions}`                            | `mail.read`; optional AI structured proposal, no rule save                      |
| `mail.filter.preview`              | `{criteria}`                                | `mail.read`; bounded matching preview, no mutation                              |
| `mail.attachment.file`             | `{threadId, messageId, objectId, folderId}` | `drive.write` + `mail.read`; scanned-source copy, existing folder authorization |
| `mail.meeting.brief`               | `{eventId, threadIds:[]}`                   | `mail.read` + `calendar.read`; optional AI private brief                        |
| `mail.action.digest`               | `{}`                                        | `mail.read`; private structured overview, no AI required                        |

Normal registry approval, DLP, tenant/resource authorization and audit requirements
still apply. Bots call these tools under their own accounts; they cannot enable
human background settings or override admin-disabled Mail AI. External bots may
instead draft using their own model, respecting their connection's classification
and provider policy, then use ordinary authorized Workspace draft/send tools.

### Bot workflow instructions

1. **Reply tracking:** query `mail.threads.list` with `folder:"all"` and
   `query:"is:needs-reply"`, `"is:waiting-on"`, `"is:done"` or `"is:overdue"`.
   These are follow-up candidates, not guaranteed obligations. Use
   `mail.followup.set` with the latest delivered message ID and state `automatic`,
   `needs_reply`, `waiting_on` or `done`. A new message invalidates the override;
   refresh on conflict. A queued/failed send must not count as a completed reply.
2. **Prepared reply:** read the conversation, request `mail.reply.prepare`, and
   handle artifact status `working`, `ready` or `failed`. Only a ready artifact's
   `text` is a suggestion. Re-read source freshness before applying it; preserve
   any existing human draft and use the normal draft revision checks. Sending is
   a separate action with its own approval and delivery result. Do not parse the
   opaque `sourceKey` as a stable public version contract.
3. **Rules:** ask `mail.filter.propose`, review/edit its structured
   `{name,criteria,actions}`, then run `mail.filter.preview`. Save only after
   explicit review using existing `mail.filter.create`/`update` schemas. Criteria
   use ANDed, case-insensitive literal matches, not regex. Proposed actions are
   existing-label application, archive, mark-read and star; unsupported sending,
   forwarding, deletion and snooze schedules are rejected. Preview samples the
   latest 50 conversations and reports truncation; it is not a full backfill.
4. **Attachments:** identify the authorized message/attachment and writable
   destination; call `mail.attachment.file`. The copy is deduplicated by actor,
   source message, attachment and destination. Source mail stays intact and
   folder permissions govern the copy. `ready` here means filing completed,
   not necessarily that Drive scanning finished; inspect upload/scan availability
   before trying to read it. Current attachment bound is 25 MiB.
5. **Meeting brief:** provide a visible calendar `eventId` and up to five
   explicitly selected authorized `threadIds`. Re-fetch after event or message
   changes. Briefs remain private; publishing/emailing requires a separate action.
   This feature does not enable Meet recording or transcription.
6. **Action digest:** fetch `mail.action.digest` for `needsReply`, `waitingOn`,
   `meetings`, `calendarError`, `generatedAt` and `approvalsHref`. The current
   digest includes a link to the approval inbox, not approval items or counts.
   Retrieve actual approval state through the existing authorized actions tools;
   never execute an item just because the digest mentions it.

Current preparation rejects conversations over 50 messages or truncated bodies;
handle that error visibly rather than silently claiming the whole conversation
was summarized. Reply/brief artifacts include `id`, `kind`, `sourceKey`, `status`,
`text`, nullable `objectId`/`error`, `createdAt` and `updatedAt`. Briefs and digests
are re-read through their own tools, not `mail.productivity.artifacts.list`.
Background scheduling, retries, retention and UI behavior still need the complete
acceptance checks in the plan; do not promise unattended coverage from these
on-demand operations alone.

Human settings are opt-in: `preparedReplies`, `meetingBriefs` and `dailyDigest`
default to false. Other fields are `writingInstructions` (up to 2,000 characters),
`overdueDays` (1–90, default 3), `digestHourUtc` (0–23, default 8) and `filingRules`
(up to 20). Read the full object before changing it: setting preferences replaces
it, and omitted fields take defaults. Bots should run their own explicitly granted
schedules instead of trying to mutate a human's settings.

```sh
# Run with the approved bot credential, not the setup credential.
helix tool call mail.action.digest --json '{}'
helix tool call mail.threads.list --json '{"folder":"all","query":"is:needs-reply","limit":25}'
helix tool call mail.filter.propose --json '{"instructions":"Star mail whose subject contains invoice"}'
helix tool call mail.filter.preview --json '{"criteria":{"subjectContains":"invoice"}}'
```

## Additional Bot and Workspace acceptance tasks

- [ ] Bot: persist enrollment manifest, secret reference and request receipt before
      retries; prove restart recovery without duplicate accounts or leaked keys.
- [ ] Workspace + Bot: reject anonymous enrollment, another setup principal's
      request reads, cross-tenant IDs, nonhuman approvals and scope escalation.
- [ ] Workspace: prove atomic concurrent approvals, rollback on mailbox/credential
      failure, inactive requester/owner handling and request expiry/rejection.
- [ ] Bot: accept downscoping, unavailable apps and changed approved addresses;
      stop on credential expiry/revocation and avoid duplicate model hosting.
- [ ] Workspace + Bot: test API, CLI and MCP request/status using the same identity,
      including policy-driven `pending_confirmation` before request execution.
- [ ] Workspace: complete human request alerts, observer inventory/revocation,
      history pagination and credential-expiry visibility before calling setup complete.
- [ ] Workspace: prove observer reads with own human authority, no writes/sends,
      tenant separation, missing grants, revoked access, scan blocking and audits.
- [ ] Bot: expose Workspace review/oversight links and meaningful pending/errors;
      use inline setup/review panels with the existing shared UI components.
- [ ] Both: test prepared-reply freshness, concurrent human edits, disabled AI,
      unsafe rule proposals, folder revocation and scanning-pending/infected files.
- [ ] Both: verify Mail, Chat, files, Calendar, events, presence, approval waits and
      reconnect behavior with two bots and two humans before enabling the catalog.
- [ ] Workspace: finish the implementation plan's database, worker, browser and
      accessibility tests plus full repository gates; migrate and deploy together.
- [ ] Bot: keep the catalog planned/unverified until the actual deployed adapter
      passes its cross-application acceptance suite. Local source/typechecking is
      not evidence of live deployment or end-to-end authorization correctness.

### Local verification checkpoint — 2026-10-16

The handoff's local file links, JSON manifest, all 18 new tool IDs and CLI example
parsing were checked against source. The manifest passes the shared request
schema after substituting a locally computed test hash; no enrollment or outbound
message was submitted. Repository formatting, typecheck, build and boundary checks
pass. Lint still fails on query/mutation conventions in the new UI code. The full
test run also reports failures in Mail sidebar ordering, admin cold-load requests,
Settings navigation and agent-credentials rendering. These must be resolved as
part of the implementation work, not ignored by the integrating Bot agent.

This update did not run live Bot enrollment, database isolation qualification,
Playwright or new browser accessibility checks, and did not deploy. Use the
acceptance tasks above to qualify the integration before enabling it.
