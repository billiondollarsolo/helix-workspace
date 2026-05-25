#!/usr/bin/env bash
set -Eeuo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EDITORS_ROOT="${HELIX_EDITORS_DIR:-$(cd "$WORKSPACE_ROOT/.." && pwd)/helix-editors}"

if [ ! -d "$EDITORS_ROOT/packages/core-app" ]; then
  echo "helix-editors was not found at $EDITORS_ROOT" >&2
  echo "Set HELIX_EDITORS_DIR=/absolute/path/to/helix-editors or check it out as a sibling." >&2
  exit 1
fi

node "$WORKSPACE_ROOT/infra/scripts/verify-workspace-editor-boundaries.mjs"
HELIX_WORKSPACE_DIR="$WORKSPACE_ROOT" pnpm --dir "$EDITORS_ROOT" lint:boundaries
HELIX_WORKSPACE_DIR="$WORKSPACE_ROOT" pnpm --dir "$EDITORS_ROOT" contract:package-install
