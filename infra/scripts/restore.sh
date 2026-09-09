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

Two restore paths are supported; logical is the default and --pitr is explicit:
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
  --manifest-public-key <path>     Trusted Ed25519 backup signing public key
  --expected-app-version <id>      Require a specific source build id
  --pitr                           Force PITR replay path
  --recovery-target-time <ts>      PITR recovery target (ISO 8601). Default: latest
  --pitr-data-dir <path>           Host dir to materialize the recovered cluster
  --restore-objects                Restore objects to a new versioned target and switch routing
  --object-target-bucket <name>    New empty bucket (default: <source>-restore-<backup-id>)
  --object-route-command <path>    Atomic route adapter: current; switch <old> <new>; rollback <new> <old>
  --no-object-switch               Validate an isolated object restore without changing routing
  --object-rollback-state <path>   Durable rollback receipt. Default: ./backups/object-restore-state.json
  --rollback-objects <path>        Roll route back using a prior receipt; no backup is required
  --target-object-bucket <name>    Alias for --object-target-bucket
  --manifest-format <ed25519|hmac-v3>  Explicit legacy archive compatibility (default: ed25519)
  --verify                         Run DB verification after a logical restore
  --require-manifest-v3            Require checksum/recovery-set sidecars and schema v3
  --verification-output <path>     Write content-free verification observations
  -h, --help

Environment:
  POSTGRES_DB, POSTGRES_USER, POSTGRES_SERVICE
  AGE_IDENTITY_FILE, HELIX_BACKUP_KMS_DATAKEY, HELIX_KMS_ENDPOINT
  HELIX_BACKUP_SIGNING_PUBLIC_KEY, HELIX_RESTORE_EXPECTED_APP_VERSION
  HELIX_BACKUP_MANIFEST_HMAC_KEY   Same independent 32+ byte key used at backup time
  HELIX_BACKUP_RUSTFS_BUCKET, RUSTFS_ENDPOINT/RUSTFS_ACCESS_KEY/RUSTFS_SECRET_KEY
  HELIX_OBJECT_ROUTE_COMMAND, HELIX_OBJECT_RESTORE_STATE, HELIX_PITR_POSTGRES_IMAGE
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
SIGNING_PUBLIC_KEY=${HELIX_BACKUP_SIGNING_PUBLIC_KEY:-}
EXPECTED_APP_VERSION=${HELIX_RESTORE_EXPECTED_APP_VERSION:-${HELIX_APP_VERSION:-}}
FORCE_PITR=false
RECOVERY_TARGET_TIME=${HELIX_RECOVERY_TARGET_TIME:-}
PITR_DATA_DIR=${HELIX_PITR_DATA_DIR:-./backups/pitr-restore}
RESTORE_OBJECTS=false
OBJECT_TARGET_BUCKET=${HELIX_OBJECT_RESTORE_BUCKET:-${HELIX_RESTORE_TARGET_OBJECT_BUCKET:-}}
MANIFEST_FORMAT=ed25519
OBJECT_ROUTE_COMMAND=${HELIX_OBJECT_ROUTE_COMMAND:-}
OBJECT_SWITCH=true
OBJECT_ROLLBACK_STATE=${HELIX_OBJECT_RESTORE_STATE:-./backups/object-restore-state.json}
ROLLBACK_OBJECTS=
WORK_DIR=
PITR_CONTAINER=
REQUIRE_MANIFEST_V3=false
VERIFICATION_OUTPUT=
MANIFEST_VERIFIED=false
DATABASE_CONSISTENCY=not_run
OBJECT_CONSISTENCY=not_run
SAMPLE_COUNT=0
SAMPLE_MATCHES=0

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
    --manifest-public-key) SIGNING_PUBLIC_KEY=${2:?missing signing public key}; shift 2 ;;
    --expected-app-version) EXPECTED_APP_VERSION=${2:?missing app version}; shift 2 ;;
    --pitr) FORCE_PITR=true; shift ;;
    --recovery-target-time) RECOVERY_TARGET_TIME=${2:?missing recovery target time}; shift 2 ;;
    --pitr-data-dir) PITR_DATA_DIR=${2:?missing pitr data dir}; shift 2 ;;
    --restore-objects) RESTORE_OBJECTS=true; shift ;;
    --object-target-bucket) OBJECT_TARGET_BUCKET=${2:?missing target bucket}; shift 2 ;;
    --object-route-command) OBJECT_ROUTE_COMMAND=${2:?missing route command}; shift 2 ;;
    --no-object-switch) OBJECT_SWITCH=false; shift ;;
    --object-rollback-state) OBJECT_ROLLBACK_STATE=${2:?missing rollback state}; shift 2 ;;
    --rollback-objects) ROLLBACK_OBJECTS=${2:?missing rollback state}; shift 2 ;;
    --target-object-bucket) OBJECT_TARGET_BUCKET=${2:?missing target object bucket}; shift 2 ;;
    --manifest-format) MANIFEST_FORMAT=${2:?missing manifest format}; shift 2 ;;
    --verify) VERIFY=true; shift ;;
    --require-manifest-v3) REQUIRE_MANIFEST_V3=true; shift ;;
    --verification-output) VERIFICATION_OUTPUT=${2:?missing verification output}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$MANIFEST_FORMAT" in ed25519|hmac-v3) ;; *) die "unsupported manifest format" ;; esac

