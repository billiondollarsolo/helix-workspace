#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CHART_DIR=${HELIX_HELM_CHART_DIR:-"$ROOT_DIR/infra/helm/helix"}
HELM_BIN=${HELM_BIN:-helm}
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-helm-validation.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

render() {
  local name=$1
  shift
  "$HELM_BIN" lint "$CHART_DIR" "$@" >/dev/null
  "$HELM_BIN" template helix "$CHART_DIR" "$@" >"$WORK_DIR/$name.yaml"
}

assert_contains() {
  local file=$1
  local pattern=$2
  local message=$3
  if ! grep -Eq -- "$pattern" "$file"; then
    echo "Helm validation failed: $message" >&2
    echo "  file: $file" >&2
    echo "  pattern: $pattern" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file=$1
  local pattern=$2
  local message=$3
  if grep -Eq -- "$pattern" "$file"; then
    echo "Helm validation failed: $message" >&2
    echo "  file: $file" >&2
    echo "  forbidden pattern: $pattern" >&2
    exit 1
  fi
}

if ! command -v "$HELM_BIN" >/dev/null 2>&1; then
  echo "Helm validation failed: helm binary not found. Set HELM_BIN to override." >&2
  exit 1
fi

render base
render monitoring \
  --set monitoring.tenantStorageMigrationPrometheusRule.enabled=true \
  --set monitoring.tenantExportPrometheusRule.enabled=true
render business -f "$CHART_DIR/values-business.yaml"
render enterprise -f "$CHART_DIR/values-enterprise.yaml"
render sovereign -f "$CHART_DIR/values-sovereign.yaml"

BASE="$WORK_DIR/base.yaml"
MONITORING="$WORK_DIR/monitoring.yaml"
BUSINESS="$WORK_DIR/business.yaml"
ENTERPRISE="$WORK_DIR/enterprise.yaml"
SOVEREIGN="$WORK_DIR/sovereign.yaml"

assert_contains "$BASE" '^kind: Deployment$' "base chart must render a Deployment"
assert_contains "$BASE" '^kind: HorizontalPodAutoscaler$' "base chart must render an HPA"
assert_contains "$BASE" 'helix_websocket_connections_active' "HPA must autoscale on the WebSocket-connection metric (PRD 16.1)"
assert_contains "$BASE" '^  behavior:$' "HPA must declare scale-up/scale-down behaviour for spiky WebSocket traffic"
assert_contains "$BASE" 'prometheus.io/scrape: "true"' "deployment must expose Prometheus scrape hints for the WS metrics adapter"
assert_contains "$BASE" '^kind: PodDisruptionBudget$' "base chart must render a PDB"
assert_contains "$BASE" '^kind: NetworkPolicy$' "base chart must render a NetworkPolicy"
assert_contains "$BASE" 'automountServiceAccountToken: false' "service account token automount must be disabled by default"
assert_contains "$BASE" 'runAsNonRoot: true' "pods must run as non-root"
assert_contains "$BASE" 'readOnlyRootFilesystem: true' "container filesystem must be read-only"
assert_not_contains "$BASE" 'HelixTenantStorageMigrationStalled' "tenant storage migration alerts must be opt-in"
assert_not_contains "$BASE" 'HelixTenantExportStalled' "tenant export alerts must be opt-in"

