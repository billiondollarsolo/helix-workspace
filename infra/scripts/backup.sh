#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/backup.sh [options]

Creates Helix backup artifacts. Dry-run is the default; pass --execute to run.

Postgres is captured one of two ways:
  - logical dump (pg_dump custom format) -- portable, Tier 1/2 default.
  - physical base backup (pg_basebackup) + archived WAL -- enables
    point-in-time recovery (PITR). Pass --pitr (Tier 2+ recommended).

Options:
  --tier <personal|business|enterprise|sovereign>
  --output-dir <path>              Default: ./backups
  --backup-id <id>                 Default: UTC timestamp
  --execute                        Run the backup and write artifacts
  --dry-run                        Print commands only
  --pitr                           Take a physical base backup + WAL for PITR
  --include-wal                    Capture archived WAL segments alongside the dump
  --object-backup                  Sync the RustFS/S3 object bucket into the archive
  --skip-object-backup             Skip object-store backup entirely
  --age-recipient <recipient>      Encrypt archive with an age recipient
  --age-recipients-file <path>     Encrypt archive with an age recipient file
  --kms-key-id <id>                Encrypt archive with a cloud KMS data key (Tier 3)
  -h, --help

Environment:
  POSTGRES_DB, POSTGRES_USER, POSTGRES_SERVICE, POSTGRES_PASSWORD
  HELIX_BACKUP_DIR                 Default output directory
  HELIX_BACKUP_PITR=true           Default --pitr on
  HELIX_BACKUP_INCLUDE_WAL=true    Default --include-wal on
  HELIX_BACKUP_RUSTFS_BUCKET=<b>   Object bucket to back up
  RUSTFS_ENDPOINT / RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY
  HELIX_WAL_ARCHIVE_DIR            Host path that receives archived WAL
                                   (Postgres archive_command target). Default:
                                   /var/lib/postgresql/wal_archive inside the
                                   postgres container.
  AGE_RECIPIENTS / AGE_RECIPIENTS_FILE
  HELIX_BACKUP_KMS_KEY_ID          Cloud KMS key id/alias/ARN (Tier 3)
  HELIX_KMS_ENDPOINT               Optional KMS endpoint override (LocalStack etc.)

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
INCLUDE_WAL=${HELIX_BACKUP_INCLUDE_WAL:-false}
OBJECT_BACKUP=auto
POSTGRES_SERVICE=${POSTGRES_SERVICE:-postgres}
POSTGRES_DB=${POSTGRES_DB:-helix}
POSTGRES_USER=${POSTGRES_USER:-helix}
WAL_ARCHIVE_DIR=${HELIX_WAL_ARCHIVE_DIR:-/wal_archive}
RUSTFS_BUCKET=${HELIX_BACKUP_RUSTFS_BUCKET:-}
KMS_KEY_ID=${HELIX_BACKUP_KMS_KEY_ID:-}
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

ensure_repo_root
if [[ "$DRY_RUN" == "0" ]]; then
  require_cmd docker
fi
require_cmd tar

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
  require_cmd openssl
  require_cmd python3
fi

# Object backup defaults to on whenever a bucket is configured.
if [[ "$OBJECT_BACKUP" == "auto" ]]; then
  if [[ -n "$RUSTFS_BUCKET" ]]; then OBJECT_BACKUP=true; else OBJECT_BACKUP=false; fi
fi

STAGING_DIR="$OUTPUT_DIR/$BACKUP_ID"
POSTGRES_DUMP="$STAGING_DIR/postgres.dump"
BASEBACKUP_DIR="$STAGING_DIR/postgres-basebackup"
WAL_DIR="$STAGING_DIR/wal"
OBJECTS_DIR="$STAGING_DIR/objects"
MANIFEST="$STAGING_DIR/manifest.json"
ARCHIVE="$OUTPUT_DIR/$BACKUP_ID.tar.gz"

log "backup id: $BACKUP_ID"
log "tier: $TIER"
log "pitr: $PITR  include-wal: $INCLUDE_WAL  object-backup: $OBJECT_BACKUP"
log "dry run: $DRY_RUN"

if [[ "$DRY_RUN" == "1" ]]; then
  printf '+ mkdir -p %q\n' "$STAGING_DIR"
else
  mkdir -p "$STAGING_DIR"
fi

compose() {
  # shellcheck disable=SC2086
  printf 'docker compose %s' "${HELIX_COMPOSE_ARGS:-}"
}

