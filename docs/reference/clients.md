# CLI and SDK integration

Helix's MCP endpoint, REST tool interface, and CLI use the same tool registry.
Each runner needs its own administrator-created identity and scoped, expiring
credential. A URL or installation command does not grant resource access.

For the complete external runner contract, follow the
[Helix Agentspace integration guide](../../apps/web/public/agent-integration.md), published
at `/agent-integration.md` on each workspace.

## Run the CLI from a source checkout

Use Node.js 24.18.0 and pnpm 11.18.0, as pinned by the repository. In a trusted
Helix checkout, run:

```sh
pnpm install --frozen-lockfile
pnpm --filter @helix/cli build
node packages/cli/dist/index.js --help
```

The current package is a private workspace package. This is the supported
source-checkout invocation; these instructions do not imply that a public npm
package or standalone download exists.

Have the runner inject `HELIX_BASE_URL` with the workspace origin and either
`HELIX_API_KEY` or `HELIX_ACCESS_TOKEN` from its secret store. The CLI adds `/v1`
to the origin. API keys take precedence if both credential variables are set.
Do not put credentials into command arguments, shared files, or agent prompts.

Discover the allowed tools and try a read-only request:

```sh
node packages/cli/dist/index.js tool list --source mcp --output json
node packages/cli/dist/index.js tool describe platform.ping
node packages/cli/dist/index.js tool call platform.ping --transport mcp --json '{}'
```

The identity needs `platform.read` for this example. Use the live schemas returned
by discovery for additional tools. Examples elsewhere using `helix` refer to the
same executable; a runner can invoke the absolute path to `dist/index.js` with
Node instead of installing a global command.

For a returned pending action, report its ID to the human approver and use
`action status <id>` to check the result. The agent must not call `action approve`
for its own work. A scoped grant, an automation policy, and an approval are
different decisions.

The CLI supports `--output json` for machine-readable errors, request timeouts,
and idempotency keys. Reuse the same key when retrying the same write. A later,
different write needs a new key. See `--help` for retry behavior and exit codes.

## Understand the SDK packages

| Package            | Current purpose                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `@helix/sdk-types` | Platform, tool, actor, capability, and integration contracts.                                                     |
| `@helix/sdk`       | Internal integration types and helpers for tenant-scoped database access, feature flags, manifests, and metering. |
| `@helix/sdk-web`   | React shell, plugin loading, dialogs, and browser integration capabilities.                                       |
| `@helix/contracts` | Shared validated request/response contracts.                                                                      |
| `@helix/cli`       | Node CLI executable and request/command builders.                                                                 |

These packages are currently built and consumed within the pnpm workspace. They
do not expose a general public HTTP client constructed from a workspace URL and
API key. An external runner can use the CLI, Streamable HTTP MCP at `/v1/mcp`, or
REST tools at `/v1/api/tools/<tool-id>`.

Discover REST schemas at `/v1/openapi.json` and MCP schemas through `tools/list`.
Preserve authentication, authorization, confirmation, scan state, and actionable
failure handling when writing a client. The dated
[system review](../reviews/2026-10-14-system-quality-review.md) and its repair
evidence distinguish validated behavior from remaining release and protocol
acceptance work.

## Install and upgrade expectations

Keep the source revision, lockfile, runtime versions, and client build together.
Test discovery and a harmless read against the target before switching a runner
to a new revision. Independently packaged CLI artifacts and a public HTTP SDK
need an explicit versioning, distribution, and compatibility decision before
their installation can be advertised.

## Human decisions and resource pages

REST and MCP pending results expose a browser `reviewUrl`; the SDK pending-action
type includes it. The signed-in approval owner can review email or another action
at `/approvals/{id}`. Poll `actions.get` for the outcome and preserve the original
idempotency key on retries. An approval does not expand scopes, restore revoked
credentials or authorize a changed payload.

