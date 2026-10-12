#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CHART_DIR=${HELIX_HELM_CHART_DIR:-"$ROOT_DIR/infra/helm/helix"}
HELM_BIN=${HELM_BIN:-helm}
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-helm-validation.XXXXXX")
VALIDATION_DIGEST=sha256:1111111111111111111111111111111111111111111111111111111111111111
CNPG_VALIDATION_DIGEST=sha256:2222222222222222222222222222222222222222222222222222222222222222
CRD_SCHEMA_LOCATION=${HELIX_CRD_SCHEMA_LOCATION:-"https://raw.githubusercontent.com/datreeio/CRDs-catalog/63669a570e231d4f1f8396d229a1de512bcf0a34/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"}
trap 'rm -rf "$WORK_DIR"' EXIT

render() {
  local name=$1
  shift
  "$HELM_BIN" lint "$CHART_DIR" \
    --set-string image.digest="$VALIDATION_DIGEST" \
    --set-string fips.imageDigest="$VALIDATION_DIGEST" \
    --set-string cloudnativepg.image.digest="$CNPG_VALIDATION_DIGEST" \
    "$@" >/dev/null
  "$HELM_BIN" template helix "$CHART_DIR" \
    --set-string image.digest="$VALIDATION_DIGEST" \
    --set-string fips.imageDigest="$VALIDATION_DIGEST" \
    --set-string cloudnativepg.image.digest="$CNPG_VALIDATION_DIGEST" \
    "$@" >"$WORK_DIR/$name.yaml"
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

extract_policy() {
  local source=$1
  local name=$2
  local destination=$3
  awk -v target="  name: $name" '
    $0 == "---" && found { exit }
    $0 == target { found = 1 }
    found { print }
  ' "$source" >"$destination"
  if [[ ! -s "$destination" ]]; then
    echo "Helm validation failed: NetworkPolicy $name was not rendered" >&2
    exit 1
  fi
}

assert_template_fails() {
  local name=$1
  shift
  if "$HELM_BIN" template helix "$CHART_DIR" \
    --set-string image.digest="$VALIDATION_DIGEST" \
    --set-string fips.imageDigest="$VALIDATION_DIGEST" \
    --set-string cloudnativepg.image.digest="$CNPG_VALIDATION_DIGEST" \
    "$@" >"$WORK_DIR/$name.out" 2>&1; then
    echo "Helm validation failed: unsafe network configuration $name was accepted" >&2
    exit 1
  fi
}

if ! command -v "$HELM_BIN" >/dev/null 2>&1; then
  echo "Helm validation failed: helm binary not found. Set HELM_BIN to override." >&2
  exit 1
fi

if "$HELM_BIN" template helix "$CHART_DIR" >/dev/null 2>&1; then
  echo "Helm validation failed: chart rendered without an image digest" >&2
  exit 1
fi
if "$HELM_BIN" template helix "$CHART_DIR" \
  --set-string image.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000 \
  >/dev/null 2>&1; then
  echo "Helm validation failed: chart accepted a placeholder image digest" >&2
  exit 1
fi

render storage
assert_not_contains "$WORK_DIR/storage.yaml" "HELIX_DRIVE_OFFICE_PREVIEW_URL" "storage must not require the converter"
assert_not_contains "$WORK_DIR/storage.yaml" "^  name: helix-content-converter$" "storage must not deploy the converter"
render base
render business -f "$CHART_DIR/values-business.yaml"
render enterprise -f "$CHART_DIR/values-enterprise.yaml"
render sovereign -f "$CHART_DIR/values-sovereign.yaml"
render observability --set monitoring.prometheusRule.enabled=true
# `helm lint` has no --is-upgrade; the enterprise overlay was linted above.
"$HELM_BIN" template helix "$CHART_DIR" \
  --set-string image.digest="$VALIDATION_DIGEST" \
  --set-string fips.imageDigest="$VALIDATION_DIGEST" \
  --set-string cloudnativepg.image.digest="$CNPG_VALIDATION_DIGEST" \
  -f "$CHART_DIR/values-enterprise.yaml" --is-upgrade >"$WORK_DIR/enterprise-upgrade.yaml"
render cnpg-recovery -f "$CHART_DIR/values-enterprise.yaml" \
  --set cloudnativepg.bootstrap.recovery.enabled=true \
  --set-string 'cloudnativepg.recovery.externalClusters[0].name=helix-postgres-backup' \
  --set-string 'cloudnativepg.recovery.externalClusters[0].barmanObjectName=helix-postgres-backup' \
  --set-string 'cloudnativepg.recovery.externalClusters[0].serverName=helix-postgres' \
  --set-string 'cloudnativepg.bootstrap.recovery.recoveryTarget.targetTime=2026-10-01T00:00:00Z'
render roles \
  --set 'roleDeployments[0].name=realtime' \
  --set 'roleDeployments[0].role=realtime' \
  --set 'roleDeployments[0].autoscaling.enabled=true' \
  --set spire.enabled=true \
  --set vault.agentInject=true \
  --set vault.csi.enabled=true \
  --set-string 'networkPolicy.application.ingress[0].namespace=ingress-nginx' \
  --set-string 'networkPolicy.application.ingress[0].serviceAccount=ingress-nginx' \
  --set-string 'networkPolicy.application.ingress[0].podLabels.app\.kubernetes\.io/name=ingress-nginx'
render network-allowlist \
  --set-string 'networkPolicy.application.ingress[0].namespace=ingress-nginx' \
  --set-string 'networkPolicy.application.ingress[0].serviceAccount=ingress-nginx' \
  --set-string 'networkPolicy.application.ingress[0].podLabels.app\.kubernetes\.io/name=ingress-nginx' \
  --set-string 'networkPolicy.application.egress.endpoints[0].cidr=10.42.0.9/32' \
  --set 'networkPolicy.application.egress.endpoints[0].ports[0]=5432' \
  --set-string 'networkPolicy.application.egress.inCluster[0].namespace=data' \
  --set-string 'networkPolicy.application.egress.inCluster[0].serviceAccount=redis' \
  --set-string 'networkPolicy.application.egress.inCluster[0].podLabels.app\.kubernetes\.io/name=redis' \
  --set 'networkPolicy.application.egress.inCluster[0].ports[0]=6379'

BASE="$WORK_DIR/base.yaml"
BUSINESS="$WORK_DIR/business.yaml"
ENTERPRISE="$WORK_DIR/enterprise.yaml"
SOVEREIGN="$WORK_DIR/sovereign.yaml"
OBSERVABILITY="$WORK_DIR/observability.yaml"
ROLES="$WORK_DIR/roles.yaml"
NETWORK_ALLOWLIST="$WORK_DIR/network-allowlist.yaml"

extract_policy "$BASE" helix-default "$WORK_DIR/base-default-network-policy.yaml"
extract_policy "$BASE" helix-image-verifier "$WORK_DIR/base-verifier-network-policy.yaml"
extract_policy "$ROLES" helix-realtime "$WORK_DIR/role-network-policy.yaml"
extract_policy "$ENTERPRISE" helix-default "$WORK_DIR/enterprise-default-network-policy.yaml"
extract_policy "$SOVEREIGN" helix-image-verifier "$WORK_DIR/sovereign-verifier-network-policy.yaml"
extract_policy "$NETWORK_ALLOWLIST" helix-default "$WORK_DIR/allowlist-network-policy.yaml"
extract_policy "$BASE" helix-migrate "$WORK_DIR/base-migrate-network-policy.yaml"
extract_policy "$ENTERPRISE" helix-migrate "$WORK_DIR/enterprise-migrate-network-policy.yaml"

BASE_DEFAULT_POLICY="$WORK_DIR/base-default-network-policy.yaml"
BASE_VERIFIER_POLICY="$WORK_DIR/base-verifier-network-policy.yaml"
ROLE_POLICY="$WORK_DIR/role-network-policy.yaml"
ENTERPRISE_DEFAULT_POLICY="$WORK_DIR/enterprise-default-network-policy.yaml"
SOVEREIGN_VERIFIER_POLICY="$WORK_DIR/sovereign-verifier-network-policy.yaml"
ALLOWLIST_POLICY="$WORK_DIR/allowlist-network-policy.yaml"

assert_contains "$BASE" '^kind: Deployment$' "base chart must render a Deployment"
assert_contains "$BASE" 'image: "ghcr.io/billiondollarsolo/helix-workspace@sha256:1111111111111111111111111111111111111111111111111111111111111111"' "base deployment must use only the approved digest"
assert_contains "$BASE" '^kind: Job$' "base chart must render the pre-install image verifier"
assert_contains "$BASE" 'helm.sh/hook: pre-install,pre-upgrade' "image verification must block installs and upgrades"
assert_contains "$BASE" 'ghcr.io/sigstore/cosign/cosign:v3\.0\.6@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00' "image verifier itself must be digest-pinned"
assert_contains "$BASE" '/var/run/helix-cosign/cosign.pub' "image verifier must use the approved public key Secret"
assert_contains "$BASE" 'name: sbom-attestation' "image verifier must require a signed SBOM attestation"
assert_contains "$BASE" 'name: provenance-attestation' "image verifier must require signed build provenance"
assert_contains "$BASE" 'spdxjson' "image verifier must require SPDX SBOM evidence"
assert_contains "$BASE" 'slsaprovenance' "image verifier must require SLSA provenance evidence"
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
assert_contains "$BASE" '^  minReadySeconds: 10$' "workloads must remain ready before a rollout advances"
assert_contains "$BASE" '^  progressDeadlineSeconds: 600$' "failed rollouts must have a finite progress deadline"
assert_contains "$BASE" '^      maxUnavailable: 0$' "rolling releases must keep existing replicas available"
assert_contains "$BASE" '^      maxSurge: 1$' "rolling releases must canary one new replica at a time"
assert_contains "$BASE" '^[[:space:]]+startupProbe:$' "slow starts must be separated from liveness failure"
assert_contains "$BASE" 'topologyKey: topology\.kubernetes\.io/zone' "replicas must spread across zones"
assert_contains "$BASE" 'topologyKey: kubernetes\.io/hostname' "replicas must spread across nodes"
assert_contains "$BASE" '^kind: NetworkPolicy$' "base chart must render a NetworkPolicy"
assert_contains "$BASE_DEFAULT_POLICY" 'helix.io/role: "default"' "default policy must select only the default role"
assert_contains "$BASE_DEFAULT_POLICY" 'helix.io/service-account: "helix"' "default policy must select its exact service-account identity"
assert_contains "$BASE_DEFAULT_POLICY" '^  ingress: \[\]$' "unconfigured ingress must deny every source pod"
assert_contains "$BASE_DEFAULT_POLICY" 'kubernetes.io/metadata.name: "kube-system"' "default egress must select the DNS namespace exactly"
assert_contains "$BASE_DEFAULT_POLICY" 'k8s-app: kube-dns' "default egress must select DNS pods exactly"
assert_contains "$BASE_DEFAULT_POLICY" '^          port: 53$' "default egress must allow DNS destination port 53"
assert_not_contains "$BASE_DEFAULT_POLICY" 'port: 443|cidr:|namespaceSelector: \{\}|podSelector: \{\}|- \{\}' "default app policy must have no broad ingress or non-DNS egress"
assert_contains "$BASE_VERIFIER_POLICY" 'helix.io/role: "image-verifier"' "image verifier must have its own exact policy"
assert_contains "$BASE_VERIFIER_POLICY" 'helm.sh/hook-weight: "-20"' "verifier policy must exist before the verification Job"
assert_contains "$BASE_VERIFIER_POLICY" 'helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded' "verifier policy must be removed after the hook finishes"
assert_contains "$BASE_VERIFIER_POLICY" '^  ingress: \[\]$' "image verifier must deny all ingress"
assert_contains "$BASE_VERIFIER_POLICY" 'cidr: 0\.0\.0\.0/0' "image verifier must explicitly scope public HTTPS"
assert_contains "$BASE_VERIFIER_POLICY" '169\.254\.0\.0/16' "public HTTPS must exclude link-local metadata addresses"
assert_contains "$BASE_VERIFIER_POLICY" '10\.0\.0\.0/8' "public HTTPS must exclude private IPv4"
assert_contains "$BASE_VERIFIER_POLICY" 'cidr: 2000::/3' "public HTTPS must allow only global-unicast IPv6"
assert_contains "$BASE_VERIFIER_POLICY" '^          port: 443$' "image verifier public egress must be HTTPS only"
assert_not_contains "$BASE_VERIFIER_POLICY" 'namespaceSelector: \{\}|podSelector: \{\}|- \{\}' "image verifier policy must not contain broad selectors or egress"
assert_contains "$BASE" 'automountServiceAccountToken: false' "service account token automount must be disabled by default"
assert_contains "$BASE" 'helix.io/service-account: "helix"' "service account and workload identity labels must agree"
assert_contains "$BASE" 'runAsNonRoot: true' "pods must run as non-root"
assert_contains "$BASE" 'readOnlyRootFilesystem: true' "container filesystem must be read-only"
assert_contains "$BASE" 'HELIX_PUBLIC_URL: "https://helix\.example\.com"' "production public URL must be HTTPS"
assert_contains "$BASE" '^            - name: BETTER_AUTH_SECRET$' "Better Auth must receive an external secret"
assert_contains "$BASE" '^                  name: "helix-auth"$' "Better Auth secret must come from the configured Secret"
assert_contains "$BASE" '^            - name: DATABASE_URL$' "database configuration must be present"
assert_contains "$BASE" '^                  name: "helix-postgres"$' "database credentials must come from the configured Secret"
assert_not_contains "$BASE" 'change-me|helix_dev_password|type: (LoadBalancer|NodePort)|nodePort:' "production manifests must contain no known credentials or public control-plane Services"
assert_not_contains "$BASE" '^kind: PrometheusRule$' "PrometheusRule must be opt-in because Prometheus Operator CRDs may be absent"

# Full Workspace readiness gates (MVP fail-closed). Defaults must match
# docker-compose.production.yml and AGENTS.md; PKG flip is documented only.
assert_contains "$BASE" 'name: HELIX_APPS' "base chart must inject HELIX_APPS for packaging parity with Compose"
assert_contains "$BASE" 'key: HELIX_APPS' "HELIX_APPS must come from the packaging ConfigMap"
assert_contains "$BASE" 'HELIX_APPS: "mail,drive,chat,assistant"' "base chart must default HELIX_APPS to the production MVP allowlist"
assert_contains "$BASE" 'HELIX_WORKSPACE_PROFILE: "mvp"' "base chart must default workspace profile to mvp"
# ConfigMap stores HELIX_CONFIG_JSON as an escaped JSON string (\"keys\").
assert_contains "$BASE" '\\"calendar\\":\{\\"enabled\\":false\}' "HELIX_CONFIG_JSON must disable calendar module by default"
assert_contains "$BASE" '\\"meet\\":\{\\"enabled\\":false\}' "HELIX_CONFIG_JSON must disable meet module by default"
assert_not_contains "$BASE" 'HELIX_APPS: "mail,drive,chat,assistant,calendar' "base chart must not enable Full Workspace apps by default"

# Negative structural gate: MVP profile must refuse expanded apps without profile=full.
# Helm --set treats unescaped commas as value separators, so escape list commas.
if "$HELM_BIN" template helix "$CHART_DIR" \
  --set-string image.digest="$VALIDATION_DIGEST" \
  --set workspace.apps='mail\,drive\,chat\,assistant\,meet' >/dev/null 2>"$WORK_DIR/mvp-apps-fail.err"; then
  echo "Helm validation failed: MVP profile must refuse workspace.apps that enable Meet without profile=full" >&2
  exit 1
fi
assert_contains "$WORK_DIR/mvp-apps-fail.err" 'workspace.apps must be mail,drive,chat,assistant unless workspace.profile=full' \
  "MVP packaging fail must name the PKG flip constraint"

# Full profile may expand apps (structural only — does not claim domain evidence).
render full_profile \
  --set workspace.profile=full \
  --set workspace.apps='mail\,drive\,chat\,assistant\,calendar\,meet' \
  --set workspace.modules.docs.enabled=true \
  --set workspace.modules.calendar.enabled=true \
  --set workspace.modules.meet.enabled=true
FULL_PROFILE="$WORK_DIR/full_profile.yaml"
assert_contains "$FULL_PROFILE" 'HELIX_WORKSPACE_PROFILE: "full"' "full profile must set HELIX_WORKSPACE_PROFILE=full"
assert_contains "$FULL_PROFILE" 'HELIX_APPS: "mail,drive,chat,assistant,calendar,meet"' \
  "full profile must render Full Workspace HELIX_APPS when explicitly set"

assert_contains "$BUSINESS" 'helix.io/security-tier: "business"' "business overlay must label the tier"
assert_not_contains "$BUSINESS" '^    - \{\}$' "business overlay must not allow all egress"

assert_contains "$ENTERPRISE" 'helix.io/security-tier: "enterprise"' "enterprise overlay must label the tier"
assert_contains "$ENTERPRISE" 'priorityClassName: "helix-workspace-critical"' "enterprise workloads must use an operator-managed priority class"
assert_contains "$ENTERPRISE" '^kind: Cluster$' "enterprise overlay must render CloudNativePG Cluster"
assert_contains "$ENTERPRISE" '^kind: ScheduledBackup$' "enterprise overlay must render CloudNativePG ScheduledBackup"
assert_contains "$ENTERPRISE" 'barmanObjectName: "helix-postgres-backup"' "enterprise overlay must configure CloudNativePG object-store backups"
assert_contains "$ENTERPRISE" 'helix.io/postgres-tde: required' "enterprise overlay must carry Postgres TDE/KMS annotations"
assert_contains "$ENTERPRISE" 'VAULT_ADDR' "enterprise overlay must expose Vault wiring"
assert_contains "$ENTERPRISE" 'HELIX_VAULT_AUTH_PATH' "enterprise overlay must expose Vault auth path for dynamic tenant secret reads"
assert_contains "$ENTERPRISE" 'HELIX_BYO_STORAGE_VAULT_MOUNT' "enterprise overlay must expose BYO storage Vault mount"
assert_contains "$ENTERPRISE" 'SIEM_ENDPOINT' "enterprise overlay must expose SIEM wiring"
assert_contains "$ENTERPRISE" 'inheritedMetadata:' "CloudNativePG pods must inherit their network identity"
assert_contains "$ENTERPRISE" 'helix.io/service-account: "helix-postgres"' "CloudNativePG network identity must match its dedicated service account"
assert_contains "$ENTERPRISE" 'name: "helix-postgres-runtime"' "enterprise runtime must use a non-owner database Secret"
assert_contains "$ENTERPRISE" '^      owner: "helix_migrator"$' "CloudNativePG bootstrap owner must be migration-only"
assert_contains "$ENTERPRISE_DEFAULT_POLICY" 'kubernetes.io/metadata.name: "default"' "CloudNativePG egress must stay in the release namespace"
assert_contains "$ENTERPRISE_DEFAULT_POLICY" 'cnpg.io/cluster: "helix-postgres"' "CloudNativePG egress must select the exact cluster"
assert_contains "$ENTERPRISE_DEFAULT_POLICY" 'cnpg.io/podRole: instance' "CloudNativePG egress must select database pods only"
assert_contains "$ENTERPRISE_DEFAULT_POLICY" '^          port: 5432$' "CloudNativePG egress must allow only PostgreSQL traffic"

# Database: CloudNativePG runs PostgreSQL 18 with pgvector and creates every
# migration extension and the Helix role model before migrations run as the
# non-superuser owner (docs/deployment-production.md#database).
ENTERPRISE_UPGRADE="$WORK_DIR/enterprise-upgrade.yaml"
CNPG_RECOVERY="$WORK_DIR/cnpg-recovery.yaml"
assert_contains "$ENTERPRISE" "imageName: \"ghcr\\.io/billiondollarsolo/helix-workspace-postgres-cnpg@${CNPG_VALIDATION_DIGEST}\"" "CloudNativePG must run the digest-pinned Helix PostgreSQL 18 + pgvector operand"
assert_not_contains "$ENTERPRISE" 'cloudnative-pg/postgresql:' "CloudNativePG must not run an upstream operand without pgvector"
for extension in vector pgcrypto pg_trgm; do
  assert_contains "$ENTERPRISE" "^        - CREATE EXTENSION IF NOT EXISTS ${extension}$" "CloudNativePG bootstrap must create the ${extension} extension as the superuser"
done
assert_contains "$ENTERPRISE" '^        - GRANT helix_migration_owner TO helix_migrator$' "CloudNativePG bootstrap must let the owner assume the schema owner role"
assert_contains "$ENTERPRISE" 'CREATE ROLE helix_migration_owner NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;' "CloudNativePG bootstrap must create the schema owner with the migration 0090 attributes"
assert_contains "$ENTERPRISE" '^      - name: helix_app$' "CloudNativePG must manage the runtime role"
assert_contains "$ENTERPRISE" 'name: "helix-postgres-role-app"' "runtime role password must come from a Secret"
assert_not_contains "$ENTERPRISE" '^        superuser: true$' "managed roles must never be superusers"
assert_contains "$ENTERPRISE" '^kind: ObjectStore$' "CloudNativePG backups must use a Barman Cloud Plugin ObjectStore"
assert_contains "$ENTERPRISE" 'apiVersion: barmancloud\.cnpg\.io/v1' "ObjectStore must use the Barman Cloud Plugin API"
assert_contains "$ENTERPRISE" '^    - name: "barman-cloud\.cloudnative-pg\.io"$' "Cluster must archive WAL through the Barman Cloud Plugin"
assert_contains "$ENTERPRISE" '^      isWALArchiver: true$' "Barman Cloud Plugin must be the WAL archiver"
assert_contains "$ENTERPRISE" '^  method: plugin$' "ScheduledBackup must use the Barman Cloud Plugin"
assert_not_contains "$ENTERPRISE" '^    barmanObjectStore:$' "deprecated in-core barmanObjectStore must not be rendered"
assert_contains "$ENTERPRISE" '"helm.sh/hook": post-install$' "first install must migrate after the CloudNativePG Cluster exists"
assert_contains "$ENTERPRISE_UPGRADE" '"helm.sh/hook": pre-install,pre-upgrade$' "upgrades must migrate before the Deployment rolls"
assert_contains "$ENTERPRISE" '^            - name: HELIX_MIGRATION_DATABASE_URL$' "migration Job must receive the owner credential"
assert_contains "$ENTERPRISE" '^                  name: "helix-postgres-app"$' "migration Job must default to the CloudNativePG owner Secret"
assert_contains "$ENTERPRISE" '^                  key: uri$' "migration Job must read the CloudNativePG owner URI"
assert_contains "$ENTERPRISE" '^              value: "600"$' "migration Job must wait for a bootstrapping cluster"
assert_contains "$ENTERPRISE" 'value: /var/run/helix/postgres-tls/ca\.crt' "CloudNativePG clients must pin the operator CA"
assert_contains "$ENTERPRISE" 'secretName: "helix-postgres-ca"' "CloudNativePG CA must come from the operator Secret"
assert_contains "$CNPG_RECOVERY" '^    recovery:$' "recovery values must bootstrap from a backup"
assert_contains "$CNPG_RECOVERY" 'barmanObjectName: "helix-postgres-backup"' "recovery must read the source through the Barman Cloud Plugin"
assert_not_contains "$CNPG_RECOVERY" 'postInitApplicationSQL:' "a restored cluster already carries its extensions and roles"
assert_not_contains "$BASE" '^kind: Cluster$|POSTGRES_TLS_CA_FILE|HELIX_MIGRATION_DATABASE_URL' "external Postgres must not render CloudNativePG wiring"
BASE_MIGRATE_POLICY="$WORK_DIR/base-migrate-network-policy.yaml"
ENTERPRISE_MIGRATE_POLICY="$WORK_DIR/enterprise-migrate-network-policy.yaml"
assert_contains "$BASE_MIGRATE_POLICY" 'helix.io/role: "migrate"' "migration Job must have its own NetworkPolicy"
assert_contains "$BASE_MIGRATE_POLICY" 'helm.sh/hook: pre-install,pre-upgrade' "migration policy must exist before the pre-install/pre-upgrade Job"
assert_contains "$BASE_MIGRATE_POLICY" 'helm.sh/hook-weight: "-20"' "migration policy must be created before the Job"
assert_contains "$BASE_MIGRATE_POLICY" '^  ingress: \[\]$' "migration Job must deny all ingress"
assert_contains "$BASE_MIGRATE_POLICY" 'k8s-app: kube-dns' "migration Job must reach exact cluster DNS"
assert_not_contains "$BASE_MIGRATE_POLICY" 'port: 443|cidr:|namespaceSelector: \{\}|podSelector: \{\}|- \{\}' "migration Job must have no egress beyond DNS until a PostgreSQL endpoint is configured"
assert_contains "$BASE" 'helix.io/service-account: "helix"' "migration pods must carry the network identity label"
assert_contains "$ENTERPRISE_MIGRATE_POLICY" 'helm.sh/hook: post-install' "first-install migration policy must follow the post-install Job"
assert_contains "$ENTERPRISE_MIGRATE_POLICY" 'cnpg.io/cluster: "helix-postgres"' "migration Job must reach the CloudNativePG cluster"
assert_contains "$ENTERPRISE_MIGRATE_POLICY" '^          port: 5432$' "migration Job must reach only PostgreSQL"
assert_not_contains "$ENTERPRISE_MIGRATE_POLICY" 'port: 443|cidr:' "migration Job must not reach public HTTPS"
assert_contains "$ENTERPRISE_UPGRADE" 'helm.sh/hook: pre-install,pre-upgrade' "upgrade migration policy must precede the pre-upgrade Job"
assert_contains "$BASE" "^              value: \"ghcr\\.io/billiondollarsolo/helix-workspace@${VALIDATION_DIGEST}\"$" "pods must receive HELIX_IMAGE from the selected image digest"
assert_contains "$BASE" '^              value: helm$' "Helm pods must declare HELIX_DEPLOYMENT_KIND=helm for the image-pinning check"
assert_contains "$SOVEREIGN" "^              value: \"ghcr\\.io/billiondollarsolo/helix-workspace-fips@" "sovereign pods must pin the approved FIPS repository"
assert_template_fails migrate-public-https --set networkPolicy.migrate.egress.publicHttps=true
assert_template_fails cnpg-tag-image --set cloudnativepg.enabled=true --set-string cloudnativepg.image.digest=
assert_template_fails cnpg-placeholder-image --set cloudnativepg.enabled=true \
  --set-string cloudnativepg.image.digest=sha256:0000000000000000000000000000000000000000000000000000000000000000
assert_template_fails cnpg-legacy-image-name --set-string cloudnativepg.imageName=ghcr.io/cloudnative-pg/postgresql:17
assert_template_fails cnpg-superuser-owner --set cloudnativepg.enabled=true --set-string cloudnativepg.bootstrap.owner=postgres

# Optional password manager: absent by default, a separate workload on its own
# host when enabled, and refused without what it cannot run without.
PASSWORDS="$WORK_DIR/passwords.yaml"
passwords_values=(
  --set passwords.enabled=true
  --set-string passwords.host=vault.example.com
  --set-string passwords.signupDomains=example.com
  --set-string passwords.smtp.host=smtp.example.com
  --set-string passwords.smtp.from=passwords@example.com
)
render passwords "${passwords_values[@]}"
assert_not_contains "$BASE" 'vaultwarden|HELIX_PASSWORDS_URL' \
  "the password manager must not be deployed or advertised unless enabled"
assert_contains "$PASSWORDS" 'image: "vaultwarden/server:[0-9.]+-alpine@sha256:[a-f0-9]{64}"' \
  "the password manager image must be pinned by digest"
assert_contains "$PASSWORDS" 'HELIX_PASSWORDS_URL: "https://vault\.example\.com"' \
  "the application must be told where the password manager is"
assert_contains "$PASSWORDS" '- host: "vault\.example\.com"' \
  "the password manager must be served on its own host"
assert_contains "$PASSWORDS" 'app\.kubernetes\.io/name: helix-passwords' \
  "the password manager must not share the application's selector labels"
assert_contains "$PASSWORDS" 'helm\.sh/resource-policy: keep' \
  "uninstalling the release must keep the vault's data"
assert_contains "$PASSWORDS" 'value: "example\.com"' \
  "vault sign-up must be limited to the configured domains"
assert_not_contains "$PASSWORDS" 'ADMIN_TOKEN' \
  "the password manager's server administration page must stay off"
assert_template_fails passwords-no-host --set passwords.enabled=true
assert_template_fails passwords-no-signup-domains "${passwords_values[@]}" \
  --set-string passwords.signupDomains=
assert_template_fails passwords-no-smtp "${passwords_values[@]}" --set-string passwords.smtp.host=
assert_template_fails passwords-tag-image "${passwords_values[@]}" \
  --set-string passwords.image.digest=

assert_contains "$SOVEREIGN" 'helix.io/security-tier: "sovereign"' "sovereign overlay must label the tier"
assert_contains "$SOVEREIGN" 'priorityClassName: "helix-workspace-critical"' "sovereign workloads must use an operator-managed priority class"
assert_contains "$SOVEREIGN" 'ghcr\.io/billiondollarsolo/helix-workspace-fips@sha256:' "sovereign overlay must use a digest-pinned FIPS image"
assert_contains "$SOVEREIGN" 'HELIX_FIPS_MODE: "required"' "sovereign overlay must require FIPS mode"
assert_contains "$SOVEREIGN" 'HELIX_CRYPTO_ADAPTER: "node-openssl-fips"' "sovereign overlay must select the FIPS crypto adapter"
assert_contains "$SOVEREIGN" 'HELIX_AIRGAP_MODE: "required"' "sovereign overlay must require air-gap mode"
assert_contains "$SOVEREIGN" 'node-restriction\.kubernetes\.io/fips: "true"' "sovereign overlay must select FIPS nodes"
assert_contains "$SOVEREIGN" '^kind: SecretProviderClass$' "sovereign overlay must render Vault CSI wiring"
assert_not_contains "$SOVEREIGN" '^    - \{\}$' "sovereign overlay must not allow all egress"
assert_contains "$SOVEREIGN_VERIFIER_POLICY" 'k8s-app: kube-dns' "sovereign verifier must allow only exact cluster DNS by default"
assert_not_contains "$SOVEREIGN_VERIFIER_POLICY" 'cidr:|port: 443' "sovereign verifier must not have public or private endpoint egress by default"

assert_contains "$OBSERVABILITY" '^kind: PrometheusRule$' "observability overlay must render a PrometheusRule when enabled"
assert_contains "$OBSERVABILITY" 'name: helix\.product\.slo\.recording' "PrometheusRule must include product SLO recording rules"
assert_contains "$OBSERVABILITY" 'HelixProductAvailabilityFastBurn' "PrometheusRule must include multi-window product budget alerts"
assert_contains "$OBSERVABILITY" 'HelixAuthAvailabilitySlowBurn' "PrometheusRule must include auth budget alerts"
assert_contains "$OBSERVABILITY" 'name: helix\.capability\.health' "PrometheusRule must include capability health alerts"
assert_contains "$OBSERVABILITY" 'HelixOperationalFailure' "PrometheusRule must include the bounded operational failure alert"
assert_contains "$OBSERVABILITY" 'HelixMailDeliveryFailure' "PrometheusRule must include the mail delivery failure alert"
assert_contains "$OBSERVABILITY" 'HelixSearchReconciliationDrift' "PrometheusRule must include the reconciliation drift alert"
assert_contains "$OBSERVABILITY" 'runbook_url: docs/runbooks/product-slo-breach\.md' "product SLO alerts must link the owner runbook"
assert_not_contains "$OBSERVABILITY" 'org_id|actor_id|email_address|user_agent|ip_address' "SLO alerts must not carry private or high-cardinality labels"

assert_contains "$ROLES" '^  name: helix-realtime$' "role chart must expose a routable, role-specific Service"
assert_contains "$ROLES" 'helix.io/role: "realtime"' "role Deployment and Service must use the same exact role selector"
assert_contains "$ROLES" '^            - name: HELIX_ROLE$' "role Deployment must select only the requested app role"
assert_contains "$ROLES" '^            - name: spire-agent-socket$' "role Deployment must mount the SPIRE workload identity socket"
assert_contains "$ROLES" '^            - name: vault-secrets$' "role Deployment must mount Vault CSI secrets"
assert_contains "$ROLES" 'vault.hashicorp.com/agent-inject: "true"' "role Deployment must preserve Vault agent identity annotations"
assert_contains "$ROLES" 'spire.io/workload-selector:' "role Deployment must preserve SPIRE workload identity annotations"
assert_contains "$ROLES" '^    kind: Deployment$' "role HPA must target a Deployment"
assert_contains "$ROLES" '^    name: helix-realtime$' "role HPA must target the role-specific Deployment"
assert_contains "$ROLES" '^  name: helix-realtime$' "role deployments must have a disruption budget"
assert_contains "$ROLE_POLICY" 'helix.io/role: "realtime"' "each role must have a separately selected NetworkPolicy"
assert_contains "$ROLE_POLICY" 'helix.io/service-account: "helix"' "role NetworkPolicy must select the exact service-account identity"
assert_contains "$ROLE_POLICY" '^  ingress: \[\]$' "a role must remain denied when only the default application ingress is configured"

assert_contains "$ALLOWLIST_POLICY" 'kubernetes.io/metadata.name: "ingress-nginx"' "ingress source must select an exact namespace"
assert_contains "$ALLOWLIST_POLICY" 'helix.io/service-account: "ingress-nginx"' "ingress source must select an exact service account"
assert_contains "$ALLOWLIST_POLICY" 'app.kubernetes.io/name: ingress-nginx' "ingress source must include exact workload labels"
assert_contains "$ALLOWLIST_POLICY" '^          port: 3000$' "ingress must expose only the app port"
assert_contains "$ALLOWLIST_POLICY" 'cidr: "10\.42\.0\.9/32"' "private egress must allow only an approved host"
assert_contains "$ALLOWLIST_POLICY" '^          port: 5432$' "private endpoint egress must select an exact port"
assert_contains "$ALLOWLIST_POLICY" 'kubernetes.io/metadata.name: "data"' "in-cluster egress must select an exact namespace"
assert_contains "$ALLOWLIST_POLICY" 'helix.io/service-account: "redis"' "in-cluster egress must select an exact service account"
assert_contains "$ALLOWLIST_POLICY" 'app.kubernetes.io/name: redis' "in-cluster egress must include exact workload labels"
assert_contains "$ALLOWLIST_POLICY" '^          port: 6379$' "in-cluster egress must select an exact port"
assert_not_contains "$ALLOWLIST_POLICY" 'namespaceSelector: \{\}|podSelector: \{\}|- \{\}' "configured allowlists must not introduce broad selectors"

assert_template_fails legacy-disable --set networkPolicy.enabled=false
assert_template_fails legacy-allow-all --set networkPolicy.egress.allowAll=true
assert_template_fails role-allow-all \
  --set-string 'roleDeployments[0].name=realtime' \
  --set 'roleDeployments[0].networkPolicy.egress.allowAll=true'
assert_template_fails subnet-scan \
  --set-string 'networkPolicy.application.egress.endpoints[0].cidr=10.0.0.0/8' \
  --set 'networkPolicy.application.egress.endpoints[0].ports[0]=443'
assert_template_fails metadata-endpoint \
  --set-string 'networkPolicy.application.egress.endpoints[0].cidr=169.254.169.254/32' \
  --set 'networkPolicy.application.egress.endpoints[0].ports[0]=443'
assert_template_fails metadata-ipv6-endpoint \
  --set-string 'networkPolicy.application.egress.endpoints[0].cidr=fd20:ce::254/128' \
  --set 'networkPolicy.application.egress.endpoints[0].ports[0]=443'
assert_template_fails unscoped-ingress \
  --set-string 'networkPolicy.application.ingress[0].namespace=ingress-nginx' \
  --set-string 'networkPolicy.application.ingress[0].serviceAccount=ingress-nginx'
assert_template_fails ingress-without-source --set ingress.enabled=true
assert_template_fails reserved-identity-label \
  --set-string 'podLabels.helix\.io/service-account=spoofed'
assert_template_fails dns-disabled --set networkPolicy.dns.enabled=false
assert_template_fails insecure-public-url --set-string publicUrl=http://helix.example.com
assert_template_fails inline-database-url --set-string external.postgres.url=postgres://helix:strong@postgres.internal:5432/helix
assert_template_fails missing-auth-secret --set-string auth.secretRef.name=

for values_file in "$CHART_DIR"/values*.yaml; do
  assert_not_contains "$values_file" 'allowAll:|^[[:space:]]+- (10\.0\.0\.0/8|172\.16\.0\.0/12|192\.168\.0\.0/16)$' "tier values must not restore allow-all or RFC1918 subnet defaults"
done

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
    "$BASE" "$BUSINESS" "$ENTERPRISE" "$SOVEREIGN" "$OBSERVABILITY" "$ROLES"
  # CloudNativePG Cluster/ScheduledBackup and Barman Cloud ObjectStore schemas
  # from an immutable CRDs-catalog commit, so CRD fields are checked as well.
  kubeconform \
    -strict \
    -kubernetes-version 1.36.3 \
    -schema-location default \
    -schema-location "$CRD_SCHEMA_LOCATION" \
    -ignore-missing-schemas \
    "$ENTERPRISE" "$ENTERPRISE_UPGRADE" "$CNPG_RECOVERY"
elif [[ "${CI:-}" == "true" ]]; then
  echo "Helm validation failed: kubeconform v0.8.0 is required in CI." >&2
  exit 1
else
  echo "kubeconform not found; skipped Kubernetes schema validation."
fi

echo "Helm validation passed: base, business, enterprise, sovereign, observability, and MVP packaging/full-profile structural gates rendered expected PRD hardening evidence."
