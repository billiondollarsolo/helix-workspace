# ADR-0029: Immutable Audit Log via `audit-immutable-s3` Plugin; 7-Year Retention

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Compliance SOC 2 + HIPAA evidence)

## Context

Audit logs are foundational for compliance (SOC 2, HIPAA, GDPR, FedRAMP). Requirements:

- **Immutability** — written-once; can't be modified or deleted by application.
- **Retention** — 7 years (typical compliance baseline).
- **Per-tenant scoping** — tenant admin can see their own; cross-tenant queries staff-only.
- **Shippable** — to SIEM (Splunk/Sentinel/Elastic) for Enterprise+ customers.
- **Performant** — high write rate (every API call, every save, every share).

helix-workspace already has `com.helix.audit-immutable-s3` plugin that ships to S3 with Object Lock. Build atop.

## Decision

We will use **`com.helix.audit-immutable-s3` plugin as canonical audit sink** for all helix products (Platform, Editors, Commercial). Retention 7 years via S3 Object Lock in compliance mode. Per-tenant scoping via `org_id` in every audit event. SIEM ship via `com.helix.audit-siem-syslog` plugin for Enterprise+.

Audit event taxonomy (canonical event types):

- **Auth**: `auth.login`, `auth.logout`, `auth.mfa.challenge`, `auth.sso.login`, `auth.sso.failed`, `auth.session.expired`, `auth.impersonation.*`
- **Tenant**: `tenant.provisioned`, `tenant.suspended`, `tenant.deleted`, `tenant.exported`, `tenant.imported`, `tenant.import.audit_continuity.recorded`, `tenant.region.changed`
- **Identity**: `actor.created`, `actor.updated`, `actor.role.granted`, `actor.role.revoked`, `actor.forgotten` (GDPR), `scim.*`
- **Authorization**: `cerbos.allow`, `cerbos.deny`, `permission.granted`, `permission.revoked`
- **Resource**: `doc.opened`, `doc.saved`, `doc.shared`, `doc.exported`, `doc.suggestion.*`, `doc.comment.*`, `sheet.*`, `slide.*`, `pdf.*`
- **AI**: `ai.request`, `ai.completion`, `ai.failed`, `ai.cost-spike`
- **Plugin**: `plugin.installed`, `plugin.uninstalled`, `plugin.enabled`, `plugin.disabled`
- **Billing**: `billing.plan.changed`, `billing.payment.*`, `billing.suspension`
- **Security**: `security.policy.changed`, `security.kms.revoked`, `security.dlp.blocked`, `security.breach.detected`
- **Cross-tenant**: `share.cross_tenant.granted`, `share.cross_tenant.received`, `share.cross_tenant.revoked`
- **Admin**: `admin.action.*` for any admin console mutation

All events: `{event_type, ts, actor_id, org_id, request_id, ip, user_agent, target_resource, before?, after?, metadata}`.

## Consequences

### Positive

- Reuses existing helix plugin.
- S3 Object Lock = cryptographic immutability; satisfies compliance auditors.
- 7-year retention covers SOC 2 / HIPAA / FedRAMP requirements.
- Per-tenant query: `WHERE org_id = $1` natural filter.
- SIEM integration for customers who require it.

### Negative

- Audit log write volume = ~10-100 events per user-action; storage cost (mitigated by S3 lifecycle to cheaper tiers).
- Cross-tenant analytics queries need read-side aggregation (no joins across tenant boundaries).
- Event schema evolution requires versioning (additive only).

### Neutral

- Hot tier: Postgres `activity` table for last 30 days (existing helix pattern).
- Warm/cold tier: S3 Object Lock.
- Tenant export currently includes a summary-only audit range; import records a
  target-local continuity marker after internal row/object execution, including
  verified self-fetch object-byte restore when used. Import does not mutate,
  splice, or replay historical immutable audit rows until a redacted, versioned
  raw audit replay schema is available (per `tenant-lifecycle.md`).

## Implementation

- All products emit via `host.events.publish('audit.<event_type>', payload)` from SDK.
- `com.helix.audit-immutable-s3` consumes; writes to S3 Object Lock bucket.
- Per-tier configuration in `byo_config.audit_sink` for Enterprise+ to specify their own SIEM URL.
- Query API for tenant admins to fetch their audit log; helix-staff query API for cross-tenant (audit-logged itself).

## Alternatives Considered

### Alt 1: Database-only audit log

**Rejected**. Postgres `activity` table fine for hot queries but not immutable in compliance sense; needs WORM sink.

### Alt 2: Custom audit service

**Rejected**. Plugin already exists; reuse.

## References

- `04-compliance/soc2.md`
- `04-compliance/hipaa.md`
- `04-compliance/gdpr.md`
- `01-platform-v2/tenant-lifecycle.md`
- `com.helix.audit-immutable-s3` (existing helix plugin)
