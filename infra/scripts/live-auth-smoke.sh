#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/live-auth-smoke.sh [options]

Runs live authenticated API checks against a deployed Helix stack. This script
does not start Docker; it collects the OAuth/API/MCP/admin evidence once the
stack is already running.

Options:
  --base-url <url>             API base URL. Default: HELIX_BASE_URL or http://127.0.0.1:28431
  --client-id <id>             OAuth client id. Default: HELIX_SMOKE_CLIENT_ID
  --client-secret <secret>     OAuth client secret. Default: HELIX_SMOKE_CLIENT_SECRET
  --scope <scope>              OAuth scope string. Default includes platform, seeded app, assistant, and admin read/write scopes
  --mutate                     Also PATCH /api/admin/platform-config with --tier
  --tier <tier>                Tier to set when --mutate is used. Default: personal
  --backup-restore             Also dry-run POST /api/admin/backups and /api/admin/restores
  --backup-id <id>             Backup id for --backup-restore. Default: helix-smoke-backup
  --backup-restore-encrypted   Restore dry-run expects an age-encrypted <backup-id>.tar.gz.age archive
  --search-reindex             Also POST /api/admin/search/reindex with pruneStale=false
  --seeded-demo-tools          Also assert seeded mail/chat/docs/drive/calendar/search tool results
  --seeded-demo                Alias for --seeded-demo-tools
  --seeded-volume-search-smoke Also assert opt-in seeded volume mail through global search.query
  --drive-docs-calendar-smoke  Also create live Drive, Docs, and Calendar data and verify it through tools/MCP
  --drive-docs-calendar-search-smoke
                              Also reindex and verify live Drive, Docs, and Calendar data through search.query
  --drive-docs-calendar-event-search-smoke
                              Also verify live Drive, Docs, and Calendar search.query via event-driven indexing without reindex
  --workspace-search-smoke     Alias for --drive-docs-calendar-search-smoke
  --cli-checks                 Also run live checks through the built helix CLI
  --cli-bin <path>             CLI executable for --cli-checks. Default: node packages/cli/dist/index.js
  --pending-action-cli         Also create, poll, and cancel a pending action through the CLI
  --audit-runtime-smoke        Also validate live audit rows, hash-chain fields, and audit metrics
  --agent-limits-smoke         Also validate OAuth agent tool limiter 429, Retry-After, and metrics
  --events-ws                  Also validate authenticated /events/ws websocket behavior
  --chat-realtime-smoke        Also validate live chat room websocket fanout and persisted search
  --meet-smoke                 Also validate live Meet/Jitsi room, JWT, recording webhook, and end-room flow
  --assistant-smoke            Also validate deterministic assistant chat and memory-forget gating
  --assistant-provider-smoke   Also validate an explicitly configured non-local assistant provider,
                              provenance id propagation, and provider-specific LLM metrics
  --mail-smtp-smoke            Also validate live inbound SMTP receive and outbound Mailpit delivery
  --mail-chat-search-smoke     Also verify live Mail/Chat markers through global search.query after reindex
  --mail-chat-event-search-smoke
                              Also verify live Mail/Chat search.query via event-driven indexing without reindex
  --webdav-smoke               Also validate live WebDAV app-password auth, byte round-trip, and revoke
  --carddav-smoke              Also validate live CardDAV app-password auth, vCard sync, and revoke
  --caldav-smoke               Also validate live CalDAV app-password auth, VEVENT sync, and revoke
  --webhook-smoke              Also validate webhook admin CLI flows plus signed inbound and loopback delivery
  --plugin-lifecycle-smoke     Also validate plugin list/install/enable/disable/uninstall through live tools
  --backend-realism-smoke      Enable the backend-only realism bundle: seeded demo checks, live
                              workspace mutations/search, SMTP/Mailpit, events WS, DAV, and k6
  --k6-target-smoke            Also run target-mode k6 with the minted OAuth token
  --k6-web-base-url <url>      Web base URL for --k6-target-smoke. Default: HELIX_SMOKE_K6_WEB_BASE_URL or http://127.0.0.1:4173
  --k6-api-base-url <url>      API base URL for --k6-target-smoke. Default: HELIX_SMOKE_K6_API_BASE_URL or --base-url
  --k6-scenario-groups <csv>   k6 groups for --k6-target-smoke. Default: api_smoke,mcp
  --k6-duration <duration>     k6 WEB/API/PRD duration for --k6-target-smoke. Default: HELIX_SMOKE_K6_DURATION or 3s
  --static                     Validate shell syntax only
  -h, --help

Required for live mode:
  HELIX_SMOKE_CLIENT_ID and HELIX_SMOKE_CLIENT_SECRET, unless passed as flags.
  HELIX_TRACE_TOKEN is optional; when set, every request includes a W3C traceparent header.

Typical local evidence flow after Docker starts:
  pnpm --filter @helix/app db:seed:oauth
  HELIX_SMOKE_CLIENT_ID=helix-local-oauth-client \
  HELIX_SMOKE_CLIENT_SECRET=helix-local-dev-secret \
    infra/scripts/live-auth-smoke.sh --base-url http://127.0.0.1:28431
EOF
}

BASE_URL=${HELIX_BASE_URL:-http://127.0.0.1:28431}
CLIENT_ID=${HELIX_SMOKE_CLIENT_ID:-}
CLIENT_SECRET=${HELIX_SMOKE_CLIENT_SECRET:-}
SCOPE=${HELIX_SMOKE_SCOPE:-platform.read mail.read mail.write mail.send docs.read docs.write docs.comment drive.read drive.write calendar.read calendar.write calendar.write:respond calendar.read:freebusy chat.read chat.write meet.read meet.write assistant.write assistant.memory admin.users admin.audit admin.agents admin.plugins admin.webhooks admin.config.write}
MUTATE=false
TIER=${HELIX_SMOKE_TIER:-personal}
BACKUP_RESTORE=${HELIX_SMOKE_BACKUP_RESTORE:-false}
BACKUP_ID=${HELIX_SMOKE_BACKUP_ID:-helix-smoke-backup}
BACKUP_RESTORE_ENCRYPTED=${HELIX_SMOKE_BACKUP_RESTORE_ENCRYPTED:-false}
SEARCH_REINDEX=${HELIX_SMOKE_SEARCH_REINDEX:-false}
SEEDED_DEMO=${HELIX_SMOKE_SEEDED_DEMO:-false}
SEEDED_VOLUME_SEARCH=${HELIX_SMOKE_SEEDED_VOLUME_SEARCH:-false}
DRIVE_DOCS_CALENDAR_SMOKE=${HELIX_SMOKE_DRIVE_DOCS_CALENDAR_SMOKE:-false}
WORKSPACE_SEARCH_SMOKE=${HELIX_SMOKE_WORKSPACE_SEARCH_SMOKE:-false}
WORKSPACE_SEARCH_REINDEX=true
CLI_CHECKS=${HELIX_SMOKE_CLI_CHECKS:-false}
CLI_BIN=${HELIX_CLI_BIN:-}
PENDING_ACTION_CLI=${HELIX_SMOKE_PENDING_ACTION_CLI:-false}
PENDING_ACTOR_ID=${HELIX_SMOKE_PENDING_ACTOR_ID:-00000000-0000-4000-8000-000000000101}
AUDIT_RUNTIME_SMOKE=${HELIX_SMOKE_AUDIT_RUNTIME_SMOKE:-false}
AUDIT_RUNTIME_SHIPPING_METRICS=${HELIX_SMOKE_AUDIT_SHIPPING_METRICS:-false}
AGENT_LIMITS_SMOKE=${HELIX_SMOKE_AGENT_LIMITS_SMOKE:-false}
AGENT_LIMIT_CLIENT_ID=${HELIX_SMOKE_AGENT_CLIENT_ID:-helix-live-smoke-agent-client}
AGENT_LIMIT_CLIENT_SECRET=${HELIX_SMOKE_AGENT_CLIENT_SECRET:-helix-live-smoke-agent-secret}
AGENT_LIMIT_SCOPE=${HELIX_SMOKE_AGENT_SCOPE:-platform.read}
EVENTS_WS=${HELIX_SMOKE_EVENTS_WS:-false}
CHAT_REALTIME_SMOKE=${HELIX_SMOKE_CHAT_REALTIME_SMOKE:-false}
MEET_SMOKE=${HELIX_SMOKE_MEET_SMOKE:-false}
MEET_SMOKE_ORG_ID=${HELIX_SMOKE_MEET_ORG_ID:-${HELIX_DEFAULT_ORG_ID:-00000000-0000-0000-0000-000000000000}}
MEET_SMOKE_JITSI_DOMAIN=${HELIX_SMOKE_MEET_JITSI_DOMAIN:-${MEET_JITSI_DOMAIN:-meet.localhost}}
MEET_SMOKE_WEBHOOK_SECRET=${HELIX_SMOKE_MEET_WEBHOOK_SECRET:-${HELIX_SMOKE_MEET_JITSI_WEBHOOK_SECRET:-${MEET_JITSI_WEBHOOK_SHARED_SECRET:-${JITSI_WEBHOOK_SECRET:-helix_dev_jitsi_webhook_secret_change_me}}}}
ASSISTANT_SMOKE=${HELIX_SMOKE_ASSISTANT_SMOKE:-false}
ASSISTANT_PROVIDER_SMOKE=${HELIX_SMOKE_ASSISTANT_PROVIDER_SMOKE:-false}
ASSISTANT_PROVIDER_ID=${HELIX_SMOKE_ASSISTANT_PROVIDER_ID:-${ASSISTANT_AI_PROVIDER_ID:-${AI_DEFAULT_PROVIDER_ID:-}}}
ASSISTANT_PROVIDER_MODEL=${HELIX_SMOKE_ASSISTANT_PROVIDER_MODEL:-}
ASSISTANT_PROVIDER_EXPECT=${HELIX_SMOKE_ASSISTANT_PROVIDER_EXPECT:-Helix provider smoke}
ASSISTANT_PROVIDER_PROMPT=${HELIX_SMOKE_ASSISTANT_PROVIDER_PROMPT:-Reply with one short sentence containing the exact words "Helix provider smoke". Do not call tools.}
MAIL_SMTP_SMOKE=${HELIX_SMOKE_MAIL_SMTP_SMOKE:-false}
MAIL_SMTP_HOST=${HELIX_SMOKE_SMTP_HOST:-127.0.0.1}
MAIL_SMTP_PORT=${HELIX_SMOKE_SMTP_PORT:-28456}
MAIL_SMTP_RECIPIENT=${HELIX_SMOKE_SMTP_RECIPIENT:-local-admin@helix.local}
MAILPIT_URL=${HELIX_SMOKE_MAILPIT_URL:-http://127.0.0.1:28458}
MAIL_CHAT_SEARCH_SMOKE=${HELIX_SMOKE_MAIL_CHAT_SEARCH_SMOKE:-false}
MAIL_CHAT_SEARCH_REINDEX=true
WEBDAV_SMOKE=${HELIX_SMOKE_WEBDAV_SMOKE:-false}
CARDDAV_SMOKE=${HELIX_SMOKE_CARDDAV_SMOKE:-false}
CALDAV_SMOKE=${HELIX_SMOKE_CALDAV_SMOKE:-false}
APP_PASSWORD_ACTOR_ID=${HELIX_SMOKE_APP_PASSWORD_ACTOR_ID:-00000000-0000-4000-8000-000000000101}
APP_PASSWORD_USERNAME=${HELIX_SMOKE_APP_PASSWORD_USERNAME:-local-admin@helix.local}
WEBHOOK_SMOKE=${HELIX_SMOKE_WEBHOOK_SMOKE:-false}
PLUGIN_LIFECYCLE_SMOKE=${HELIX_SMOKE_PLUGIN_LIFECYCLE_SMOKE:-false}
PLUGIN_LIFECYCLE_ID=${HELIX_SMOKE_PLUGIN_ID:-com.helix.core.search-meilisearch}
PLUGIN_LIFECYCLE_VERSION=${HELIX_SMOKE_PLUGIN_VERSION:-1.0.0}
K6_TARGET_SMOKE=${HELIX_SMOKE_K6_TARGET_SMOKE:-false}
K6_WEB_BASE_URL=${HELIX_SMOKE_K6_WEB_BASE_URL:-${WEB_BASE_URL:-http://127.0.0.1:4173}}
K6_API_BASE_URL=${HELIX_SMOKE_K6_API_BASE_URL:-}
K6_SCENARIO_GROUPS=${HELIX_SMOKE_K6_SCENARIO_GROUPS:-api_smoke,mcp}
K6_SCENARIO_GROUPS_USER_SET=false
if [[ -n "${HELIX_SMOKE_K6_SCENARIO_GROUPS+x}" ]]; then
  K6_SCENARIO_GROUPS_USER_SET=true
fi
K6_DURATION=${HELIX_SMOKE_K6_DURATION:-3s}
TRACE_TOKEN=${HELIX_TRACE_TOKEN:-}
STATIC_ONLY=false
ACCESS_TOKEN=
NEXT_TRACEPARENT=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL=${2:?missing base URL}; shift 2 ;;
    --client-id) CLIENT_ID=${2:?missing client id}; shift 2 ;;
    --client-secret) CLIENT_SECRET=${2:?missing client secret}; shift 2 ;;
    --scope) SCOPE=${2:?missing scope}; shift 2 ;;
    --mutate) MUTATE=true; shift ;;
    --tier) TIER=${2:?missing tier}; shift 2 ;;
    --backup-restore) BACKUP_RESTORE=true; shift ;;
    --backup-id) BACKUP_ID=${2:?missing backup id}; shift 2 ;;
    --backup-restore-encrypted) BACKUP_RESTORE=true; BACKUP_RESTORE_ENCRYPTED=true; shift ;;
    --search-reindex) SEARCH_REINDEX=true; shift ;;
    --seeded-demo|--seeded-demo-tools) SEEDED_DEMO=true; shift ;;
    --seeded-volume-search-smoke) SEEDED_VOLUME_SEARCH=true; shift ;;
    --drive-docs-calendar-smoke) DRIVE_DOCS_CALENDAR_SMOKE=true; shift ;;
    --drive-docs-calendar-search-smoke|--workspace-search-smoke) WORKSPACE_SEARCH_SMOKE=true; shift ;;
    --drive-docs-calendar-event-search-smoke)
      WORKSPACE_SEARCH_SMOKE=true
      WORKSPACE_SEARCH_REINDEX=false
      shift
      ;;
    --cli-checks) CLI_CHECKS=true; shift ;;
    --cli-bin) CLI_BIN=${2:?missing CLI executable path}; shift 2 ;;
    --pending-action-cli) PENDING_ACTION_CLI=true; shift ;;
    --audit-runtime-smoke) AUDIT_RUNTIME_SMOKE=true; shift ;;
    --agent-limits-smoke) AGENT_LIMITS_SMOKE=true; shift ;;
    --events-ws) EVENTS_WS=true; shift ;;
    --chat-realtime-smoke) CHAT_REALTIME_SMOKE=true; shift ;;
    --meet-smoke) MEET_SMOKE=true; shift ;;
    --assistant-smoke) ASSISTANT_SMOKE=true; shift ;;
    --assistant-provider-smoke) ASSISTANT_PROVIDER_SMOKE=true; shift ;;
    --mail-smtp-smoke) MAIL_SMTP_SMOKE=true; shift ;;
    --mail-chat-search-smoke) MAIL_CHAT_SEARCH_SMOKE=true; shift ;;
    --mail-chat-event-search-smoke)
      MAIL_CHAT_SEARCH_SMOKE=true
      MAIL_CHAT_SEARCH_REINDEX=false
      shift
      ;;
    --webdav-smoke) WEBDAV_SMOKE=true; shift ;;
    --carddav-smoke) CARDDAV_SMOKE=true; shift ;;
    --caldav-smoke) CALDAV_SMOKE=true; shift ;;
    --webhook-smoke) WEBHOOK_SMOKE=true; shift ;;
    --plugin-lifecycle-smoke) PLUGIN_LIFECYCLE_SMOKE=true; shift ;;
    --backend-realism-smoke)
      SEEDED_DEMO=true
      DRIVE_DOCS_CALENDAR_SMOKE=true
      WORKSPACE_SEARCH_SMOKE=true
      MAIL_SMTP_SMOKE=true
      MAIL_CHAT_SEARCH_SMOKE=true
      EVENTS_WS=true
      WEBDAV_SMOKE=true
      CARDDAV_SMOKE=true
      CALDAV_SMOKE=true
      K6_TARGET_SMOKE=true
      if ! bool_true "$K6_SCENARIO_GROUPS_USER_SET"; then
        K6_SCENARIO_GROUPS=api_smoke,mail_api,inbound_mail,search,chat,docs,meet_jitsi,mcp,otel_health
      fi
      shift
      ;;
    --k6-target-smoke) K6_TARGET_SMOKE=true; shift ;;
    --k6-web-base-url) K6_WEB_BASE_URL=${2:?missing k6 web base URL}; shift 2 ;;
    --k6-api-base-url) K6_API_BASE_URL=${2:?missing k6 API base URL}; shift 2 ;;
    --k6-scenario-groups) K6_SCENARIO_GROUPS=${2:?missing k6 scenario groups}; K6_SCENARIO_GROUPS_USER_SET=true; shift 2 ;;
    --k6-duration) K6_DURATION=${2:?missing k6 duration}; shift 2 ;;
    --static) STATIC_ONLY=true; shift ;;
    --) shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

K6_API_BASE_URL=${K6_API_BASE_URL:-$BASE_URL}

ensure_repo_root
require_cmd bash

if bool_true "$STATIC_ONLY"; then
  bash -n infra/scripts/live-auth-smoke.sh
  log "live auth smoke syntax validation complete"
  exit 0
fi

require_cmd curl
require_cmd node

case "$TIER" in
  personal|business|enterprise|sovereign) ;;
  *) die "unknown tier: $TIER" ;;
esac

[[ -n "$CLIENT_ID" ]] || die "HELIX_SMOKE_CLIENT_ID or --client-id is required"
[[ -n "$CLIENT_SECRET" ]] || die "HELIX_SMOKE_CLIENT_SECRET or --client-secret is required"

api_url() {
  local path=${1:?missing path}
  local normalized=${BASE_URL%/}
  printf '%s%s' "$normalized" "$path"
}

json_field() {
  local field=${1:?missing field}
  node -e '
const field = process.argv[1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const value = parsed[field];
  if (typeof value !== "string" || value.length === 0) {
    process.exit(2);
  }
  process.stdout.write(value);
});
' "$field"
}

