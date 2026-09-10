# ADR-0024: Stripe + Metering Events for Billing

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Commercial Phase B.2 + B.3)

## Context

Multi-tenant SaaS billing requires:

- Invoice generation
- Payment processing (cards, ACH, wires for Enterprise)
- Subscription management (recurring, proration, upgrades)
- Metered usage (AI tokens, storage, seats)
- Tax calculation (per jurisdiction)
- Dunning + retries
- PCI-DSS scope minimization

Options:

1. **Build in-house** — full control; massive scope; PCI Level 1.
2. **Stripe** — industry standard; mature subscriptions + Metered Usage API + Tax + Connect.
3. **Paddle / Chargebee / Recurly** — merchant-of-record (Paddle) or billing platform.
4. **Hybrid**: Stripe for SaaS; manual invoicing (ops-led) for Enterprise.

## Decision

We will use **Stripe + emit metering events to a NATS subject, daily rollup into Stripe Metered Usage records**.

Architecture:

- Application code emits `metering.events.<orgId>` to NATS with `{event_type, quantity, metadata}`.
- Worker `metering-ingest` consumes → writes `metering_events` Postgres table.
- Nightly worker `metering-rollup` aggregates by tenant+period+metric → `metering_rollups`.
- Worker `metering-stripe-sync` reports rollups to Stripe Metered Usage API.
- Stripe generates invoices; webhook to helix syncs into `admin/billing.ts` read-model.
- Dunning workflow per Commercial spec.

Enterprise tier deals: Stripe Invoice mode (Net 30/60), not subscription mode.

## Consequences

### Positive

- Industry-standard tooling; partner support.
- Stripe handles PCI Level 1 (we stay PCI scope-minimized to SAQ-A).
- Stripe Tax handles US/EU tax automatically.
- Metered Usage API matches our token/storage/seat metering model.
- Connect available for marketplace partner payouts.
- Mature dunning / retry logic.

### Negative

- Stripe transaction fees (2.9% + $0.30 typical, lower at scale).
- Per-tenant Stripe customer + subscription objects to maintain.
- Stripe webhook ordering not guaranteed; idempotent handlers required.
- Vendor lock-in to Stripe APIs.

### Neutral

- Self-host customers don't touch Stripe; license keys per ADR-0010.
- Stripe handles cards; helix never sees PAN.

## Implementation

Schema additions:

- `stripe_links` (orgId → stripe_customer_id, stripe_subscription_id, plan_id, billing_cycle)
- `metering_events` (orgId, event_type, quantity, metadata, occurred_at, rolled_up_at)
- `metering_rollups` (orgId, period, metric_key, quantity)

Service additions:

- `metering-ingest` worker (NATS consumer → Postgres)
- `metering-rollup` worker (nightly cron)
- `metering-stripe-sync` worker (nightly cron)
- Stripe webhook endpoint `POST /api/billing/stripe-webhook` (idempotent)
- Tenant-side billing UI in admin console (extends existing `admin/billing.ts` read-model)

## Alternatives Considered

### Alt 1: Build in-house

**Rejected**. Massive scope; PCI Level 1 unjustified; reinventing solved problems.

### Alt 3: Paddle (merchant of record)

**Rejected for v1**. Paddle is great for global tax + chargeback handling but rev-share is higher; Stripe is sufficient for US/EU start.

### Alt 4: Multiple processors

**Deferred**. Stripe-first; revisit when international expansion demands or rev-share unsustainable.

## References

- `02-commercial/billing-and-metering.md`
- `04-compliance/pci-dss.md`
- `decisions-owed.md` C2
