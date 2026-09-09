#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/backup.sh [options]

Creates Helix backup artifacts. Dry-run is the default; pass --execute to run.

Every backup contains a logical dump and ready-object inventory from one
exported repeatable-read snapshot. --pitr additionally captures a physical
base backup plus archived WAL for point-in-time recovery.

Options:
  --tier <personal|business|enterprise|sovereign>
  --output-dir <path>              Default: ./backups
  --backup-id <id>                 Default: UTC timestamp
  --execute                        Run the backup and write artifacts
  --dry-run                        Print commands only
  --pitr                           Take a physical base backup + WAL for PITR
  --include-wal                    Capture archived WAL segments alongside the dump
  --object-backup                  Capture exact immutable object versions referenced by the DB
  --skip-object-backup             Skip object-store backup entirely
  --age-recipient <recipient>      Encrypt archive with an age recipient
  --age-recipients-file <path>     Encrypt archive with an age recipient file
  --kms-key-id <id>                Encrypt archive with a cloud KMS data key (Tier 3)
  --signing-private-key <path>     Ed25519 private key used to sign manifest.json
  -h, --help

Environment:
  POSTGRES_DB, POSTGRES_USER, POSTGRES_SERVICE, POSTGRES_PASSWORD
  HELIX_BACKUP_DIR                 Default output directory
  HELIX_BACKUP_PITR=true           Default --pitr on
  HELIX_BACKUP_PITR_PROOF=true     Add before/after recovery markers for drills
  HELIX_BACKUP_INCLUDE_WAL=true    Default --include-wal on
  HELIX_BACKUP_RUSTFS_BUCKET=<b>   Versioned object bucket to back up
  RUSTFS_ENDPOINT / RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY
  HELIX_WAL_ARCHIVE_DIR            Host path that receives archived WAL
                                   (Postgres archive_command target). Default:
                                   /wal_archive inside the postgres container.
  AGE_RECIPIENTS / AGE_RECIPIENTS_FILE
  HELIX_BACKUP_KMS_KEY_ID          Cloud KMS key id/alias/ARN (Tier 3)
  HELIX_KMS_ENDPOINT               Optional KMS endpoint override (LocalStack etc.)
  HELIX_BACKUP_SIGNING_PRIVATE_KEY Required Ed25519 manifest signing key
  HELIX_APP_VERSION                Immutable build id (defaults to Git commit locally)

WAL archiving (operator one-time setup, required for --pitr / --include-wal):
  postgresql.conf:
    wal_level = replica
    archive_mode = on
    archive_command = 'test ! -f /wal_archive/%f && cp %p /wal_archive/%f'
    archive_timeout = 60        # bound RPO to 60s of WAL
  Mount a durable volume at /wal_archive. The enterprise Helm overlay wires this
  through CloudNativePG's barmanObjectStore instead -- see docs/backup-restore.md.
EOF
}

TIER=${HELIX_SECURITY_TIER:-personal}
OUTPUT_DIR=${HELIX_BACKUP_DIR:-./backups}
BACKUP_ID=${HELIX_BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
DRY_RUN=1
PITR=${HELIX_BACKUP_PITR:-false}
PITR_PROOF=${HELIX_BACKUP_PITR_PROOF:-false}
INCLUDE_WAL=${HELIX_BACKUP_INCLUDE_WAL:-false}
OBJECT_BACKUP=auto
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
POSTGRES_DB=${POSTGRES_DB:-helix}
POSTGRES_USER=${POSTGRES_USER:-helix}
WAL_ARCHIVE_DIR=${HELIX_WAL_ARCHIVE_DIR:-/wal_archive}
RUSTFS_BUCKET=${HELIX_BACKUP_RUSTFS_BUCKET:-}
KMS_KEY_ID=${HELIX_BACKUP_KMS_KEY_ID:-}
SIGNING_PRIVATE_KEY=${HELIX_BACKUP_SIGNING_PRIVATE_KEY:-}
AGE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier) TIER=${2:?missing tier}; shift 2 ;;
    --output-dir) OUTPUT_DIR=${2:?missing output dir}; shift 2 ;;
    --backup-id) BACKUP_ID=${2:?missing backup id}; shift 2 ;;
    --execute) DRY_RUN=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --pitr) PITR=true; INCLUDE_WAL=true; shift ;;
    --include-wal) INCLUDE_WAL=true; shift ;;
    --object-backup) OBJECT_BACKUP=true; shift ;;
    --skip-object-backup) OBJECT_BACKUP=false; shift ;;
    --skip-rustfs-metadata) OBJECT_BACKUP=false; shift ;;
    --age-recipient) AGE_ARGS+=("-r" "${2:?missing age recipient}"); shift 2 ;;
    --age-recipients-file) AGE_ARGS+=("-R" "${2:?missing recipients file}"); shift 2 ;;
    --kms-key-id) KMS_KEY_ID=${2:?missing kms key id}; shift 2 ;;
    --signing-private-key) SIGNING_PRIVATE_KEY=${2:?missing signing private key}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$TIER" in
  personal|business|enterprise|sovereign) ;;
  *) die "unsupported tier: $TIER" ;;
