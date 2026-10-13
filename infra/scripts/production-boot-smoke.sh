#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/production-boot-smoke.sh [options]

Boots the production Compose stack from nothing on this host and proves the
path a new deployment takes: generated secrets, one `up -d`, HTTPS at the edge,
first administrator, 2-step verification, an emailed invitation, a Drive
upload, download, and malware rejection, an agent using the secrets it was
granted, and replacing the HTTPS certificate from the Admin console. With
--with passwords it also installs the optional
password manager and proves it is served on its own address, sends its
sign-up confirmation, and appears for people once an administrator turns it on.
With --with meet it adds docker-compose.meet.yml and holds a real meeting: two
headless browsers join with passes Helix signed, each must receive the other's
audio and video through the bridge over an encrypted connection, and a forged
pass must be turned away. That needs Playwright's Chromium
(pnpm --filter @helix/web exec playwright install chromium).

Images are built from this checkout; nothing is pulled from the Helix registry
and nothing is published beyond 127.0.0.1. Everything the run creates is
removed afterwards unless --keep is given.

Options:
  --tls <internal|files>  Certificate source at the edge. internal uses Caddy's
                          own CA; files serves an operator certificate through
                          docker-compose.tls-files.yml. Default: internal
  --with <install>        Also start an optional install: passwords or meet.
                          Repeat the option for both.
  --skip-build            Reuse images from an earlier run
  --keep                  Leave the stack and its work directory in place
  --project <name>        Compose project name. Default: helixbootsmoke
  --https-port <port>     Default: 28843
  --http-port <port>      Default: 28880
  --smtp-port <port>      Default: 28825
  -h, --help              Show this help
EOF
}

TLS_MODE=internal
WITH_PASSWORDS=0
WITH_MEET=0
SKIP_BUILD=0
KEEP=0
PROJECT=helixbootsmoke
HTTPS_PORT=28843
HTTP_PORT=28880
SMTP_PORT=28825
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tls) TLS_MODE=${2:?missing value for --tls}; shift 2 ;;
    --with)
      case "${2:?missing value for --with}" in
        passwords) WITH_PASSWORDS=1 ;;
        meet) WITH_MEET=1 ;;
        *) die "--with accepts: passwords, meet" ;;
      esac
      shift 2
      ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --keep) KEEP=1; shift ;;
    --project) PROJECT=${2:?missing value for --project}; shift 2 ;;
    --https-port) HTTPS_PORT=${2:?missing value for --https-port}; shift 2 ;;
    --http-port) HTTP_PORT=${2:?missing value for --http-port}; shift 2 ;;
    --smtp-port) SMTP_PORT=${2:?missing value for --smtp-port}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
[[ "$TLS_MODE" == internal || "$TLS_MODE" == files ]] || die "--tls must be internal or files"

cd "$SCRIPT_DIR/../.."
ensure_repo_root
for command in docker node openssl curl; do require_cmd "$command"; done
# Older Compose releases merge the production files differently: some refuse
# them, and 2.24 quietly drops settings.
compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//')
if [[ "$(printf '%s\n' 2.27.0 "${compose_version:-0}" | sort -V | head -n 1)" != 2.27.0 ]]; then
  die "Docker Compose 2.27 or newer is required (found ${compose_version:-none})"
fi
if [[ "$WITH_MEET" == 1 ]] && ! node -e '
  const { createRequire } = require("node:module");
  const { chromium } = createRequire(process.cwd() + "/apps/web/package.json")("@playwright/test");
  if (!require("node:fs").existsSync(chromium.executablePath())) process.exit(1);
' 2>/dev/null; then
  die "--with meet holds a real meeting and needs Playwright's Chromium: pnpm install && pnpm --filter @helix/web exec playwright install chromium"
fi

# Cleanup removes the project's containers and volumes, so never adopt one.
if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] ||
  docker network inspect "$PROJECT-data-plane" >/dev/null 2>&1; then
  die "Compose project $PROJECT already exists; remove it or choose another --project"
fi

DOMAIN=helix.bootsmoke.test
VAULT_DOMAIN=vault.bootsmoke.test
MEET_DOMAIN=meet.bootsmoke.test
ORG_NAME="Boot Smoke Workspace"
OWNER_EMAIL="owner@$DOMAIN"
OWNER_PASSWORD="Boot-smoke-$(openssl rand -hex 12)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/helix-boot-smoke.XXXXXX")
# Lets someone sign in to a stack left running with --keep.
printf '%s\n%s\n' "$OWNER_EMAIL" "$OWNER_PASSWORD" >"$WORK/owner-sign-in.txt"
SECRETS="$WORK/secrets"
APP_IMAGE=helix/workspace:boot-smoke
WEB_IMAGE=helix/workspace-web:boot-smoke
FAILURES=0

compose_files=(-f docker-compose.yml -f docker-compose.production.yml)
[[ "$TLS_MODE" == files ]] && compose_files+=(-f docker-compose.tls-files.yml)
[[ "$WITH_MEET" == 1 ]] && compose_files+=(-f docker-compose.meet.yml)
compose_files+=(-f "$WORK/smoke.override.yml")
compose() {
  docker compose -p "$PROJECT" --env-file "$WORK/env.production" "${compose_files[@]}" "$@"
}

