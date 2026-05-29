# AI + Assistant — Senior Review

## Summary
The AI router and Assistant orchestrator are unusually well-structured for an early-stage platform: classification gating, fallback, OTEL tracing, metering, provenance, and a Redis-backed daily cost limiter are all present, with native streaming wired end-to-end through SSE. Per-tenant isolation has serious gaps, however — the pgvector store has no `org_id` column or filter, prompt-injection defenses are absent, and provider API keys are stored as plain process-level strings with no per-tenant key model. The web composer also ships a fake model selector, an unwired Paperclip/Doc/Users toolbar, and no UI for tool-call confirmation, so several PRD-level features are present in design only.

## Scorecard
- Security: 2/5 — process-global provider keys, no prompt-injection guardrails, no PII redaction before send, missing tenant scoping in `pgvector`, no per-tenant rate limit (only daily cost).
- Correctness: 3.5/5 — streaming + fallback semantics are correct, but cost reservations leak when streams abort, classification can be downgraded via untrusted request input, and tool calls are not surfaced from streamed responses.
- Feature completeness: 2.5/5 — model selector, attachments, system-prompt customization, conversation share, and the pending-confirmation UI are all stubbed or absent.
- Code quality: 3.5/5 — `routing.ts` (1127 LoC) and `orchestrator.ts` (1022 LoC) have heavy duplication between streaming and non-streaming paths; types and tests are otherwise strong.

## Findings

### A1: pgvector store has no tenant scoping · critical · security
**File**: `apps/helix/src/platform/ai/vector/pgvector.ts:34-94`
**What's wrong**: `createCollection`, `upsert`, `query`, and `delete` accept only a collection name; there is no `orgId` column on `vector_collections` or `vector_items` and no caller-supplied tenant filter. Any caller that knows a collection name can read or overwrite every tenant's vectors in the same collection. `VectorStore` (`types.ts:24`) does not require tenant identity at all, so other adapters (`chroma.ts`, `milvus.ts`, `qdrant.ts`, `weaviate.ts`) likely inherit the same hole.
**Fix**: Add `org_id` (and ideally `actor_id`) to both tables, require `orgId` on every `VectorStore` method, and namespace collection names per org (or filter `where org_id = $1` on every query). Add a regression test asserting `query()` for org A never returns org B's items.
**Effort**: M

### A2: Classification can be downgraded via untrusted request input · high · security
**File**: `apps/helix/src/platform/ai/routing.ts:215`, `apps/helix/src/platform/assistant/tools.ts:42`
**What's wrong**: `chat()` resolves classification as `request.classification ?? ctx.classification ?? "standard"`. The assistant `chat` tool's Zod schema lets any caller pass `classification` directly in the request body. A caller with `assistant.write` can send confidential content but claim `classification: "public"` to dodge `assertClassificationAllowed` and ship the prompt to an external provider.
**Fix**: Compute classification server-side from `ResourceClassificationService` over the prompt + context, ignoring (or downgrading-only) the client-supplied value. At minimum, require admin scope to lower classification.
**Effort**: M

### A3: Provider API keys are process-global, not per-tenant · high · security
**File**: `apps/helix/src/platform/ai/providers/openai-compatible.ts:55`, `anthropic-compatible.ts:61`, `bedrock.ts:107`, `embeddings/openai-compatible.ts:54`
**What's wrong**: Each provider stores a single `#apiKey` field set at construction time. There is no `KeyProvider`-style interface that accepts the `Actor` / `orgId`, no rotation hook, and no audit trail when the key is read. For Bedrock the AWS secret-access-key is held in memory verbatim and is used to sign every tenant's requests against the same AWS account.
**Fix**: Add a `resolveCredentials(ctx: AICallContext): Promise<{...}>` indirection. Source per-tenant credentials from the secret store (BYOK) when configured, fall back to a system key. Redact on log lines and never put the key in error messages.
**Effort**: L