[[ -n "$BACKUP_PATH" || -n "$ROLLBACK_OBJECTS" ]] || die "--backup is required"
if bool_true "$REQUIRE_MANIFEST_V3" && [[ -d "$BACKUP_PATH" ]]; then
  die "strict restore requires an encrypted archive, not an already extracted directory"
fi
if bool_true "$REQUIRE_MANIFEST_V3"; then
  OBJECT_SWITCH=false
  VERIFY=true
  [[ "$TARGET_DB" != "$POSTGRES_DB" ]] || die "strict restore requires an isolated database"
  case "$BACKUP_PATH" in
    *.age|*.kms) ;;
    *) die "strict restore requires a .age or .kms ciphertext archive" ;;
  esac
fi

if [[ "$TARGET_DB" == "$POSTGRES_DB" ]] && ! bool_true "$ALLOW_LIVE_TARGET"; then
  die "refusing to restore into live database '$TARGET_DB'; use a drill database or pass --allow-live-target"
fi

ensure_repo_root
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd node
  if [[ -z "$ROLLBACK_OBJECTS" ]]; then
    require_cmd docker
    if [[ "$MANIFEST_FORMAT" == "ed25519" ]]; then
      [[ -f "$SIGNING_PUBLIC_KEY" ]] || die "restore requires --manifest-public-key or HELIX_BACKUP_SIGNING_PUBLIC_KEY"
    fi
  fi
fi

