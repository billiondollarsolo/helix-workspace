#!/bin/bash
# Jibri finalize script — runs after each recording completes.
#
# Jibri invokes us with the recording directory as $1. Inside that dir
# we expect at least one .mp4 (the recorded conference) and a metadata.json
# Jibri writes with conference metadata (room name, start/end timestamps).
#
# Responsibility:
#   1. Prefer an opt-in Helix prepare call that resolves tenant storage and
#      returns a presigned PUT URL. When disabled or non-required failures
#      occur, fall back to the local RustFS/S3-compatible upload path.
#   2. POST Helix's /webhook/jitsi with the storageKey + metadata so the
#      attachRecording flow creates the objects/messages/notifications
#      rows + fans out to participants.
#
# Failure modes:
#   - If upload fails and prepare-required mode is disabled, we still POST
#     Helix with the local path so the row exists; the operator can repair the
#     upload later (Jibri keeps the file on the local volume).
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

http_ok() {
  [[ "$1" == 2* ]]
}

PREPARE_UPLOAD="${HELIX_JITSI_PREPARE_UPLOAD:-false}"
PREPARE_REQUIRED="${HELIX_JITSI_PREPARE_REQUIRED:-false}"
PREPARE_URL="${HELIX_JITSI_PREPARE_URL:-${HELIX_INTERNAL_URL}/internal/meet/recording-uploads}"
UPLOAD_ID=""

PREPARE_ENABLED=0
if [[ "$PREPARE_UPLOAD" == "true" || -n "${HELIX_JITSI_PREPARE_URL:-}" ]]; then
  PREPARE_ENABLED=1
fi

# --- Upload to S3-compatible storage (RustFS by default) ---
UPLOADED=0
if [[ "$PREPARE_ENABLED" -eq 1 ]]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "finalize: prepare upload requested but jq is unavailable" >&2
    if [[ "$PREPARE_REQUIRED" == "true" ]]; then
      exit 1
    fi
  else
    PREPARE_PAYLOAD=$(jq -n \
      --arg roomName "$ROOM" \
      --arg storageKey "$KEY" \
      --arg mimeType "video/mp4" \
      --argjson byteSize "$BYTE_SIZE" \
      --arg sha256 "$SHA256" \
      --arg startedAt "$START_AT" \
      --arg endedAt "$END_AT" \
      '{
        roomName: $roomName,
        storageKey: $storageKey,
        mimeType: $mimeType,
        byteSize: $byteSize,
        sha256: $sha256,
        startedAt: (if $startedAt == "" then null else $startedAt end),
        endedAt: $endedAt
      }')
    PREPARE_HEADERS=(
      -H "Content-Type: application/json"
      -H "X-Helix-Jitsi-Secret: ${HELIX_JITSI_WEBHOOK_SECRET}"
    )
    if [[ -n "${HELIX_JITSI_ORG_ID:-}" ]]; then
      PREPARE_HEADERS+=(-H "X-Helix-Org-Id: ${HELIX_JITSI_ORG_ID}")
    fi

    PREPARE_STATUS=$(curl -sS -o /tmp/finalize-prepare-resp.txt -w "%{http_code}" \
      -X POST "$PREPARE_URL" \
      "${PREPARE_HEADERS[@]}" \
      -d "$PREPARE_PAYLOAD")
    echo "finalize: prepare -> HTTP $PREPARE_STATUS"

    if http_ok "$PREPARE_STATUS"; then
      PREPARED_KEY="$(jq -r '.storageKey // empty' /tmp/finalize-prepare-resp.txt)"
      UPLOAD_URL="$(jq -r '.uploadUrl // empty' /tmp/finalize-prepare-resp.txt)"
      UPLOAD_ID="$(jq -r '.uploadId // empty' /tmp/finalize-prepare-resp.txt)"
      if [[ -n "$PREPARED_KEY" && -n "$UPLOAD_URL" ]]; then
        KEY="$PREPARED_KEY"
        mapfile -t UPLOAD_HEADER_VALUES < <(jq -r '.headers // {} | to_entries[] | "\(.key): \(.value)"' /tmp/finalize-prepare-resp.txt)
        if [[ "${#UPLOAD_HEADER_VALUES[@]}" -eq 0 ]]; then
          UPLOAD_HEADER_VALUES=("Content-Type: video/mp4")
        fi
        UPLOAD_HEADERS=()
        for header in "${UPLOAD_HEADER_VALUES[@]}"; do
          UPLOAD_HEADERS+=(-H "$header")
        done
        UPLOAD_STATUS=$(curl -sS -o /tmp/finalize-upload-resp.txt -w "%{http_code}" \
          -X PUT "$UPLOAD_URL" \
          "${UPLOAD_HEADERS[@]}" \
          --upload-file "$MP4")
        echo "finalize: presigned upload -> HTTP $UPLOAD_STATUS"
        if http_ok "$UPLOAD_STATUS"; then
          UPLOADED=1
        elif [[ "$PREPARE_REQUIRED" == "true" ]]; then
          cat /tmp/finalize-upload-resp.txt >&2 || true
          exit 1
        fi
      else
        echo "finalize: prepare response missing storageKey or uploadUrl" >&2
        cat /tmp/finalize-prepare-resp.txt >&2 || true
        if [[ "$PREPARE_REQUIRED" == "true" ]]; then
          exit 1
        fi
      fi
    else
      cat /tmp/finalize-prepare-resp.txt >&2 || true
      if [[ "$PREPARE_REQUIRED" == "true" ]]; then
        exit 1
      fi
    fi
  fi