request() {
  local method=${1:?missing method}
  local path=${2:?missing path}
  local expected_status=${3:?missing expected status}
  local body=${4:-}
  local expected_field=${5:-}
  local expected_value=${6:-}
  local output_file
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-smoke.XXXXXX")

  local status
  if [[ -n "$body" ]]; then
    status=$(curl_with_trace -sS \
      -o "$output_file" \
      -w '%{http_code}' \
      -X "$method" \
      -H 'accept: application/json' \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $ACCESS_TOKEN" \
      --data "$body" \
      "$(api_url "$path")")
  else
    status=$(curl_with_trace -sS \
      -o "$output_file" \
      -w '%{http_code}' \
      -X "$method" \
      -H 'accept: application/json' \
      -H "authorization: Bearer $ACCESS_TOKEN" \
      "$(api_url "$path")")
  fi

  if [[ "$status" != "$expected_status" ]]; then
    log "response body from $method $path:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "$method $path returned HTTP $status, expected $expected_status"
  fi

  if [[ -n "$expected_field" ]]; then
    local actual_value
    actual_value=$(json_field "$expected_field" <"$output_file") || {
      log "response body from $method $path:"
      cat "$output_file" >&2
      rm -f "$output_file"
      die "$method $path response did not include string field $expected_field"
    }
    if [[ "$actual_value" != "$expected_value" ]]; then
      log "response body from $method $path:"
      cat "$output_file" >&2
      rm -f "$output_file"
      die "$method $path returned $expected_field=$actual_value, expected $expected_value"
    fi
  fi

  rm -f "$output_file"
  log "ok: $method $path -> $status"
}

request_contains() {
  local method=${1:?missing method}
  local path=${2:?missing path}
  local expected_status=${3:?missing expected status}
  local body=${4:-}
  local label=${5:?missing label}
  shift 5
  local output_file
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-smoke.XXXXXX")

  local status
  if [[ -n "$body" ]]; then
    status=$(curl_with_trace -sS \
      -o "$output_file" \
      -w '%{http_code}' \
      -X "$method" \
      -H 'accept: application/json' \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $ACCESS_TOKEN" \
      --data "$body" \
      "$(api_url "$path")")
  else
    status=$(curl_with_trace -sS \
      -o "$output_file" \
      -w '%{http_code}' \
      -X "$method" \
      -H 'accept: application/json' \
      -H "authorization: Bearer $ACCESS_TOKEN" \
      "$(api_url "$path")")
  fi

  if [[ "$status" != "$expected_status" ]]; then
    log "response body from $method $path:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "$method $path returned HTTP $status, expected $expected_status"
  fi

  local needle
  for needle in "$@"; do
    if ! grep -Fq "$needle" "$output_file"; then
      log "response body from $method $path:"
      cat "$output_file" >&2
      rm -f "$output_file"
      die "$label response did not contain expected seeded value: $needle"
    fi
  done

  rm -f "$output_file"
  log "ok: $label -> $status"
}

request_contains_retry() {
  local method=${1:?missing method}
  local path=${2:?missing path}
  local expected_status=${3:?missing expected status}
  local body=${4:-}
  local label=${5:?missing label}
  local timeout_seconds=${6:?missing timeout seconds}
  shift 6
  local output_file deadline status needle
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-smoke.XXXXXX")
  deadline=$((SECONDS + timeout_seconds))

  while true; do
    if [[ -n "$body" ]]; then
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H 'content-type: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        --data "$body" \
        "$(api_url "$path")") || status=000
    else
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        "$(api_url "$path")") || status=000
    fi

    if [[ "$status" == "$expected_status" ]]; then
      local matched=true
      for needle in "$@"; do
        if ! grep -Fq "$needle" "$output_file"; then
          matched=false
          break
        fi
      done
      if bool_true "$matched"; then
        rm -f "$output_file"
        log "ok: $label -> $status"
        return 0
      fi
    fi

    if (( SECONDS >= deadline )); then
      log "last response body from $method $path:"
      cat "$output_file" >&2
      rm -f "$output_file"
      die "$label did not contain expected values before timeout"
    fi
    sleep 1
  done
}

request_search_hit_retry() {
  local method=${1:?missing method}
  local path=${2:?missing path}
  local body=${3:-}
  local label=${4:?missing label}
  local timeout_seconds=${5:?missing timeout seconds}
  local expected_id=${6:?missing expected search hit id}
  local expected_type=${7:?missing expected search hit type}
  local expected_title=${8:?missing expected search hit title}
  local output_file deadline status
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-search-smoke.XXXXXX")
  deadline=$((SECONDS + timeout_seconds))

  while true; do
    if [[ -n "$body" ]]; then
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H 'content-type: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        --data "$body" \
        "$(api_url "$path")") || status=000
    else
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        "$(api_url "$path")") || status=000
    fi

    if [[ "$status" == "200" ]] &&
      node -e '
const fs = require("node:fs");
const [file, expectedId, expectedType, expectedTitle] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
if (!hits.some((hit) => hit?.id === expectedId && hit?.type === expectedType && hit?.title === expectedTitle)) {
  process.exit(1);
}
' "$output_file" "$expected_id" "$expected_type" "$expected_title"; then
      rm -f "$output_file"
      log "ok: $label -> $status"
      return 0
    fi

    if (( SECONDS >= deadline )); then
      log "last response body from $method $path:"
      cat "$output_file" >&2
      rm -f "$output_file"
      die "$label did not return expected search hit $expected_id"
    fi
    sleep 1
  done
}

request_search_projection_retry() {
  local method=${1:?missing method}
  local path=${2:?missing path}
  local body=${3:-}
  local label=${4:?missing label}
  local timeout_seconds=${5:?missing timeout seconds}
  local expected_id=${6:?missing expected search hit id}
  local expected_type=${7:?missing expected search hit type}
  local expected_title=${8:?missing expected search hit title}
  local expected_url=${9:?missing expected search hit URL}
  shift 9
  local output_file deadline status
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-search-smoke.XXXXXX")
  deadline=$((SECONDS + timeout_seconds))

  while true; do
    if [[ -n "$body" ]]; then
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H 'content-type: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        --data "$body" \
        "$(api_url "$path")") || status=000
    else
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        "$(api_url "$path")") || status=000
    fi

    if [[ "$status" == "200" ]] &&
      node -e '
const fs = require("node:fs");
const [file, expectedId, expectedType, expectedTitle, expectedUrl, ...needles] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
if (!hits.some((hit) => {
  if (
    hit?.id !== expectedId ||
    hit?.type !== expectedType ||
    hit?.title !== expectedTitle ||
    hit?.url !== expectedUrl
  ) {
    return false;
  }
  const text = JSON.stringify(hit);
  return needles.every((needle) => text.includes(needle));
})) {
  process.exit(1);
}
' "$output_file" "$expected_id" "$expected_type" "$expected_title" "$expected_url" "$@"; then
      rm -f "$output_file"
      log "ok: $label -> $status"
      return 0
    fi

    if (( SECONDS >= deadline )); then
      log "last response body from $method $path:"
      cat "$output_file" >&2
      rm -f "$output_file"
      die "$label did not return expected projected search hit $expected_id"
    fi
    sleep 1
  done
}

request_search_text_retry() {
  local method=${1:?missing method}
  local path=${2:?missing path}
  local body=${3:-}
  local label=${4:?missing label}
  local timeout_seconds=${5:?missing timeout seconds}
  local expected_type=${6:?missing expected search hit type}
  shift 6
  local output_file deadline status
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-search-smoke.XXXXXX")
  deadline=$((SECONDS + timeout_seconds))

  while true; do
    if [[ -n "$body" ]]; then
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H 'content-type: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        --data "$body" \
        "$(api_url "$path")") || status=000
    else
      status=$(curl_with_trace -sS \
        -o "$output_file" \
        -w '%{http_code}' \
        -X "$method" \
        -H 'accept: application/json' \
        -H "authorization: Bearer $ACCESS_TOKEN" \
        "$(api_url "$path")") || status=000
    fi

    if [[ "$status" == "200" ]] &&
      node -e '
const fs = require("node:fs");
const [file, expectedType, ...needles] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
if (!hits.some((hit) => {
  if (hit?.type !== expectedType) return false;
  const text = JSON.stringify(hit);
  return needles.every((needle) => text.includes(needle));
})) {
  process.exit(1);
}
' "$output_file" "$expected_type" "$@"; then
      rm -f "$output_file"
      log "ok: $label -> $status"
      return 0
    fi

    if (( SECONDS >= deadline )); then
      log "last response body from $method $path:"
      cat "$output_file" >&2
      rm -f "$output_file"
      die "$label did not return an expected $expected_type search hit"
    fi
    sleep 1
  done
}

run_global_search_reindex_for_live_markers() {
  request POST /api/admin/search/reindex 200 '{"all":true,"pruneStale":false}' status completed
}

request_capture() {
  local method=${1:?missing method}
  local path=${2:?missing path}
  local expected_status=${3:?missing expected status}
  local body=${4:-}
  local label=${5:?missing label}
  local output_file=${6:?missing output file}

  local status
  if [[ -n "$body" ]]; then
    status=$(curl_with_trace -sS \
      -o "$output_file" \
      -w '%{http_code}' \
      -X "$method" \
      -H 'accept: application/json' \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $ACCESS_TOKEN" \
      --data "$body" \
      "$(api_url "$path")")
  else
    status=$(curl_with_trace -sS \
      -o "$output_file" \
      -w '%{http_code}' \
      -X "$method" \
      -H 'accept: application/json' \
      -H "authorization: Bearer $ACCESS_TOKEN" \
      "$(api_url "$path")")
  fi

  if [[ "$status" != "$expected_status" ]]; then
    log "response body from $method $path:"
    cat "$output_file" >&2
    die "$label returned HTTP $status, expected $expected_status"
  fi

  log "ok: $label -> $status"
}

curl_with_trace() {
  next_traceparent
  if [[ -n "$NEXT_TRACEPARENT" ]]; then
    curl -H "traceparent: $NEXT_TRACEPARENT" "$@"
  else
    curl "$@"
  fi
}

next_traceparent() {
  NEXT_TRACEPARENT=
  local token
  token=$(trim "$TRACE_TOKEN")
  if [[ -z "$token" ]]; then
    return 0
  fi

  local trace_id parent_id
  trace_id=$(trace_id_from_token "$token")
  parent_id=$(random_parent_id)
  NEXT_TRACEPARENT="00-$trace_id-$parent_id-01"
}

trace_id_from_token() {
  local token=${1:?missing token}
  local lower_token=${token,,}

  if [[ "$lower_token" =~ ^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$ ]] &&
    ! is_zero_hex "${BASH_REMATCH[1]}"; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi

  if [[ "$lower_token" =~ ^[0-9a-f]{32}$ ]] && ! is_zero_hex "$lower_token"; then
    printf '%s' "$lower_token"
    return 0
  fi

  non_zero_hex "$(hash_hex "trace:$token" 32)" 32
}

hash_hex() {
  local input=${1:?missing input}
  local length=${2:?missing length}
  node -e '
const { createHash } = require("node:crypto");
const input = process.argv[1];
const length = Number(process.argv[2]);
process.stdout.write(createHash("sha256").update(input).digest("hex").slice(0, length));
' "$input" "$length"
}

random_parent_id() {
  non_zero_hex "$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')" 16
}

non_zero_hex() {
  local value=${1:?missing value}
  local length=${2:?missing length}
  if is_zero_hex "$value"; then
    printf '%0*d1' "$((length - 1))" 0
  else
    printf '%s' "$value"
  fi
}

is_zero_hex() {
  [[ "$1" =~ ^0+$ ]]
}

trim() {
  local value=${1:-}
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

run_seeded_demo_checks() {
  request_contains POST /api/tools/mail.search 200 \
    '{"query":"Renovate","limit":10}' \
    "seeded mail search" \
    "00000000-0000-4000-8000-000000000604" \
    "Renovate"

  request_contains POST /api/tools/mail.thread.get 200 \
    '{"threadId":"00000000-0000-4000-8000-000000000601"}' \
    "seeded Amazon mail thread" \
    "Amazon" \
    '"hasAttachment":true' \
    '"objectId":"00000000-0000-4000-8000-000000000609"' \
    '"filename":"order-summary.txt"' \
    '"mimeType":"text/plain"' \
    '"disposition":"attachment"'

  request_contains POST /api/tools/docs.list 200 \
    '{"query":"Quarterly","limit":10}' \
    "seeded Docs list" \
    "00000000-0000-4000-8000-000000000401" \
    "Quarterly Planning Notes"

  request_contains POST /api/tools/docs.get 200 \
    '{"docId":"00000000-0000-4000-8000-000000000401"}' \
    "seeded Docs get" \
    "00000000-0000-4000-8000-000000000401" \
    "Quarterly Planning Notes"

  request_contains POST /api/tools/docs.export 200 \
    '{"docId":"00000000-0000-4000-8000-000000000401","format":"markdown"}' \
    "seeded Docs export" \
    "Quarterly Planning Notes" \
    "contentBase64"

  request_contains POST /api/tools/drive.list 200 \
    '{"limit":25}' \
    "seeded Drive list" \
    "00000000-0000-4000-8000-000000000301" \
    "Projects" \
    "AI Services and Keys"

  request_contains POST /api/tools/drive.search 200 \
    '{"query":"Training Course","limit":10}' \
    "seeded Drive search" \
    "00000000-0000-4000-8000-000000000303" \
    "Training Course Links"

  request_contains POST /api/tools/calendar.event.list 200 \
    '{"startsAt":"2026-05-20T00:00:00.000Z","endsAt":"2026-05-22T00:00:00.000Z","limit":10}' \
    "seeded Calendar list" \
    "00000000-0000-4000-8000-000000000502" \
    "Order match ball" \
    "00000000-0000-4000-8000-000000000504" \
    "Product planning review"

  request_contains POST /api/tools/chat.room.list 200 \
    '{"query":"Helix launch","limit":10}' \
    "seeded Chat room list" \
    "00000000-0000-4000-8000-000000000701" \
    "Helix launch room"

  request_contains POST /api/tools/chat.search 200 \
    '{"query":"Mail density","limit":10}' \
    "seeded Chat search" \
    "00000000-0000-4000-8000-000000000703" \
    "Mail density"

  request_search_projection_retry POST /api/tools/search.query \
    '{"query":"Renovate","types":["mail"],"limit":10}' \
    "seeded global mail search" \
    10 \
    "mail:00000000-0000-4000-8000-000000000604" \
    "mail" \
    "[AlphaBravoCompany/remotedialer] Run failed: Renovate - main" \
    "/mail/00000000-0000-4000-8000-000000000603?message=00000000-0000-4000-8000-000000000604" \
    "manual review" \
    '"threadId":"00000000-0000-4000-8000-000000000603"' \
    '"from":"mjtechguy@example.com"' \
    '"labels":["inbox","updates"]'

  request_search_projection_retry POST /api/tools/search.query \
    '{"query":"AI Services","types":["drive"],"limit":10}' \
    "seeded global Drive search" \
    10 \
    "drive:00000000-0000-4000-8000-000000000302" \
    "drive" \
    "AI Services and Keys" \
    "/drive/00000000-0000-4000-8000-000000000302" \
    '"kind":"file"' \
    '"mimeType":"text/markdown"' \
    '"path":["AI Services and Keys"]'

  request_search_projection_retry POST /api/tools/search.query \
    '{"query":"Quarterly Planning","types":["docs"],"limit":10}' \
    "seeded global Docs search" \
    10 \
    "docs:00000000-0000-4000-8000-000000000401" \
    "docs" \
    "Quarterly Planning Notes" \
    "/docs/00000000-0000-4000-8000-000000000401" \
    "Tighten mail list density" \
    '"tags":["planning","product"]'

  request_search_projection_retry POST /api/tools/search.query \
    '{"query":"Order match","types":["calendar"],"limit":10}' \
    "seeded global Calendar search" \
    10 \
    "calendar:00000000-0000-4000-8000-000000000502" \
    "calendar" \
    "Order match ball" \
    "/calendar/events/00000000-0000-4000-8000-000000000502" \
    "payment receipt" \
    '"location":"Indoor Court 2"' \
    '"icsUid":"demo-order-match@helix.local"'

  request_search_projection_retry POST /api/tools/search.query \
    '{"query":"Mail density","types":["chat"],"limit":10}' \
    "seeded global Chat search" \
    10 \
    "chat:00000000-0000-4000-8000-000000000703" \
    "chat" \
    "Helix launch room" \
    "/chat/00000000-0000-4000-8000-000000000701?message=00000000-0000-4000-8000-000000000703" \
    "Mail density" \
    '"roomId":"00000000-0000-4000-8000-000000000701"' \
    '"reactions":["ok"]'

  request_contains POST /mcp 200 \
    '{"jsonrpc":"2.0","id":"seeded-resources","method":"resources/list"}' \
    "seeded MCP resources list" \
    "helix://chat/room/00000000-0000-4000-8000-000000000701" \
    "helix://mail/thread/00000000-0000-4000-8000-000000000601" \
    "helix://docs/document/00000000-0000-4000-8000-000000000401" \
    "helix://drive/file/00000000-0000-4000-8000-000000000302" \
    "helix://calendar/event/00000000-0000-4000-8000-000000000502"

  request_contains POST /mcp 200 \
    '{"jsonrpc":"2.0","id":"seeded-doc-read","method":"resources/read","params":{"uri":"helix://docs/document/00000000-0000-4000-8000-000000000401"}}' \
    "seeded MCP Docs read" \
    "Quarterly Planning Notes"

  request_contains POST /mcp 200 \
    '{"jsonrpc":"2.0","id":"seeded-mail-read","method":"resources/read","params":{"uri":"helix://mail/thread/00000000-0000-4000-8000-000000000601"}}' \
    "seeded MCP Mail read" \
    "3 items from Amazon arriving tomorrow" \
    "Track package delivery"

  request_contains POST /mcp 200 \
    '{"jsonrpc":"2.0","id":"seeded-drive-read","method":"resources/read","params":{"uri":"helix://drive/file/00000000-0000-4000-8000-000000000302"}}' \
    "seeded MCP Drive read" \
    "AI Services and Keys" \
    "Local Ollama"

  request_contains POST /mcp 200 \
    '{"jsonrpc":"2.0","id":"seeded-calendar-read","method":"resources/read","params":{"uri":"helix://calendar/event/00000000-0000-4000-8000-000000000502"}}' \
    "seeded MCP Calendar read" \
    "Order match ball" \
    "Indoor Court 2" \
    "payment receipt"

  request_contains POST /mcp 200 \
    '{"jsonrpc":"2.0","id":"seeded-chat-read","method":"resources/read","params":{"uri":"helix://chat/room/00000000-0000-4000-8000-000000000701"}}' \
    "seeded MCP Chat read" \
    "Helix launch room" \
    "Mail density"
}

run_seeded_volume_search_smoke() {
  request_search_projection_retry POST /api/tools/search.query \
    '{"query":"helix-volume-mail-search","types":["mail"],"limit":20}' \
    "seeded volume global mail search" \
    10 \
    "mail:00000000-0000-4200-8000-000000000001" \
    "mail" \
    "helix-volume-mail-search message 00001" \
    "/mail/00000000-0000-4100-8000-000000000001?message=00000000-0000-4200-8000-000000000001" \
    "helix-volume-mail-search body 00001" \
    '"threadId":"00000000-0000-4100-8000-000000000001"' \
    '"messageId":"00000000-0000-4200-8000-000000000001"' \
    '"labels":["inbox","operations","volume"]' \
    '"source":"local-demo-volume"' \
    '"marker":"helix-volume-mail-search"'
}

run_audit_runtime_smoke() {
  local app_password_file agent_file audit_file metrics_file expected_trace_id deadline

  if [[ -z "$(trim "$TRACE_TOKEN")" ]]; then
    TRACE_TOKEN="audit-runtime-smoke-$(date +%Y%m%d%H%M%S)"
    log "using generated HELIX_TRACE_TOKEN equivalent for audit runtime smoke: $TRACE_TOKEN"
  fi
  expected_trace_id=$(trace_id_from_token "$TRACE_TOKEN")

  app_password_file=$(mktemp "${TMPDIR:-/tmp}/helix-audit-app-passwords.XXXXXX")
  request_capture POST /api/tools/app.passwords.list 200 \
    '{"includeRevoked":false}' \
    "audit app.passwords.list trigger" \
    "$app_password_file"
  rm -f "$app_password_file"

  agent_file=$(mktemp "${TMPDIR:-/tmp}/helix-audit-agent-credentials.XXXXXX")
  request_capture POST /api/tools/agent.credentials.list 200 \
    '{"includeRevoked":false}' \
    "audit agent.credentials.list trigger" \
    "$agent_file"
  rm -f "$agent_file"

  audit_file=$(mktemp "${TMPDIR:-/tmp}/helix-audit-runtime.XXXXXX")
  request_capture GET '/api/admin/audit-log?verb=app.password.listed&objectType=tool&limit=10' 200 \
    "" \
    "audit log app.password.listed" \
    "$audit_file"
  node -e '
const fs = require("node:fs");
const [file, expectedTraceId] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const records = Array.isArray(parsed.records) ? parsed.records : [];
const hashPattern = /^[a-f0-9]{64}$/;
const record = records.find((candidate) =>
  candidate?.verb === "app.password.listed" &&
  candidate?.objectType === "tool" &&
  candidate?.actorId &&
  candidate?.payload?.credentialType === "app_password" &&
  candidate?.payload?.toolPermission === "admin.users" &&
  candidate?.payload?.actorType &&
  hashPattern.test(candidate?.thisHash ?? "") &&
  (candidate?.prevHash === null || hashPattern.test(candidate?.prevHash ?? "")) &&
  typeof candidate?.createdAt === "string" &&
  (expectedTraceId.length === 0 || candidate?.traceId === expectedTraceId)
);
if (record === undefined) {
  process.exit(2);
}
' "$audit_file" "$expected_trace_id" || {
    log "response body from app.password.listed audit log:"
    cat "$audit_file" >&2
    rm -f "$audit_file"
    die "audit runtime smoke did not find a valid app.password.listed audit row"
  }
  rm -f "$audit_file"
  log "ok: audit log includes hash-chained app.password.listed row"

  audit_file=$(mktemp "${TMPDIR:-/tmp}/helix-audit-runtime.XXXXXX")
  request_capture GET '/api/admin/audit-log?verb=agent.credential.listed&objectType=tool&limit=10' 200 \
    "" \
    "audit log agent.credential.listed" \
    "$audit_file"
  node -e '
const fs = require("node:fs");
const [file, expectedTraceId] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const records = Array.isArray(parsed.records) ? parsed.records : [];
const hashPattern = /^[a-f0-9]{64}$/;
const record = records.find((candidate) =>
  candidate?.verb === "agent.credential.listed" &&
  candidate?.objectType === "tool" &&
  candidate?.actorId &&
  candidate?.payload?.credentialType === "oauth_client" &&
  candidate?.payload?.toolPermission === "admin.agents" &&
  candidate?.payload?.actorType &&
  hashPattern.test(candidate?.thisHash ?? "") &&
  (candidate?.prevHash === null || hashPattern.test(candidate?.prevHash ?? "")) &&
  typeof candidate?.createdAt === "string" &&
  (expectedTraceId.length === 0 || candidate?.traceId === expectedTraceId)
);
if (record === undefined) {
  process.exit(2);
}
' "$audit_file" "$expected_trace_id" || {
    log "response body from agent.credential.listed audit log:"
    cat "$audit_file" >&2
    rm -f "$audit_file"
    die "audit runtime smoke did not find a valid agent.credential.listed audit row"
  }
  rm -f "$audit_file"
  log "ok: audit log includes hash-chained agent.credential.listed row"

  metrics_file=$(mktemp "${TMPDIR:-/tmp}/helix-audit-metrics.XXXXXX")
  deadline=$((SECONDS + 15))
  while true; do
    curl_with_trace -fsS "$(api_url /metrics)" -o "$metrics_file"
    if grep -E '^helix_audit_activity_total\{verb="app\.password\.listed",object_type="tool"\} [1-9][0-9]*(\.[0-9]+)?$' "$metrics_file" >/dev/null &&
      grep -E '^helix_audit_activity_total\{verb="agent\.credential\.listed",object_type="tool"\} [1-9][0-9]*(\.[0-9]+)?$' "$metrics_file" >/dev/null &&
      grep -E '^helix_audit_hash_chain_last_verified_timestamp_seconds [1-9][0-9]*(\.[0-9]+)?$' "$metrics_file" >/dev/null; then
      break
    fi
    if (( SECONDS >= deadline )); then
      log "metrics output from /metrics:"
      cat "$metrics_file" >&2
      rm -f "$metrics_file"
      die "audit runtime smoke did not find audit activity and hash-chain verifier metrics"
    fi
    sleep 1
  done

  if bool_true "$AUDIT_RUNTIME_SHIPPING_METRICS"; then
    grep -E '^helix_audit_shipping_backlog_records\{destination="immutable-s3"\} [0-9]+(\.[0-9]+)?$' "$metrics_file" >/dev/null || {
      log "metrics output from /metrics:"
      cat "$metrics_file" >&2
      rm -f "$metrics_file"
      die "audit runtime smoke did not find immutable-s3 shipping backlog metrics"
    }
    grep -E '^helix_audit_shipping_lag_seconds\{destination="immutable-s3"\} [0-9]+(\.[0-9]+)?$' "$metrics_file" >/dev/null || {
      log "metrics output from /metrics:"
      cat "$metrics_file" >&2
      rm -f "$metrics_file"
      die "audit runtime smoke did not find immutable-s3 shipping lag metrics"
    }
    log "ok: audit immutable shipping metrics exposed"
  fi

  rm -f "$metrics_file"
  log "ok: audit activity and hash-chain verifier metrics exposed"
}

