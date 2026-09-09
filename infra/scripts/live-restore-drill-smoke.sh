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
  --backup <path>              Restore a pre-existing encrypted backup
  --backup-id <id>             Default: live-restore-drill-<UTC timestamp>
  --target-db <name>           Default: helix_restore_drill_smoke
  --target-object-bucket <n>   Isolated object-store restore target
  --target-database-url <url>  Host URL for strict restored-DB reindex
  --age-identity <path>        age identity for an encrypted backup
  --kms-datakey <path>         KMS-wrapped data key for an encrypted backup
  --evidence-output <path>     Require strict live RPO/RTO evidence
  --compose-project <name>     Optional isolated Docker Compose project
  --skip-postgres-up           Do not run docker compose up -d postgres/rustfs first
  --skip-migrate               Do not run app migrations before backup
  --skip-seed-oauth            Do not seed the deterministic local OAuth actor/client before backup
  --verify-app-url <url>       Probe /readyz and /openapi.json during restore-drill
  --reindex                    Run helix reindex --all after restore/app probes
  --skip-reindex               Do not reindex even if HELIX_LIVE_RESTORE_REINDEX=true
  --pitr                       Configure WAL archiving and prove before/after recovery markers
  -h, --help

Environment:
  POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_PORT, POSTGRES_SERVICE
  DATABASE_URL                 Overrides host migration database URL
  HELIX_LIVE_RESTORE_*         Mirrors the options above for CI/runbooks
EOF
}

DRY_RUN=1
BACKUP_DIR=${HELIX_LIVE_RESTORE_BACKUP_DIR:-./data/restore-drill/backups}
BACKUP_PATH=${HELIX_LIVE_RESTORE_BACKUP:-}
BACKUP_ID=${HELIX_LIVE_RESTORE_BACKUP_ID:-live-restore-drill-$(date -u +%Y%m%dT%H%M%SZ)}
TARGET_DB=${HELIX_LIVE_RESTORE_TARGET_DB:-helix_restore_drill_smoke}
TARGET_OBJECT_BUCKET=${HELIX_LIVE_RESTORE_TARGET_OBJECT_BUCKET:-}
AGE_IDENTITY=${AGE_IDENTITY_FILE:-}
KMS_DATAKEY=${HELIX_BACKUP_KMS_DATAKEY:-}
EVIDENCE_OUTPUT=${HELIX_LIVE_RESTORE_EVIDENCE_OUTPUT:-}
START_POSTGRES=${HELIX_LIVE_RESTORE_START_POSTGRES:-true}
RUN_MIGRATIONS=${HELIX_LIVE_RESTORE_MIGRATE:-true}
SEED_OAUTH=${HELIX_LIVE_RESTORE_SEED_OAUTH:-true}
COMPOSE_PROJECT=${HELIX_LIVE_RESTORE_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-}}
VERIFY_APP_URL=${HELIX_LIVE_RESTORE_VERIFY_APP_URL:-${HELIX_VERIFY_APP_URL:-}}
REINDEX=${HELIX_LIVE_RESTORE_REINDEX:-false}
PITR=${HELIX_LIVE_RESTORE_PITR:-false}
POSTGRES_DB=${POSTGRES_DB:-helix}
POSTGRES_USER=${POSTGRES_USER:-helix}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-helix_dev_password}
POSTGRES_PORT=${POSTGRES_PORT:-28432}
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
DATABASE_URL=${DATABASE_URL:-postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$POSTGRES_DB}
COMPOSE_OVERRIDE=
PITR_WORK_DIR=
OWNS_COMPOSE_PROJECT=false
TARGET_DATABASE_URL=${HELIX_RESTORE_DRILL_TARGET_DATABASE_URL:-postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:$POSTGRES_PORT/$TARGET_DB}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) DRY_RUN=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --backup-dir) BACKUP_DIR=${2:?missing backup dir}; shift 2 ;;
    --backup) BACKUP_PATH=${2:?missing backup path}; shift 2 ;;
    --backup-id) BACKUP_ID=${2:?missing backup id}; shift 2 ;;
    --target-db) TARGET_DB=${2:?missing target db}; shift 2 ;;
    --target-object-bucket) TARGET_OBJECT_BUCKET=${2:?missing target object bucket}; shift 2 ;;
    --target-database-url) TARGET_DATABASE_URL=${2:?missing target database URL}; shift 2 ;;
    --age-identity) AGE_IDENTITY=${2:?missing age identity}; shift 2 ;;
    --kms-datakey) KMS_DATAKEY=${2:?missing KMS datakey}; shift 2 ;;
    --evidence-output) EVIDENCE_OUTPUT=${2:?missing evidence output}; shift 2 ;;
    --compose-project) COMPOSE_PROJECT=${2:?missing compose project}; shift 2 ;;
    --skip-postgres-up) START_POSTGRES=false; shift ;;
    --skip-migrate) RUN_MIGRATIONS=false; shift ;;
    --skip-seed-oauth) SEED_OAUTH=false; shift ;;
    --verify-app-url) VERIFY_APP_URL=${2:?missing verify app URL}; shift 2 ;;
    --reindex) REINDEX=true; shift ;;
    --skip-reindex) REINDEX=false; shift ;;
    --pitr) PITR=true; shift ;;
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
if bool_true "$PITR" && [[ "$DRY_RUN" == "0" && -z "$COMPOSE_PROJECT" ]]; then
  die "live PITR drill requires --compose-project so cleanup cannot touch the default stack"
