# ADR-0022: CloudNativePG Async Replica for Multi-Region DR

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Platform v2 P-A.10 multi-region)

## Context

Enterprise tier customers (and beyond) require multi-region disaster recovery with measurable RTO/RPO. Three primary options for Postgres DR:

1. **CloudNativePG `replicaCluster`** — Kubernetes-native operator for Postgres; supports streaming async/sync replicas in same or different clusters; PITR via WAL archive; existing helix Helm chart already uses CloudNativePG.
2. **Logical replication** — pglogical / native pub-sub; per-table granularity; more flexibility; more operational complexity; slower failover.
3. **Application-level replication** — write to multiple databases at app layer; high control; massive complexity; not a real option for SaaS scale.

helix-workspace already uses CloudNativePG (`cloudnativepg-cluster.yaml` + `cloudnativepg-scheduledbackup.yaml` in the Helm chart).

## Decision

We will use **CloudNativePG `replicaCluster`** for cross-region async replication. Primary cluster in tenant's home region; warm replica cluster in DR region. Failover via promotion (manual or automated on health-check breach).

RTO/RPO targets (per tier):

- **Enterprise**: RTO 1h / RPO 5min (warm async replica + DNS cutover).
- **Sovereign**: RTO 30min / RPO 1min (sync replica or per-contract).

## Consequences

### Positive

- Reuses existing CloudNativePG operator + helm chart pattern.
- Battle-tested CloudNativePG features: backup, PITR, ScheduledBackup, failover.
- Familiar operator pattern; SRE team learns one tool.
- Per-tenant region pinning still works (each tenant placed in single primary region; DR replica in paired region).
- WAL archive enables point-in-time-recovery to seconds before incident.

### Negative

- Async replication has small data loss window (~5s typical, defines RPO).
- Failover requires DNS cutover + connection pool flush; brief disruption.
- Promoted DR replica becomes new primary; un-promote-back complex; usually requires fresh re-replication.
- Cost: 2x Postgres infrastructure for Enterprise+ tenants opting into DR.

### Neutral

- Sovereign tier can opt into sync replication for tighter RPO (cost: latency overhead on every write).
- Per-tenant routing logic must know primary region; CDN/Caddy ingress handles.

## Implementation

- Helm chart adds optional `replicaCluster` configuration to existing `cloudnativepg-cluster.yaml` template.
- Per-region operator instance manages cluster lifecycle.
- WAL shipping via S3 in customer-chosen region (with cross-region replication for Sovereign).
- Failover runbook in `05-operations/runbooks/region-failover-real.md`.
- DR drill quarterly via `region-failover-drill.md`.

## Alternatives Considered

### Alt 2: Logical replication

**Rejected**. Operational complexity (per-table setup, schema-drift handling); slower failover; loses some Postgres features (sequences need special handling); insufficient gain.

### Alt 3: Application-level dual-write

**Rejected**. Massive coordination burden; eventual consistency complexity; inadequate at scale.

### Alt 4: Multi-region active-active (e.g., CockroachDB, YugabyteDB)

**Rejected for v1**. Requires re-architecting around distributed-SQL constraints (no triggers, eventual-consistency semantics); enormous scope; lose Postgres ecosystem benefits. Revisit in v2+ if multi-region active-write becomes top-tier requirement.

## References

- `01-platform-v2/multi-region.md`
- `05-operations/runbooks/postgres-failover.md` (to write)
- `decisions-owed.md` P8
- CloudNativePG docs (external)