cleanup() {
  local status=$?
  if [[ "$KEEP" == 1 ]]; then
    log "Kept project $PROJECT and $WORK"
  else
    [[ -f "$WORK/env.production" ]] && compose down --volumes --remove-orphans >/dev/null 2>&1
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}
expect() {
  local label=$1 actual=$2 expected=$3
  if [[ "$actual" == "$expected" ]]; then pass "$label"; else fail "$label (expected $expected, got $actual)"; fi
}
json() { node -e '
  const path = process.argv[1].split(".");
  let value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  for (const key of path) value = value?.[key];
  process.stdout.write(value === undefined || value === null ? "" : String(value));
' "$1"; }
totp() { node -e '
  const { createHmac } = require("node:crypto");
  const secret = new URL(process.argv[1]).searchParams.get("secret").toUpperCase();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/u, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/gu).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  process.stdout.write(String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0"));
' "$1"; }

# --- Inputs a new deployment prepares --------------------------------------

log "Generating secrets in $SECRETS"
node infra/scripts/generate-production-secrets.mjs --dir "$SECRETS" --mail-host "mail.$DOMAIN" >/dev/null
openssl rand -hex 24 >"$SECRETS/mail_smtp_password"
if [[ "$WITH_MEET" == 1 ]]; then
  node infra/scripts/generate-production-secrets.mjs --add-meet --dir "$SECRETS" \
    --meet-host "$MEET_DOMAIN" >/dev/null
fi

# issue_certificate <file name> <host> [more hosts...]
issue_certificate() {
  local name=$1 host=$2 names
  shift
  names=$(printf 'DNS:%s,' "$@")
  openssl req -newkey rsa:2048 -nodes -keyout "$WORK/$name.key" -out "$WORK/$name.csr" \
    -subj "/CN=$host" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "${names%,}" >"$WORK/$name.ext"
  openssl x509 -req -in "$WORK/$name.csr" -CA "$SECRETS/ca/ca.pem" -CAkey "$SECRETS/ca/ca.key" \
    -CAcreateserial -out "$WORK/$name.pem" -days 2 -extfile "$WORK/$name.ext" 2>/dev/null
  chmod 0644 "$WORK/$name.key" "$WORK/$name.pem"
}
# The stand-in mail provider requires STARTTLS, as a real one does.
issue_certificate relay relay
if [[ "$TLS_MODE" == files ]]; then
  # One operator certificate covers every site the edge serves.
  edge_names=("$DOMAIN")
  [[ "$WITH_PASSWORDS" == 1 ]] && edge_names+=("$VAULT_DOMAIN")
  [[ "$WITH_MEET" == 1 ]] && edge_names+=("$MEET_DOMAIN")
  issue_certificate edge "${edge_names[@]}"
  cat "$WORK/edge.pem" "$SECRETS/ca/ca.pem" >"$SECRETS/tls_cert"
  cp "$WORK/edge.key" "$SECRETS/tls_key"
  chmod 0644 "$SECRETS/tls_cert" "$SECRETS/tls_key"
  EDGE_CA="$SECRETS/ca/ca.pem"
else
  EDGE_CA="$WORK/caddy-root.crt"
fi

placeholder_digest=$(printf 'a%.0s' {1..64})
{
  printf 'HELIX_DOMAIN=%s\nHELIX_REGION=eu-test\nHELIX_DEFAULT_ORG_NAME=%s\n' "$DOMAIN" "$ORG_NAME"
  printf 'HELIX_PRODUCTION_SECRETS_DIR=%s\n' "$SECRETS"
  # Also prefixes the networks, keeping this run off a real deployment's.
  printf 'HELIX_COMPOSE_PROJECT_NAME=%s\n' "$PROJECT"
  for pair in HELIX_IMAGE: HELIX_WEB_IMAGE:-web HELIX_POSTGRES_IMAGE:-postgres HELIX_NATS_IMAGE:-nats \
    HELIX_MEILISEARCH_IMAGE:-meilisearch HELIX_CERBOS_IMAGE:-cerbos HELIX_SPAMD_IMAGE:-spamassassin \
    HELIX_CLAMAV_IMAGE:-clamav; do
    printf '%s=ghcr.io/billiondollarsolo/helix-workspace%s@sha256:%s\n' \
      "${pair%%:*}" "${pair#*:}" "$placeholder_digest"
  done
  cat <<EOF
MAIL_PROVIDER=smtp-relay
MAIL_FROM_DOMAIN=$DOMAIN
MAIL_SMTP_HOST=relay
MAIL_SMTP_PORT=1025
MAIL_SMTP_USER=helix
MAIL_SMTP_SECURE=false
HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED=true
HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED=true
HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED=true
HELIX_BACKUP_MANIFEST_HMAC_KEY_REF=vault://boot-smoke/backup-hmac
DRIVE_CLAMAV_MAX_BYTES=1073741824
DRIVE_CLAMAV_SCANNER_VERSION=clamd
CADDY_BIND_IP=127.0.0.1
CADDY_HTTP_PORT=$HTTP_PORT
CADDY_HTTPS_PORT=$HTTPS_PORT
HELIX_SMTP_RECEIVE_BIND_IP=127.0.0.1
HELIX_SMTP_RECEIVE_PORT=$SMTP_PORT
EOF
  [[ "$TLS_MODE" == internal ]] && printf 'HELIX_CADDY_TLS=internal\n'
  # What an operator adds to install the optional password manager.
  [[ "$WITH_PASSWORDS" == 1 ]] &&
    printf 'COMPOSE_PROFILES=passwords\nHELIX_PASSWORDS_DOMAIN=%s\n' "$VAULT_DOMAIN"
  # What an operator adds for Meet; the ports stay on this host for the test.
  [[ "$WITH_MEET" == 1 ]] && cat <<EOF
HELIX_MEET_DOMAIN=$MEET_DOMAIN
HELIX_MEET_PUBLIC_IP=127.0.0.1
HELIX_MEET_BIND_IP=127.0.0.1
HELIX_MEET_MEDIA_PORT=$((HTTPS_PORT + 1))
HELIX_MEET_TURN_PORT=$((HTTPS_PORT + 2))
HELIX_MEET_TURNS_PORT=$((HTTPS_PORT + 3))
EOF
  true
} >"$WORK/env.production"

# Test-only: images built from this checkout stand in for the published
# digests, and Mailpit stands in for the mail provider.
cat >"$WORK/smoke.override.yml" <<EOF
services:
  helix-migrate: { image: $APP_IMAGE, pull_policy: never }
  helix: { image: $APP_IMAGE, pull_policy: never }
  helix-storage-init: { image: $APP_IMAGE, pull_policy: never }
  caddy: { image: $WEB_IMAGE, pull_policy: never }
  postgres: { image: helix/postgres-pgvector:18.6-pgvector0.8.5, pull_policy: never }
  nats: { image: helix/nats-server:2.14.3-patched, pull_policy: never }
  meilisearch: { image: helix/meilisearch:1.51.0-patched, pull_policy: never }
  cerbos: { image: helix/cerbos:0.54.0-patched, pull_policy: never }
  spamd: { image: helix/spamassassin:4.0.2-patched, pull_policy: never }
  clamav: { image: helix/clamav:1.5.4-patched, pull_policy: never }
  relay:
    image: axllent/mailpit:v1.31.4@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48
    environment:
      MP_SMTP_TLS_CERT: /certs/relay.pem
      MP_SMTP_TLS_KEY: /certs/relay.key
      MP_SMTP_REQUIRE_STARTTLS: "true"
      MP_SMTP_AUTH_ACCEPT_ANY: "true"
    volumes:
      - $WORK/relay.pem:/certs/relay.pem:ro
      - $WORK/relay.key:/certs/relay.key:ro
    networks: [data-plane, edge]
EOF
# The stand-in provider's certificate comes from the deployment CA, which the
# password manager has no reason to trust; a real provider's is public.
if [[ "$WITH_PASSWORDS" == 1 ]]; then
  cat >>"$WORK/smoke.override.yml" <<EOF
  vaultwarden:
    environment:
      SMTP_ACCEPT_INVALID_CERTS: "true"
EOF
fi
# The bridge refuses to run with only a loopback address to advertise, which
# is right for a real deployment and is all this test has.
if [[ "$WITH_MEET" == 1 ]]; then
  cat >>"$WORK/smoke.override.yml" <<EOF
  jitsi-jvb:
    environment:
      JVB_REQUIRE_VALID_ADDRESS: "false"
EOF
fi

if [[ "$SKIP_BUILD" == 0 ]]; then
  log "Building images from this checkout"
  docker compose -f docker-compose.yml --profile mail-security build --quiet \
    postgres nats meilisearch cerbos spamd clamav
  docker buildx build --quiet -f infra/docker/Dockerfile --target runtime -t "$APP_IMAGE" . >/dev/null
  docker buildx build --quiet -f infra/docker/Dockerfile --target web-runtime -t "$WEB_IMAGE" . >/dev/null
fi

# --- One command brings the stack up ---------------------------------------

log "Starting the stack (the first start waits for ClamAV signatures)"
started=$SECONDS
compose up -d --quiet-pull 2>"$WORK/up.log" || {
  tail -n 30 "$WORK/up.log" >&2
  compose logs --tail 40 helix >&2 || true
  die "docker compose up failed"
}
pass "one 'docker compose up -d' reached a healthy stack in $((SECONDS - started))s"

for service in helix-migrate rustfs-kms-init rustfs-kms-key helix-storage-init; do
  container=$(compose ps -a -q "$service")
  expect "$service exited 0" "$(docker inspect -f '{{.State.ExitCode}}' "$container")" 0
done

if [[ "$TLS_MODE" == internal ]]; then
  until compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$EDGE_CA" >/dev/null 2>&1; do
    [[ $((SECONDS - started)) -lt 900 ]] || die "Caddy never issued its internal CA"
    sleep 2
  done
  # A certificate uploaded later in this run is signed by the deployment CA.
  cat "$SECRETS/ca/ca.pem" >>"$EDGE_CA"
fi

BASE="https://$DOMAIN"
JAR="$WORK/owner.jar"
edge() {
  curl -sS --cacert "$EDGE_CA" --connect-to "$DOMAIN:443:127.0.0.1:$HTTPS_PORT" "$@"
}
api() {
  local path=$1
  shift
  # A JSON content type on a request without a body is refused.
  local content_type='accept: application/json'
  [[ " $* " == *" -d "* ]] && content_type='content-type: application/json'
  edge -b "$JAR" -c "$JAR" -H "origin: $BASE" -H "$content_type" \
    -H "x-helix-csrf-token: ${CSRF:-}" "$BASE$path" "$@"
}
status_of() { api "$@" -o "$WORK/last.json" -w '%{http_code}'; }
VAULT="https://$VAULT_DOMAIN"
vault() {
  curl -sS --cacert "$EDGE_CA" --connect-to "$VAULT_DOMAIN:443:127.0.0.1:$HTTPS_PORT" "$@"
}
vault_status() { vault -o "$WORK/vault.json" -w '%{http_code}' "$@"; }
MEET="https://$MEET_DOMAIN"
meet() {
  curl -sS --cacert "$EDGE_CA" --connect-to "$MEET_DOMAIN:443:127.0.0.1:$HTTPS_PORT" "$@"
}
# relay_has_mail <Mailpit search query>
relay_has_mail() {
  for _ in {1..20}; do
    if compose exec -T relay wget -qO- "http://127.0.0.1:8025/api/v1/search?query=$1" |
      grep -q '"Subject"'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# --- Edge -------------------------------------------------------------------

until [[ "$(edge -o /dev/null -w '%{http_code}' "$BASE/readyz" 2>/dev/null)" == 200 ]]; do
  [[ $((SECONDS - started)) -lt 900 ]] || break
  sleep 3
done
expect "/readyz over verified HTTPS ($TLS_MODE certificate)" \
  "$(edge -o /dev/null -w '%{http_code}' "$BASE/readyz")" 200
expect "HTTP redirects to HTTPS" \
  "$(curl -sS -o /dev/null -w '%{http_code}' -H "host: $DOMAIN" "http://127.0.0.1:$HTTP_PORT/")" 308
if edge -I "$BASE/" | grep -qi '^strict-transport-security:'; then
  pass "HSTS header is sent"
else
  fail "HSTS header is sent"
fi
if edge "$BASE/" | grep -qi '<div id="root"'; then pass "web app is served"; else fail "web app is served"; fi
if [[ "$TLS_MODE" == files ]]; then
  issuer=$(echo | openssl s_client -connect "127.0.0.1:$HTTPS_PORT" -servername "$DOMAIN" 2>/dev/null |
    openssl x509 -noout -issuer)
  if [[ "$issuer" == *"Helix deployment internal CA"* ]]; then
    pass "edge serves the operator-provided certificate"
  else
    fail "edge serves the operator-provided certificate ($issuer)"
  fi
fi
if echo QUIT | openssl s_client -starttls smtp -connect "127.0.0.1:$SMTP_PORT" 2>/dev/null |
  grep -q 'BEGIN CERTIFICATE'; then
  pass "inbound SMTP offers STARTTLS"
else
  fail "inbound SMTP offers STARTTLS"
fi

# --- First administrator ----------------------------------------------------

bootstrap=$(compose exec -T helix /nodejs/bin/node dist/db/bootstrap-owner.js \
  --email "$OWNER_EMAIL" --name "Smoke Owner" 2>&1)
token=$(grep -o 'token=[A-Za-z0-9_-]*' <<<"$bootstrap" | head -n 1 | cut -d= -f2)
if [[ -n "$token" && "$bootstrap" == *"$BASE/signup/invite"* ]]; then
  pass "bootstrap-owner prints an invitation link on the public address"
else
  fail "bootstrap-owner prints an invitation link on the public address"
fi
expect "invitation opens" "$(status_of /v1/api/invites/inspect -d "{\"token\":\"$token\"}")" 200
if grep -q "$ORG_NAME" "$WORK/last.json"; then
  pass "invitation names the workspace \"$ORG_NAME\""
else
  fail "invitation names the workspace \"$ORG_NAME\" ($(head -c 200 "$WORK/last.json"))"
fi
expect "owner chooses a password" \
  "$(status_of /v1/api/invites/accept -d "{\"token\":\"$token\",\"password\":\"$OWNER_PASSWORD\"}")" 200
expect "owner signs in" \
  "$(status_of /v1/api/auth/sign-in/email -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}")" 200
CSRF=$(api /v1/api/auth/csrf-token | json csrfToken)
expect "owner reads mail" "$(status_of /v1/api/tools/mail.threads.list -d '{}')" 200

invite='{"email":"second@'$DOMAIN'","displayName":"Second Person"}'
expect "admin action is refused before 2-step verification" \
  "$(status_of /v1/api/admin/users/invite -d "$invite")" 403
totp_uri=$(api /v1/api/auth/two-factor/enable -d "{\"password\":\"$OWNER_PASSWORD\"}" | json totpURI)
printf '%s\n' "$totp_uri" >>"$WORK/owner-sign-in.txt"
verify_code() {
  status_of /v1/api/auth/two-factor/verify-totp -d "{\"code\":\"$(totp "$totp_uri")\"}"
}
expect "owner enrolls an authenticator app" "$(verify_code)" 200
expect "administrator invites a person" "$(status_of /v1/api/admin/users/invite -d "$invite")" 201

# Administrator sessions must be verified again after the policy interval
# (10 minutes by default). Age this session instead of waiting for it.
compose exec -T postgres sh -c 'psql -q "postgresql://helix_app:$(cat /run/secrets/postgres_app_password)@localhost:5432/helix?sslmode=require" \
  -c "update \"session\" set mfa_verified_at = now() - interval '"'"'11 minutes'"'"'"' >/dev/null
expect "a lapsed administrator session is refused" "$(status_of '/v1/api/admin/users?limit=1')" 401
if grep -q session_reauthentication_required "$WORK/last.json"; then
  pass "the refusal asks for the session to be verified again"
else
  fail "the refusal asks for the session to be verified again ($(head -c 200 "$WORK/last.json"))"
fi
expect "a fresh code verifies the same session" "$(verify_code)" 200
expect "the administrator carries on without signing in again" \
  "$(status_of '/v1/api/admin/users?limit=1')" 200

if relay_has_mail "to:second@$DOMAIN"; then
  pass "invitation email reaches the mail provider over STARTTLS"
else
  fail "invitation email reaches the mail provider over STARTTLS"
fi

# --- Optional install: password manager ------------------------------------

passwords_field() { api /v1/api/core-apps | json "passwords.$1"; }
if [[ "$WITH_PASSWORDS" == 0 ]]; then
  expect "no password manager is offered when none is installed" "$(passwords_field installed)" false
else
  for _ in {1..40}; do
    [[ "$(vault_status "$VAULT/alive" 2>/dev/null)" == 200 ]] && break
    sleep 3
  done
  expect "password manager answers on its own address over verified HTTPS" \
    "$(vault_status "$VAULT/alive")" 200
  expect "it is the bundled Vaultwarden" "$(vault "$VAULT/api/config" | json server.name)" Vaultwarden
  vault_headers=$(vault -I "$VAULT/")
  if grep -qi '^strict-transport-security:' <<<"$vault_headers" &&
    grep -qi '^content-security-policy:' <<<"$vault_headers"; then
    pass "its site sends HSTS and the vault's own content policy"
  else
    fail "its site sends HSTS and the vault's own content policy"
  fi
  # A disabled administration page answers with a notice; its pages do not exist.
  if vault "$VAULT/admin" | grep -q 'admin panel is disabled' &&
    [[ "$(vault_status "$VAULT/admin/users/overview")" == 404 ]]; then
    pass "its server administration page is off"
  else
    fail "its server administration page is off"
  fi
  if edge "$BASE/alive" | grep -qi '<div id="root"'; then
    pass "the workspace address does not serve the vault"
  else
    fail "the workspace address does not serve the vault"
  fi

  register() {
    vault_status "$VAULT/identity/accounts/register/send-verification-email" \
      -H 'content-type: application/json' -d "{\"email\":\"$1\",\"name\":\"Smoke Person\"}"
  }
  outsider_status=$(register "someone@elsewhere.test")
  if [[ "$outsider_status" == 4* ]]; then
    pass "sign-up is refused outside the workspace's mail domain"
  else
    fail "sign-up is refused outside the workspace's mail domain (got $outsider_status)"
  fi
  member_status=$(register "vaultuser@$DOMAIN")
  if [[ "$member_status" == 2* ]]; then
    pass "sign-up with a workspace address is accepted"
  else
    fail "sign-up with a workspace address is accepted (got $member_status: $(head -c 200 "$WORK/vault.json"))"
  fi
  if relay_has_mail "to:vaultuser@$DOMAIN"; then
    pass "its confirmation email reaches the mail provider over STARTTLS"
  else
    fail "its confirmation email reaches the mail provider over STARTTLS"
  fi

  expect "the workspace knows a password manager is installed" "$(passwords_field installed)" true
  expect "people are not offered it until an administrator turns it on" "$(passwords_field url)" ""
  expect "an administrator turns Passwords on" \
    "$(status_of /v1/api/admin/tenant-config -X PATCH \
      -d '{"features":{"passwords_app":true},"reason":"boot smoke"}')" 200
  expect "people are then sent to the password manager" "$(passwords_field url)" "$VAULT"
fi

# --- Optional install: Meet -------------------------------------------------

app_registered() {
  api /v1/api/core-apps | node -e '
    const apps = JSON.parse(require("node:fs").readFileSync(0, "utf8")).apps ?? [];
    process.stdout.write(String(apps.find((app) => app.id === process.argv[1])?.registered ?? false));
  ' "$1"
}
if [[ "$WITH_MEET" == 0 ]]; then
  expect "Meet is not served when it is not installed" "$(app_registered meet)" false
else
  for _ in {1..40}; do
    [[ "$(meet -o /dev/null -w '%{http_code}' "$MEET/" 2>/dev/null)" == 200 ]] && break
    sleep 3
  done
  expect "meeting page answers on its own address over verified HTTPS" \
    "$(meet -o /dev/null -w '%{http_code}' "$MEET/")" 200
  if meet -I "$MEET/" | grep -qi "^content-security-policy: frame-ancestors https://$DOMAIN"; then
    pass "only the workspace may embed the meeting page"
  else
    fail "only the workspace may embed the meeting page"
  fi
  expect "the workspace serves Meet" "$(app_registered meet)" true
  expect "and Calendar, which schedules meetings" "$(app_registered calendar)" true
  expect "Meet reports that it is available" \
    "$(api /v1/api/tools/meet.status -d '{}' | json available)" true

  bridges=0
  for _ in {1..40}; do
    bridges=$(compose exec -T jitsi-jicofo curl -s http://127.0.0.1:8888/stats 2>/dev/null |
      json bridge_selector.bridge_count || true)
    [[ "${bridges:-0}" -ge 1 ]] && break
    sleep 3
  done
  if [[ "${bridges:-0}" -ge 1 ]]; then
    pass "the media bridge has joined the conference focus over verified XMPP"
  else
    fail "the media bridge has joined the conference focus over verified XMPP"
  fi

  # A real meeting. Helix creates the room and signs a pass per person; the
  # browsers then talk to the bundled Jitsi only.
  notice=$(grep -o 'MEET_RECORDING_NOTICE_VERSION = "[^"]*"' apps/helix/src/platform/meet/store.ts |
    cut -d'"' -f2)
  uuid() { node -e 'process.stdout.write(require("node:crypto").randomUUID())'; }
  room_id=$(api /v1/api/tools/meet.create-room -d '{"subject":"Boot smoke meeting"}' | json id)
  join_url() {
    api /v1/api/tools/meet.mint-token -d "{\"roomId\":\"$room_id\",\"recordingNoticeAccepted\":true,\"recordingNoticeVersion\":\"$notice\",\"deviceId\":\"$(uuid)\",\"joinGrantId\":\"$(uuid)\"}" |
      json joinUrl
  }
  first_url=$(join_url)
  second_url=$(join_url)
  if [[ "$first_url" == "$MEET/"*"jwt="* && "$second_url" == "$MEET/"*"jwt="* ]]; then
    pass "Helix signs a meeting pass for the bundled Jitsi's address"
  else
    fail "Helix signs a meeting pass for the bundled Jitsi's address ($(head -c 120 <<<"$first_url"))"
  fi
  # The same pass, re-signed with a key the deployment does not hold.
  forged_url=$(node -e '
    const { createHmac } = require("node:crypto");
    const url = new URL(process.argv[1]);
    const [header, payload] = url.searchParams.get("jwt").split(".");
    const signature = createHmac("sha256", "not-the-deployment-secret")
      .update(`${header}.${payload}`).digest("base64url");
    url.searchParams.set("jwt", `${header}.${payload}.${signature}`);
    process.stdout.write(url.toString());
  ' "$first_url" 2>/dev/null || true)
  node apps/web/scripts/meet-media-probe.mjs --join-url "$first_url" --join-url "$second_url" \
    --forged-url "$forged_url" --map "$MEET_DOMAIN:443=127.0.0.1:$HTTPS_PORT" --insecure \
    >"$WORK/media.log" 2>&1 || true
  grep -E '^PASS' "$WORK/media.log" || true
  media_failures=$(grep -cE '^FAIL' "$WORK/media.log" || true)
  if [[ "$media_failures" -gt 0 ]] || ! grep -qE '^PASS' "$WORK/media.log"; then
    grep -vE '^PASS' "$WORK/media.log" | head -n 12
    FAILURES=$((FAILURES + (media_failures > 0 ? media_failures : 1)))
  fi
fi

# --- Drive: upload, download, malware --------------------------------------

upload() {
  local file=$1 name=$2 size sha
  size=$(wc -c <"$file" | tr -d ' ')
  sha=$(openssl dgst -sha256 -r "$file" | cut -d' ' -f1)
  local body="{\"name\":\"$name\",\"folderId\":null,\"mimeType\":\"text/plain\",\"byteSize\":$size,\"sha256\":\"$sha\",\"metadata\":{}}"
  api /v1/api/tools/drive.upload -d "$body" >"$WORK/upload.json"
  OBJECT_ID=$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const r=d.result??d;process.stdout.write(r.objectId??"")' "$WORK/upload.json")
  node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const r = d.result ?? d;
    const lines = [`url = "${r.uploadUrl}"`, `request = "PUT"`];
    for (const [key, value] of Object.entries(r.uploadHeaders ?? {})) lines.push(`header = "${key}: ${value}"`);
    process.stdout.write(lines.join("\n") + "\n");
  ' "$WORK/upload.json" >"$WORK/put.curl"
  PUT_STATUS=$(edge -K "$WORK/put.curl" --data-binary "@$file" -o /dev/null -w '%{http_code}')
  FINALIZE_STATUS=$(status_of /v1/api/tools/drive.finalize \
    -d "{\"objectId\":\"$OBJECT_ID\",\"byteSize\":$size,\"sha256\":\"$sha\",\"mimeType\":\"text/plain\",\"metadata\":{}}")
}

printf 'hello from the production boot smoke\n' >"$WORK/hello.txt"
upload "$WORK/hello.txt" hello.txt
if grep -q "^url = \"$BASE/" "$WORK/put.curl"; then
  pass "upload link uses the public address"
else
  fail "upload link uses the public address ($(head -n 1 "$WORK/put.curl" | cut -c1-80))"
fi
expect "browser uploads through the edge" "$PUT_STATUS" 200
expect "upload is scanned and accepted" "$FINALIZE_STATUS" 200
download_status=$(edge -L -b "$JAR" -H "origin: $BASE" -o "$WORK/download.out" -w '%{http_code}' \
  "$BASE/v1/api/drive/objects/$OBJECT_ID/content?download=1")
expect "download succeeds" "$download_status" 200
if cmp -s "$WORK/hello.txt" "$WORK/download.out"; then
  pass "downloaded bytes match the upload"
else
  fail "downloaded bytes match the upload"
fi

# The EICAR antivirus test string, split so this file is not itself flagged.
printf '%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-' 'ANTIVIRUS-TEST-FILE!$H+H*' >"$WORK/eicar.txt"
upload "$WORK/eicar.txt" eicar.txt
expect "malware upload is rejected by the scanner" "$FINALIZE_STATUS" 409
expect "rejected file cannot be downloaded" \
  "$(edge -b "$JAR" -H "origin: $BASE" -o /dev/null -w '%{http_code}' \
    "$BASE/v1/api/drive/objects/$OBJECT_ID/content?download=1")" 404

# --- Agents and their secrets -----------------------------------------------
# An administrator adds an agent, issues it an API key, and grants it secrets.
# The agent is handed the one it may read and refused the one it may only use.

# Tools check for an exact permission; the workspace's own administrator must
# still be able to use the administration ones.
expect "the first administrator can use administration tools" \
  "$(status_of /v1/api/tools/chat.room.list_organization -d '{}')" 200

agent_id=$(api /v1/api/admin/agents -d '{"displayName":"Release bot"}' | json agent.id)
if [[ -n "$agent_id" ]]; then pass "an administrator adds an agent"; else fail "an administrator adds an agent"; fi

# A tool call may wait for a person to confirm it. Given the response to one,
# the owner confirms it if it is waiting; the result is printed either way.
confirm_as_owner() {
  local out=$1
  if [[ "$(json status <<<"$out")" == pending_confirmation ]]; then
    out=$(api "/v1/api/tools/pending/$(json pending.id <<<"$out")/approve" -d '{}')
    [[ "$(json status <<<"$out")" == executed ]] &&
      out=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(0, "utf8")).output))' <<<"$out")
  fi
  printf '%s' "$out"
}
expires=$(node -e 'process.stdout.write(new Date(Date.now() + 86400000).toISOString())')
issue_key() {
  api /v1/api/tools/agent.credentials.create -d "{\"actorId\":\"$agent_id\",\"credentialType\":\"api_key\",\"label\":\"Release key\",\"purpose\":\"Boot smoke\",\"scopes\":[\"tools:read\",\"secrets.use\"],\"expiresAt\":\"$expires\"}"
}
handed_value="hunter2-$(openssl rand -hex 6)"
hidden_value="tok_live_$(openssl rand -hex 8)"
grant_to_agent() {
  status_of "/v1/api/admin/agent-secrets/$1/grants" -X PUT -d "{\"actorIds\":[\"$agent_id\"]}"
}
expect "stores a secret an agent may be handed" "$(status_of /v1/api/admin/agent-secrets -d "{\"name\":\"portal-password\",\"mode\":\"handover\",\"value\":\"$handed_value\"}")" 201
handed_id=$(json secret.id <"$WORK/last.json")
# A workspace starts with one administrator, who must be able to do this
# alone. Asking for a second administrator is a rule an organization turns on,
# and only once it has another administrator to ask.
expect "a lone administrator cannot require a second administrator" \
  "$(status_of /v1/api/admin/security-policies/mfa -X PUT -d '{"settings":{"secondAdminApprovalRequired":true}}')" 409
