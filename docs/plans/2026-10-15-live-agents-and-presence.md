# Live agents, MCP subscriptions, and workspace presence

## Outcome and scope

An authenticated agent can wait for relevant Helix events without repeatedly
invoking a model. Its host wakes it for selected events, reads current authorized
content with existing tools, and preserves normal human approvals. Humans can
set availability, a short status and emoji, and expiry. The UI distinguishes a
live connection from activity: connected does not mean a message was read.

Reuse the existing notification, mail delivery, pending-action, tenant RLS,
Chat authorization and event infrastructure. Add no model provider, autonomous
permissions, broker, or external dependency. Keep the established visual design.

## Protocol and compatibility

Target the latest stable MCP revision, **2026-07-28**. Implement stateless
per-request protocol/capability metadata, `server/discover`, HTTP mirrored header
validation, private cache hints and deterministic discovery. Open live updates
with `subscriptions/listen` POST SSE: acknowledge the honored resource filter
first, tag every notification with the request's subscription ID, and send a
terminal result on graceful shutdown. Disconnect cancels the subscription.
No modern session IDs, initialize handshake or GET event stream are required.

Retain 2025-06-18 and 2025-03-26 initialize/tool/resource behavior for existing
clients. Legacy initialize negotiates only a legacy revision. Do not advertise
legacy resource subscriptions or optional sampling/elicitation/tasks which Helix
does not implement. The private inbox is read with an application cursor; modern
MCP streams do not use transport Last-Event-ID replay. Hosts reconnect, subscribe,
and read their saved cursor to catch up without losing events.

References:

- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/schema
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning

## Durable event inbox

- Store small event references, never another copy of message bodies, credentials
  or approval inputs. Include event ID/cursor, type, resource IDs and timestamp.
- Project Chat notifications (including direct messages and mentions), inbound
  mail delivery, and pending-action decisions transactionally with their sources.
  Existing relevant file/task notifications can use the same notification seam.
- Allocate ordered cursors under a per-actor row lock: a later committed event
  must not cause an earlier transaction's event to be skipped.
- Bound replay history; explicitly report a stale/ahead cursor and require a
  resynchronization rather than silently skipping work. Reading does not mark a
  chat message or email read and does not approve or execute anything.
- Apply actor/tenant RLS and current source access checks on every replay. Filter
  by current token scopes. Removing room access, blocking a person or revoking a
  credential must stop further disclosure. Event filters only narrow access.
- Push committed change hints; keep a bounded reconciliation timer for lost hints.
  No database transaction may live for the duration of an SSE connection.
- Bound streams, batches, buffered output, subscription lifetime and replay data.
  Recheck credentials during heartbeats and close on shutdown or revocation.

## Presence and user status

- Persist user-chosen availability: available, away, do not disturb, invisible.
  A short status message, emoji and optional expiry are independent of connection.
- Use expiring connection leases, not the existence of an API key, for online
  state. Multiple tabs/runners must not make an actor offline when one disconnects.
- Separate agent work state: idle/connected, working, waiting for approval.
  Heartbeat expiry overrides stale working state. Unrelated actors cannot set it.
- Human shell heartbeats carry active/idle state; activity should not force an
  explicitly chosen away/DND/invisible status back to available.
- Status is visible only within permitted workspace relationships, with existing
  block/privacy rules. Invisible hides connectivity and last-seen from others.
- Put a small, labelled status editor in the account area; use shared fields,
  buttons and global tokens. Show accessible text as well as presence dots in
  Chat room headers and direct-message lists. No blocking creation/edit modal.
- DND is stored and displayed without discarding messages, unread badges, approvals
  or security notices. The current shell has no incoming desktop/sound notification
  presenter; any future interruptive presenter must honor DND.

## SDK, CLI, and reference runner

- Provide a typed SDK event listener with cancellation, reconnect/backoff and
  bounded SSE parsing. Keep cursors and explicit reset semantics available.
- Add `helix events watch` for JSON event output and a persistent cursor file.
  An explicitly supplied local handler can process events serially; no shell
  evaluation or commands derived from incoming messages.