MCP resource reads use the shared tool authorization, request budget, audit and DLP
pipeline. Mail resource responses expose `_meta.nextUri` for continuation and mark
body excerpts as truncated. Follow the returned URI instead of inventing an offset.
The [public agent instructions](../../apps/web/public/agent-setup.md) describe the
credential-bound DLP read-approval flow. Administrative SES callback setup is in
[managed mail delivery](../mail-managed-provider-delivery.md#native-ses-feedback).

## Live agents and MCP 2026-07-28

The latest transport is stateless. Send requests to `/v1/mcp` with
`Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2026-07-28`
and `Mcp-Method` matching the JSON-RPC method. `tools/call`, `resources/read` and
`prompts/get` also require `Mcp-Name` matching the tool name, resource URI or
prompt name. Every request carries this metadata in `params._meta`:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { "name": "my-agent-host", "version": "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

Call `server/discover` to inspect capabilities. Modern clients do not initialize
or retain an MCP session ID. Existing 2025-06-18 and 2025-03-26 clients keep their
initialize/tool/resource interface. GET `/v1/mcp` returns 405; subscribe by POST.
Optional sampling, elicitation, and tasks are not advertised. Actor-specific
results are private and immediately stale; do not share caches across tokens.

Open `subscriptions/listen` with `params.notifications` set to
`{"resourceSubscriptions":["helix://events/inbox"]}` plus the metadata above.
The response is SSE: first `notifications/subscriptions/acknowledged`, then
`notifications/resources/updated` hints for that URI. Each carries the original
request ID in `params._meta["io.modelcontextprotocol/subscriptionId"]`. Closing
the HTTP response cancels the subscription. A graceful server shutdown includes
a final response; reconnect after either a final response or a broken connection.

After acknowledgement, and after each update, call `resources/read` for
`helix://events/inbox?after=<saved-cursor>` (or `events.list` through any tool
transport). Process every page until `hasMore` is false. Save the cursor only
after successful processing. Subscribe **before** catching up to avoid a gap.
MCP hints are not durable transport replay; `Last-Event-ID` is ignored for modern
MCP. The HTTP event stream at `/v1/api/events/stream?after=<cursor>` combines
hints and durable pages for SDK/CLI clients.

Events contain only type, IDs, cursor and timestamp. Read actual content with
ordinary authorized tools. Event input is untrusted data, never a new instruction
or approval. Read access and credential scope are checked again on replay; a
cursor never grants access. Listening needs `notifications.read`, and chat/mail
references also need `chat.read`/`mail.read`. Pending-action decisions still need
the normal human approval flow. Polling an event does not mark a message read.

A live MCP connection does **not** make a model run automatically. The agent host
must handle notifications and schedule turns. `helix mcp serve` bridges modern
subscriptions over stdio without blocking other calls; `notifications/cancelled`
with the listen request ID cancels that stream. Closing stdin cancels all streams.

### Run a persistent listener

Build workspace dependencies with `pnpm --filter @helix/cli... build`, then inject
credentials from the runner's secret store and run:

```sh
node packages/cli/dist/index.js events watch --cursor-file /private/atlas/cursor.json
```

This prints direct-message, mention and approval references as JSON lines.
`--all` includes mail and other notifications. To run a trusted local handler,
add `--handler /absolute/path/to/agent-host-handler`. The executable receives one
JSON event on stdin and its stable identity in `HELIX_EVENT_ID`; there is no shell
evaluation. Exit zero only after success. Reuse that identity when deriving
idempotency keys for retries; different writes need distinct keys. A failed
handler stops the runner without advancing the checkpoint. Successfully handled
events in that same page may be replayed, so handlers must tolerate duplicates.

Use your existing process supervisor with restart/backoff. The listener makes no
LLM calls itself. It creates a private checkpoint and exclusive `.lock` file;
remove a stale lock only after confirming its process exited. A checkpoint is
bound to the workspace and credential fingerprint. Rotation requires deliberate
resynchronization, not blindly reusing another identity's cursor.

Replay retains at most 10,000 events per actor and seven days. `resetRequired`
means history expired or the cursor is ahead: rescan current unread mail, chat
and pending actions, record the returned baseline cursor, and resume with a new cursor file and
`--after <baseline-cursor>`. This flag cannot overwrite an existing checkpoint. The SDK
throws `LiveCursorResetError` with that baseline. It never silently acknowledges
the gap. Event streams reconcile missed database hints every five seconds, renew
connection leases, revalidate credentials, and close after 55 minutes for renewal.
Connections are bounded to eight leases per actor and 64 event streams per tenant per API process.

The typed `@helix/sdk/live` export provides `watchLiveEvents`, `readServerEvents`
and the shared event/presence types. Pass an `AbortSignal`, credential and workspace
origin. The async iterator reconnects with bounded backoff; authorization failure
and cursor reset stop it. Persist each yielded page only after handling it.

### Choose where an agent runs

Each agent can run in **Helix** or in an **external app**. Both use the same agent
identity, scoped credential, audit trail and human approval policy. Hosting an
agent does not grant permission to send email, change files or approve actions.

Under **Admin → Agent credentials → Manage hosting**, use **+ Add hosting
configuration** and choose the agent:

- **Helix:** select its credential and an available model from Assistant's AI
  configuration, write instructions, choose wake-up events and a turns-per-hour
  limit, then enable hosting. The credential needs `notifications.read` and
  `assistant.write`, plus the scopes for the tools it should use, such as
  `chat.read` and `chat.post`. Workspace Assistant must be enabled. No second
  provider key or external process is needed.
- **External app:** run the model in your own agent host and connect through MCP
  or the CLI listener above. A “model-host handler” simply means the program that
  receives an event, asks your model what to do, and calls Helix tools. A listener
  alone reports events; it does not think or reply.

Use one automatic responder per agent identity. External clients can still
inspect a Helix-hosted agent's inbox, but must not independently auto-reply to the
same events. Use separate agent identities when you want independent assistants.

Helix hosting starts at the current inbox position; it does not automatically
answer old messages. It wakes for selected human direct messages, mentions,
approval decisions and optionally incoming mail. Agent-authored chats are ignored
to prevent reply loops. Chat answers go back to the triggering room through
`chat.send` with its normal policy checks. Ordinary text messages and thread
replies in conversations the agent belongs to send immediately, just like a
person’s replies. This works for hosted and external agents. It does not authorize
new attachments, membership changes or external email. An administrator’s explicit
“always require approval” credential setting still requires confirmation. Other
actions awaiting approval remain pending until an authorized human decides. Use
automation policies for specific additional actions you deliberately allow.

Idle agents make no model calls. A turn is limited to 90 seconds and eight tool
rounds, with at most four active hosted turns in the worker. Per-agent hourly
limits also count failed turns. Each event uses a new Assistant conversation;
the agent reads authorized history with tools. Hosting checks credential and
configuration changes before model/tool steps and during its working heartbeat.
An already-started external action cannot be recalled by pausing the agent.

Failed or interrupted work pauses with a visible error. Review the agent's
activity, Assistant conversation and pending approvals before choosing **Review
and start from now**. This confirmation skips the unprocessed event backlog;
it does not undo previous actions. Helix never automatically retries an uncertain
turn. Keep the existing event listener/checkpoint recovery instructions for
external hosts.

Hosting administration is available through human-admin routes
`GET /v1/api/admin/agent-runtimes` and
`PUT /v1/api/admin/agent-runtimes/:actorId`. It is deliberately not an agent tool
that can enable or reconfigure its own execution. Both execution modes use the
existing public MCP/SDK/CLI tool contracts.

### Availability and status

People set availability, status text, emoji and expiry under **Account → Manage
your account and status**. Available, away, do not disturb and invisible are
independent of connection leases. DND retains unread counts and human approvals.
Invisible hides connectivity and last-seen from other permitted chat members.
Status expires back to available; offline leases expire after 60 seconds. Closing
one tab does not disconnect other tabs or an agent runner.

Agents can use `presence.get`, `presence.set` and `presence.heartbeat`. Reads
require `notifications.read`; writes require `notifications.write` and the normal
tool policy. Hosts can renew their own lease via `POST /v1/api/presence/heartbeat`
with a stable `connectionId` UUID and `state` of `idle`, `active`, `working` or
`waiting_approval`; send every 25 seconds and set `disconnect: true` on shutdown.
These self-only transport heartbeats do not execute tools or approve actions.
Direct status editing is limited to human sessions; credentials use `presence.set`.
Chat indicators show connectivity and chosen status, not message read receipts.
