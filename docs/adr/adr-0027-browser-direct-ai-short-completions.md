# ADR-0027: Browser-Direct AI for Short Completions; Server-Mediated for Streaming/RAG

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates editors AI Phase 2 + Phase 6)

## Context

AI assists in editors need to feel instant for short ops (rewrite a sentence) and reliable for long ops (generate a 10-slide deck with images). Architecture options:

1. **All browser-direct** — editor calls assistant API directly (via session cookie); lowest latency; assistant tracks token use; works for streaming too.
2. **All server-mediated** — editor calls helix API, helix forwards to assistant; central place for prompt templates + caching + audit.
3. **Hybrid** — short completions browser-direct; complex flows server-mediated.

Audit, metering, and tenant-config (BYO AI) require server visibility regardless. Option 1 still routes through helix-assistant for auth + metering — "browser-direct" means no second hop through `editors-ai-mediator` for short ops.

## Decision

We will use the **hybrid pattern**:

- **Browser-direct** for short completions (<2 KB selection, single-call): editor calls assistant API directly with session cookie. Faster perceived latency. Streaming OK.
- **Server-mediated through `editors-ai-bridge`** for:
  - Multi-step flows (e.g., "generate slide deck" = outline → per-slide content → images).
  - RAG-backed queries (need server-side vector search).
  - Cross-doc operations (e.g., "summarize all my docs about X").
  - Long-context flows >50k tokens.

`editors-ai-bridge` lives in helix-editors core-app; consumes platform `ai-routing` + `vector-store` capabilities. It enforces editor-specific prompt templates, caching, retry, audit annotations.

## Consequences

### Positive

- Lowest latency for the common case (short rewrites/explanations).
- Server-mediated for the complex cases preserves observability + agentic control.
- Prompt templates centralized for complex flows; consistent voice/quality.
- BYO-AI-provider (per ADR-0004) honored uniformly — assistant API does the routing.

### Negative

- Two code paths to maintain (browser-direct + server-mediated).
- Browser-direct calls are still audit-logged (via assistant), but with less context than server-mediated.

### Neutral

- Helix Assistant remains the single AI router for both paths.
- All AI calls metered per ADR-0014.

## Implementation

`@helix/editors-ai-bridge` exposes:

```ts
export async function assistShort(slot: string, selection: string): Promise<string>;
export async function assistStream(slot: string, prompt: string): AsyncIterable<string>;
export async function assistRAG(question: string, contextDocIds?: string[]): Promise<RAGResponse>;
export async function assistMultiStep(flow: string, params: object): Promise<MultiStepResult>;
```

`assistShort` and `assistStream` (small payloads): browser-direct to `/api/assistant/complete`.
`assistRAG` and `assistMultiStep`: server-mediated via `/api/editors/ai/*`.

## Alternatives Considered

### Alt 1: All browser-direct

**Rejected**. Multi-step flows + RAG need server orchestration.

### Alt 2: All server-mediated

**Rejected**. Adds latency to short ops; user perception of AI as "slow."

## References

- `03-editors/editors.md` §13 (AI surface)
- ADR-0004 (BYO-AI-provider)
- ADR-0014 (metering events for AI)