esac

case "$BACKUP_ID" in
  ""|.*|*/*|*\\*) die "backup id must be a relative name without slashes or a leading dot: $BACKUP_ID" ;;
esac
[[ "$BACKUP_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "backup id contains unsupported characters: $BACKUP_ID"

ensure_repo_root
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd docker
  require_cmd node
  [[ -f "$SIGNING_PRIVATE_KEY" ]] || die "backup requires --signing-private-key or HELIX_BACKUP_SIGNING_PRIVATE_KEY"
fi
require_cmd tar

APP_VERSION=${HELIX_APP_VERSION:-}
if [[ -z "$APP_VERSION" ]]; then
  APP_VERSION=$(git rev-parse --verify HEAD 2>/dev/null || true)
fi
[[ -n "$APP_VERSION" ]] || die "HELIX_APP_VERSION is required outside a Git checkout"

if [[ ${#AGE_ARGS[@]} -eq 0 && -n "${AGE_RECIPIENTS_FILE:-}" ]]; then
  AGE_ARGS+=("-R" "$AGE_RECIPIENTS_FILE")
fi

if [[ ${#AGE_ARGS[@]} -eq 0 && -n "${AGE_RECIPIENTS:-}" ]]; then
  read -r -a env_recipients <<<"${AGE_RECIPIENTS//,/ }"
  for recipient in "${env_recipients[@]}"; do
    AGE_ARGS+=("-r" "$recipient")
  done
fi

ENCRYPT_AGE=false
[[ ${#AGE_ARGS[@]} -gt 0 ]] && ENCRYPT_AGE=true
ENCRYPT_KMS=false
[[ -n "$KMS_KEY_ID" ]] && ENCRYPT_KMS=true

if [[ "$ENCRYPT_AGE" == "true" && "$ENCRYPT_KMS" == "true" ]]; then
  die "choose one of --age-recipient or --kms-key-id, not both"
fi

# Tier policy: business+ must be encrypted; sovereign requires KMS/HSM-backed keys.
if [[ "$TIER" != "personal" && "$ENCRYPT_AGE" == "false" && "$ENCRYPT_KMS" == "false" && "$DRY_RUN" == "0" ]]; then
  die "$TIER backups must be encrypted; set AGE_RECIPIENTS/AGE_RECIPIENTS_FILE/--age-recipient or HELIX_BACKUP_KMS_KEY_ID/--kms-key-id"
fi
if [[ "$TIER" == "sovereign" && "$ENCRYPT_KMS" == "false" && "$DRY_RUN" == "0" ]]; then
  die "sovereign backups require KMS/HSM-backed encryption; set --kms-key-id"
fi

if [[ "$ENCRYPT_AGE" == "true" && "$DRY_RUN" == "0" ]]; then
  require_cmd age
fi
if [[ "$ENCRYPT_KMS" == "true" && "$DRY_RUN" == "0" ]]; then
  require_cmd aws
  require_cmd node
fi

# Object backup defaults to on whenever a bucket is configured.
if [[ "$OBJECT_BACKUP" == "auto" ]]; then
  if [[ -n "$RUSTFS_BUCKET" ]]; then OBJECT_BACKUP=true; else OBJECT_BACKUP=false; fi
fi
if [[ "$TIER" != "personal" && "$OBJECT_BACKUP" != "true" ]]; then
  die "$TIER backups must include object storage; set HELIX_BACKUP_RUSTFS_BUCKET and --object-backup"
fi
if bool_true "$PITR_PROOF" && ! bool_true "$PITR"; then
  die "HELIX_BACKUP_PITR_PROOF requires --pitr"
fi

STAGING_DIR="$OUTPUT_DIR/$BACKUP_ID"
POSTGRES_DUMP="$STAGING_DIR/postgres.dump"
BASEBACKUP_DIR="$STAGING_DIR/postgres-basebackup"
WAL_DIR="$STAGING_DIR/wal"
OBJECTS_DIR="$STAGING_DIR/objects"
OBJECT_REFS="$STAGING_DIR/object-references.json"
OBJECT_VERSIONS="$STAGING_DIR/object-versions.json"
MANIFEST="$STAGING_DIR/manifest.json"
MANIFEST_SIGNATURE="$STAGING_DIR/manifest.sig"
ARCHIVE="$OUTPUT_DIR/$BACKUP_ID.tar.gz"

log "backup id: $BACKUP_ID"
log "tier: $TIER"
log "pitr: $PITR  include-wal: $INCLUDE_WAL  object-backup: $OBJECT_BACKUP"
log "dry run: $DRY_RUN"

if [[ "$DRY_RUN" == "1" ]]; then
  printf '+ mkdir -p %q\n' "$STAGING_DIR"
else
  [[ ! -e "$STAGING_DIR" && ! -e "$ARCHIVE" && ! -e "$ARCHIVE.age" && ! -e "$ARCHIVE.kms" ]] \
    || die "backup output already exists for id: $BACKUP_ID"
  mkdir -p "$STAGING_DIR"
fi

compose() {
  # shellcheck disable=SC2086
  printf 'docker compose %s' "${HELIX_COMPOSE_ARGS:-}"
}

# --- Shared database/object boundary ----------------------------------------
DATABASE_SNAPSHOT=
DATABASE_BOUNDARY=
DATABASE_LSN=
MIGRATION_INVENTORY='[]'
SNAPSHOT_PID=
SNAPSHOT_INPUT_FD=
SNAPSHOT_OUTPUT_FD=

start_consistent_snapshot() {
  if [[ "$DRY_RUN" == "1" ]]; then
    DATABASE_SNAPSHOT='<exported-snapshot>'
    DATABASE_BOUNDARY='<database-boundary>'
    DATABASE_LSN='<boundary-lsn>'
    printf '+ begin repeatable read, read-only transaction and export shared DB/object snapshot\n'
    return
  fi
  local cmd
  cmd=$(printf '%s exec -T %q psql -X -qAt -v ON_ERROR_STOP=1 -U %q -d %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB")
  coproc SNAPSHOT_HOLDER { bash -c "$cmd"; }
  SNAPSHOT_PID=$SNAPSHOT_HOLDER_PID
  exec {SNAPSHOT_INPUT_FD}>&"${SNAPSHOT_HOLDER[1]}"
  exec {SNAPSHOT_OUTPUT_FD}<&"${SNAPSHOT_HOLDER[0]}"
  printf '%s\n' \
    'begin isolation level repeatable read read only;' \
    'select pg_export_snapshot();' \
    "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');" \
    'select pg_current_wal_lsn();' >&"$SNAPSHOT_INPUT_FD"
  IFS= read -r DATABASE_SNAPSHOT <&"$SNAPSHOT_OUTPUT_FD"
  IFS= read -r DATABASE_BOUNDARY <&"$SNAPSHOT_OUTPUT_FD"
  IFS= read -r DATABASE_LSN <&"$SNAPSHOT_OUTPUT_FD"
  [[ "$DATABASE_SNAPSHOT" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || die "Postgres did not export a valid backup snapshot"
  [[ -n "$DATABASE_BOUNDARY" && -n "$DATABASE_LSN" ]] || die "Postgres did not return the backup boundary"
}

finish_consistent_snapshot() {
  [[ "$DRY_RUN" == "0" && -n "$SNAPSHOT_PID" ]] || return 0
  printf 'commit;\n\\q\n' >&"$SNAPSHOT_INPUT_FD"
  exec {SNAPSHOT_INPUT_FD}>&-
  wait "$SNAPSHOT_PID"
  SNAPSHOT_PID=
}

abort_consistent_snapshot() {
  [[ -n "$SNAPSHOT_PID" ]] || return 0
  kill "$SNAPSHOT_PID" 2>/dev/null || true
  wait "$SNAPSHOT_PID" 2>/dev/null || true
  SNAPSHOT_PID=
}

trap abort_consistent_snapshot EXIT

# --- Postgres logical dump ---------------------------------------------------
dump_postgres_logical() {
  local cmd
  cmd=$(printf '%s exec -T %q pg_dump --snapshot=%q --format=custom --no-owner --no-acl --verbose -U %q -d %q > %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$DATABASE_SNAPSHOT" "$POSTGRES_USER" "$POSTGRES_DB" "$POSTGRES_DUMP")
  run_shell "$cmd"
}

capture_snapshot_metadata() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ read applied migrations and every ready storage reference from the exported snapshot\n'
    return
  fi
  local snapshot_sql refs_sql
  snapshot_sql="begin isolation level repeatable read read only; set transaction snapshot '$DATABASE_SNAPSHOT';"
  MIGRATION_INVENTORY=$(bash -c "$(printf '%s exec -T %q psql -X -qAt -v ON_ERROR_STOP=1 -U %q -d %q -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "$snapshot_sql select coalesce(json_agg(json_build_object('namespace', namespace, 'name', name) order by namespace, name), '[]'::json)::text from schema_migrations; commit;")")
  refs_sql="$snapshot_sql
    with referenced as (
      select storage_key, byte_size::bigint as byte_size, lower(sha256) as sha256
      from objects
      where storage_key <> ''
        and coalesce(metadata->>'status', 'ready') = 'ready'
      union all
      select version.storage_key, version.byte_size::bigint, lower(version.sha256)
      from drive_versions version
      join objects object on object.id = version.object_id and object.org_id = version.org_id
      where version.storage_key <> ''
        and coalesce(object.metadata->>'status', 'ready') = 'ready'
      union all
      select metadata->'preview'->>'storageKey', null::bigint, null::text
      from objects
      where coalesce(metadata->>'status', 'ready') = 'ready'
        and coalesce(metadata->'preview'->>'storageKey', '') <> ''
    )
    select coalesce(json_agg(json_build_object('key', storage_key, 'size', byte_size, 'sha256', sha256)
      order by storage_key), '[]'::json)::text from referenced; commit;"
  bash -c "$(printf '%s exec -T %q psql -X -qAt -v ON_ERROR_STOP=1 -U %q -d %q -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" "$refs_sql")" >"$OBJECT_REFS"
  [[ "$MIGRATION_INVENTORY" == \[*\] ]] || die "Postgres returned invalid migration metadata"
  node -e 'const fs=require("fs"); if(!Array.isArray(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))) process.exit(1)' "$OBJECT_REFS" \
    || die "Postgres returned invalid object references"
}

require_object_coverage() {
  [[ "$DRY_RUN" == "0" && "$OBJECT_BACKUP" != "true" ]] || return 0
  node -e 'const fs=require("fs"); if(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).length) process.exit(1)' \
    "$OBJECT_REFS" || die "database snapshot has ready object references; object backup is required"
}

# --- Postgres physical base backup for PITR ----------------------------------
# pg_basebackup produces a self-consistent cluster snapshot; combined with the
# archived WAL it allows replay to any point after the backup start LSN.
backup_postgres_physical() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ mkdir -p %q\n' "$BASEBACKUP_DIR"
    printf '+ %s exec -T -e PGPASSWORD=<redacted> %q pg_basebackup -U %q -D - -Ft -z -X fetch -P -l %q | tar -C %q -xzf -\n' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "helix-pitr-$BACKUP_ID" "$BASEBACKUP_DIR"
    return
  fi
  mkdir -p "$BASEBACKUP_DIR"
  # Stream the base backup as a gzipped tar over the exec channel and unpack
  # locally so the archive is host-side and self-contained.
  bash -o pipefail -c "$(printf '%s exec -T -e PGPASSWORD=%q %q pg_basebackup -U %q -D - -Ft -z -X fetch -c fast -l %q | tar -C %q -xzf -' \
    "$(compose)" "${POSTGRES_PASSWORD:-helix_dev_password}" "$POSTGRES_SERVICE" "$POSTGRES_USER" \
    "helix-pitr-$BACKUP_ID" "$BASEBACKUP_DIR")"
  [[ -f "$BASEBACKUP_DIR/PG_VERSION" ]] || die "pg_basebackup did not produce a cluster"
  # Record the backup label / start LSN for the manifest and restore tooling.
  bash -c "$(printf '%s exec -T %q psql -U %q -d %q -t -A -v ON_ERROR_STOP=1 -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "select pg_current_wal_lsn();")" >"$BASEBACKUP_DIR/BACKUP_END_LSN"
}

# --- WAL segment capture -----------------------------------------------------
# Copies the archived WAL segments (written by Postgres archive_command) so the
# restore side can replay them. WAL_ARCHIVE_DIR is the in-container archive path.
capture_wal() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ mkdir -p %q\n' "$WAL_DIR"
    printf '+ docker compose exec -T %s psql -c "select pg_switch_wal()"\n' "$POSTGRES_SERVICE"
    printf '+ docker compose exec -T %s sh -c '\''tar -C %s -cf - .'\'' | tar -C %s -xf -\n' \
      "$POSTGRES_SERVICE" "$WAL_ARCHIVE_DIR" "$WAL_DIR"
    return
  fi
  mkdir -p "$WAL_DIR"
  # Flush and wait for the exact segment before copying the archive. Returning
  # earlier would produce a backup that advertises WAL it does not contain.
  local segment
  segment=$(bash -c "$(printf '%s exec -T %q psql -X -qAt -U %q -d %q -v ON_ERROR_STOP=1 -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "select pg_walfile_name(pg_switch_wal());")")
  [[ "$segment" =~ ^[A-F0-9]{24}$ ]] || die "Postgres did not return the switched WAL segment"
  bash -c "$(printf '%s exec -T %q test -d %q' "$(compose)" "$POSTGRES_SERVICE" "$WAL_ARCHIVE_DIR")" \
    || die "WAL archive directory is unavailable: $WAL_ARCHIVE_DIR"
  local archived=false
  for _ in {1..60}; do
    if bash -c "$(printf '%s exec -T %q test -f %q' \
      "$(compose)" "$POSTGRES_SERVICE" "$WAL_ARCHIVE_DIR/$segment")"; then
      archived=true
      break
    fi
    sleep 1
  done
  bool_true "$archived" || die "timed out waiting for archived WAL segment: $segment"
  bash -c "$(printf '%s exec -T %q sh -c %q | tar -C %q -xf -' \
    "$(compose)" "$POSTGRES_SERVICE" "tar -C $WAL_ARCHIVE_DIR -cf - ." "$WAL_DIR")"
}

PITR_PROOF_BEFORE=
PITR_PROOF_AFTER=
PITR_PROOF_TARGET=

create_pitr_proof() {
  bool_true "$PITR_PROOF" || return 0
  PITR_PROOF_BEFORE="$BACKUP_ID-before"
  PITR_PROOF_AFTER="$BACKUP_ID-after"
  if [[ "$DRY_RUN" == "1" ]]; then
    PITR_PROOF_TARGET='<between-before-and-after-markers>'
    printf '+ create PITR before marker, record target time, then create post-target marker\n'
    return
  fi
  bash -c "$(printf '%s exec -T %q psql -X -qAt -U %q -d %q -v ON_ERROR_STOP=1 -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "create table if not exists public.helix_pitr_proof (id text primary key, created_at timestamptz not null default clock_timestamp()); insert into public.helix_pitr_proof(id) values ('$PITR_PROOF_BEFORE') on conflict do nothing;")" >/dev/null
  PITR_PROOF_TARGET=$(bash -c "$(printf '%s exec -T %q psql -X -qAt -U %q -d %q -v ON_ERROR_STOP=1 -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00';")" | tail -n 1)
  [[ -n "$PITR_PROOF_TARGET" ]] || die "could not record PITR proof target"
  bash -c "$(printf '%s exec -T %q psql -X -qAt -U %q -d %q -v ON_ERROR_STOP=1 -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "insert into public.helix_pitr_proof(id) values ('$PITR_PROOF_AFTER') on conflict do nothing;")" >/dev/null
}

# --- RustFS / S3 object-store backup -----------------------------------------
# Select and download the one immutable bucket version that existed at the
# exported database snapshot boundary for every ready database reference.
backup_objects() {
  local endpoint
  endpoint=$(object_store_endpoint)
  if [[ -z "$RUSTFS_BUCKET" ]]; then
    die "object-backup requires HELIX_BACKUP_RUSTFS_BUCKET"
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ mkdir -p %q\n' "$OBJECTS_DIR"
    printf '+ require bucket versioning Enabled: s3://%s\n' "$RUSTFS_BUCKET"
    printf '+ aws --endpoint-url %q s3api list-object-versions --bucket %q > version inventory\n' \
      "$endpoint" "$RUSTFS_BUCKET"
    printf '+ select/download exactly one immutable version at %s for every ready DB reference\n' "$DATABASE_BOUNDARY"
    return
  fi
  require_cmd aws
  export_object_store_credentials
  local versioning
  versioning=$(aws --no-cli-pager --endpoint-url "$endpoint" s3api get-bucket-versioning \
    --bucket "$RUSTFS_BUCKET" --query Status --output text)
  [[ "$versioning" == "Enabled" ]] || die "object backup requires versioning Enabled on s3://$RUSTFS_BUCKET"
  mkdir -p "$OBJECTS_DIR"
  aws --endpoint-url "$endpoint" s3api list-object-versions \
    --bucket "$RUSTFS_BUCKET" --output json \
    >"$OBJECT_VERSIONS"
  node "$SCRIPT_DIR/object-snapshot.mjs" capture \
    "$OBJECT_REFS" "$OBJECT_VERSIONS" "$DATABASE_BOUNDARY" \
    "$RUSTFS_BUCKET" "$endpoint" "$OBJECTS_DIR"
}

write_manifest() {
  local encryption='"none"'
  if [[ "$ENCRYPT_AGE" == "true" ]]; then encryption='"age"'; fi
  if [[ "$ENCRYPT_KMS" == "true" ]]; then encryption='"kms"'; fi

  local pg_mode="logical-dump"

  cat >"$MANIFEST" <<EOF
{
  "backup_id": "$(json_escape "$BACKUP_ID")",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "tier": "$(json_escape "$TIER")",
  "schema_version": 3,
  "app_version": "$(json_escape "$APP_VERSION")",
  "postgres": {
    "service": "$(json_escape "$POSTGRES_SERVICE")",
    "database": "$(json_escape "$POSTGRES_DB")",
    "user": "$(json_escape "$POSTGRES_USER")",
    "mode": "$pg_mode",
    "logical_artifact": "postgres.dump",
    "physical_artifact": "postgres-basebackup/",
    "pitr_artifact_included": $([ "$PITR" == "true" ] && printf true || printf false),
    "format": "pg_dump custom",
    "physical_format": "pg_basebackup tar with WAL fetch",
    "end_lsn": "$(json_escape "$DATABASE_LSN")",
    "snapshot_boundary": "$(json_escape "$DATABASE_BOUNDARY")",
    "migrations": $MIGRATION_INVENTORY
  },
  "wal": {
    "included": $([ "$INCLUDE_WAL" == "true" ] && printf true || printf false),
    "pitr_capable": $([ "$PITR" == "true" ] && printf true || printf false),
    "artifact": "wal/",
    "archive_dir": "$(json_escape "$WAL_ARCHIVE_DIR")",
    "note": "Replay these segments after restoring the base backup to reach an arbitrary recovery_target_time."
  },
  "pitr_proof": {
    "enabled": $([ "$PITR_PROOF" == "true" ] && printf true || printf false),
    "target_time": "$(json_escape "$PITR_PROOF_TARGET")",
    "before_marker": "$(json_escape "$PITR_PROOF_BEFORE")",
    "after_marker": "$(json_escape "$PITR_PROOF_AFTER")"
  },
  "objects": {
    "included": $([ "$OBJECT_BACKUP" == "true" ] && printf true || printf false),
    "bucket": "$(json_escape "$RUSTFS_BUCKET")",
    "endpoint": "$(json_escape "$(object_store_endpoint)")",
    "artifact": "objects/",
    "inventory": "objects/inventory.json",
    "note": "Exactly one immutable version per ready reference at postgres.snapshot_boundary."
  },
  "encryption": {
    "method": $encryption,
    "kms_key_id": "$(json_escape "${KMS_KEY_ID}")"
  }
}
EOF

  node "$SCRIPT_DIR/backup-manifest.mjs" sign \
    "$STAGING_DIR" "$MANIFEST" "$SIGNING_PRIVATE_KEY"
}

archive_backup() {
  run_shell "$(printf 'COPYFILE_DISABLE=1 tar -C %q -czf %q %q' "$OUTPUT_DIR" "$ARCHIVE" "$BACKUP_ID")"

  if [[ "$DRY_RUN" == "0" ]]; then
    tar -tzf "$ARCHIVE" >/dev/null
    tar -tzf "$ARCHIVE" | grep -Fx "$BACKUP_ID/manifest.json" >/dev/null || die "archive missing manifest.json"
    tar -tzf "$ARCHIVE" | grep -Fx "$BACKUP_ID/manifest.sig" >/dev/null || die "archive missing manifest.sig"
    if [[ "$PITR" == "true" ]]; then
      tar -tzf "$ARCHIVE" | grep -F "$BACKUP_ID/postgres-basebackup/" >/dev/null || die "archive missing base backup"
    else
      tar -tzf "$ARCHIVE" | grep -Fx "$BACKUP_ID/postgres.dump" >/dev/null || die "archive missing postgres.dump"
    fi
  fi

  if [[ "$ENCRYPT_AGE" == "true" ]]; then
    local encrypted_archive="$ARCHIVE.age"
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '+ age <recipients> -o %q %q\n' "$encrypted_archive" "$ARCHIVE"
      printf '+ rm -rf %q %q\n' "$STAGING_DIR" "$ARCHIVE"
    else
      age "${AGE_ARGS[@]}" -o "$encrypted_archive" "$ARCHIVE"
      rm -rf "$STAGING_DIR" "$ARCHIVE"
      log "encrypted archive (age): $encrypted_archive"
    fi
  elif [[ "$ENCRYPT_KMS" == "true" ]]; then
    local encrypted_archive="$ARCHIVE.kms"
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '+ aws kms generate-data-key --key-id %q\n' "$KMS_KEY_ID"
      printf '+ aes-gcm-file.mjs encrypt %q %q <kms-data-key-via-stdin>\n' "$ARCHIVE" "$encrypted_archive"
      printf '+ write KMS-wrapped data key: %q\n' "$encrypted_archive.datakey"
      printf '+ rm -rf %q %q\n' "$STAGING_DIR" "$ARCHIVE"
    else
      kms_encrypt_file "$ARCHIVE" "$encrypted_archive" "$KMS_KEY_ID"
      rm -rf "$STAGING_DIR" "$ARCHIVE"
      log "encrypted archive (kms): $encrypted_archive (+ $encrypted_archive.datakey)"
    fi
  else
    log "archive: $ARCHIVE"
  fi
}

start_consistent_snapshot
dump_postgres_logical
capture_snapshot_metadata
require_object_coverage
finish_consistent_snapshot

if [[ "$DRY_RUN" == "1" ]]; then
  [[ "$PITR" == "true" ]] && backup_postgres_physical
  create_pitr_proof
  [[ "$INCLUDE_WAL" == "true" ]] && capture_wal
  [[ "$OBJECT_BACKUP" == "true" ]] && backup_objects
  printf '+ write signed SHA-256 manifest: %q %q\n' "$MANIFEST" "$MANIFEST_SIGNATURE"
else
  [[ "$PITR" == "true" ]] && backup_postgres_physical
  create_pitr_proof
  [[ "$INCLUDE_WAL" == "true" ]] && capture_wal
  [[ "$OBJECT_BACKUP" == "true" ]] && backup_objects
  write_manifest
fi

archive_backup
log "backup workflow complete"