issued=$(confirm_as_owner "$(issue_key)")
agent_key=$(json secret <<<"$issued")
if [[ "$agent_key" == helix_ak_* ]]; then
  pass "and issues it an API key that may use secrets"
else
  fail "and issues it an API key that may use secrets ($(head -c 200 <<<"$issued"))"
fi
as_agent() {
  local tool=$1
  shift
  edge -H "x-api-key: $agent_key" -H 'content-type: application/json' \
    "$BASE/v1/api/tools/$tool" "$@"
}

expect "stores a secret an agent may only use" "$(status_of /v1/api/admin/agent-secrets -d "{\"name\":\"billing-api\",\"mode\":\"use_only\",\"value\":\"$hidden_value\",\"allowedHosts\":[\"api.example.com\"]}")" 201
hidden_id=$(json secret.id <"$WORK/last.json")
expect "a stored secret is available to no agent until it is granted" \
  "$(as_agent secrets.list -d '{}' | node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0, "utf8")).secrets.length))')" 0
expect "the administrator grants both to the agent, without waiting for anyone" \
  "$(grant_to_agent "$handed_id") $(grant_to_agent "$hidden_id")" "200 200"
expect "and one the agent was not granted" "$(status_of /v1/api/admin/agent-secrets -d '{"name":"not-for-agents","mode":"handover","value":"nobody-gets-this"}')" 201
if api /v1/api/admin/agent-secrets | grep -q -e "$handed_value" -e "$hidden_value" -e nobody-gets-this; then
  fail "a stored value is never sent back to the console"
