#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/validate-caddy-hardening.sh [options]

Validates the Tier 2 Caddy upstream mTLS hardening example without requiring Docker.

Options:
  --caddyfile <path>       Default: infra/caddy/examples/tier2-upstream-mtls.Caddyfile
  --live                   Exercise body/header/time limits and a concurrent flood through Caddy
  -h, --help

Checks:
  - public edge TLS is configured
  - upstream reverse_proxy uses HTTPS
  - transport enables TLS, trusted CA, SNI, and client certificate auth
  - complete browser security headers are present on the default and mTLS edges
  - health/readiness are proxied to the app rather than forged at the edge
  - bounded headers/bodies, slow-client timeouts, streaming, and upstream backpressure
  - local Caddyfile adaptation runs when the caddy binary is installed
EOF
}

CADDYFILE=${HELIX_CADDY_MTLS_FILE:-infra/caddy/examples/tier2-upstream-mtls.Caddyfile}
LIVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --caddyfile) CADDYFILE=${2:?missing caddyfile}; shift 2 ;;
    --live) LIVE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

ensure_repo_root
[[ -f "$CADDYFILE" ]] || die "caddyfile not found: $CADDYFILE"
require_cmd grep

assert_contains() {
  local pattern=$1
  local message=$2
  if ! grep -Eq -- "$pattern" "$CADDYFILE"; then
    die "$message"
  fi
}

log "checking Caddy mTLS hardening contract: $CADDYFILE"
assert_contains '^[[:space:]]*tls[[:space:]]+/etc/caddy/tls/helix\.crt[[:space:]]+/etc/caddy/tls/helix\.key[[:space:]]*\{' \
  "edge TLS certificate/key directive is missing"
assert_contains '^[[:space:]]*protocols[[:space:]]+tls1\.2[[:space:]]+tls1\.3$' \
  "edge TLS must allow only TLS 1.2 and 1.3"
assert_contains 'Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"' \
  "HSTS preload header is missing"
assert_contains 'X-Frame-Options "DENY"' \
  "frame denial header is missing"
assert_contains 'Permissions-Policy ".*camera=\(self.*microphone=\(self.*geolocation=\(\).*"' \
  "restricted Permissions-Policy header is missing"
assert_contains '^[[:space:]]*reverse_proxy[[:space:]]+https://\{\$HELIX_UPSTREAM:' \
  "upstream reverse_proxy must use HTTPS"
assert_contains '^[[:space:]]*transport[[:space:]]+http[[:space:]]*\{' \
  "reverse_proxy transport block is missing"
assert_contains '^[[:space:]]*tls$' \
  "upstream transport TLS is missing"
assert_contains '^[[:space:]]*tls_server_name[[:space:]]+\{\$HELIX_UPSTREAM_SNI:' \
  "upstream TLS SNI override is missing"
assert_contains '^[[:space:]]*tls_trusted_ca_certs[[:space:]]+/etc/caddy/mtls/ca\.crt$' \
  "upstream trusted CA is missing"
assert_contains '^[[:space:]]*tls_client_auth[[:space:]]+/etc/caddy/mtls/caddy-client\.crt[[:space:]]+/etc/caddy/mtls/caddy-client\.key$' \
  "upstream client certificate authentication is missing"

check_browser_headers() {
  local file=$1
  local token
  for token in \
    Strict-Transport-Security \
    Content-Security-Policy \
    "frame-ancestors 'none'" \
    Permissions-Policy \
    Referrer-Policy \
    X-Content-Type-Options \
    X-Frame-Options \
    Cross-Origin-Opener-Policy \
    Cross-Origin-Resource-Policy \
    Origin-Agent-Cluster
  do
    grep -Fq -- "$token" "$file" || die "browser security header missing from $file: $token"
  done
  if grep -Fq -- "frame-src 'self' https:" "$file"; then
    die "frame-src in $file trusts every HTTPS origin"
  fi
  if grep -Eq -- '^[[:space:]]*respond[[:space:]]+@health' "$file"; then
    die "health/readiness must be proxied to the application in $file"
  fi
}

check_request_hardening() {
  local file=$1
  local token
  for token in \
    "max_header_size 32KB" \
    "keepalive_interval 30s" \
    "read_header 10s" \
    "read_body 2m" \
    "idle 2m" \
    "method PUT" \
    "path /v1/dav/files/*" \
    "/v1/api/tools/drive.finalize" \
    "/v1/api/tools/mail.send" \
    "max_size 2MB" \
    "max_size 32MB" \
    "max_size 64MB" \
    "stream_timeout 24h" \
    "stream_close_delay 5m" \
    "dial_timeout 5s" \
    "response_header_timeout 2m" \
    "read_timeout 5m" \
    "write_timeout 2m" \
    "max_response_header 64KB" \
    "max_conns_per_host 2048"
  do
    grep -Fq -- "$token" "$file" || die "request hardening missing from $file: $token"
  done
  if grep -Eq -- '^[[:space:]]*(request_buffers|response_buffers)[[:space:]]' "$file"; then
    die "whole-body reverse-proxy buffering is forbidden in $file"
  fi
}

check_browser_headers infra/caddy/Caddyfile.production
check_browser_headers "$CADDYFILE"
check_request_hardening "$CADDYFILE"
DEFAULT_CADDYFILE=infra/caddy/Caddyfile
if [[ "$CADDYFILE" != "$DEFAULT_CADDYFILE" ]]; then
  check_browser_headers "$DEFAULT_CADDYFILE"
  check_request_hardening "$DEFAULT_CADDYFILE"
fi

if command -v caddy >/dev/null 2>&1; then
  HELIX_DOMAIN=${HELIX_DOMAIN:-helix.example.com} caddy adapt --config "$CADDYFILE" --adapter caddyfile >/dev/null
  log "Caddyfile adaptation passed"
else
  log "caddy binary not found; skipped Caddyfile adaptation"
fi

if bool_true "$LIVE"; then
  require_cmd node
  node infra/scripts/caddy-request-limits-smoke.mjs
fi

log "Caddy mTLS hardening validation complete"
