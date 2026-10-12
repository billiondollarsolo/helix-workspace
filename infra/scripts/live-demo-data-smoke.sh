#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/live-demo-data-smoke.sh [options]

Starts Postgres, Meilisearch, RustFS and ClamAV, migrates a fresh database and
runs the Quillfeather Labs demo seed (docs/demo-data.md) against them. The seed
fails unless its own validation passes: every stored object readable through
tenant storage, Drive contents loadable, storage accounting settled, a clean
search reindex and Drive reconciliation, an intact audit chain and working
sign-ins. The seed also registers the local OAuth client
(helix-local-oauth-client) as the workspace admin for API smokes. Dry-run is
the default.

Options:
  --execute                    Start/run Docker-backed commands
  --dry-run                    Print commands only
  --compose-project <name>     Default: helix_demo_smoke
  --skip-services-up           Do not run docker compose up first
  --skip-migrate               Do not run db:migrate
  --skip-seed                  Start services and migrate only
  --size <small|medium|large>  Demo preset (default: small)
  -h, --help

Environment:
  POSTGRES_DB                  Default: helix_demo_smoke
  POSTGRES_USER                Default: helix
  POSTGRES_PASSWORD            Default: helix_dev_password
  POSTGRES_PORT                Default: 39532
  MEILI_PORT                   Default: 39533
  RUSTFS_API_PORT              Default: 39534
  RUSTFS_CONSOLE_PORT          Default: 39535
  CLAMAV_PORT                  Default: 39536
  DATABASE_URL, MEILI_HOST, MEILI_MASTER_KEY, RUSTFS_ENDPOINT, RUSTFS_* override
  HELIX_LIVE_DEMO_*            Mirrors the options above for CI/runbooks
EOF
}

DRY_RUN=1
COMPOSE_PROJECT=${HELIX_LIVE_DEMO_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-helix_demo_smoke}}
START_SERVICES=${HELIX_LIVE_DEMO_START_SERVICES:-true}
RUN_MIGRATIONS=${HELIX_LIVE_DEMO_MIGRATE:-true}
RUN_SEED=${HELIX_LIVE_DEMO_SEED:-true}
DEMO_SIZE=${HELIX_LIVE_DEMO_SIZE:-small}

POSTGRES_DB=${POSTGRES_DB:-helix_demo_smoke}
POSTGRES_USER=${POSTGRES_USER:-helix}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-helix_dev_password}
POSTGRES_PORT=${POSTGRES_PORT:-39532}
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
MEILI_PORT=${MEILI_PORT:-39533}
MEILI_MASTER_KEY=${MEILI_MASTER_KEY:-helix_dev_meili_master_key}
RUSTFS_API_PORT=${RUSTFS_API_PORT:-39534}
RUSTFS_CONSOLE_PORT=${RUSTFS_CONSOLE_PORT:-39535}
RUSTFS_ACCESS_KEY=${RUSTFS_ACCESS_KEY:-helixrustfs}
RUSTFS_SECRET_KEY=${RUSTFS_SECRET_KEY:-helix_rustfs_dev_secret}
RUSTFS_BUCKET=${RUSTFS_BUCKET:-helix-objects}
CLAMAV_PORT=${CLAMAV_PORT:-39536}

DATABASE_URL=${DATABASE_URL:-postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB}
MEILI_HOST=${MEILI_HOST:-http://127.0.0.1:$MEILI_PORT}
RUSTFS_ENDPOINT=${RUSTFS_ENDPOINT:-http://127.0.0.1:$RUSTFS_API_PORT}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) DRY_RUN=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --compose-project) COMPOSE_PROJECT=${2:?missing compose project}; shift 2 ;;
    --skip-services-up) START_SERVICES=false; shift ;;
    --skip-migrate) RUN_MIGRATIONS=false; shift ;;
    --skip-seed) RUN_SEED=false; shift ;;
    --size) DEMO_SIZE=${2:?missing demo size}; shift 2 ;;
    --) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$COMPOSE_PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || die "compose project contains unsupported characters: $COMPOSE_PROJECT"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "POSTGRES_DB contains unsupported characters: $POSTGRES_DB"
for port in "$POSTGRES_PORT" "$MEILI_PORT" "$RUSTFS_API_PORT" "$RUSTFS_CONSOLE_PORT" "$CLAMAV_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] || die "ports must be numeric: $port"
done
[[ "$DEMO_SIZE" =~ ^(small|medium|large)$ ]] || die "--size must be small, medium or large"

ensure_repo_root
require_cmd bash
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd docker
  require_cmd pnpm
  require_cmd curl
  require_cmd node
fi

log "live demo data compose project: $COMPOSE_PROJECT"
log "ports: postgres $POSTGRES_PORT, meilisearch $MEILI_PORT, rustfs $RUSTFS_API_PORT/$RUSTFS_CONSOLE_PORT, clamav $CLAMAV_PORT"
log "demo size: $DEMO_SIZE"
log "dry run: $DRY_RUN"

compose_prefix() {
  printf 'docker compose -p %q --profile mail-security' "$COMPOSE_PROJECT"
}

compose_exec_cmd() {
  local service=${1:?missing service}
  shift
  printf '%s exec -T %q' "$(compose_prefix)" "$service"
  local arg
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
}

