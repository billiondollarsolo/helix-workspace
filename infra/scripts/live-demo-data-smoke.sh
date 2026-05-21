#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/live-demo-data-smoke.sh [options]

Starts the add-on services needed for realistic local demo data, then prepares and
verifies seeded Mail, Drive, Docs, Calendar, Chat, RustFS object bytes, and
Meilisearch projections. Dry-run is the default.

Options:
  --execute                    Start/run Docker-backed commands
  --dry-run                    Print commands only
  --compose-project <name>     Default: helix_demo_smoke
  --skip-services-up           Do not run docker compose up first
  --skip-migrate               Pass --skip-migrate to db:prepare:demo
  --volume-search              Seed and verify the deterministic volume mail corpus
  --volume-mail-count <n>      Seed n deterministic volume mail messages
  --anchor-date <YYYY-MM-DD>   Shift seeded mail/calendar/chat dates near this day
  --batch-size <n>             Reindex batch size for db:prepare:demo
  -h, --help

Environment:
  POSTGRES_DB                  Default: helix_demo_smoke
  POSTGRES_USER                Default: helix
  POSTGRES_PASSWORD            Default: helix_dev_password
  POSTGRES_PORT                Default: 39532
  MEILI_PORT                   Default: 39533
  RUSTFS_API_PORT              Default: 39534
  RUSTFS_CONSOLE_PORT          Default: 39535
  DATABASE_URL, MEILI_HOST, MEILI_MASTER_KEY, RUSTFS_ENDPOINT, RUSTFS_* override
  HELIX_LIVE_DEMO_*            Mirrors the options above for CI/runbooks
EOF
}

DRY_RUN=1
COMPOSE_PROJECT=${HELIX_LIVE_DEMO_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-helix_demo_smoke}}
START_SERVICES=${HELIX_LIVE_DEMO_START_SERVICES:-true}
RUN_MIGRATIONS=${HELIX_LIVE_DEMO_MIGRATE:-true}
VOLUME_SEARCH=${HELIX_LIVE_DEMO_VOLUME_SEARCH:-false}
VOLUME_MAIL_COUNT=${HELIX_LIVE_DEMO_VOLUME_MAIL_COUNT:-}
ANCHOR_DATE=${HELIX_LIVE_DEMO_ANCHOR_DATE:-}
BATCH_SIZE=${HELIX_LIVE_DEMO_BATCH_SIZE:-}

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
    --volume-search) VOLUME_SEARCH=true; shift ;;
    --volume-mail-count) VOLUME_MAIL_COUNT=${2:?missing volume mail count}; VOLUME_SEARCH=true; shift 2 ;;
    --anchor-date) ANCHOR_DATE=${2:?missing anchor date}; shift 2 ;;
    --batch-size) BATCH_SIZE=${2:?missing batch size}; shift 2 ;;
    --) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$COMPOSE_PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || die "compose project contains unsupported characters: $COMPOSE_PROJECT"
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "POSTGRES_DB contains unsupported characters: $POSTGRES_DB"
[[ "$POSTGRES_PORT" =~ ^[0-9]+$ ]] || die "POSTGRES_PORT must be numeric"
[[ "$MEILI_PORT" =~ ^[0-9]+$ ]] || die "MEILI_PORT must be numeric"
[[ "$RUSTFS_API_PORT" =~ ^[0-9]+$ ]] || die "RUSTFS_API_PORT must be numeric"
[[ "$RUSTFS_CONSOLE_PORT" =~ ^[0-9]+$ ]] || die "RUSTFS_CONSOLE_PORT must be numeric"
if [[ -n "$VOLUME_MAIL_COUNT" ]]; then
  [[ "$VOLUME_MAIL_COUNT" =~ ^[1-9][0-9]*$ ]] || die "volume mail count must be a positive integer"
fi
if [[ -n "$ANCHOR_DATE" ]]; then
  [[ "$ANCHOR_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "anchor date must use YYYY-MM-DD"
fi
if [[ -n "$BATCH_SIZE" ]]; then
  [[ "$BATCH_SIZE" =~ ^[1-9][0-9]*$ ]] || die "batch size must be a positive integer"
fi

ensure_repo_root
require_cmd bash
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd docker
  require_cmd pnpm
  require_cmd curl
  require_cmd node
fi

log "live demo data compose project: $COMPOSE_PROJECT"
log "postgres port: $POSTGRES_PORT"
log "meilisearch port: $MEILI_PORT"
log "rustfs ports: $RUSTFS_API_PORT/$RUSTFS_CONSOLE_PORT"
log "dry run: $DRY_RUN"

compose_prefix() {
  printf 'docker compose -p %q' "$COMPOSE_PROJECT"
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
  docker compose -p "$COMPOSE_PROJECT" ps --services --status running 2>/dev/null | grep -Fxq "$service"
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
    printf '+ DATABASE_URL=<redacted> MEILI_HOST=%q RUSTFS_ENDPOINT=%q %s\n' "$MEILI_HOST" "$RUSTFS_ENDPOINT" "$cmd"
  else
    DATABASE_URL="$DATABASE_URL" \
      MEILI_HOST="$MEILI_HOST" \
      MEILI_MASTER_KEY="$MEILI_MASTER_KEY" \
      RUSTFS_ENDPOINT="$RUSTFS_ENDPOINT" \
      RUSTFS_ACCESS_KEY="$RUSTFS_ACCESS_KEY" \
      RUSTFS_SECRET_KEY="$RUSTFS_SECRET_KEY" \
      RUSTFS_BUCKET="$RUSTFS_BUCKET" \
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
  run_shell "$(printf 'POSTGRES_DB=%q POSTGRES_USER=%q POSTGRES_PASSWORD=%q POSTGRES_PORT=%q MEILI_PORT=%q MEILI_MASTER_KEY=%q RUSTFS_API_PORT=%q RUSTFS_CONSOLE_PORT=%q RUSTFS_ACCESS_KEY=%q RUSTFS_SECRET_KEY=%q %s up -d postgres meilisearch rustfs' \
    "$POSTGRES_DB" "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$POSTGRES_PORT" "$MEILI_PORT" "$MEILI_MASTER_KEY" "$RUSTFS_API_PORT" "$RUSTFS_CONSOLE_PORT" "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" "$(compose_prefix)")"
  wait_for_postgres
  wait_for_http "$MEILI_HOST/health" "Meilisearch"
  wait_for_http "$RUSTFS_ENDPOINT/health" "RustFS"
else
  log "skipping docker compose up -d postgres meilisearch rustfs"
fi

prepare_args=(--require-storage --require-search)
if ! bool_true "$RUN_MIGRATIONS"; then
  prepare_args+=(--skip-migrate)
fi
if bool_true "$VOLUME_SEARCH"; then
  prepare_args+=(--volume-search)
fi
if [[ -n "$VOLUME_MAIL_COUNT" ]]; then
  prepare_args+=(--volume-mail-count "$VOLUME_MAIL_COUNT")
fi
if [[ -n "$ANCHOR_DATE" ]]; then
  prepare_args+=(--anchor-date "$ANCHOR_DATE")
fi
if [[ -n "$BATCH_SIZE" ]]; then
  prepare_args+=(--batch-size "$BATCH_SIZE")
fi

prepare_cmd="pnpm --filter @helix/app db:prepare:demo --"
for arg in "${prepare_args[@]}"; do
  prepare_cmd+=" $(printf '%q' "$arg")"
done
run_env_command "$prepare_cmd"

log "live demo data smoke complete"