### A4: No prompt-injection or output guardrails before tool execution · high · security
**File**: `apps/helix/src/platform/assistant/orchestrator.ts:177-209`
**What's wrong**: Tool calls returned by the model are dispatched after only an "is the tool visible?" check and `requiresAssistantConfirmation` (a static side-effect classification). There is no sanitization of `toolCall.input`, no policy filter on per-tool argument values, and no instruction-isolation strategy for untrusted content pulled in by `collectSearchContext`. A document the user pastes (or a SharePoint file retrieved by RAG) can carry instructions like "call `mail.send` with X" and they will be executed once the user happens to be allowed to send mail.
**Fix**: Treat retrieved sources as untrusted: wrap in explicit `<source>` blocks the system prompt warns about, deny tool calls whose arguments contain bytes from those blocks, and add a per-tool argument allow-list / regex check. Always require confirmation for any tool argument that targets a recipient outside the current org.
**Effort**: L

### A5: No PII redaction in prompts or provenance records · high · security
**File**: `apps/helix/src/platform/ai/routing.ts:516-532`, `apps/helix/src/platform/ai/provenance.ts:46-67`
**What's wrong**: The router computes `hashJson(request)` and `hashJson(output.message)` but the provenance metadata also passes `usage`, `routing`, and trace context with no redaction. More importantly, the actual content is sent to the provider with no PII scrub, even when the classification service has the heuristics (`classification/service.ts:34`). The `ai-observability.tsx` UI advertises `redactPIIBeforeSend` as a configurable setting, but I found no enforcement path in the router.
**Fix**: Add an optional `PiiRedactor` injected into `AIRouter` that runs over each message before provider dispatch when `policy.privacy.redactPIIBeforeSend` is true. Strip the same fields from any provenance metadata that is persisted.
**Effort**: M

### A6: No per-tenant rate limiting on AI calls · high · security
**File**: `apps/helix/src/platform/ai/costs/` (entire directory)
**What's wrong**: The cost guard enforces a daily USD-micros budget but there is no concurrency cap, RPS cap, or token-per-minute throttle. A runaway client (or a tool-loop bug — see A8) can burn the entire daily budget in a few seconds, hammer provider rate limits, and DoS other tenants because providers share the process-level key.
**Fix**: Add a `RedisAIRateLimiter` modeled after `RedisAICostLimiter` that enforces RPS and concurrency per `(orgId, providerId)` and per `(orgId, actorId)`. Reuse the existing `RedisAgentRateCostLimiter` Lua pattern.
**Effort**: M

### A7: Cost reservation leaks on aborted streams · high · correctness
**File**: `apps/helix/src/platform/ai/routing.ts:237-302`
**What's wrong**: `#chatStream` calls `costGuard.reserve()` before yielding chunks, then calls `costGuard.record()` in `#finalizeStream`. If the client disconnects mid-stream (or the for-await throws after `reserve` but before reaching `finalizeStream`), the reservation is gone but no record is made and no compensating release runs. Over time the actor's "remaining" budget drifts upward of true spend. The non-streaming path has the same shape (`routing.ts:466-485`).
**Fix**: Wrap the stream consumer in `try { ... } finally { await record(estimatedOrPartial) }`. Track partial usage from received chunks so partial billing is at least bounded; if `record` runs without `reserve` it should be a no-op release.
**Effort**: S

### A8: `maxToolRounds = 3` is too small and silently truncates · medium · correctness
**File**: `apps/helix/src/platform/assistant/orchestrator.ts:64`, `140`
**What's wrong**: When the model wants more than three tool rounds, the loop exits without telling the model or the user — the final assistant message is whatever was generated in round 3, even if it ends with `toolCalls: [...]` still pending. There is no indicator in the response, no `truncated: true` flag, and no telemetry. The streaming path also yields the final `final` event with no warning.
**Fix**: Make the limit a per-tenant policy setting (admin config), and when reached, append a synthetic tool-error message ("Tool round limit reached") into the conversation so the model can produce a graceful close. Emit a metric `helix_assistant_tool_rounds_truncated_total`.
**Effort**: S

