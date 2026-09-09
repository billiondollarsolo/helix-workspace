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
  - host roles and lobby/A-V/chat controls are enforced by Prosody/Jicofo
  - required env example keys are present and non-empty
  - local dev ports stay in the Helix high-port block and do not collide
  - public URL and Meet domain are consistent
  - XMPP clients verify a private CA and reject an untrusted certificate
  - owned short-lived TURN is configured without committed credentials
  - signaling and media workloads use separate restricted networks
  - production HA chart is locked, multi-region, autoscaled, and drain-safe
  - the opt-in live gate cannot silently substitute mocked or direct media
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
require_cmd node
require_cmd sed
require_cmd seq
require_cmd sort
require_cmd wc
require_cmd openssl
require_cmd helm
require_cmd kubectl

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

assert_not_contains() {
  local file=$1
  local pattern=$2
  local message=$3
  if grep -Eq -- "$pattern" "$file"; then
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
assert_contains "$COMPOSE_FILE" 'HELIX_JITSI_ORG_ID: \$\{HELIX_JITSI_ORG_ID:-\}' "Jibri must accept tenant org context for recording uploads"
assert_contains "$COMPOSE_FILE" 'HELIX_JITSI_WEBHOOK_SECRET: \$\{MEET_JITSI_WEBHOOK_SHARED_SECRET:-' "Jibri must receive the same webhook HMAC secret"
assert_contains infra/meet/finalize/finalize.sh 'X-Helix-Signature:' "Jibri callbacks must use timestamped HMAC signatures"
assert_contains infra/meet/finalize/finalize.sh '/internal/meet/recording-uploads' "Jibri must prepare tenant-bound recording uploads"
assert_contains infra/meet/finalize/finalize.sh 'ffprobe' "Jibri finalization must derive a real recording duration"
assert_contains infra/meet/finalize/finalize.sh 'startedAt: \$startedAt' "Jibri must bind recording timestamps to prepare and completion"
assert_contains infra/meet/finalize/finalize.sh 'sha256: \$sha256' "Jibri must bind the recording digest to prepare and completion"
assert_contains "$COMPOSE_FILE" 'secretEnv":"MEET_JITSI_JWT_SECRET"' "plugin config must reference JWT secretEnv"
assert_contains "$COMPOSE_FILE" 'sharedSecretEnv":"MEET_JITSI_WEBHOOK_SHARED_SECRET"' "plugin config must reference webhook sharedSecretEnv"
assert_contains "$COMPOSE_FILE" 'AUTH_TYPE: jwt' "Jitsi services must use JWT auth"
assert_contains "$COMPOSE_FILE" 'ENABLE_AUTH: "1"' "Jitsi auth must be enabled"
assert_contains "$COMPOSE_FILE" 'ENABLE_GUESTS: "0"' "Jitsi guests must be disabled"
assert_contains "$COMPOSE_FILE" 'ENABLE_LOBBY: "1"' "Prosody lobby enforcement must be enabled"
assert_contains "$COMPOSE_FILE" 'ENABLE_AV_MODERATION: "1"' "A/V moderation must be media enforced"
assert_contains "$COMPOSE_FILE" 'PROSODY_ENABLE_FILTER_MESSAGES: "1"' "chat policy must be enforced by Prosody"
assert_contains "$COMPOSE_FILE" 'XMPP_MUC_MODULES: token_affiliation' "moderator affiliation must come from signed token claims"
assert_contains "$COMPOSE_FILE" 'ENABLE_AUTO_OWNER: "0"' "Jicofo must not promote the first attendee"
assert_contains "$COMPOSE_FILE" 'ENABLE_MODERATOR_CHECKS: "1"' "Jicofo moderator checks must be enabled"
assert_contains infra/meet/custom-config.js 'enableFeaturesBasedOnToken = true' "Jitsi UI must honor signed feature claims"
assert_contains infra/meet/custom-config.js 'groupChatRequiresPermission = true' "group chat must require a token permission"
assert_contains "$COMPOSE_FILE" 'jitsi-web-config:/config' "Jitsi web runtime config must use a generated volume"
assert_contains "$COMPOSE_FILE" 'jitsi-prosody-config:/config' "Prosody runtime config must use a generated volume"
assert_contains "$COMPOSE_FILE" 'JVB_TCP_HARVESTER_DISABLED: "true"' "JVB TCP harvester must stay disabled for the local UDP path"
assert_contains "$COMPOSE_FILE" '127\.0\.0\.1:\$\{JITSI_JVB_UDP_PORT:-28453\}:10000/udp' "JVB UDP port mapping must be loopback-only in local Compose"
assert_contains "$COMPOSE_FILE" 'image: coturn/coturn:[^@]+@sha256:' "owned TURN must use a pinned Coturn image"
assert_contains "$COMPOSE_FILE" 'TURN_TTL: "600"' "TURN credentials must be short lived"
assert_contains "$COMPOSE_FILE" 'jitsi_turn_shared_secret' "TURN auth must come from a Docker secret"
assert_contains "$COMPOSE_FILE" 'ENABLE_P2P: "0"' "P2P must not bypass managed media policy"
assert_contains "$COMPOSE_FILE" 'networks: \[meet-control, meet-media\]' "JVB must bridge only the control and media networks"
assert_contains "$COMPOSE_FILE" '^[[:space:]]+meet-control:$' "compose must define the restricted Meet control network"
assert_contains "$COMPOSE_FILE" '^[[:space:]]+internal: true$' "Meet control networking must be internal"
assert_contains infra/meet/jvb/custom-jvb.conf 'DISABLE_CERTIFICATE_VERIFICATION = false' "JVB must verify Prosody certificates"
assert_contains infra/meet/jicofo/custom-jicofo.conf 'disable-certificate-verification = false' "Jicofo must verify Prosody certificates"
assert_contains "$COMPOSE_FILE" 'XMPP_TRUST_ALL_CERTS: "false"' "Jibri must verify Prosody certificates"
assert_contains "$COMPOSE_FILE" 'javax\.net\.ssl\.trustStore=/run/secrets/jitsi_xmpp_truststore' "Java XMPP clients must use the injected private CA"
assert_not_contains "$COMPOSE_FILE" 'meet-jit-si-turnrelay\.jitsi\.net' "public Jitsi STUN/TURN is forbidden"
assert_not_contains infra/meet/custom-config.js 'meet-jit-si-turnrelay\.jitsi\.net' "browser config must not use public Jitsi STUN/TURN"

log "checking real-browser media gate"
LIVE_SPEC=apps/web/tests/e2e/meet-live-media.spec.ts
LIVE_WORKFLOW=.github/workflows/meet-live-media.yml
[[ -f "$LIVE_SPEC" ]] || die "real-browser Meet gate is missing"
[[ -f "$LIVE_WORKFLOW" ]] || die "scheduled Meet media workflow is missing"
assert_contains apps/web/playwright.config.ts 'meet-live-media\.spec\.ts' "ordinary E2E must exclude the live media gate"
assert_contains apps/web/playwright.meet-live.config.ts 'testMatch: "meet-live-media\.spec\.ts"' "live config must select only the media gate"
browser_launches=$(grep -Ec '^[[:space:]]+launchSyntheticBrowser\(\),' "$LIVE_SPEC")
(( browser_launches == 2 )) || die "media gate must launch two independent browsers"
assert_contains "$LIVE_SPEC" 'iceTransportPolicy: "relay"' "media gate must force TURN relay candidates"
assert_contains "$LIVE_SPEC" 'stats\.inbound\.audio' "media gate must prove inbound audio bytes"
assert_contains "$LIVE_SPEC" 'stats\.inbound\.video' "media gate must prove inbound video bytes"
assert_contains "$LIVE_SPEC" 'stats\.outbound\.audio' "media gate must prove outbound audio bytes"
assert_contains "$LIVE_SPEC" 'stats\.outbound\.video' "media gate must prove outbound video bytes"
assert_contains "$LIVE_SPEC" 'meet\.host-controls\.apply' "media gate must exercise authoritative host controls"
assert_contains "$LIVE_SPEC" 'setOffline\(true\)' "media gate must exercise reconnect"
assert_contains "$LIVE_SPEC" 'startRecording' "media gate must record real conference media"
assert_contains "$LIVE_SPEC" 'createHash\("sha256"\).*recordedBytes' "media gate must verify stored recording bytes"
assert_not_contains "$LIVE_SPEC" 'mockJitsi|route\.fulfill|test\.skip' "live media evidence must never use a mock or skip"
assert_contains "$LIVE_WORKFLOW" '^  schedule:' "live media workflow must run on a schedule"
assert_contains "$LIVE_WORKFLOW" 'environment: meet-live' "live media secrets must use a protected environment"
assert_contains "$LIVE_WORKFLOW" 'pnpm quality:meet-live-media' "workflow must execute the real media gate"

if grep -RIE --exclude='*.md' '(TURN_CREDENTIALS|static-auth-secret)[=:][[:space:]]*[A-Za-z0-9_]{16,}' infra/meet "$COMPOSE_FILE" >/dev/null; then
  die "TURN credentials must not be committed"
fi

if find infra/meet/config -type f -name '*.key' -print -quit | grep -q .; then
  die "Meet private keys must never exist in the repository config tree"
fi

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

log "checking fail-closed certificate verification"
tls_dir=$(mktemp -d "${TMPDIR:-/tmp}/helix-meet-tls.XXXXXX")
trap 'rm -rf "$tls_dir"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=trusted-ca \
  -keyout "$tls_dir/trusted-ca.key" -out "$tls_dir/trusted-ca.crt" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=wrong-ca \
  -keyout "$tls_dir/wrong-ca.key" -out "$tls_dir/wrong-ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=auth.meet.jitsi \
  -keyout "$tls_dir/xmpp.key" -out "$tls_dir/xmpp.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:auth.meet.jitsi,DNS:jitsi-prosody\n' > "$tls_dir/xmpp.ext"
openssl x509 -req -days 1 -in "$tls_dir/xmpp.csr" \
  -CA "$tls_dir/trusted-ca.crt" -CAkey "$tls_dir/trusted-ca.key" -CAcreateserial \
  -extfile "$tls_dir/xmpp.ext" -out "$tls_dir/xmpp.crt" >/dev/null 2>&1
openssl verify -verify_hostname auth.meet.jitsi -CAfile "$tls_dir/trusted-ca.crt" \
  "$tls_dir/xmpp.crt" >/dev/null
if openssl verify -verify_hostname auth.meet.jitsi -CAfile "$tls_dir/wrong-ca.crt" \
  "$tls_dir/xmpp.crt" >/dev/null 2>&1; then
  die "an XMPP certificate from an untrusted CA must fail verification"
fi
tls_port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
openssl s_server -quiet -naccept 3 -accept "127.0.0.1:$tls_port" \
  -cert "$tls_dir/xmpp.crt" -key "$tls_dir/xmpp.key" >"$tls_dir/server.log" 2>&1 &
tls_server_pid=$!
for _ in $(seq 1 50); do
  openssl s_client -brief -connect "127.0.0.1:$tls_port" </dev/null >/dev/null 2>&1 && break
  sleep 0.02
done
kill -0 "$tls_server_pid" 2>/dev/null || die "test TLS server did not start"
if openssl s_client -quiet -verify_return_error -verify_hostname auth.meet.jitsi \
  -CAfile "$tls_dir/wrong-ca.crt" -connect "127.0.0.1:$tls_port" </dev/null >/dev/null 2>&1; then
  die "an XMPP connection using an untrusted certificate must fail closed"
fi
openssl s_client -quiet -verify_return_error -verify_hostname auth.meet.jitsi \
  -CAfile "$tls_dir/trusted-ca.crt" -connect "127.0.0.1:$tls_port" </dev/null >/dev/null 2>&1
wait "$tls_server_pid"

log "checking production Meet HA topology"
"$PWD/infra/meet/ha/validate.sh"

log "Meet Jitsi static validation complete"
