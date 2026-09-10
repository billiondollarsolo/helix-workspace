# ADR-0021: Apache 2.0 OSS Core + Commercial License Premium Features

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates public OSS release timing; affects marketplace + partner program)

## Context

helix needs an open-source license that:

- Encourages community + marketplace adoption.
- Allows commercial premium feature gating (per ADR-0010).
- Doesn't drive Big Cloud to take + monetize without contributing.
- Acceptable to enterprise procurement (no copyleft entanglement).

Options:

1. **MIT** — most permissive; cloud-takeover risk.
2. **Apache 2.0** — permissive + patent grant + contributor mechanics; cloud-takeover risk.
3. **AGPL-3.0** — strong copyleft; prevents cloud-takeover; enterprise procurement friction.
4. **Business Source License (BSL)** — time-bombed proprietary → open after N years.
5. **Dual-license** (Apache 2.0 community + commercial proprietary) per feature.
6. **Server Side Public License (SSPL)** — MongoDB-style; rejected by OSI; enterprise friction.

## Decision

We will adopt **Apache 2.0** for the core platform + sibling repos (helix-workspace core, helix-editors packages, helix-engine references) + **proprietary commercial license for premium features gated via ADR-0010**.

Premium features distributed in the same repo as Apache 2.0 code with clear `// © Helix Inc — Commercial License Required` header + license-key validation at runtime. The PROPRIETARY portion is a small minority of code; community can fork the OSS portion and operate everything except gated features.

Marketplace plugins: Apache 2.0 or MIT or partner-EULA permitted; per-plugin disclosure.

## Consequences

### Positive

- Apache 2.0 is the most-trusted permissive license in enterprise procurement (vs AGPL).
- Patent grant protects contributors.
- Marketplace partners can commercialize without copyleft entanglement.
- Community fork is feasible; reduces governance risk.
- Cloud-takeover risk mitigated by:
  - Premium features (gating prevents trivial monetization).
  - Trust center + SOC 2 + multi-region SaaS that takes time to clone.
  - First-mover network effects (existing tenants + marketplace).
- Sustainable: GitLab, Sentry, PostHog all on similar models successfully.

### Negative

- Cloud providers CAN run the OSS core as a service without contributing (we accept this risk).
- "Open core" framing draws some community criticism.
- Premium feature line must be drawn clearly + publicly to avoid resentment.

### Neutral

- Existing helix-workspace code (Apache 2.0 already per code headers — verify in legal review) doesn't need re-licensing.

## Implementation

- LICENSE file Apache 2.0 at root of each repo.
- COMMERCIAL-LICENSE.md describing gated features + how to purchase.
- Per-file SPDX-License-Identifier headers: `Apache-2.0` for OSS; `LicenseRef-Helix-Commercial` for proprietary.
- CI lint enforces every file has SPDX header.
- Contributor License Agreement (CLA) required for OSS contributions (preserves dual-license option for community contributions).

## Alternatives Considered

### Alt 1: MIT only

**Rejected**. No patent grant; otherwise identical to Apache 2.0; less enterprise-trusted.

### Alt 3: AGPL only

**Rejected**. Enterprise procurement friction; SaaS competitors blocked but so is legitimate enterprise use.

### Alt 4: BSL

**Rejected**. Recent change-back-to-source events have damaged BSL trust; OSI doesn't recognize.

### Alt 5: SSPL

**Rejected**. OSI rejected; cloud-provider treats as proprietary; enterprise concerns.

### Alt 6: Apache 2.0 + premium as fully separate proprietary repo

**Rejected**. Operational complexity; harder integration testing; harder release coordination.

## References

- `02-commercial/license-management.md`
- `decisions-owed.md` S3
- ADR-0010 (license-key gating mechanism)