compose_service_running() {
  local service=${1:?missing service}
  if [[ "$DRY_RUN" == "1" ]]; then
    return 1
  fi
  docker compose -p "$COMPOSE_PROJECT" --profile mail-security ps --services --status running 2>/dev/null | grep -Fxq "$service"
}

wait_for_postgres() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ %s\n' "$(compose_exec_cmd "$POSTGRES_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
    return 0
  fi
  for _ in {1..45}; do
    if bash -c "$(compose_exec_cmd "$POSTGRES_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB")" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  bash -c "$(compose_exec_cmd "$POSTGRES_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB")" >/dev/null
}

wait_for_http() {
  local url=${1:?missing url}
  local label=${2:?missing label}
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ wait for %s at %q\n' "$label" "$url"
    return 0
  fi
  for _ in {1..45}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  curl -fsS "$url" >/dev/null
}

# clamd loads its signature database before it accepts connections; that can take minutes.
wait_for_tcp() {
  local port=${1:?missing port}
  local label=${2:?missing label}
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ wait for %s on 127.0.0.1:%s\n' "$label" "$port"
    return 0
  fi
  for _ in {1..180}; do
    if timeout 1 bash -c "</dev/tcp/127.0.0.1/$port" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  die "$label did not accept connections on 127.0.0.1:$port"
}

assert_port_free() {
  local port=${1:?missing port}
  local label=${2:?missing label}
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ assert %s port %s is free on 127.0.0.1\n' "$label" "$port"
    return 0
  fi
  node -e '
const net = require("node:net");
const [port, label] = process.argv.slice(1);
const server = net.createServer();
server.once("error", (error) => {
  console.error(`${label} port ${port} is not free: ${error.code ?? error.message}`);
  process.exit(2);
});
server.once("listening", () => {
  server.close(() => process.exit(0));
});
server.listen(Number(port), "127.0.0.1");
' "$port" "$label"
}

run_env_command() {
  local cmd=${1:?missing command}
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ DATABASE_URL=<redacted> MEILI_HOST=%q RUSTFS_ENDPOINT=%q MAIL_CLAMAV_PORT=%q %s\n' "$MEILI_HOST" "$RUSTFS_ENDPOINT" "$CLAMAV_PORT" "$cmd"
  else
    DATABASE_URL="$DATABASE_URL" \
      MEILI_HOST="$MEILI_HOST" \
      MEILI_MASTER_KEY="$MEILI_MASTER_KEY" \
      RUSTFS_ENDPOINT="$RUSTFS_ENDPOINT" \
      RUSTFS_ACCESS_KEY="$RUSTFS_ACCESS_KEY" \
      RUSTFS_SECRET_KEY="$RUSTFS_SECRET_KEY" \
      RUSTFS_BUCKET="$RUSTFS_BUCKET" \
      MAIL_CLAMAV_ENABLED=true \
      MAIL_CLAMAV_HOST=127.0.0.1 \
      MAIL_CLAMAV_PORT="$CLAMAV_PORT" \
      bash -c "$cmd"
  fi
}

if bool_true "$START_SERVICES"; then
  if ! compose_service_running "$POSTGRES_SERVICE"; then
    assert_port_free "$POSTGRES_PORT" "Postgres"
  fi
  if ! compose_service_running meilisearch; then
    assert_port_free "$MEILI_PORT" "Meilisearch"
  fi
  if ! compose_service_running rustfs; then
    assert_port_free "$RUSTFS_API_PORT" "RustFS API"
    assert_port_free "$RUSTFS_CONSOLE_PORT" "RustFS console"
  fi
  if ! compose_service_running clamav; then
    assert_port_free "$CLAMAV_PORT" "ClamAV"
  fi
  run_shell "$(printf 'POSTGRES_DB=%q POSTGRES_USER=%q POSTGRES_PASSWORD=%q POSTGRES_PORT=%q MEILI_PORT=%q MEILI_MASTER_KEY=%q RUSTFS_API_PORT=%q RUSTFS_CONSOLE_PORT=%q RUSTFS_ACCESS_KEY=%q RUSTFS_SECRET_KEY=%q MAIL_CLAMAV_PORT_PUBLISHED=%q %s up -d postgres meilisearch rustfs clamav' \
    "$POSTGRES_DB" "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$POSTGRES_PORT" "$MEILI_PORT" "$MEILI_MASTER_KEY" "$RUSTFS_API_PORT" "$RUSTFS_CONSOLE_PORT" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" "$CLAMAV_PORT" "$(compose_prefix)")"
  wait_for_postgres
  wait_for_http "$MEILI_HOST/health" "Meilisearch"
  wait_for_http "$RUSTFS_ENDPOINT/health" "RustFS"
  wait_for_tcp "$CLAMAV_PORT" "ClamAV"
else
  log "skipping docker compose up -d postgres meilisearch rustfs clamav"
fi

if bool_true "$RUN_MIGRATIONS"; then
  run_env_command "pnpm --filter @helix/app db:migrate"
fi

if bool_true "$RUN_SEED"; then
  run_env_command "pnpm --filter @helix/app db:seed:demo -- --reset --size $(printf '%q' "$DEMO_SIZE")"
else
  log "skipping db:seed:demo"
fi

log "live demo data smoke complete"
