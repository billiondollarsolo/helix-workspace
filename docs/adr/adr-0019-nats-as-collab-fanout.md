# ADR-0019: NATS as Cross-Replica Collab Fanout + Event Bus

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Platform v2 multi-replica + editors Phase 5 scale-out)

## Context

helix-workspace already uses **NATS** as its event bus (per PRD §3 + plugin-host services). When `apps/helix` runs in multi-replica mode, ops landing on replica A must reach clients connected to replica B. Three transport options:

1. **NATS** — already deployed; pub/sub natively suited; durable streams (JetStream) available; subject hierarchy maps cleanly to tenants/docs.
2. **Redis pub/sub** — Redis already deployed for cache. Could double-purpose.
3. **PostgreSQL LISTEN/NOTIFY** — no new infra; integrates with op log; lower throughput; no per-subject scoping.

## Decision

We will use **NATS** for cross-replica collab fanout:

- **Subjects**: `tenants.<orgId>.doc-op.<docId>`, `tenants.<orgId>.sheet-op.<sheetId>`, `tenants.<orgId>.slide-op.<deckId>`, `tenants.<orgId>.presence.<resourceKind>.<resourceId>`.
- **Pattern**: each replica subscribes to subjects for docs it has active sessions on. Replica receives op locally → publishes to NATS → other replicas receive → broadcast to their connected WS clients.
- **Durability**: presence is ephemeral (no JetStream); doc ops are persisted to Postgres FIRST then NATS-broadcast (eventual consistency for replicas; convergent via op log).
- **Fanout pattern**: client-attached pods do sticky-session WS via ingress; NATS bridges across pods.

Same mechanism powers other cross-product events (mail received, calendar event, plugin lifecycle, audit), so this is uniform with the rest of helix.

## Consequences

### Positive

- Reuses existing NATS infrastructure; no new transport.
- Hierarchical subjects enable per-tenant scoping (`tenants.<orgId>.*`).
- Wildcard subscriptions efficient for cross-cutting concerns (audit).
- JetStream available if we need durable replay (e.g., op recovery if Postgres briefly behind).
- Subject prefix per tenant aligns with multi-tenancy isolation.

### Negative

- NATS becomes critical-path for collab; outage → degraded collab.
- Cross-replica latency adds ~5-50 ms to op broadcast (acceptable; SLO is <100 ms).
- NATS subject cardinality at scale: thousands of active docs = thousands of subjects; needs monitoring.

### Neutral

- Sticky-session WS at ingress still required (clients pinned to one replica per session).
- Graceful pod-shutdown drain pattern unchanged.

## Implementation contract

- Replica subscribes to `tenants.<orgId>.{doc,sheet,slide}-op.<resourceId>` on first WS client joining that resource.
- Replica unsubscribes when last WS client for that resource disconnects (with grace period to avoid flapping).
- Op publish includes correlation_id for de-dup; client's own ops loopback-filtered.
- Presence uses dedicated subjects with shorter TTL; awareness state full-state-publish-every-N-seconds for re-join robustness.

## Alternatives Considered

### Alt 1: Redis pub/sub

**Rejected**. Doubles Redis purpose; loses subject hierarchy; less scalable to thousands of channels; less aligned with existing helix event-bus pattern.

### Alt 2: Postgres LISTEN/NOTIFY

**Rejected**. Lower throughput; doesn't scale to op-rate of busy spreadsheet; couples collab to DB health.

### Alt 3: Per-replica direct WebSocket mesh

**Rejected**. O(N²) connection complexity; ops complexity; no benefit over NATS.

## References

- `01-platform-v2/multi-tenancy.md` (subject scoping)
- `03-editors/editors.md` §12 (collab engines feed NATS)
- ADR-0007 (custom OT for sheets)
- PRD §3 (NATS as event bus)