run_agent_limits_smoke() {
  local token_response agent_token output_file headers_file status attempt metrics_file

  log "minting OAuth client-credentials token for limiter smoke agent $AGENT_LIMIT_CLIENT_ID"
  token_response=$(curl_with_trace -fsS \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=$AGENT_LIMIT_CLIENT_ID" \
    --data-urlencode "client_secret=$AGENT_LIMIT_CLIENT_SECRET" \
    --data-urlencode "scope=$AGENT_LIMIT_SCOPE" \
    "$(api_url /oauth/token)")
  agent_token=$(printf '%s' "$token_response" | json_field access_token)
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-agent-limit-body.XXXXXX")
  headers_file=$(mktemp "${TMPDIR:-/tmp}/helix-agent-limit-headers.XXXXXX")

  for attempt in 1 2 3; do
    status=$(curl_with_trace -sS \
      -D "$headers_file" \
      -o "$output_file" \
      -w '%{http_code}' \
      -X POST \
      -H 'accept: application/json' \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $agent_token" \
      --data '{}' \
      "$(api_url /api/tools/platform.ping)") || status=000
    if [[ "$status" == "429" ]]; then
      break
    fi
  done

  if [[ "$status" != "429" ]]; then
    log "last response body from agent-limited platform.ping:"
    cat "$output_file" >&2
    rm -f "$output_file" "$headers_file"
    die "agent limits smoke did not receive HTTP 429; start the app with a limiting tier and low HELIX_AGENT_LIMIT_REQUESTS_PER_MINUTE"
  fi

  grep -iq '^retry-after:' "$headers_file" || {
    log "agent limiter response headers:"
    cat "$headers_file" >&2
    rm -f "$output_file" "$headers_file"
    die "agent limits smoke did not receive Retry-After header"
  }
  node -e '
const fs = require("node:fs");
const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (
  parsed?.error !== "Agent tool invocation limit exceeded: requests_per_minute" ||
  parsed?.rateLimit?.reason !== "requests_per_minute" ||
  typeof parsed?.retryAfterSeconds !== "number" ||
  parsed.retryAfterSeconds <= 0 ||
  parsed.rateLimit?.usage?.requestsPerMinute?.remaining !== 0
) {
  process.exit(1);
}
' "$output_file" || {
    log "agent limiter response body:"
    cat "$output_file" >&2
    rm -f "$output_file" "$headers_file"
    die "agent limits smoke did not receive expected rateLimit JSON"
  }
  rm -f "$output_file" "$headers_file"
  log "ok: agent tool limiter metadata -> 429"

  metrics_file=$(mktemp "${TMPDIR:-/tmp}/helix-agent-limit-metrics.XXXXXX")
  curl_with_trace -fsS "$(api_url /metrics)" -o "$metrics_file"
  grep -F 'helix_agent_tool_limiter_denials_total{tool_id="platform.ping"' "$metrics_file" >/dev/null || {
    log "metrics output from /metrics:"
    cat "$metrics_file" >&2
    rm -f "$metrics_file"
    die "agent limits smoke did not find limiter denial metric"
  }
  grep -F 'reason="requests_per_minute"' "$metrics_file" >/dev/null || {
    log "metrics output from /metrics:"
    cat "$metrics_file" >&2
    rm -f "$metrics_file"
    die "agent limits smoke did not find requests_per_minute metric label"
  }
  rm -f "$metrics_file"
  log "ok: agent tool limiter metric exposed"
}

run_drive_docs_calendar_smoke() {
  local suffix marker drive_name drive_content drive_content_base64 drive_sha drive_upload_file drive_finalize_file drive_object_id
  local docs_title docs_updated_title docs_body docs_file docs_id docs_export_file
  local starts_at ends_at window_starts_at window_ends_at calendar_title calendar_file calendar_pending_id calendar_approve_file calendar_event_id
  suffix=$(date +%Y%m%d%H%M%S)
  marker="helix-workspace-smoke-${suffix}"

  drive_name="Helix Drive smoke ${suffix}.txt"
  drive_content="Drive storage marker: ${marker}"
  drive_content_base64=$(printf '%s' "$drive_content" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => process.stdout.write(Buffer.from(input, "utf8").toString("base64")));
')
  drive_sha=$(printf '%s' "$drive_content" | node -e '
const { createHash } = require("node:crypto");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => process.stdout.write(createHash("sha256").update(input).digest("hex")));
')

  drive_upload_file=$(mktemp "${TMPDIR:-/tmp}/helix-drive-smoke.XXXXXX")
  request_capture POST /api/tools/drive.upload 200 \
    "$(node -e '
const [name, byteSize, sha256, marker] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  name,
  mimeType: "text/plain; charset=utf-8",
  byteSize: Number(byteSize),
  sha256,
  metadata: { smoke: true, marker },
}));
' "$drive_name" "${#drive_content}" "$drive_sha" "$marker")" \
    "drive.upload" \
    "$drive_upload_file"
  drive_object_id=$(json_field_from_file "$drive_upload_file" "parsed.objectId") || {
    log "response body from drive.upload:"
    cat "$drive_upload_file" >&2
    rm -f "$drive_upload_file"
    die "drive.upload did not return objectId"
  }
  rm -f "$drive_upload_file"

  drive_finalize_file=$(mktemp "${TMPDIR:-/tmp}/helix-drive-smoke.XXXXXX")
  request_capture POST /api/tools/drive.finalize 200 \
    "$(node -e '
const [objectId, byteSize, sha256, contentBase64, marker] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  objectId,
  byteSize: Number(byteSize),
  sha256,
  mimeType: "text/plain; charset=utf-8",
  contentBase64,
  metadata: { smoke: true, marker },
}));
' "$drive_object_id" "${#drive_content}" "$drive_sha" "$drive_content_base64" "$marker")" \
    "drive.finalize" \
    "$drive_finalize_file"
  rm -f "$drive_finalize_file"

  request_contains POST /api/tools/drive.list 200 \
    '{"limit":25}' \
    "Drive live list" \
    "$drive_object_id" \
    "$drive_name"

  request_contains_retry POST /api/tools/drive.search 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], limit: 10 }))' "$drive_name")" \
    "Drive live search" \
    10 \
    "$drive_object_id" \
    "$drive_name"

  request_contains POST /mcp 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "drive-smoke-read", method: "resources/read", params: { uri: `helix://drive/file/${process.argv[1]}` } }))' "$drive_object_id")" \
    "Drive MCP byte read" \
    "$drive_content"

  docs_title="Helix Docs smoke ${suffix}"
  docs_updated_title="Helix Docs smoke updated ${suffix}"
  docs_body="# ${docs_title}\n\nDocs marker: ${marker}\n\n- Created by live workspace smoke."
  docs_file=$(mktemp "${TMPDIR:-/tmp}/helix-docs-smoke.XXXXXX")
  request_capture POST /api/tools/docs.create 200 \
    "$(node -e '
const [title, markdown, marker] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  title,
  initialMarkdown: markdown,
  metadata: { smoke: true, marker },
}));
' "$docs_title" "$docs_body" "$marker")" \
    "docs.create" \
    "$docs_file"
  docs_id=$(json_field_from_file "$docs_file" "parsed.id") || {
    log "response body from docs.create:"
    cat "$docs_file" >&2
    rm -f "$docs_file"
    die "docs.create did not return id"
  }
  rm -f "$docs_file"

  request_contains POST /api/tools/docs.update-title 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ docId: process.argv[1], title: process.argv[2] }))' "$docs_id" "$docs_updated_title")" \
    "Docs update title" \
    "$docs_id" \
    "$docs_updated_title"

  request_contains POST /api/tools/docs.comment.create 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ docId: process.argv[1], body: `Comment marker: ${process.argv[2]}`, anchor: { type: "document" }, metadata: { smoke: true } }))' "$docs_id" "$marker")" \
    "Docs comment create" \
    "$docs_id" \
    "$marker"

  request_contains POST /api/tools/docs.get 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ docId: process.argv[1] }))' "$docs_id")" \
    "Docs live get" \
    "$docs_id" \
    "$docs_updated_title"

  docs_export_file=$(mktemp "${TMPDIR:-/tmp}/helix-docs-export.XXXXXX")
  request_capture POST /api/tools/docs.export 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ docId: process.argv[1], format: "markdown", includeComments: true }))' "$docs_id")" \
    "Docs markdown export" \
    "$docs_export_file"
  node -e '
const fs = require("node:fs");
const [file, marker, title] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const text = Buffer.from(String(parsed.contentBase64 ?? ""), "base64").toString("utf8");
if (!text.includes(marker) || !text.includes(title)) {
  process.exit(2);
}
' "$docs_export_file" "$marker" "$docs_updated_title" || {
    log "response body from docs.export:"
    cat "$docs_export_file" >&2
    rm -f "$docs_export_file"
    die "Docs markdown export did not include title and marker"
  }
  rm -f "$docs_export_file"
  log "ok: Docs markdown export content"

  request_contains POST /mcp 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "docs-smoke-read", method: "resources/read", params: { uri: `helix://docs/document/${process.argv[1]}` } }))' "$docs_id")" \
    "Docs MCP read" \
    "$docs_updated_title" \
    "$marker"

  read -r starts_at ends_at window_starts_at window_ends_at < <(node -e '
const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 30 * 60 * 1000);
const windowStart = new Date(start.getTime() - 30 * 60 * 1000);
const windowEnd = new Date(start.getTime() + 2 * 60 * 60 * 1000);
process.stdout.write(`${start.toISOString()} ${end.toISOString()} ${windowStart.toISOString()} ${windowEnd.toISOString()}\n`);
')
  calendar_title="Helix Calendar smoke ${suffix}"
  calendar_file=$(mktemp "${TMPDIR:-/tmp}/helix-calendar-smoke.XXXXXX")
  request_capture POST /api/tools/calendar.event.create 202 \
    "$(node -e '
const [title, marker, startsAt, endsAt] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  title,
  description: `Calendar marker: ${marker}`,
  location: "Helix smoke room",
  startsAt,
  endsAt,
  timezone: "UTC",
  attendees: [{
    email: "local-admin@helix.local",
    displayName: "Local Admin",
    responseStatus: "needs_action",
    metadata: { smoke: true },
  }],
  metadata: { smoke: true, marker },
  sendInvitations: false,
}));
' "$calendar_title" "$marker" "$starts_at" "$ends_at")" \
    "calendar.event.create pending" \
    "$calendar_file"
  calendar_pending_id=$(json_field_from_file "$calendar_file" "parsed.pending?.id") || {
    log "response body from calendar.event.create:"
    cat "$calendar_file" >&2
    rm -f "$calendar_file"
    die "calendar.event.create did not return pending.id"
  }
  rm -f "$calendar_file"

  calendar_approve_file=$(mktemp "${TMPDIR:-/tmp}/helix-calendar-approve.XXXXXX")
  request_capture POST "/api/tools/pending/$calendar_pending_id/approve" 200 \
    '{}' \
    "calendar.event.create approve" \
    "$calendar_approve_file"
  calendar_event_id=$(json_field_from_file "$calendar_approve_file" "parsed.output?.id") || {
    log "response body from calendar.event.create approve:"
    cat "$calendar_approve_file" >&2
    rm -f "$calendar_approve_file"
    die "calendar.event.create approval did not return output.id"
  }
  rm -f "$calendar_approve_file"

  request_contains POST /api/tools/calendar.event.list 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ startsAt: process.argv[1], endsAt: process.argv[2], limit: 25 }))' "$window_starts_at" "$window_ends_at")" \
    "Calendar live list" \
    "$calendar_event_id" \
    "$calendar_title"

  request_contains POST /api/tools/calendar.event.respond 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ eventId: process.argv[1], attendeeEmail: "local-admin@helix.local", responseStatus: "accepted" }))' "$calendar_event_id")" \
    "Calendar RSVP respond" \
    "$calendar_event_id" \
    "accepted"

  request_contains POST /api/tools/calendar.find-time 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ attendeeEmails: ["local-admin@helix.local"], windowStartsAt: process.argv[1], windowEndsAt: process.argv[2], durationMinutes: 30, stepMinutes: 30, limit: 5 }))' "$window_starts_at" "$window_ends_at")" \
    "Calendar find time" \
    "slots"

  request_contains POST /mcp 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "calendar-smoke-read", method: "resources/read", params: { uri: `helix://calendar/event/${process.argv[1]}` } }))' "$calendar_event_id")" \
    "Calendar MCP read" \
    "$calendar_title" \
    "$marker"

  if bool_true "$WORKSPACE_SEARCH_SMOKE"; then
    if bool_true "$WORKSPACE_SEARCH_REINDEX"; then
      request POST /api/admin/search/reindex 200 '{"all":true,"pruneStale":false}' status completed
    else
      log "skipping admin search reindex; relying on event-driven indexing"
    fi

    request_search_hit_retry POST /api/tools/search.query \
      "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], types: ["drive"], limit: 10 }))' "$drive_name")" \
      "Drive live global search" \
      20 \
      "drive:$drive_object_id" \
      "drive" \
      "$drive_name"
    request_search_hit_retry GET \
      "$(node -e 'const params = new URLSearchParams({ query: process.argv[1], types: "drive", limit: "10" }); process.stdout.write(`/api/tools/search.query?${params}`);' "$drive_name")" \
      "" \
      "Drive live global GET search" \
      20 \
      "drive:$drive_object_id" \
      "drive" \
      "$drive_name"

    request_search_hit_retry POST /api/tools/search.query \
      "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], types: ["docs"], limit: 10 }))' "$docs_updated_title")" \
      "Docs live global search" \
      20 \
      "docs:$docs_id" \
      "docs" \
      "$docs_updated_title"
    request_search_hit_retry GET \
      "$(node -e 'const params = new URLSearchParams({ query: process.argv[1], types: "docs", limit: "10" }); process.stdout.write(`/api/tools/search.query?${params}`);' "$docs_updated_title")" \
      "" \
      "Docs live global GET search" \
      20 \
      "docs:$docs_id" \
      "docs" \
      "$docs_updated_title"

    request_search_hit_retry POST /api/tools/search.query \
      "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], types: ["calendar"], limit: 10 }))' "$calendar_title")" \
      "Calendar live global search" \
      20 \
      "calendar:$calendar_event_id" \
      "calendar" \
      "$calendar_title"
    request_search_hit_retry GET \
      "$(node -e 'const params = new URLSearchParams({ query: process.argv[1], types: "calendar", limit: "10" }); process.stdout.write(`/api/tools/search.query?${params}`);' "$calendar_title")" \
      "" \
      "Calendar live global GET search" \
      20 \
      "calendar:$calendar_event_id" \
      "calendar" \
      "$calendar_title"
  fi
}

run_cli_command() {
  if [[ -n "$CLI_BIN" ]]; then
    "$CLI_BIN" "$@"
  else
    node packages/cli/dist/index.js "$@"
  fi
}

print_redacted_cli_output() {
  local output_file=${1:?missing output file}
  sed -E \
    -e 's/helix_at_[A-Za-z0-9_-]+/helix_at_[redacted]/g' \
    -e 's/helix_ap_[A-Za-z0-9_-]+/helix_ap_[redacted]/g' \
    "$output_file" >&2
}

