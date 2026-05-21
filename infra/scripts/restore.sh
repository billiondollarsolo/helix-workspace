#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/restore.sh --backup <path> [options]

Restores a Helix backup. Dry-run is the default. The script does not overwrite
an existing database unless --allow-drop-target is set.

Two restore paths are supported, selected by the backup manifest:
  - logical: pg_restore a custom-format dump into a target database.
  - pitr:    rebuild a Postgres data directory from a physical base backup and
             replay archived WAL to a point in time (--recovery-target-time).

Options:
  --backup <path>                  Backup directory, .tar.gz, .tar.gz.age, or .tar.gz.kms
  --target-db <name>               Logical restore target. Default: helix_restore_drill
  --execute                        Run restore commands
  --dry-run                        Print commands only
  --allow-drop-target              Drop/recreate target DB if it exists
  --allow-live-target              Permit TARGET_DB to match POSTGRES_DB
  --age-identity <path>            age identity file for .age archives
  --kms-datakey <path>             KMS-wrapped data key for .kms archives
                                   (defaults to <archive>.datakey next to the file)
  --pitr                           Force PITR replay path
  --recovery-target-time <ts>      PITR recovery target (ISO 8601). Default: latest
  --pitr-data-dir <path>           Host dir to materialize the recovered cluster
  --restore-objects                Re-sync the object bucket from the backup
  --verify                         Run DB verification after a logical restore
  -h, --help

Environment:
  POSTGRES_DB, POSTGRES_USER, POSTGRES_SERVICE
  AGE_IDENTITY_FILE, HELIX_BACKUP_KMS_DATAKEY, HELIX_KMS_ENDPOINT
  HELIX_BACKUP_RUSTFS_BUCKET, RUSTFS_ENDPOINT/RUSTFS_ACCESS_KEY/RUSTFS_SECRET_KEY
EOF
}

BACKUP_PATH=${HELIX_RESTORE_BACKUP:-}
TARGET_DB=${HELIX_RESTORE_TARGET_DB:-helix_restore_drill}
POSTGRES_DB=${POSTGRES_DB:-helix}
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
POSTGRES_USER=${POSTGRES_USER:-helix}
DRY_RUN=1
ALLOW_DROP_TARGET=false
ALLOW_LIVE_TARGET=${HELIX_RESTORE_ALLOW_LIVE_TARGET:-false}
VERIFY=false
AGE_IDENTITY=${AGE_IDENTITY_FILE:-}
KMS_DATAKEY=${HELIX_BACKUP_KMS_DATAKEY:-}
FORCE_PITR=false
RECOVERY_TARGET_TIME=${HELIX_RECOVERY_TARGET_TIME:-}
PITR_DATA_DIR=${HELIX_PITR_DATA_DIR:-./backups/pitr-restore}
RESTORE_OBJECTS=false
WORK_DIR=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP_PATH=${2:?missing backup path}; shift 2 ;;
    --target-db) TARGET_DB=${2:?missing target db}; shift 2 ;;
    --execute) DRY_RUN=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-drop-target) ALLOW_DROP_TARGET=true; shift ;;
    --allow-live-target) ALLOW_LIVE_TARGET=true; shift ;;
    --age-identity) AGE_IDENTITY=${2:?missing age identity}; shift 2 ;;
    --kms-datakey) KMS_DATAKEY=${2:?missing kms datakey}; shift 2 ;;
    --pitr) FORCE_PITR=true; shift ;;
    --recovery-target-time) RECOVERY_TARGET_TIME=${2:?missing recovery target time}; shift 2 ;;
    --pitr-data-dir) PITR_DATA_DIR=${2:?missing pitr data dir}; shift 2 ;;
    --restore-objects) RESTORE_OBJECTS=true; shift ;;
    --verify) VERIFY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$BACKUP_PATH" ]] || die "--backup is required"

if [[ "$TARGET_DB" == "$POSTGRES_DB" ]] && ! bool_true "$ALLOW_LIVE_TARGET"; then
  die "refusing to restore into live database '$TARGET_DB'; use a drill database or pass --allow-live-target"
fi

ensure_repo_root
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd docker
fi
require_cmd tar

