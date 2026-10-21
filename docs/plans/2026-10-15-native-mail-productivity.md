# Native mail productivity and meeting preparation

Status: implementation in progress (updated 2026-10-16). This is native Helix functionality inspired
by Inbox Zero's published workflows, not an Inbox Zero account integration or
reuse of its source code.

## Outcome and scope

Help people and their agents identify conversations needing attention, prepare
reviewable replies, organize incoming files, and arrive at meetings with useful
context. Preserve the existing Mail layout, shared design tokens and controls.
Keep AI optional and keep normal Mail working without a model provider.

Sources reviewed on 2026-10-15:

- <https://www.getinboxzero.com/reply-zero-ai>: reply tracking and prepared drafts.
- <https://www.getinboxzero.com/ai-automation>: natural-language mail rules.
- <https://www.getinboxzero.com/auto-file-email-attachments>: attachment routing.
- <https://www.getinboxzero.com/brief-my-meeting>: meeting preparation.

The action digest is our extension across Helix's existing applications. Bulk
unsubscribe, contact enrichment from public websites, new external mail account
connectors, and autonomous outbound replies are outside this implementation.

## Existing foundations to reuse

- `mail.ai.suggest` provides compose, rewrite, reply and summary generation with
  authorized server-side conversation loading and data classification.
- Mail already has actor-scoped threads, drafts with revision conflict checks,
  labels, snooze, search, filters, live invalidation and spam decision evidence.
- Drive has authorized folders, upload finalization, malware scanning, retention
  and immutable versions. Mail attachment reads check mailbox visibility.
- Calendar has actor-scoped event reads; approvals have an existing human queue.
- The tool registry supplies REST, MCP, Assistant, CLI invocation and SDK access,
  authorization, confirmation policy, DLP and auditing. Avoid parallel APIs.
- The existing worker supervisor, tenant SQL context, AI routing and cost limits
  own background execution, tenant isolation and provider selection.

## Behavior

### 1. Reply tracking

- Add Needs reply and Waiting on views with search, normal thread navigation,
  live updates, snooze and overdue filtering.
- Derive waiting state from the latest successfully sent or received message in
  the actor's mailbox. A queued, failed or cancelled send cannot resolve a reply.
- Use existing explicit needs-reply evidence when available; describe heuristic
  candidates honestly. Do not imply every inbound message requires a reply.
- Let the user mark a conversation Done, Needs reply, Waiting on, or Automatic.
  Overrides bind to the latest message so a new reply reopens the conversation.
- Deleted, quarantined, spam and actively snoozed conversations do not appear in
  the attention queue. Mailbox owners never inherit another member's state.
- Overdue means no new activity for the user's configured number of days; it is
  a follow-up reminder, not an invented promise or deadline.

### 2. Prepared replies

- Administrator Mail AI enablement and explicit per-user opt-in are both needed
  for background generation. Expose writing preferences and a bounded batch.
- Prepare a suggestion for a specific latest message, separately from the human
  draft. Never overwrite a saved or in-progress human draft.
- Show AI provenance, source freshness, generation status and actionable errors.
  Applying a suggestion opens the existing reply composer for review.
- New messages invalidate stale suggestions. Retries must not create duplicate
  suggestions or spend repeatedly on an unchanged source.
- No automatic sending. Existing send permissions, DLP and approval requirements
  still apply when a person or agent eventually sends the reviewed reply.

### 3. Plain-English rules

- Turn a user instruction into the existing structured filter schema, validate
  it, and show an editable proposal with a bounded preview of matching mail.
- Use the same matching semantics for preview and new inbound mail. Clearly
  label sample limits; a sample is not an exact mailbox-wide count.
- Require explicit Save/Enable; generation and preview do not mutate mail.
- Reject unsupported actions, unknown fields and empty actions. Do not let email
  content supply instructions or escalate an action to forwarding or sending.
- Existing filter editing, pause/delete and audit behavior remain the source of
  truth. Preview is not permission to apply a bulk destructive action.

### 4. Attachment filing

- Explicit user-selected rules map matching new mail to an authorized Drive
  folder. Start with structured sender/subject/attachment criteria, allowing
  natural-language drafting of supported criteria rather than arbitrary AI I/O.
- Read only attachments visible to that actor and cleared by malware scanning.
  Use Drive's upload/finalization pipeline; never move the mail source object.
- Keep a durable source-message/attachment/destination record for deduplication
  and retry. Preserve original thread linkage and attachment name/content type.
- Check folder write access again at execution time. Explain that destination
  folder permissions govern copies; do not create or broaden sharing grants.
- Bounded file and batch sizes, visible failures, retry and pause controls.
  Deleting a filed copy must not silently recreate it on the next background run.

### 5. Meeting briefs

- Offer an on-demand brief and optional preparation for upcoming meetings.
- Load only events visible to the requester and explicitly authorized related
  mail. Include agenda, participants, relevant discussions, open questions and
  source links. Show context bounds and missing evidence.
- Keep private calendar details private; do not use free/busy projections as
  permission to read event descriptions or other attendees' mailboxes.
- AI generation uses the configured optional provider and classification rules.
  Event changes invalidate old briefs. No web scraping or inferred commitments.
- Keep briefs private to the requester. Publishing or emailing them remains an
  explicit existing share/send operation. This does not enable Meet recording.

### 6. Action digest

