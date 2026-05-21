#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/live-restore-drill-smoke.sh [options]

Runs a live backup/restore drill against Docker Compose Postgres. Dry-run is the default.
The restore target is always a separate drill database unless explicitly changed.

Options:
  --execute                    Start/run Docker-backed commands
  --dry-run                    Print commands only
  --backup-dir <path>          Default: ./data/restore-drill/backups
  --backup-id <id>             Default: live-restore-drill-<UTC timestamp>
  --target-db <name>           Default: helix_restore_drill_smoke
  --compose-project <name>     Optional isolated Docker Compose project
  --skip-postgres-up           Do not run docker compose up -d postgres first
  --skip-migrate               Do not run app migrations before backup
  --skip-seed-oauth            Do not seed the deterministic local OAuth actor/client before backup
  --verify-app-url <url>       Probe /readyz and /openapi.json during restore-drill
  --reindex                    Run helix reindex --all after restore/app probes
  --skip-reindex               Do not reindex even if HELIX_LIVE_RESTORE_REINDEX=true
  -h, --help

Environment:
  POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT, POSTGRES_SERVICE
  DATABASE_URL                 Overrides host migration database URL
  HELIX_LIVE_RESTORE_*         Mirrors the options above for CI/runbooks
EOF
}

DRY_RUN=1
BACKUP_DIR=${HELIX_LIVE_RESTORE_BACKUP_DIR:-./data/restore-drill/backups}
BACKUP_ID=${HELIX_LIVE_RESTORE_BACKUP_ID:-live-restore-drill-$(date -u +%Y%m%dT%H%M%SZ)}
TARGET_DB=${HELIX_LIVE_RESTORE_TARGET_DB:-helix_restore_drill_smoke}
START_POSTGRES=${HELIX_LIVE_RESTORE_START_POSTGRES:-true}
RUN_MIGRATIONS=${HELIX_LIVE_RESTORE_MIGRATE:-true}
SEED_OAUTH=${HELIX_LIVE_RESTORE_SEED_OAUTH:-true}
COMPOSE_PROJECT=${HELIX_LIVE_RESTORE_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-}}
VERIFY_APP_URL=${HELIX_LIVE_RESTORE_VERIFY_APP_URL:-${HELIX_VERIFY_APP_URL:-}}
REINDEX=${HELIX_LIVE_RESTORE_REINDEX:-false}
POSTGRES_DB=${POSTGRES_DB:-helix}
POSTGRES_USER=${POSTGRES_USER:-helix}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-helix_dev_password}
POSTGRES_PORT=${POSTGRES_PORT:-28432}
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
DATABASE_URL=${DATABASE_URL:-postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) DRY_RUN=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --backup-dir) BACKUP_DIR=${2:?missing backup dir}; shift 2 ;;
    --backup-id) BACKUP_ID=${2:?missing backup id}; shift 2 ;;
    --target-db) TARGET_DB=${2:?missing target db}; shift 2 ;;
    --compose-project) COMPOSE_PROJECT=${2:?missing compose project}; shift 2 ;;
    --skip-postgres-up) START_POSTGRES=false; shift ;;
    --skip-migrate) RUN_MIGRATIONS=false; shift ;;
    --skip-seed-oauth) SEED_OAUTH=false; shift ;;
    --verify-app-url) VERIFY_APP_URL=${2:?missing verify app URL}; shift 2 ;;
    --reindex) REINDEX=true; shift ;;
    --skip-reindex) REINDEX=false; shift ;;
    --) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$BACKUP_ID" in
  ""|.*|*/*|*\\*) die "backup id must be a relative name without slashes or a leading dot: $BACKUP_ID" ;;
esac
[[ "$BACKUP_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "backup id contains unsupported characters: $BACKUP_ID"

case "$TARGET_DB" in
  ""|.*|*/*|*\\*) die "target db must be a database name without slashes or a leading dot: $TARGET_DB" ;;
