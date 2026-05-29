#!/usr/bin/env bash
# Helix dev stack — graceful shutdown of backend + web dev.
# Leaves docker infra containers (postgres, rustfs, etc.) running.
# Use `pnpm infra:down` to stop those too.

set -u

log() { printf '\033[1;34m[dev-down]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }

WEB_PORT=${HELIX_DEV_WEB_PORT:-5174}

log "stopping helix backend…"
if pkill -TERM -f "tsx.*helix.*src/index.ts" 2>/dev/null; then ok "sent SIGTERM"; fi
pkill -TERM -f "pnpm.*@helix/app.*dev" 2>/dev/null || true
sleep 2
pkill -9 -f "tsx.*helix.*src/index.ts" 2>/dev/null && ok "force-killed leftover backend" || true

log "stopping web dev (port ${WEB_PORT})…"
if pkill -TERM -f "vite.*--port ${WEB_PORT}\b" 2>/dev/null; then ok "sent SIGTERM"; fi
pkill -TERM -f "pnpm.*@helix/web.*dev" 2>/dev/null || true
sleep 1
pkill -9 -f "vite.*--port ${WEB_PORT}\b" 2>/dev/null && ok "force-killed leftover vite" || true

log "remaining processes:"
pgrep -fl "tsx.*helix|@helix/(app|web).*dev|vite.*helix" 2>/dev/null || ok "none"
