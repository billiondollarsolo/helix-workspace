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
  --off-host-uri <s3://...>        Copy ciphertext + manifest/checksum sidecars off-host
  --retention-days <n>             Required retention contract for business+
  --key-custody-ref <ref>          Non-secret KMS/HSM/vault/keychain recovery reference
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
  HELIX_BACKUP_OFFHOST_URI         S3 destination for encrypted artifacts
  HELIX_BACKUP_RETENTION_DAYS      Required retention duration
  HELIX_BACKUP_KEY_CUSTODY_REF     Non-secret recovery-key custody reference
  HELIX_BACKUP_OFFHOST_PROFILE     Optional AWS profile for the off-host destination

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
OFFHOST_URI=${HELIX_BACKUP_OFFHOST_URI:-}
RETENTION_DAYS=${HELIX_BACKUP_RETENTION_DAYS:-0}
KEY_CUSTODY_REF=${HELIX_BACKUP_KEY_CUSTODY_REF:-}
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
    --off-host-uri) OFFHOST_URI=${2:?missing off-host URI}; shift 2 ;;
    --retention-days) RETENTION_DAYS=${2:?missing retention days}; shift 2 ;;
    --key-custody-ref) KEY_CUSTODY_REF=${2:?missing key custody reference}; shift 2 ;;
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
  require_cmd node
  require_cmd shasum
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

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "retention days must be a non-negative integer"
case "$OFFHOST_URI" in
  ""|s3://*) ;;
  *) die "off-host URI must use s3://" ;;
esac

# Tier policy: business+ must be encrypted; sovereign requires KMS/HSM-backed keys.
if [[ "$TIER" != "personal" && "$ENCRYPT_AGE" == "false" && "$ENCRYPT_KMS" == "false" && "$DRY_RUN" == "0" ]]; then
  die "$TIER backups must be encrypted; set AGE_RECIPIENTS/AGE_RECIPIENTS_FILE/--age-recipient or HELIX_BACKUP_KMS_KEY_ID/--kms-key-id"
fi
if [[ "$TIER" == "sovereign" && "$ENCRYPT_KMS" == "false" && "$DRY_RUN" == "0" ]]; then
  die "sovereign backups require KMS/HSM-backed encryption; set --kms-key-id"
fi
if [[ "$TIER" != "personal" && "$DRY_RUN" == "0" ]]; then
  MIN_RETENTION_DAYS=30
  [[ "$TIER" == "enterprise" ]] && MIN_RETENTION_DAYS=90
  [[ "$TIER" == "sovereign" ]] && MIN_RETENTION_DAYS=365
  [[ -n "$OFFHOST_URI" ]] || die "$TIER backups require --off-host-uri"
  (( RETENTION_DAYS >= MIN_RETENTION_DAYS )) \
    || die "$TIER backups require --retention-days >= $MIN_RETENTION_DAYS"
  [[ -n "$KEY_CUSTODY_REF" ]] || die "$TIER backups require --key-custody-ref (never put a private key in the backup)"
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
if [[ "$TIER" != "personal" && "$DRY_RUN" == "0" ]]; then
  bool_true "$OBJECT_BACKUP" || die "$TIER backups require --object-backup"
  [[ -n "$RUSTFS_BUCKET" ]] || die "$TIER backups require HELIX_BACKUP_RUSTFS_BUCKET"
fi

