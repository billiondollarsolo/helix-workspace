import { readFileSync } from "node:fs";

const source = readFileSync("infra/k6/helix-quality-gates.js", "utf8");
const runner = readFileSync("infra/scripts/validate-k6.sh", "utf8");
const liveAuthSmoke = readFileSync("infra/scripts/live-auth-smoke.sh", "utf8");
const adminGuide = readFileSync("docs/admin-guide.md", "utf8");
const troubleshooting = readFileSync("docs/troubleshooting.md", "utf8");

const requiredCoverage = [
  {
    label: "p95 mail-list render",
    group: "mail_api",
    metric: "helix_mail_api_ms",
    thresholdEnv: "MAIL_API_P95_MS",
    defaultThreshold: 200,
    envOverrides: ["MAIL_API_TOOL_ID", "MAIL_API_BODY", "MAIL_API_QUERY", "MAIL_API_EXPECT"],
  },
  {
    label: "inbound mail accept to searchable",
    group: "inbound_mail",
    metric: "helix_inbound_mail_searchable_ms",
    thresholdEnv: "INBOUND_MAIL_SEARCHABLE_P95_MS",
    defaultThreshold: 5000,
    envOverrides: [
      "INBOUND_MAIL_ACCEPT_PATH",
      "INBOUND_MAIL_BODY",
      "INBOUND_MAIL_MARKER",
      "INBOUND_MAIL_FROM",
      "INBOUND_MAIL_TO",
      "INBOUND_MAIL_SEARCH_TOOL_ID",
      "INBOUND_MAIL_SEARCH_BODY",
      "INBOUND_MAIL_SEARCH_TIMEOUT_MS",
      "INBOUND_MAIL_SEARCH_INTERVAL_MS",
    ],
  },
  {
    label: "p95 search query",
    group: "search",
    metric: "helix_search_query_ms",
    thresholdEnv: "SEARCH_P95_MS",
    defaultThreshold: 300,
    envOverrides: ["SEARCH_TOOL_IDS", "SEARCH_BODY", "SEARCH_QUERY", "SEARCH_EXPECT"],
  },
  {
    label: "chat message delivery",
    group: "chat",
    metric: "helix_chat_delivery_ms",
    thresholdEnv: "CHAT_DELIVERY_P95_MS",
    defaultThreshold: 150,
    envOverrides: ["CHAT_TOOL_ID", "CHAT_BODY", "CHAT_QUERY", "CHAT_EXPECT"],
  },
  {
    label: "concurrent editors in one doc",
    group: "docs",
    metric: "helix_docs_collaboration_ms",
    thresholdEnv: "DOCS_COLLABORATION_P95_MS",
    defaultThreshold: 200,
    envOverrides: [
      "DOCS_CREATE_TOOL_ID",
      "DOCS_CREATE_BODY",
      "DOCS_EXPORT_TOOL_ID",
      "DOCS_EXPORT_BODY",
      "DOCS_DOC_ID",
      "DOCS_EXPECT",
    ],
  },
  {
    label: "Jitsi call join time",
    group: "meet_jitsi",
    metric: "helix_jitsi_join_ms",
    thresholdEnv: "JITSI_JOIN_P95_MS",
    defaultThreshold: 4000,
    envOverrides: [
      "MEET_CREATE_TOOL_ID",
      "MEET_CREATE_BODY",
      "MEET_MINT_TOOL_ID",
      "MEET_MINT_BODY",
      "MEET_END_TOOL_ID",
      "MEET_ROOM_ID",
      "MEET_JITSI_DOMAIN",
      "MEET_EXPECT",
      "MEET_END_AFTER_MINT",
    ],
  },
  {
    label: "plugin install to operational",
    group: "plugin_install",
    metric: "helix_plugin_install_ms",
    thresholdEnv: "PLUGIN_INSTALL_P95_MS",
    defaultThreshold: 30000,
    envOverrides: [
      "PLUGIN_INSTALL_TOOL_ID",
      "PLUGIN_INSTALL_BODY",
      "PLUGIN_INSTALL_EXPECT",
      "PLUGIN_INSTALL_PLUGIN_ID",
      "PLUGIN_INSTALL_VERSION",
      "PLUGIN_INSTALL_SOURCE",
      "PLUGIN_INSTALL_REGISTRY_URL",
    ],
  },
  {
    label: "LLM routing decision overhead",
    group: "assistant_llm",
    metric: "helix_llm_routing_overhead_ms",
    thresholdEnv: "LLM_ROUTING_P95_MS",
    defaultThreshold: 5,
    envOverrides: ["ASSISTANT_TOOL_ID", "ASSISTANT_BODY", "ASSISTANT_MESSAGE"],
  },
  {
    label: "MCP tool catalog response",
    group: "mcp",
    metric: "helix_mcp_catalog_ms",
    thresholdEnv: "MCP_CATALOG_P95_MS",
    defaultThreshold: 100,
    envOverrides: ["MCP_PATH", "MCP_EXPECT"],
  },
  {
    label: "OTel trace ingestion lag",
    group: "otel_health",
    metric: "helix_otel_trace_ingestion_lag_ms",
    thresholdEnv: "OTEL_INGESTION_LAG_P95_MS",
    defaultThreshold: 1000,
    envOverrides: ["OTEL_HEALTH_PATH"],
  },
];

