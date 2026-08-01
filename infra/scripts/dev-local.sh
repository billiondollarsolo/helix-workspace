#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "${script_dir}/../.." && pwd)"
cd "${workspace_root}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

postgres_db="${POSTGRES_DB:-helix}"
postgres_user="${POSTGRES_USER:-helix}"
postgres_password="${POSTGRES_PASSWORD:-helix_dev_password}"
postgres_port="${POSTGRES_PORT:-28432}"
redis_port="${REDIS_PORT:-28433}"
nats_port="${NATS_CLIENT_PORT:-28434}"
meili_port="${MEILI_PORT:-28436}"
rustfs_port="${RUSTFS_API_PORT:-28437}"
cerbos_port="${CERBOS_HTTP_PORT:-28439}"
mailpit_smtp_port="${MAILPIT_SMTP_PORT:-28457}"
smtp_receive_port="${HELIX_SMTP_RECEIVE_PORT:-28456}"

export DATABASE_URL="${DATABASE_URL:-postgres://${postgres_user}:${postgres_password}@127.0.0.1:${postgres_port}/${postgres_db}}"
export BETTER_AUTH_DATABASE_URL="${BETTER_AUTH_DATABASE_URL:-${DATABASE_URL}}"
export HELIX_DEFAULT_ORG_ID="${HELIX_DEFAULT_ORG_ID:-00000000-0000-0000-0000-000000000000}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:${redis_port}}"
export NATS_URL="${NATS_URL:-nats://127.0.0.1:${nats_port}}"
export MEILI_URL="${MEILI_URL:-http://127.0.0.1:${meili_port}}"
export RUSTFS_ENDPOINT="${RUSTFS_ENDPOINT:-http://127.0.0.1:${rustfs_port}}"
export CERBOS_HTTP_URL="${CERBOS_HTTP_URL:-http://127.0.0.1:${cerbos_port}}"

if ! curl --silent --show-error --fail --max-time 2 \
  "${CERBOS_HTTP_URL%/}/_cerbos/health" >/dev/null; then
  printf >&2 \
    'Cerbos is unavailable at %s. Start it with: docker compose up -d cerbos\n' \
    "${CERBOS_HTTP_URL}"
  exit 1
fi

trusted_origins="${BETTER_AUTH_TRUSTED_ORIGINS:-http://localhost:3000,http://localhost:5173,http://localhost:4173}"
for trusted_origin in "http://localhost:5174" "http://127.0.0.1:5174"; do
  case ",${trusted_origins}," in
    *",${trusted_origin},"*) ;;
    *) trusted_origins="${trusted_origins},${trusted_origin}" ;;
  esac
done
export BETTER_AUTH_TRUSTED_ORIGINS="${trusted_origins}"

if [[ "${MAIL_SMTP_HOST:-}" == "mailpit" || -z "${MAIL_SMTP_HOST:-}" ]]; then
  export MAIL_SMTP_HOST="127.0.0.1"
  export MAIL_SMTP_PORT="${mailpit_smtp_port}"
fi
export MAIL_SMTP_RECEIVER_HOST="${MAIL_SMTP_RECEIVER_HOST:-0.0.0.0}"
if [[ "${MAIL_SMTP_RECEIVER_PORT:-}" == "2525" || -z "${MAIL_SMTP_RECEIVER_PORT:-}" ]]; then
  export MAIL_SMTP_RECEIVER_PORT="${smtp_receive_port}"
fi

exec pnpm exec turbo run dev --env-mode=loose
