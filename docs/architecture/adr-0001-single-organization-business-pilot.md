# ADR-0001: Single-organization Business pilot

- **Status:** Accepted
- **Date:** 2026-07-28
- **Plan decision:** RD-1

## Context

Helix has organization-scoped models and a multi-tenant operating mode, but its current inbound and
outbound mail bootstrap paths still rely on a default organization. Public multi-tenant SaaS also
requires tenant lifecycle, billing, abuse response, per-tenant keys and provider secrets,
noisy-neighbor controls, and independent isolation evidence. Claiming that operating shape at
launch would exceed the available operational evidence.

The initial deployment needs a small, credible support boundary without permitting implementation
shortcuts that would make later tenant isolation unsafe.

## Decision

Launch the `business` security tier as one organization with 5–50 trusted users. Treat this as the
only supported production shape for the initial dogfood and private pilot.

All application interfaces, persistence, queues, caches, events, authorization, credentials, and
resource identifiers must still be organization-scoped. Cross-organization negative tests remain
release requirements. `HELIX_DEFAULT_ORG_ID` may not become implicit authorization or a tenant
identity fallback in code intended for multi-tenant operation.

Public multi-tenant SaaS is not part of this launch.

## Alternatives considered

- **Public multi-tenant SaaS at launch:** rejected because tenant lifecycle, routing, isolation,
  abuse, billing, and operational controls are not yet proven together.
- **Remove tenant-aware internals for simplicity:** rejected because it creates security debt and a
  migration hazard without materially simplifying the pilot.
- **Personal-only deployment:** rejected because the pilot needs Business controls, shared
  administration, and measurable recovery behavior.

## Consequences

- Deployment and support documentation must present the one-organization limit prominently.
- The default pilot cap is 50 users; exceeding it requires a capacity review.
- Tenant-safe queries and negative tests cannot be omitted merely because only one organization is
  configured.
- Product claims must not describe the pilot as public SaaS-ready.
- Pilot evidence can focus on one organization, while routing and isolation tests must still use at
  least two organizations where they prove a security boundary.

## Reversal triggers

Reconsider only after the public SaaS gate in the production-readiness plan passes, including
tenant-aware mail routing, independent tenant-isolation testing, tenant lifecycle and deletion,
per-tenant secrets and storage controls, noisy-neighbor load tests, abuse operations, and
per-tenant kill switches.
