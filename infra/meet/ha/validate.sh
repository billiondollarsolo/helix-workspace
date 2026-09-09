#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/meet/ha/chart.lock
# shellcheck disable=SC1091
. "$ROOT/chart.lock"
# shellcheck source=infra/meet/ha/capacity.env
# shellcheck disable=SC1091
. "$ROOT/capacity.env"
rendered=$(mktemp "${TMPDIR:-/tmp}/helix-meet-ha.XXXXXX")
mutated=$(mktemp "${TMPDIR:-/tmp}/helix-meet-ha-bad.XXXXXX")
trap 'rm -f "$rendered" "$mutated"' EXIT

fail() { echo "Meet HA validation failed: $*" >&2; exit 1; }
contains() { grep -Eq -- "$2" "$1" || fail "$3"; }

archive="$ROOT/vendor/jitsi-scaler-$version.tgz"
actual=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$archive"; else shasum -a 256 "$archive"; fi | awk '{print $1}')
[[ "$actual" == "$archive_sha256" ]] || fail "vendored chart checksum changed"

bash -n "$ROOT/deploy.sh" "$ROOT/failover-drill.sh" "$ROOT/post-render.sh" "$ROOT/validate.sh"
helm lint "$archive" -f "$ROOT/values.yaml" >/dev/null
HELIX_MEET_IMAGE_REGISTRY=registry.test.local/meet \
HELIX_MEET_PUBLIC_HOST=meet.test.local \
HELIX_MEET_TURN_DOMAIN=test.local \
HELIX_MEET_CLUSTER_PEER_RANGE=10.0.0.0-10.255.255.255 \
  "$ROOT/deploy.sh" render > "$rendered"

images=$(awk '$1 == "image:" { print $2 }' "$rendered" | sort -u)
[[ -n "$images" ]] || fail "render contains no images"
! grep -q '^kind: Secret$' "$rendered" || fail "Helm must not generate or retain media credentials"
if printf '%s\n' "$images" | grep -Ev '@sha256:[a-f0-9]{64}$' >/dev/null; then
  fail "every workload and test image must be digest-pinned"
fi
[[ $(printf '%s\n' "$images" | wc -l | tr -d ' ') -eq 7 ]] || fail "unexpected image set"
! grep -Eq 'meet-jit-si-turnrelay\.jitsi\.net|stun\.l\.google\.com|\.invalid' "$rendered" || fail "render uses a public relay or placeholder"

contains "$rendered" 'stick on url_param\(room\) if has_room' "signaling must be sticky only by room"
contains "$rendered" 'peers mypeers' "HAProxy replicas must synchronize room affinity"
contains "$rendered" 'maxconn 10000' "signaling capacity must be explicit"
contains "$rendered" 'type: RollingUpdate' "JVB upgrades must roll one bridge at a time"
contains "$rendered" 'maxUnavailable: 1' "JVB rollout must retain capacity"
contains "$rendered" 'colibri/drain/enable' "JVB preStop must enter drain mode"
contains "$rendered" 'terminationGracePeriodSeconds: 660' "JVB must have a bounded drain deadline"
contains "$rendered" 'topology.kubernetes.io/zone' "media pods must spread across zones"
contains "$rendered" 'minDomains: 3' "JVB and signaling need three-zone placement"
contains "$rendered" 'whenUnsatisfiable: DoNotSchedule' "zone safety must fail closed"
contains "$rendered" 'kind: HorizontalPodAutoscaler' "JVB autoscaling must be declarative"
contains "$rendered" 'stabilizationWindowSeconds: 900' "scale-down must protect active calls"
contains "$rendered" 'kind: PodDisruptionBudget' "planned maintenance must preserve replicas"
contains "$rendered" "MAX_BRIDGE_PARTICIPANTS: \"$JVB_MAX_PARTICIPANTS\"" "Jicofo must enforce bridge capacity"
contains "$rendered" 'stale-nonce=600' "TURN credentials must rotate through bounded nonces"
contains "$rendered" 'name: helix-meet-runtime' "runtime credentials must be externally managed"