fi

# Jibri image is debian-based; install awscli on first run (cached after).
if [[ "$UPLOADED" -eq 0 && -n "${RUSTFS_ENDPOINT_INTERNAL:-}" ]] && ! command -v aws >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq awscli >/dev/null 2>&1 || true
fi

if [[ "$UPLOADED" -eq 0 ]] && command -v aws >/dev/null 2>&1 && [[ -n "${RUSTFS_ENDPOINT_INTERNAL:-}" ]]; then
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
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(jq -n \
    --arg roomName "$ROOM" \
    --arg storageKey "$KEY" \
    --arg mimeType "video/mp4" \
    --argjson byteSize "$BYTE_SIZE" \
    --arg sha256 "$SHA256" \
    --arg startedAt "$START_AT" \
    --arg endedAt "$END_AT" \
    --arg uploadId "$UPLOAD_ID" \
    --argjson uploaded "$UPLOADED" \
    '{
      event: "recording.uploaded",
      roomName: $roomName,
      storageKey: $storageKey,
      mimeType: $mimeType,
      byteSize: $byteSize,
      sha256: $sha256,
      startedAt: (if $startedAt == "" then null else $startedAt end),
      endedAt: $endedAt,
      metadata: { uploaded: ($uploaded == 1) }
    } + (if $uploadId == "" then {} else { uploadId: $uploadId } end)')
else
  UPLOAD_ID_FIELD=""
  if [[ -n "$UPLOAD_ID" ]]; then
    UPLOAD_ID_FIELD="\"uploadId\": \"${UPLOAD_ID}\","
  fi
  UPLOADED_JSON="false"
  if [[ "$UPLOADED" -eq 1 ]]; then
    UPLOADED_JSON="true"
  fi
  PAYLOAD=$(cat <<JSON
{
  "event": "recording.uploaded",
  "roomName": "${ROOM}",
  "storageKey": "${KEY}",
  ${UPLOAD_ID_FIELD}
  "mimeType": "video/mp4",
  "byteSize": ${BYTE_SIZE},
  "sha256": "${SHA256}",
  "startedAt": ${START_AT:+\"${START_AT}\"}${START_AT:-null},
  "endedAt": "${END_AT}",
  "metadata": { "uploaded": ${UPLOADED_JSON} }
}
JSON
)
fi

WEBHOOK_HEADERS=(
  -H "Content-Type: application/json"
  -H "X-Helix-Jitsi-Secret: ${HELIX_JITSI_WEBHOOK_SECRET}"
)
if [[ -n "${HELIX_JITSI_ORG_ID:-}" ]]; then
  WEBHOOK_HEADERS+=(-H "X-Helix-Org-Id: ${HELIX_JITSI_ORG_ID}")
fi

HTTP_STATUS=$(curl -sS -o /tmp/finalize-resp.txt -w "%{http_code}" \
  -X POST "${HELIX_INTERNAL_URL}/webhook/jitsi" \
  "${WEBHOOK_HEADERS[@]}" \
  -d "$PAYLOAD")

echo "finalize: webhook -> HTTP $HTTP_STATUS"
cat /tmp/finalize-resp.txt
echo

if ! http_ok "$HTTP_STATUS"; then
  exit 1
fi
exit 0
