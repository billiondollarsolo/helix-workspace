#!/usr/bin/env bash
# Helix dev stack — one-command bring-up for coding agents.
#
# Brings the local dev environment to a "cohesive, seeded deployment" state:
#   1. Verifies the required docker infrastructure containers are running.
#   2. Stops any stale helix backend / vite dev processes.
#   3. Loads env from .env + apps/helix/.env (with overrides).
#   4. Starts the helix backend (apps/helix) and waits for /healthz.
#   5. Starts the web dev server (apps/web) and waits for the vite port.
#   6. Optionally seeds the demo workspace (`pnpm --filter @helix/app db:seed:demo`).
#
# Usage (run from repo root or any subdir):
#   scripts/dev-up.sh                 # bring everything up, do not seed
#   scripts/dev-up.sh --seed          # bring up + seed the demo workspace (DEMO_SIZE=small|medium|large)
#   scripts/dev-up.sh --reseed        # bring up + wipe and reseed the demo workspace
#   scripts/dev-up.sh --no-web        # backend only (CI smoke)
#
# Exit codes:
#   0 = success, stack healthy
#   2 = infra prerequisite missing (docker / containers)
#   3 = backend failed to become healthy within timeout
#   4 = web dev failed to bind its port within timeout
#   5 = seed failed
#
# Logs:
#   /tmp/helix-backend.log
#   /tmp/helix-web.log
#   /tmp/helix-seed.log
#
# Companion: scripts/dev-down.sh stops everything cleanly.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"

# ───────── flags ─────────
SEED=0
WEB=1
RESEED=0
BACKEND_TIMEOUT_S=${HELIX_DEV_BACKEND_TIMEOUT:-90}
WEB_TIMEOUT_S=${HELIX_DEV_WEB_TIMEOUT:-30}
BACKEND_PORT=${PORT:-3000}
WEB_PORT=${HELIX_DEV_WEB_PORT:-5174}

for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --reseed) SEED=1; RESEED=1 ;;
    --no-web) WEB=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg"; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m[dev-up]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  ⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; }

# ───────── step 1: docker infra ─────────
log "verifying docker infrastructure…"
REQUIRED_IMAGES=(
  "postgres-pgvector"   # any helix-infra postgres
  "rustfs"
  "meilisearch"
)
INFRA_OK=1
for needle in "${REQUIRED_IMAGES[@]}"; do
  if ! docker ps --format '{{.Image}}' | grep -q "$needle"; then
    fail "no running container matching image *${needle}*"
    INFRA_OK=0
  else
    ok "$needle container running"
  fi
done
if [[ $INFRA_OK -eq 0 ]]; then
  fail "infrastructure missing. start with: pnpm infra:up   (or docker compose -f docker-compose.yml up -d)"
  exit 2
fi

# Reachability probes — host port forwards from lima/colima/rancher.
for port in 28432 28437 28461 28434; do
  if ! nc -z -w 1 localhost "$port" >/dev/null 2>&1; then
    warn "port $port not reachable from host (some functionality may be disabled)"
  fi
done

# ───────── step 2: stop existing processes ─────────
log "stopping any existing helix backend / web dev processes…"
pkill -9 -f "tsx.*helix.*src/index.ts" 2>/dev/null && ok "killed prior backend" || true
pkill -9 -f "pnpm.*@helix/app.*dev" 2>/dev/null || true
pkill -9 -f "vite.*--host.*--port ${WEB_PORT}\b" 2>/dev/null && ok "killed prior web dev" || true
sleep 1

# ───────── step 3: load env ─────────
log "loading env from .env + apps/helix/.env…"
set -a
# shellcheck disable=SC1091
[[ -f .env ]] && source .env
# shellcheck disable=SC1091
[[ -f apps/helix/.env ]] && source apps/helix/.env
set +a

# Sanity-check the critical vars the backend boot demands.
for var in DATABASE_URL BETTER_AUTH_DATABASE_URL HELIX_DEFAULT_ORG_ID; do
  if [[ -z "${!var:-}" ]]; then
    fail "$var is not set after loading env files"
    exit 2
  fi
done
ok "env loaded (DATABASE_URL, BETTER_AUTH_DATABASE_URL, HELIX_DEFAULT_ORG_ID present)"

# Tenant storage fallback (matches server.ts:1426): if RUSTFS_ENDPOINT is absent
# but RUSTFS_API_PORT is set, derive a localhost endpoint so tenant storage
# writes (docs / sheets / slides snapshots, Drive uploads) work.
if [[ -z "${RUSTFS_ENDPOINT:-}" && -n "${RUSTFS_API_PORT:-}" ]]; then
  export RUSTFS_ENDPOINT="http://localhost:${RUSTFS_API_PORT}"
  ok "derived RUSTFS_ENDPOINT=${RUSTFS_ENDPOINT} from RUSTFS_API_PORT"
fi

# Bump the postgres.js pool size above the worker count. The backend registers
# 12+ singleton workers, each holding an advisory lock on its own session for
# the lifetime of leadership; the default pool of 10 starves the last 2,
# blocking server boot indefinitely. 30 leaves headroom for HTTP request handlers.
export POSTGRES_POOL_MAX="${POSTGRES_POOL_MAX:-30}"
ok "POSTGRES_POOL_MAX=${POSTGRES_POOL_MAX}"

