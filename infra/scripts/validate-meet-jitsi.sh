#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/validate-meet-jitsi.sh [options]

Validates the offline/static Meet Jitsi infrastructure contract without Docker
or network access.

Options:
  --compose-file <path>      Default: docker-compose.yml
  --env-file <path>          Default: infra/meet/jitsi.env.example
  -h, --help

Checks:
  - compose has the meet profile and Jitsi web/prosody/jicofo/jvb services
  - Helix exposes the Meet plugin config through environment variables
  - Jitsi services use JWT auth with guests disabled
  - required env example keys are present and non-empty
  - local dev ports stay in the Helix high-port block and do not collide
  - public URL and Meet domain are consistent
EOF
}

COMPOSE_FILE=${HELIX_MEET_COMPOSE_FILE:-docker-compose.yml}
ENV_FILE=${HELIX_MEET_ENV_FILE:-infra/meet/jitsi.env.example}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compose-file) COMPOSE_FILE=${2:?missing compose file}; shift 2 ;;
    --env-file) ENV_FILE=${2:?missing env file}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

ensure_repo_root
require_cmd bash
require_cmd grep
require_cmd sed
require_cmd sort
require_cmd wc

[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"

assert_contains() {
  local file=$1
  local pattern=$2
  local message=$3
  if ! grep -Eq -- "$pattern" "$file"; then
    die "$message"
  fi
}

env_value() {
  local key=$1
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)
  [[ -n "$line" ]] || die "missing env key: $key"
  printf '%s' "${line#*=}"
}

assert_env_non_empty() {
  local key=$1
  local value
  value=$(env_value "$key")
  [[ -n "$value" ]] || die "env key must be non-empty: $key"
}

assert_port() {
  local key=$1
  local value
  value=$(env_value "$key")
  [[ "$value" =~ ^[0-9]+$ ]] || die "$key must be numeric"
  (( value >= 28451 && value <= 28455 )) || die "$key must stay in the Meet high-port block 28451-28455"
}

log "checking shell syntax"
bash -n "$SCRIPT_DIR/validate-meet-jitsi.sh" "$SCRIPT_DIR/common.sh"

log "checking compose Meet/Jitsi contract"
assert_contains "$COMPOSE_FILE" '^[[:space:]]+jitsi-web:$' "compose must define jitsi-web"
assert_contains "$COMPOSE_FILE" '^[[:space:]]+jitsi-prosody:$' "compose must define jitsi-prosody"
assert_contains "$COMPOSE_FILE" '^[[:space:]]+jitsi-jicofo:$' "compose must define jitsi-jicofo"
assert_contains "$COMPOSE_FILE" '^[[:space:]]+jitsi-jvb:$' "compose must define jitsi-jvb"
assert_contains "$COMPOSE_FILE" 'profiles: \["meet"\]' "Jitsi services must be behind the meet profile"
assert_contains "$COMPOSE_FILE" 'com\.helix\.core\.meet-jitsi' "Helix config must enable the Meet Jitsi plugin"
assert_contains "$COMPOSE_FILE" 'MEET_JITSI_DOMAIN: \$\{MEET_JITSI_DOMAIN:-meet\.localhost\}' "Helix must expose MEET_JITSI_DOMAIN"
assert_contains "$COMPOSE_FILE" 'MEET_JITSI_PUBLIC_URL: \$\{MEET_JITSI_PUBLIC_URL:-https://meet\.localhost:28452\}' "Helix must expose MEET_JITSI_PUBLIC_URL"
assert_contains "$COMPOSE_FILE" 'MEET_JITSI_JWT_SECRET: \$\{MEET_JITSI_JWT_SECRET:-' "Helix must expose the Meet JWT secret"
assert_contains "$COMPOSE_FILE" 'MEET_JITSI_WEBHOOK_SHARED_SECRET: \$\{MEET_JITSI_WEBHOOK_SHARED_SECRET:-' "Helix must expose the Jitsi webhook secret"
assert_contains "$COMPOSE_FILE" 'secretEnv":"MEET_JITSI_JWT_SECRET"' "plugin config must reference JWT secretEnv"
assert_contains "$COMPOSE_FILE" 'sharedSecretEnv":"MEET_JITSI_WEBHOOK_SHARED_SECRET"' "plugin config must reference webhook sharedSecretEnv"
assert_contains "$COMPOSE_FILE" 'AUTH_TYPE: jwt' "Jitsi services must use JWT auth"
assert_contains "$COMPOSE_FILE" 'ENABLE_AUTH: "1"' "Jitsi auth must be enabled"
assert_contains "$COMPOSE_FILE" 'ENABLE_GUESTS: "0"' "Jitsi guests must be disabled"
assert_contains "$COMPOSE_FILE" 'JVB_TCP_HARVESTER_DISABLED: "true"' "JVB TCP harvester must stay disabled for the local UDP path"
assert_contains "$COMPOSE_FILE" '\$\{JITSI_JVB_UDP_PORT:-28453\}:10000/udp' "JVB UDP port mapping must be present"