[[ $(grep -c '^kind: HorizontalPodAutoscaler$' "$rendered") -eq "$SHARD_COUNT" ]] || fail "one HPA is required per regional shard"
contains "$rendered" "minReplicas: $JVB_MIN_REPLICAS" "HPA minimum does not match the capacity model"
contains "$rendered" "maxReplicas: $JVB_MAX_REPLICAS" "HPA maximum does not match the capacity model"
[[ $(grep -c '^kind: Deployment$' "$rendered") -ge 12 ]] || fail "three regional media stacks did not render"
[[ $(grep -c '^  type: LoadBalancer$' "$rendered") -eq 3 ]] || fail "three regional TURN services are required"
IFS=',' read -r -a regions <<< "$REGIONS"
[[ ${#regions[@]} -eq "$SHARD_COUNT" ]] || fail "region list must match shard count"
for region in "${regions[@]}"; do
  contains "$rendered" "turn-$region\.test\.local" "missing TURN endpoint for $region"
  contains "$rendered" "name: helix-meet-turn-$region" "missing external TURN secret for $region"
  contains "$rendered" "- $region" "missing required node affinity for $region"
done

surviving_capacity=$(( (JVB_MIN_REPLICAS - 1) * JVB_MAX_PARTICIPANTS ))
(( JVB_PLANNED_PARTICIPANTS <= surviving_capacity )) || fail "one-loss capacity SLO is overcommitted"
(( JVB_MIN_REPLICAS >= 3 && JVB_MAX_REPLICAS > JVB_MIN_REPLICAS )) || fail "autoscaling bounds are unsafe"

cp "$rendered" "$mutated"
sed -i.bak 's/@sha256:[a-f0-9]\{64\}//' "$mutated"
if ! awk '$1 == "image:" { print $2 }' "$mutated" | grep -Ev '@sha256:[a-f0-9]{64}$' >/dev/null; then
  fail "seeded unpinned-image failure was not detected"
fi

contains "$ROOT/deploy.sh" 'cosign verify --key' "deploy must verify every mirrored image signature"
contains "$ROOT/deploy.sh" '--certificate-identity-regexp' "deploy must verify the signed upstream chart"
contains "$ROOT/deploy.sh" '--atomic --wait' "upgrade must fail atomically"
contains "$ROOT/deploy.sh" 'helm rollback' "rollback command is required"
contains "$ROOT/deploy.sh" '--cleanup-on-fail' "failed rollback must clean up"
contains "$ROOT/failover-drill.sh" 'HELIX_MEET_CANARY_URL' "failure drill must measure an established call"
contains "$ROOT/failover-drill.sh" 'kubectl uncordon' "failure drill must restore node scheduling"
contains "$ROOT/failover-drill.sh" 'HELIX_MEET_RECOVERY_EVIDENCE' "failure drill must emit aggregate release evidence"
node --test "$ROOT/release-evidence.test.mjs" >/dev/null

support_contract="$ROOT/../../../docs/meet-support-and-slos.md"
contains "$support_contract" '^## Supported clients$' "Meet client boundary must be published"
contains "$support_contract" '^## Service objectives$' "Meet SLOs must be published"
contains "$support_contract" '^## Accessibility and keyboard boundary$' "Meet accessibility boundary must be published"
contains "$support_contract" '^## Privacy model$' "Meet privacy model must be published"
contains "$support_contract" '^## Incident playbooks$' "Meet incident playbooks must be published"

if [[ "${1:-}" == --online-signatures ]]; then
  command -v cosign >/dev/null || fail "cosign is required for online verification"
  cosign verify "$chart@$oci_digest" --certificate-identity-regexp "$certificate_identity" \
    --certificate-oidc-issuer "$certificate_issuer" >/dev/null
fi

echo "Meet HA topology validated: $SHARD_COUNT regions, $JVB_MIN_REPLICAS-$JVB_MAX_REPLICAS bridges each, $surviving_capacity participant one-loss capacity per shard."
