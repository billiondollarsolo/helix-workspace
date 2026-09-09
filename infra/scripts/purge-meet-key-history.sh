#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: purge-meet-key-history.sh --backup-bundle /absolute/path/repository-before-purge.bundle --execute

Run only inside a fresh bare mirror clone during the coordinated credential-
rotation window. The script creates a recoverable local bundle, deletes every
historical Jitsi certificate/config path, and proves that reachable history no
longer contains a usable key. It never pushes rewritten refs.
EOF
}

BACKUP_BUNDLE=""
EXECUTE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-bundle) BACKUP_BUNDLE=${2:?missing backup path}; shift 2 ;;
    --execute) EXECUTE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$EXECUTE" == true ]] || { usage; exit 2; }
[[ -n "$BACKUP_BUNDLE" && "$BACKUP_BUNDLE" == /* ]] || {
  echo "--backup-bundle must be an absolute path outside the mirror" >&2
  exit 2
}
[[ $(git rev-parse --is-bare-repository) == true ]] || {
  echo "refusing to rewrite a working repository; use a fresh git clone --mirror" >&2
  exit 2
}
[[ $(git rev-parse --is-shallow-repository) == false ]] || {
  echo "refusing to scan or rewrite a shallow clone" >&2
  exit 2
}
git filter-repo -h >/dev/null 2>&1 || {
  echo "git-filter-repo is required" >&2
  exit 2
}
[[ ! -e "$BACKUP_BUNDLE" ]] || {
  echo "backup already exists: $BACKUP_BUNDLE" >&2
  exit 2
}

git bundle create "$BACKUP_BUNDLE" --all
git filter-repo --force --invert-paths \
  --path infra/meet/config/jicofo \
  --path infra/meet/config/jvb \
  --path infra/meet/config/prosody \
  --path infra/meet/config/web
git reflog expire --expire=now --all
git gc --prune=now --aggressive

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$SCRIPT_DIR/scan-git-history-secrets.mjs"
echo "History is clean locally. Follow docs/security/meet-key-rotation.md before pushing rewritten refs."