cleanup() {
  if [[ -n "${PITR_CONTAINER:-}" ]]; then
    docker rm -f "$PITR_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WORK_DIR:-}" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

json_field() {
  node -e 'const fs=require("fs"); const value=process.argv[2].split(".").reduce((value,key)=>value?.[key],JSON.parse(fs.readFileSync(process.argv[1],"utf8"))); if(typeof value!=="string" || !value) process.exit(1); process.stdout.write(value)' "$1" "$2"
}

rollback_objects() {
  [[ -x "$OBJECT_ROUTE_COMMAND" ]] || die "object rollback requires executable --object-route-command"
  [[ -f "$ROLLBACK_OBJECTS" ]] || die "object rollback receipt not found: $ROLLBACK_OBJECTS"
  local previous restored
  previous=$(json_field "$ROLLBACK_OBJECTS" previous_bucket) || die "invalid rollback receipt"
  restored=$(json_field "$ROLLBACK_OBJECTS" restored_bucket) || die "invalid rollback receipt"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ %q rollback %q %q\n' "$OBJECT_ROUTE_COMMAND" "$restored" "$previous"
  else
    local current
    current=$("$OBJECT_ROUTE_COMMAND" current)
    if [[ "$current" == "$restored" ]]; then
      "$OBJECT_ROUTE_COMMAND" rollback "$restored" "$previous"
    elif [[ "$current" != "$previous" ]]; then
      die "object route no longer matches either rollback target"
    fi
  fi
  log "object route rolled back: $restored -> $previous"
}

if [[ -n "$ROLLBACK_OBJECTS" ]]; then
  rollback_objects
  exit 0
fi

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

  local plain_tar="$WORK_DIR/archive.tar.gz"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ shasum -a 256 -c %q\n' "$source.sha256" >&2
  elif [[ -f "$source.sha256" ]]; then
    (cd "$(dirname "$source")" && shasum -a 256 -c "$(basename "$source").sha256") >&2
  elif bool_true "$REQUIRE_MANIFEST_V3"; then
    die "strict restore requires archive checksum sidecar: $source.sha256"
  else
    log "warning: archive checksum sidecar not found; restoring legacy backup"
  fi
  case "$source" in
    *.age)
      [[ -n "$AGE_IDENTITY" ]] || die "encrypted backup requires --age-identity or AGE_IDENTITY_FILE"
      [[ "$DRY_RUN" == "1" ]] || require_cmd age
      if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ age -d -i %q -o <temporary-archive> %q\n' "$AGE_IDENTITY" "$source" >&2
        printf '+ safe_extract_tar.py <temporary-archive> %q\n' "$WORK_DIR" >&2
      else
        require_cmd python3
        age -d -i "$AGE_IDENTITY" -o "$plain_tar" "$source"
        python3 "$SCRIPT_DIR/safe_extract_tar.py" "$plain_tar" "$WORK_DIR"
        rm -f "$plain_tar"
      fi
      ;;
    *.kms)
      local datakey=${KMS_DATAKEY:-$source.datakey}
      if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ aws kms decrypt --ciphertext-blob fileb://%q\n' "$datakey" >&2
        printf '+ aes-gcm-file.mjs decrypt %q <temporary-archive> <kms-data-key-via-stdin>\n' "$source" >&2
      else
        require_cmd aws
        require_cmd node
        require_cmd python3
        kms_decrypt_file "$source" "$plain_tar" "$datakey" "$MANIFEST_FORMAT"
        python3 "$SCRIPT_DIR/safe_extract_tar.py" "$plain_tar" "$WORK_DIR"
        rm -f "$plain_tar"
      fi
      ;;
    *.tar.gz|*.tgz)
      if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ safe_extract_tar.py %q %q\n' "$source" "$WORK_DIR" >&2
      else
        require_cmd python3
        python3 "$SCRIPT_DIR/safe_extract_tar.py" "$source" "$WORK_DIR"
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

if [[ ! -d "$BACKUP_PATH" ]]; then WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-restore.XXXXXX"); fi
BACKUP_DIR=$(extract_backup "$BACKUP_PATH")
POSTGRES_DUMP="$BACKUP_DIR/postgres.dump"
BASEBACKUP_DIR="$BACKUP_DIR/postgres-basebackup"
WAL_DIR="$BACKUP_DIR/wal"
OBJECTS_DIR="$BACKUP_DIR/objects"
MANIFEST="$BACKUP_DIR/manifest.json"
MANIFEST_SIGNATURE="$BACKUP_DIR/manifest.sig"

