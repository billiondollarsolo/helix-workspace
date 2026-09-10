# ADR-0025: OpenFeature + In-DB Backend for Feature Flags

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Platform v2 per-tenant config + Commercial plan/SKU mechanics)

## Context

helix needs feature flags for:

- Per-tenant feature gating (per `01-platform-v2/per-tenant-config.md`)
- Per-tier plan feature gating (per Commercial spec)
- Per-actor experiments (A/B tests)
- Operator emergency disables (kill switches)
- Progressive rollout of new features

Options:

1. **In-DB only** — `tenant_config.feature_flags` JSONB + simple resolver.
2. **OpenFeature SDK + in-DB provider** — vendor-neutral interface, in-DB backend.
3. **LaunchDarkly / Unleash / ConfigCat** — third-party service.

## Decision

We will adopt **OpenFeature SDK + in-DB provider for v1**. Provider abstraction lets us swap to Unleash / LaunchDarkly later if scale demands without refactoring call sites.

`@helix/sdk` exposes:

```ts
export const flags = {
  get<T>(key: string, defaultValue: T): T;
  getAsync<T>(key: string, defaultValue: T, context: EvaluationContext): Promise<T>;
};
```

Backend reads from `tenant_config.feature_flags` merged with `plans.feature_flags_default`. Context-evaluated (orgId, actorId, environment) so per-actor experiments work.

## Consequences

### Positive

- OpenFeature is an emerging open standard; vendor-neutral.
- In-DB backend has zero third-party dependencies.
- Future swap to Unleash / LaunchDarkly is one provider implementation.
- Resolves both per-tenant + per-plan + per-actor cases in one mental model.

### Negative

- Per-flag read is a DB query (cached aggressively).
- Cache invalidation on flag change needs NATS broadcast.
- Initial backend is hand-rolled (extra code).

### Neutral

- OpenFeature TypeScript SDK is mature.
- Migration path to managed provider (LaunchDarkly) is documented.

## Implementation

- `packages/sdk/src/feature-flags.ts` exposes typed `flags.get(key)`.
- `apps/helix/src/platform/feature-flags/` implements provider:
  - Loads `tenant_config.feature_flags` per request from cache.
  - Loads `plans.feature_flags_default` from cache.
  - Merges; tenant overrides plan.
  - Per-actor experiment overlays.
- Cache invalidation: NATS `flags.changed.<orgId>` event from admin console flag edits.
- Kill-switch flags (`emergency.*`) skip cache; always live-evaluated.

## Alternatives Considered

### Alt 1: In-DB only (no OpenFeature)

**Rejected for v1**. Slightly simpler now but harder to migrate to managed provider later.

### Alt 3: LaunchDarkly direct

**Rejected**. Cost; third-party dependency; we don't need their advanced experimentation features yet.

### Alt 4: Unleash self-hosted

**Deferred**. Will revisit if flag complexity grows past in-DB sustainability.

## References

- `01-platform-v2/per-tenant-config.md`
- `02-commercial/plans-and-skus.md`
- `decisions-owed.md` O4
- OpenFeature spec (external)