# --- Postgres logical dump ---------------------------------------------------
dump_postgres_logical() {
  local cmd
  cmd=$(printf '%s exec -T %q pg_dump --format=custom --no-owner --no-acl --verbose -U %q -d %q > %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" "$POSTGRES_DUMP")
  run_shell "$cmd"
}

# --- Postgres physical base backup for PITR ----------------------------------
# pg_basebackup produces a self-consistent cluster snapshot; combined with the
# archived WAL it allows replay to any point after the backup start LSN.
backup_postgres_physical() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ mkdir -p %q\n' "$BASEBACKUP_DIR"
    printf '+ %s exec -T -e PGPASSWORD=<redacted> %q pg_basebackup -U %q -D - -Ft -z -Xs -P -l %q | tar -C %q -xzf -\n' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "helix-pitr-$BACKUP_ID" "$BASEBACKUP_DIR"
    return
  fi
  mkdir -p "$BASEBACKUP_DIR"
  # Stream the base backup as a gzipped tar over the exec channel and unpack
  # locally so the archive is host-side and self-contained.
  bash -c "$(printf '%s exec -T -e PGPASSWORD=%q %q pg_basebackup -U %q -D - -Ft -z -Xs -c fast -l %q | tar -C %q -xzf -' \
    "$(compose)" "${POSTGRES_PASSWORD:-helix_dev_password}" "$POSTGRES_SERVICE" "$POSTGRES_USER" \
    "helix-pitr-$BACKUP_ID" "$BASEBACKUP_DIR")"
  # Record the backup label / start LSN for the manifest and restore tooling.
  bash -c "$(printf '%s exec -T %q psql -U %q -d %q -t -A -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "select pg_current_wal_lsn();")" >"$BASEBACKUP_DIR/BACKUP_END_LSN" 2>/dev/null || true
}

# --- WAL segment capture -----------------------------------------------------
# Copies the archived WAL segments (written by Postgres archive_command) so the
# restore side can replay them. WAL_ARCHIVE_DIR is the in-container archive path.
capture_wal() {
  local cmd
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ mkdir -p %q\n' "$WAL_DIR"
    printf '+ docker compose exec -T %s psql -c "select pg_switch_wal()"\n' "$POSTGRES_SERVICE"
    printf '+ docker compose exec -T %s sh -c '\''tar -C %s -cf - .'\'' | tar -C %s -xf -\n' \
      "$POSTGRES_SERVICE" "$WAL_ARCHIVE_DIR" "$WAL_DIR"
    return
  fi
  mkdir -p "$WAL_DIR"
  # Ask Postgres to flush a fresh WAL segment so the archive is current, then
  # copy whatever archive_command has shipped to WAL_ARCHIVE_DIR.
  bash -c "$(printf '%s exec -T %q psql -U %q -d %q -c %q' \
    "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$POSTGRES_DB" \
    "select pg_switch_wal();")" >/dev/null 2>&1 || \
    log "warning: pg_switch_wal failed; continuing with WAL already on disk"
  if bash -c "$(printf '%s exec -T %q sh -c %q' "$(compose)" "$POSTGRES_SERVICE" \
      "test -d $WAL_ARCHIVE_DIR")"; then
    bash -c "$(printf '%s exec -T %q sh -c %q | tar -C %q -xf -' \
      "$(compose)" "$POSTGRES_SERVICE" "tar -C $WAL_ARCHIVE_DIR -cf - ." "$WAL_DIR")"
  else
    log "warning: WAL archive dir $WAL_ARCHIVE_DIR not present in the postgres container."
    log "         configure archive_command (see backup.sh --help) for real PITR coverage."
    cat >"$WAL_DIR/.archive-not-configured" <<EOF
WAL archive directory $WAL_ARCHIVE_DIR was not found inside the postgres
container at backup time. Continuous WAL archiving is an operator one-time
setup; see infra/scripts/backup.sh --help and docs/backup-restore.md.
EOF
  fi
}