log "checking env example"
required_env_keys=(
  MEET_JITSI_DOMAIN
  MEET_JITSI_PUBLIC_URL
  MEET_JITSI_JWT_APP_ID
  MEET_JITSI_JWT_ISSUER
  MEET_JITSI_JWT_AUDIENCE
  MEET_JITSI_JWT_SECRET
  MEET_JITSI_TOKEN_TTL_SECONDS
  MEET_JITSI_WEBHOOK_SHARED_SECRET
  JITSI_WEB_HTTP_PORT
  JITSI_WEB_HTTPS_PORT
  JITSI_JVB_UDP_PORT
  JITSI_PROSODY_C2S_PORT
  JITSI_PROSODY_HTTP_PORT
  JITSI_XMPP_DOMAIN
  JITSI_XMPP_AUTH_DOMAIN
  JITSI_XMPP_MUC_DOMAIN
  JITSI_XMPP_INTERNAL_MUC_DOMAIN
  JITSI_JICOFO_AUTH_PASSWORD
  JITSI_JICOFO_COMPONENT_SECRET
  JITSI_JVB_AUTH_PASSWORD
)

for key in "${required_env_keys[@]}"; do
  assert_env_non_empty "$key"
done

assert_port JITSI_WEB_HTTP_PORT
assert_port JITSI_WEB_HTTPS_PORT
assert_port JITSI_JVB_UDP_PORT
assert_port JITSI_PROSODY_C2S_PORT
assert_port JITSI_PROSODY_HTTP_PORT

ports=$(sed -n 's/^\(JITSI_.*_PORT\)=\([0-9][0-9]*\)$/\2/p' "$ENV_FILE")
unique_port_count=$(printf '%s\n' "$ports" | sort -u | wc -l | tr -d ' ')
port_count=$(printf '%s\n' "$ports" | wc -l | tr -d ' ')
[[ "$unique_port_count" == "$port_count" ]] || die "Jitsi env example ports must not collide"

ttl=$(env_value MEET_JITSI_TOKEN_TTL_SECONDS)
[[ "$ttl" =~ ^[0-9]+$ ]] || die "MEET_JITSI_TOKEN_TTL_SECONDS must be numeric"
(( ttl >= 300 && ttl <= 86400 )) || die "MEET_JITSI_TOKEN_TTL_SECONDS must be between 300 and 86400 seconds"

domain=$(env_value MEET_JITSI_DOMAIN)
public_url=$(env_value MEET_JITSI_PUBLIC_URL)
[[ "$domain" == meet.* ]] || die "MEET_JITSI_DOMAIN should use a meet.* host"
[[ "$public_url" == https://"$domain"* ]] || die "MEET_JITSI_PUBLIC_URL must use https and the configured MEET_JITSI_DOMAIN"

if grep -Eq '(^|[^A-Z0-9_])(JITSI_JWT_SECRET|JITSI_WEBHOOK_SECRET)([^A-Z0-9_]|$)' "$ENV_FILE"; then
  die "env example must use canonical MEET_JITSI_* secret names"
fi

log "Meet Jitsi static validation complete"
