# ADR-0015: HELIX_MODE Runtime Configuration for Single-Tenant vs Multi-Tenant SaaS

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Implemented locally; formal S1 approval remains tracked in
`../decisions-owed.md`. The current Quality Gates workflow runs the same test
suite in both `HELIX_MODE=single-tenant` and
`HELIX_MODE=multi-tenant-saas`, enforcing the no-fork runtime contract while
human signoff is pending.

## Context

Helix targets two distribution shapes:

1. **Self-host single-tenant** — customer downloads Helm chart, runs on their cluster, owns everything.
2. **Multi-tenant SaaS** — helix-hosted, signup-based, billed, supports thousands of orgs.

Both need to share a codebase to avoid maintenance burden + integration drift + migration friction (a SaaS customer must be able to export and migrate to self-host without losing data or capability).

Three alternative approaches considered:

1. **Fork into two distributions** — separate repos / images.
2. **Build SaaS-only and run self-host as "first customer"** — single org per deployment is just a configuration of SaaS code.
3. **Build self-host-only and bolt SaaS surfaces on later** — multi-tenancy retrofitted.
4. **Single codebase + runtime mode switch via env var**.

## Decision

We will adopt **option 4**: `HELIX_MODE` environment variable (`single-tenant` | `multi-tenant-saas`) selected at process boot determines which routes, middleware, and admin surfaces are registered. The same Docker image, Helm chart, plugin loader, schema, and Cerbos bundle serve both modes.

## Consequences

### Positive

- One runtime codebase; no fork drift.
- Migrate-to-self-host is feasible (export from SaaS, import to single-tenant).
- Operators learn one product, not two.
- New features land in both modes at once.

### Negative

- CI must run both modes for every PR (longer cycle).
- Some code complexity to gate signup/billing routes by mode.
- Single-tenant operators see "unused" SaaS-related schemas (`orgs.byo_config`, `stripe_links`, etc.) — minor confusion.

### Neutral

- `orgs` table exists in single-tenant mode with exactly one row.
- `tenant_config` schema applies in both modes; in single-tenant the one row is "the config."

## Alternatives Considered

### Alternative 1: Fork into two distributions

**Rejected**. Doubles maintenance; integration drift inevitable; defeats the migrate-to-self-host story.

### Alternative 2: Build SaaS-only; self-host as "first customer"

**Rejected**. Requires running SaaS infrastructure (Stripe, signup) to use self-host; SaaS surfaces optional in self-host but the architecture still presumes them. Adds operational burden for self-host customers.

### Alternative 3: Build self-host-only; bolt SaaS later

**Rejected**. Multi-tenancy is invasive (every table, every query, every Cerbos policy); retrofitting is more expensive than designing for it from start. SaaS-specific surfaces (signup, billing, support tooling) bolt on awkwardly.

## References

- `01-platform-v2/modes.md`
- `../repository-boundaries.md`
- `00-strategic-roadmap.md` §4
- PRD §18 (open question: "Multi-tenant in v2 — design v1 hooks now, or strict single-org?") — this ADR answers in favor of designing v1 hooks now.