### A9: Streaming path does not surface tool calls from non-OpenAI-shaped providers · medium · correctness
**File**: `apps/helix/src/platform/assistant/orchestrator.ts:1003-1022`
**What's wrong**: `toolCallsFromStreamMetadata` only inspects `metadata.toolCalls`. The router's `#chatStream` adopts metadata from the provider stream, but a provider that emits its final `done` chunk without populating `metadata.toolCalls` (e.g., the non-streaming fallback path that emits `metadata: { model }` and forgets to include toolCalls except as a nested shape) will lose them silently — Bedrock/Anthropic providers route through `#emitNonStreamingFallback` (`routing.ts:333-357`) which only re-serializes `response.toolCalls` if they're already on the response. Result: streamed Bedrock conversations cannot call tools.
**Fix**: Have `#emitNonStreamingFallback` include `toolCalls` even when empty, and unit-test "Bedrock streams emit tool calls" via the orchestrator end-to-end.
**Effort**: S

### A10: Provider fallback only triggers on errors, not on slow/hung providers · medium · correctness
**File**: `apps/helix/src/platform/ai/routing.ts:303-323`, `1121-1123`
**What's wrong**: `shouldTryFallback(error)` flips to fallback only on a thrown error other than `AICostLimitExceededError`. If a provider hangs or returns garbage with a 200, the request stalls forever — there is no per-attempt timeout and no `AbortController` plumbed through. The PRD promises fallback when "a provider is down."
**Fix**: Accept `timeoutMs` on `AIRouterOptions`, race the provider call against `setTimeout(timeoutMs).then(() => throw)`, and abort the underlying fetch via `AbortSignal`.
**Effort**: M

### A11: Conversation context truncation is naive (`historyLimit = 24`) · medium · correctness
**File**: `apps/helix/src/platform/assistant/orchestrator.ts:65`, `135`
**What's wrong**: History is sliced by message count only; there is no token budget. A long-running thread with 24 multi-thousand-token messages will exceed the model context and either fail or silently get the back-end of the window dropped by the provider, losing the system prompt the assistant just composed.
**Fix**: Compose history backward by tokens (use `provider.countTokens`) until the budget is hit, always keeping the system message; trim from the middle with a summarization step when over budget.
**Effort**: M

### A12: `hashJson(request)` over the raw request includes API-key-like fields · medium · security
**File**: `apps/helix/src/platform/ai/routing.ts:521`, `931`
**What's wrong**: `hashJson(request)` serializes the full `ChatRequest`, including any `metadata` callers pass in. If a feature ever puts secrets into `request.metadata` (already happens for `providerId` and could happen for auth-token override) those bytes land in the provenance row's `input_hash` derivation. The hash itself is one-way, but the function is also used for log keys downstream and `metadata` is persisted verbatim in `#finalizeStream`.
**Fix**: Hash only `messages` + `tools` + `feature` + `model`. Strip `metadata` from the persisted provenance row, or at least allow-list the keys (`visibleTools`, `sourceIds`, `memoryIds`, classification).
**Effort**: S

### A13: `tool` messages re-serialize the full tool output into chat history · medium · security
**File**: `apps/helix/src/platform/assistant/orchestrator.ts:194-202`, `972-980`
**What's wrong**: `toolResultContent(result)` stringifies the full `result.output` as the message body, and that body is fed back into the next provider call via `promptMessages.push(toAIMessage(toolMessage))`. If a tool returns sensitive data (passwords, internal user PII, signed URLs), every subsequent turn ships those bytes to the model — and to the provenance record.
**Fix**: Add a per-tool `redactOutput?(output): JsonValue` hook and apply it before persistence + before re-injection into the model context. Default to the existing behavior but require destructive/external_communication tools to define a redactor.
**Effort**: M

### A14: Pending-confirmation UI is not wired in the surface · high · feature_completeness
**File**: `apps/web/src/features/assistant/assistant-surface.tsx` (entire file)
**What's wrong**: The backend returns `pendingConfirmations` on every turn (`api.ts:67`), and there's a `tool-decisions.ts` helper, but `AssistantSurface` never reads `turn.pendingConfirmations` or renders an Approve / Cancel prompt. A model that wants to call a destructive tool will appear to the user as a silent no-op response — the conversation hangs waiting for a confirmation the user has no UI to give.
**Fix**: When the streamed `final` event contains `pendingConfirmations`, render an inline confirmation card with Approve / Cancel buttons that call `decideAssistantToolCall`. Then re-stream the resumed turn.
**Effort**: M

