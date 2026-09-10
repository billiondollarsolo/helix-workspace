# ADR-0020: License-Key Gating for Paid Self-Host Features

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Commercial Phase B.6 + revenue model for self-host)

## Context

Self-host customers download + run helix on their own infra. Apache 2.0 OSS core gives them everything for free. We need a sustainable revenue model for self-host customers beyond optional support contracts.

Industry precedent:

- **GitLab**: Open-Core; CE free + EE paid via license file.
- **Sentry**: OSS unlimited self-host + paid SaaS + Business Source License migration.
- **MinIO**: AGPL self-host + paid commercial license to escape AGPL terms.
- **Posthog**: MIT self-host + paid cloud + paid enterprise features behind license key.

helix's posture: Apache 2.0 OSS for core (most permissive; encourages adoption + marketplace), **commercial license required for premium features** in self-host (signaled per feature; gated by a license-key validation).

## Decision

We will gate premium self-host features behind **Ed25519-signed JWT license keys** issued by helix-commercial backend on payment.

Gating list (subject to `decisions-owed.md` C6 final approval):

- BYO-KMS
- BYO-DB (per-tenant; self-host always has its own DB anyway)
- IRM (Information Rights Management)
- Watermarking (invisible)
- DLP enterprise scanners
- White-label / "powered by Helix" removal
- FedRAMP / FIPS modules
- Premium support contract validation
- Paid marketplace plugins

Verification:

- License JWT signed Ed25519; pubkey embedded in helix codebase.
- Validation on boot + every 24 h.
- Grace period (configurable; default 30 days post-expiry).
- Phone-home optional for renewal status; air-gap mode permitted.

SaaS deployments don't use license keys (plan entitlement IS the gating mechanism per Commercial spec).

## Consequences

### Positive

- Revenue path for self-host customers beyond support.
- Clear signal of "what's paid" — admin sees Pro/Enterprise badges next to features.
- Air-gap-compatible (no phone-home required for validity).
- Per-feature gating allows custom license bundles per customer.
- Open-source ethos preserved: most features Apache 2.0; only premium gated.

### Negative

- License code is patchable in Apache 2.0 OSS (we don't fight that hard); rely on commercial agreements + audit.
- Adds complexity to feature-flag evaluation (license-state read).
- License issuance backend + Ed25519 HSM key management is new infrastructure.

### Neutral

- Tier 1 (Personal) self-host gets all OSS features free.
- Tier 4 (Sovereign) customers contractually agree to non-circumvention; audits available.

## Open questions deferred to C6

The exact list of which features require licenses is per-feature subjective; finalize when paid self-host customer pipeline materializes. Default list above is the starting point.

## Alternatives Considered

### Alt 1: Pure OSS (no gating); revenue only from support contracts

**Rejected**. Support-only revenue insufficient for sustainable product investment.

### Alt 2: Business Source License (BSL) for premium features

**Rejected for now**. BSL is divisive; community pushback significant; gating via license key is less controversial and same outcome.

### Alt 3: Premium features as separate proprietary repo

**Rejected**. Distribution friction; harder to test integration; harder to coordinate releases.

## References

- `02-commercial/license-management.md`
- `decisions-owed.md` C5, C6
- ADR-0011 (OSS licensing)
- ADR-0016 (Ed25519 specifically)
