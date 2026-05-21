import http from "k6/http";
import { check, sleep } from "k6";
import { sha256 } from "k6/crypto";
import { Trend } from "k6/metrics";

const webBaseUrl = (__ENV.WEB_BASE_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const apiBaseUrl = (__ENV.API_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const authToken = __ENV.AUTH_TOKEN || "";
const traceToken = __ENV.K6_TRACE_TOKEN || __ENV.HELIX_TRACE_TOKEN || "";
const traceparent = traceToken ? buildTraceparent(traceToken) : "";
const skipProtectedWithoutAuth =
  (__ENV.SKIP_PROTECTED_WITHOUT_AUTH || "true").toLowerCase() !== "false";

const webRoutes = csv(
  __ENV.WEB_ROUTES ||
    "/,/login,/signup,/mail,/chat,/drive,/docs,/calendar,/meet,/assistant,/settings,/admin",
);
const apiTargets = csv(__ENV.API_TARGETS || "/healthz,/readyz,/metrics,/openapi.json");
const enabledGroups = new Set(
  csv(
    __ENV.K6_SCENARIO_GROUPS ||
      "web_navigation,api_smoke,mail_api,inbound_mail,search,chat,docs,meet_jitsi,plugin_install,assistant_llm,mcp,otel_health",
  ),
);

const scenarios = {};
const thresholds = {
  checks: ["rate>0.99"],
  http_req_failed: ["rate<0.05"],
  "http_req_duration{group:web_navigation}": [`p(95)<${Number(__ENV.WEB_P95_MS || 1000)}`],
  "http_req_duration{group:api_smoke}": [`p(95)<${Number(__ENV.API_P95_MS || 1000)}`],
};

const prdTargets = [
  {
    group: "mail_api",
    exec: "mailApi",
    metric: "helix_mail_api_ms",
    threshold: Number(__ENV.MAIL_API_P95_MS || 200),
    protected: true,
  },
  {
    group: "inbound_mail",
    exec: "inboundMailSearchable",
    metric: "helix_inbound_mail_searchable_ms",
    threshold: Number(__ENV.INBOUND_MAIL_SEARCHABLE_P95_MS || 5000),
    protected: true,
  },
  {
    group: "search",
    exec: "search",
    metric: "helix_search_query_ms",
    threshold: Number(__ENV.SEARCH_P95_MS || 300),
    protected: true,
  },
  {
    group: "chat",
    exec: "chat",
    metric: "helix_chat_delivery_ms",
    threshold: Number(__ENV.CHAT_DELIVERY_P95_MS || 150),
    protected: true,
  },
  {
    group: "docs",
    exec: "docs",
    metric: "helix_docs_collaboration_ms",
    threshold: Number(__ENV.DOCS_COLLABORATION_P95_MS || 200),
    protected: true,
  },
  {
    group: "meet_jitsi",
    exec: "meetJitsi",
    metric: "helix_jitsi_join_ms",
    threshold: Number(__ENV.JITSI_JOIN_P95_MS || 4000),
    protected: true,
  },
  {
    group: "plugin_install",
    exec: "pluginInstall",
    metric: "helix_plugin_install_ms",
    threshold: Number(__ENV.PLUGIN_INSTALL_P95_MS || 30000),
    protected: true,
  },
  {
    group: "assistant_llm",
    exec: "assistantLlm",
    metric: "helix_llm_routing_overhead_ms",
    threshold: Number(__ENV.LLM_ROUTING_P95_MS || 5),
    protected: true,
  },
  {
    group: "mcp",
    exec: "mcp",
    metric: "helix_mcp_catalog_ms",
    threshold: Number(__ENV.MCP_CATALOG_P95_MS || 100),
    protected: true,
  },
  {
    group: "otel_health",
    exec: "otelHealth",
    metric: "helix_otel_trace_ingestion_lag_ms",
    threshold: Number(__ENV.OTEL_INGESTION_LAG_P95_MS || 1000),
    protected: false,
  },
];

addScenario(
  "web_navigation",
  "webNavigationSmoke",
  false,
  __ENV.WEB_VUS || 2,
  __ENV.WEB_DURATION || "30s",
);
addScenario("api_smoke", "apiSmoke", false, __ENV.API_VUS || 2, __ENV.API_DURATION || "30s");

for (const target of prdTargets) {
  if (
    addScenario(
      target.group,
      target.exec,
      target.protected,
      __ENV.PRD_VUS || 1,
      __ENV.PRD_DURATION || "30s",
    )
  ) {
    thresholds[target.metric] = [`p(95)<${target.threshold}`];
  }
}

export const options = {
  scenarios,
  thresholds,
};

const metrics = {
  mail_api: new Trend("helix_mail_api_ms", true),
  inbound_mail: new Trend("helix_inbound_mail_searchable_ms", true),
  search: new Trend("helix_search_query_ms", true),
  chat: new Trend("helix_chat_delivery_ms", true),
  docs: new Trend("helix_docs_collaboration_ms", true),
  meet_jitsi: new Trend("helix_jitsi_join_ms", true),
  plugin_install: new Trend("helix_plugin_install_ms", true),
  assistant_llm: new Trend("helix_llm_routing_overhead_ms", true),
  mcp: new Trend("helix_mcp_catalog_ms", true),
  otel_health: new Trend("helix_otel_trace_ingestion_lag_ms", true),
};

const baseHeaders = {
  ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  ...(traceparent ? { traceparent } : {}),
};

const requestParams = Object.keys(baseHeaders).length > 0 ? { headers: baseHeaders } : {};

const jsonRequestParams = {
  ...requestParams,
  headers: {
    ...(requestParams.headers || {}),
    "Content-Type": "application/json",
  },
};

export function webNavigationSmoke() {
  for (const route of webRoutes) {
    const response = http.get(`${webBaseUrl}${route}`, {
      tags: { group: "web_navigation", route },
    });
    check(response, {
      "web route is reachable and not a server error": (res) =>
        res.status >= 200 && res.status < 500,
      "web route returns html or redirect": (res) =>
        [200, 301, 302, 307, 308].includes(res.status) &&
        (String(res.headers["Content-Type"] || "").includes("text/html") || res.status >= 300),
    });
    sleep(0.2);
  }
}

export function apiSmoke() {
  for (const route of apiTargets) {
    const response = http.get(`${apiBaseUrl}${route}`, {
      ...requestParams,
      tags: { group: "api_smoke", route },
    });
    check(response, {
      "api target is reachable": (res) => res.status >= 200 && res.status < 500,
      "api target is not unauthorized when AUTH_TOKEN is provided": (res) =>
        !authToken || res.status !== 401,
    });
    sleep(0.2);
  }
}

export function mailApi() {
  recordToolCall({
    group: "mail_api",
    metric: metrics.mail_api,
    toolId: __ENV.MAIL_API_TOOL_ID || "mail.search",
    body: jsonEnv("MAIL_API_BODY", { query: __ENV.MAIL_API_QUERY || "", limit: 50 }),
    okStatuses: [200, 404],
    expect: __ENV.MAIL_API_EXPECT || "",
  });
}

export function inboundMailSearchable() {
  const marker = __ENV.INBOUND_MAIL_MARKER || "helix-k6-inbound-mail-probe";
  const startedAt = Date.now();
  const acceptResponse = http.post(
    `${apiBaseUrl}${__ENV.INBOUND_MAIL_ACCEPT_PATH || "/api/tools/mail.inbound.accept"}`,
    JSON.stringify(jsonEnv("INBOUND_MAIL_BODY", defaultInboundMailBody(marker))),
    { ...jsonRequestParams, tags: { group: "inbound_mail", step: "accept" } },
  );
  const accepted = [200, 202].includes(acceptResponse.status);

  let searchResponse = null;
  let searchable = false;
  const timeoutMs = Number(__ENV.INBOUND_MAIL_SEARCH_TIMEOUT_MS || 5000);
  const intervalMs = Number(__ENV.INBOUND_MAIL_SEARCH_INTERVAL_MS || 250);
  const deadline = Date.now() + timeoutMs;

  while (accepted && Date.now() <= deadline) {
    searchResponse = toolCall(
      __ENV.INBOUND_MAIL_SEARCH_TOOL_ID || "mail.search",
      jsonEnv("INBOUND_MAIL_SEARCH_BODY", { query: marker, limit: 10 }),
      { group: "inbound_mail", step: "search" },
    );
    searchable = searchResponse.status === 200 && responseContains(searchResponse, marker);
    if (searchable) {
      break;
    }
    sleep(intervalMs / 1000);
  }

  metrics.inbound_mail.add(Date.now() - startedAt, { group: "inbound_mail" });
  check(acceptResponse, {
    "inbound mail accept endpoint accepted probe": () => accepted,
    "inbound mail probe became searchable": () => searchable,
    "inbound mail search is authorized with AUTH_TOKEN": () =>
      !authToken || searchResponse === null || searchResponse.status !== 401,
  });
}

export function search() {
  const query = __ENV.SEARCH_QUERY || "helix";
  for (const toolId of csv(__ENV.SEARCH_TOOL_IDS || "mail.search,chat.search,drive.search")) {
    recordToolCall({
      group: "search",
      metric: metrics.search,
      toolId,
      body: jsonEnv("SEARCH_BODY", { query, limit: 20 }),
      okStatuses: [200, 404],
      expect: __ENV.SEARCH_EXPECT || "",
    });
  }
}

export function chat() {
  recordToolCall({
    group: "chat",
    metric: metrics.chat,
    toolId: __ENV.CHAT_TOOL_ID || "chat.search",
    body: jsonEnv("CHAT_BODY", { query: __ENV.CHAT_QUERY || "", limit: 20 }),
    okStatuses: [200, 404],
    expect: __ENV.CHAT_EXPECT || "",
  });
}

export function docs() {
  const marker = __ENV.DOCS_EXPECT || `Helix Docs k6 ${Date.now()}-${__VU}-${__ITER}`;
  const startedAt = Date.now();
  let docId = __ENV.DOCS_DOC_ID || "";
  const providedDocId = docId.length > 0;
  let createResponse = null;

  if (!docId) {
    createResponse = toolCall(
      __ENV.DOCS_CREATE_TOOL_ID || "docs.create",
      jsonEnv("DOCS_CREATE_BODY", {
        title: `k6 Docs collaboration probe ${marker}`,
        initialMarkdown: `Synthetic Docs backend probe ${marker}`,
        metadata: { source: "k6", marker },
      }),
      { group: "docs", step: "create" },
    );
    const created = parseJson(createResponse);
    docId = typeof created?.id === "string" ? created.id : "";
  }

  const exportResponse = toolCall(
    __ENV.DOCS_EXPORT_TOOL_ID || "docs.export",
    {
      ...jsonEnv("DOCS_EXPORT_BODY", {
        docId,
        format: "markdown",
        includeComments: true,
      }),
      docId,
    },
    { group: "docs", step: "export" },
  );
  metrics.docs.add(Date.now() - startedAt, { group: "docs" });

  check(exportResponse, {
    "docs create tool accepted probe": () =>
      createResponse === null || [200, 202].includes(createResponse.status),
    "docs backend probe returned a document id": () => docId.length > 0,
    "docs export tool is reachable": (res) => [200, 404].includes(res.status),
    "docs export is authorized with AUTH_TOKEN": (res) => !authToken || res.status !== 401,
    "docs export contains expected marker": (res) =>
      (providedDocId && !__ENV.DOCS_EXPECT) || responseContains(res, marker),
  });
}

export function meetJitsi() {
  const marker = `Helix Meet k6 ${Date.now()}-${__VU}-${__ITER}`;
  const expect = __ENV.MEET_EXPECT || "";
  const startedAt = Date.now();
  let roomId = __ENV.MEET_ROOM_ID || "";
  let createResponse = null;

  if (!roomId) {
    createResponse = toolCall(
      __ENV.MEET_CREATE_TOOL_ID || "meet.create-room",
      jsonEnv("MEET_CREATE_BODY", {
        subject: `k6 Meet join probe ${marker}`,
        jitsiDomain: __ENV.MEET_JITSI_DOMAIN || "meet.localhost",
        participantActorIds: [],
        metadata: { source: "k6", marker },
      }),
      { group: "meet_jitsi", step: "create" },
    );
    const created = parseJson(createResponse);
    roomId = typeof created?.id === "string" ? created.id : "";
  }

  const mintResponse = toolCall(
    __ENV.MEET_MINT_TOOL_ID || "meet.mint-token",
    {
      ...jsonEnv("MEET_MINT_BODY", {
        roomId,
        expiresInSeconds: 600,
        moderator: false,
      }),
      roomId,
    },
    { group: "meet_jitsi", step: "mint-token" },
  );

  if ((__ENV.MEET_END_AFTER_MINT || "true").toLowerCase() !== "false" && roomId) {
    toolCall(
      __ENV.MEET_END_TOOL_ID || "meet.end-room",
      { roomId },
      { group: "meet_jitsi", step: "end-room" },
    );
  }

  metrics.meet_jitsi.add(Date.now() - startedAt, { group: "meet_jitsi" });
  check(mintResponse, {
    "meet create tool accepted probe": () =>
      createResponse === null || [200, 202].includes(createResponse.status),
    "meet backend probe returned a room id": () => roomId.length > 0,
    "meet mint-token tool is reachable": (res) => [200, 404].includes(res.status),
    "meet mint-token is authorized with AUTH_TOKEN": (res) => !authToken || res.status !== 401,
    "meet mint-token returned a JWT": (res) => jwtLooksSigned(parseJson(res)?.token),
    "meet mint-token returned a Jitsi join URL": (res) =>
      typeof parseJson(res)?.joinUrl === "string" && parseJson(res).joinUrl.includes("jwt="),
    "meet response contains expected marker": (res) => !expect || responseContains(res, expect),
  });
}

export function pluginInstall() {
  recordToolCall({
    group: "plugin_install",
    metric: metrics.plugin_install,
    toolId: __ENV.PLUGIN_INSTALL_TOOL_ID || "plugin.install",
    body: jsonEnv("PLUGIN_INSTALL_BODY", defaultPluginInstallBody()),
    okStatuses: [200, 202, 404],
    expect: __ENV.PLUGIN_INSTALL_EXPECT || "",
  });
}

export function assistantLlm() {
  const response = toolCall(
    __ENV.ASSISTANT_TOOL_ID || "assistant.chat",
    jsonEnv("ASSISTANT_BODY", {
      message: __ENV.ASSISTANT_MESSAGE || "Route this request without side effects.",
    }),
    { group: "assistant_llm" },
  );
  recordResponseMetric(metrics.assistant_llm, response, "assistant_llm", [
    "X-Helix-LLM-Routing-MS",
    "X-LLM-Routing-MS",
  ]);
  check(response, {
    "assistant/LLM route is reachable": (res) => [200, 400, 404].includes(res.status),
    "assistant/LLM route is authorized with AUTH_TOKEN": (res) => !authToken || res.status !== 401,
  });
}

export function mcp() {
  const response = http.post(
    `${apiBaseUrl}${__ENV.MCP_PATH || "/mcp"}`,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    { ...jsonRequestParams, tags: { group: "mcp" } },
  );
  recordResponseMetric(metrics.mcp, response, "mcp");
  check(response, {
    "MCP tool catalog is reachable": (res) => res.status >= 200 && res.status < 500,
    "MCP tool catalog is authorized with AUTH_TOKEN": (res) => !authToken || res.status !== 401,
    "MCP tool catalog contains expected marker": (res) =>
      !__ENV.MCP_EXPECT || responseContains(res, __ENV.MCP_EXPECT),
  });
}

export function otelHealth() {
  const response = http.get(`${apiBaseUrl}${__ENV.OTEL_HEALTH_PATH || "/metrics"}`, {
    ...requestParams,
    tags: { group: "otel_health" },
  });
  recordResponseMetric(metrics.otel_health, response, "otel_health", [
    "X-Helix-OTel-Ingestion-Lag-MS",
    "X-OTel-Ingestion-Lag-MS",
  ]);
  check(response, {
    "OTel/health surface is reachable": (res) => res.status >= 200 && res.status < 500,
  });
}

function addScenario(group, exec, protectedEndpoint, vus, duration) {
  if (!enabledGroups.has(group) || (protectedEndpoint && skipProtectedWithoutAuth && !authToken)) {
    return false;
  }

  scenarios[group] = {
    executor: "constant-vus",
    vus: Number(vus),
    duration,
    exec,
    tags: { group },
  };
  return true;
}

function recordToolCall({ group, metric, toolId, body, okStatuses, expect = "" }) {
  const response = toolCall(toolId, body, { group, toolId });
  recordResponseMetric(metric, response, group);
  check(response, {
    [`${group} tool is reachable`]: (res) => okStatuses.includes(res.status),
    [`${group} tool is authorized with AUTH_TOKEN`]: (res) => !authToken || res.status !== 401,
    [`${group} response contains expected marker`]: (res) =>
      !expect || responseContains(res, expect),
  });
}

function toolCall(toolId, body, tags) {
  return http.post(`${apiBaseUrl}/api/tools/${encodeURIComponent(toolId)}`, JSON.stringify(body), {
    ...jsonRequestParams,
    tags,
  });
}

function recordResponseMetric(metric, response, group, headerNames = []) {
  const value = metricValue(response, headerNames);
  metric.add(value, { group });
}

function metricValue(response, headerNames) {
  for (const headerName of headerNames) {
    const value = Number(header(response, headerName));
    if (Number.isFinite(value)) {
      return value;
    }
  }

  const body = parseJson(response);
  for (const field of ["durationMs", "latencyMs", "routingMs", "ingestionLagMs"]) {
    const value = Number(body && body[field]);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return response.timings.duration;
}

function header(response, name) {
  const direct = response.headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(response.headers)) {
    if (key.toLowerCase() === lowerName) {
      return response.headers[key];
    }
  }
  return undefined;
}

function jsonEnv(name, fallback) {
  const value = __ENV[name];
  if (!value) {
    return fallback;
  }
  return JSON.parse(value);
}

function defaultPluginInstallBody() {
  return {
    pluginId: __ENV.PLUGIN_INSTALL_PLUGIN_ID || "com.helix.core.search-meilisearch",
    version: __ENV.PLUGIN_INSTALL_VERSION || "1.0.0",
    source: __ENV.PLUGIN_INSTALL_SOURCE || "official",
  };
}

function defaultInboundMailBody(marker) {
  return {
    eventSubject: "mail.inbound.accepted",
    messageId: `<${marker}@k6.local>`,
    from: { address: __ENV.INBOUND_MAIL_FROM || "sender@example.test" },
    to: [{ address: __ENV.INBOUND_MAIL_TO || "local-admin@helix.local" }],
    subject: `k6 inbound mail searchable probe ${marker}`,
    bodyText: `Synthetic TASK-A09 inbound mail probe ${marker}`,
    receivedAt: new Date().toISOString(),
  };
}

function responseContains(response, marker) {
  return String(response.body || "").includes(marker);
}

function jwtLooksSigned(value) {
  return typeof value === "string" && value.split(".").length === 3;
}

function buildTraceparent(token) {
  const normalized = String(token).trim().toLowerCase();
  const existing = normalized.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  if (existing) {
    return normalized;
  }
  const traceId = normalized.match(/^[0-9a-f]{32}$/)
    ? normalized
    : String(sha256(normalized, "hex")).slice(0, 32);
  const parentId = String(sha256(`${normalized}:k6-parent`, "hex")).slice(0, 16);
  return `00-${traceId}-${parentId}-01`;
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_error) {
    return null;
  }
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
