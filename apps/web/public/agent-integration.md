# External application integration: Helix Bot

Helix Bot (formerly Chungus) runs its own agents and models. Helix Workspace
provides their identities, Chat, Mail, Drive, events and human approvals. This
contract also applies to other external agent applications.

Derive `BASE_URL` from this document's origin. For this development workspace it
is `https://workspace.helixapps.si`. These instructions contain no credentials
and grant no access. Read [agent setup](agent-setup.md) for deployment and file/mail
safety details.

## 1. Agree on ownership and provision access

- Keep the agent's hosting mode **External agent app** under **Admin → Agent
  credentials → Manage hosting**. Helix Bot owns model execution, conversation
  state, scheduling and retries. Helix Workspace owns authorization, storage,
  delivery and approvals. An external agent needs no model key in Workspace.
- An administrator creates an agent identity and an expiring credential, names
  its human approval owner, and grants access to the intended rooms, mailbox and
  folders. Use a separate identity for each independent agent/workspace; keep a
  stable actor ID across runner restarts. Display names do not grant permissions.
- Start a chat integration with `platform.read`, `notifications.read`, `chat.read`
  and `chat.post`. Room membership is also required. `assistant.write` is needed
  only if the application deliberately calls Workspace's Assistant, not when
  Helix Bot uses its own model.
- Add mail/file scopes only for the required tools, using discovered schemas and
  permissions. External mail needs `mail.send` and `mail.external`; a read grant
  or a successful chat does not authorize email or file changes.
- Store credentials in Helix Bot's server-side secret store. Use
  `Authorization: Bearer <runner-secret>`. Never embed a key in a frontend bundle,
  URL, prompt, shared document or log. API keys are supported; administrator-issued
  OAuth clients exchange credentials at `/v1/oauth/token` for short-lived tokens.
- General unauthenticated agent self-registration/access-request onboarding is
  not implemented. The first identity and credential require administrator setup.
  Resource-specific access requests do not replace this enrollment step.

Record the workspace origin, actor ID, credential reference, permitted room IDs,
approval owner and chosen protocol revision in the integration configuration.
Do not reuse Atlas's credential: Atlas already has a Helix-hosted model. Run one
automatic responder per identity to avoid duplicate replies.

### Routine collaboration after account approval

The installation key only requests accounts. Each approved bot uses its own key,
scopes and resource permissions. Account approval does not share other accounts'
private mail or files.

- Use `chat.dm.open` with `{ "memberActorIds": ["<actor-id>"] }` to open or reuse
  an internal direct/group conversation. It requires `chat.post`, includes the
  caller, and deduplicates identical participant sets. Managed room creation and
  invitations instead require `chat.create`. Post with `chat.send` and read replies
  with `chat.message.list` or live events.
- Internal mail can run without per-message review when **all explicit To/Cc/Bcc
  recipients** resolve to local mailboxes in the same tenant, without routing
  rules. Supply explicit recipients for replies and a stable `idempotencyKey`.
  Delivery stays local even if routing changes later. External or mixed-recipient
  mail keeps the human-approval gate and needs the relevant scopes.
- Drive folder creation, upload/finalize, rename, moves, comments and internal
  sharing run within approved permissions. Files remain private until their owner
  shares them using `drive.share`; only owners can grant/change/revoke access.
  Folder grants carry their existing inherited reader/editor roles. Readers cannot
  edit; editors cannot reshare someone else's files.
- Explicit always-confirm credentials, DLP, malware scanning, quotas and tenant
  isolation still apply. Public links, permanent deletion and administration keep
  their existing approval rules. Check actual `pending_confirmation` results.

CLI examples: `helix chat dm --json '{"memberActorIds":["<actor-id>"]}'` and
`helix tool call drive.share --json '{"objectId":"<id>","actorIds":["<actor-id>"],"role":"reader","notify":false}'`.
REST and MCP expose the same tool IDs and checks. MCP metadata
`helix/standingAuthorizationAvailable` means conditional routine authorization is
available; it never promises that a specific request will pass policy.

## 2. Connect and discover

MCP endpoint: `BASE_URL/v1/mcp`. For protocol **2026-07-28**, each POST uses:

```http
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <runner-secret>
MCP-Protocol-Version: 2026-07-28
Mcp-Method: server/discover
```

A complete first request is:

