#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: infra/scripts/validate-k6.sh [options]

Runs the k6 quality gate. By default it starts local mock web/API targets on
adjacent high ports so the script itself can be validated without a running
Helix stack. The runner is auto-detected: local k6 first, then Docker.

Options:
  --mock                         Start mock targets. Default.
  --no-mock                      Use WEB_BASE_URL and API_BASE_URL as provided.
  --runner <auto|local|docker>    k6 runner. Default: auto.
  --static                       Run syntax/static validation only; no k6 or Docker.
  --web-port <port>              Mock web host port. Default: 39180.
  --api-port <port>              Mock API host port. Default: 39181.
  --duration <duration>          WEB/API/PRD scenario duration. Default: 3s.
  -h, --help

Environment:
  K6_IMAGE                       Default: grafana/k6:latest
  HELIX_K6_MOCK_IMAGE            Default: caddy:2-alpine
  WEB_BASE_URL, API_BASE_URL     Required when --no-mock is used
  HELIX_K6_DOCKER_WEB_BASE_URL   Docker-only WEB_BASE_URL override
  HELIX_K6_DOCKER_API_BASE_URL   Docker-only API_BASE_URL override
  HELIX_K6_DOCKER_NETWORK        Optional docker run network, for example: host
  HELIX_K6_DOCKER_ADD_HOST_GATEWAY
                                  Add host.docker.internal:host-gateway.
                                  Default: auto (Linux only). Use true/false
                                  to force behavior.
  AUTH_TOKEN                     Bearer token for protected endpoints
  SKIP_PROTECTED_WITHOUT_AUTH    Default: true
  K6_SCENARIO_GROUPS             Comma list of enabled groups
EOF
}

USE_MOCK=true
RUNNER=${HELIX_K6_RUNNER:-auto}
STATIC_ONLY=false
WEB_PORT=${HELIX_K6_WEB_PORT:-39180}
API_PORT=${HELIX_K6_API_PORT:-39181}
DURATION=${HELIX_K6_DURATION:-3s}
K6_IMAGE=${K6_IMAGE:-grafana/k6:latest}
MOCK_IMAGE=${HELIX_K6_MOCK_IMAGE:-caddy:2-alpine}
MOCK_CONTAINER=${HELIX_K6_MOCK_CONTAINER:-helix-k6-mock}
TMP_DIR=
MOCK_PID=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mock) USE_MOCK=true; shift ;;
    --no-mock) USE_MOCK=false; shift ;;
    --runner) RUNNER=${2:?missing runner}; shift 2 ;;
    --static) STATIC_ONLY=true; shift ;;
    --) shift ;;
    --web-port) WEB_PORT=${2:?missing web port}; shift 2 ;;
    --api-port) API_PORT=${2:?missing api port}; shift 2 ;;
    --duration) DURATION=${2:?missing duration}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

ensure_repo_root

case "$RUNNER" in
  auto|local|docker) ;;
  *) die "unknown runner: $RUNNER" ;;
esac

static_validate() {
  require_cmd bash
  require_cmd node
  bash -n infra/scripts/validate-k6.sh
  node --check infra/k6/helix-quality-gates.js
  node infra/k6/validate-quality-gates.mjs
}

if bool_true "$STATIC_ONLY"; then
  log "running static k6 validation"
  static_validate
  exit 0
fi

if [[ "$RUNNER" == "auto" ]]; then
  if command -v k6 >/dev/null 2>&1; then
    RUNNER=local
  elif command -v docker >/dev/null 2>&1; then
    RUNNER=docker
  else
    die "neither k6 nor docker is available; run infra/scripts/validate-k6.sh --static for syntax validation"
  fi
fi

if [[ "$RUNNER" == "local" ]]; then
  require_cmd k6
  if bool_true "$USE_MOCK"; then
    require_cmd node
    require_cmd curl
  fi
else
  require_cmd docker
  if bool_true "$USE_MOCK"; then
    require_cmd curl
  fi
fi