verify_manifest() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ verify %s manifest and every file digest before restoring data\n' "$MANIFEST_FORMAT"
    return
  fi
  [[ -f "$MANIFEST" ]] || die "backup manifest not found: $MANIFEST"
  if [[ "$MANIFEST_FORMAT" == "ed25519" ]]; then
    [[ -f "$MANIFEST_SIGNATURE" ]] || die "backup manifest signature not found"
    node "$SCRIPT_DIR/backup-manifest.mjs" verify "$BACKUP_DIR" "$MANIFEST" "$SIGNING_PUBLIC_KEY" "$EXPECTED_APP_VERSION"
  else
    node "$SCRIPT_DIR/backup-manifest.mjs" verify --root "$BACKUP_DIR" >/dev/null
    [[ -z "$EXPECTED_APP_VERSION" ]] || die "legacy HMAC backups do not attest an application version"
  fi
  if bool_true "$REQUIRE_MANIFEST_V3"; then
    node -e 'const fs=require("fs"),m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(m.schema!=="helix.backup-manifest.v3" || !["age","kms"].includes(m.encryption?.method) || m.objects?.included!==true) process.exit(1)' "$MANIFEST" \
      || die "strict restore requires an encrypted recovery-set manifest with objects"
  fi
  if [[ -f "$BACKUP_PATH.manifest.json" ]]; then
    cmp "$BACKUP_PATH.manifest.json" "$MANIFEST" >/dev/null || die "external manifest differs from the verified embedded manifest"
  elif bool_true "$REQUIRE_MANIFEST_V3"; then
    die "strict restore requires an external manifest sidecar"
  fi
  MANIFEST_VERIFIED=true
}
verify_manifest

# Logical restoration preserves the exported DB/object snapshot; PITR is explicit.
RESTORE_MODE=logical
if bool_true "$FORCE_PITR"; then
  RESTORE_MODE=pitr
fi

log "backup: $BACKUP_PATH"
log "restore mode: $RESTORE_MODE"
log "dry run: $DRY_RUN"