- Default wake-up selection: direct messages, mentions and approval outcomes.
  Incoming-mail and other notification wake-ups are opt-in.
- Save the cursor only after successful handling. Deliver at least once and pass
  a stable event identity for tool idempotency; do not promise exactly-once side
  effects across a runner crash. Stop/retry on handler failure, never acknowledge
  failed work. Prevent concurrent runners from sharing the same checkpoint file.
- Keep credentials out of URLs, output and checkpoint files. Existing CLI
  credential storage continues to work. No model calls occur while idle.
- MCP stdio forwarding must relay subscription notifications without corrupting
  JSON-RPC output or blocking ordinary requests. Hosts still decide whether a
  notification starts a model turn; document this limitation prominently.

## Tasks and acceptance checks

- [x] Shared event/presence contracts and validation.
- [x] Migration, durable inbox, bounded replay and transactional source hooks.
- [x] Presence/status storage, lease aggregation, expiry and privacy.
- [x] Authenticated HTTP replay/stream and presence routes; short RLS transactions.
- [x] MCP 2026-07-28 discovery, metadata, subscriptions/read/list, legacy compatibility and stdio notification relay.
- [x] SDK listener, CLI watch and reference handler/checkpoint runner.
- [x] Account status editor, workspace heartbeat, Chat status indicators and DND preference.
- [x] Document setup for agent hosts, scopes, defaults, reconnect/reset handling,
      status semantics, idempotency, approvals and operational limits.
- [x] Test actor/tenant separation, narrow scopes, access loss, revoked credentials,
      aborted transactions, concurrent writes, cursor gaps, multiple connections,
      bounded frames, restart/catch-up, handler failures, clean-restart duplicate avoidance,
      status expiry and invisible/DND behavior.
- [x] Run format, typecheck, lint, tests, build and dependency boundaries; relevant
      browser/accessibility checks for the status UI.
- [x] Deploy migrations before compatible code; verify Atlas through public MCP
      and CLI, presence, a private chat wake-up, reconnect and approval outcomes.
      No external email is needed for this feature's acceptance.
- [x] Record evidence and leave a named persistent listener only after proving
      its behavior; do not run an unconfigured autonomous model loop.

## Rollout and recovery

Use additive schema changes, preserve existing Chat transport and UI fallback,
and take a current backup before migration. Live agents must reconnect after an
API restart. A compatible rollback can ignore the new inbox and presence tables;
never roll back by deleting mailbox or chat records. Include the new tables in
normal PostgreSQL backups. Monitor active streams, event lag, handler failures,
reconnects and checkpoint resets. This remains a development deployment; a
long-duration, multi-host load test is a separate production acceptance item.

## Development acceptance — 2026-10-15

Deployed additive migration `0233_live_events_presence.sql`, API image
`helix/workspace-development:live-agents-r19`, and web image
`helix/workspace-web-development:live-agents-r17`. Public readiness passes.
An encrypted off-server snapshot was taken before migration. Rollback retains the
new tables and restores the previous compatible application image.

Atlas's existing credential gained only `notifications.read`; write permissions
and human approvals were not broadened. Public MCP discovery, mirrored-header
rejection, legacy initialization, subscription acknowledgement, private Chat
wake-up, resource replay and pending-action creation/cancellation passed. The
approval fixture was cancelled without execution. Its temporary actor was disabled
and its private room archived; Atlas and audit/history records were retained.

The named `helix-atlas-listener.service` user service runs on Mike's local machine.
It uses the existing private Atlas credential, logs event references and saves a
private checkpoint. It caught up after an offline interval, avoided duplicate
logging on a clean restart, and reconnected after API replacement. No model handler
is configured: it makes no LLM calls and sends no automatic replies. Stop it with
`systemctl --user stop helix-atlas-listener.service`; restarting resumes its cursor.
This listener depends on that machine and its user service remaining available.
Credential rotation requires a deliberate checkpoint resynchronization.

The full unit suite, typecheck, lint and build passed. The nine focused database
checks passed in both tenancy modes; account/status and Chat browser checks passed,
including the status accessibility assertion. Format and dependency-boundary
results, public checks, backup details and test limits are recorded in
`docs/reviews/evidence/2026-10-15-live-agents-presence.json`.

