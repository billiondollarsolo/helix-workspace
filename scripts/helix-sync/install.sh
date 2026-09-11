#!/usr/bin/env bash
# Helix Sync installer — macOS and Linux.
#
#   curl -fsSL https://YOUR-HELIX/v1/drive/sync/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync/install.sh | bash
#
# Installs a local rclone binary and the `helix-sync` CLI into
# ~/.helix/drive-sync/bin (and ~/.local/bin when possible). No Node, pnpm, or sudo.
set -euo pipefail

GITHUB_RAW="https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync"
RCLONE_VERSION="${HELIX_SYNC_RCLONE_VERSION:-v1.69.3}"
HELIX_HOME="${HELIX_SYNC_HOME:-$HOME/.helix/drive-sync}"
BIN_DIR="$HELIX_HOME/bin"
LOCAL_BIN="${HELIX_SYNC_LOCAL_BIN:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) rclone_os="osx" ;;
  Linux) rclone_os="linux" ;;
  *)
    echo "This installer supports macOS and Linux. On Windows use install.ps1." >&2
    exit 1
    ;;
esac
case "$arch" in
  x86_64 | amd64) rclone_arch="amd64" ;;
  arm64 | aarch64) rclone_arch="arm64" ;;
  *)
    echo "Unsupported CPU architecture: $arch" >&2
    exit 1
    ;;
esac

mkdir -p "$BIN_DIR" "$LOCAL_BIN"

if [[ "${HELIX_SYNC_SKIP_RCLONE:-}" != "1" ]]; then
  zip_name="rclone-${RCLONE_VERSION}-${rclone_os}-${rclone_arch}.zip"
  url="https://downloads.rclone.org/${RCLONE_VERSION}/${zip_name}"
  tmp="$(mktemp -d)"
  echo "Downloading rclone ${RCLONE_VERSION} (${rclone_os}/${rclone_arch})…"
  curl -fsSL "$url" -o "$tmp/rclone.zip"
  if command -v unzip >/dev/null 2>&1; then
    unzip -qo "$tmp/rclone.zip" -d "$tmp"
  else
    python3 - "$tmp/rclone.zip" "$tmp" <<'PY'
import sys, zipfile
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
PY
  fi
  rclone_bin="$(find "$tmp" -type f -name rclone | head -n 1)"
  if [[ -z "$rclone_bin" ]]; then
    echo "rclone zip did not contain a rclone binary." >&2
    exit 1
  fi
  install -m 755 "$rclone_bin" "$BIN_DIR/rclone"
  rm -rf "$tmp"
fi

script_base="${HELIX_SYNC_ORIGIN:-}"
if [[ -n "$script_base" ]]; then
  script_url="${script_base%/}/v1/drive/sync/helix-sync.sh"
else
  script_url="${HELIX_SYNC_SCRIPT_BASE:-$GITHUB_RAW}/helix-sync.sh"
fi

echo "Installing helix-sync…"
curl -fsSL "$script_url" -o "$BIN_DIR/helix-sync"
chmod 755 "$BIN_DIR/helix-sync"
ln -sfn "$BIN_DIR/helix-sync" "$LOCAL_BIN/helix-sync"

echo
echo "  Helix Sync is installed."
echo "  Binary:  $BIN_DIR/helix-sync"
echo
echo "  Next:    helix-sync"
if ! command -v helix-sync >/dev/null 2>&1; then
  echo "  If that command is not found:"
  echo "    export PATH=\"$LOCAL_BIN:\$PATH\""
  echo "    # or run:  $BIN_DIR/helix-sync"
fi
echo
echo "  You will need an app password from Helix (Settings → Security)."
echo