# --- PITR restore: rebuild a cluster from base backup + WAL replay -----------
restore_pitr() {
  if [[ "$DRY_RUN" == "0" && -z "$RECOVERY_TARGET_TIME" ]]; then
    RECOVERY_TARGET_TIME=$(node -e 'const m=require(process.argv[1]); if(m.pitr_proof?.enabled===true) process.stdout.write(m.pitr_proof.target_time)' "$MANIFEST")
  fi
  if [[ -n "$RECOVERY_TARGET_TIME" && ! "$RECOVERY_TARGET_TIME" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[T\ ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:?[0-9]{2})$ ]]; then
    die "invalid --recovery-target-time"
  fi
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
+ docker run --network none --mount ${PITR_DATA_DIR} and start isolated Postgres
+ wait for WAL replay/promotion, verify schema/invariants and before/after proof markers
+ docker rm -f <isolated-pitr-container>
EOF
    return
  fi
  require_cmd cp
  [[ -d "$BASEBACKUP_DIR" ]] || die "PITR restore needs a base backup at $BASEBACKUP_DIR"
  [[ -d "$WAL_DIR" ]] || die "PITR restore needs archived WAL at $WAL_DIR"
  if [[ -e "$PITR_DATA_DIR" && -n "$(find "$PITR_DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    die "PITR data directory must be empty: $PITR_DATA_DIR"
  fi
  mkdir -p "$PITR_DATA_DIR"
  cp -a "$BASEBACKUP_DIR/." "$PITR_DATA_DIR/"
  mkdir -p "$PITR_DATA_DIR/pg_wal_restore"
  cp -a "$WAL_DIR/." "$PITR_DATA_DIR/pg_wal_restore/"
  chmod 700 "$PITR_DATA_DIR"
  # Postgres 12+ recovery: restore_command + recovery target in auto.conf,
  # plus an empty recovery.signal file to trigger archive recovery mode.
  cat >>"$PITR_DATA_DIR/postgresql.auto.conf" <<EOF

# --- Helix PITR recovery (generated by restore.sh) ---
restore_command = 'cp "/var/lib/postgresql/data/pg_wal_restore/%f" "%p"'
${target_clause}
recovery_target_action = 'promote'
archive_mode = 'off'
EOF
  rm -f "$PITR_DATA_DIR/standby.signal"
  : >"$PITR_DATA_DIR/recovery.signal"

  local image=${HELIX_PITR_POSTGRES_IMAGE:-}
  if [[ -z "$image" ]]; then
    image=$(bash -c "$(compose) images -q $POSTGRES_SERVICE" | head -n 1)
  fi
  [[ -n "$image" ]] || die "cannot resolve PITR Postgres image; set HELIX_PITR_POSTGRES_IMAGE"
  local absolute_data
  absolute_data=$(cd "$PITR_DATA_DIR" && pwd -P)
  PITR_CONTAINER="helix-pitr-$(date -u +%s)-$$"
  docker run --rm --entrypoint sh -v "$absolute_data:/target" "$image" \
    -c 'chown -R postgres:postgres /target'
  docker run -d --name "$PITR_CONTAINER" --network none \
    -v "$absolute_data:/var/lib/postgresql/data" "$image" \
    postgres -c listen_addresses='' >/dev/null

  local ready=false
  for _ in {1..90}; do
    if docker exec "$PITR_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      ready=true
      break
    fi
    if ! docker inspect -f '{{.State.Running}}' "$PITR_CONTAINER" 2>/dev/null | grep -qx true; then
      docker logs "$PITR_CONTAINER" >&2 || true
      die "recovered Postgres exited before promotion"
    fi
    sleep 1
  done
  bool_true "$ready" || die "timed out waiting for recovered Postgres"
  docker exec "$PITR_CONTAINER" psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c "select pg_is_in_recovery();" | grep -qx f
  docker exec "$PITR_CONTAINER" psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -c "select 'public.actors'::regclass, 'public.activity'::regclass, 'public.schema_migrations'::regclass;" >/dev/null

  local proof_enabled proof_target proof_before proof_after
  proof_enabled=$(node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.pitr_proof?.enabled===true))' "$MANIFEST")
  if [[ "$proof_enabled" == "true" ]]; then
    proof_target=$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.pitr_proof.target_time)' "$MANIFEST")
    proof_before=$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.pitr_proof.before_marker)' "$MANIFEST")
    proof_after=$(node -e 'const m=require(process.argv[1]); process.stdout.write(m.pitr_proof.after_marker)' "$MANIFEST")
    [[ -z "$RECOVERY_TARGET_TIME" || "$RECOVERY_TARGET_TIME" == "$proof_target" ]] \
      || die "recovery target does not match the backup proof target"
    [[ "$proof_before" =~ ^[A-Za-z0-9._-]+$ && "$proof_after" =~ ^[A-Za-z0-9._-]+$ ]] \
      || die "invalid PITR proof markers"
    docker exec "$PITR_CONTAINER" psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
      -c "select count(*) from public.helix_pitr_proof where id='$proof_before';" | grep -qx 1
    docker exec "$PITR_CONTAINER" psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
      -c "select count(*) from public.helix_pitr_proof where id='$proof_after';" | grep -qx 0
  fi
  docker rm -f "$PITR_CONTAINER" >/dev/null
  PITR_CONTAINER=
  log "PITR replay promoted and passed schema, invariant, and marker checks"
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
    verify_database_consistency
  fi
}

capture_database_consistency() {
  local database=$1 output=$2
  local sql
  sql="select metric, value from (
    select 'activity.count'::text metric, count(*)::text value from public.activity
    union all select 'audit.invalid_links', count(*)::text from (
      select prev_hash, lag(this_hash) over (partition by org_id order by sequence) expected
      from public.activity
    ) links where prev_hash is distinct from expected
    union all select 'drive_versions.count', count(*)::text from public.drive_versions
    union all select 'mail_outbound_messages.count', count(*)::text from public.mail_outbound_messages
    union all select 'objects.count', count(*)::text from public.objects
    union all select 'outbox.count', count(*)::text from public.outbox
  ) metrics order by metric;
  select 'drive_version.sample', concat_ws('|', id::text, storage_key, sha256)
  from public.drive_versions order by id limit 25;"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ %s exec -T %q psql -At -F <tab> -U %q -d %q > %q # compare database, versions, outbound queues, audit chain\n' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$database" "$output"
  else
    bash -c "$(printf '%s exec -T %q psql -X -qAt -F %q -v ON_ERROR_STOP=1 -U %q -d %q -c %q > %q' \
      "$(compose)" "$POSTGRES_SERVICE" $'\t' "$POSTGRES_USER" "$database" "$sql" "$output")"
  fi
}

