#!/usr/bin/env bash

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

run_shell() {
  local cmd=${1:?missing command}
  if [[ "${DRY_RUN:-1}" == "1" ]]; then
    printf '+ %s\n' "$cmd"
  else
    bash -c "$cmd"
  fi
}

ensure_repo_root() {
  if [[ ! -f docker-compose.yml ]]; then
    die "run from the repository root containing docker-compose.yml"
  fi
}

bool_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

json_escape() {
  local value=${1:-}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  printf '%s' "$value"
}

# Resolve the S3-compatible endpoint for the object store (RustFS by default).
object_store_endpoint() {
  printf '%s' "${RUSTFS_ENDPOINT:-${HELIX_OBJECT_STORE_ENDPOINT:-http://localhost:${RUSTFS_API_PORT:-28437}}}"
}

# Export AWS-style credentials for the `aws` CLI from RustFS/S3 env vars.
export_object_store_credentials() {
  AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-${RUSTFS_ACCESS_KEY:-${HELIX_OBJECT_STORE_ACCESS_KEY:-}}}
  AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-${RUSTFS_SECRET_KEY:-${HELIX_OBJECT_STORE_SECRET_KEY:-}}}
  AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-${HELIX_OBJECT_STORE_REGION:-us-east-1}}
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
}

# Encrypt a file with a cloud KMS-issued data key (envelope encryption).
# AWS KMS: generate-data-key -> AES-256-CBC with openssl -> store wrapped key.
# Produces "<dest>" (ciphertext) and "<dest>.datakey" (KMS-wrapped data key).
kms_encrypt_file() {
  local src=$1 dest=$2 key_id=$3
  require_cmd aws
  require_cmd openssl
  local datakey_json plaintext_key ciphertext_key
  datakey_json=$(aws kms generate-data-key \
    --key-id "$key_id" \
    --key-spec AES_256 \
    --output json ${HELIX_KMS_ENDPOINT:+--endpoint-url "$HELIX_KMS_ENDPOINT"})
  plaintext_key=$(printf '%s' "$datakey_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Plaintext"])')
  ciphertext_key=$(printf '%s' "$datakey_json" | python3 -c 'import json,sys;print(json.load(sys.stdin)["CiphertextBlob"])')
  printf '%s' "$ciphertext_key" >"$dest.datakey"
  openssl enc -aes-256-cbc -salt -pbkdf2 \
    -in "$src" -out "$dest" \
    -pass "pass:$plaintext_key"
  unset plaintext_key
}

# Decrypt a KMS-envelope-encrypted file produced by kms_encrypt_file.
kms_decrypt_file() {
  local src=$1 dest=$2 datakey_file=$3
  require_cmd aws
  require_cmd openssl
  [[ -f "$datakey_file" ]] || die "KMS data key file not found: $datakey_file"
  local plaintext_key tmp_blob endpoint_args=()
  [[ -n "${HELIX_KMS_ENDPOINT:-}" ]] && endpoint_args=(--endpoint-url "$HELIX_KMS_ENDPOINT")
  # Decode the base64-stored ciphertext blob to a temp file for `fileb://`.
  tmp_blob=$(mktemp "${TMPDIR:-/tmp}/helix-kms.XXXXXX")
  base64 -d <"$datakey_file" >"$tmp_blob"
  plaintext_key=$(aws kms decrypt \
    --ciphertext-blob "fileb://$tmp_blob" \
    --output text --query Plaintext \
    "${endpoint_args[@]}")
  rm -f "$tmp_blob"
  openssl enc -d -aes-256-cbc -pbkdf2 \
    -in "$src" -out "$dest" \
    -pass "pass:$plaintext_key"
  unset plaintext_key
}
