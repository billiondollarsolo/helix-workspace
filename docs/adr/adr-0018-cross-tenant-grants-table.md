# ADR-0018: Cross-Tenant Sharing via `cross_tenant_grants` Table

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Platform v2 Phase A.7)

## Context

B2B sharing — a user in tenant A wants to share a doc with a user in tenant B — is essential for collaborative work across organizations. Three implementation approaches:

1. **Guest as actor in host tenant**: when alice@acme shares with bob@globex, helix creates a guest actor row in acme. Bob signs into acme (separate from his globex session). Pro: simple ACL model. Con: bob has two identities; "Switch workspace" UI complexity; ACL pollution in host tenant.
2. **Cross-tenant ACL**: bob stays in globex as his primary identity. A separate `cross_tenant_grants` table records that bob (in globex) has access to specific resources in acme. Pro: bob has one identity; cleaner audit; B2B is first-class. Con: requires Cerbos cross-tenant policy + resource routing logic.
3. **Federation**: full federated identity with each tenant's IdP trusting each other. Pro: enterprise-grade. Con: enormous complexity for a v1 feature.

## Decision

We will adopt **cross-tenant ACL via a dedicated `cross_tenant_grants` table** (option 2).

Schema:

```sql
CREATE TABLE cross_tenant_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_org_id   uuid NOT NULL REFERENCES orgs(id),
  resource_kind     text NOT NULL,
  resource_id       uuid NOT NULL,
  grantee_org_id    uuid REFERENCES orgs(id),
  grantee_actor_id  uuid REFERENCES actors(id),
  grantee_email     text,                   -- for unverified/guest invites
  role              text NOT NULL,
  granted_by_actor_id uuid NOT NULL REFERENCES actors(id),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz,
  revoked_at        timestamptz,
  share_link_id     uuid,
  metadata          jsonb NOT NULL DEFAULT '{}'
);
```

Cerbos extends with a `cross_tenant` derived role that grants permission when the requesting actor matches a grant for the target resource.

When a cross-tenant request arrives:

1. Tenant middleware sets `req.orgId` = requester's home tenant.
2. Resource resolver checks if the requested resource is in another tenant; if so, looks up `cross_tenant_grants`.
3. If grant exists + unexpired + unrevoked → request proceeds against the resource's home tenant's DB.
4. Audit emitted in both tenants.

Guests (option 1 sub-case) are handled by setting `grantee_email` without `grantee_actor_id` — magic link issues a session scoped to that grant.

## Consequences

### Positive

- Bob has one helix identity in globex; no workspace-switching tax.
- Helix tenant admins see all grants outgoing + incoming cleanly.
- DLP + audit naturally bilateral.
- Future federation is incremental on top of this primitive.
- Permission revocation is a single row update.

### Negative

- Cerbos policies are more complex (cross-tenant derived role logic).
- Resource resolver has to route across DBs when grants exist.
- Per-tenant Postgres roles complicated by cross-tenant grants (must temporarily elevate to resource owner's role on grant-authorized access; carefully scoped to prevent abuse).

### Neutral

- Tenant admin policy (`security_policies.external_sharing`) gates allowed grant patterns (off / same-domain / approved-tenants / unrestricted).

## Alternatives Considered

### Alt 1: Guest as actor in host tenant

**Rejected**. Identity confusion; ACL bloat in host tenant; no clean "view my granted resources" surface for grantees.

### Alt 3: Federation

**Rejected for v1**. Massive scope; few customers need full federation; cross-tenant ACL provides 95% of practical value.

## References

- `01-platform-v2/b2b-sharing.md`
- `decisions-owed.md` P3