run_cli_contains() {
  local label=${1:?missing label}
  shift

  local args=()
  while [[ $# -gt 0 && "$1" != "--expect" ]]; do
    args+=("$1")
    shift
  done
  [[ "${1:-}" == "--expect" ]] || die "$label is missing --expect separator"
  shift

  local output_file
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-cli-smoke.XXXXXX")

  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command "${args[@]}" >"$output_file" 2>&1; then
    log "CLI output from $label:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "$label failed"
  fi

  local needle
  for needle in "$@"; do
    if ! grep -Fq "$needle" "$output_file"; then
      log "CLI output from $label:"
      print_redacted_cli_output "$output_file"
      rm -f "$output_file"
      die "$label output did not contain expected value: $needle"
    fi
  done

  rm -f "$output_file"
  log "ok: CLI $label"
}

run_cli_checks() {
  if [[ -z "$CLI_BIN" && ! -f packages/cli/dist/index.js ]]; then
    die "packages/cli/dist/index.js is missing; run pnpm --filter @helix/cli build or pass --cli-bin"
  fi

  run_cli_contains "login" \
    login --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" --scope "$SCOPE" \
    --expect access_token token_type

  run_cli_contains "OpenAPI tool list" \
    tool list --source openapi \
    --expect mail.search platform.ping

  run_cli_contains "MCP tool list" \
    tool list --source mcp \
    --expect mail.search platform.ping

  run_cli_contains "REST platform.ping" \
    tool call platform.ping --json '{}' \
    --expect '"ok": true' helix-app

  run_cli_contains "MCP platform.ping" \
    tool call platform.ping --transport mcp --json '{}' \
    --expect '"ok": true' helix-app

  run_cli_contains "admin users list" \
    admin users list --limit 1 \
    --expect users

  run_cli_contains "admin audit list" \
    admin audit list --limit 1 \
    --expect records

  if bool_true "$MUTATE"; then
    run_cli_contains "tier set $TIER" \
      tier set "$TIER" \
      --expect '"tier":' "$TIER"
  fi

  if bool_true "$BACKUP_RESTORE"; then
    local restore_args=(restore --from "$BACKUP_ID")
    if bool_true "$BACKUP_RESTORE_ENCRYPTED"; then
      restore_args+=(--encrypted)
    fi
    run_cli_contains "backup dry-run" \
      backup create \
      --expect dry_run backup

    run_cli_contains "restore dry-run" \
      "${restore_args[@]}" \
      --expect dry_run "$BACKUP_ID"
  fi

  if bool_true "$SEEDED_DEMO"; then
    run_cli_contains "seeded MCP resources list" \
      mcp resources list \
      --expect \
      "helix://docs/document/00000000-0000-4000-8000-000000000401" \
      "helix://mail/thread/00000000-0000-4000-8000-000000000601"

    run_cli_contains "seeded MCP Docs read" \
      mcp resources read helix://docs/document/00000000-0000-4000-8000-000000000401 \
      --expect "Quarterly Planning Notes"
  fi
}

run_cli_pending_action_check() {
  if [[ -z "$CLI_BIN" && ! -f packages/cli/dist/index.js ]]; then
    die "packages/cli/dist/index.js is missing; run pnpm --filter @helix/cli build or pass --cli-bin"
  fi

  local output_file pending_id label approve_pending_id password_id revoke_pending_id approve_label
  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-cli-pending.XXXXXX")
  label="helix-smoke-pending-${BACKUP_ID}"

  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command \
      admin app-passwords create \
      --actor-id "$PENDING_ACTOR_ID" \
      --label "$label" \
      --scope mail.read >"$output_file" 2>&1; then
    log "CLI output from pending action create:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action create failed"
  fi

  if ! grep -Fq "pending_confirmation" "$output_file"; then
    log "CLI output from pending action create:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action create did not return pending_confirmation"
  fi

  pending_id=$(node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const id = parsed.pending?.id;
  if (typeof id !== "string" || id.length === 0) process.exit(2);
  process.stdout.write(id);
});
' <"$output_file") || {
    log "CLI output from pending action create:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action create did not include pending.id"
  }
  rm -f "$output_file"
  log "ok: CLI pending action create"

  run_cli_contains "pending action status" \
    action status "$pending_id" \
    --expect pending_confirmation app.passwords.create

  run_cli_contains "pending action cancel" \
    action cancel "$pending_id" \
    --expect cancelled "$pending_id"

  run_cli_contains "cancelled pending action status" \
    action status "$pending_id" \
    --expect cancelled "$pending_id"

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-cli-pending.XXXXXX")
  approve_label="helix-smoke-approve-${BACKUP_ID}"
  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command \
      admin app-passwords create \
      --actor-id "$PENDING_ACTOR_ID" \
      --label "$approve_label" \
      --scope mail.read >"$output_file" 2>&1; then
    log "CLI output from pending action approve setup:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action approve setup failed"
  fi

  approve_pending_id=$(node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const id = parsed.pending?.id;
  if (parsed.status !== "pending_confirmation" || typeof id !== "string" || id.length === 0) {
    process.exit(2);
  }
  process.stdout.write(id);
});
' <"$output_file") || {
    log "CLI output from pending action approve setup:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action approve setup did not include pending.id"
  }
  rm -f "$output_file"
  log "ok: CLI pending action approve setup"

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-cli-pending.XXXXXX")
  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command action approve "$approve_pending_id" >"$output_file" 2>&1; then
    log "CLI output from pending action approve:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action approve failed"
  fi

  password_id=$(node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const id = parsed.output?.appPassword?.id;
  if (parsed.status !== "executed" || typeof id !== "string" || id.length === 0) {
    process.exit(2);
  }
  process.stdout.write(id);
});
' <"$output_file") || {
    log "CLI output from pending action approve:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action approve did not execute or return output.appPassword.id"
  }

  if ! grep -Fq "helix_ap_" "$output_file"; then
    log "CLI output from pending action approve:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action approve did not return a one-time app password"
  fi
  rm -f "$output_file"
  log "ok: CLI pending action approve"

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-cli-pending.XXXXXX")
  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command admin app-passwords revoke --password-id "$password_id" >"$output_file" 2>&1; then
    log "CLI output from pending action revoke setup:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action revoke setup failed"
  fi

  revoke_pending_id=$(node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const id = parsed.pending?.id;
  if (parsed.status !== "pending_confirmation" || typeof id !== "string" || id.length === 0) {
    process.exit(2);
  }
  process.stdout.write(id);
});
' <"$output_file") || {
    log "CLI output from pending action revoke setup:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "CLI pending action revoke setup did not include pending.id"
  }
  rm -f "$output_file"
  log "ok: CLI pending action revoke setup"

  run_cli_contains "pending action revoke approve" \
    action approve "$revoke_pending_id" \
    --expect executed revoked "$password_id"
}

run_events_ws_check() {
  HELIX_BASE_URL="$BASE_URL" HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" node <<'NODE'
const baseUrl = process.env.HELIX_BASE_URL;
const token = process.env.HELIX_ACCESS_TOKEN;
if (!baseUrl || !token) {
  console.error("HELIX_BASE_URL and HELIX_ACCESS_TOKEN are required.");
  process.exit(2);
}

const url = new URL("/events/ws", baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("subject", "helix.config.changed");
url.searchParams.set("access_token", token);

const socket = new WebSocket(url.href);
let opened = false;
let settled = false;

async function triggerConfigEvent() {
  const configResponse = await fetch(new URL("/api/admin/platform-config", baseUrl), {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (!configResponse.ok) {
    throw new Error(`platform config read returned HTTP ${configResponse.status}`);
  }
  const configStatus = await configResponse.json();
  const tier = configStatus?.config?.security?.tier;
  if (typeof tier !== "string" || tier.length === 0) {
    throw new Error("platform config read did not return config.security.tier");
  }
  const updateResponse = await fetch(new URL("/api/admin/platform-config", baseUrl), {
    method: "PATCH",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ security: { tier } }),
  });
  if (!updateResponse.ok) {
    throw new Error(`platform config PATCH returned HTTP ${updateResponse.status}`);
  }
}

const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  try {
    socket.close(1000, "smoke complete");
  } catch {}
  if (opened) {
    console.error("events websocket authenticated but did not receive helix.config.changed");
    process.exit(1);
  }
  console.error("events websocket did not open or close within timeout");
  process.exit(1);
}, 3000);

socket.addEventListener("open", () => {
  opened = true;
  triggerConfigEvent().catch((error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try {
      socket.close(1011, "smoke trigger failed");
    } catch {}
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
});

socket.addEventListener("message", (event) => {
  if (settled) return;
  let parsed;
  try {
    parsed = JSON.parse(String(event.data));
  } catch {
    console.error("events websocket received non-JSON message");
    settled = true;
    clearTimeout(timeout);
    socket.close(1002, "invalid smoke message");
    process.exit(1);
  }
  if (
    parsed?.subject === "helix.config.changed" &&
    Array.isArray(parsed?.payload?.keys) &&
    parsed.payload.keys.includes("security") &&
    typeof parsed?.payload?.actorId === "string" &&
    typeof parsed?.occurredAt === "string"
  ) {
    settled = true;
    clearTimeout(timeout);
    socket.close(1000, "smoke complete");
    console.log("events websocket delivered helix.config.changed");
    process.exit(0);
  }
  console.error(`events websocket received unexpected message: ${String(event.data)}`);
  settled = true;
  clearTimeout(timeout);
  socket.close(1002, "unexpected smoke message");
  process.exit(1);
});

socket.addEventListener("close", (event) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (opened && event.code === 1000) {
    console.log("events websocket authenticated and closed cleanly");
    process.exit(0);
  }
  console.error(
    `events websocket closed unexpectedly: code=${event.code} reason=${event.reason}`,
  );
  process.exit(1);
});

socket.addEventListener("error", () => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  console.error("events websocket connection failed");
  process.exit(1);
});
NODE
  log "ok: authenticated /events/ws websocket"
}

run_chat_realtime_smoke() {
  local suffix marker room_subject room_file room_id message_file message_id status
  suffix=$(date +%Y%m%d%H%M%S)
  marker="helix-chat-smoke-${suffix}"
  room_subject="Helix chat smoke $suffix"
  room_file=$(mktemp "${TMPDIR:-/tmp}/helix-chat-room.XXXXXX")

  status=$(curl_with_trace -sS \
    -o "$room_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "$(node -e 'process.stdout.write(JSON.stringify({ subject: process.argv[1], topic: "Live smoke websocket fanout", isPrivate: false, metadata: { smoke: true } }))' "$room_subject")" \
    "$(api_url /api/tools/chat.create_room)")
  if [[ "$status" != "200" ]]; then
    log "response body from chat.create_room:"
    cat "$room_file" >&2
    rm -f "$room_file"
    die "chat.create_room returned HTTP $status, expected 200"
  fi
  room_id=$(json_field_from_file "$room_file" "parsed.id") || {
    log "response body from chat.create_room:"
    cat "$room_file" >&2
    rm -f "$room_file"
    die "chat.create_room did not return id"
  }
  rm -f "$room_file"
  log "ok: chat room created -> 200"

  message_file=$(mktemp "${TMPDIR:-/tmp}/helix-chat-message.XXXXXX")
  HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_CHAT_ROOM_ID="$room_id" \
    HELIX_CHAT_MARKER="$marker" \
    HELIX_CHAT_MESSAGE_FILE="$message_file" \
    node <<'NODE'
const fs = require("node:fs");
const baseUrl = process.env.HELIX_BASE_URL;
const token = process.env.HELIX_ACCESS_TOKEN;
const roomId = process.env.HELIX_CHAT_ROOM_ID;
const marker = process.env.HELIX_CHAT_MARKER;
const messageFile = process.env.HELIX_CHAT_MESSAGE_FILE;
if (!baseUrl || !token || !roomId || !marker || !messageFile) {
  console.error("HELIX_BASE_URL, HELIX_ACCESS_TOKEN, HELIX_CHAT_ROOM_ID, HELIX_CHAT_MARKER, and HELIX_CHAT_MESSAGE_FILE are required.");
  process.exit(2);
}

const url = new URL("/ws/chat", baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.searchParams.set("access_token", token);

const sockets = [];
const timeout = setTimeout(() => {
  cleanup();
  console.error("chat realtime smoke timed out");
  process.exit(1);
}, 10_000);

function cleanup() {
  clearTimeout(timeout);
  for (const socket of sockets) {
    try {
      socket.close(1000, "smoke complete");
    } catch {}
  }
}

function connect(name) {
  const socket = new WebSocket(url.href);
  sockets.push(socket);
  const backlog = [];
  const waiters = [];

  socket.addEventListener("message", (event) => {
    let parsed;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex((waiter) => waiter.match(parsed));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }
    backlog.push(parsed);
  });

  socket.addEventListener("error", () => {
    cleanup();
    console.error(`${name} chat websocket failed`);
    process.exit(1);
  });

  function waitFor(match, label) {
    const backlogIndex = backlog.findIndex(match);
    if (backlogIndex >= 0) {
      const [event] = backlog.splice(backlogIndex, 1);
      return Promise.resolve(event);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${name} did not receive ${label}`));
      }, 5000);
      waiters.push({ match, resolve, timer });
    });
  }

  return {
    socket,
    send: (payload) => socket.send(JSON.stringify(payload)),
    waitFor,
  };
}

async function main() {
  const sender = connect("sender");
  const receiver = connect("receiver");

  await Promise.all([
    sender.waitFor((event) => event.type === "ready", "ready"),
    receiver.waitFor((event) => event.type === "ready", "ready"),
  ]);

  sender.send({ type: "subscribe", roomId });
  receiver.send({ type: "subscribe", roomId });
  await Promise.all([
    sender.waitFor((event) => event.type === "subscribed" && event.roomId === roomId, "subscribed"),
    receiver.waitFor((event) => event.type === "subscribed" && event.roomId === roomId, "subscribed"),
  ]);

  sender.send({ type: "typing", roomId, isTyping: true });
  await receiver.waitFor(
    (event) => event.type === "typing" && event.roomId === roomId && event.isTyping === true,
    "typing",
  );

  sender.send({ type: "send", roomId, body: `Realtime marker: ${marker}`, bodyFormat: "plain" });
  const created = await receiver.waitFor(
    (event) =>
      event.type === "message.created" &&
      event.roomId === roomId &&
      typeof event.message?.id === "string" &&
      event.message?.body?.includes(marker),
    "message.created",
  );

  receiver.send({ type: "read", roomId, messageId: created.message.id });
  await sender.waitFor(
    (event) =>
      event.type === "read" &&
      event.roomId === roomId &&
      event.receipt?.lastReadMessageId === created.message.id,
    "read",
  );

  fs.writeFileSync(messageFile, JSON.stringify({ messageId: created.message.id }), "utf8");
  cleanup();
}

main()
  .then(() => {
    console.log("chat realtime websocket fanout passed");
    process.exit(0);
  })
  .catch((error) => {
    cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
NODE
  message_id=$(json_field_from_file "$message_file" "parsed.messageId") || {
    log "response body from chat websocket message capture:"
    cat "$message_file" >&2
    rm -f "$message_file"
    die "chat realtime smoke did not capture message id"
  }
  rm -f "$message_file"
  log "ok: chat realtime websocket fanout"

  request_contains_retry POST /api/tools/chat.search 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], roomId: process.argv[2], limit: 10 }))' "$marker" "$room_id")" \
    "chat realtime message searchable" \
    10 \
    "$room_id" \
    "$marker"

  if bool_true "$MAIL_CHAT_SEARCH_SMOKE"; then
    if bool_true "$MAIL_CHAT_SEARCH_REINDEX"; then
      run_global_search_reindex_for_live_markers
    else
      log "skipping admin search reindex; relying on Mail/Chat event-driven indexing"
    fi
    request_search_text_retry POST /api/tools/search.query \
      "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], types: ["chat"], limit: 10 }))' "$marker")" \
      "Chat live global search" \
      20 \
      "chat" \
      "chat:$message_id" \
      "$room_id" \
      "/chat/$room_id?message=$message_id" \
      "$room_subject" \
      "$marker"
  fi
}

run_meet_smoke() {
  local suffix subject room_file room_id room_org_id room_name token_file webhook_file recording_key list_file end_file ended_list_file status
  suffix=$(date +%Y%m%d%H%M%S)
  subject="Helix Meet smoke $suffix"
  room_file=$(mktemp "${TMPDIR:-/tmp}/helix-meet-room.XXXXXX")

  request_capture POST /api/tools/meet.create-room 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ subject: process.argv[1], roomName: process.argv[1], jitsiDomain: process.argv[2], metadata: { smoke: true } }))' "$subject" "$MEET_SMOKE_JITSI_DOMAIN")" \
    "meet.create-room" \
    "$room_file"
  room_id=$(json_field_from_file "$room_file" "parsed.id") || {
    log "response body from meet.create-room:"
    cat "$room_file" >&2
    rm -f "$room_file"
    die "meet.create-room did not return id"
  }
  room_org_id=$(json_field_from_file "$room_file" "parsed.orgId") || {
    room_org_id="$MEET_SMOKE_ORG_ID"
  }
  room_name=$(json_field_from_file "$room_file" "parsed.roomName") || {
    log "response body from meet.create-room:"
    cat "$room_file" >&2
    rm -f "$room_file"
    die "meet.create-room did not return roomName"
  }
  rm -f "$room_file"

  token_file=$(mktemp "${TMPDIR:-/tmp}/helix-meet-token.XXXXXX")
  request_capture POST /api/tools/meet.mint-token 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ roomId: process.argv[1], moderator: true, expiresInSeconds: 600 }))' "$room_id")" \
    "meet.mint-token" \
    "$token_file"
  node -e '
const fs = require("node:fs");
const [file, roomId, roomName, domain] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
if (
  parsed.roomId !== roomId ||
  parsed.roomName !== roomName ||
  parsed.jitsiDomain !== domain ||
  typeof parsed.token !== "string" ||
  parsed.token.split(".").length !== 3 ||
  typeof parsed.joinUrl !== "string" ||
  !parsed.joinUrl.startsWith(`https://${domain}/${encodeURIComponent(roomName)}?`) ||
  !parsed.joinUrl.includes("jwt=")
) {
  process.exit(2);
}
' "$token_file" "$room_id" "$room_name" "$MEET_SMOKE_JITSI_DOMAIN" || {
    log "response body from meet.mint-token:"
    cat "$token_file" >&2
    rm -f "$token_file"
    die "meet.mint-token did not return a valid room JWT/joinUrl"
  }
  rm -f "$token_file"
  log "ok: Meet JWT minted"

  recording_key="recordings/live-smoke-${suffix}.webm"
  webhook_file=$(mktemp "${TMPDIR:-/tmp}/helix-meet-webhook-bad.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$webhook_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "x-helix-org-id: $room_org_id" \
    -H 'x-helix-jitsi-secret: definitely-wrong' \
    --data "$(node -e 'process.stdout.write(JSON.stringify({ event_name: "RECORDING_UPLOAD_FINISHED", room_id: process.argv[1], storage_key: process.argv[2] }))' "$room_id" "$recording_key")" \
    "$(api_url /webhook/jitsi)")
  if [[ "$status" != "401" ]] || ! grep -Fq 'Invalid Jitsi webhook secret.' "$webhook_file"; then
    log "response body from invalid /webhook/jitsi:"
    cat "$webhook_file" >&2
    rm -f "$webhook_file"
    die "invalid /webhook/jitsi secret returned HTTP $status, expected 401"
  fi
  rm -f "$webhook_file"
  log "ok: invalid Meet recording webhook secret rejected"

  webhook_file=$(mktemp "${TMPDIR:-/tmp}/helix-meet-webhook.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$webhook_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "x-helix-org-id: $room_org_id" \
    -H "x-helix-jitsi-secret: $MEET_SMOKE_WEBHOOK_SECRET" \
    --data "$(node -e 'process.stdout.write(JSON.stringify({ event_name: "RECORDING_UPLOAD_FINISHED", room_id: process.argv[1], room_name: process.argv[2], storage_key: process.argv[3], mime_type: "video/webm", byte_size: 128, started_at: process.argv[4], ended_at: process.argv[5], metadata: { smoke: true } }))' "$room_id" "$room_name" "$recording_key" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" \
    "$(api_url /webhook/jitsi)")
  if [[ "$status" != "200" ]]; then
    log "response body from /webhook/jitsi:"
    cat "$webhook_file" >&2
    rm -f "$webhook_file"
    die "/webhook/jitsi returned HTTP $status, expected 200"
  fi
  node -e '
const fs = require("node:fs");
const [file, roomId, storageKey] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
if (
  parsed?.ok !== true ||
  parsed?.attachment?.roomId !== roomId ||
  parsed?.attachment?.storageKey !== storageKey ||
  typeof parsed?.attachment?.objectId !== "string"
) {
  process.exit(2);
}
' "$webhook_file" "$room_id" "$recording_key" || {
    log "response body from /webhook/jitsi:"
    cat "$webhook_file" >&2
    rm -f "$webhook_file"
    die "/webhook/jitsi did not attach the recording artifact"
  }
  rm -f "$webhook_file"
  log "ok: Meet recording webhook attached artifact"

  list_file=$(mktemp "${TMPDIR:-/tmp}/helix-meet-list.XXXXXX")
  request_capture POST /api/tools/meet.room.list 200 \
    '{"status":"active","limit":25}' \
    "meet.room.list" \
    "$list_file"
  node -e '
const fs = require("node:fs");
const [file, roomId, storageKey] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
const room = rooms.find((candidate) => candidate.id === roomId);
if (
  room === undefined ||
  room.status !== "active" ||
  !Array.isArray(room.recordingArtifacts) ||
  !room.recordingArtifacts.some((artifact) => artifact.storageKey === storageKey)
) {
  process.exit(2);
}
' "$list_file" "$room_id" "$recording_key" || {
    log "response body from meet.room.list:"
    cat "$list_file" >&2
    rm -f "$list_file"
    die "meet.room.list did not return the active room and recording artifact"
  }
  rm -f "$list_file"
  log "ok: Meet room list includes recording artifact"

  end_file=$(mktemp "${TMPDIR:-/tmp}/helix-meet-end.XXXXXX")
  request_capture POST /api/tools/meet.end-room 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ roomId: process.argv[1] }))' "$room_id")" \
    "meet.end-room" \
    "$end_file"
  node -e '
const fs = require("node:fs");
const [file, roomId] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
if (parsed.id !== roomId || parsed.status !== "ended" || typeof parsed.endedAt !== "string") {
  process.exit(2);
}
' "$end_file" "$room_id" || {
    log "response body from meet.end-room:"
    cat "$end_file" >&2
    rm -f "$end_file"
    die "meet.end-room did not return ended room state"
  }
  rm -f "$end_file"
  log "ok: Meet room ended"

  ended_list_file=$(mktemp "${TMPDIR:-/tmp}/helix-meet-ended-list.XXXXXX")
  request_capture POST /api/tools/meet.room.list 200 \
    '{"status":"ended","limit":10}' \
    "meet.room.list ended" \
    "$ended_list_file"
  node -e '
