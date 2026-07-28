#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/restore-drill.sh [options]

Runs a restore drill against a clean drill database. Dry-run is the default.

By default the drill restores the most recent existing backup -- a real drill
exercises a pre-existing artifact, not one created moments earlier. The nightly
CI drill uses --prior-day to restore the previous calendar day's backup.

Options:
  --backup <path>             Existing backup directory, .tar.gz, .tar.gz.age, .tar.gz.kms
  --backup-dir <path>         Directory to search for backups. Default: ./backups
  --backup-id <id>            Backup id for --create-backup. Default: restore-drill-<UTC timestamp>
  --create-backup             Create a fresh Tier 1 backup before restoring
  --prior-day                 Restore the most recent backup from the prior UTC day
  --max-age-hours <n>         Fail if the selected backup is older than n hours
  --target-db <name>          Default: helix_restore_drill
  --target-object-bucket <n>  Isolated object bucket for strict restore
  --strict                    Require v3 manifest, objects, encryption evidence inputs
  --evidence-output <path>    Write strict machine-readable live drill evidence
  --execute                   Run the drill
  --dry-run                   Print commands only
  --age-identity <path>       age identity file for .age archives
  --kms-datakey <path>        KMS-wrapped data key for .kms archives
  --reindex                   Run helix reindex --all after restore/app probes
  --skip-reindex              Do not run search reindex even if env enables it
  --reindex-base-url <url>    HELIX_BASE_URL for reindex
  --target-database-url <url> Restored DB URL used by strict local reindex
  -h, --help

Critical-path checks:
  - pg_restore exits cleanly into the drill database (logical mode)
  - PITR base-backup + WAL recovery directory is materialized (pitr mode)
  - public schema exists and expected core tables are addressable
  - optional HELIX_VERIFY_APP_URL /readyz and /openapi.json checks
  - optional authenticated helix reindex --all for derived Meilisearch rebuild
EOF
}

BACKUP_PATH=${HELIX_RESTORE_DRILL_BACKUP:-}
BACKUP_DIR=${HELIX_BACKUP_DIR:-./backups}
BACKUP_ID=${HELIX_RESTORE_DRILL_BACKUP_ID:-}
TARGET_DB=${HELIX_RESTORE_TARGET_DB:-helix_restore_drill}
CREATE_BACKUP=false
PRIOR_DAY=${HELIX_RESTORE_DRILL_PRIOR_DAY:-false}
MAX_AGE_HOURS=${HELIX_RESTORE_DRILL_MAX_AGE_HOURS:-}
DRY_RUN=1
AGE_IDENTITY=${AGE_IDENTITY_FILE:-}
KMS_DATAKEY=${HELIX_BACKUP_KMS_DATAKEY:-}
REINDEX=${HELIX_RESTORE_DRILL_REINDEX:-false}
REINDEX_BASE_URL=${HELIX_REINDEX_BASE_URL:-${HELIX_VERIFY_APP_URL:-${HELIX_BASE_URL:-}}}
REINDEX_COMMAND=${HELIX_REINDEX_COMMAND:-helix reindex --all}
REINDEX_ACCESS_TOKEN=${HELIX_REINDEX_ACCESS_TOKEN:-${HELIX_ACCESS_TOKEN:-}}
TARGET_DATABASE_URL=${HELIX_RESTORE_DRILL_TARGET_DATABASE_URL:-}
TARGET_OBJECT_BUCKET=${HELIX_RESTORE_TARGET_OBJECT_BUCKET:-}
STRICT=${HELIX_RESTORE_DRILL_STRICT:-false}
EVIDENCE_OUTPUT=${HELIX_RESTORE_DRILL_EVIDENCE_OUTPUT:-}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) BACKUP_PATH=${2:?missing backup path}; shift 2 ;;
    --backup-dir) BACKUP_DIR=${2:?missing backup dir}; shift 2 ;;
    --backup-id) BACKUP_ID=${2:?missing backup id}; shift 2 ;;
    --create-backup) CREATE_BACKUP=true; shift ;;
    --prior-day) PRIOR_DAY=true; shift ;;
    --max-age-hours) MAX_AGE_HOURS=${2:?missing max age hours}; shift 2 ;;
    --target-db) TARGET_DB=${2:?missing target db}; shift 2 ;;
    --target-object-bucket) TARGET_OBJECT_BUCKET=${2:?missing target object bucket}; shift 2 ;;
    --strict) STRICT=true; shift ;;
    --evidence-output) EVIDENCE_OUTPUT=${2:?missing evidence output}; STRICT=true; shift 2 ;;
    --execute) DRY_RUN=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --age-identity) AGE_IDENTITY=${2:?missing age identity}; shift 2 ;;
    --kms-datakey) KMS_DATAKEY=${2:?missing kms datakey}; shift 2 ;;
    --reindex) REINDEX=true; shift ;;
    --skip-reindex) REINDEX=false; shift ;;
    --reindex-base-url) REINDEX_BASE_URL=${2:?missing reindex base url}; shift 2 ;;
    --target-database-url) TARGET_DATABASE_URL=${2:?missing target database URL}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

