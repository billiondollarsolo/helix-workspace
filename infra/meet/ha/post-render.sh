#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/meet/ha/capacity.env
# shellcheck disable=SC1091
. "$ROOT/capacity.env"

release=${HELIX_MEET_RELEASE:-helix-meet}
[[ "$release" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
  echo "invalid Helm release name: $release" >&2
  exit 1
}
image_registry=${HELIX_MEET_IMAGE_REGISTRY:-registry.helix.invalid/meet}
[[ "$image_registry" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._/-]+$ ]] || {
  echo "invalid Meet image registry path" >&2
  exit 1
}

work=$(mktemp -d "${TMPDIR:-/tmp}/helix-meet-render.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$ROOT/post-render/kustomization.yaml" "$work/kustomization.yaml"
sed "s#registry\.helix\.invalid/meet#$image_registry#g" \
  > "$work/upstream.yaml"
helm template "${release}-ha" "$ROOT/addons" \
  --set-string targetRelease="$release" \
  --set shardCount="$SHARD_COUNT" \
  --set minReplicas="$JVB_MIN_REPLICAS" \
  --set maxReplicas="$JVB_MAX_REPLICAS" \
  --set cpuTarget="$JVB_CPU_TARGET" > "$work/addons.yaml"
sed -i.bak "s#registry\.helix\.invalid/meet#$image_registry#g" "$work/kustomization.yaml"
kubectl kustomize "$work"
