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
render business -f "$CHART_DIR/values-business.yaml"
render enterprise -f "$CHART_DIR/values-enterprise.yaml"
render sovereign -f "$CHART_DIR/values-sovereign.yaml"
render observability --set monitoring.prometheusRule.enabled=true

BASE="$WORK_DIR/base.yaml"
BUSINESS="$WORK_DIR/business.yaml"
ENTERPRISE="$WORK_DIR/enterprise.yaml"
SOVEREIGN="$WORK_DIR/sovereign.yaml"
OBSERVABILITY="$WORK_DIR/observability.yaml"

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
assert_not_contains "$BASE" '^kind: PrometheusRule$' "PrometheusRule must be opt-in because Prometheus Operator CRDs may be absent"

assert_contains "$BUSINESS" 'helix.io/security-tier: "business"' "business overlay must label the tier"
assert_contains "$BUSINESS" 'cidr: "10\.0\.0\.0/8"' "business overlay must render private egress allow-list CIDRs"
assert_not_contains "$BUSINESS" '^    - \{\}$' "business overlay must not allow all egress"

assert_contains "$ENTERPRISE" 'helix.io/security-tier: "enterprise"' "enterprise overlay must label the tier"
assert_contains "$ENTERPRISE" '^kind: Cluster$' "enterprise overlay must render CloudNativePG Cluster"
assert_contains "$ENTERPRISE" '^kind: ScheduledBackup$' "enterprise overlay must render CloudNativePG ScheduledBackup"
assert_contains "$ENTERPRISE" 'barmanObjectStore:' "enterprise overlay must configure CloudNativePG object-store backups"
assert_contains "$ENTERPRISE" 'helix.io/postgres-tde: required' "enterprise overlay must carry Postgres TDE/KMS annotations"
assert_contains "$ENTERPRISE" 'VAULT_ADDR' "enterprise overlay must expose Vault wiring"
assert_contains "$ENTERPRISE" 'HELIX_VAULT_AUTH_PATH' "enterprise overlay must expose Vault auth path for dynamic tenant secret reads"
assert_contains "$ENTERPRISE" 'HELIX_BYO_STORAGE_VAULT_MOUNT' "enterprise overlay must expose BYO storage Vault mount"
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

assert_contains "$OBSERVABILITY" '^kind: PrometheusRule$' "observability overlay must render a PrometheusRule when enabled"
assert_contains "$OBSERVABILITY" 'name: helix.signup.slo' "PrometheusRule must include the signup SLO group"
assert_contains "$OBSERVABILITY" 'HelixSignupActivationP95High' "PrometheusRule must include the signup p95 alert"
assert_contains "$OBSERVABILITY" 'HelixSignupActivationSloMissRateHigh' "PrometheusRule must include the signup miss-rate alert"
assert_contains "$OBSERVABILITY" 'HelixSignupActivationSamplesMissing' "PrometheusRule must include the missing-samples alert"
assert_contains "$OBSERVABILITY" 'runbook_url: "?docs/specs/05-operations/runbooks/signup-activation-slo-breach\.md"?' "signup SLO alerts must link the runbook"
assert_not_contains "$OBSERVABILITY" 'org_id|actor_id|email_address|user_agent|ip_address' "signup SLO alerts must not carry private or high-cardinality labels"

if command -v kubeconform >/dev/null 2>&1; then
  KUBECONFORM_REQUIRED_VERSION=${KUBECONFORM_REQUIRED_VERSION:-v0.8.0}
  KUBECONFORM_ACTUAL_VERSION=$(kubeconform -v)
  if [[ "$KUBECONFORM_ACTUAL_VERSION" != "$KUBECONFORM_REQUIRED_VERSION" ]]; then
    echo "Helm validation failed: kubeconform ${KUBECONFORM_REQUIRED_VERSION} is required; found ${KUBECONFORM_ACTUAL_VERSION}." >&2
    exit 1
  fi
  kubeconform \
    -strict \
    -kubernetes-version 1.36.3 \
    -ignore-missing-schemas \
    "$BASE" "$BUSINESS" "$ENTERPRISE" "$SOVEREIGN" "$OBSERVABILITY"
elif [[ "${CI:-}" == "true" ]]; then
  echo "Helm validation failed: kubeconform v0.8.0 is required in CI." >&2
  exit 1
else
  echo "kubeconform not found; skipped Kubernetes schema validation."
fi

echo "Helm validation passed: base, business, enterprise, sovereign, and observability overlays rendered expected PRD hardening evidence."