- Provide an on-demand digest of reply candidates, waiting conversations,
  upcoming meetings and human approvals available to the requester.
- Link each item to its original authorized action. Include timestamps, bounded
  result counts and independent error states so one unavailable app does not
  make the whole digest unusable.
- Optional daily preparation uses the user's schedule and existing durable
  processing. Start with a private in-app digest; delivery through Chat/Mail uses
  explicit destination selection and the existing send policy.
- MCP/CLI users can fetch the same structured digest without requiring an LLM.

## Data, execution and trust boundaries

- Persist preferences and suggestion/job state with `(org_id, actor_id)` scope,
  foreign keys and forced RLS. Worker discovery may return tenant IDs only, and
  each operation re-enters the tenant and actor context.
- Claim background work with bounded leases, bounded retries and stable source
  keys. Recheck enablement, actor status and access before reading or publishing.
- Never send secrets, unrelated mailbox contents or raw provider errors to UI,
  logs, job metadata or another tenant. Treat message/file text as untrusted data.
- Keep generated output bounded and retained only while its source is visible;
  clear stale content on expiry/deletion. Do not duplicate full mail archives.
- Reuse configured AI budgets/routing. Fail closed on classification/provider
  mismatch and remain usable when AI is disabled or rate limited.
- Agents must pass their real scopes and policy. A compound workflow cannot use
  an internal call to bypass confirmation, attachment access or Drive permissions.

## Implementation tasks and acceptance

- [ ] Add shared contracts for preferences, reply state, suggestions, rule
      proposals/previews, filing rules/results, briefs and digests.
- [ ] Add migration and stores with actor-scoped authorization and RLS tests.
- [ ] Implement reply-state derivation, overrides, overdue views and live refresh.
- [ ] Implement bounded, optional prepared replies with source freshness and
      draft preservation; test concurrent generation and retry behavior.
- [ ] Implement natural-language filter proposals and matching previews; connect
      to the existing editable filter workflow and test unsafe model output.
- [ ] Implement attachment filing through existing scanning/upload services with
      deduplication, folder authorization and source linkage.
- [ ] Implement authorized meeting briefs and private action digests with source
      links and readable disabled/error states.
- [ ] Register shared tools and document exact MCP, SDK and CLI examples. Test
      actual registry invocation, permission denial and approval preservation.
- [ ] Add user settings and Mail navigation using shared components. Use labelled
      controls, inline validation, search/sort where useful and no creation modals.
- [ ] Wire bounded background work to existing worker lifecycle; expose status,
      retry, pause, default-off behavior and provider failure handling.
- [ ] Run focused unit/integration tests, browser and accessibility checks, then
      formatting, typecheck, lint, full tests, build and boundary checks.
- [ ] Record deployment requirements, schema compatibility, verification evidence
      and remaining limitations. Do not label untested live services ready.

Essential regression cases: tenant and actor separation; revoked access; agent
scope restrictions; disabled AI; prompt injection; unsupported rule actions;
new mail during generation; manual draft edits; duplicate deliveries and jobs;
failed/cancelled sends; archived/spam/deleted mail; DST/schedule boundaries;
malicious/unscanned files; revoked destination access; partial provider/storage
failure; restart recovery; accessible controls and preserved focus/scroll.

## Additional authorized scope: bot account requests and human oversight

Added during implementation: Helix Agentspace must request a persistent Workspace
account and its desired capabilities through API, CLI and MCP. A Workspace
administrator approves the concrete request before credentials or resources are
usable. Users with explicit bot access and administrators need an authorized bot
workspace showing its email, files, chat and activity.

- [ ] Inspect existing enrollment, admin agent creation, mailbox delegation,
      credential issuance and approval stores before adding a new flow.
- [ ] Define a bounded request manifest: stable external bot identity, name,
      purpose, requested email/local part, capabilities/scopes, resource access,
      human owner, quotas and external hosting. “Full account” is a request for
      enabled apps, not wildcard administrator rights or every tenant resource.
- [ ] Authenticate installation/request origin, rate-limit requests, deduplicate
      retries, persist pending state, and return a review link/status receipt.
- [ ] Let admins review and reduce permissions, approve or reject with a reason.
      Provision transactionally/idempotently; report unavailable apps/domains.
- [ ] Activate a locally generated per-bot key only after approval of its
      precommitted SHA-256 hash. The requester retains the raw key in its secret
      store; no credential-claim endpoint is needed. Support expiry/revocation
      and keep usable tokens out of listings, audits and status responses.
- [ ] Expose authenticated request/status via the shared registry API and matching
      CLI/MCP entry points without making normal tools anonymously accessible.
- [ ] Add bot access grants and an oversight view for authorized humans. Reuse
      existing domain authorization for reads; keep observer and write/control
      authority distinct. Audit sensitive access and recheck revocation.
- [ ] Test tenant separation, request ownership, concurrent approvals/retries,
      downscoping, disabled apps, duplicate accounts, expired requests and revoked
      human access. Update the Helix Agentspace handoff with implemented contracts.

Integration handoff: [Helix Agentspace → Workspace](2026-10-15-helix-agentspace-workspace-handoff.md).
It documents the current local request fields, supported scopes, credential
activation, human oversight, native productivity tools and remaining gaps.
Resource manifests, custom quota requests, complete oversight pagination and
request alerts are not yet complete; do not treat the checklist as deployed
capability evidence.