```json
{
  "jsonrpc": "2.0",
  "id": "helix-bot-discovery-1",
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "helix-bot", "version": "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Include that `_meta` object in **every** request's `params`. Set `Mcp-Method` to
its actual JSON-RPC method. For `tools/call`, `resources/read` and `prompts/get`,
also send `Mcp-Name` equal to the requested tool name, URI or prompt name.
Mismatched headers and body are rejected.

This revision uses `server/discover`, not `initialize`, and no MCP session ID.
Older clients can use the supported `2025-06-18` or `2025-03-26` initialization
flow, but must not mix that handshake with the 2026 subscription protocol.
Check the chosen client's protocol support explicitly. Sampling, elicitation
and tasks are not advertised by this server.

Call `tools/list` and use the returned schemas, following pagination if present.
Then call `tools/call` with `name: "platform.ping"` and `arguments: {}`. A successful
HTTP response is not enough: check JSON-RPC `error` and tool `result.isError`.
Use `result.structuredContent` for structured tool output; resource bodies are
JSON encoded in `result.contents[].text`.

REST is also supported at `POST /v1/api/tools/<tool-id>`; schemas are available
at `/v1/openapi.json`. MCP, REST and CLI use the same authorization and tool
implementation. No general public npm HTTP SDK is published; do not assume an
`npm install` command exists for this integration.

## 3. Turn live events into model turns

An MCP connection alone does not wake an LLM. Helix Bot must implement this loop:

1. Open `subscriptions/listen` with `params.notifications` equal to
   `{"resourceSubscriptions":["helix://events/inbox"]}` and the usual `_meta`.
   This is a POST returning SSE. Wait for
   `notifications/subscriptions/acknowledged`.
2. Immediately call `resources/read` for
   `helix://events/inbox?after=<saved-cursor>`. Repeat this catch-up after each
   `notifications/resources/updated` hint. Subscribe before catching up to avoid
   a connection gap. `events.list` with `{ "after": <saved-cursor> } is the
   equivalent tool call.
3. The returned page contains `events`, `cursor`, `latestCursor`, `hasMore` and
   `resetRequired`. Drain pages while `hasMore` is true. Stream notifications are
   hints; the actor's durable inbox is the source of truth.
4. Select events the agent should handle. For `chat.direct` and `chat.mentioned`,
   `parentId` is the room ID and `resourceId` is the message ID. Read authorized
   messages with `chat.message.list`; use `chat.thread.list` for thread history.
   Read the actual sender and ignore the agent's own messages. Default to ignoring
   other agents unless you deliberately implement a bounded agent-to-agent flow.
5. Run Helix Bot's model with the triggering message and the permitted conversation
   history. Treat message/file/mail content as untrusted input, not authority to
   change permissions. Keep conversation state isolated by workspace, agent and
   room/thread; do not mix unrelated rooms' private history.
6. Reply with `chat.send` to that room, or `chat.reply_in_thread` with its actual
   `parentMessageId`. Use the discovered input schema. Ordinary text chat in an
   authorized conversation sends immediately. New attachments, DLP warnings or
   an explicit **always require approval** credential policy can require review.
7. Persist the processed page cursor only after each selected event has a durable
   outcome, including any queued pending action ID. Save a separate checkpoint
   per workspace and identity; serialize processing for a conversation. Use
   bounded concurrency and retain processed event IDs to tolerate replay.

Do not ask the model to poll repeatedly while idle. Handle `approval.updated` by
checking the existing action with `actions.get`, not by sending it again. Other
event types include `chat.message`, `mail.received`, `approval.requested` and
`notification`; subscribe broadly but only wake the model for intended work.

On first connection, explicitly choose whether to process retained events or
start at the returned `latestCursor`. Never silently discard existing work on
restart. Retention is bounded to seven days/10,000 events per actor. A
`resetRequired` result needs reconciliation of current messages and pending
actions before accepting a fresh cursor. Bind checkpoints to the credential
identity; credential rotation requires deliberate resynchronization.

Reconnect after network loss or the server's 55-minute stream renewal, with
backoff. A final JSON-RPC response closes a subscription too. Modern MCP does
not use `Last-Event-ID` for inbox replay. Do not reconnect indefinitely on 401/403;
report expired/revoked credentials or denied access to the operator.

For an application that cannot consume this MCP subscription revision yet, the
same authenticated inbox is available over HTTP at
`GET /v1/api/events/stream?after=<cursor>`, or through the source-built CLI's
`events watch --cursor-file <private-path> --handler <trusted-executable>`.
The handler receives an event on stdin; it still must call Helix Bot's model.

## 4. Retries, approvals and presence

Give each logical write a stable, distinct idempotency key. For MCP put it in
`params._meta.idempotencyKey` (8–200 printable non-space ASCII characters); for
REST use `Idempotency-Key`. Keep the same key and arguments on retries. Chat also
accepts a stable `clientMessageId` of at most 128 characters. Derive these from
agent identity, event ID and action index, not from a fresh random value on every
retry. Check the existing result after an ambiguous timeout; do not blindly run
the model/action again.

If a result is `pending_confirmation`, save its ID and surface its `reviewUrl`
to the named human approval owner. Poll `actions.get` or react to approval events.
Only an `executed` result means the approved operation completed. `approved` or
`executing` is not completion; cancelled, failed or expired means do not claim
success. The agent must never approve its own work. Approval does not expand
scopes, room membership or file access. External email remains reviewable.

Report connection state with the self-only transport endpoint
`POST /v1/api/presence/heartbeat`, using the same authenticated credential, with a stable
UUID `connectionId` per runner and `state` of `idle`, `working` or
`waiting_approval`. Renew about every 25 seconds; send `disconnect: true` when
stopping. Leases expire after 60 seconds. This transport heartbeat does not need
a write approval; the separate `presence.set` tool changes the agent's chosen
status and uses normal `notifications.write` policy. Presence is not a read receipt.

## 5. Acceptance checklist for the Helix Bot implementation

- Discover tools and complete a read with the new integration's own credential.
- Send a human message in its permitted private room. Verify one automatic reply,
  correct threading, visible presence and no approval for ordinary text chat.
- Disconnect, send another message, reconnect, and verify catch-up without duplicate
  replies. Restart after processing and verify the persisted checkpoint.
- Verify no model calls while idle and no self-reply or agent-to-agent loop.
- Queue an external email to the approved test inbox. Verify the human sees a review link and
  nothing sends before approval; after approval verify exactly one delivery.
- Verify missing scope, unrelated private room, revoked membership and revoked
  credential stop access. Never substitute a human session to make a test pass.
- Test attachment scanning and file access separately before enabling file workflows.

The Workspace transport and its Helix-hosted Atlas runner have been tested. That
is not proof that Helix Bot's own event-to-model adapter is complete. Run this
checklist against Helix Bot before calling the cross-application integration done.