const fs = require("node:fs");
const [file, roomId, storageKey] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
const room = rooms.find((candidate) => candidate.id === roomId);
if (
  room === undefined ||
  room.status !== "ended" ||
  typeof room.endedAt !== "string" ||
  !Array.isArray(room.recordingArtifacts) ||
  !room.recordingArtifacts.some((artifact) => artifact.storageKey === storageKey)
) {
  process.exit(2);
}
' "$ended_list_file" "$room_id" "$recording_key" || {
    log "response body from ended meet.room.list:"
    cat "$ended_list_file" >&2
    rm -f "$ended_list_file"
    die "meet.room.list did not return the ended room and recording artifact"
  }
  rm -f "$ended_list_file"
  log "ok: Meet ended room list includes recording artifact"
}

run_assistant_smoke() {
  local output_file status conversation_id pending_id approve_pending_id

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-smoke.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$output_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data '{"title":"Helix live smoke assistant","memoryOptIn":true}' \
    "$(api_url /api/tools/assistant.conversation.create)")
  if [[ "$status" != "200" ]]; then
    log "response body from assistant conversation create:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant conversation create returned HTTP $status, expected 200"
  fi
  conversation_id=$(node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  if (typeof parsed.id !== "string" || parsed.memoryOptIn !== true) process.exit(2);
  process.stdout.write(parsed.id);
});
' <"$output_file") || {
    log "response body from assistant conversation create:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant conversation create did not return id with memoryOptIn=true"
  }
  rm -f "$output_file"
  log "ok: assistant conversation create -> 200"

  run_assistant_chat_check "$conversation_id" "/draft a concise project update" "Draft ready."
  run_assistant_chat_check "$conversation_id" "/summarize the local testing notes" "Summary ready."
  run_assistant_chat_check "$conversation_id" "/find Renovate mail" "I found the most relevant visible workspace context"
  run_assistant_chat_check "$conversation_id" "/schedule product review follow-up" "I can help schedule this"
  assert_assistant_llm_metrics

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-smoke.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$output_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "{\"conversationId\":\"$conversation_id\",\"all\":true}" \
    "$(api_url /api/tools/assistant.memory.forget)")
  if [[ "$status" != "202" ]]; then
    log "response body from assistant memory forget:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant memory forget returned HTTP $status, expected 202"
  fi
  pending_id=$(node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const id = parsed.pending?.id;
  if (
    parsed.status !== "pending_confirmation" ||
    parsed.pending?.toolId !== "assistant.memory.forget" ||
    typeof id !== "string"
  ) {
    process.exit(2);
  }
  process.stdout.write(id);
});
' <"$output_file") || {
    log "response body from assistant memory forget:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant memory forget did not return assistant.memory.forget pending confirmation"
  }
  rm -f "$output_file"
  log "ok: assistant memory forget pending -> 202"

  request_contains POST /api/tools/assistant.confirmation.cancel 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ conversationId: process.argv[1], pendingId: process.argv[2] }))' "$conversation_id" "$pending_id")" \
    "assistant memory forget assistant-native cancel" \
    "$pending_id" \
    "skipped" \
    "Pending assistant tool action was cancelled by the actor."

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-smoke.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$output_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "{\"conversationId\":\"$conversation_id\",\"all\":true}" \
    "$(api_url /api/tools/assistant.memory.forget)")
  if [[ "$status" != "202" ]]; then
    log "response body from second assistant memory forget:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "second assistant memory forget returned HTTP $status, expected 202"
  fi
  approve_pending_id=$(json_field_from_file "$output_file" "parsed.pending?.id") || {
    log "response body from second assistant memory forget:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "second assistant memory forget did not return pending.id"
  }
  rm -f "$output_file"
  log "ok: assistant memory forget second pending -> 202"

  request_contains POST /api/tools/assistant.confirmation.approve 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ conversationId: process.argv[1], pendingId: process.argv[2] }))' "$conversation_id" "$approve_pending_id")" \
    "assistant memory forget assistant-native approve" \
    "$approve_pending_id" \
    "executed" \
    "assistant.memory.forget"
}

run_assistant_chat_check() {
  local conversation_id=${1:?missing conversation id}
  local message=${2:?missing assistant message}
  local expected_text=${3:?missing expected assistant text}
  local output_file status

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-smoke.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$output_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "$(node -e 'process.stdout.write(JSON.stringify({ conversationId: process.argv[1], message: process.argv[2], memoryOptIn: true }))' "$conversation_id" "$message")" \
    "$(api_url /api/tools/assistant.chat)")
  if [[ "$status" != "200" ]]; then
    log "response body from assistant chat:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant chat returned HTTP $status, expected 200"
  fi
  node -e '
const expectedText = process.argv[1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  if (
    parsed.response?.metadata?.providerId !== "assistant.local" ||
    parsed.response?.metadata?.model !== "deterministic-assistant" ||
    typeof parsed.response?.content !== "string" ||
    !parsed.response.content.includes(expectedText)
  ) {
    process.exit(2);
  }
});
' "$expected_text" <"$output_file" || {
    log "response body from assistant chat:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant chat response did not match deterministic assistant expectations"
  }
  rm -f "$output_file"
  log "ok: assistant chat '$message' -> 200"
}

assert_assistant_llm_metrics() {
  local metrics_file
  metrics_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-metrics.XXXXXX")
  curl_with_trace -fsS "$(api_url /metrics)" -o "$metrics_file"
  grep -E '^helix_llm_calls_total\{provider="assistant\.local",model="deterministic-assistant",feature="assistant\.chat",status="success"\} [1-9][0-9]*$' "$metrics_file" >/dev/null || {
    log "metrics output from /metrics:"
    cat "$metrics_file" >&2
    rm -f "$metrics_file"
    die "assistant smoke did not emit helix_llm_calls_total for deterministic assistant"
  }
  grep -E '^helix_llm_latency_seconds_count\{provider="assistant\.local",model="deterministic-assistant",feature="assistant\.chat",status="success"\} [1-9][0-9]*$' "$metrics_file" >/dev/null || {
    log "metrics output from /metrics:"
    cat "$metrics_file" >&2
    rm -f "$metrics_file"
    die "assistant smoke did not emit helix_llm_latency_seconds_count for deterministic assistant"
  }
  grep -E '^helix_llm_cost_usd_micros_total\{provider="assistant\.local",model="deterministic-assistant",feature="assistant\.chat"\} [0-9]+$' "$metrics_file" >/dev/null || {
    log "metrics output from /metrics:"
    cat "$metrics_file" >&2
    rm -f "$metrics_file"
    die "assistant smoke did not emit helix_llm_cost_usd_micros_total for deterministic assistant"
  }
  rm -f "$metrics_file"
  log "ok: assistant LLM call, latency, and cost metrics emitted"
}

run_assistant_provider_smoke() {
  local output_file status conversation_id provider_model provider_id model

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-provider-smoke.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$output_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data '{"title":"Helix provider-backed assistant smoke","memoryOptIn":false}' \
    "$(api_url /api/tools/assistant.conversation.create)")
  if [[ "$status" != "200" ]]; then
    log "response body from assistant provider conversation create:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant provider conversation create returned HTTP $status, expected 200"
  fi
  conversation_id=$(json_field_from_file "$output_file" "parsed.id") || {
    log "response body from assistant provider conversation create:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant provider conversation create did not return id"
  }
  rm -f "$output_file"
  log "ok: assistant provider conversation create -> 200"

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-provider-smoke.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$output_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "$(node -e 'process.stdout.write(JSON.stringify({ conversationId: process.argv[1], message: process.argv[2], memoryOptIn: false, classification: "public" }))' "$conversation_id" "$ASSISTANT_PROVIDER_PROMPT")" \
    "$(api_url /api/tools/assistant.chat)")
  if [[ "$status" != "200" ]]; then
    log "response body from assistant provider chat:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "assistant provider chat returned HTTP $status, expected 200"
  fi

  provider_model=$(node -e '
const [expectedProvider, expectedModel, expectedText] = process.argv.slice(1);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const providerId = parsed.ai?.providerId;
  const model = parsed.ai?.model;
  const message = parsed.ai?.message ?? parsed.response?.content;
  const provenanceId = parsed.ai?.metadata?.provenanceId;
  if (typeof providerId !== "string" || providerId.length === 0) process.exit(2);
  if (providerId === "assistant.local") process.exit(3);
  if (expectedProvider.length > 0 && providerId !== expectedProvider) process.exit(4);
  if (typeof model !== "string" || model.length === 0) process.exit(5);
  if (expectedModel.length > 0 && model !== expectedModel) process.exit(6);
  if (typeof message !== "string" || message.trim().length === 0) process.exit(7);
  if (
    expectedText.length > 0 &&
    !message.toLowerCase().includes(expectedText.toLowerCase())
  ) {
    process.exit(8);
  }
  if (typeof provenanceId !== "string" || provenanceId.length === 0) process.exit(9);
  process.stdout.write(`${providerId}\t${model}`);
});
' "$ASSISTANT_PROVIDER_ID" "$ASSISTANT_PROVIDER_MODEL" "$ASSISTANT_PROVIDER_EXPECT" <"$output_file") || {
    local parse_status=$?
    log "response body from assistant provider chat:"
    cat "$output_file" >&2
    rm -f "$output_file"
    case "$parse_status" in
      3) die "assistant provider smoke routed to assistant.local; start the app with ASSISTANT_AI_PROVIDER_ID or AI routing pointed at a real provider" ;;
      4) die "assistant provider smoke did not use expected provider $ASSISTANT_PROVIDER_ID" ;;
      6) die "assistant provider smoke did not use expected model $ASSISTANT_PROVIDER_MODEL" ;;
      8) die "assistant provider smoke response did not contain expected text: $ASSISTANT_PROVIDER_EXPECT" ;;
      9) die "assistant provider smoke did not surface ai.metadata.provenanceId" ;;
      *) die "assistant provider smoke response did not match provider/provenance expectations" ;;
    esac
  }
  rm -f "$output_file"
  provider_id=${provider_model%%$'\t'*}
  model=${provider_model#*$'\t'}
  log "ok: assistant provider chat used $provider_id/$model and surfaced provenance"
  assert_assistant_provider_metrics "$provider_id" "$model"
}

assert_assistant_provider_metrics() {
  local provider_id=${1:?missing provider id}
  local model=${2:?missing model}
  local metrics_file
  metrics_file=$(mktemp "${TMPDIR:-/tmp}/helix-assistant-provider-metrics.XXXXXX")
  curl_with_trace -fsS "$(api_url /metrics)" -o "$metrics_file"
  node -e '
const [file, providerId, model] = process.argv.slice(1);
const text = require("node:fs").readFileSync(file, "utf8");
const metricNames = new Set([
  "helix_llm_calls_total",
  "helix_llm_latency_seconds_count",
  "helix_llm_cost_usd_micros_total",
]);
const found = new Set();
for (const line of text.split(/\n/u)) {
  const match = line.match(/^(helix_llm_[a-z_]+(?:_total|_count))\{([^}]*)\}\s+([0-9.e+-]+)/u);
  if (match === null || !metricNames.has(match[1])) continue;
  const labels = Object.fromEntries(
    match[2].split(",").map((part) => {
      const [key, rawValue = ""] = part.split("=");
      return [key, rawValue.replace(/^"|"$/g, "").replace(/\\"/g, "\"")];
    }),
  );
  if (
    labels.provider === providerId &&
    labels.model === model &&
    labels.feature === "assistant.chat" &&
    (labels.status === undefined || labels.status === "success") &&
    Number(match[3]) > 0
  ) {
    found.add(match[1]);
  }
}
for (const name of metricNames) {
  if (!found.has(name)) process.exit(2);
}
' "$metrics_file" "$provider_id" "$model" || {
    log "metrics output from /metrics:"
    cat "$metrics_file" >&2
    rm -f "$metrics_file"
    die "assistant provider smoke did not emit provider-specific LLM metrics"
  }
  rm -f "$metrics_file"
  log "ok: assistant provider LLM metrics emitted for $provider_id/$model"
}

run_webdav_smoke() {
  local suffix label create_file pending_id approve_file password_id app_password revoke_file revoke_pending_id
  suffix=$(date +%Y%m%d%H%M%S)
  label="helix-webdav-smoke-${suffix}"

  create_file=$(mktemp "${TMPDIR:-/tmp}/helix-webdav-app-password.XXXXXX")
  request_capture POST /api/tools/app.passwords.create 202 \
    "$(node -e '
const [actorId, label] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ actorId, label, scopes: ["webdav"] }));
' "$APP_PASSWORD_ACTOR_ID" "$label")" \
    "WebDAV app-password create pending" \
    "$create_file"
  pending_id=$(json_field_from_file "$create_file" "parsed.pending?.id") || {
    log "response body from WebDAV app-password create:"
    cat "$create_file" >&2
    rm -f "$create_file"
    die "WebDAV app-password create did not return pending.id"
  }
  rm -f "$create_file"

  approve_file=$(mktemp "${TMPDIR:-/tmp}/helix-webdav-app-password.XXXXXX")
  request_capture POST "/api/tools/pending/$pending_id/approve" 200 \
    '{}' \
    "WebDAV app-password create approve" \
    "$approve_file"
  password_id=$(json_field_from_file "$approve_file" "parsed.output?.appPassword?.id") || {
    log "response body from WebDAV app-password approve:"
    cat "$approve_file" >&2
    rm -f "$approve_file"
    die "WebDAV app-password approve did not return output.appPassword.id"
  }
  app_password=$(json_field_from_file "$approve_file" "parsed.output?.password") || {
    log "response body from WebDAV app-password approve:"
    cat "$approve_file" >&2
    rm -f "$approve_file"
    die "WebDAV app-password approve did not return one-time password"
  }
  rm -f "$approve_file"

  HELIX_BASE_URL="$BASE_URL" \
    HELIX_WEBDAV_USERNAME="$APP_PASSWORD_USERNAME" \
    HELIX_WEBDAV_PASSWORD="$app_password" \
    HELIX_WEBDAV_SUFFIX="$suffix" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    node <<'NODE'
const { createHash, randomBytes } = require("node:crypto");

const baseUrl = process.env.HELIX_BASE_URL;
const username = process.env.HELIX_WEBDAV_USERNAME;
const password = process.env.HELIX_WEBDAV_PASSWORD;
const suffix = process.env.HELIX_WEBDAV_SUFFIX;
const traceToken = process.env.HELIX_TRACE_TOKEN ?? "";
if (!baseUrl || !username || !password || !suffix) {
  console.error("HELIX_BASE_URL, HELIX_WEBDAV_USERNAME, HELIX_WEBDAV_PASSWORD, and HELIX_WEBDAV_SUFFIX are required.");
  process.exit(2);
}

const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
const folderName = `HelixWebDavSmoke-${suffix}`;
const fileName = `note-${suffix}.txt`;
const marker = `webdav smoke marker ${suffix}`;

function url(path) {
  return new URL(path, baseUrl).href;
}

function traceHeaders() {
  const token = traceToken.trim();
  if (token.length === 0) return {};
  const lower = token.toLowerCase();
  const traceId = /^[0-9a-f]{32}$/.test(lower)
    ? lower
    : createHash("sha256").update(`trace:${token}`).digest("hex").slice(0, 32);
  const parentId = randomBytes(8).toString("hex");
  return { traceparent: `00-${traceId}-${parentId}-01` };
}

async function request(method, path, expectedStatus, options = {}) {
  const headers = {
    accept: "*/*",
    ...traceHeaders(),
    ...(options.auth === false ? {} : { authorization: `Basic ${basic}` }),
    ...(options.headers ?? {}),
  };
  const response = await fetch(url(path), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    console.error(`${method} ${path} returned HTTP ${response.status}, expected ${expectedStatus}`);
    console.error(text);
    process.exit(1);
  }
  for (const [header, expected] of Object.entries(options.headersContain ?? {})) {
    const value = response.headers.get(header);
    if (value === null || !value.includes(expected)) {
      console.error(`${method} ${path} response header ${header} did not contain ${expected}; got ${value}`);
      process.exit(1);
    }
  }
  for (const expected of options.contains ?? []) {
    if (!text.includes(expected)) {
      console.error(`${method} ${path} response did not contain ${expected}`);
      console.error(text);
      process.exit(1);
    }
  }
  if (options.requireHeader !== undefined && response.headers.get(options.requireHeader) === null) {
    console.error(`${method} ${path} response did not include ${options.requireHeader}`);
    process.exit(1);
  }
  return { response, text };
}

async function main() {
  const folderPath = `/dav/files/${folderName}`;
  const filePath = `${folderPath}/${fileName}`;
  await request("PROPFIND", "/dav/files/", 401, {
    auth: false,
    headers: { depth: "0", "content-type": "application/xml" },
    body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname /></D:prop></D:propfind>',
    headersContain: { "www-authenticate": 'Basic realm="Helix WebDAV"' },
  });
  await request("PROPFIND", "/dav/files/", 207, {
    headers: { depth: "0", "content-type": "application/xml" },
    body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname /></D:prop></D:propfind>',
    contains: ["/dav/files/"],
  });
  await request("MKCOL", folderPath, 201);
  await request("PUT", filePath, 201, {
    headers: {
      "if-none-match": "*",
      "content-type": "text/plain; charset=utf-8",
    },
    body: marker,
    requireHeader: "etag",
  });
  const { response: lockResponse } = await request("LOCK", filePath, 200, {
    headers: {
      depth: "0",
      timeout: "Second-60",
      "content-type": "application/xml",
    },
    body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>helix-live-smoke</D:href></D:owner></D:lockinfo>',
    requireHeader: "lock-token",
    contains: ["lockdiscovery", "activelock"],
  });
  const lockToken = lockResponse.headers.get("lock-token");
  if (lockToken === null || !lockToken.includes("opaquelocktoken:")) {
    console.error(`LOCK did not return a usable Lock-Token; got ${lockToken}`);
    process.exit(1);
  }
  await request("PUT", filePath, 423, {
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "blocked while locked",
  });
  await request("PUT", filePath, 204, {
    headers: {
      if: `(${lockToken})`,
      "content-type": "text/plain; charset=utf-8",
    },
    body: marker,
    requireHeader: "etag",
  });
  await request("PROPFIND", `${folderPath}/`, 207, {
    headers: { depth: "1", "content-type": "application/xml" },
    body: '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag /><D:getcontentlength /></D:prop></D:propfind>',
    contains: [filePath, "getetag", "getcontentlength"],
  });
  await request("UNLOCK", filePath, 204, {
    headers: { "lock-token": lockToken },
  });
  await request("GET", filePath, 200, {
    contains: [marker],
    requireHeader: "etag",
  });
  await request("DELETE", filePath, 204);
  await request("DELETE", `${folderPath}/`, 204);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
NODE
  log "ok: WebDAV app-password byte round-trip"

  revoke_file=$(mktemp "${TMPDIR:-/tmp}/helix-webdav-app-password.XXXXXX")
  request_capture POST /api/tools/app.passwords.revoke 202 \
    "$(node -e 'process.stdout.write(JSON.stringify({ passwordId: process.argv[1] }))' "$password_id")" \
    "WebDAV app-password revoke pending" \
    "$revoke_file"
  revoke_pending_id=$(json_field_from_file "$revoke_file" "parsed.pending?.id") || {
    log "response body from WebDAV app-password revoke:"
    cat "$revoke_file" >&2
    rm -f "$revoke_file"
    die "WebDAV app-password revoke did not return pending.id"
  }
  rm -f "$revoke_file"

  request_contains POST "/api/tools/pending/$revoke_pending_id/approve" 200 \
    '{}' \
    "WebDAV app-password revoke approve" \
    "$password_id" \
    "revoked"

  HELIX_BASE_URL="$BASE_URL" \
    HELIX_WEBDAV_USERNAME="$APP_PASSWORD_USERNAME" \
    HELIX_WEBDAV_PASSWORD="$app_password" \
    node <<'NODE'
const baseUrl = process.env.HELIX_BASE_URL;
const username = process.env.HELIX_WEBDAV_USERNAME;
const password = process.env.HELIX_WEBDAV_PASSWORD;
if (!baseUrl || !username || !password) process.exit(2);
const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
const response = await fetch(new URL("/dav/files/", baseUrl).href, {
  method: "PROPFIND",
  headers: {
    authorization: `Basic ${basic}`,
    depth: "0",
    "content-type": "application/xml",
  },
  body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname /></D:prop></D:propfind>',
});
if (response.status !== 401) {
  console.error(`revoked WebDAV app password returned HTTP ${response.status}, expected 401`);
  console.error(await response.text());
  process.exit(1);
}
NODE
  log "ok: revoked WebDAV app-password rejected"
}

