#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/meet/ha/chart.lock
# shellcheck disable=SC1091
. "$ROOT/chart.lock"

release=${HELIX_MEET_RELEASE:-helix-meet}
namespace=${HELIX_MEET_NAMESPACE:-helix-meet}
chart_archive="$ROOT/vendor/jitsi-scaler-$version.tgz"
action=${1:-}

[[ "$release" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "invalid release name" >&2; exit 1; }
[[ "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || { echo "invalid namespace" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: infra/meet/ha/deploy.sh render|verify|deploy|status|rollback [revision]

Production verify/deploy requires HELIX_MEET_IMAGE_REGISTRY,
HELIX_MEET_PUBLIC_HOST, HELIX_MEET_TURN_DOMAIN,
HELIX_MEET_CLUSTER_PEER_RANGE, and HELIX_MEET_COSIGN_PUBLIC_KEY.
EOF
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

verify_archive() {
  [[ -f "$chart_archive" ]] || { echo "missing vendored chart: $chart_archive" >&2; exit 1; }
  [[ "$(sha256 "$chart_archive")" == "$archive_sha256" ]] || {
    echo "vendored Jitsi chart checksum mismatch" >&2
    exit 1
  }
}

require_production_env() {
  local name
  for name in HELIX_MEET_IMAGE_REGISTRY HELIX_MEET_PUBLIC_HOST HELIX_MEET_TURN_DOMAIN \
    HELIX_MEET_CLUSTER_PEER_RANGE HELIX_MEET_COSIGN_PUBLIC_KEY; do
    [[ -n "${!name:-}" ]] || { echo "$name is required" >&2; exit 1; }
  done
  [[ "$HELIX_MEET_IMAGE_REGISTRY" != *.invalid* ]] || {
    echo "production image registry cannot use .invalid" >&2; exit 1;
  }
  [[ "$HELIX_MEET_IMAGE_REGISTRY" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]+$ ]] || {
    echo "invalid image registry path" >&2; exit 1;
  }
  [[ "$HELIX_MEET_PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ && "$HELIX_MEET_TURN_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || {
    echo "public and TURN hosts must be DNS names" >&2; exit 1;
  }
  [[ "$HELIX_MEET_CLUSTER_PEER_RANGE" =~ ^[0-9.]+-[0-9.]+$ ]] || {
    echo "cluster peer range must be an explicit IPv4 start-end range" >&2; exit 1;
  }
  [[ -f "$HELIX_MEET_COSIGN_PUBLIC_KEY" ]] || {
    echo "Cosign public key not found: $HELIX_MEET_COSIGN_PUBLIC_KEY" >&2; exit 1;
  }
}

helm_args() {
  local region index component
  printf '%s\0' -n "$namespace" -f "$ROOT/values.yaml"
  [[ -n "${HELIX_MEET_IMAGE_REGISTRY:-}" ]] || return
  printf '%s\0' --set-string "haproxy.image.repository=$HELIX_MEET_IMAGE_REGISTRY/haproxy"
  printf '%s\0' --set-string "haproxy.ingress.host=$HELIX_MEET_PUBLIC_HOST"
  for component in web prosody jicofo jvb coturn; do
    for index in 0 1 2; do
      printf '%s\0' --set-string "shard$index.$component.image.repository=$HELIX_MEET_IMAGE_REGISTRY/$component"
    done
  done
  for index in 0 1 2; do
    printf '%s\0' --set-string "shard$index.publicURL=https://$HELIX_MEET_PUBLIC_HOST"
    printf '%s\0' --set-string "shard$index.coturn.initContainers.busybox.image=$HELIX_MEET_IMAGE_REGISTRY/busybox:1.38.0@sha256:dc2d74b28e4cf8984fa52af1f39bc7c3d9c73760b41a74d629f5d11b1ab28616"
    printf '%s\0' --set-string "shard$index.coturn.allowedPeerIPs[0]=$HELIX_MEET_CLUSTER_PEER_RANGE"
  done
  for region in us-east-1 us-east-2 us-west-2; do
    case "$region" in us-east-1) index=0 ;; us-east-2) index=1 ;; *) index=2 ;; esac
    printf '%s\0' --set-string "shard$index.turnHost=turn-$region.$HELIX_MEET_TURN_DOMAIN"
  done
}

render() {
  local args=()
  while IFS= read -r -d '' item; do args+=("$item"); done < <(helm_args)
  HELIX_MEET_RELEASE="$release" HELIX_MEET_IMAGE_REGISTRY="${HELIX_MEET_IMAGE_REGISTRY:-}" \
    helm template "$release" "$chart_archive" "${args[@]}" | "$ROOT/post-render.sh"
}

verify_release() {
  local image rendered
  require_production_env
  command -v cosign >/dev/null || { echo "cosign is required" >&2; exit 1; }
  cosign verify "$chart@$oci_digest" \
    --certificate-identity-regexp "$certificate_identity" \
    --certificate-oidc-issuer "$certificate_issuer" >/dev/null
  rendered=$(mktemp "${TMPDIR:-/tmp}/helix-meet-verify.XXXXXX")
  render > "$rendered"
  while IFS= read -r image; do
    [[ "$image" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "unpinned image: $image" >&2; exit 1; }
    cosign verify --key "$HELIX_MEET_COSIGN_PUBLIC_KEY" "$image" >/dev/null
  done < <(awk '$1 == "image:" { print $2 }' "$rendered" | sort -u)
  rm -f "$rendered"
}

verify_archive
case "$action" in
  render) render ;;
  verify) verify_release ;;
  deploy)
    require_production_env
    [[ "$(helm version --template '{{.Version}}')" == v3.* ]] || {
      echo "Helm 3 is required for executable post-renderer support" >&2; exit 1;
    }
    verify_release
    for secret in helix-meet-runtime helix-meet-ingress-tls \
      helix-meet-turn-us-east-1 helix-meet-turn-us-east-2 helix-meet-turn-us-west-2 \
      helix-meet-turn-us-east-1-tls helix-meet-turn-us-east-2-tls helix-meet-turn-us-west-2-tls; do
      kubectl -n "$namespace" get secret "$secret" >/dev/null
    done
    args=()
    while IFS= read -r -d '' item; do args+=("$item"); done < <(helm_args)
    export HELIX_MEET_RELEASE="$release" HELIX_MEET_IMAGE_REGISTRY
    helm upgrade --install "$release" "$chart_archive" "${args[@]}" \
      --post-renderer "$ROOT/post-render.sh" --atomic --wait --timeout 45m --history-max 10
    ;;
  status) helm status "$release" -n "$namespace" ;;
  rollback)
    revision=${2:-}
    [[ "$revision" =~ ^[1-9][0-9]*$ ]] || { echo "rollback revision must be a positive integer" >&2; exit 1; }
    helm rollback "$release" "$revision" -n "$namespace" --wait --cleanup-on-fail --timeout 45m
    ;;
  *) usage; exit 2 ;;
esac
