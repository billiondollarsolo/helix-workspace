#!/usr/bin/env bash
# Jibri finalize hook: prepare a tenant-bound upload, upload the recording,
# then authenticate its completion with a timestamped raw-body HMAC.

set -Eeuo pipefail

RECORDING_DIR=${1:-}
[[ -n "$RECORDING_DIR" && -d "$RECORDING_DIR" ]] || {
  echo "finalize: missing or invalid recording dir: $RECORDING_DIR" >&2
  exit 2
}

: "${HELIX_INTERNAL_URL:?finalize: HELIX_INTERNAL_URL is required}"
: "${HELIX_JITSI_ORG_ID:?finalize: HELIX_JITSI_ORG_ID is required}"
: "${HELIX_JITSI_WEBHOOK_SECRET:?finalize: HELIX_JITSI_WEBHOOK_SECRET is required}"
for command in curl date ffprobe jq openssl sha256sum stat; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "finalize: required command is unavailable: $command" >&2
    exit 2
  }
done

MP4=$(find "$RECORDING_DIR" -maxdepth 1 -type f -name '*.mp4' -print -quit)
[[ -n "$MP4" ]] || {
  echo "finalize: no .mp4 in $RECORDING_DIR" >&2
  exit 2
}

ROOM=""
META_FILE="$RECORDING_DIR/metadata.json"
if [[ -f "$META_FILE" ]]; then
  ROOM=$(jq -r '.meeting_url // .room_name // .room // empty' "$META_FILE")
fi
ROOM=${ROOM##*/}
ROOM=${ROOM%%\?*}
ROOM=${ROOM:-$(basename "$RECORDING_DIR")}

BYTE_SIZE=$(stat -c%s "$MP4")
SHA256=$(sha256sum "$MP4" | awk '{print $1}')
END_EPOCH=$(stat -c%Y "$MP4")
END_AT=$(date -u -d "@$END_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
START_AT=""
if [[ -f "$META_FILE" ]]; then
  START_AT=$(jq -r '.start_time // .startTime // empty' "$META_FILE")
fi
if [[ "$START_AT" =~ ^[0-9]+$ ]]; then
  START_AT=$(date -u -d "@$START_AT" +%Y-%m-%dT%H:%M:%SZ)
elif [[ -n "$START_AT" ]]; then
  START_AT=$(date -u -d "$START_AT" +%Y-%m-%dT%H:%M:%SZ)
else
  DURATION_SECONDS=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$MP4")
  DURATION_SECONDS=$(awk -v seconds="$DURATION_SECONDS" 'BEGIN { rounded = int(seconds + 0.999); print rounded < 1 ? 1 : rounded }')
  START_AT=$(date -u -d "@$((END_EPOCH - DURATION_SECONDS))" +%Y-%m-%dT%H:%M:%SZ)
fi

response_file=$(mktemp "${TMPDIR:-/tmp}/helix-jibri-response.XXXXXX")
trap 'rm -f "$response_file"' EXIT

http_ok() {
  [[ $1 == 2* ]]
}

signature_header() {
  local payload=$1 timestamp signature
  timestamp=$(date +%s)
  signature=$(printf '%s.%s' "$timestamp" "$payload" |
    openssl dgst -sha256 -hmac "$HELIX_JITSI_WEBHOOK_SECRET" | awk '{print $NF}')
  printf 't=%s,v1=%s' "$timestamp" "$signature"
}

PREPARE_PAYLOAD=$(jq -cn \
  --arg orgId "$HELIX_JITSI_ORG_ID" \
  --arg roomName "$ROOM" \
  --argjson byteSize "$BYTE_SIZE" \
  --arg sha256 "$SHA256" \
  --arg startedAt "$START_AT" \
  --arg endedAt "$END_AT" \
  '{
    orgId: $orgId,
    roomName: $roomName,
    mimeType: "video/mp4",
    byteSize: $byteSize,
    sha256: $sha256,
    startedAt: $startedAt,
    endedAt: $endedAt,
    metadata: { source: "jibri" }
  }')
PREPARE_STATUS=$(curl -sS -o "$response_file" -w '%{http_code}' \
  -X POST "${HELIX_INTERNAL_URL}/internal/meet/recording-uploads" \
  -H 'Content-Type: application/json' \
  -H "X-Helix-Signature: $(signature_header "$PREPARE_PAYLOAD")" \
  --data-binary "$PREPARE_PAYLOAD")
if ! http_ok "$PREPARE_STATUS"; then
  echo "finalize: prepare failed with HTTP $PREPARE_STATUS" >&2
  cat "$response_file" >&2
  exit 1
fi

UPLOAD_ID=$(jq -er '.uploadId | select(type == "string" and length > 0)' "$response_file")
UPLOAD_URL=$(jq -er '.uploadUrl | select(type == "string" and length > 0)' "$response_file")
UPLOAD_HEADERS=()
while IFS= read -r header; do
  UPLOAD_HEADERS+=(-H "$header")
done < <(jq -r '.headers | to_entries[] | "\(.key): \(.value)"' "$response_file")

UPLOAD_STATUS=$(curl -sS -o "$response_file" -w '%{http_code}' \
  -X PUT "$UPLOAD_URL" \
  "${UPLOAD_HEADERS[@]}" \
  --upload-file "$MP4")
if ! http_ok "$UPLOAD_STATUS"; then
  echo "finalize: recording upload failed with HTTP $UPLOAD_STATUS" >&2
  cat "$response_file" >&2
  exit 1
fi

COMPLETION_PAYLOAD=$(jq -cn \
  --arg uploadId "$UPLOAD_ID" \
  --argjson byteSize "$BYTE_SIZE" \
  --arg sha256 "$SHA256" \
  --arg startedAt "$START_AT" \
  --arg endedAt "$END_AT" \
  '{
    event: "recording.uploaded",
    uploadId: $uploadId,
    mimeType: "video/mp4",
    byteSize: $byteSize,
    sha256: $sha256,
    startedAt: $startedAt,
    endedAt: $endedAt,
    metadata: { uploaded: true, source: "jibri" }
  }')
COMPLETION_STATUS=$(curl -sS -o "$response_file" -w '%{http_code}' \
  -X POST "${HELIX_INTERNAL_URL}/webhook/jitsi" \
  -H 'Content-Type: application/json' \
  -H "X-Helix-Signature: $(signature_header "$COMPLETION_PAYLOAD")" \
  --data-binary "$COMPLETION_PAYLOAD")
if ! http_ok "$COMPLETION_STATUS"; then
  echo "finalize: completion webhook failed with HTTP $COMPLETION_STATUS" >&2
  cat "$response_file" >&2
  exit 1
fi

echo "finalize: recording uploaded and attached (uploadId=$UPLOAD_ID)"
