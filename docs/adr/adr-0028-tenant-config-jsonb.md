# ADR-0028: Per-Tenant `tenant_config` as JSONB on `orgs` Table

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Platform v2 P-A.3)

## Context

Per-tenant settings, feature flags, quotas, BYO config, and branding must be stored. Options:

1. **JSONB columns on `orgs`** — `byo_config`, `feature_flags`, `quotas`, `branding`. Schemaless flexibility. One row per tenant.
2. **Normalized tables** — `tenant_settings(orgId, key, value)`. More queryable; more tables.
3. **Hybrid** — typed columns for hot fields (`tier`, `region`, `status`); JSONB for flexible/extensible config.

## Decision

We will use **JSONB columns on `orgs`** for `byo_config`, `feature_flags`, `quotas`, `branding`. Hot single-value fields (`tier`, `region`, `status`, `slug`, `name`, timestamps) stay as typed columns. `tenant_config_audit` table tracks changes for compliance.

Typed accessor in `@helix/sdk`:

```ts
const cfg = await tenantConfig.get(orgId);
cfg.feature_flags.editors_native_document; // typed
cfg.quotas.storage_bytes_limit; // typed
cfg.byo.storage?.bucket; // typed optional
```

JSONB shapes validated by Zod schemas at read + write.

## Consequences

### Positive

- One Postgres row read per tenant per request (cached aggressively).
- Schema evolution by adding fields to Zod schema, no migration.
- Per-tenant overrides cleanly diff-able for audit.
- JSON queryable with PG operators when needed (`feature_flags->>'editors_native_document' = 'true'`).

### Negative

- No SQL-level index on JSONB fields (mitigation: expression indexes on hot fields if added later).
- Schema validation must be in application layer (Zod), not DB.
- Bloat if `byo_config` grows large (KB scale is fine).

### Neutral

- `tenant_config_audit` table separately handles per-change audit (per compliance).
- Plans contribute defaults; tenant overrides win (per per-tenant-config.md resolution order).

## Implementation

`orgs` table per multi-tenancy.md:

```sql
ALTER TABLE orgs ADD COLUMN byo_config jsonb NOT NULL DEFAULT '{}';
ALTER TABLE orgs ADD COLUMN feature_flags jsonb NOT NULL DEFAULT '{}';
ALTER TABLE orgs ADD COLUMN quotas jsonb NOT NULL DEFAULT '{}';
ALTER TABLE orgs ADD COLUMN branding jsonb NOT NULL DEFAULT '{}';
```

`tenant_config_audit` per per-tenant-config.md. Triggers populate audit on UPDATE.

## Alternatives Considered

### Alt 2: Fully normalized

**Rejected**. Multi-row reads per request; harder schema evolution; same eventual flexibility.

### Alt 3: External config store (Consul, etcd)

**Rejected**. New infra; consistency model harder; loses transactional updates with orgs row.

## References

- `01-platform-v2/per-tenant-config.md`
- `01-platform-v2/multi-tenancy.md`
- ADR-0003 (row-level multi-tenancy)
