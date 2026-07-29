#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/validate-restore-drill.sh [options]

Validates backup, restore, and restore-drill shell contracts without starting Docker.

Options:
  --backup-dir <path>       Temporary dry-run backup directory. Default: mktemp
  --keep-work-dir           Keep the temporary directory for inspection
  -h, --help

Checks:
  - shell syntax for backup/restore scripts
  - personal dry-run backup command path
  - encrypted business dry-run backup command path (age)
  - PITR base-backup + WAL capture dry-run command path
  - KMS-encrypted enterprise dry-run backup command path
  - object-store sync dry-run command path
  - restore dry-run command path into a drill database
  - PITR / KMS restore dry-run command paths
  - restore-drill dry-run command path with application health probes
  - restore-drill prior-day backup selection
  - restore-drill optional reindex command path without leaking access tokens
  - live restore-drill smoke dry-run path without Docker execution
EOF
}

BACKUP_DIR=
KEEP_WORK_DIR=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir) BACKUP_DIR=${2:?missing backup dir}; shift 2 ;;
    --keep-work-dir) KEEP_WORK_DIR=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

ensure_repo_root
require_cmd bash
require_cmd tar
require_cmd grep
require_cmd mktemp

if [[ -z "$BACKUP_DIR" ]]; then
  BACKUP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-restore-validation.XXXXXX")
else
  mkdir -p "$BACKUP_DIR"
fi

cleanup() {
  if [[ "$KEEP_WORK_DIR" != "true" && -d "$BACKUP_DIR" ]]; then
    rm -rf "$BACKUP_DIR"
  fi
}
trap cleanup EXIT

assert_output_contains() {
  local output=$1
  local needle=$2
  local message=$3

  if ! grep -Fq -- "$needle" <<<"$output"; then
    printf '%s\n' "$output" >&2
    die "$message"
  fi
}

# Default in-container WAL archive directory captured by backup.sh.
WAL_ARCHIVE_PATTERN="/wal_archive"

log "checking shell syntax"
bash -n \
  infra/scripts/common.sh \
  infra/scripts/backup.sh \
  infra/scripts/restore.sh \
  infra/scripts/restore-drill.sh \
  infra/scripts/live-restore-drill-smoke.sh \
  infra/scripts/validate-restore-drill.sh
node --check infra/scripts/backup-manifest.mjs
node --check infra/scripts/restore-drill-evidence.mjs

log "checking personal backup dry-run"
personal_output=$("$SCRIPT_DIR/backup.sh" \
  --tier personal \
  --output-dir "$BACKUP_DIR" \
  --backup-id validation-personal \
  --dry-run)
assert_output_contains "$personal_output" "pg_dump --format=custom" "personal backup dry-run did not include pg_dump"
assert_output_contains "$personal_output" "tar -C" "personal backup dry-run did not include archive creation"
assert_output_contains "$personal_output" "consistency/database.tsv" "backup dry-run did not capture consistency metadata"
assert_output_contains "$personal_output" "checksummed recovery-set manifest" "backup dry-run did not build the v3 recovery set"
assert_output_contains "$personal_output" ".sha256" "backup dry-run did not publish an archive checksum sidecar"

log "checking encrypted business backup dry-run"
business_output=$("$SCRIPT_DIR/backup.sh" \
  --tier business \
  --output-dir "$BACKUP_DIR" \
  --backup-id validation-business \
  --age-recipient age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq \
  --include-wal \
  --dry-run)
assert_output_contains "$business_output" "age <recipients>" "business backup dry-run did not include age encryption"
assert_output_contains "$business_output" "tar -C $WAL_ARCHIVE_PATTERN" "business backup dry-run did not capture archived WAL"

log "checking PITR base-backup dry-run"
pitr_output=$("$SCRIPT_DIR/backup.sh" \
  --tier personal \
  --output-dir "$BACKUP_DIR" \
  --backup-id validation-pitr \
  --pitr \
  --dry-run)
assert_output_contains "$pitr_output" "pg_basebackup" "PITR backup dry-run did not include pg_basebackup"
assert_output_contains "$pitr_output" "tar -C $WAL_ARCHIVE_PATTERN" "PITR backup dry-run did not capture WAL segments"