esac
[[ "$TARGET_DB" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "target db contains unsupported characters: $TARGET_DB"
[[ "$TARGET_DB" != "$POSTGRES_DB" ]] || die "refusing to restore into live database '$POSTGRES_DB'"
if [[ -n "$COMPOSE_PROJECT" ]]; then
  [[ "$COMPOSE_PROJECT" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$ ]] || die "compose project contains unsupported characters: $COMPOSE_PROJECT"
fi

ensure_repo_root
require_cmd bash
require_cmd tar
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd docker
  require_cmd pnpm
  mkdir -p "$BACKUP_DIR"
fi

log "live restore drill backup id: $BACKUP_ID"
log "target db: $TARGET_DB"
log "dry run: $DRY_RUN"
[[ -n "$COMPOSE_PROJECT" ]] && log "compose project: $COMPOSE_PROJECT"

compose_prefix() {
  if [[ -n "$COMPOSE_PROJECT" ]]; then
    printf 'docker compose -p %q' "$COMPOSE_PROJECT"
  else
    printf 'docker compose'
  fi
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

run_database_url_command() {
  local cmd=${1:?missing command}
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ DATABASE_URL=<redacted> %s\n' "$cmd"
  else
    DATABASE_URL="$DATABASE_URL" bash -c "$cmd"
  fi
}

if bool_true "$START_POSTGRES"; then
  run_shell "$(printf '%s up -d postgres' "$(compose_prefix)")"
  if [[ "$DRY_RUN" == "0" ]]; then
    for _ in {1..30}; do
      if bash -c "$(compose_exec_cmd "$POSTGRES_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB")" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    bash -c "$(compose_exec_cmd "$POSTGRES_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB")" >/dev/null
  else
    printf '+ %s\n' "$(compose_exec_cmd "$POSTGRES_SERVICE" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
  fi
else
  log "skipping docker compose up -d postgres"
fi

if bool_true "$RUN_MIGRATIONS"; then
  run_database_url_command "pnpm --filter @helix/app db:migrate"
else
  log "skipping migrations before backup"
fi

if bool_true "$SEED_OAUTH"; then
  run_database_url_command "pnpm --filter @helix/app db:seed:oauth"
else
  log "skipping seeded local OAuth actor/client before backup"
fi

compose_args=${HELIX_COMPOSE_ARGS:-}
if [[ -n "$COMPOSE_PROJECT" ]]; then
  compose_args="-p $COMPOSE_PROJECT"
fi
restore_drill_cmd=$(printf 'POSTGRES_DB=%q POSTGRES_USER=%q POSTGRES_SERVICE=%q HELIX_COMPOSE_ARGS=%q HELIX_BACKUP_DIR=%q infra/scripts/restore-drill.sh --create-backup --backup-dir %q --backup-id %q --target-db %q' \
  "$POSTGRES_DB" "$POSTGRES_USER" "$POSTGRES_SERVICE" "$compose_args" "$BACKUP_DIR" "$BACKUP_DIR" "$BACKUP_ID" "$TARGET_DB")
if [[ "$DRY_RUN" == "0" ]]; then
  restore_drill_cmd+=" --execute"
else
  restore_drill_cmd+=" --dry-run"
fi
if [[ -n "$VERIFY_APP_URL" ]]; then
  restore_drill_cmd=$(printf 'HELIX_VERIFY_APP_URL=%q %s' "$VERIFY_APP_URL" "$restore_drill_cmd")
fi
if bool_true "$REINDEX"; then
  if [[ -z "${HELIX_REINDEX_ACCESS_TOKEN:-${HELIX_ACCESS_TOKEN:-}}" ]]; then
    log "skipping restore-drill reindex because HELIX_REINDEX_ACCESS_TOKEN or HELIX_ACCESS_TOKEN is not set"
    REINDEX=false
  fi
fi
if bool_true "$REINDEX"; then
  restore_drill_cmd+=" --reindex"
else
  restore_drill_cmd+=" --skip-reindex"
fi
run_shell "$restore_drill_cmd"

run_shell "$(compose_exec_cmd "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -c "select count(*) as helix_tables from information_schema.tables where table_schema='public';")"
run_shell "$(compose_exec_cmd "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -c "do \$\$ begin if (select count(*) from public.actors) = 0 then raise exception 'restored actors table is empty'; end if; end \$\$;")"
run_shell "$(compose_exec_cmd "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -c "select count(*) as activity_rows, count(this_hash) as hashed_activity_rows from public.activity;")"

log "live restore drill smoke complete"