run_carddav_smoke() {
  local suffix label create_file pending_id approve_file password_id app_password revoke_file revoke_pending_id
  suffix=$(date +%Y%m%d%H%M%S)
  label="helix-carddav-smoke-${suffix}"

  create_file=$(mktemp "${TMPDIR:-/tmp}/helix-carddav-app-password.XXXXXX")
  request_capture POST /api/tools/app.passwords.create 202 \
    "$(node -e '
const [actorId, label] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ actorId, label, scopes: ["carddav"] }));
' "$APP_PASSWORD_ACTOR_ID" "$label")" \
    "CardDAV app-password create pending" \
    "$create_file"
  pending_id=$(json_field_from_file "$create_file" "parsed.pending?.id") || {
    log "response body from CardDAV app-password create:"
    cat "$create_file" >&2
    rm -f "$create_file"
    die "CardDAV app-password create did not return pending.id"
  }
  rm -f "$create_file"

  approve_file=$(mktemp "${TMPDIR:-/tmp}/helix-carddav-app-password.XXXXXX")
  request_capture POST "/api/tools/pending/$pending_id/approve" 200 \
    '{}' \
    "CardDAV app-password create approve" \
    "$approve_file"
  password_id=$(json_field_from_file "$approve_file" "parsed.output?.appPassword?.id") || {
    log "response body from CardDAV app-password approve:"
    cat "$approve_file" >&2
    rm -f "$approve_file"
    die "CardDAV app-password approve did not return output.appPassword.id"
  }
  app_password=$(json_field_from_file "$approve_file" "parsed.output?.password") || {
    log "response body from CardDAV app-password approve:"
    cat "$approve_file" >&2
    rm -f "$approve_file"
    die "CardDAV app-password approve did not return one-time password"
  }
  rm -f "$approve_file"

  HELIX_BASE_URL="$BASE_URL" \
    HELIX_CARDDAV_USERNAME="$APP_PASSWORD_USERNAME" \
    HELIX_CARDDAV_PASSWORD="$app_password" \
    HELIX_CARDDAV_ACTOR_ID="$APP_PASSWORD_ACTOR_ID" \
    HELIX_CARDDAV_SUFFIX="$suffix" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    node <<'NODE'
const { createHash, randomBytes } = require("node:crypto");

const baseUrl = process.env.HELIX_BASE_URL;
const username = process.env.HELIX_CARDDAV_USERNAME;
const password = process.env.HELIX_CARDDAV_PASSWORD;
const actorId = process.env.HELIX_CARDDAV_ACTOR_ID;
const suffix = process.env.HELIX_CARDDAV_SUFFIX;
const traceToken = process.env.HELIX_TRACE_TOKEN ?? "";
if (!baseUrl || !username || !password || !actorId || !suffix) {
  console.error("HELIX_BASE_URL, HELIX_CARDDAV_USERNAME, HELIX_CARDDAV_PASSWORD, HELIX_CARDDAV_ACTOR_ID, and HELIX_CARDDAV_SUFFIX are required.");
  process.exit(2);
}

const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
const addressbookPath = `/dav/card/${encodeURIComponent(actorId)}/`;
const contactName = `helix-carddav-smoke-${suffix}.vcf`;
const contactPath = `${addressbookPath}${encodeURIComponent(contactName)}`;
const marker = `Helix CardDAV Smoke ${suffix}`;
const initialVcard = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  `UID:helix-carddav-smoke-${suffix}`,
  `FN:${marker}`,
  `EMAIL:carddav-smoke-${suffix}@example.test`,
  "END:VCARD",
  "",
].join("\r\n");
const updatedVcard = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  `UID:helix-carddav-smoke-${suffix}`,
  `FN:${marker} Updated`,
  `EMAIL:carddav-smoke-updated-${suffix}@example.test`,
  "END:VCARD",
  "",
].join("\r\n");

function url(path) {
  return new URL(path, baseUrl).href;
}

function traceHeaders() {
  const token = traceToken.trim();
  if (token.length === 0) return {};
  const lower = token.toLowerCase();
  const traceId = /^[0-9a-f]{32}$/.test(lower)
    ? lower
    : createHash("sha256").update(`trace:${token}`).digest("hex").slice(0, 32);
  const parentId = randomBytes(8).toString("hex");
  return { traceparent: `00-${traceId}-${parentId}-01` };
}

async function request(method, path, expectedStatus, options = {}) {
  const headers = {
    accept: "*/*",
    ...traceHeaders(),
    ...(options.auth === false ? {} : { authorization: `Basic ${basic}` }),
    ...(options.headers ?? {}),
  };
  const response = await fetch(url(path), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    console.error(`${method} ${path} returned HTTP ${response.status}, expected ${expectedStatus}`);
    console.error(text);
    process.exit(1);
  }
  for (const [header, expected] of Object.entries(options.headersContain ?? {})) {
    const value = response.headers.get(header);
    if (value === null || !value.includes(expected)) {
      console.error(`${method} ${path} response header ${header} did not contain ${expected}; got ${value}`);
      process.exit(1);
    }
  }
  for (const expected of options.contains ?? []) {
    if (!text.includes(expected)) {
      console.error(`${method} ${path} response did not contain ${expected}`);
      console.error(text);
      process.exit(1);
    }
  }
  if (options.requireHeader !== undefined && response.headers.get(options.requireHeader) === null) {
    console.error(`${method} ${path} response did not include ${options.requireHeader}`);
    process.exit(1);
  }
  return { response, text };
}

function syncTokenFrom(text) {
  const match = text.match(/<D:sync-token>([^<]+)<\/D:sync-token>/);
  if (match?.[1] === undefined) {
    console.error("CardDAV response did not include D:sync-token");
    console.error(text);
    process.exit(1);
  }
  return match[1];
}

async function main() {
  await request("PROPFIND", "/dav/card/", 401, {
    auth: false,
    headers: { depth: "0", "content-type": "application/xml" },
    body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname /></D:prop></D:propfind>',
    headersContain: { "www-authenticate": 'Basic realm="Helix CardDAV"' },
  });
  const discovery = await request("PROPFIND", addressbookPath, 207, {
    headers: { depth: "1", "content-type": "application/xml" },
    body: '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:displayname /><D:sync-token /><D:supported-report-set /><C:addressbook-home-set /></D:prop></D:propfind>',
    contains: [
      addressbookPath,
      `${addressbookPath}self.vcf`,
      "addressbook-query",
      "addressbook-multiget",
      "sync-collection",
    ],
  });
  const initialSyncToken = syncTokenFrom(discovery.text);
  await request("GET", `${addressbookPath}self.vcf`, 200, {
    contains: ["BEGIN:VCARD", actorId],
    requireHeader: "etag",
  });
  const put = await request("PUT", contactPath, 201, {
    headers: {
      "if-none-match": "*",
      "content-type": "text/vcard; charset=utf-8",
    },
    body: initialVcard,
    requireHeader: "etag",
  });
  const createdEtag = put.response.headers.get("etag");
  if (createdEtag === null) {
    console.error("CardDAV PUT did not return an ETag");
    process.exit(1);
  }
  await request("GET", contactPath, 200, {
    contains: ["BEGIN:VCARD", marker, `carddav-smoke-${suffix}@example.test`],
    requireHeader: "etag",
  });
  await request("REPORT", addressbookPath, 207, {
    headers: { depth: "1", "content-type": "application/xml" },
    body: `<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:prop><D:getetag/><C:address-data/></D:prop><D:href>${contactPath}</D:href><D:href>${addressbookPath}missing-${suffix}.vcf</D:href></C:addressbook-multiget>`,
    contains: [contactPath, marker, "address-data", "404 Not Found"],
  });
  const updated = await request("PUT", contactPath, 204, {
    headers: {
      "if-match": createdEtag,
      "content-type": "text/vcard; charset=utf-8",
    },
    body: updatedVcard,
    requireHeader: "etag",
  });
  const updatedEtag = updated.response.headers.get("etag");
  if (updatedEtag === null || updatedEtag === createdEtag) {
    console.error("CardDAV update did not return a changed ETag");
    process.exit(1);
  }
  await request("REPORT", addressbookPath, 207, {
    headers: { depth: "1", "content-type": "application/xml" },
    body: `<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:sync-token>${initialSyncToken}</D:sync-token><D:prop><D:getetag/><C:address-data/></D:prop></D:sync-collection>`,
    contains: [contactPath, `${marker} Updated`, "sync-token"],
  });
  await request("DELETE", contactPath, 204, {
    headers: { "if-match": updatedEtag },
  });
  await request("REPORT", addressbookPath, 207, {
    headers: { depth: "1", "content-type": "application/xml" },
    body: `<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><D:sync-token>${initialSyncToken}</D:sync-token><D:prop><D:getetag/><C:address-data/></D:prop></D:sync-collection>`,
    contains: [contactPath, "404 Not Found", "sync-token"],
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
NODE
  log "ok: CardDAV app-password vCard sync round-trip"

  revoke_file=$(mktemp "${TMPDIR:-/tmp}/helix-carddav-app-password.XXXXXX")
  request_capture POST /api/tools/app.passwords.revoke 202 \
    "$(node -e 'process.stdout.write(JSON.stringify({ passwordId: process.argv[1] }))' "$password_id")" \
    "CardDAV app-password revoke pending" \
    "$revoke_file"
  revoke_pending_id=$(json_field_from_file "$revoke_file" "parsed.pending?.id") || {
    log "response body from CardDAV app-password revoke:"
    cat "$revoke_file" >&2
    rm -f "$revoke_file"
    die "CardDAV app-password revoke did not return pending.id"
  }
  rm -f "$revoke_file"

  request_contains POST "/api/tools/pending/$revoke_pending_id/approve" 200 \
    '{}' \
    "CardDAV app-password revoke approve" \
    "$password_id" \
    "revoked"

  HELIX_BASE_URL="$BASE_URL" \
    HELIX_CARDDAV_USERNAME="$APP_PASSWORD_USERNAME" \
    HELIX_CARDDAV_PASSWORD="$app_password" \
    node <<'NODE'
const baseUrl = process.env.HELIX_BASE_URL;
const username = process.env.HELIX_CARDDAV_USERNAME;
const password = process.env.HELIX_CARDDAV_PASSWORD;
if (!baseUrl || !username || !password) process.exit(2);
const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
const response = await fetch(new URL("/dav/card/", baseUrl).href, {
  method: "PROPFIND",
  headers: {
    authorization: `Basic ${basic}`,
    depth: "0",
    "content-type": "application/xml",
  },
  body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname /></D:prop></D:propfind>',
});
if (response.status !== 401) {
  console.error(`revoked CardDAV app password returned HTTP ${response.status}, expected 401`);
  console.error(await response.text());
  process.exit(1);
}
NODE
  log "ok: revoked CardDAV app-password rejected"
}

run_caldav_smoke() {
  local suffix label create_file pending_id approve_file password_id app_password revoke_file revoke_pending_id
  suffix=$(date +%Y%m%d%H%M%S)
  label="helix-caldav-smoke-${suffix}"

  create_file=$(mktemp "${TMPDIR:-/tmp}/helix-caldav-app-password.XXXXXX")
  request_capture POST /api/tools/app.passwords.create 202 \
    "$(node -e '
const [actorId, label] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ actorId, label, scopes: ["caldav"] }));
' "$APP_PASSWORD_ACTOR_ID" "$label")" \
    "CalDAV app-password create pending" \
    "$create_file"
  pending_id=$(json_field_from_file "$create_file" "parsed.pending?.id") || {
    log "response body from CalDAV app-password create:"
    cat "$create_file" >&2
    rm -f "$create_file"
    die "CalDAV app-password create did not return pending.id"
  }
  rm -f "$create_file"

  approve_file=$(mktemp "${TMPDIR:-/tmp}/helix-caldav-app-password.XXXXXX")
  request_capture POST "/api/tools/pending/$pending_id/approve" 200 \
    '{}' \
    "CalDAV app-password create approve" \
    "$approve_file"
  password_id=$(json_field_from_file "$approve_file" "parsed.output?.appPassword?.id") || {
    log "response body from CalDAV app-password approve:"
    cat "$approve_file" >&2
    rm -f "$approve_file"
    die "CalDAV app-password approve did not return output.appPassword.id"
  }
  app_password=$(json_field_from_file "$approve_file" "parsed.output?.password") || {
    log "response body from CalDAV app-password approve:"
    cat "$approve_file" >&2
    rm -f "$approve_file"
    die "CalDAV app-password approve did not return one-time password"
  }
  rm -f "$approve_file"

  HELIX_BASE_URL="$BASE_URL" \
    HELIX_CALDAV_USERNAME="$APP_PASSWORD_USERNAME" \
    HELIX_CALDAV_PASSWORD="$app_password" \
    HELIX_CALDAV_ACTOR_ID="$APP_PASSWORD_ACTOR_ID" \
    HELIX_CALDAV_SUFFIX="$suffix" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    node <<'NODE'
const { createHash, randomBytes } = require("node:crypto");

const baseUrl = process.env.HELIX_BASE_URL;
const username = process.env.HELIX_CALDAV_USERNAME;
const password = process.env.HELIX_CALDAV_PASSWORD;
const actorId = process.env.HELIX_CALDAV_ACTOR_ID;
const suffix = process.env.HELIX_CALDAV_SUFFIX;
const traceToken = process.env.HELIX_TRACE_TOKEN ?? "";
if (!baseUrl || !username || !password || !actorId || !suffix) {
  console.error("HELIX_BASE_URL, HELIX_CALDAV_USERNAME, HELIX_CALDAV_PASSWORD, HELIX_CALDAV_ACTOR_ID, and HELIX_CALDAV_SUFFIX are required.");
  process.exit(2);
}

const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
const calendarId = actorId;
const eventId = `00000000-0000-4000-8000-${suffix.slice(-12).padStart(12, "0")}`;
const missingEventId = `00000000-0000-4001-8000-${suffix.slice(-12).padStart(12, "0")}`;
const calendarPath = `/dav/cal/${encodeURIComponent(calendarId)}/`;
const eventPath = `${calendarPath}${encodeURIComponent(eventId)}.ics`;
const missingEventPath = `${calendarPath}${encodeURIComponent(missingEventId)}.ics`;
const marker = `Helix CalDAV Smoke ${suffix}`;
const initialIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Helix//Live CalDAV Smoke//EN",
  "BEGIN:VEVENT",
  `UID:helix-caldav-smoke-${suffix}@helix.local`,
  `SUMMARY:${marker}`,
  "DESCRIPTION:Created by live CalDAV smoke",
  "LOCATION:Runtime validation",
  "DTSTART:20260521T150000Z",
  "DTEND:20260521T160000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
const updatedIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Helix//Live CalDAV Smoke//EN",
  "BEGIN:VEVENT",
  `UID:helix-caldav-smoke-${suffix}@helix.local`,
  `SUMMARY:${marker} Updated`,
  "DESCRIPTION:Updated by live CalDAV smoke",
  "LOCATION:Runtime validation",
  "DTSTART:20260521T153000Z",
  "DTEND:20260521T163000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

function url(path) {
  return new URL(path, baseUrl).href;
}

function traceHeaders() {
  const token = traceToken.trim();
  if (token.length === 0) return {};
  const lower = token.toLowerCase();
  const traceId = /^[0-9a-f]{32}$/.test(lower)
    ? lower
    : createHash("sha256").update(`trace:${token}`).digest("hex").slice(0, 32);
  const parentId = randomBytes(8).toString("hex");
  return { traceparent: `00-${traceId}-${parentId}-01` };
}

async function request(method, path, expectedStatus, options = {}) {
  const headers = {
    accept: "*/*",
    ...traceHeaders(),
    ...(options.auth === false ? {} : { authorization: `Basic ${basic}` }),
    ...(options.headers ?? {}),
  };
  const response = await fetch(url(path), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    console.error(`${method} ${path} returned HTTP ${response.status}, expected ${expectedStatus}`);
    console.error(text);
    process.exit(1);
  }
  for (const [header, expected] of Object.entries(options.headersContain ?? {})) {
    const value = response.headers.get(header);
    if (value === null || !value.includes(expected)) {
      console.error(`${method} ${path} response header ${header} did not contain ${expected}; got ${value}`);
      process.exit(1);
    }
  }
  for (const expected of options.contains ?? []) {
    if (!text.includes(expected)) {
      console.error(`${method} ${path} response did not contain ${expected}`);
      console.error(text);
      process.exit(1);
    }
  }
  if (options.requireHeader !== undefined && response.headers.get(options.requireHeader) === null) {
    console.error(`${method} ${path} response did not include ${options.requireHeader}`);
    process.exit(1);
  }
  return { response, text };
}

async function main() {
  await request("PROPFIND", "/dav/cal/", 401, {
    auth: false,
    headers: { depth: "0", "content-type": "application/xml" },
    body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname /></D:prop></D:propfind>',
    headersContain: { "www-authenticate": 'Basic realm="Helix CalDAV"' },
  });
  await request("PROPFIND", calendarPath, 207, {
    headers: { depth: "0", "content-type": "application/xml" },
    body: '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:current-user-principal /><C:calendar-home-set /><D:supported-report-set /></D:prop></D:propfind>',
    contains: [calendarPath, "calendar-query", "calendar-multiget", "calendar-home-set"],
  });
  const put = await request("PUT", eventPath, 201, {
    headers: {
      "if-none-match": "*",
      "content-type": "text/calendar; charset=utf-8",
    },
    body: initialIcs,
    requireHeader: "etag",
  });
  const createdEtag = put.response.headers.get("etag");
  if (createdEtag === null) {
    console.error("CalDAV PUT did not return an ETag");
    process.exit(1);
  }
  await request("GET", eventPath, 200, {
    contains: ["BEGIN:VCALENDAR", `SUMMARY:${marker}`, "DTSTART:20260521T150000Z"],
    requireHeader: "etag",
  });
  await request("REPORT", calendarPath, 207, {
    headers: { depth: "1", "content-type": "application/xml" },
    body: `<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><D:href>${eventPath}</D:href><D:href>${missingEventPath}</D:href></C:calendar-multiget>`,
    contains: [eventPath, missingEventPath, marker, "calendar-data", "404 Not Found"],
  });
  await request("REPORT", calendarPath, 207, {
    headers: { depth: "1", "content-type": "application/xml" },
    body: [
      '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
      "<D:prop><D:getetag/><C:calendar-data/></D:prop>",
      '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">',
      '<C:time-range start="20260521T000000Z" end="20260522T000000Z"/>',
      "</C:comp-filter></C:comp-filter></C:filter>",
      "</C:calendar-query>",
    ].join(""),
    contains: [marker, "calendar-data"],
  });
  const updated = await request("PUT", eventPath, 204, {
    headers: {
      "if-match": createdEtag,
      "content-type": "text/calendar; charset=utf-8",
    },
    body: updatedIcs,
    requireHeader: "etag",
  });
  const updatedEtag = updated.response.headers.get("etag");
  if (updatedEtag === null || updatedEtag === createdEtag) {
    console.error("CalDAV update did not return a changed ETag");
    process.exit(1);
  }
  await request("GET", eventPath, 200, {
    contains: [`SUMMARY:${marker} Updated`, "DTSTART:20260521T153000Z"],
    requireHeader: "etag",
  });
  await request("DELETE", eventPath, 204, {
    headers: { "if-match": updatedEtag },
  });
  await request("GET", eventPath, 404);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
NODE
  log "ok: CalDAV app-password VEVENT round-trip"

  revoke_file=$(mktemp "${TMPDIR:-/tmp}/helix-caldav-app-password.XXXXXX")
  request_capture POST /api/tools/app.passwords.revoke 202 \
    "$(node -e 'process.stdout.write(JSON.stringify({ passwordId: process.argv[1] }))' "$password_id")" \
    "CalDAV app-password revoke pending" \
    "$revoke_file"
  revoke_pending_id=$(json_field_from_file "$revoke_file" "parsed.pending?.id") || {
    log "response body from CalDAV app-password revoke:"
    cat "$revoke_file" >&2
    rm -f "$revoke_file"
    die "CalDAV app-password revoke did not return pending.id"
  }
  rm -f "$revoke_file"

  request_contains POST "/api/tools/pending/$revoke_pending_id/approve" 200 \
    '{}' \
    "CalDAV app-password revoke approve" \
    "$password_id" \
    "revoked"

  HELIX_BASE_URL="$BASE_URL" \
    HELIX_CALDAV_USERNAME="$APP_PASSWORD_USERNAME" \
    HELIX_CALDAV_PASSWORD="$app_password" \
    node <<'NODE'
const baseUrl = process.env.HELIX_BASE_URL;
const username = process.env.HELIX_CALDAV_USERNAME;
const password = process.env.HELIX_CALDAV_PASSWORD;
if (!baseUrl || !username || !password) process.exit(2);
const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
const response = await fetch(new URL("/dav/cal/", baseUrl).href, {
  method: "PROPFIND",
  headers: {
    authorization: `Basic ${basic}`,
    depth: "0",
    "content-type": "application/xml",
  },
  body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname /></D:prop></D:propfind>',
});
if (response.status !== 401) {
  console.error(`revoked CalDAV app password returned HTTP ${response.status}, expected 401`);
  console.error(await response.text());
  process.exit(1);
}
NODE
  log "ok: revoked CalDAV app-password rejected"
}