const failures = [];

expectDoc("admin guide", adminGuide, "## k6 PRD Scenario Evidence Contract");
expectDoc("troubleshooting", troubleshooting, "## k6 Target-Mode Blocker Reporting");

for (const item of requiredCoverage) {
  expectSource(item.label, item.group);
  expectSource(item.label, item.metric);
  expectSource(item.label, item.thresholdEnv);
  expectSource(item.label, String(item.defaultThreshold));

  expectDoc("admin guide", adminGuide, item.group);
  expectDoc("admin guide", adminGuide, item.metric);
  expectDoc("admin guide", adminGuide, item.thresholdEnv);
  expectDoc("admin guide", adminGuide, `K6_SCENARIO_GROUPS=${item.group}`);
  for (const envOverride of item.envOverrides) {
    expectDoc("admin guide", adminGuide, envOverride);
    expectRunnerPassthrough(item.label, envOverride);
  }
  expectRunnerPassthrough(item.label, item.thresholdEnv);
}

for (const targetModeEnv of [
  "WEB_BASE_URL",
  "API_BASE_URL",
  "AUTH_TOKEN",
  "K6_TRACE_TOKEN",
  "HELIX_TRACE_TOKEN",
  "SKIP_PROTECTED_WITHOUT_AUTH",
  "K6_SCENARIO_GROUPS",
]) {
  expectDoc("admin guide", adminGuide, targetModeEnv);
  expectRunnerPassthrough("target-mode k6 execution", targetModeEnv);
}

expectLiveAuthSmoke(
  "backend realism smoke preserves explicit k6 scenario overrides",
  "K6_SCENARIO_GROUPS_USER_SET",
);
expectLiveAuthSmoke(
  "backend realism smoke default k6 bundle",
  "api_smoke,mail_api,inbound_mail,search,chat,docs,meet_jitsi,mcp,otel_health",
);
for (const backendGroup of [
  "mail_api",
  "inbound_mail",
  "search",
  "chat",
  "docs",
  "meet_jitsi",
  "mcp",
  "otel_health",
]) {
  expectLiveAuthSmoke("backend realism smoke default k6 bundle", backendGroup);
}

for (const expected of [
  "blocker",
  "owner",
  "next command",
  "observed p95",
  "threshold",
  "K6_SCENARIO_GROUPS",
]) {
  expectDoc("admin guide", adminGuide, expected);
  expectDoc("troubleshooting", troubleshooting, expected);
}

expectDoc(
  "admin guide",
  adminGuide,
  "Outbound mail send-to-delivered remains live-provider evidence",
);

if (failures.length > 0) {
  console.error("k6 quality gate coverage validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `validated ${requiredCoverage.length} implemented PRD Section 2.2 k6 coverage contracts`,
);

function expectSource(label, expected) {
  if (!source.includes(expected)) {
    failures.push(`${label} is missing ${expected}`);
  }
}

function expectDoc(documentName, documentSource, expected) {
  if (!documentSource.includes(expected)) {
    failures.push(`${documentName} is missing ${expected}`);
  }
}

function expectRunnerPassthrough(label, envName) {
  if (
    !runner.includes(`-e ${envName}`) &&
    !runner.includes(`-e "${envName}=`) &&
    !runner.includes(`export ${envName}=`)
  ) {
    failures.push(`${label} runner is missing Docker/local passthrough for ${envName}`);
  }
}

function expectLiveAuthSmoke(label, expected) {
  if (!liveAuthSmoke.includes(expected)) {
    failures.push(`${label} is missing ${expected}`);
  }
}
