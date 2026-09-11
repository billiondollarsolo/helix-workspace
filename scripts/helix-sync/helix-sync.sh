#!/usr/bin/env bash
# Helix Sync — configure a local Drive folder or virtual mount (rclone WebDAV).
set -euo pipefail

REMOTE_NAME="${HELIX_SYNC_REMOTE:-helix}"
HELIX_HOME="${HELIX_SYNC_HOME:-$HOME/.helix/drive-sync}"
RCLONE="${HELIX_RCLONE:-$HELIX_HOME/bin/rclone}"
if [[ ! -x "$RCLONE" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    RCLONE="$(command -v rclone)"
  else
    echo "Helix Sync is not installed. Run the installer:" >&2
    echo "  curl -fsSL \"\${HELIX_SYNC_ORIGIN:-https://YOUR-HELIX}/v1/drive/sync/install.sh\" | bash" >&2
    echo "  # or: curl -fsSL https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync/install.sh | bash" >&2
    exit 2
  fi
fi

normalize_dav_url() {
  local s="${1:-}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  if [[ -z "$s" ]]; then
    echo "Server URL is required." >&2
    return 1
  fi
  if [[ ! "$s" =~ ^https?:// ]]; then
    s="https://$s"
  fi
  s="${s%/}"
  if [[ "$s" =~ /dav/files$ ]]; then
    echo "${s}/"
    return 0
  fi
  if [[ "$s" =~ /dav/files/ ]]; then
    echo "${s%/}/"
    return 0
  fi
  echo "${s}/dav/files/"
}

prompt() {
  local label="$1"
  local default="${2:-}"
  local secret="${3:-}"
  local suffix=""
  [[ -n "$default" ]] && suffix=" [$default]"
  local hint=""
  [[ "$secret" == "1" ]] && hint=" (app password, not your login)"
  local answer=""
  if [[ "$secret" == "1" ]]; then
    read -r -s -p "${label}${hint}${suffix}: " answer
    echo >&2
  else
    read -r -p "${label}${hint}${suffix}: " answer
  fi
  answer="${answer#"${answer%%[![:space:]]*}"}"
  answer="${answer%"${answer##*[![:space:]]}"}"
  if [[ -z "$answer" ]]; then
    echo "$default"
  else
    echo "$answer"
  fi
}

run_rclone() {
  "$RCLONE" "$@"
}

echo
echo "  Helix Sync setup"
echo "  ────────────────"
echo "  Connects this computer to Helix Drive over WebDAV."
echo "  Use an app password (Settings → Security), not your login password."
echo

url_raw="${HELIX_SYNC_URL:-${HELIX_SYNC_DEFAULT_URL:-}}"
if [[ -z "$url_raw" ]]; then
  url_raw="$(prompt "Helix server URL (e.g. https://helix.company.com)")"
fi
url="$(normalize_dav_url "$url_raw")"

user="${HELIX_SYNC_USER:-}"
if [[ -z "$user" ]]; then
  user="$(prompt "Your Helix email")"
fi
if [[ -z "$user" ]]; then
  echo "Email is required." >&2
  exit 1
fi

password="${HELIX_SYNC_PASSWORD:-}"
if [[ -z "$password" ]]; then
  password="$(prompt "App password" "" 1)"
fi
if [[ -z "$password" ]]; then
  echo "App password is required." >&2
  exit 1
fi

echo
echo "  How should files appear on this computer?"
echo "    1) Mirror folder  — a normal folder that stays in sync (recommended)"
echo "    2) Virtual drive  — mount Helix like a network drive"
echo
mode_raw="${HELIX_SYNC_MODE:-}"
if [[ -z "$mode_raw" ]]; then
  mode_raw="$(prompt "Choose mode" "1")"
fi
case "$(echo "$mode_raw" | tr '[:upper:]' '[:lower:]')" in
  1 | mirror | m | folder | sync) mode="mirror" ;;
  2 | mount | drive | virtual) mode="mount" ;;
  *)
    echo "Mode must be mirror or mount." >&2
    exit 1
    ;;
esac

if [[ "$mode" == "mirror" ]]; then
  default_path="${HELIX_SYNC_PATH:-$HOME/HelixDrive}"
  path_label="Local folder path"
else
  default_path="${HELIX_SYNC_PATH:-$HOME/HelixMount}"
  path_label="Mount path"
fi
local_path="${HELIX_SYNC_PATH:-}"
if [[ -z "$local_path" ]]; then
  local_path="$(prompt "$path_label" "$default_path")"
fi

echo
echo "Configuring connection…"
obscured="$(run_rclone obscure "$password" | head -n 1 | tr -d '\r')"
run_rclone config delete "$REMOTE_NAME" >/dev/null 2>&1 || true
if ! run_rclone config create "$REMOTE_NAME" webdav "url=$url" vendor=other "user=$user" "pass=$obscured"; then
  echo "rclone config failed." >&2
  exit 1
fi

echo "Testing connection…"
if ! run_rclone lsd "${REMOTE_NAME}:"; then
  echo "Could not list Helix Drive. Check URL, email, and app password." >&2
  exit 1
fi

mkdir -p "$HELIX_HOME" "$local_path"
if [[ "$mode" == "mirror" ]]; then
  cat >"$HELIX_HOME/sync-now.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec $(printf '%q' "$RCLONE") bisync $(printf '%q' "$local_path") ${REMOTE_NAME}: --create-empty-src-dirs --resilient
EOF
  chmod 755 "$HELIX_HOME/sync-now.sh"
  echo
  echo "First sync into $local_path…"
  run_rclone bisync "$local_path" "${REMOTE_NAME}:" --create-empty-src-dirs --resilient --resync
  echo
  echo "  Helix Drive is set up."
  echo "  Folder:  $local_path"
  echo "  Later:   $HELIX_HOME/sync-now.sh"
else
  cat >"$HELIX_HOME/mount.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p $(printf '%q' "$local_path")
echo "Mounting Helix Drive at $local_path (Ctrl+C to stop)..."
exec $(printf '%q' "$RCLONE") mount ${REMOTE_NAME}: $(printf '%q' "$local_path") --vfs-cache-mode full --dir-cache-time 30s
EOF
  chmod 755 "$HELIX_HOME/mount.sh"
  echo
  echo "  Helix Drive is configured."
  echo "  Start mount:  $HELIX_HOME/mount.sh"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "  Note: macOS may need macFUSE or FUSE-T for mount mode."
  fi
fi
echo