STAGING_DIR="$OUTPUT_DIR/$BACKUP_ID"
POSTGRES_DUMP="$STAGING_DIR/postgres.dump"
BASEBACKUP_DIR="$STAGING_DIR/postgres-basebackup"
WAL_DIR="$STAGING_DIR/wal"
OBJECTS_DIR="$STAGING_DIR/objects"
MANIFEST="$STAGING_DIR/manifest.json"
ARCHIVE="$OUTPUT_DIR/$BACKUP_ID.tar.gz"
FINAL_ARCHIVE="$ARCHIVE"
BACKUP_CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DATABASE_CAPTURED_AT=$BACKUP_CREATED_AT
OBJECTS_CAPTURED_AT=$BACKUP_CREATED_AT
OBJECT_VERSIONING=Unavailable
OBJECT_REPLICATION=not-applicable

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
  DATABASE_CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
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
  DATABASE_CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
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
    printf '+ aws --endpoint-url %q s3api get-bucket-versioning --bucket %q\n' \
      "$endpoint" "$RUSTFS_BUCKET"
    printf '+ aws --endpoint-url %q s3api list-object-versions --bucket %q\n' \
      "$endpoint" "$RUSTFS_BUCKET"
    return
  fi
  require_cmd aws
  export_object_store_credentials
  mkdir -p "$OBJECTS_DIR/$RUSTFS_BUCKET"
  aws --endpoint-url "$endpoint" s3 sync "s3://$RUSTFS_BUCKET" \
    "$OBJECTS_DIR/$RUSTFS_BUCKET" --delete
  aws --endpoint-url "$endpoint" s3api get-bucket-versioning \
    --bucket "$RUSTFS_BUCKET" --output json \
    >"$OBJECTS_DIR/$RUSTFS_BUCKET.versioning.json"
  OBJECT_VERSIONING=$(aws --endpoint-url "$endpoint" s3api get-bucket-versioning \
    --bucket "$RUSTFS_BUCKET" --query Status --output text 2>/dev/null || printf Unavailable)
  [[ "$OBJECT_VERSIONING" != "None" && -n "$OBJECT_VERSIONING" ]] || OBJECT_VERSIONING=Unavailable
  if aws --endpoint-url "$endpoint" s3api get-bucket-replication \
      --bucket "$RUSTFS_BUCKET" --output json \
      >"$OBJECTS_DIR/$RUSTFS_BUCKET.replication.json" 2>/dev/null; then
    OBJECT_REPLICATION=configured
  else
    OBJECT_REPLICATION=not-configured
    printf '{"status":"not-configured"}\n' >"$OBJECTS_DIR/$RUSTFS_BUCKET.replication.json"
  fi
  # Keep the version identifiers next to the byte snapshot so a drill can prove
  # that the database recovery point and object recovery point were linked.
  aws --endpoint-url "$endpoint" s3api list-object-versions \
    --bucket "$RUSTFS_BUCKET" --output json \
    >"$OBJECTS_DIR/$RUSTFS_BUCKET.versions.json"
  OBJECTS_CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
}