else
  pass "a stored value is never sent back to the console"
fi
expect "a use-only secret cannot be pointed at another host without its value" \
  "$(status_of "/v1/api/admin/agent-secrets/$hidden_id" -X PATCH -d '{"allowedHosts":["evil.example.net"]}')" 400

expect "the agent sees the secrets it was granted, and only those" \
  "$(as_agent secrets.list -d '{}' | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).secrets.map((s) => `${s.name}:${s.mode}`).join(" "))')" \
  "billing-api:use_only portal-password:handover"
expect "the agent is handed the secret it may read" \
  "$(as_agent secrets.get -d '{"name":"portal-password"}' | json value)" "$handed_value"
expect "the agent is refused the secret it may only use" \
  "$(as_agent secrets.get -d '{"name":"billing-api"}' -o "$WORK/agent.json" -w '%{http_code}')" 403
if grep -q "$hidden_value" "$WORK/agent.json"; then
  fail "the refusal does not carry the value"
else
  pass "the refusal does not carry the value"
fi
expect "the agent is told nothing about a secret it was not granted" \
  "$(as_agent secrets.get -d '{"name":"not-for-agents"}' -o /dev/null -w '%{http_code}')" 404
# The grant is the administrator's authorization for exactly this: this secret,
# to the hosts it lists. Such a request runs without anyone confirming it.
# (api.example.com does not exist, so the request itself fails; it is not held.)
held() { [[ "$(json status <<<"$1")" == pending_confirmation ]] && echo held || echo "not held"; }
allowed_request='{"secret":"billing-api","url":"https://api.example.com/v1/invoices"}'
expect "the agent sends a use-only secret where it was stored for, without a person confirming" \
  "$(held "$(as_agent secrets.http_request -d "$allowed_request")")" "not held"
