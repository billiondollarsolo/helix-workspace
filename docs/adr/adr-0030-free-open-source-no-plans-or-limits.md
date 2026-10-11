# ADR-0030: Helix is free and open source with no plans or limits

## Status

Accepted (2026-10-11). Supersedes the plan-gating parts of
[ADR-0017](adr-0017-byo-everything-per-tenant.md), [ADR-0025](adr-0025-openfeature-in-db-flags.md)
and [ADR-0028](adr-0028-tenant-config-jsonb.md).

## Context

Helix needs one licensing and packaging model for every deployment, self-hosted or
multi-tenant. The owner's decision: Helix is 100% open source and free to use however people
want, with no limits.

## Decision

- Helix is licensed under Apache-2.0 (see `LICENSE`), chosen for its permissive terms and
  explicit patent grant. There is no commercial edition, no license key and no paid feature.
- There are no plans. The effective tenant config is system defaults, then the org's own
  overrides.
- Every org gets every feature. Tenant feature flags are org-admin policy switches (an admin
  may turn outbound mail or Assistant workspace retrieval off for their own workspace), and
  each one is enforced where the feature runs. A flag that no code reads is removed, together
  with its stored values.
- Every quota defaults to `null`, meaning unlimited: storage, AI tokens and images, actors,
  outbound webhooks, integration API requests per second and export jobs per hour. An org
  admin may still set an explicit cap on their own tenant.
- Agent and AI cost budgets have no default for any security tier. An admin-configured budget
  still applies.
- Usage metering serves observability and capacity planning. Code publishes metering events
  on the NATS subject `metering.events.<orgId>`; the `metering-ingest` worker stores them in
  `metering_events`, and the `metering-rollup` worker aggregates completed days per org and
  metric into `metering_rollups`. The metrics are AI tokens, AI images generated, storage
  deltas with a daily average, and completed exports.

## What stays

These are security and safety controls, not plan limits:

- authorization, tenant isolation (row-level security, per-tenant roles, Cerbos) and the
  multi-tenant deployment mode;
- security tiers (`personal`, `business`, `enterprise`, `sovereign`) and their posture,
  including sovereign's local-only AI;
- malware scanning, retention and the immutable audit trail;
- per-request caps that protect the server: body size, upload chunk size, recipient
  expansion, concurrent event streams and the per-session browser request budget.

## Alternatives considered

- **Open core with license-gated premium features.** Rejected: it splits the product and
  needs license keys, payments and enforcement code that serve no user.
- **Plans with every plan unlimited.** Rejected: it keeps a commercial concept in the
  schema, the API and the admin UI with nothing behind it.

## Consequences

- New and existing orgs get every feature and no quota without any migration of their own
  data; explicit admin overrides in `orgs.quotas` and `orgs.feature_flags` are kept.
- A suspended tenant answers `423 Locked` with code `tenant-suspended`.

## Reversal triggers

None planned. Reintroducing paid features or plans would need a new ADR that supersedes this
one.