cleanup() {
  if [[ -n "${MOCK_PID:-}" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
    wait "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  if bool_true "$USE_MOCK" && [[ "$RUNNER" == "docker" ]]; then
    docker rm -f "$MOCK_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

wait_for_url() {
  local url=${1:?missing url}
  local attempts=30

  while (( attempts > 0 )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return
    fi
    attempts=$((attempts - 1))
    sleep 1
  done

  die "mock target did not become ready: $url"
}

start_mock_targets() {
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-k6.XXXXXX")
  cat >"$TMP_DIR/Caddyfile" <<'EOF'
:8080 {
  header Content-Type text/html
  respond "<html><body>helix k6 mock</body></html>" 200
}

:8081 {
  header Content-Type application/json
  header X-Helix-LLM-Routing-MS 1
  header X-Helix-OTel-Ingestion-Lag-MS 100
  respond "{\"status\":\"ok\",\"query\":\"helix-k6-inbound-mail-probe\"}" 200
}
EOF

  docker rm -f "$MOCK_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --rm \
    --name "$MOCK_CONTAINER" \
    -p "$WEB_PORT:8080" \
    -p "$API_PORT:8081" \
    -v "$TMP_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    "$MOCK_IMAGE" \
    caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

  wait_for_url "http://127.0.0.1:$WEB_PORT/"
  wait_for_url "http://127.0.0.1:$API_PORT/healthz"
}

start_node_mock_targets() {
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/helix-k6.XXXXXX")
  cat >"$TMP_DIR/mock-server.mjs" <<'EOF'
import http from "node:http";

const [webPort, apiPort] = process.argv.slice(2).map(Number);

const web = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<html><body>helix k6 mock</body></html>");
});

const api = http.createServer((request, response) => {
  request.resume();
  const headers = {
    "Content-Type": request.url === "/metrics" ? "text/plain" : "application/json",
    "X-Helix-LLM-Routing-MS": "1",
    "X-Helix-OTel-Ingestion-Lag-MS": "100",
  };
  response.writeHead(200, headers);
  response.end(
    request.url === "/metrics"
      ? "helix_mock_up 1\n"
      : "{\"status\":\"ok\",\"query\":\"helix-k6-inbound-mail-probe\"}",
  );
});

web.listen(webPort, "127.0.0.1");
api.listen(apiPort, "127.0.0.1");
EOF

  node "$TMP_DIR/mock-server.mjs" "$WEB_PORT" "$API_PORT" &
  MOCK_PID=$!

  wait_for_url "http://127.0.0.1:$WEB_PORT/"
  wait_for_url "http://127.0.0.1:$API_PORT/healthz"
}

if bool_true "$USE_MOCK"; then
  log "starting k6 mock targets on ports $WEB_PORT and $API_PORT"
  if [[ "$RUNNER" == "local" ]]; then
    start_node_mock_targets
    WEB_BASE_URL=${WEB_BASE_URL:-http://127.0.0.1:$WEB_PORT}
    API_BASE_URL=${API_BASE_URL:-http://127.0.0.1:$API_PORT}
  else
    start_mock_targets
    WEB_BASE_URL=${WEB_BASE_URL:-http://host.docker.internal:$WEB_PORT}
    API_BASE_URL=${API_BASE_URL:-http://host.docker.internal:$API_PORT}
  fi
else
  [[ -n "${WEB_BASE_URL:-}" ]] || die "WEB_BASE_URL is required with --no-mock"
  [[ -n "${API_BASE_URL:-}" ]] || die "API_BASE_URL is required with --no-mock"
fi

export WEB_BASE_URL
export API_BASE_URL
export WEB_VUS="${WEB_VUS:-1}"
export API_VUS="${API_VUS:-1}"
export PRD_VUS="${PRD_VUS:-1}"
export WEB_DURATION="${WEB_DURATION:-$DURATION}"
export API_DURATION="${API_DURATION:-$DURATION}"
export PRD_DURATION="${PRD_DURATION:-$DURATION}"
export WEB_ROUTES="${WEB_ROUTES:-/,/login,/signup,/mail,/chat,/drive,/docs,/calendar,/meet,/assistant,/settings,/admin}"
export API_TARGETS="${API_TARGETS:-/healthz,/readyz,/metrics,/openapi.json}"
export AUTH_TOKEN="${AUTH_TOKEN:-}"
export K6_TRACE_TOKEN="${K6_TRACE_TOKEN:-}"
export HELIX_TRACE_TOKEN="${HELIX_TRACE_TOKEN:-}"
export SKIP_PROTECTED_WITHOUT_AUTH="${SKIP_PROTECTED_WITHOUT_AUTH:-true}"
export K6_SCENARIO_GROUPS="${K6_SCENARIO_GROUPS:-web_navigation,api_smoke,mail_api,inbound_mail,search,chat,docs,meet_jitsi,plugin_install,assistant_llm,mcp,otel_health}"

if [[ "$RUNNER" == "local" ]]; then
  log "running local k6 quality gate"
  k6 run infra/k6/helix-quality-gates.js
else
  log "running Dockerized k6 quality gate"
  DOCKER_WEB_BASE_URL=${HELIX_K6_DOCKER_WEB_BASE_URL:-$WEB_BASE_URL}
  DOCKER_API_BASE_URL=${HELIX_K6_DOCKER_API_BASE_URL:-$API_BASE_URL}
  DOCKER_NETWORK_ARGS=()
  if [[ -n "${HELIX_K6_DOCKER_NETWORK:-}" ]]; then
    DOCKER_NETWORK_ARGS=(--network "$HELIX_K6_DOCKER_NETWORK")
  fi
  DOCKER_HOST_ARGS=()
  DOCKER_ADD_HOST_GATEWAY=${HELIX_K6_DOCKER_ADD_HOST_GATEWAY:-auto}
  case "$DOCKER_ADD_HOST_GATEWAY" in
    auto)
      if [[ "$(uname -s)" == "Linux" ]]; then
        DOCKER_HOST_ARGS=(--add-host=host.docker.internal:host-gateway)
      fi
      ;;
    true|1|yes)
      DOCKER_HOST_ARGS=(--add-host=host.docker.internal:host-gateway)
      ;;
    false|0|no|"") ;;
    *) die "unknown HELIX_K6_DOCKER_ADD_HOST_GATEWAY: $DOCKER_ADD_HOST_GATEWAY" ;;
  esac

  docker run --rm \
    "${DOCKER_NETWORK_ARGS[@]}" \
    "${DOCKER_HOST_ARGS[@]}" \
    -v "$PWD/infra/k6:/scripts:ro" \
    -e "WEB_BASE_URL=$DOCKER_WEB_BASE_URL" \
    -e "API_BASE_URL=$DOCKER_API_BASE_URL" \
    -e "WEB_VUS=$WEB_VUS" \
    -e "API_VUS=$API_VUS" \
    -e "PRD_VUS=$PRD_VUS" \
    -e "WEB_DURATION=$WEB_DURATION" \
    -e "API_DURATION=$API_DURATION" \
    -e "PRD_DURATION=$PRD_DURATION" \
    -e "WEB_ROUTES=$WEB_ROUTES" \
    -e "API_TARGETS=$API_TARGETS" \
    -e WEB_P95_MS \
    -e API_P95_MS \
    -e "AUTH_TOKEN=$AUTH_TOKEN" \
    -e "K6_TRACE_TOKEN=$K6_TRACE_TOKEN" \
    -e "HELIX_TRACE_TOKEN=$HELIX_TRACE_TOKEN" \
    -e "SKIP_PROTECTED_WITHOUT_AUTH=$SKIP_PROTECTED_WITHOUT_AUTH" \
    -e "K6_SCENARIO_GROUPS=$K6_SCENARIO_GROUPS" \
    -e MAIL_API_TOOL_ID \
    -e MAIL_API_BODY \
    -e MAIL_API_QUERY \
    -e MAIL_API_EXPECT \
    -e MAIL_API_P95_MS \
    -e INBOUND_MAIL_ACCEPT_PATH \
    -e INBOUND_MAIL_BODY \
    -e INBOUND_MAIL_MARKER \
    -e INBOUND_MAIL_FROM \
    -e INBOUND_MAIL_TO \
    -e INBOUND_MAIL_SEARCH_TOOL_ID \
    -e INBOUND_MAIL_SEARCH_BODY \
    -e INBOUND_MAIL_SEARCH_TIMEOUT_MS \
    -e INBOUND_MAIL_SEARCH_INTERVAL_MS \
    -e INBOUND_MAIL_SEARCHABLE_P95_MS \
    -e SEARCH_TOOL_IDS \
    -e SEARCH_BODY \
    -e SEARCH_QUERY \
    -e SEARCH_EXPECT \
    -e SEARCH_P95_MS \
    -e CHAT_TOOL_ID \
    -e CHAT_BODY \
    -e CHAT_QUERY \
    -e CHAT_EXPECT \
    -e CHAT_DELIVERY_P95_MS \
    -e DOCS_CREATE_TOOL_ID \
    -e DOCS_CREATE_BODY \
    -e DOCS_EXPORT_TOOL_ID \
    -e DOCS_EXPORT_BODY \
    -e DOCS_DOC_ID \
    -e DOCS_EXPECT \
    -e DOCS_COLLABORATION_P95_MS \
    -e MEET_CREATE_TOOL_ID \
    -e MEET_CREATE_BODY \
    -e MEET_MINT_TOOL_ID \
    -e MEET_MINT_BODY \
    -e MEET_END_TOOL_ID \
    -e MEET_ROOM_ID \
    -e MEET_JITSI_DOMAIN \
    -e MEET_EXPECT \
    -e MEET_END_AFTER_MINT \
    -e JITSI_JOIN_P95_MS \
    -e PLUGIN_INSTALL_TOOL_ID \
    -e PLUGIN_INSTALL_BODY \
    -e PLUGIN_INSTALL_EXPECT \
    -e PLUGIN_INSTALL_PLUGIN_ID \
    -e PLUGIN_INSTALL_VERSION \
    -e PLUGIN_INSTALL_SOURCE \
    -e PLUGIN_INSTALL_REGISTRY_URL \
    -e PLUGIN_INSTALL_P95_MS \
    -e ASSISTANT_TOOL_ID \
    -e ASSISTANT_BODY \
    -e ASSISTANT_MESSAGE \
    -e LLM_ROUTING_P95_MS \
    -e MCP_PATH \
    -e MCP_EXPECT \
    -e MCP_CATALOG_P95_MS \
    -e OTEL_HEALTH_PATH \
    -e OTEL_INGESTION_LAG_P95_MS \
    "$K6_IMAGE" run /scripts/helix-quality-gates.js
fi
