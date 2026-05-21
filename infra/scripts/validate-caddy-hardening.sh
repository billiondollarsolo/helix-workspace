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
  -h, --help

Checks:
  - public edge TLS is configured
  - upstream reverse_proxy uses HTTPS
  - transport enables TLS, trusted CA, SNI, and client certificate auth
  - strict security headers are present
  - local caddy validate runs when the caddy binary is installed
EOF
}

CADDYFILE=${HELIX_CADDY_MTLS_FILE:-infra/caddy/examples/tier2-upstream-mtls.Caddyfile}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --caddyfile) CADDYFILE=${2:?missing caddyfile}; shift 2 ;;
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
assert_contains 'Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\)"' \
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

if command -v caddy >/dev/null 2>&1; then
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
  log "caddy syntax validation passed"
else
  log "caddy binary not found; skipped caddy syntax validation"
fi

log "Caddy mTLS hardening validation complete"