fi

ensure_repo_root
require_cmd bash
require_cmd tar
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd docker
  require_cmd pnpm
  require_cmd aws
  require_cmd openssl
  mkdir -p "$BACKUP_DIR"
fi

cleanup() {
  if bool_true "$OWNS_COMPOSE_PROJECT"; then
    "${SHELL:-/bin/bash}" -c "$(compose_prefix) down -v" >/dev/null 2>&1 || true
  fi
  if [[ -n "$PITR_WORK_DIR" ]]; then rm -rf "$PITR_WORK_DIR"; fi
  if [[ -n "$COMPOSE_OVERRIDE" ]]; then rm -f "$COMPOSE_OVERRIDE"; fi
}
trap cleanup EXIT

if bool_true "$PITR"; then
  PITR_WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-pitr-drill.XXXXXX")
  chmod 777 "$PITR_WORK_DIR"
  COMPOSE_OVERRIDE=$(mktemp "${TMPDIR:-/tmp}/helix-pitr-compose.XXXXXX")
  cat >"$COMPOSE_OVERRIDE" <<EOF
services:
  postgres:
    command: ["postgres", "-c", "archive_mode=on", "-c", "archive_command=test ! -f /wal_archive/%f && cp %p /wal_archive/%f", "-c", "archive_timeout=1s"]
    volumes:
      - "$PITR_WORK_DIR:/wal_archive"
EOF
fi

log "live restore drill backup id: $BACKUP_ID"
log "target db: $TARGET_DB"
log "dry run: $DRY_RUN"
[[ -n "$COMPOSE_PROJECT" ]] && log "compose project: $COMPOSE_PROJECT"

compose_prefix() {
  local prefix="docker compose"
  if [[ -n "$COMPOSE_OVERRIDE" ]]; then
    prefix+=" -f docker-compose.yml -f $(printf '%q' "$COMPOSE_OVERRIDE")"
  fi
  if [[ -n "$COMPOSE_PROJECT" ]]; then
    printf '%s -p %q' "$prefix" "$COMPOSE_PROJECT"
  else
    printf '%s' "$prefix"
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

if bool_true "$PITR" && [[ "$DRY_RUN" == "0" ]] \
  && [[ -n "$(bash -c "$(compose_prefix) ps -q")" ]]; then
  die "refusing to reuse non-empty PITR compose project: $COMPOSE_PROJECT"
fi
if bool_true "$PITR" && [[ "$DRY_RUN" == "0" ]]; then
  OWNS_COMPOSE_PROJECT=true
fi

run_database_url_command() {
  local cmd=${1:?missing command}
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ DATABASE_URL=<redacted> %s\n' "$cmd"
  else
    DATABASE_URL="$DATABASE_URL" bash -c "$cmd"
  fi
}

if bool_true "$START_POSTGRES"; then
  run_shell "$(printf '%s up -d postgres rustfs' "$(compose_prefix)")"
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

OBJECT_BUCKET="helix-restore-source-$(printf '%s' "$BACKUP_ID" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-32)"}
TARGET_OBJECT_BUCKET=${TARGET_OBJECT_BUCKET:-"helix-restore-target-$(printf '%s' "$BACKUP_ID" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-32)"}
OBJECT_ENDPOINT=${RUSTFS_ENDPOINT:-http://127.0.0.1:${RUSTFS_API_PORT:-28437}}
export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-${RUSTFS_ACCESS_KEY:-helixrustfs}}
export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-${RUSTFS_SECRET_KEY:-helix_rustfs_dev_secret}}
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-1}
if [[ "$DRY_RUN" == "1" ]]; then
  printf '+ create/version s3://%s and seed one DB-referenced proof blob\n' "$OBJECT_BUCKET"
