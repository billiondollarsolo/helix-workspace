#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/meet/ha/capacity.env
# shellcheck disable=SC1091
. "$ROOT/capacity.env"

usage() {
  cat <<'EOF'
Usage: failover-drill.sh --confirm bridge|node|zone [target]

HELIX_MEET_CANARY_URL must be an HTTPS endpoint that returns 2xx only while an
already-established synthetic call has bidirectional RTP. Optional settings:
HELIX_MEET_NAMESPACE (helix-meet), HELIX_MEET_RELEASE (helix-meet),
HELIX_MEET_FAILOVER_SLO_SECONDS (capacity.env), HELIX_MEET_DRILL_SECONDS (180),
HELIX_MEET_RECOVERY_EVIDENCE (optional aggregate JSON output path).
EOF
}

[[ ${1:-} == --confirm ]] || { usage; exit 2; }
mode=${2:-}
target=${3:-}
[[ "$mode" =~ ^(bridge|node|zone)$ ]] || { usage; exit 2; }
: "${HELIX_MEET_CANARY_URL:?HELIX_MEET_CANARY_URL is required}"
[[ "$HELIX_MEET_CANARY_URL" == https://* ]] || { echo "canary URL must use HTTPS" >&2; exit 1; }

namespace=${HELIX_MEET_NAMESPACE:-helix-meet}
release=${HELIX_MEET_RELEASE:-helix-meet}
slo=${HELIX_MEET_FAILOVER_SLO_SECONDS:-$FAILURE_RECOVERY_SLO_SECONDS}
duration=${HELIX_MEET_DRILL_SECONDS:-180}
selector="app.kubernetes.io/instance=$release,app.kubernetes.io/component=jvb"
log=$(mktemp "${TMPDIR:-/tmp}/helix-meet-drill.XXXXXX")
cordoned=()
monitor_pid=

cleanup() {
  [[ -z "$monitor_pid" ]] || kill "$monitor_pid" 2>/dev/null || true
  local node
  for node in "${cordoned[@]}"; do kubectl uncordon "$node" >/dev/null 2>&1 || true; done
  rm -f "$log"
}
trap cleanup EXIT INT TERM

cordon_node() {
  local node=$1
  if [[ "$(kubectl get node "$node" -o jsonpath='{.spec.unschedulable}')" != true ]]; then
    kubectl cordon "$node" >/dev/null
    cordoned+=("$node")
  fi
}

for _ in 1 2 3 4 5; do
  curl -fsS --max-time 2 "$HELIX_MEET_CANARY_URL" >/dev/null || {
    echo "established-call canary is not healthy before the drill" >&2; exit 1;
  }
done

(
  end=$(( $(date +%s) + duration ))
  while [[ $(date +%s) -lt $end ]]; do
    now=$(date +%s)
    if curl -fsS --max-time 2 "$HELIX_MEET_CANARY_URL" >/dev/null; then echo "$now 1"; else echo "$now 0"; fi
    sleep 1
  done
) > "$log" &
monitor_pid=$!

case "$mode" in
  bridge)
    pod=${target:-$(kubectl -n "$namespace" get pod -l "$selector" -o jsonpath='{.items[0].metadata.name}')}
    [[ -n "$pod" ]] || { echo "no JVB pod found" >&2; exit 1; }
    kubectl -n "$namespace" delete pod "$pod" --wait=false
    ;;
  node)
    node=${target:-$(kubectl -n "$namespace" get pod -l "$selector" -o jsonpath='{.items[0].spec.nodeName}')}
    [[ -n "$node" ]] || { echo "no JVB node found" >&2; exit 1; }
    cordon_node "$node"
    kubectl -n "$namespace" delete pod -l "$selector" --field-selector "spec.nodeName=$node" --wait=false
    ;;
  zone)
    zone=${target:-$(kubectl -n "$namespace" get pod -l "$selector" -o jsonpath='{.items[0].spec.nodeName}' | xargs -I{} kubectl get node {} -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')}
    [[ -n "$zone" ]] || { echo "no JVB zone found" >&2; exit 1; }
    while IFS= read -r node; do
      [[ -n "$node" ]] || continue
      cordon_node "$node"
      kubectl -n "$namespace" delete pod -l "$selector" --field-selector "spec.nodeName=$node" --wait=false
    done < <(kubectl get nodes -l "topology.kubernetes.io/zone=$zone" -o name | sed 's#node/##')
    ;;
esac

wait "$monitor_pid"
monitor_pid=
max_outage=$(awk '$2==0 {if(!start)start=$1; last=$1; next} start {span=$1-start; if(span>max)max=span; start=0} END {if(start){span=last-start+1;if(span>max)max=span}print max+0}' "$log")
if [[ -n "${HELIX_MEET_RECOVERY_EVIDENCE:-}" ]]; then
  printf '{"schemaVersion":1,"measuredAt":"%s","mode":"%s","observationSeconds":%d,"maxOutageSeconds":%d}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mode" "$duration" "$max_outage" > "$HELIX_MEET_RECOVERY_EVIDENCE"
fi
[[ "$max_outage" -le "$slo" ]] || {
  echo "$mode loss exceeded call SLO: ${max_outage}s > ${slo}s" >&2
  exit 1
}
echo "$mode loss passed: maximum established-call interruption ${max_outage}s (SLO ${slo}s)"