ensure_repo_root
if [[ -n "$EVIDENCE_OUTPUT" && "$DRY_RUN" == "0" ]]; then
  require_cmd node
fi

list_backups() {
  [[ -d "$BACKUP_DIR" ]] || return 1
  find "$BACKUP_DIR" -maxdepth 1 \
    \( -name '*.tar.gz' -o -name '*.tar.gz.age' -o -name '*.tar.gz.kms' -o -type d \) \
    ! -name "$(basename "$BACKUP_DIR")" -print | sort
}

find_latest_backup() {
  list_backups | tail -n 1
}

# Select the newest backup whose mtime falls on the prior UTC calendar day.
# This is what the nightly CI drill exercises: yesterday's real artifact.
find_prior_day_backup() {
  [[ -d "$BACKUP_DIR" ]] || return 1
  local start_epoch end_epoch
  # Start of today (UTC), then bracket the prior 24h window.
  local today_date
  today_date=$(date -u +%Y-%m-%d)
  if date -u -d "$today_date" +%s >/dev/null 2>&1; then
    start_epoch=$(date -u -d "$today_date 00:00:00" +%s)        # GNU date
  else
    start_epoch=$(date -u -j -f "%Y-%m-%d %H:%M:%S" "$today_date 00:00:00" +%s)  # BSD date
  fi
  end_epoch=$start_epoch
  start_epoch=$((start_epoch - 86400))

  local newest="" newest_mtime=0 entry mtime
  while IFS= read -r entry; do
    [[ -e "$entry" ]] || continue
    if mtime=$(stat -c %Y "$entry" 2>/dev/null); then :; else
      mtime=$(stat -f %m "$entry" 2>/dev/null) || continue
    fi
    if (( mtime >= start_epoch && mtime < end_epoch && mtime > newest_mtime )); then
      newest=$entry
      newest_mtime=$mtime
    fi
  done < <(list_backups)
  [[ -n "$newest" ]] && printf '%s\n' "$newest"
}

assert_backup_fresh() {
  local path=$1
  [[ -n "$MAX_AGE_HOURS" ]] || return 0
  [[ -e "$path" ]] || return 0
  local mtime now age_hours
  if mtime=$(stat -c %Y "$path" 2>/dev/null); then :; else
    mtime=$(stat -f %m "$path" 2>/dev/null) || return 0
  fi
  now=$(date -u +%s)
  age_hours=$(( (now - mtime) / 3600 ))
  if (( age_hours > MAX_AGE_HOURS )); then
    die "selected backup is ${age_hours}h old, exceeds --max-age-hours ${MAX_AGE_HOURS}: $path"
  fi
  log "selected backup age: ${age_hours}h (limit ${MAX_AGE_HOURS}h)"
}

if bool_true "$CREATE_BACKUP"; then
  backup_id=${BACKUP_ID:-restore-drill-$(date -u +%Y%m%dT%H%M%SZ)}
  backup_args=(--tier personal --output-dir "$BACKUP_DIR" --backup-id "$backup_id")
  [[ "$DRY_RUN" == "0" ]] && backup_args+=(--execute) || backup_args+=(--dry-run)
  "$SCRIPT_DIR/backup.sh" "${backup_args[@]}"
  BACKUP_PATH="$BACKUP_DIR/$backup_id.tar.gz"
elif [[ -z "$BACKUP_PATH" ]]; then
  if bool_true "$PRIOR_DAY"; then
    log "selecting prior-day backup from $BACKUP_DIR"
    BACKUP_PATH=$(find_prior_day_backup || true)
    if [[ -z "$BACKUP_PATH" ]]; then
      die "no backup found for the prior UTC day in $BACKUP_DIR; nightly backup may have failed"
    fi
  else
    BACKUP_PATH=$(find_latest_backup || true)
  fi
fi

[[ -n "$BACKUP_PATH" ]] || die "no backup found; pass --backup, --create-backup, or --prior-day"
log "drill backup: $BACKUP_PATH"
assert_backup_fresh "$BACKUP_PATH"

[[ -n "$TARGET_OBJECT_BUCKET" ]] || TARGET_OBJECT_BUCKET="${TARGET_DB//_/-}-objects"
DRILL_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
VERIFICATION_OUTPUT=
if bool_true "$STRICT"; then
  if [[ "$DRY_RUN" == "0" ]]; then
    VERIFICATION_OUTPUT=$(mktemp "${TMPDIR:-/tmp}/helix-restore-observations.XXXXXX")
  else
    VERIFICATION_OUTPUT="${TMPDIR:-/tmp}/helix-restore-observations.<dry-run>"
  fi
fi
cleanup_observations() {
  if [[ -n "$VERIFICATION_OUTPUT" && -f "$VERIFICATION_OUTPUT" ]]; then
    rm -f "$VERIFICATION_OUTPUT"
  fi
}
trap cleanup_observations EXIT