log "checking KMS-encrypted enterprise backup dry-run"
kms_output=$("$SCRIPT_DIR/backup.sh" \
  --tier enterprise \
  --output-dir "$BACKUP_DIR" \
  --backup-id validation-kms \
  --kms-key-id alias/helix-backup \
  --dry-run)
assert_output_contains "$kms_output" "aws kms generate-data-key --key-id" "KMS backup dry-run did not call KMS generate-data-key"
assert_output_contains "$kms_output" "openssl enc -aes-256-cbc" "KMS backup dry-run did not envelope-encrypt the archive"
assert_output_contains "$kms_output" ".datakey" "KMS backup dry-run did not write the wrapped data key"

log "checking object-store sync dry-run"
object_output=$(HELIX_BACKUP_RUSTFS_BUCKET=helix-objects \
  "$SCRIPT_DIR/backup.sh" \
  --tier personal \
  --output-dir "$BACKUP_DIR" \
  --backup-id validation-objects \
  --object-backup \
  --dry-run)
assert_output_contains "$object_output" "s3 sync s3://helix-objects" "object backup dry-run did not sync the object bucket"
assert_output_contains "$object_output" "get-bucket-versioning" "object backup dry-run did not inspect bucket versioning"
assert_output_contains "$object_output" "list-object-versions" "object backup dry-run did not capture version identifiers"

log "checking restore dry-run"
restore_output=$("$SCRIPT_DIR/restore.sh" \
  --backup "$BACKUP_DIR/validation-personal.tar.gz" \
  --target-db helix_restore_validation \
  --allow-drop-target \
  --verify \
  --dry-run)
assert_output_contains "$restore_output" "createdb -U" "restore dry-run did not include target database creation"
assert_output_contains "$restore_output" "pg_restore --no-owner --no-acl --exit-on-error" "restore dry-run did not include pg_restore"
assert_output_contains "$restore_output" "public.actors" "restore dry-run did not include core table verification"
assert_output_contains "$restore_output" "backup-manifest.mjs verify" "restore dry-run did not verify the recovery-set manifest"
assert_output_contains "$restore_output" "audit.invalid_links" "restore dry-run did not verify the audit chain"
assert_output_contains "$restore_output" "outbound queue counts match" "restore dry-run did not verify outbound queues"

log "checking PITR restore dry-run"
pitr_restore_output=$("$SCRIPT_DIR/restore.sh" \
  --backup "$BACKUP_DIR/validation-pitr.tar.gz" \
  --pitr \
  --recovery-target-time "2026-05-21T00:00:00Z" \
  --dry-run)
assert_output_contains "$pitr_restore_output" "restore_command" "PITR restore dry-run did not configure restore_command"
assert_output_contains "$pitr_restore_output" "recovery_target_time = '2026-05-21T00:00:00Z'" "PITR restore dry-run did not set the recovery target"
assert_output_contains "$pitr_restore_output" "recovery.signal" "PITR restore dry-run did not create recovery.signal"

log "checking KMS restore dry-run"
kms_restore_output=$("$SCRIPT_DIR/restore.sh" \
  --backup "$BACKUP_DIR/validation-kms.tar.gz.kms" \
  --kms-datakey "$BACKUP_DIR/validation-kms.tar.gz.kms.datakey" \
  --target-db helix_restore_validation \
  --allow-drop-target \
  --dry-run 2>&1)
assert_output_contains "$kms_restore_output" "aws kms decrypt" "KMS restore dry-run did not call KMS decrypt"

log "checking restore-drill dry-run"
drill_output=$(HELIX_VERIFY_APP_URL=http://localhost:28431 \
  HELIX_RESTORE_DRILL_REINDEX=true \
  HELIX_ACCESS_TOKEN=validation-secret-token \
  "$SCRIPT_DIR/restore-drill.sh" \
  --backup "$BACKUP_DIR/validation-personal.tar.gz" \
  --target-db helix_restore_validation \
  --dry-run)
