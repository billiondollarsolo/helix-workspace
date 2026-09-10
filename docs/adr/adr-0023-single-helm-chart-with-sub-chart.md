# ADR-0023: Single Helm Chart + Optional Sub-Charts for Workers / Roles

> Historical cross-product proposal. Retained for context; the [1.0 scope](../release/1.0-scope.md) is authoritative. This record does not enable features or impose a commercial license.

## Status

Proposed (gates Platform v2 + editors deployment model)

## Context

helix-workspace has one Helm chart (`infra/helm/helix/`) that deploys apps/helix with all the core apps + dependencies (CloudNativePG, Vault CSI, SPIRE, observability). helix-editors v3 originally proposed a separate chart for editor workers. v4 changed direction.

Three options:

1. **Single chart** — all helix services in one chart; conditional inclusion via values.
2. **Multiple top-level charts** — helix + helix-editors (separately installed).
3. **Single chart + optional sub-charts** — main chart for core helix; optional sub-charts for scale-out roles, dependencies.

## Decision

We will use **one Helm chart (`helix`) with optional sub-charts as Helm chart dependencies**:

- `helix-editors-roles` — optional sub-chart adding extra-role Deployments for conv/export/ocr/collab-gw (per editors v4).
- `helix-marketplace-roles` — optional sub-chart for marketplace-specific scale-out (future).
- Each sub-chart declared as optional dependency in `helix/Chart.yaml` with `condition: <feature>.enabled`.

Operator installs ONE chart (`helix`); enables sub-charts via values.

This is a chart and workload boundary, not a repository split. A future
marketplace role sub-chart does not imply a `helix-marketplace` source repo;
any new sibling repo still must satisfy `repository-boundaries.md` extraction
gates and land its own ADR.

## Consequences

### Positive

- One `helm install` command for operators.
- Shared values (global config, secrets, observability endpoints) flow naturally to sub-charts.
- Versioning: each sub-chart independently semver'd but chart-of-charts pinned via dependencies.
- Operators can selectively enable scale-out roles without learning new install commands.
- ArgoCD App-of-Apps pattern works cleanly.

### Negative

- Helm sub-chart values overrides have known confusion (per `helix-editors-roles.convWorker.replicas` vs `helix-editors-roles.exportWorker.replicas`).
- Sub-chart version-bumping requires Chart.yaml updates in main chart.

### Neutral

- Each sub-chart is independently testable via `helm template`.
- Operators can opt out of any sub-chart by leaving `enabled: false`.

## Implementation

`helix/Chart.yaml`:

```yaml
apiVersion: v2
name: helix
dependencies:
  - name: helix-editors-roles
    version: "^1.0.0"
    repository: "oci://ghcr.io/helix-org/charts"
    condition: helix-editors-roles.enabled
  - name: cloudnative-pg
    version: "^0.x"
    repository: "https://cloudnative-pg.github.io/charts"
    condition: cloudnativepg.enabled
```

`values.yaml` at top level:

```yaml
helix-editors-roles:
  enabled: false # opt-in
  convWorker:
    enabled: true
    replicas:
      min: 2
      max: 30
```

## Alternatives Considered

### Alt 1: Single chart with all conditional templates

**Rejected**. Templates bloat; harder to maintain; sub-chart isolation easier per-team.

### Alt 2: Multiple top-level charts

**Rejected**. Multiple install commands; harder coordination; lost shared-values benefit.

## References

- `03-editors/editors.md` §8.3 (Helm sub-chart pattern)
- `01-platform-v2/README.md` (cross-spec deployment alignment)
- ADR-0006 (editors as core-app)
