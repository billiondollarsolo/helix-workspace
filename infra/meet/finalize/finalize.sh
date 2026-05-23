#!/bin/bash
# Jibri finalize script — runs after each recording completes.
#
# Jibri invokes us with the recording directory as $1. Inside that dir
# we expect at least one .mp4 (the recorded conference) and a metadata.json
# Jibri writes with conference metadata (room name, start/end timestamps).
#
# Responsibility:
#   1. Upload the mp4 to RustFS (or whichever S3-compatible bucket is
#      configured) at key `recordings/{room}/{epoch}.mp4`.
#   2. POST helix's /webhook/jitsi with the storageKey + metadata so the
#      attachRecording flow creates the objects/messages/notifications
#      rows + fans out to participants.
#
# Failure modes:
#   - If S3 upload fails, we still POST helix with the local path so the
#     row exists; the operator can repair the upload later (Jibri keeps
#     the file on the local volume).
#   - If helix POST fails, we exit 1 so Jibri logs the failure. The mp4
#     is retained on disk.

set -uo pipefail

RECORDING_DIR="${1:-}"
if [[ -z "$RECORDING_DIR" || ! -d "$RECORDING_DIR" ]]; then
  echo "finalize: missing or invalid recording dir: $RECORDING_DIR" >&2
  exit 2
fi

# Pick the (single) mp4 Jibri produced. Jibri names them by timestamp.
MP4="$(find "$RECORDING_DIR" -maxdepth 1 -name '*.mp4' | head -1)"
if [[ -z "$MP4" ]]; then
  echo "finalize: no .mp4 in $RECORDING_DIR" >&2
  exit 2
fi

META_FILE="$RECORDING_DIR/metadata.json"
ROOM=""
START_AT=""
if [[ -f "$META_FILE" ]]; then
  # Pluck "room_name" and "start_time" using jq if present; else awk fallback
  if command -v jq >/dev/null 2>&1; then
    ROOM="$(jq -r '.meeting_url // .room_name // .room // empty' "$META_FILE")"
    START_AT="$(jq -r '.start_time // empty' "$META_FILE")"
  fi
fi
# Strip protocol+host from meeting_url if jq returned one
ROOM="${ROOM##*/}"
ROOM="${ROOM%%\?*}"

# Fall back to the recording-dir basename if metadata didn't carry the room
if [[ -z "$ROOM" ]]; then
  ROOM="$(basename "$RECORDING_DIR")"
fi

BYTE_SIZE="$(stat -c%s "$MP4" 2>/dev/null || stat -f%z "$MP4")"
SHA256="$(sha256sum "$MP4" | awk '{print $1}')"
EPOCH="$(date +%s)"
KEY="recordings/${ROOM}/${EPOCH}.mp4"
END_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "finalize: room=$ROOM size=$BYTE_SIZE sha256=$SHA256 key=$KEY"

# --- Upload to S3-compatible storage (RustFS by default) ---
# Jibri image is debian-based; install awscli on first run (cached after).
if ! command -v aws >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq awscli >/dev/null 2>&1 || true
fi

UPLOADED=0
if command -v aws >/dev/null 2>&1 && [[ -n "${RUSTFS_ENDPOINT_INTERNAL:-}" ]]; then
  # Path-style + sigv4. Region is required by AWS CLI but ignored by RustFS.
  if AWS_ACCESS_KEY_ID="$RUSTFS_ACCESS_KEY" \
     AWS_SECRET_ACCESS_KEY="$RUSTFS_SECRET_KEY" \
     AWS_EC2_METADATA_DISABLED=true \
     aws --endpoint-url "$RUSTFS_ENDPOINT_INTERNAL" \
         --region us-east-1 \
         s3 cp --no-progress "$MP4" "s3://${RUSTFS_BUCKET}/${KEY}"; then
    UPLOADED=1
    echo "finalize: uploaded to s3://${RUSTFS_BUCKET}/${KEY}"
  else
    echo "finalize: S3 upload failed; helix will still get the row, repair later" >&2
  fi
fi

# --- POST helix webhook ---
PAYLOAD=$(cat <<JSON
{
  "event": "recording.uploaded",
  "roomName": "${ROOM}",
  "storageKey": "${KEY}",
  "mimeType": "video/mp4",
  "byteSize": ${BYTE_SIZE},
  "sha256": "${SHA256}",
  "startedAt": ${START_AT:+\"${START_AT}\"}${START_AT:-null},
  "endedAt": "${END_AT}",
  "metadata": { "uploaded": ${UPLOADED} }
}
JSON
)

HTTP_STATUS=$(curl -sS -o /tmp/finalize-resp.txt -w "%{http_code}" \
  -X POST "${HELIX_INTERNAL_URL}/webhook/jitsi" \
  -H "Content-Type: application/json" \
  -H "X-Helix-Jitsi-Secret: ${HELIX_JITSI_WEBHOOK_SECRET}" \
  -d "$PAYLOAD")

echo "finalize: webhook -> HTTP $HTTP_STATUS"
cat /tmp/finalize-resp.txt
echo

if [[ "$HTTP_STATUS" != "200" ]]; then
  exit 1
fi
exit 0