run_mail_smtp_smoke() {
  local suffix inbound_marker outbound_marker invite_marker inbound_subject outbound_subject invite_title invite_subject invite_recipient outbound_file pending_id
  suffix=$(date +%Y%m%d%H%M%S)
  inbound_marker="helix-smoke-inbound-${suffix}"
  outbound_marker="helix-smoke-outbound-${suffix}"
  invite_marker="helix-smoke-calendar-invite-${suffix}"
  inbound_subject="Helix SMTP inbound smoke $suffix"
  outbound_subject="Helix SMTP outbound smoke $suffix"
  invite_title="Helix calendar invite smoke $suffix $invite_marker"
  invite_subject="Invitation: $invite_title"
  invite_recipient=${HELIX_SMOKE_CALENDAR_INVITE_RECIPIENT:-calendar-invite-$suffix@example.net}

  HELIX_SMOKE_SMTP_HOST="$MAIL_SMTP_HOST" \
    HELIX_SMOKE_SMTP_PORT="$MAIL_SMTP_PORT" \
    HELIX_SMOKE_SMTP_FROM="sender-$suffix@example.net" \
    HELIX_SMOKE_SMTP_TO="$MAIL_SMTP_RECIPIENT" \
    HELIX_SMOKE_SMTP_SUBJECT="$inbound_subject" \
    HELIX_SMOKE_SMTP_MARKER="$inbound_marker" \
    node <<'NODE'
const net = require("node:net");

const host = process.env.HELIX_SMOKE_SMTP_HOST;
const port = Number.parseInt(process.env.HELIX_SMOKE_SMTP_PORT ?? "", 10);
const from = process.env.HELIX_SMOKE_SMTP_FROM;
const to = process.env.HELIX_SMOKE_SMTP_TO;
const subject = process.env.HELIX_SMOKE_SMTP_SUBJECT;
const marker = process.env.HELIX_SMOKE_SMTP_MARKER;
if (!host || !Number.isFinite(port) || !from || !to || !subject || !marker) {
  console.error("missing SMTP smoke environment");
  process.exit(2);
}

const body = [
  `From: Helix Smoke <${from}>`,
  `To: ${to}`,
  `Subject: ${subject}`,
  `Message-ID: <${marker}@example.net>`,
  `Date: ${new Date().toUTCString()}`,
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  `Inbound marker: ${marker}`,
  "",
].join("\r\n");

const commands = [
  "EHLO helix-smoke.local\r\n",
  `MAIL FROM:<${from}>\r\n`,
  `RCPT TO:<${to}>\r\n`,
  "DATA\r\n",
  `${body}\r\n.\r\n`,
  "QUIT\r\n",
];
let step = 0;
let buffer = "";
const socket = net.createConnection({ host, port });
socket.setTimeout(10_000);

function fail(message) {
  console.error(message);
  socket.destroy();
  process.exit(1);
}

socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (!buffer.endsWith("\n")) return;
  const lines = buffer.trimEnd().split(/\r?\n/u);
  const last = lines[lines.length - 1] ?? "";
  if (/^\d{3}-/u.test(last)) return;
  const code = Number.parseInt(last.slice(0, 3), 10);
  buffer = "";
  if (!Number.isFinite(code)) {
    fail(`unexpected SMTP response: ${last}`);
  }
  if (step === 0 && code !== 220) fail(`SMTP greeting failed: ${last}`);
  if (step > 0 && step < 4 && code >= 400) fail(`SMTP command failed: ${last}`);
  if (step === 4 && code !== 354) fail(`SMTP DATA not accepted: ${last}`);
  if (step === 5 && code >= 400) fail(`SMTP message rejected: ${last}`);
  if (step === commands.length + 1) {
    socket.end();
    return;
  }
  const command = commands[step++];
  if (command !== undefined) {
    socket.write(command);
  } else {
    socket.end();
  }
});
socket.on("timeout", () => fail("SMTP smoke timed out"));
socket.on("error", (error) => fail(`SMTP smoke connection failed: ${error.message}`));
socket.on("end", () => process.exit(0));
NODE
  log "ok: SMTP inbound message accepted"

  request_contains_retry POST /api/tools/mail.search 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], limit: 10 }))' "$inbound_marker")" \
    "SMTP inbound mail searchable" \
    30 \
    "$inbound_subject" \
    "$inbound_marker"

  outbound_file=$(mktemp "${TMPDIR:-/tmp}/helix-mail-smtp.XXXXXX")
  local outbound_body
  outbound_body=$(node -e '
const [to, subject, marker] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  to: [to],
  subject,
  bodyText: `Outbound marker: ${marker}`,
  undoWindowMs: 0,
}));
' "$MAIL_SMTP_RECIPIENT" "$outbound_subject" "$outbound_marker")
  local status
  status=$(curl_with_trace -sS \
    -o "$outbound_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "$outbound_body" \
    "$(api_url /api/tools/mail.send)")
  if [[ "$status" != "202" ]]; then
    log "response body from mail.send:"
    cat "$outbound_file" >&2
    rm -f "$outbound_file"
    die "mail.send returned HTTP $status, expected 202 pending confirmation"
  fi
  pending_id=$(json_field_from_file "$outbound_file" "parsed.pending?.id") || {
    log "response body from mail.send:"
    cat "$outbound_file" >&2
    rm -f "$outbound_file"
    die "mail.send did not return pending.id"
  }
  rm -f "$outbound_file"
  log "ok: mail.send pending confirmation -> 202"

  request_contains POST "/api/tools/pending/$pending_id/approve" 200 \
    '{}' \
    "mail.send approve" \
    "executed" \
    "queued"

  request_contains_retry POST /api/tools/mail.search 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], limit: 10 }))' "$outbound_marker")" \
    "SMTP outbound mail stored" \
    10 \
    "$outbound_subject" \
    "$outbound_marker"

  if bool_true "$MAIL_CHAT_SEARCH_SMOKE"; then
    if bool_true "$MAIL_CHAT_SEARCH_REINDEX"; then
      run_global_search_reindex_for_live_markers
    else
      log "skipping admin search reindex; relying on Mail/Chat event-driven indexing"
    fi
    request_search_text_retry POST /api/tools/search.query \
      "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], types: ["mail"], limit: 10 }))' "$inbound_marker")" \
      "SMTP inbound global mail search" \
      20 \
      "mail" \
      "$inbound_subject" \
      "$inbound_marker" \
      "inbound" \
      "sender-$suffix@example.net"
    request_search_text_retry POST /api/tools/search.query \
      "$(node -e 'process.stdout.write(JSON.stringify({ query: process.argv[1], types: ["mail"], limit: 10 }))' "$outbound_marker")" \
      "SMTP outbound global mail search" \
      20 \
      "mail" \
      "$outbound_subject" \
      "$outbound_marker" \
      "outbound" \
      "$MAIL_SMTP_RECIPIENT"
  fi

  HELIX_SMOKE_MAILPIT_URL="$MAILPIT_URL" \
    HELIX_SMOKE_MAILPIT_MARKER="$outbound_subject" \
    node <<'NODE'
const url = process.env.HELIX_SMOKE_MAILPIT_URL;
const marker = process.env.HELIX_SMOKE_MAILPIT_MARKER;
if (!url || !marker) {
  console.error("missing Mailpit smoke environment");
  process.exit(2);
}
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(new URL("/api/v1/messages", url));
    if (response.ok) {
      const body = await response.text();
      if (body.includes(marker)) {
        process.exit(0);
      }
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error(`Mailpit did not receive outbound marker: ${marker}`);
process.exit(1);
NODE
  log "ok: outbound SMTP delivered to Mailpit"

  local invite_starts_at invite_ends_at invite_file invite_pending_id invite_approve_file
  read -r invite_starts_at invite_ends_at < <(node -e '
const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 30 * 60 * 1000);
process.stdout.write(`${start.toISOString()} ${end.toISOString()}\n`);
')
  invite_file=$(mktemp "${TMPDIR:-/tmp}/helix-calendar-invite-smoke.XXXXXX")
  request_capture POST /api/tools/calendar.event.create 202 \
    "$(node -e '
const [title, marker, startsAt, endsAt, attendee] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  title,
  description: `Calendar outbound invite marker: ${marker}`,
  location: "Helix Mailpit smoke room",
  startsAt,
  endsAt,
  timezone: "UTC",
  attendees: [{
    email: attendee,
    displayName: "Helix Invite Recipient",
    responseStatus: "needs_action",
    metadata: { smoke: true, marker },
  }],
  metadata: { smoke: true, marker },
  sendInvitations: true,
}));
' "$invite_title" "$invite_marker" "$invite_starts_at" "$invite_ends_at" "$invite_recipient")" \
    "calendar.event.create invite pending" \
    "$invite_file"
  invite_pending_id=$(json_field_from_file "$invite_file" "parsed.pending?.id") || {
    log "response body from calendar.event.create invite:"
    cat "$invite_file" >&2
    rm -f "$invite_file"
    die "calendar.event.create invite did not return pending.id"
  }
  rm -f "$invite_file"

  invite_approve_file=$(mktemp "${TMPDIR:-/tmp}/helix-calendar-invite-approve.XXXXXX")
  request_capture POST "/api/tools/pending/$invite_pending_id/approve" 200 \
    '{}' \
    "calendar.event.create invite approve" \
    "$invite_approve_file"
  node -e '
const fs = require("node:fs");
const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (parsed.status !== "executed" || Number(parsed.output?.invitationsQueued ?? 0) < 1) {
  process.exit(2);
}
' "$invite_approve_file" || {
    log "response body from calendar.event.create invite approve:"
    cat "$invite_approve_file" >&2
    rm -f "$invite_approve_file"
    die "calendar.event.create invite approval did not queue an outbound invitation"
  }
  rm -f "$invite_approve_file"
  log "ok: calendar invitation queued outbound mail"

  HELIX_SMOKE_MAILPIT_URL="$MAILPIT_URL" \
    HELIX_SMOKE_MAILPIT_MARKER="$invite_subject" \
    node <<'NODE'
const url = process.env.HELIX_SMOKE_MAILPIT_URL;
const subject = process.env.HELIX_SMOKE_MAILPIT_MARKER;
if (!url || !subject) {
  console.error("missing Mailpit calendar invite smoke environment");
  process.exit(2);
}
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(new URL("/api/v1/messages", url));
    if (response.ok) {
      const body = await response.text();
      if (body.includes(subject)) {
        process.exit(0);
      }
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error(`Mailpit did not receive calendar invite marker: ${subject}`);
process.exit(1);
NODE
  log "ok: calendar invitation delivered to Mailpit"
}

json_field_from_file() {
  local file=${1:?missing JSON file}
  local expression=${2:?missing JS expression}
  node -e "
const fs = require('node:fs');
const parsed = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const value = (${expression});
if (typeof value !== 'string' || value.length === 0) process.exit(2);
process.stdout.write(value);
" "$file"
}

webhook_signature() {
  local secret=${1:?missing webhook secret}
  local payload=${2:?missing webhook payload}
  node -e '
const { createHmac } = require("node:crypto");
const secret = process.argv[1];
const payload = process.argv[2];
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac("sha256", secret)
  .update(String(timestamp))
  .update(".")
  .update(payload)
  .digest("hex");
process.stdout.write(`t=${timestamp},v1=${signature}`);
' "$secret" "$payload"
}

webhook_bad_signature() {
  node -e 'process.stdout.write(`t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`);'
}

assert_webhook_inbound_delivery() {
  local delivery_id=${1:?missing delivery id}
  local inbound_id=${2:?missing inbound id}
  local event_subject=${3:?missing event subject}
  local expected_status=${4:?missing expected status}
  local signature=${5:?missing signature}
  local payload_kind=${6:?missing payload kind}
  local output_file status

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-delivery.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$output_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "$(node -e 'process.stdout.write(JSON.stringify({ id: process.argv[1] }))' "$delivery_id")" \
    "$(api_url /api/tools/webhook.delivery.get)")
  if [[ "$status" != "200" ]]; then
    log "response body from webhook delivery get:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "webhook delivery get returned HTTP $status, expected 200"
  fi
  node -e '
const fs = require("node:fs");
const [file, deliveryId, inboundId, eventSubject, expectedStatus, signature, payloadKind] = process.argv.slice(1);
const delivery = JSON.parse(fs.readFileSync(file, "utf8"));
const expectedError = expectedStatus === "failed" ? "Invalid webhook signature" : null;
if (
  delivery.id !== deliveryId ||
  delivery.direction !== "inbound" ||
  delivery.inboundWebhookId !== inboundId ||
  delivery.eventSubject !== eventSubject ||
  delivery.status !== expectedStatus ||
  delivery.signature !== signature ||
  delivery.error !== expectedError ||
  delivery.payload?.smoke !== true ||
  delivery.payload?.kind !== payloadKind
) {
  process.exit(2);
}
' "$output_file" "$delivery_id" "$inbound_id" "$event_subject" "$expected_status" "$signature" "$payload_kind" || {
    log "response body from webhook delivery get:"
    cat "$output_file" >&2
    rm -f "$output_file"
    die "webhook delivery get did not match expected inbound delivery state"
  }
  rm -f "$output_file"
  log "ok: webhook inbound delivery $expected_status"
}

run_webhook_loopback_smoke() {
  local inbound_id=${1:?missing inbound id}
  local inbound_slug=${2:?missing inbound slug}
  local suffix=${3:?missing suffix}
  local webhook_secret="helix-smoke-loopback"
  local valid_body bad_body valid_signature bad_signature valid_file bad_file outbound_file outbound_id test_file status
  local valid_delivery_id bad_delivery_id outbound_delivery_id outbound_signature

  bad_body="{\"smoke\":true,\"kind\":\"inbound-invalid\",\"runId\":\"$suffix\"}"
  bad_signature=$(webhook_bad_signature)
  bad_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-inbound-bad.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$bad_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H 'x-helix-event: helix.smoke.inbound' \
    -H "x-helix-signature: $bad_signature" \
    --data "$bad_body" \
    "$(api_url "/webhooks/$inbound_slug")")
  if [[ "$status" != "401" ]]; then
    log "response body from invalid inbound webhook:"
    cat "$bad_file" >&2
    rm -f "$bad_file"
    die "invalid inbound webhook returned HTTP $status, expected 401"
  fi
  bad_delivery_id=$(json_field_from_file "$bad_file" "parsed.deliveryId") || {
    log "response body from invalid inbound webhook:"
    cat "$bad_file" >&2
    rm -f "$bad_file"
    die "invalid inbound webhook did not return deliveryId"
  }
  if ! grep -Fq '"ok":false' "$bad_file" || ! grep -Fq 'Invalid webhook signature' "$bad_file"; then
    log "response body from invalid inbound webhook:"
    cat "$bad_file" >&2
    rm -f "$bad_file"
    die "invalid inbound webhook response did not include rejection details"
  fi
  rm -f "$bad_file"
  log "ok: invalid signed inbound webhook rejected -> 401"
  assert_webhook_inbound_delivery "$bad_delivery_id" "$inbound_id" "helix.smoke.inbound" "failed" "$bad_signature" "inbound-invalid"

  valid_body="{\"smoke\":true,\"kind\":\"inbound-valid\",\"runId\":\"$suffix\"}"
  valid_signature=$(webhook_signature "$webhook_secret" "$valid_body")
  valid_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-inbound-valid.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$valid_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H 'x-helix-event: helix.smoke.inbound' \
    -H "x-helix-signature: $valid_signature" \
    --data "$valid_body" \
    "$(api_url "/webhooks/$inbound_slug")")
  if [[ "$status" != "202" ]]; then
    log "response body from valid inbound webhook:"
    cat "$valid_file" >&2
    rm -f "$valid_file"
    die "valid inbound webhook returned HTTP $status, expected 202"
  fi
  valid_delivery_id=$(json_field_from_file "$valid_file" "parsed.deliveryId") || {
    log "response body from valid inbound webhook:"
    cat "$valid_file" >&2
    rm -f "$valid_file"
    die "valid inbound webhook did not return deliveryId"
  }
  if ! grep -Fq '"ok":true' "$valid_file"; then
    log "response body from valid inbound webhook:"
    cat "$valid_file" >&2
    rm -f "$valid_file"
    die "valid inbound webhook response did not include ok=true"
  fi
  rm -f "$valid_file"
  log "ok: valid signed inbound webhook accepted -> 202"
  assert_webhook_inbound_delivery "$valid_delivery_id" "$inbound_id" "helix.smoke.inbound" "delivered" "$valid_signature" "inbound-valid"

  outbound_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-loopback-outbound.XXXXXX")
  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command \
      webhook outbound create \
      --name "Helix smoke loopback $suffix" \
      --url "$(api_url "/webhooks/$inbound_slug")" \
      --event-subject "helix.smoke.outbound" \
      --secret-ref "inline:$webhook_secret" \
      --header "x-helix-smoke=live-auth-smoke" \
      --enabled >"$outbound_file" 2>&1; then
    log "CLI output from webhook loopback outbound create:"
    print_redacted_cli_output "$outbound_file"
    rm -f "$outbound_file"
    die "webhook loopback outbound create failed"
  fi
  outbound_id=$(json_field_from_file "$outbound_file" "parsed.id") || {
    log "CLI output from webhook loopback outbound create:"
    print_redacted_cli_output "$outbound_file"
    rm -f "$outbound_file"
    die "webhook loopback outbound create did not return id"
  }
  rm -f "$outbound_file"
  log "ok: CLI webhook loopback outbound create"

  test_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-loopback-test.XXXXXX")
  status=$(curl_with_trace -sS \
    -o "$test_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    --data "$(node -e '
const [id, suffix] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  id,
  subject: "helix.smoke.outbound",
  payload: { smoke: true, runId: suffix, classification: "standard" },
}));
' "$outbound_id" "$suffix")" \
    "$(api_url /api/tools/webhook.outbound.test)")
  if [[ "$status" == "202" ]]; then
    local pending_id approved_file
    pending_id=$(json_field_from_file "$test_file" "parsed.pending?.id") || {
      log "response body from webhook outbound test:"
      cat "$test_file" >&2
      cleanup_webhook_smoke "$outbound_id" ""
      rm -f "$test_file"
      die "webhook outbound test returned pending response without pending.id"
    }
    approved_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-loopback-approve.XXXXXX")
    status=$(curl_with_trace -sS \
      -o "$approved_file" \
      -w '%{http_code}' \
      -X POST \
      -H 'accept: application/json' \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $ACCESS_TOKEN" \
      --data '{}' \
      "$(api_url "/api/tools/pending/$pending_id/approve")")
    if [[ "$status" != "200" ]]; then
      log "response body from webhook outbound approval:"
      cat "$approved_file" >&2
      cleanup_webhook_smoke "$outbound_id" ""
      rm -f "$test_file" "$approved_file"
      die "webhook outbound approval returned HTTP $status, expected 200"
    fi
    mv "$approved_file" "$test_file"
  elif [[ "$status" != "200" ]]; then
    log "response body from webhook outbound test:"
    cat "$test_file" >&2
    cleanup_webhook_smoke "$outbound_id" ""
    rm -f "$test_file"
    die "webhook outbound test returned HTTP $status, expected 200 or 202"
  fi

  read -r outbound_delivery_id outbound_signature < <(node -e '
const fs = require("node:fs");
const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const delivery = parsed.delivery ?? parsed.output?.delivery;
if (
  delivery?.direction !== "outbound" ||
  delivery?.outboundWebhookId !== process.argv[2] ||
  delivery?.eventSubject !== "helix.smoke.outbound" ||
  delivery?.status !== "delivered" ||
  delivery?.responseStatus !== 202 ||
  typeof delivery?.signature !== "string" ||
  !delivery.signature.startsWith("t=") ||
  !delivery.signature.includes(",v1=") ||
  delivery?.requestHeaders?.["x-helix-event"] !== "helix.smoke.outbound" ||
  delivery?.requestHeaders?.["x-helix-delivery"] !== delivery.id
) {
  process.exit(2);
}
process.stdout.write(`${delivery.id} ${delivery.signature}\n`);
' "$test_file" "$outbound_id") || {
    log "response body from webhook outbound test:"
    cat "$test_file" >&2
    cleanup_webhook_smoke "$outbound_id" ""
    rm -f "$test_file"
    die "webhook outbound loopback delivery did not match expected delivered state"
  }
  rm -f "$test_file"
  log "ok: webhook outbound loopback delivery -> 202 receiver response"

  request_contains POST /api/tools/webhook.delivery.list 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ direction: "inbound", limit: 20 }))')" \
    "webhook loopback inbound delivery list" \
    "$outbound_delivery_id" \
    "$outbound_signature" \
    "helix.smoke.outbound" \
    "\"runId\":\"$suffix\""

  cleanup_webhook_smoke "$outbound_id" ""
}