Production follow-ups (outside this development acceptance):

- [ ] Long-duration, multi-host load and adversarial slow-consumer testing. The
      64-stream tenant limit is per API process; actor leases are database-bound.
- [ ] Exercise the chosen external model host's event-to-turn integration with a
      configured handler, real idempotent side effects and its approval workflow.
- [ ] Full restore drill and the existing production encryption/readiness gates.
      The development backup does not establish production readiness.

## Next slice: agents hosted in Helix and external agents

An agent's identity and credential are independent of where it runs. External
agents continue to use MCP/CLI events. A human administrator may instead enable
Helix hosting for an existing agent and scoped credential, choose a configured
Assistant model, supply instructions and select wake-up events. Hosting does not
create extra permissions or authorize external writes.

Implementation tasks:

- [x] Add tenant-scoped hosting configuration and durable run/checkpoint state.
- [x] Add audited human-admin configuration, validation, pause and deliberate
      recovery after failed/interrupted work; never automatically repeat an
      uncertain turn that may already have produced side effects.
- [x] Reuse Assistant orchestration and credential policy for hosted turns; cap
      turns per hour, model tool rounds and duration. Revalidate credentials and
      configuration before each model/tool step. Ignore self and agent-originated
      chat wakeups to avoid automatic agent-to-agent reply loops.
- [x] Run only selected new inbox events, retain approval gates, report working
      and waiting status, and stop on revocation or admin pause. Idle agents make
      no model calls. Use the existing singleton worker infrastructure.
- [x] Add an inline hosting panel using shared controls and AdminTable. Keep
      external connection instructions alongside the hosting choice.
- [x] Cover tenant isolation, revocation, interrupted recovery, budget limits,
      tool-policy preservation and both execution modes; deploy and exercise a
      hosted Atlas turn without enabling unapproved external mail.

Conversation decision: ordinary text chat and thread replies in an agent’s existing
conversations send immediately for both hosted and external agents. Reuse standing
authorization from active room membership, preserving tenant/scope checks and
rate limits. This is not authority to share new files, change room membership or
send external email. An explicit always-confirm credential policy takes precedence.
Test immediate replies and the explicit approval override separately.

## Hosted-agent development acceptance — 2026-10-15

Migration `0234_agent_runtime.sql` and API/web images `hosted-agents-r20` are
deployed. A fresh encrypted off-server PostgreSQL dump was authenticated and its
catalog checked before migration; this is not a full restore drill.

Atlas now runs in Helix using the configured `openai/gpt-6-luna` model, with a
20-turn hourly limit. Its credential gained only `assistant.write` for this
capability. Normal text chat uses active room membership as standing permission;
external email and other consequential actions retain their existing approval
policy. The local Atlas listener remains a passive event monitor and does not
run another model. External agent hosts continue to use the same MCP/CLI tools.

A real private human-fixture message woke Atlas. The model read a nonce present
only in that message and returned it in exactly one reply in the same room, with
no pending approval. MCP and CLI sends also completed immediately. Agent-origin
messages and idle listening did not add model turns. The temporary human fixture
was disabled and its room archived; Atlas, its history and audit records remain.

Validation includes the full repository checks, six browser tests with the new
hosting panel's accessibility assertion, hosting RLS tests in both tenancy modes,
and eight additional PostgreSQL chat-grant/privacy checks. Tests cover explicit
always-confirm policy, missing scopes, lost room membership, attachments,
credential revocation, bounded turns, concurrent agents and interrupted recovery.
The live hosted test uses the configured provider; it is not a production load or
provider-failover test. The authenticated admin UI was exercised with isolated
browser fixtures; the shared live browser was signed out.

Operational limits: four simultaneous hosted turns on the elected worker, new
Assistant context per event, no automatic replay after uncertain side effects,
and no automatic replies to agent-authored chats. Large fleets and long-running
model calls need load testing, including database connection/audit-lock contention
and idle presence renewal across rotating discovery batches. Evidence is in
`docs/reviews/evidence/2026-10-15-hosted-agents.json`.