assert_contains "$MONITORING" '^kind: PrometheusRule$' "monitoring overlay must render opt-in PrometheusRule"
assert_contains "$MONITORING" 'name: helix\.tenant_storage\.migration' "tenant storage migration alert group must render"
assert_contains "$MONITORING" 'HelixTenantStorageMigrationStalled' "tenant storage migration stalled alert must render"
assert_contains "$MONITORING" 'HelixTenantStorageMigrationFailed' "tenant storage migration failed alert must render"
assert_contains "$MONITORING" 'helix_tenant_storage_migration_stalled_jobs' "stalled alert must use the committed migration stalled metric"
assert_contains "$MONITORING" 'helix_tenant_storage_migration_jobs_total' "failed alert must use the committed migration job counter"
assert_contains "$MONITORING" 'runbook_url: "docs/specs/05-operations/runbooks/tenant-storage-migration.md"' "tenant storage migration alerts must link the runbook"
assert_contains "$MONITORING" 'operation: tenant_storage_migration' "tenant storage migration alerts must carry operation label"
assert_not_contains "$MONITORING" 'org_id|job_id|actor_id|email_address|user_agent|ip_address' "tenant storage migration alerts must not add high-cardinality labels"
assert_contains "$MONITORING" 'name: helix\.tenant_export' "tenant export alert group must render"
assert_contains "$MONITORING" 'HelixTenantExportStalled' "tenant export stalled alert must render"
assert_contains "$MONITORING" 'HelixTenantExportFailed' "tenant export failed alert must render"
assert_contains "$MONITORING" 'helix_tenant_export_stalled_jobs' "tenant export stalled alert must use the committed stalled metric"
assert_contains "$MONITORING" 'helix_tenant_export_jobs_total' "tenant export failed alert must use the committed job counter"
assert_contains "$MONITORING" 'runbook_url: "docs/specs/05-operations/runbooks/tenant-export-too-large.md"' "tenant export alerts must link the runbook"
assert_contains "$MONITORING" 'operation: tenant_export' "tenant export alerts must carry operation label"
assert_not_contains "$MONITORING" 'tenant_id|filename|storage_key' "tenant export alerts must not add high-cardinality labels"

assert_contains "$BUSINESS" 'helix.io/security-tier: "business"' "business overlay must label the tier"
assert_contains "$BUSINESS" 'cidr: "10\.0\.0\.0/8"' "business overlay must render private egress allow-list CIDRs"
assert_not_contains "$BUSINESS" '^    - \{\}$' "business overlay must not allow all egress"

assert_contains "$ENTERPRISE" 'helix.io/security-tier: "enterprise"' "enterprise overlay must label the tier"
assert_contains "$ENTERPRISE" '^kind: Cluster$' "enterprise overlay must render CloudNativePG Cluster"
assert_contains "$ENTERPRISE" '^kind: ScheduledBackup$' "enterprise overlay must render CloudNativePG ScheduledBackup"
assert_contains "$ENTERPRISE" 'barmanObjectStore:' "enterprise overlay must configure CloudNativePG object-store backups"
assert_contains "$ENTERPRISE" 'helix.io/postgres-tde: required' "enterprise overlay must carry Postgres TDE/KMS annotations"
assert_contains "$ENTERPRISE" 'VAULT_ADDR' "enterprise overlay must expose Vault wiring"
assert_contains "$ENTERPRISE" 'SIEM_ENDPOINT' "enterprise overlay must expose SIEM wiring"

assert_contains "$SOVEREIGN" 'helix.io/security-tier: "sovereign"' "sovereign overlay must label the tier"
assert_contains "$SOVEREIGN" 'registry\.example\.internal/helix/helix-fips@sha256:' "sovereign overlay must use a digest-pinned FIPS image"
assert_contains "$SOVEREIGN" 'HELIX_FIPS_MODE: "required"' "sovereign overlay must require FIPS mode"
assert_contains "$SOVEREIGN" 'HELIX_CRYPTO_ADAPTER: "node-openssl-fips"' "sovereign overlay must select the FIPS crypto adapter"
assert_contains "$SOVEREIGN" 'HELIX_AIRGAP_MODE: "required"' "sovereign overlay must require air-gap mode"
assert_contains "$SOVEREIGN" 'node-restriction\.kubernetes\.io/fips: "true"' "sovereign overlay must select FIPS nodes"
assert_contains "$SOVEREIGN" '^kind: SecretProviderClass$' "sovereign overlay must render Vault CSI wiring"
assert_contains "$SOVEREIGN" '^  egress: \[\]$' "sovereign overlay must default-deny egress"
assert_not_contains "$SOVEREIGN" '^    - \{\}$' "sovereign overlay must not allow all egress"
assert_not_contains "$SOVEREIGN" 'kube-system' "sovereign overlay must not allow DNS egress by default"

if command -v kubeconform >/dev/null 2>&1; then
  kubeconform -strict -ignore-missing-schemas "$BASE" "$MONITORING" "$BUSINESS" "$ENTERPRISE" "$SOVEREIGN"
else
  echo "kubeconform not found; skipped Kubernetes schema validation."
fi

echo "Helm validation passed: base, monitoring, business, enterprise, and sovereign overlays rendered expected PRD hardening evidence."