cleanup() {
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

compose() {
  # shellcheck disable=SC2086
  printf 'docker compose %s' "${HELIX_COMPOSE_ARGS:-}"
}

extract_backup() {
  local source=$1

  if [[ -d "$source" ]]; then
    printf '%s\n' "$source"
    return
  fi

  WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-restore.XXXXXX")
  case "$source" in
    *.age)
      [[ -n "$AGE_IDENTITY" ]] || die "encrypted backup requires --age-identity or AGE_IDENTITY_FILE"
      [[ "$DRY_RUN" == "1" ]] || require_cmd age
      if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ age -d -i %q %q | tar -C %q -xzf -\n' "$AGE_IDENTITY" "$source" "$WORK_DIR" >&2
      else
        age -d -i "$AGE_IDENTITY" "$source" | tar -C "$WORK_DIR" -xzf -
      fi
      ;;
    *.kms)
      local datakey=${KMS_DATAKEY:-$source.datakey}
      if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ aws kms decrypt --ciphertext-blob fileb://%q\n' "$datakey" >&2
        printf '+ openssl enc -d -aes-256-cbc -pbkdf2 -in %q | tar -C %q -xzf -\n' "$source" "$WORK_DIR" >&2
      else
        require_cmd aws
        require_cmd openssl
        local plain_tar="$WORK_DIR/archive.tar.gz"
        kms_decrypt_file "$source" "$plain_tar" "$datakey"
        tar -C "$WORK_DIR" -xzf "$plain_tar"
        rm -f "$plain_tar"
      fi
      ;;
    *.tar.gz|*.tgz)
      if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ tar -C %q -xzf %q\n' "$WORK_DIR" "$source" >&2
      else
        tar -C "$WORK_DIR" -xzf "$source"
      fi
      ;;
    *)
      die "unsupported backup format: $source"
      ;;
  esac

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '%s\n' "$WORK_DIR/<extracted-backup>"
  else
    find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1
  fi
}

BACKUP_DIR=$(extract_backup "$BACKUP_PATH")
POSTGRES_DUMP="$BACKUP_DIR/postgres.dump"
BASEBACKUP_DIR="$BACKUP_DIR/postgres-basebackup"
WAL_DIR="$BACKUP_DIR/wal"
OBJECTS_DIR="$BACKUP_DIR/objects"
MANIFEST="$BACKUP_DIR/manifest.json"

# Decide restore mode. A physical base backup => PITR; otherwise logical.
RESTORE_MODE=logical
if bool_true "$FORCE_PITR"; then
  RESTORE_MODE=pitr
elif [[ "$DRY_RUN" == "0" && -d "$BASEBACKUP_DIR" ]]; then
  RESTORE_MODE=pitr
elif [[ "$DRY_RUN" == "0" && -f "$MANIFEST" ]] && grep -q '"mode": *"physical-basebackup"' "$MANIFEST" 2>/dev/null; then
  RESTORE_MODE=pitr
fi

log "backup: $BACKUP_PATH"
log "restore mode: $RESTORE_MODE"
log "dry run: $DRY_RUN"

if [[ "$DRY_RUN" == "0" && -f "$MANIFEST" ]]; then
  log "manifest:"
  sed 's/^/  /' "$MANIFEST" >&2
fi

# --- PITR restore: rebuild a cluster from base backup + WAL replay -----------
restore_pitr() {
  local target_clause="recovery_target = 'immediate'"
  if [[ -n "$RECOVERY_TARGET_TIME" ]]; then
    target_clause="recovery_target_time = '$RECOVERY_TARGET_TIME'"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    cat <<EOF
+ # PITR restore plan
+ mkdir -p ${PITR_DATA_DIR}
+ cp -a ${BASEBACKUP_DIR}/. ${PITR_DATA_DIR}/        # materialize base backup
+ cp -a ${WAL_DIR}/. ${PITR_DATA_DIR}/pg_wal_restore/ # stage archived WAL
+ # write ${PITR_DATA_DIR}/postgresql.auto.conf:
+ #   restore_command = 'cp ${PITR_DATA_DIR}/pg_wal_restore/%f %p'
+ #   ${target_clause}
+ #   recovery_target_action = 'promote'
+ touch ${PITR_DATA_DIR}/recovery.signal
+ # start a Postgres 17 instance on this data dir; it replays WAL then promotes.
+ pg_ctl -D ${PITR_DATA_DIR} start
EOF
    return
  fi
  require_cmd cp
  [[ -d "$BASEBACKUP_DIR" ]] || die "PITR restore needs a base backup at $BASEBACKUP_DIR"
  mkdir -p "$PITR_DATA_DIR"
  cp -a "$BASEBACKUP_DIR/." "$PITR_DATA_DIR/"
  mkdir -p "$PITR_DATA_DIR/pg_wal_restore"
  if [[ -d "$WAL_DIR" ]]; then
    cp -a "$WAL_DIR/." "$PITR_DATA_DIR/pg_wal_restore/" 2>/dev/null || true
  fi
  chmod 700 "$PITR_DATA_DIR"
  # Postgres 12+ recovery: restore_command + recovery target in auto.conf,
  # plus an empty recovery.signal file to trigger archive recovery mode.
  cat >>"$PITR_DATA_DIR/postgresql.auto.conf" <<EOF

# --- Helix PITR recovery (generated by restore.sh) ---
restore_command = 'cp "${PITR_DATA_DIR}/pg_wal_restore/%f" "%p"'
${target_clause}
recovery_target_action = 'promote'
EOF
  : >"$PITR_DATA_DIR/recovery.signal"
  log "PITR data directory prepared: $PITR_DATA_DIR"
  log "Start a Postgres 17 server on this directory to replay WAL and promote."
  log "Example (container): docker run --rm -v $PITR_DATA_DIR:/var/lib/postgresql/data \\"
  log "          -e POSTGRES_PASSWORD=unused helix/postgres-pgvector:17-alpine"
  log "After promotion, run pg_dump on the recovered cluster and load it normally,"
  log "or re-point the application DATABASE_URL at the recovered instance."
}