### A15: Model selector in the composer is fake · high · feature_completeness · stubs
**File**: `apps/web/src/features/assistant/assistant-data.ts:93-100`, `assistant-surface.tsx:1267-1325`
**What's wrong**: `ASSISTANT_MODELS` is a hard-coded list of marketing names; the selected value is never passed to `streamAssistantChat` and never reaches `assistant.chat`. The backend has no per-conversation model override either (`tools.ts:37-44` does not accept a model).
**Fix**: Either remove the selector or wire it: load real models from `GET /api/ai/providers/models` (router has `listProviders`), pass `metadata.providerId` / `metadata.model` through the chat tool, and respect it server-side in `#selectProviderAttempts` (currently only honors `providerId`, not `model`).
**Effort**: M

### A16: Attachment / mention buttons in composer have no handlers · medium · feature_completeness · stubs
**File**: `apps/web/src/features/assistant/assistant-surface.tsx:1302-1310`
**What's wrong**: Paperclip, Doc, and Users buttons render but have no `onClick`. The PRD-promised "@mention a doc, person, or file" feature is placeholder UI.
**Fix**: Remove the buttons or implement at least the @mention picker backed by the existing search service.
**Effort**: M

### A17: No system-prompt customization or per-tenant assistant persona · medium · feature_completeness
**File**: `apps/helix/src/platform/assistant/orchestrator.ts:873-896`
**What's wrong**: `systemMessage()` returns a hard-coded "You are Helix Assistant." prefix. There is no way for a tenant admin to add a persona, brand voice, allow/deny topics, or compliance disclaimer. PRD §AI Governance lists this as a tier-1 deliverable.
**Fix**: Add `tenantSystemPrompt` to `AssistantOrchestratorOptions`, sourced from admin config (`tenant-config.ts`). Prepend it to the system message after the platform preamble.
**Effort**: S

### A18: No conversation share, export, or save · medium · feature_completeness
**File**: `apps/helix/src/platform/assistant/tools.ts` (entire file)
**What's wrong**: Tools cover create/list/pin/rename/delete/chat/forget — but no share, no permalink, no export to Markdown/PDF, no fork-from-message. The PRD calls these out for Assistant parity.
**Fix**: Add `assistant.conversation.share` (creates a shareable link gated by org policy) and `assistant.conversation.export` (returns Markdown). Both need their own ACL.
**Effort**: M

### A19: AI Observability dashboard is mostly hard-coded fake data · medium · stubs
**File**: `apps/web/src/features/admin/ai-observability.tsx:44-87`
**What's wrong**: `metricRows` is a static literal. The "Status" column says "Dashboard provisioned" / "Pending live telemetry" but there is no live read from Prometheus. The "Top-cost actors" row literally says it requires runtime data. To an admin, the page looks populated but reflects nothing about their environment.
**Fix**: Either gate the page behind a "metrics integration not configured" empty state, or wire it to `/api/admin/ai/usage` (the limiter already has `summarize()` in `in-memory-limiter.ts:128` and a Postgres equivalent should exist).
**Effort**: M

### A20: AI cost-limits admin UI accepts any UUID as actor without existence check · low · correctness
**File**: `apps/web/src/features/admin/ai-cost-limits-management.tsx:302-324`
**What's wrong**: `normalizeFormInput` validates UUID shape but the upsert silently writes overrides for actors that may not exist. There is no actor picker, so typos create orphaned override rows that confuse later audits.
**Fix**: Make the actor input an autocompleting picker over `/api/admin/users`; server-side, reject overrides for unknown actor IDs.
**Effort**: S

### A21: `routing.ts` duplicates ~400 lines between `#chat` and `#chatStream` · medium · code_quality
**File**: `apps/helix/src/platform/ai/routing.ts:210-330`, `431-570`
**What's wrong**: Attempt selection, classification gating, cost reserve/record, metrics, span attributes, and provenance recording exist twice with subtle drift (e.g., the stream path adds `streamed: true` to provenance, the chat path does not record `streamed: false`).
**Fix**: Extract a shared `#executeAttempt(invoke: (provider) => Promise<ChatResponse>)` helper that handles reserve / metrics / provenance, and let the two callers pass the actual provider invocation lambda.
**Effort**: M