verify_database_consistency() {
  local expected="$BACKUP_DIR/consistency/database.tsv"
  local observed="${WORK_DIR:-${TMPDIR:-/tmp}}/restored-database.tsv"
  if [[ "$DRY_RUN" == "1" ]]; then
    capture_database_consistency "$TARGET_DB" "$observed"
    printf '+ cmp %q %q\n' "$expected" "$observed"
    printf '+ assert audit.invalid_links == 0 and outbound queue counts match\n'
    return
  fi
  [[ -f "$expected" ]] || {
    bool_true "$REQUIRE_MANIFEST_V3" && die "strict restore requires database consistency snapshot"
    log "warning: database consistency snapshot missing"
    return
  }
  capture_database_consistency "$TARGET_DB" "$observed"
  cmp "$expected" "$observed" >/dev/null || die "restored database consistency snapshot differs from source"
  [[ "$(awk -F $'\t' '$1 == "audit.invalid_links" { print $2 }' "$observed")" == "0" ]] \
    || die "restored audit hash chain has broken links"
  DATABASE_CONSISTENCY=passed
}

# --- Object-store restore: stage, validate, then atomically switch -----------
restore_objects() {
  local configured_source_bucket=${HELIX_BACKUP_RUSTFS_BUCKET:-}
  local bucket=$configured_source_bucket
  local endpoint
  endpoint=$(object_store_endpoint)
  local inventory="$OBJECTS_DIR/inventory.json"
  if [[ "$DRY_RUN" == "0" ]]; then
    local source_bucket
    source_bucket=$(json_field "$MANIFEST" objects.bucket) || die "manifest does not name its source bucket"
    [[ -z "$bucket" || "$bucket" == "$source_bucket" ]] || die "configured source bucket differs from manifest"
    bucket=$source_bucket
  fi
  [[ -n "$bucket" ]] || bucket='helix-source'
  local backup_id=restore
  if [[ "$DRY_RUN" == "0" ]]; then
    backup_id=$(json_field "$MANIFEST" backup_id || json_field "$MANIFEST" backupId) || die "backup manifest does not name its backup id"
  fi
  local suffix
  suffix=$(printf '%s' "$backup_id" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9.-' | cut -c1-24)
  local target=${OBJECT_TARGET_BUCKET:-$(printf '%.37s-restore-%s' "$bucket" "$suffix")}
  [[ "$target" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "invalid object restore target bucket: $target"
  [[ "$target" != "$bucket" ]] || die "object restore target must be a new bucket"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ create new versioned bucket s3://%s\n' "$target"
    printf '+ restore and SHA-256 verify every signed inventory object into s3://%s\n' "$target"
    if bool_true "$OBJECT_SWITCH"; then
      printf '+ atomic route compare/switch <previous> %s; preserve rollback receipt %s\n' \
        "$target" "$OBJECT_ROLLBACK_STATE"
    else
      printf '+ validate isolated object restore without changing routing\n'
    fi
    return
  fi
  if [[ "$MANIFEST_FORMAT" == "ed25519" ]]; then
    [[ -f "$inventory" ]] || die "object inventory not found in archive: $inventory"
  fi
  require_cmd aws
  export_object_store_credentials
  if aws --no-cli-pager --endpoint-url "$endpoint" s3api head-bucket --bucket "$target" >/dev/null 2>&1; then
    die "object restore target already exists: s3://$target"
  fi
  aws --no-cli-pager --endpoint-url "$endpoint" s3api create-bucket --bucket "$target" >/dev/null
  aws --no-cli-pager --endpoint-url "$endpoint" s3api put-bucket-versioning --bucket "$target" \
    --versioning-configuration Status=Enabled
  [[ "$(aws --no-cli-pager --endpoint-url "$endpoint" s3api get-bucket-versioning \
    --bucket "$target" --query Status --output text)" == "Enabled" ]] \
    || die "object restore target did not enable versioning"
  local observations
  if [[ "$MANIFEST_FORMAT" == "ed25519" ]]; then
    observations=$(node "$SCRIPT_DIR/object-snapshot.mjs" restore "$inventory" "$target" "$endpoint")
  else
    observations=$(node "$SCRIPT_DIR/object-snapshot.mjs" restore-legacy "$BACKUP_DIR" "$target" "$endpoint")
  fi
  SAMPLE_COUNT=$(printf '%s' "$observations" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const n=JSON.parse(s).objectCount;if(!Number.isSafeInteger(n)||n<0)process.exit(1);process.stdout.write(String(n))})')
  SAMPLE_MATCHES=$SAMPLE_COUNT
  OBJECT_CONSISTENCY=passed

  if bool_true "$OBJECT_SWITCH"; then
    [[ -x "$OBJECT_ROUTE_COMMAND" ]] || die "object restore switch requires executable --object-route-command"
    local previous state_dir
    previous=$("$OBJECT_ROUTE_COMMAND" current)
    [[ -n "$previous" ]] || die "object route command returned an empty current target"
    state_dir=$(dirname "$OBJECT_ROLLBACK_STATE")
    mkdir -p "$state_dir"
    [[ ! -e "$OBJECT_ROLLBACK_STATE" ]] \
      || die "refusing to overwrite existing object rollback receipt: $OBJECT_ROLLBACK_STATE"
    node -e 'const fs=require("fs"); const [file,previous,restored,backup,status]=process.argv.slice(1); const temp=`${file}.tmp-${process.pid}`; fs.writeFileSync(temp,`${JSON.stringify({schema_version:1,previous_bucket:previous,restored_bucket:restored,backup_id:backup,status,updated_at:new Date().toISOString()},null,2)}\n`,{mode:0o600}); fs.renameSync(temp,file)' \
      "$OBJECT_ROLLBACK_STATE" "$previous" "$target" "$backup_id" prepared
    "$OBJECT_ROUTE_COMMAND" switch "$previous" "$target"
    node -e 'const fs=require("fs"); const file=process.argv[1], state=JSON.parse(fs.readFileSync(file,"utf8")), temp=`${file}.tmp-${process.pid}`; state.status="switched"; state.updated_at=new Date().toISOString(); fs.writeFileSync(temp,`${JSON.stringify(state,null,2)}\n`,{mode:0o600}); fs.renameSync(temp,file)' \
      "$OBJECT_ROLLBACK_STATE"
    log "object route switched atomically: $previous -> $target"
    log "rollback: restore.sh --rollback-objects $OBJECT_ROLLBACK_STATE --object-route-command $OBJECT_ROUTE_COMMAND --execute"
  else
    log "isolated object restore validated without changing routing: s3://$target"
  fi
}

write_verification_observations() {
  [[ -n "$VERIFICATION_OUTPUT" ]] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ write content-free restore verification observations: %q\n' "$VERIFICATION_OUTPUT"
    return
  fi
  mkdir -p "$(dirname "$VERIFICATION_OUTPUT")"
  {
    printf 'manifest_integrity\t%s\n' "$([ "$MANIFEST_VERIFIED" == "true" ] && printf passed || printf failed)"
    printf 'database_consistency\t%s\n' "$DATABASE_CONSISTENCY"
    printf 'object_version_consistency\t%s\n' "$OBJECT_CONSISTENCY"
    printf 'outbound_queue_consistency\t%s\n' "$DATABASE_CONSISTENCY"
    printf 'audit_chain\t%s\n' "$DATABASE_CONSISTENCY"
    printf 'sample_count\t%s\n' "$SAMPLE_COUNT"
    printf 'sample_matches\t%s\n' "$SAMPLE_MATCHES"
  } >"$VERIFICATION_OUTPUT"
}

if [[ "$RESTORE_MODE" == "pitr" ]]; then
  restore_pitr
else
  restore_logical
fi

if bool_true "$RESTORE_OBJECTS"; then
  restore_objects
fi

write_verification_observations
log "restore workflow complete"