assert_output_contains "$drill_output" "pg_restore --no-owner --no-acl --exit-on-error" "restore-drill dry-run did not include pg_restore"
assert_output_contains "$drill_output" "/readyz" "restore-drill dry-run did not include readiness probe"
assert_output_contains "$drill_output" "/openapi.json" "restore-drill dry-run did not include OpenAPI probe"
assert_output_contains "$drill_output" "helix reindex --all" "restore-drill dry-run did not include search reindex"
assert_output_contains "$drill_output" "HELIX_ACCESS_TOKEN=<redacted>" "restore-drill dry-run did not redact reindex token"
if grep -Fq "validation-secret-token" <<<"$drill_output"; then
  printf '%s\n' "$drill_output" >&2
  die "restore-drill dry-run leaked the reindex access token"
fi

log "checking restore-drill prior-day backup selection"
# Materialize a fake archive dated to the prior UTC day so --prior-day picks it.
PRIOR_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-prior-day.XXXXXX")
prior_archive="$PRIOR_DIR/prior-day-backup.tar.gz"
: >"$prior_archive"
if touch -d "yesterday 12:00" "$prior_archive" 2>/dev/null \
   || touch -t "$(date -u -v-1d +%Y%m%d1200 2>/dev/null || date -u -d 'yesterday' +%Y%m%d1200)" "$prior_archive" 2>/dev/null; then
  prior_output=$("$SCRIPT_DIR/restore-drill.sh" \
    --backup-dir "$PRIOR_DIR" \
    --prior-day \
    --target-db helix_restore_validation \
    --dry-run 2>&1)
  assert_output_contains "$prior_output" "prior-day-backup.tar.gz" "restore-drill --prior-day did not select the prior day's backup"
  assert_output_contains "$prior_output" "selecting prior-day backup" "restore-drill --prior-day did not log prior-day selection"
else
  log "skipping prior-day check: could not set a prior-day mtime on this platform"
fi
rm -rf "$PRIOR_DIR"

log "checking live restore-drill smoke dry-run"
live_drill_output=$("$SCRIPT_DIR/live-restore-drill-smoke.sh" \
  --backup-dir "$BACKUP_DIR" \
  --backup-id validation-live-restore \
  --target-db helix_restore_validation_live \
  --verify-app-url http://localhost:28431 \
  --reindex \
  --dry-run)
assert_output_contains "$live_drill_output" "docker compose up -d postgres" "live restore-drill dry-run did not start Postgres"
assert_output_contains "$live_drill_output" "pnpm --filter @helix/app db:migrate" "live restore-drill dry-run did not include migrations"
assert_output_contains "$live_drill_output" "pnpm --filter @helix/app db:seed:oauth" "live restore-drill dry-run did not include OAuth seed"
assert_output_contains "$live_drill_output" "restore-drill.sh --create-backup" "live restore-drill dry-run did not invoke restore-drill"
assert_output_contains "$live_drill_output" "helix_restore_validation_live" "live restore-drill dry-run did not use target drill DB"
assert_output_contains "$live_drill_output" "public.actors" "live restore-drill dry-run did not include restored actor verification"

log "checking strict encrypted restore evidence dry-run"
strict_output=$(HELIX_BACKUP_RUSTFS_BUCKET=helix-objects "$SCRIPT_DIR/restore-drill.sh" \
  --backup "$BACKUP_DIR/validation-business.tar.gz.age" \
  --target-db helix_restore_validation_strict \
  --target-object-bucket helix-objects-restore-validation \
  --age-identity /secure/validation-age-identity \
  --reindex \
  --target-database-url postgres://helix:redacted@127.0.0.1:28432/helix_restore_validation_strict \
  --evidence-output "$BACKUP_DIR/restore-drill-evidence.json" \
  --dry-run 2>&1)
assert_output_contains "$strict_output" "backup-manifest.mjs verify" "strict drill did not require the v3 manifest"
assert_output_contains "$strict_output" "s3 sync" "strict drill did not restore object bytes"
assert_output_contains "$strict_output" "hash-compare" "strict drill did not hash-compare object samples"
assert_output_contains "$strict_output" "db:reindex:search" "strict drill did not rebuild search from restored data"
assert_output_contains "$strict_output" "measured RPO/RTO" "strict drill did not include evidence finalization"

static_evidence=$(node "$SCRIPT_DIR/restore-drill-evidence.mjs" --static)
assert_output_contains "$static_evidence" '"status": "static_validated"' "static evidence status was not truthful"
assert_output_contains "$static_evidence" '"status": "not_run"' "static evidence claimed live execution"

log "restore drill validation complete"