# --- Logical restore: pg_restore into a target database ----------------------
restore_logical() {
  if [[ "$DRY_RUN" == "0" ]]; then
    [[ -f "$POSTGRES_DUMP" ]] || die "postgres dump not found: $POSTGRES_DUMP"
  fi
  log "target db: $TARGET_DB"

  if bool_true "$ALLOW_DROP_TARGET"; then
    run_shell "$(printf '%s exec -T %q dropdb --if-exists -U %q %q' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$TARGET_DB")"
  fi

  run_shell "$(printf '%s exec -T %q createdb -U %q %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$TARGET_DB")"

  run_shell "$(printf '%s exec -T %q pg_restore --no-owner --no-acl --exit-on-error -U %q -d %q < %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$TARGET_DB" "$POSTGRES_DUMP")"

  if bool_true "$VERIFY"; then
    run_shell "$(printf '%s exec -T %q psql -U %q -d %q -v ON_ERROR_STOP=1 -c %q' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$TARGET_DB" \
      "select count(*) as helix_tables from information_schema.tables where table_schema='public';")"
    run_shell "$(printf '%s exec -T %q psql -U %q -d %q -v ON_ERROR_STOP=1 -c %q' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$TARGET_DB" \
      "select 'public.actors'::regclass as actors_table, 'public.activity'::regclass as activity_table, 'public.installed_plugins'::regclass as installed_plugins_table;")"
    run_shell "$(printf '%s exec -T %q psql -U %q -d %q -v ON_ERROR_STOP=1 -c %q' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$TARGET_DB" \
      "select count(*) as activity_rows, count(this_hash) as hashed_activity_rows from public.activity;")"
  fi
}

# --- Object-store restore: re-sync the bucket from the backup ----------------
restore_objects() {
  local bucket=${HELIX_BACKUP_RUSTFS_BUCKET:-}
  local endpoint
  endpoint=$(object_store_endpoint)
  local src="$OBJECTS_DIR"
  if [[ -z "$bucket" && -d "$OBJECTS_DIR" ]]; then
    bucket=$(find "$OBJECTS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | head -n 1)
  fi
  [[ -n "$bucket" ]] || die "object restore needs HELIX_BACKUP_RUSTFS_BUCKET or an objects/ dir in the backup"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ aws --endpoint-url %q s3 sync %q s3://%s --delete\n' \
      "$endpoint" "$src/$bucket" "$bucket" >&2
    return
  fi
  [[ -d "$src/$bucket" ]] || die "object backup not found in archive: $src/$bucket"
  require_cmd aws
  export_object_store_credentials
  aws --endpoint-url "$endpoint" s3 mb "s3://$bucket" 2>/dev/null || true
  aws --endpoint-url "$endpoint" s3 sync "$src/$bucket" "s3://$bucket" --delete
  log "object bucket restored: s3://$bucket"
}

if [[ "$RESTORE_MODE" == "pitr" ]]; then
  restore_pitr
else
  restore_logical
fi

if bool_true "$RESTORE_OBJECTS"; then
  restore_objects
fi

log "restore workflow complete"