# ───────── step 4: start backend ─────────
log "starting helix backend (apps/helix)…"
: > /tmp/helix-backend.log
nohup pnpm --filter @helix/app dev >> /tmp/helix-backend.log 2>&1 &
BACKEND_WRAPPER_PID=$!
disown
ok "spawned wrapper pid=$BACKEND_WRAPPER_PID — tail /tmp/helix-backend.log"

log "waiting up to ${BACKEND_TIMEOUT_S}s for backend /healthz…"
# 6s grace period before checking process liveness — pnpm/tsx take a moment
# to descend into the tsx watcher; pgrep against the inner process would
# spuriously fail in the first second or two.
sleep 6
elapsed=6
while [[ $elapsed -lt $BACKEND_TIMEOUT_S ]]; do
  if curl -fsS -m 1 "http://localhost:${BACKEND_PORT}/healthz" >/dev/null 2>&1; then
    ok "backend healthy on :${BACKEND_PORT} after ${elapsed}s"
    break
  fi
  if ! pgrep -f "tsx.*helix.*src/index.ts" >/dev/null 2>&1; then
    fail "backend process died — last 30 log lines:"
    tail -30 /tmp/helix-backend.log >&2
    exit 3
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
if [[ $elapsed -ge $BACKEND_TIMEOUT_S ]]; then
  fail "backend never became healthy within ${BACKEND_TIMEOUT_S}s"
  fail "last 20 log lines:"; tail -20 /tmp/helix-backend.log >&2
  fail "common causes: (a) plugin connector hanging in register(), set HELIX_PLUGINS_DIR=/tmp/empty-plugins to skip; (b) zombie postgres advisory lock — restart postgres; (c) NATS/Meilisearch unreachable"
  exit 3
fi

# ───────── step 5: start web dev (vite) ─────────
if [[ $WEB -eq 1 ]]; then
  log "starting web dev (apps/web) on port ${WEB_PORT}…"
  : > /tmp/helix-web.log
  nohup pnpm --filter @helix/web dev -- --port "$WEB_PORT" >> /tmp/helix-web.log 2>&1 &
  WEB_WRAPPER_PID=$!
  disown
  ok "spawned wrapper pid=$WEB_WRAPPER_PID — tail /tmp/helix-web.log"

  log "waiting up to ${WEB_TIMEOUT_S}s for vite to bind :${WEB_PORT}…"
  elapsed=0
  while [[ $elapsed -lt $WEB_TIMEOUT_S ]]; do
    if curl -fsS -m 1 "http://localhost:${WEB_PORT}/" >/dev/null 2>&1; then
      ok "web dev ready on :${WEB_PORT} after ${elapsed}s"
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  if [[ $elapsed -ge $WEB_TIMEOUT_S ]]; then
    fail "vite never bound :${WEB_PORT} within ${WEB_TIMEOUT_S}s"
    tail -15 /tmp/helix-web.log >&2
    exit 4
  fi
fi

# ───────── step 6: seed the Quillfeather Labs demo workspace ─────────
# One deterministic seed (docs/demo-data.md): people, Mail, Drive, Chat,
# Calendar, Meet history, Contacts, Assistant and Admin, every byte scanned by
# ClamAV and stored under the tenant's storage prefix, validated at the end.
# Re-running an identical seed only re-validates; --reseed starts over.
if [[ $SEED -eq 1 ]]; then
  log "seeding the ${DEMO_SIZE:-medium} demo workspace (admin@helix.local / user@helix.local)…"
  : > /tmp/helix-seed.log
  seed_args=(--size "${DEMO_SIZE:-medium}")
  [[ $RESEED -eq 1 ]] && seed_args+=(--reset)
  # The seed writes as the runtime role, like the API in production; the
  # owner connection from .env only resets.
  seed_database_url=${SEED_DATABASE_URL:-postgres://helix_app:helix_app_local@127.0.0.1:${POSTGRES_PORT:-28432}/${POSTGRES_DB:-helix}}
  if (cd apps/helix && HELIX_MIGRATION_DATABASE_URL="${HELIX_MIGRATION_DATABASE_URL:-$DATABASE_URL}" \
    DATABASE_URL="$seed_database_url" \
    MAIL_CLAMAV_ENABLED=true MAIL_CLAMAV_HOST="${MAIL_CLAMAV_HOST:-127.0.0.1}" \
    MAIL_CLAMAV_PORT="${MAIL_CLAMAV_PORT:-28460}" pnpm db:seed:demo -- "${seed_args[@]}") \
    >> /tmp/helix-seed.log 2>&1; then
    ok "demo workspace seeded — see http://localhost:${WEB_PORT}/mail"
  else
    fail "demo seed failed — last 30 lines:"
    tail -30 /tmp/helix-seed.log >&2
    exit 5
  fi
fi

# ───────── done ─────────
echo
log "stack ready."
printf '  backend  http://localhost:%s   (logs: tail -f /tmp/helix-backend.log)\n' "$BACKEND_PORT"
if [[ $WEB -eq 1 ]]; then
  printf '  web      http://localhost:%s   (logs: tail -f /tmp/helix-web.log)\n' "$WEB_PORT"
  printf '  login    admin@helix.local / helix-admin-password\n'
fi
printf '  stop     scripts/dev-down.sh\n'