restore_args=(--backup "$BACKUP_PATH" --target-db "$TARGET_DB" --allow-drop-target --verify)
[[ "$DRY_RUN" == "0" ]] && restore_args+=(--execute) || restore_args+=(--dry-run)
[[ -n "$AGE_IDENTITY" ]] && restore_args+=(--age-identity "$AGE_IDENTITY")
[[ -n "$KMS_DATAKEY" ]] && restore_args+=(--kms-datakey "$KMS_DATAKEY")
if bool_true "$STRICT"; then
  restore_args+=(
    --require-manifest-v3
    --restore-objects
    --target-object-bucket "$TARGET_OBJECT_BUCKET"
    --verification-output "$VERIFICATION_OUTPUT"
  )
fi

"$SCRIPT_DIR/restore.sh" "${restore_args[@]}"

if [[ -n "${HELIX_VERIFY_APP_URL:-}" ]]; then
  require_cmd curl
  run_shell "$(printf 'curl -fsS %q >/dev/null' "${HELIX_VERIFY_APP_URL%/}/readyz")"
  run_shell "$(printf 'curl -fsS %q >/dev/null' "${HELIX_VERIFY_APP_URL%/}/openapi.json")"
fi

run_reindex() {
  bool_true "$REINDEX" || return 0
  if bool_true "$STRICT"; then
    [[ -n "$TARGET_DATABASE_URL" ]] || die "strict reindex requires --target-database-url"
    case "${TARGET_DATABASE_URL%%\?*}" in
      */"$TARGET_DB") ;;
      *) die "strict reindex database URL must target restored database '$TARGET_DB'" ;;
    esac
    if [[ "$DRY_RUN" == "1" ]]; then
      printf '+ DATABASE_URL=<redacted> pnpm --filter @helix/app db:reindex:search -- --all\n'
    else
      require_cmd pnpm
      DATABASE_URL="$TARGET_DATABASE_URL" pnpm --filter @helix/app db:reindex:search -- --all
    fi
    return
  fi
  [[ -n "$REINDEX_BASE_URL" ]] || die "reindex requires --reindex-base-url, HELIX_REINDEX_BASE_URL, HELIX_VERIFY_APP_URL, or HELIX_BASE_URL"
  [[ -n "$REINDEX_ACCESS_TOKEN" ]] || die "reindex requires HELIX_REINDEX_ACCESS_TOKEN or HELIX_ACCESS_TOKEN"

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ HELIX_BASE_URL=%q HELIX_ACCESS_TOKEN=<redacted> %s\n' "$REINDEX_BASE_URL" "$REINDEX_COMMAND"
  else
    HELIX_BASE_URL="$REINDEX_BASE_URL" HELIX_ACCESS_TOKEN="$REINDEX_ACCESS_TOKEN" bash -c "$REINDEX_COMMAND"
  fi
}

run_reindex

write_evidence() {
  [[ -n "$EVIDENCE_OUTPUT" ]] || return 0
  local manifest_path="$BACKUP_PATH.manifest.json"
  [[ -d "$BACKUP_PATH" ]] && manifest_path="$BACKUP_PATH/manifest.json"
  local manifest_status database_status object_status outbound_status audit_status sample_count sample_matches
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ node %q --live --manifest %q --output %q --require-pass # measured RPO/RTO, strict checks\n' \
      "$SCRIPT_DIR/restore-drill-evidence.mjs" "$manifest_path" "$EVIDENCE_OUTPUT"
    return
  fi
  [[ -f "$VERIFICATION_OUTPUT" ]] || die "strict restore did not write verification observations"
  observation() {
    awk -F $'\t' -v key="$1" '$1 == key { print $2 }' "$VERIFICATION_OUTPUT"
  }
  manifest_status=$(observation manifest_integrity)
  database_status=$(observation database_consistency)
  object_status=$(observation object_version_consistency)
  outbound_status=$(observation outbound_queue_consistency)
  audit_status=$(observation audit_chain)
  sample_count=$(observation sample_count)
  sample_matches=$(observation sample_matches)
  local search_status=not_run
  bool_true "$REINDEX" && search_status=passed
  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  node "$SCRIPT_DIR/restore-drill-evidence.mjs" \
    --live \
    --manifest "$manifest_path" \
    --started-at "$DRILL_STARTED_AT" \
    --completed-at "$completed_at" \
    --source-db "${POSTGRES_DB:-helix}" \
    --target-db "$TARGET_DB" \
    --target-object-bucket "$TARGET_OBJECT_BUCKET" \
    --manifest-integrity "$manifest_status" \
    --database-consistency "$database_status" \
    --object-version-consistency "$object_status" \
    --outbound-queue-consistency "$outbound_status" \
    --audit-chain "$audit_status" \
    --sample-count "$sample_count" \
    --sample-matches "$sample_matches" \
    --search-reindex "$search_status" \
    --output "$EVIDENCE_OUTPUT" \
    --require-pass >/dev/null
}

write_evidence

log "restore drill complete"