run_webhook_smoke() {
  if [[ -z "$CLI_BIN" && ! -f packages/cli/dist/index.js ]]; then
    die "packages/cli/dist/index.js is missing; run pnpm --filter @helix/cli build or pass --cli-bin"
  fi

  local suffix outbound_file outbound_id inbound_file inbound_id inbound_slug
  suffix=$(date +%Y%m%d%H%M%S)
  outbound_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-smoke.XXXXXX")
  inbound_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-smoke.XXXXXX")
  inbound_slug="helix-smoke-${suffix}"

  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command \
      webhook outbound create \
      --name "Helix smoke outbound $suffix" \
      --url "https://example.invalid/helix-smoke/$suffix" \
      --event-subject "helix.smoke" \
      --secret-ref "inline:helix-smoke" \
      --disabled >"$outbound_file" 2>&1; then
    log "CLI output from webhook outbound create:"
    print_redacted_cli_output "$outbound_file"
    rm -f "$outbound_file" "$inbound_file"
    die "webhook outbound create failed"
  fi
  outbound_id=$(json_field_from_file "$outbound_file" "parsed.id") || {
    log "CLI output from webhook outbound create:"
    print_redacted_cli_output "$outbound_file"
    rm -f "$outbound_file" "$inbound_file"
    die "webhook outbound create did not return id"
  }
  if ! grep -Fq '"enabled": false' "$outbound_file"; then
    log "CLI output from webhook outbound create:"
    print_redacted_cli_output "$outbound_file"
    rm -f "$outbound_file" "$inbound_file"
    die "webhook outbound create did not persist disabled state"
  fi
  log "ok: CLI webhook outbound create"

  run_cli_contains "webhook outbound list" \
    webhook outbound list \
    --expect "$outbound_id" "Helix smoke outbound $suffix"

  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command \
      webhook inbound create \
      --name "Helix smoke inbound $suffix" \
      --slug "$inbound_slug" \
      --source generic \
      --secret-ref "inline:helix-smoke-loopback" \
      --enabled >"$inbound_file" 2>&1; then
    log "CLI output from webhook inbound create:"
    print_redacted_cli_output "$inbound_file"
    cleanup_webhook_smoke "$outbound_id" ""
    rm -f "$outbound_file" "$inbound_file"
    die "webhook inbound create failed"
  fi
  inbound_id=$(json_field_from_file "$inbound_file" "parsed.id") || {
    log "CLI output from webhook inbound create:"
    print_redacted_cli_output "$inbound_file"
    cleanup_webhook_smoke "$outbound_id" ""
    rm -f "$outbound_file" "$inbound_file"
    die "webhook inbound create did not return id"
  }
  log "ok: CLI webhook inbound create"

  run_cli_contains "webhook inbound list" \
    webhook inbound list \
    --expect "$inbound_id" "$inbound_slug"

  run_webhook_loopback_smoke "$inbound_id" "$inbound_slug" "$suffix"

  run_cli_contains "webhook inbound rotate-secret" \
    webhook inbound rotate-secret --id "$inbound_id" \
    --expect "$inbound_id" secretRef

  run_cli_contains "webhook delivery list" \
    webhook delivery list --limit 5 \
    --expect deliveries

  cleanup_webhook_smoke "$outbound_id" "$inbound_id"
  rm -f "$outbound_file" "$inbound_file"
}

run_plugin_lifecycle_smoke() {
  local plugin_id=${PLUGIN_LIFECYCLE_ID:?missing plugin id}
  local plugin_version=${PLUGIN_LIFECYCLE_VERSION:?missing plugin version}
  local install_file install_pending_id install_approve_file uninstall_file uninstall_pending_id uninstall_approve_file
  local enable_file disable_file

  request_contains POST /api/tools/plugin.list 200 \
    '{"includeConfirmations":true}' \
    "plugin list" \
    "$plugin_id" \
    "$plugin_version"

  install_file=$(mktemp "${TMPDIR:-/tmp}/helix-plugin-install.XXXXXX")
  request_capture POST /api/tools/plugin.install 202 \
    "$(node -e '
const [pluginId, version] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ pluginId, version, source: "official" }));
' "$plugin_id" "$plugin_version")" \
    "plugin.install pending" \
    "$install_file"
  install_pending_id=$(json_field_from_file "$install_file" "parsed.pending?.id") || {
    log "response body from plugin.install:"
    cat "$install_file" >&2
    rm -f "$install_file"
    die "plugin.install did not return pending.id"
  }
  rm -f "$install_file"

  install_approve_file=$(mktemp "${TMPDIR:-/tmp}/helix-plugin-install-approve.XXXXXX")
  request_capture POST "/api/tools/pending/$install_pending_id/approve" 200 \
    '{}' \
    "plugin.install approve" \
    "$install_approve_file"
  node -e '
const fs = require("node:fs");
const [file, pluginId, version] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const output = parsed.output;
if (
  parsed.status !== "executed" ||
  output?.status !== "installed" ||
  output?.plugin?.id !== pluginId ||
  output?.plugin?.version !== version ||
  output?.lifecycle?.state !== "installed" ||
  output?.lifecycle?.installed !== true ||
  output?.source !== "official"
) {
  process.exit(2);
}
' "$install_approve_file" "$plugin_id" "$plugin_version" || {
    log "response body from plugin.install approve:"
    cat "$install_approve_file" >&2
    rm -f "$install_approve_file"
    die "plugin.install approval did not install the expected plugin"
  }
  rm -f "$install_approve_file"

  enable_file=$(mktemp "${TMPDIR:-/tmp}/helix-plugin-enable.XXXXXX")
  request_capture POST /api/tools/plugin.enable 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ pluginId: process.argv[1] }))' "$plugin_id")" \
    "plugin.enable" \
    "$enable_file"
  node -e '
const fs = require("node:fs");
const [file, pluginId] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
if (parsed.status !== "enabled" || parsed.plugin?.id !== pluginId || parsed.lifecycle?.state !== "enabled") {
  process.exit(2);
}
' "$enable_file" "$plugin_id" || {
    log "response body from plugin.enable:"
    cat "$enable_file" >&2
    rm -f "$enable_file"
    die "plugin.enable did not return enabled lifecycle state"
  }
  rm -f "$enable_file"

  disable_file=$(mktemp "${TMPDIR:-/tmp}/helix-plugin-disable.XXXXXX")
  request_capture POST /api/tools/plugin.disable 200 \
    "$(node -e 'process.stdout.write(JSON.stringify({ pluginId: process.argv[1] }))' "$plugin_id")" \
    "plugin.disable" \
    "$disable_file"
  node -e '
const fs = require("node:fs");
const [file, pluginId] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
if (parsed.status !== "disabled" || parsed.plugin?.id !== pluginId || parsed.lifecycle?.state !== "disabled") {
  process.exit(2);
}
' "$disable_file" "$plugin_id" || {
    log "response body from plugin.disable:"
    cat "$disable_file" >&2
    rm -f "$disable_file"
    die "plugin.disable did not return disabled lifecycle state"
  }
  rm -f "$disable_file"

  uninstall_file=$(mktemp "${TMPDIR:-/tmp}/helix-plugin-uninstall.XXXXXX")
  request_capture POST /api/tools/plugin.uninstall 202 \
    "$(node -e '
const pluginId = process.argv[1];
process.stdout.write(JSON.stringify({ pluginId, confirmations: ["plugin.uninstall"] }));
' "$plugin_id")" \
    "plugin.uninstall pending" \
    "$uninstall_file"
  uninstall_pending_id=$(json_field_from_file "$uninstall_file" "parsed.pending?.id") || {
    log "response body from plugin.uninstall:"
    cat "$uninstall_file" >&2
    rm -f "$uninstall_file"
    die "plugin.uninstall did not return pending.id"
  }
  rm -f "$uninstall_file"

  uninstall_approve_file=$(mktemp "${TMPDIR:-/tmp}/helix-plugin-uninstall-approve.XXXXXX")
  request_capture POST "/api/tools/pending/$uninstall_pending_id/approve" 200 \
    '{}' \
    "plugin.uninstall approve" \
    "$uninstall_approve_file"
  node -e '
const fs = require("node:fs");
const [file, pluginId] = process.argv.slice(1);
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const output = parsed.output;
if (
  parsed.status !== "executed" ||
  output?.status !== "uninstalled" ||
  output?.plugin?.id !== pluginId ||
  output?.lifecycle?.state !== "uninstalled" ||
  output?.lifecycle?.installed !== false
) {
  process.exit(2);
}
' "$uninstall_approve_file" "$plugin_id" || {
    log "response body from plugin.uninstall approve:"
    cat "$uninstall_approve_file" >&2
    rm -f "$uninstall_approve_file"
    die "plugin.uninstall approval did not uninstall the expected plugin"
  }
  rm -f "$uninstall_approve_file"

  request_contains POST /api/tools/plugin.list 200 \
    '{"includeConfirmations":true}' \
    "plugin list after uninstall" \
    "$plugin_id" \
    '"state":"uninstalled"' \
    '"installed":false'

  request_contains_retry GET '/api/admin/audit-log?limit=50' 200 \
    "" \
    "plugin lifecycle audit rows" \
    10 \
    "plugin.install.validated" \
    "plugin.enable.validated" \
    "plugin.disable.validated" \
    "plugin.uninstall.validated" \
    "$plugin_id"
}

cleanup_webhook_smoke() {
  local outbound_id=${1:-}
  local inbound_id=${2:-}
  if [[ -n "$outbound_id" ]]; then
    run_cli_delete_webhook "outbound" "$outbound_id"
  fi
  if [[ -n "$inbound_id" ]]; then
    run_cli_delete_webhook "inbound" "$inbound_id"
  fi
}

run_cli_delete_webhook() {
  local direction=${1:?missing webhook direction}
  local webhook_id=${2:?missing webhook id}
  local output_file pending_id

  output_file=$(mktemp "${TMPDIR:-/tmp}/helix-webhook-delete.XXXXXX")
  if ! HELIX_BASE_URL="$BASE_URL" \
    HELIX_ACCESS_TOKEN="$ACCESS_TOKEN" \
    HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
    run_cli_command webhook "$direction" delete --id "$webhook_id" >"$output_file" 2>&1; then
    log "CLI output from webhook $direction delete:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "webhook $direction delete failed"
  fi

  if grep -Fq '"deleted": true' "$output_file"; then
    rm -f "$output_file"
    log "ok: CLI webhook $direction delete"
    return 0
  fi

  pending_id=$(node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const parsed = JSON.parse(input);
  const id = parsed.pending?.id;
  if (
    parsed.status !== "pending_confirmation" ||
    typeof id !== "string" ||
    !String(parsed.pending?.toolId ?? "").startsWith("webhook.")
  ) {
    process.exit(2);
  }
  process.stdout.write(id);
});
' <"$output_file") || {
    log "CLI output from webhook $direction delete:"
    print_redacted_cli_output "$output_file"
    rm -f "$output_file"
    die "webhook $direction delete did not return deleted=true or pending confirmation"
  }
  rm -f "$output_file"

  run_cli_contains "webhook $direction delete approve" \
    action approve "$pending_id" \
    --expect executed deleted
}

run_k6_target_smoke() {
  require_cmd pnpm
  log "running target-mode k6 with minted OAuth token for groups: $K6_SCENARIO_GROUPS"
  WEB_BASE_URL="$K6_WEB_BASE_URL" \
  API_BASE_URL="$K6_API_BASE_URL" \
  AUTH_TOKEN="$ACCESS_TOKEN" \
  K6_TRACE_TOKEN="${K6_TRACE_TOKEN:-$TRACE_TOKEN}" \
  HELIX_TRACE_TOKEN="$TRACE_TOKEN" \
  K6_SCENARIO_GROUPS="$K6_SCENARIO_GROUPS" \
  WEB_DURATION="${WEB_DURATION:-$K6_DURATION}" \
  API_DURATION="${API_DURATION:-$K6_DURATION}" \
  PRD_DURATION="${PRD_DURATION:-$K6_DURATION}" \
  WEB_VUS="${WEB_VUS:-1}" \
  API_VUS="${API_VUS:-1}" \
  PRD_VUS="${PRD_VUS:-1}" \
  DOCS_CREATE_TOOL_ID="${DOCS_CREATE_TOOL_ID:-}" \
  DOCS_CREATE_BODY="${DOCS_CREATE_BODY:-}" \
  DOCS_EXPORT_TOOL_ID="${DOCS_EXPORT_TOOL_ID:-}" \
  DOCS_EXPORT_BODY="${DOCS_EXPORT_BODY:-}" \
  DOCS_DOC_ID="${DOCS_DOC_ID:-}" \
  DOCS_EXPECT="${DOCS_EXPECT:-}" \
  MEET_CREATE_TOOL_ID="${MEET_CREATE_TOOL_ID:-}" \
  MEET_CREATE_BODY="${MEET_CREATE_BODY:-}" \
  MEET_MINT_TOOL_ID="${MEET_MINT_TOOL_ID:-}" \
  MEET_MINT_BODY="${MEET_MINT_BODY:-}" \
  MEET_END_TOOL_ID="${MEET_END_TOOL_ID:-}" \
  MEET_ROOM_ID="${MEET_ROOM_ID:-}" \
  MEET_JITSI_DOMAIN="${MEET_JITSI_DOMAIN:-}" \
  MEET_EXPECT="${MEET_EXPECT:-}" \
  MEET_END_AFTER_MINT="${MEET_END_AFTER_MINT:-}" \
    infra/scripts/validate-k6.sh --no-mock
  log "ok: target-mode k6 completed"
}

case "$BACKUP_ID" in
  ""|.*|*/*|*\\*) die "backup id must be a relative name without slashes or a leading dot: $BACKUP_ID" ;;
esac
[[ "$BACKUP_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "backup id contains unsupported characters: $BACKUP_ID"

log "checking public readiness at $(api_url /readyz)"
curl_with_trace -fsS "$(api_url /readyz)" >/dev/null

log "minting OAuth client-credentials token for $CLIENT_ID"
token_response=$(curl_with_trace -fsS \
  -X POST \
  -H 'accept: application/json' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "scope=$SCOPE" \
  "$(api_url /oauth/token)")
ACCESS_TOKEN=$(printf '%s' "$token_response" | json_field access_token)
log "ok: OAuth token minted"

request GET /openapi.json 200
request GET /asyncapi.json 200
request GET /api/tools 200
request POST /mcp 200 '{"jsonrpc":"2.0","id":"helix-smoke-tools","method":"tools/list"}'
request POST /mcp 200 '{"jsonrpc":"2.0","id":"helix-smoke-resources","method":"resources/list"}'
request GET '/api/admin/users?limit=1' 200
request GET '/api/admin/audit-log?limit=1' 200
request POST /api/tools/agent.credentials.list 200 '{"includeRevoked":false}'
request POST /api/tools/app.passwords.list 200 '{"includeRevoked":false}'

if bool_true "$MUTATE"; then
  request PATCH /api/admin/platform-config 200 "{\"security\":{\"tier\":\"$TIER\"}}"
else
  log "skipping tier mutation; pass --mutate to PATCH /api/admin/platform-config"
fi

if bool_true "$BACKUP_RESTORE"; then
  backup_body="{\"backupId\":\"$BACKUP_ID\"}"
  restore_body="$backup_body"
  if bool_true "$BACKUP_RESTORE_ENCRYPTED"; then
    restore_body="{\"backupId\":\"$BACKUP_ID\",\"encrypted\":true}"
  fi
  request POST /api/admin/backups 200 "$backup_body" status dry_run
  request POST /api/admin/restores 200 "$restore_body" status dry_run
else
  log "skipping backup/restore dry-runs; pass --backup-restore to POST /api/admin/backups and /api/admin/restores"
fi

if bool_true "$SEARCH_REINDEX"; then
  request POST /api/admin/search/reindex 200 '{"all":true,"pruneStale":false}' status completed
else
  log "skipping search reindex; pass --search-reindex when Meilisearch is configured"
fi

if bool_true "$SEEDED_DEMO"; then
  run_seeded_demo_checks
else
  log "skipping seeded demo tool checks; pass --seeded-demo-tools after running db:prepare:demo"
fi

if bool_true "$SEEDED_VOLUME_SEARCH"; then
  run_seeded_volume_search_smoke
else
  log "skipping seeded volume search check; pass --seeded-volume-search-smoke after running db:prepare:demo -- --volume-search"
fi

if bool_true "$DRIVE_DOCS_CALENDAR_SMOKE" || bool_true "$WORKSPACE_SEARCH_SMOKE"; then
  run_drive_docs_calendar_smoke
else
  log "skipping Drive/Docs/Calendar live data smoke; pass --drive-docs-calendar-smoke for live workspace mutations"
fi

if bool_true "$CLI_CHECKS"; then
  run_cli_checks
else
  log "skipping CLI checks; pass --cli-checks after building @helix/cli"
fi

if bool_true "$PENDING_ACTION_CLI"; then
  run_cli_pending_action_check
else
  log "skipping pending-action CLI check; pass --pending-action-cli with a seeded actor"
fi

if bool_true "$AUDIT_RUNTIME_SMOKE"; then
  run_audit_runtime_smoke
else
  log "skipping audit runtime smoke; pass --audit-runtime-smoke to validate live audit rows and metrics"
fi

if bool_true "$AGENT_LIMITS_SMOKE"; then
  run_agent_limits_smoke
else
  log "skipping agent limits smoke; pass --agent-limits-smoke with a seeded smoke agent and limiting tier"
fi

if bool_true "$EVENTS_WS"; then
  run_events_ws_check
else
  log "skipping events websocket check; pass --events-ws to validate /events/ws auth"
fi

if bool_true "$CHAT_REALTIME_SMOKE"; then
  run_chat_realtime_smoke
else
  log "skipping chat realtime smoke; pass --chat-realtime-smoke to validate /ws/chat fanout"
fi

if bool_true "$MEET_SMOKE"; then
  run_meet_smoke
else
  log "skipping Meet smoke; pass --meet-smoke for Meet/Jitsi room, JWT, recording webhook, and end-room checks"
fi

if bool_true "$ASSISTANT_SMOKE"; then
  run_assistant_smoke
else
  log "skipping assistant smoke; pass --assistant-smoke for deterministic assistant runtime checks"
fi

if bool_true "$ASSISTANT_PROVIDER_SMOKE"; then
  run_assistant_provider_smoke
else
  log "skipping assistant provider smoke; pass --assistant-provider-smoke after starting the app with a non-local assistant provider"
fi

if bool_true "$MAIL_SMTP_SMOKE"; then
  run_mail_smtp_smoke
else
  log "skipping mail SMTP smoke; pass --mail-smtp-smoke for live SMTP receive/send checks"
fi

if bool_true "$WEBDAV_SMOKE"; then
  run_webdav_smoke
else
  log "skipping WebDAV smoke; pass --webdav-smoke for app-password WebDAV byte round-trip checks"
fi

if bool_true "$CALDAV_SMOKE"; then
  run_caldav_smoke
else
  log "skipping CalDAV smoke; pass --caldav-smoke for app-password CalDAV VEVENT checks"
fi

if bool_true "$CARDDAV_SMOKE"; then
  run_carddav_smoke
else
  log "skipping CardDAV smoke; pass --carddav-smoke for app-password CardDAV vCard sync checks"
fi

if bool_true "$WEBHOOK_SMOKE"; then
  run_webhook_smoke
else
  log "skipping webhook smoke; pass --webhook-smoke for webhook admin and loopback delivery checks"
fi

if bool_true "$PLUGIN_LIFECYCLE_SMOKE"; then
  run_plugin_lifecycle_smoke
else
  log "skipping plugin lifecycle smoke; pass --plugin-lifecycle-smoke for live plugin tool checks"
fi

if bool_true "$K6_TARGET_SMOKE"; then
  run_k6_target_smoke
else
  log "skipping target-mode k6; pass --k6-target-smoke to reuse the minted OAuth token for k6"
fi

log "live authenticated smoke checks complete"
