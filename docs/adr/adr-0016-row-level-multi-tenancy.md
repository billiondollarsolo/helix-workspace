# ADR-0016: Row-Level Multi-Tenancy with Cerbos + Per-Tenant Postgres Roles

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (blocks Platform v2 Phase A.1, A.2)

## Context

Helix's existing schema already has `orgId` columns on every business table (211 files reference `orgId` in `platform/`). To turn this into safe multi-tenancy we must enforce isolation through layered defenses, not just hope-it-works.

Three isolation models considered:

1. **Database-per-tenant**: complete isolation; expensive at scale; complex backups.
2. **Schema-per-tenant**: shared DB, separate schemas; better isolation than row-level; medium operational complexity.
3. **Row-level (orgId on every row)**: shared schemas; minimal operational overhead; relies on query-time enforcement.

Each is a real product on the market. Row-level is most common for SaaS at scale (Notion, Linear, Vercel, etc.) when paired with rigorous enforcement. Database-per-tenant is common for high-isolation regulated industries (some healthcare SaaS).

## Decision

We will adopt **row-level multi-tenancy** with **three layers of defense**:

1. **Cerbos policy enforcement**: every resource carries `attr.orgId`; every policy rule asserts `principal.attr.orgId == resource.attr.orgId` (or explicit cross-tenant grant).
2. **`tenantScoped()` Drizzle query wrapper**: all reads/writes go through a typed wrapper that injects `WHERE org_id = $1`. Direct `db.select(...).from(orgScopedTable)` is a lint error.
3. **Per-tenant Postgres roles**: each tenant gets a normalized `helix_tenant_<orgId_with_underscores>` role; backend `SET LOCAL ROLE` per request; row-level security (RLS) policies enforce `org_id = helix_current_org_id()`.

A leak must penetrate ALL THREE LAYERS. Adversarial CI test gates merges.

Database-per-tenant is reserved for **BYO-database** (Enterprise tier) as a customer-choice premium isolation option, not the default.

## Consequences

### Positive

- Reuses existing schema (orgId already there).
- Shared backups + monitoring + ops (one DB to operate at small/medium scale).
- Defense in depth: a Cerbos miss is caught by Drizzle wrapper; a wrapper miss is caught by RLS.
- Per-tenant Postgres roles enable per-tenant query plan cache, statistics, and (with CloudNativePG) per-tenant pg_stat visibility.
- Scales to ~10k+ tenants on commodity Postgres.

### Negative

- Codemod required to wrap all existing `db.select(...).from(orgScopedTable)` call sites.
- Lint rule maintenance.
- RLS adds small query-time overhead (typically <2 ms per query).
- A bug in `SET LOCAL ROLE` could break a request (failure mode: 503, not data leak — RLS denies).

### Neutral

- BYO-database remains a separate concern for tenants who need true database isolation.
- Tenant data co-located in same physical Postgres makes backups one operation but recovery of one tenant requires per-table DELETE under that tenant's RLS.

## Alternatives Considered

### Alternative 1: Database-per-tenant as default

**Rejected** for default. Operational overhead (one DB per tenant) crushes ops at scale; backups, monitoring, migration, cost.

### Alternative 2: Schema-per-tenant

**Rejected**. Less common pattern; migration runner complexity to apply to N schemas; doesn't materially improve isolation over row-level + per-tenant Postgres role.

### Alternative 3: Row-level only (no per-tenant role, no Cerbos enforcement)

**Rejected**. Single-layer defense; a single application bug can leak cross-tenant.

## References

- `01-platform-v2/multi-tenancy.md` (implementation detail)
- `01-platform-v2/isolation.md` (related layers)
- `01-platform-v2/byo-database.md` (Enterprise customer-choice premium isolation)
- ADR-0002 (mode contract that requires this)
- Notion engineering blog on row-level tenancy (external reference)