### A22: `parseEmbeddingResponse` rejects size mismatch with `TypeError`, no retry · low · correctness
**File**: `apps/helix/src/platform/ai/embeddings/openai-compatible.ts:92-106`
**What's wrong**: If the embedding API returns fewer vectors than requested (partial outage, content-policy block), the entire batch fails and the caller (memory store, RAG worker) has no path to retry or fall back.
**Fix**: Surface a `EmbeddingPartialResultError` carrying the partial vectors so callers can decide; add provider-side fallback to `AIRouter`-style attempts for embeddings.
**Effort**: M

### A23: Memory recall has no opt-in check in `PostgresMemoryStore.recall` · medium · security
**File**: `apps/helix/src/platform/ai/memory/postgres.ts:42-68`
**What's wrong**: The orchestrator gates recall on `conversation.memoryOptIn` (`orchestrator.ts:773`), but the store itself does not consult the actor's memory preference. Anyone calling `memory.recall(actor, ...)` directly (e.g., a new feature, or a misbehaving agent) bypasses the user's consent.
**Fix**: Either require an explicit `memoryConsent: true` argument on `recall`, or read `assistant_memory_preferences` inside `recall` and return `[]` when disabled.
**Effort**: S

### A24: `assistantToolPendingId` heuristic match-by-toolId is ambiguous · low · correctness
**File**: `apps/web/src/features/assistant/api.ts:422-431`
**What's wrong**: When the model calls the same tool twice in one round, `pendingConfirmations.find(p => p.toolId === toolCall.toolId)` returns only the first match. Approving / cancelling will operate on the wrong invocation.
**Fix**: Match by an opaque `toolCallId` once the backend includes it on each pending entry; if absent, throw rather than guess.
**Effort**: S

### A25: `AICostLimitExceededError.reason` always reports `actor_daily_cost` when allowed · low · correctness
**File**: `apps/helix/src/platform/ai/costs/redis-limiter.ts:246-249`
**What's wrong**: `checkScriptResponse` sets `reason: allowed ? "actor_daily_cost" : scriptReason(parts[1])`. When `allowed === true` the reason is meaningless but defaulting to `"actor_daily_cost"` is misleading if any downstream telemetry reads it. The in-memory limiter does not have this property.
**Fix**: Make `reason` optional and omit it when `allowed` is true.
**Effort**: S

### A26: No tests on provider fallback ordering or classification + fallback interaction · medium · code_quality
**File**: `apps/helix/src/platform/ai/routing.test.ts`
**What's wrong**: The routing test file is large (25 KB) but a spot check shows coverage focuses on selection rather than: (a) primary fails → fallback succeeds → metrics record both attempts with `fallback: true` only on the second; (b) primary is classification-blocked → fallback is selected if allowed; (c) fallback is also blocked → original error is rethrown unchanged. These are the high-risk paths.
**Fix**: Add table-driven tests over (primary-state, fallback-state, classification) × (allowed, blocked, error) and assert metric labels.
**Effort**: M

### A27: SSE assistant streaming has no heartbeat or backpressure handling · low · correctness
**File**: `apps/web/src/features/assistant/api.ts:192-223`
**What's wrong**: The client SSE reader has no `keepalive` / `:ping` handling — many proxies (CloudFront, nginx default) will drop an idle SSE connection after 60s. The server side `#chatStream` also does not periodically yield a comment frame during long model thinking.
**Fix**: Emit `: ping\n\n` from the SSE writer every 15s; on the client, treat unparseable frames as ignorable and reset a timeout.
**Effort**: S

## Top three to fix this sprint
1. **A1** (pgvector tenant scoping) — single biggest data-leak risk.
2. **A2 + A4 + A5** (classification trust, prompt-injection, PII) — together they decide whether the platform is safe for "confidential" data.
3. **A14 + A15** (pending-confirmation UI, real model selector) — the Assistant looks shipped but two flagship features are placeholders.