capture_database_consistency() {
  local output=$1 database=${2:-$POSTGRES_DB}
  local sql
  sql="select metric, value from (
    select 'activity.count'::text metric, count(*)::text value from public.activity
    union all select 'audit.invalid_links', count(*)::text from (
      select prev_hash, lag(this_hash) over (partition by org_id order by created_at, id) expected
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
    printf '+ mkdir -p %q\n' "$(dirname "$output")"
    printf '+ %s exec -T %q psql -At -F <tab> -U %q -d %q > %q # database/object/outbound/audit consistency snapshot\n' \
      "$(compose)" "$POSTGRES_SERVICE" "$POSTGRES_USER" "$database" "$output"
    return
  fi
  mkdir -p "$(dirname "$output")"
  bash -c "$(printf '%s exec -T %q psql -At -F %q -v ON_ERROR_STOP=1 -U %q -d %q -c %q > %q' \
    "$(compose)" "$POSTGRES_SERVICE" $'\t' "$POSTGRES_USER" "$database" "$sql" "$output")"
}

write_manifest() {
  local encryption=none
  if [[ "$ENCRYPT_AGE" == "true" ]]; then encryption=age; fi
  if [[ "$ENCRYPT_KMS" == "true" ]]; then encryption=kms; fi
  local pg_mode="logical-dump"
  [[ "$PITR" == "true" ]] && pg_mode="physical-basebackup"

  node "$SCRIPT_DIR/backup-manifest.mjs" create \
    --root "$STAGING_DIR" \
    --backup-id "$BACKUP_ID" \
    --tier "$TIER" \
    --created-at "$BACKUP_CREATED_AT" \
    --database-captured-at "$DATABASE_CAPTURED_AT" \
    --objects-captured-at "$OBJECTS_CAPTURED_AT" \
    --database-mode "$pg_mode" \
    --objects-included "$OBJECT_BACKUP" \
    --object-bucket "$RUSTFS_BUCKET" \
    --object-versioning "$OBJECT_VERSIONING" \
    --object-replication "$OBJECT_REPLICATION" \
    --encryption "$encryption" \
    --key-custody-ref "$KEY_CUSTODY_REF" \
    --off-host-uri "$OFFHOST_URI" \
    --retention-days "$RETENTION_DAYS" >/dev/null
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
    FINAL_ARCHIVE="$encrypted_archive"
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '+ age <recipients> -o %q %q\n' "$encrypted_archive" "$ARCHIVE"
      printf '+ rm -rf %q %q\n' "$STAGING_DIR" "$ARCHIVE"
    else
      age "${AGE_ARGS[@]}" -o "$encrypted_archive" "$ARCHIVE"
      cp "$MANIFEST" "$encrypted_archive.manifest.json"
      rm -rf "$STAGING_DIR" "$ARCHIVE"
      log "encrypted archive (age): $encrypted_archive"
    fi
  elif [[ "$ENCRYPT_KMS" == "true" ]]; then
    local encrypted_archive="$ARCHIVE.kms"
    FINAL_ARCHIVE="$encrypted_archive"
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '+ aws kms generate-data-key --key-id %q\n' "$KMS_KEY_ID"
      printf '+ openssl enc -aes-256-cbc -pbkdf2 -in %q -out %q\n' "$ARCHIVE" "$encrypted_archive"
      printf '+ write KMS-wrapped data key: %q\n' "$encrypted_archive.datakey"
      printf '+ rm -rf %q %q\n' "$STAGING_DIR" "$ARCHIVE"
    else
      kms_encrypt_file "$ARCHIVE" "$encrypted_archive" "$KMS_KEY_ID"
      cp "$MANIFEST" "$encrypted_archive.manifest.json"
      rm -rf "$STAGING_DIR" "$ARCHIVE"
      log "encrypted archive (kms): $encrypted_archive (+ $encrypted_archive.datakey)"
    fi
  else
    log "archive: $ARCHIVE"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ write manifest sidecar: %q\n' "$FINAL_ARCHIVE.manifest.json"
    printf '+ write sha256 sidecar: %q\n' "$FINAL_ARCHIVE.sha256"
  else
    # The embedded manifest is authoritative. The external copy permits
    # recovery-point selection without decrypting every candidate archive.
    # Restore compares it byte-for-byte with the embedded copy.
    if [[ -f "$FINAL_ARCHIVE.manifest.json" ]]; then
      :
    elif [[ -d "$STAGING_DIR" ]]; then
      cp "$MANIFEST" "$FINAL_ARCHIVE.manifest.json"
    else
      tar -xOf "$FINAL_ARCHIVE" "$BACKUP_ID/manifest.json" >"$FINAL_ARCHIVE.manifest.json"
    fi
    (
      cd "$(dirname "$FINAL_ARCHIVE")"
      shasum -a 256 "$(basename "$FINAL_ARCHIVE")"
    ) >"$FINAL_ARCHIVE.sha256"
  fi
}

validate_offhost_contract() {
  [[ -n "$OFFHOST_URI" ]] || return 0
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ aws s3api get-bucket-versioning/get-bucket-replication/get-bucket-lifecycle-configuration # %s-day contract\n' "$RETENTION_DAYS"
    return
  fi
  local destination=${OFFHOST_URI#s3://}
  local bucket=${destination%%/*}
  local profile_args=()
  [[ -n "${HELIX_BACKUP_OFFHOST_PROFILE:-}" ]] && profile_args=(--profile "$HELIX_BACKUP_OFFHOST_PROFILE")
  local status lifecycle_days day retention_ok=false
  status=$(aws "${profile_args[@]}" s3api get-bucket-versioning --bucket "$bucket" --query Status --output text)
  [[ "$status" == "Enabled" ]] || die "off-host bucket versioning is not Enabled: $bucket"
  aws "${profile_args[@]}" s3api get-bucket-replication --bucket "$bucket" >/dev/null \
    || die "off-host bucket replication is not configured: $bucket"
  if [[ "$TIER" == "sovereign" ]]; then
    local object_lock
    object_lock=$(aws "${profile_args[@]}" s3api get-object-lock-configuration \
      --bucket "$bucket" --query ObjectLockConfiguration.ObjectLockEnabled --output text)
    [[ "$object_lock" == "Enabled" ]] || die "sovereign off-host bucket must enable S3 Object Lock"
  fi
  # shellcheck disable=SC2016 # JMESPath backticks are literals, not shell expansion.
  lifecycle_days=$(aws "${profile_args[@]}" s3api get-bucket-lifecycle-configuration \
    --bucket "$bucket" --query 'Rules[?Status==`Enabled`].Expiration.Days' --output text)
  for day in $lifecycle_days; do
    if [[ "$day" =~ ^[0-9]+$ ]] && (( day >= RETENTION_DAYS )); then retention_ok=true; fi
  done
  bool_true "$retention_ok" || die "off-host bucket has no enabled lifecycle retention >= ${RETENTION_DAYS} days"
}

copy_offhost() {
  [[ -n "$OFFHOST_URI" ]] || return 0
  local profile_args=()
  [[ -n "${HELIX_BACKUP_OFFHOST_PROFILE:-}" ]] && profile_args=(--profile "$HELIX_BACKUP_OFFHOST_PROFILE")
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ aws s3 cp %q %q\n' "$FINAL_ARCHIVE" "$OFFHOST_URI/"
    printf '+ aws s3 cp %q %q\n' "$FINAL_ARCHIVE.manifest.json" "$OFFHOST_URI/"
    printf '+ aws s3 cp %q %q\n' "$FINAL_ARCHIVE.sha256" "$OFFHOST_URI/"
    return
  fi
  aws "${profile_args[@]}" s3 cp "$FINAL_ARCHIVE" "$OFFHOST_URI/"
  aws "${profile_args[@]}" s3 cp "$FINAL_ARCHIVE.manifest.json" "$OFFHOST_URI/"
  aws "${profile_args[@]}" s3 cp "$FINAL_ARCHIVE.sha256" "$OFFHOST_URI/"
  if [[ "$FINAL_ARCHIVE" == *.kms ]]; then
    aws "${profile_args[@]}" s3 cp "$FINAL_ARCHIVE.datakey" "$OFFHOST_URI/"
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
  if [[ "$PITR" == "true" ]]; then
    backup_postgres_physical
  fi
  [[ "$INCLUDE_WAL" == "true" ]] && capture_wal
  [[ "$OBJECT_BACKUP" == "true" ]] && backup_objects
fi

if [[ "$PITR" != "true" ]]; then
  dump_postgres_logical
fi

if [[ "$DRY_RUN" == "1" ]]; then
  capture_database_consistency "$STAGING_DIR/consistency/database.tsv"
  printf '+ node %q create --root %q # checksummed recovery-set manifest\n' \
    "$SCRIPT_DIR/backup-manifest.mjs" "$STAGING_DIR"
else
  capture_database_consistency "$STAGING_DIR/consistency/database.tsv"
  [[ "$OBJECT_BACKUP" == "true" ]] || OBJECTS_CAPTURED_AT=$DATABASE_CAPTURED_AT
  write_manifest
  node "$SCRIPT_DIR/backup-manifest.mjs" verify --root "$STAGING_DIR" >/dev/null
fi

validate_offhost_contract
archive_backup
copy_offhost
log "backup workflow complete"
