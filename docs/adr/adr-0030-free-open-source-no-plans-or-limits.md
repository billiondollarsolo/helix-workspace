# ADR-0030: Helix is free and open source with no plans or limits

## Status

Accepted (2026-10-11). Supersedes [ADR-0020](adr-0020-license-key-paid-features.md),
[ADR-0021](adr-0021-apache-2-plus-commercial.md), [ADR-0024](adr-0024-stripe-plus-metering.md)
and [ADR-0026](adr-0026-ed25519-license-keys.md). Supersedes the plan-gating parts of
[ADR-0017](adr-0017-byo-everything-per-tenant.md), [ADR-0025](adr-0025-openfeature-in-db-flags.md)
and [ADR-0028](adr-0028-tenant-config-jsonb.md).

## Context

Earlier proposals described a commercial model: an Apache-2.0 core with paid premium
features, license keys signed with Ed25519, Stripe billing, and commercial plans
(`personal`, `pro`, `business`, `enterprise`, `sovereign`) that set per-org feature flags and
quotas. The code carried part of that model: a `plans` table, an `orgs.plan_id` column, plan
defaults merged into every tenant's effective config, a 5 GB storage fallback, a five-webhook
fallback, a five-requests-per-second API default, a `b2b_sharing` gate on public links, a
`byo_storage` gate on bring-your-own storage, tiered agent and AI cost budgets, and an admin
billing page with an "Upgrade plan" call to action.

The owner's decision: Helix is 100% open source and free to use however people want, with
no limits.

## Decision

- Helix is licensed under Apache-2.0 (see `LICENSE`). There is no commercial edition, no
  license key and no paid feature.
- There are no plans. The `plans` table and `orgs.plan_id` are dropped (migration
  `0202_remove_plans_and_billing.sql`). The effective tenant config is system defaults, then
  the org's own overrides.
- Every org gets every feature. The system defaults turn every feature flag on; the
  remaining flags are org-admin policy switches (an admin may turn outbound mail or an AI
  feature off for their own workspace), not entitlements. Entitlement-only flags
  (`b2b_sharing`, `byo_*`, `sso_saml`, `scim_provisioning`, `custom_domain`, `white_label`,
  `multi_region_dr`, `dedicated_csm`, `marketplace_install_paid`, `support_tier`) are retired;
  old stored values still parse and have no effect.
- Every quota defaults to `null`, meaning unlimited: storage, AI tokens and images, actors,
  outbound webhooks, integration API requests per second and export jobs per hour. An org
  admin may still set an explicit cap on their own tenant.
- Agent and AI cost budgets have no default for any security tier. An admin-configured budget
  still applies.
- There is no billing. The admin billing endpoints, the billing read-model tables and the
  billing section of the admin console are removed.

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

- **Keep the plans table with every plan unlimited.** Rejected: it keeps a commercial concept
  in the schema, the API and the admin UI with nothing behind it.
- **Keep billing as a parked, build-flagged section.** Rejected: there is no billing service
  and none is planned.

## Consequences

- New and existing orgs get every feature and no quota without any migration of their own
  data; explicit admin overrides in `orgs.quotas` and `orgs.feature_flags` are kept.
- Tenant export manifests and signup events no longer carry `planId`; signup metrics no longer
  carry a `plan_id` label.
- The built-in `billing_admin` IAM role and the `admin.billing` permission are retired
  (migration `0203_retire_billing_admin_role.sql`). Existing grants are recorded as revoked
  in the append-only delegation log and then removed, so they no longer appear in admin
  views, APIs or actor authorization.
- A suspended tenant answers `423 Locked` with code `tenant-suspended` (previously
  `402 Payment Required`).

## Reversal triggers

None planned. Reintroducing paid features or plans would need a new ADR that supersedes this
one.