# --- RustFS / S3 object-store backup -----------------------------------------
# Real object backup: `aws s3 sync` mirrors every object byte-for-byte into the
# archive. This is not metadata -- the restore path re-syncs it back.
backup_objects() {
  local endpoint
  endpoint=$(object_store_endpoint)
  if [[ -z "$RUSTFS_BUCKET" ]]; then
    log "object-backup requested but HELIX_BACKUP_RUSTFS_BUCKET is unset; skipping"
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ mkdir -p %q\n' "$OBJECTS_DIR"
    printf '+ aws --endpoint-url %q s3 sync s3://%s %q --delete\n' \
      "$endpoint" "$RUSTFS_BUCKET" "$OBJECTS_DIR/$RUSTFS_BUCKET"
    return
  fi
  require_cmd aws
  export_object_store_credentials
  mkdir -p "$OBJECTS_DIR/$RUSTFS_BUCKET"
  aws --endpoint-url "$endpoint" s3 sync "s3://$RUSTFS_BUCKET" \
    "$OBJECTS_DIR/$RUSTFS_BUCKET" --delete
  # Capture object versions so the restore side can audit completeness.
  aws --endpoint-url "$endpoint" s3api list-objects-v2 \
    --bucket "$RUSTFS_BUCKET" --output json \
    >"$OBJECTS_DIR/$RUSTFS_BUCKET.inventory.json" 2>/dev/null || true
}

write_manifest() {
  local encryption='"none"'
  if [[ "$ENCRYPT_AGE" == "true" ]]; then encryption='"age"'; fi
  if [[ "$ENCRYPT_KMS" == "true" ]]; then encryption='"kms"'; fi

  local pg_mode="logical-dump"
  [[ "$PITR" == "true" ]] && pg_mode="physical-basebackup"

  cat >"$MANIFEST" <<EOF
{
  "backup_id": "$(json_escape "$BACKUP_ID")",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "tier": "$(json_escape "$TIER")",
  "schema_version": 2,
  "postgres": {
    "service": "$(json_escape "$POSTGRES_SERVICE")",
    "database": "$(json_escape "$POSTGRES_DB")",
    "user": "$(json_escape "$POSTGRES_USER")",
    "mode": "$pg_mode",
    "logical_artifact": "postgres.dump",
    "physical_artifact": "postgres-basebackup/",
    "format": "$([ "$PITR" == "true" ] && printf 'pg_basebackup tar' || printf 'pg_dump custom')"
  },
  "wal": {
    "included": $([ "$INCLUDE_WAL" == "true" ] && printf true || printf false),
    "pitr_capable": $([ "$PITR" == "true" ] && printf true || printf false),
    "artifact": "wal/",
    "archive_dir": "$(json_escape "$WAL_ARCHIVE_DIR")",
    "note": "Replay these segments after restoring the base backup to reach an arbitrary recovery_target_time."
  },
  "objects": {
    "included": $([ "$OBJECT_BACKUP" == "true" ] && printf true || printf false),
    "bucket": "$(json_escape "$RUSTFS_BUCKET")",
    "endpoint": "$(json_escape "$(object_store_endpoint)")",
    "artifact": "objects/",
    "note": "Full byte-for-byte object copy synced with 'aws s3 sync'; restore re-syncs it back."
  },
  "encryption": {
    "method": $encryption,
    "kms_key_id": "$(json_escape "${KMS_KEY_ID}")"
  }
}
EOF
}

archive_backup() {
  run_shell "$(printf 'tar -C %q -czf %q %q' "$OUTPUT_DIR" "$ARCHIVE" "$BACKUP_ID")"

  if [[ "$DRY_RUN" == "0" ]]; then
    tar -tzf "$ARCHIVE" >/dev/null
    tar -tzf "$ARCHIVE" | grep -Fx "$BACKUP_ID/manifest.json" >/dev/null || die "archive missing manifest.json"
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
      printf '+ openssl enc -aes-256-cbc -pbkdf2 -in %q -out %q\n' "$ARCHIVE" "$encrypted_archive"
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

if [[ "$DRY_RUN" == "1" ]]; then
  printf '+ write manifest: %q\n' "$MANIFEST"
  if [[ "$PITR" == "true" ]]; then
    backup_postgres_physical
  else
    printf '+ write postgres dump: %q\n' "$POSTGRES_DUMP"
  fi
  [[ "$INCLUDE_WAL" == "true" ]] && capture_wal
  [[ "$OBJECT_BACKUP" == "true" ]] && backup_objects
else
  write_manifest
  if [[ "$PITR" == "true" ]]; then
    backup_postgres_physical
  fi
  [[ "$INCLUDE_WAL" == "true" ]] && capture_wal
  [[ "$OBJECT_BACKUP" == "true" ]] && backup_objects
fi

if [[ "$PITR" != "true" ]]; then
  dump_postgres_logical
fi

archive_backup
log "backup workflow complete"