# Anything else waits for a person, and is refused even when they confirm.
elsewhere=$(confirm_as_owner "$(as_agent secrets.http_request -d '{"secret":"billing-api","url":"https://evil.example.net/collect"}')")
if grep -q "may be sent only to: api.example.com" <<<"$elsewhere"; then
  pass "the agent cannot send a use-only secret to a host it was not stored for"
else
  fail "the agent cannot send a use-only secret to a host it was not stored for ($(head -c 200 <<<"$elsewhere"))"
fi
expect "the organization asks for a person to confirm each request instead" \
  "$(status_of /v1/api/admin/tenant-config -X PATCH -d '{"features":{"agent_secrets_unattended":false},"reason":"boot smoke"}')" 200
expect "and the same request now waits" \
  "$(held "$(as_agent secrets.http_request -d "$allowed_request")")" held
expect "a person cannot read agent secrets, administrator or not" \
  "$(status_of /v1/api/tools/secrets.get -d '{"name":"portal-password"}')" 403
expect "the agent's key cannot manage secrets" \
  "$(edge -H "x-api-key: $agent_key" -o /dev/null -w '%{http_code}' "$BASE/v1/api/admin/agent-secrets")" 403
expect "an administrator takes the grant away" \
  "$(status_of "/v1/api/admin/agent-secrets/$handed_id/grants" -X PUT -d '{"actorIds":[]}')" 200
expect "and the agent can no longer read the secret" \
  "$(as_agent secrets.get -d '{"name":"portal-password"}' -o /dev/null -w '%{http_code}')" 404

# --- HTTPS certificate managed from the Admin console -----------------------

edge_issuer() {
  echo | openssl s_client -connect "127.0.0.1:$HTTPS_PORT" -servername "$DOMAIN" 2>/dev/null |
    openssl x509 -noout -issuer 2>/dev/null
}
wait_for_issuer() {
  local expected=$1
  for _ in {1..30}; do
    [[ "$(edge_issuer)" == *"$expected"* ]] && return 0
    sleep 2
  done
  return 1
}
certificate_body() {
  node -e '
    const { readFileSync } = require("node:fs");
    const [certificate, key, ca] = process.argv.slice(1).map((path) => readFileSync(path, "utf8"));
    process.stdout.write(JSON.stringify({ certificatePem: certificate + ca, privateKeyPem: key }));
  ' "$WORK/$1.pem" "$WORK/$1.key" "$SECRETS/ca/ca.pem"
}
certificate_field() { api /v1/api/admin/edge/certificate | json "certificate.$1"; }

issue_certificate uploaded "$DOMAIN"
certificate_body uploaded >"$WORK/uploaded.json"
if [[ "$TLS_MODE" == files ]]; then
  expect "the console says the certificate comes from server files" \
    "$(certificate_field source)" deployment-files
  expect "a certificate provided as files cannot be replaced from the console" \
    "$(status_of /v1/api/admin/edge/certificate -X PUT -d "@$WORK/uploaded.json")" 409
else
  expect "the console can manage the certificate" "$(certificate_field manageable)" true
  issue_certificate elsewhere "elsewhere.$DOMAIN"
  certificate_body elsewhere >"$WORK/elsewhere.json"
  expect "a certificate for another name is refused" \
    "$(status_of /v1/api/admin/edge/certificate -X PUT -d "@$WORK/elsewhere.json")" 400
  if grep -q "It must cover $DOMAIN" "$WORK/last.json"; then
    pass "the refusal says which name the certificate must cover"
  else
    fail "the refusal says which name the certificate must cover ($(head -c 200 "$WORK/last.json"))"
  fi

  expect "an administrator uploads a certificate" \
    "$(status_of /v1/api/admin/edge/certificate -X PUT -d "@$WORK/uploaded.json")" 200
  if grep -q 'PRIVATE KEY' "$WORK/last.json"; then
    fail "the private key is never returned"
  else
    pass "the private key is never returned"
  fi
  if wait_for_issuer "Helix deployment internal CA"; then
    pass "the edge serves the uploaded certificate without a restart"
  else
    fail "the edge serves the uploaded certificate without a restart ($(edge_issuer))"
  fi
  expect "the console reports it applied" "$(certificate_field applied)" true
  expect "the workspace still answers over verified HTTPS" \
    "$(edge -o /dev/null -w '%{http_code}' "$BASE/readyz")" 200

  compose restart caddy >/dev/null 2>&1
  if wait_for_issuer "Helix deployment internal CA"; then
    pass "a restarted edge still serves the uploaded certificate"
  else
    fail "a restarted edge still serves the uploaded certificate ($(edge_issuer))"
  fi

  expect "an administrator goes back to automatic certificates" \
    "$(status_of /v1/api/admin/edge/certificate -X DELETE)" 200
  if wait_for_issuer "Caddy Local Authority"; then
    pass "the edge returns to its own certificate"
  else
    fail "the edge returns to its own certificate ($(edge_issuer))"
  fi
fi

if [[ "$FAILURES" -gt 0 ]]; then
  compose logs --tail 60 helix >&2 || true
  die "$FAILURES check(s) failed"
fi
with_note=""
[[ "$WITH_PASSWORDS" == 1 ]] && with_note="$with_note, with passwords"
[[ "$WITH_MEET" == 1 ]] && with_note="$with_note, with meet"
log "Production boot smoke passed ($TLS_MODE certificate$with_note)."