else
  for _ in {1..30}; do
    if aws --no-cli-pager --endpoint-url "$OBJECT_ENDPOINT" s3api list-buckets >/dev/null 2>&1; then break; fi
    sleep 1
  done
  aws --no-cli-pager --endpoint-url "$OBJECT_ENDPOINT" s3api create-bucket --bucket "$OBJECT_BUCKET" >/dev/null
  aws --no-cli-pager --endpoint-url "$OBJECT_ENDPOINT" s3api put-bucket-versioning --bucket "$OBJECT_BUCKET" \
    --versioning-configuration Status=Enabled
  proof_file=$(mktemp "${TMPDIR:-/tmp}/helix-restore-proof.XXXXXX")
  printf 'helix restore drill %s\n' "$BACKUP_ID" >"$proof_file"
  proof_size=$(wc -c <"$proof_file" | tr -d ' ')
  proof_sha=$(openssl dgst -sha256 "$proof_file" | awk '{print $NF}')
  proof_key="restore-drill/$BACKUP_ID.bin"
  aws --no-cli-pager --endpoint-url "$OBJECT_ENDPOINT" s3api put-object \
    --bucket "$OBJECT_BUCKET" --key "$proof_key" --body "$proof_file" >/dev/null
  rm -f "$proof_file"
  run_shell "$(compose_exec_cmd "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "insert into objects(org_id, kind, storage_key, mime_type, byte_size, sha256, metadata) values (gen_random_uuid(), 'file', '$proof_key', 'application/octet-stream', $proof_size, '$proof_sha', '{\"status\":\"ready\"}');")"
fi

compose_args=${HELIX_COMPOSE_ARGS:-}
if [[ -n "$COMPOSE_OVERRIDE" ]]; then
  compose_args="-f docker-compose.yml -f $COMPOSE_OVERRIDE"
fi
if [[ -n "$COMPOSE_PROJECT" ]]; then
  compose_args+=" -p $COMPOSE_PROJECT"
fi
if [[ -n "$BACKUP_PATH" ]]; then
  drill_source=$(printf '%q %q' --backup "$BACKUP_PATH")
else
  drill_source=$(printf '%q %q %q' --create-backup --backup-id "$BACKUP_ID")
fi
restore_drill_cmd=$(printf 'HELIX_BACKUP_RUSTFS_BUCKET=%q RUSTFS_ENDPOINT=%q POSTGRES_DB=%q POSTGRES_USER=%q POSTGRES_SERVICE=%q HELIX_COMPOSE_ARGS=%q HELIX_BACKUP_DIR=%q infra/scripts/restore-drill.sh %s --backup-dir %q --target-db %q' \
  "$OBJECT_BUCKET" "$OBJECT_ENDPOINT" "$POSTGRES_DB" "$POSTGRES_USER" "$POSTGRES_SERVICE" "$compose_args" "$BACKUP_DIR" "$drill_source" "$BACKUP_DIR" "$TARGET_DB")
[[ -n "$TARGET_OBJECT_BUCKET" ]] && restore_drill_cmd+=" $(printf '%q %q' --target-object-bucket "$TARGET_OBJECT_BUCKET")"
[[ -n "$AGE_IDENTITY" ]] && restore_drill_cmd+=" $(printf '%q %q' --age-identity "$AGE_IDENTITY")"
[[ -n "$KMS_DATAKEY" ]] && restore_drill_cmd+=" $(printf '%q %q' --kms-datakey "$KMS_DATAKEY")"
[[ -n "$EVIDENCE_OUTPUT" ]] && restore_drill_cmd+=" $(printf '%q %q' --evidence-output "$EVIDENCE_OUTPUT")"
[[ -n "$EVIDENCE_OUTPUT" ]] && restore_drill_cmd+=" $(printf '%q %q' --target-database-url "$TARGET_DATABASE_URL")"
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
if bool_true "$PITR"; then
  restore_drill_cmd+=" --pitr"
  restore_drill_cmd+=$(printf ' --pitr-data-dir %q' "$BACKUP_DIR/pitr-$BACKUP_ID")
fi
run_shell "$restore_drill_cmd"

if ! bool_true "$PITR"; then
  run_shell "$(compose_exec_cmd "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -c "select count(*) as helix_tables from information_schema.tables where table_schema='public';")"
  run_shell "$(compose_exec_cmd "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -c "do \$\$ begin if (select count(*) from public.actors) = 0 then raise exception 'restored actors table is empty'; end if; end \$\$;")"
  run_shell "$(compose_exec_cmd "$POSTGRES_SERVICE" psql -U "$POSTGRES_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -c "select count(*) as activity_rows, count(this_hash) as hashed_activity_rows from public.activity;")"
fi

log "live restore drill smoke complete"
