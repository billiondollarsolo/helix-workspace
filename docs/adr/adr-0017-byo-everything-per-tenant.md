# ADR-0017: BYO-Everything as Per-Tenant Policy

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Platform v2 Phases A.4–A.6, A.9)

## Context

Enterprise + Sovereign customers commonly demand control over data + crypto + identity + AI + database. Common postures:

- BYO-storage (customer-managed S3-compatible bucket)
- BYO-database (customer-managed Postgres)
- BYO-KMS (customer-managed encryption keys)
- BYO-identity (customer-managed SAML/OIDC)
- BYO-AI-provider (customer-managed LLM + embedding endpoints)

These can be implemented as global per-deployment settings, or as per-tenant settings within a multi-tenant SaaS. The latter is harder but required for SaaS to compete with self-host for sovereignty-conscious customers.

## Decision

We will implement **all five BYO surfaces as per-tenant policy** stored in `orgs.byo_config` JSONB. Each tenant configures independently. Helix-managed defaults for tenants who don't configure BYO. Resolvers (`resolveStorageForOrg(orgId)`, `dbForOrg(orgId)`, etc.) read per-tenant config + Vault secrets and route accordingly.

This applies to both deployment shapes:

- **Self-host**: single tenant; BYO becomes "I choose my own infra" config rather than per-tenant variance.
- **SaaS**: per-tenant BYO is a tier-gated feature (Enterprise+ for storage/DB/KMS; Pro+ for AI provider).

## Consequences

### Positive

- Customers retain data sovereignty even in SaaS.
- Helix cannot decrypt content under BYO-KMS — customer trust amplified.
- Migration SaaS → self-host is realistic because BYO-storage paths can carry over directly.
- Single codebase serves both deployment shapes uniformly.

### Negative

- Resolver overhead on every storage/DB/KMS/AI call.
- Per-tenant connection pools must be managed (memory, eviction).
- Customer infra failures become helix's customer-facing problem; clear failure modes + alerts mandatory.
- Vault path proliferation per tenant per BYO type; secret-rotation tooling required.

### Neutral

- BYO defaults to "Helix-managed" for any tenant that doesn't configure — no forced disruption.
- BYO surfaces have to be documented in Trust Center + admin console UI.

## Alternatives Considered

### Alt 1: Global deployment-level BYO only (no per-tenant)

**Rejected**. Forces self-host model for sovereignty; loses competitive position for SaaS Enterprise.

### Alt 2: BYO-storage only, defer others to v2

**Rejected**. Storage without KMS is half the value proposition. SAML / SCIM needed for Enterprise SSO regardless.

### Alt 3: BYO via plugin extensibility (each BYO becomes a plugin)

**Rejected**. Per-tenant resolver pattern is cleaner; BYO is a per-tenant configuration of an existing platform capability, not a separate plugin contract.

## References

- `01-platform-v2/byo-storage.md`
- `01-platform-v2/byo-database.md`
- `01-platform-v2/byo-kms.md`
- `01-platform-v2/byo-identity.md`
- `01-platform-v2/byo-ai-provider.md`
- `decisions-owed.md` items P4, P5
