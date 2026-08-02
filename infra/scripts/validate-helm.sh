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
# Schema migrations must run before the app rolls. docker-compose.production
# has always gated the app on a `helix-migrate` service; the chart shipped
# without an equivalent, so a Kubernetes upgrade served new code against the
# old schema until this Job existed.
assert_contains "$BASE" '^kind: Job$' "base chart must render the migration Job"
assert_contains "$BASE" 'dist/db/migrate.js' "migration Job must run the migration runner"
assert_contains "$BASE" '"helm.sh/hook": pre-install,pre-upgrade' "migrations must run as a pre-install/pre-upgrade hook, before the Deployment is applied"

assert_contains "$BASE" '^kind: PodDisruptionBudget$' "base chart must render a PDB"
assert_contains "$BASE" '^kind: NetworkPolicy$' "base chart must render a NetworkPolicy"
assert_contains "$BASE" 'automountServiceAccountToken: false' "service account token automount must be disabled by default"
assert_contains "$BASE" 'runAsNonRoot: true' "pods must run as non-root"
assert_contains "$BASE" 'readOnlyRootFilesystem: true' "container filesystem must be read-only"
assert_not_contains "$BASE" '^kind: PrometheusRule$' "PrometheusRule must be opt-in because Prometheus Operator CRDs may be absent"

# Full Workspace readiness gates (MVP fail-closed). Defaults must match
# docker-compose.production.yml and AGENTS.md; PKG flip is documented only.
assert_contains "$BASE" 'name: HELIX_APPS' "base chart must inject HELIX_APPS for packaging parity with Compose"
assert_contains "$BASE" 'key: HELIX_APPS' "HELIX_APPS must come from the packaging ConfigMap"
assert_contains "$BASE" 'HELIX_APPS: "mail,drive,chat,assistant"' "base chart must default HELIX_APPS to the production MVP allowlist"
assert_contains "$BASE" 'HELIX_WORKSPACE_PROFILE: "mvp"' "base chart must default workspace profile to mvp"
assert_contains "$BASE" 'HELIX_EDITORS_MIGRATIONS_ENABLED: "false"' "base chart must keep editors migrations disabled by default"
# ConfigMap stores HELIX_CONFIG_JSON as an escaped JSON string (\"keys\").
assert_contains "$BASE" '\\"docs\\":\{\\"enabled\\":false\}' "HELIX_CONFIG_JSON must disable docs module by default"
assert_contains "$BASE" '\\"calendar\\":\{\\"enabled\\":false\}' "HELIX_CONFIG_JSON must disable calendar module by default"
assert_contains "$BASE" '\\"meet\\":\{\\"enabled\\":false\}' "HELIX_CONFIG_JSON must disable meet module by default"
assert_contains "$BASE" '\\"editors\\":\{\\"enabled\\":false\}' "HELIX_CONFIG_JSON must disable editors module by default"
assert_not_contains "$BASE" 'HELIX_APPS: "mail,drive,chat,assistant,calendar' "base chart must not enable Full Workspace apps by default"
assert_not_contains "$BASE" 'HELIX_EDITORS_MIGRATIONS_ENABLED: "true"' "base chart must not enable editors migrations by default"

# Negative structural gate: MVP profile must refuse expanded apps without profile=full.
# Helm --set treats unescaped commas as value separators, so escape list commas.
if "$HELM_BIN" template helix "$CHART_DIR" \
  --set workspace.apps='mail\,drive\,chat\,assistant\,meet' >/dev/null 2>"$WORK_DIR/mvp-apps-fail.err"; then
  echo "Helm validation failed: MVP profile must refuse workspace.apps that enable Meet without profile=full" >&2
  exit 1
fi
assert_contains "$WORK_DIR/mvp-apps-fail.err" 'workspace.apps must be mail,drive,chat,assistant unless workspace.profile=full' \
  "MVP packaging fail must name the PKG flip constraint"

# Full profile may expand apps (structural only — does not claim domain evidence).
render full_profile \
  --set workspace.profile=full \
  --set workspace.apps='mail\,drive\,chat\,assistant\,calendar\,meet\,docs\,sheets\,slides' \
  --set workspace.editorsMigrationsEnabled=true \
  --set workspace.modules.docs.enabled=true \
  --set workspace.modules.calendar.enabled=true \
  --set workspace.modules.meet.enabled=true \
  --set workspace.modules.editors.enabled=true
FULL_PROFILE="$WORK_DIR/full_profile.yaml"
assert_contains "$FULL_PROFILE" 'HELIX_WORKSPACE_PROFILE: "full"' "full profile must set HELIX_WORKSPACE_PROFILE=full"
assert_contains "$FULL_PROFILE" 'HELIX_APPS: "mail,drive,chat,assistant,calendar,meet,docs,sheets,slides"' \
  "full profile must render Full Workspace HELIX_APPS when explicitly set"
assert_contains "$FULL_PROFILE" 'HELIX_EDITORS_MIGRATIONS_ENABLED: "true"' \
  "full profile may enable editors migrations when explicitly set"

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

echo "Helm validation passed: base, business, enterprise, sovereign, observability, and MVP packaging/full-profile structural gates rendered expected PRD hardening evidence."
