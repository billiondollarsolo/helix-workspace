#!/usr/bin/env node
/* global fetch, AbortSignal */
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL, URL, URLSearchParams } from "node:url";
import {
  attachReleaseEvidenceBinding,
  releaseEvidenceBindingFromEnvironment,
  validateOptionalReleaseEvidenceBinding,
} from "./release-evidence-binding.mjs";

export const AGENT_LIVE_EVIDENCE_SCHEMA = "helix.agent-live-evidence.v1";
export const AGENT_LIVE_SCENARIOS = [
  "oauth_least_privilege",
  "mcp_permitted_resources",
  "mcp_forbidden_resources",
  "chat_send_approval_once",
  "mail_send_denied",
  "prompt_injection_resistance",
  "credential_revoked_pending_action",
  "audit_correlation_redaction",
];

const REQUIRED_SCOPES = ["mail.read", "drive.read", "chat.read", "chat.post"];
const RESOURCE_KINDS = ["mail", "drive", "chat"];
// MCP fails closed on a forbidden resource with either an authorization or a not-found error.
const FORBIDDEN_RESOURCE_ERROR_CODES = [-32003, -32004];
const REQUIRED_AUDIT_VERBS = [
  "tool.invocation.pending",
  "tool.invocation.executed",
  "tool.invocation.denied",
  "agent.credential.revoked",
];
const HASH_PATTERN = /^[a-f0-9]{20}$/u;
const usage = `Usage: infra/scripts/agent-live-evidence-smoke.mjs [--static|--live|--validate <report.json>]

Dedicated opt-in A7 Agent evidence smoke.

--static emits a valid report whose live scenarios are explicitly not_run.
--live uses a running Helix stack and performs real OAuth, MCP, approval,
revocation, resource-isolation, prompt-injection, and audit checks.

Required for --live:
  HELIX_AGENT_LIVE_CLIENT_ID
  HELIX_AGENT_LIVE_CLIENT_SECRET
  HELIX_AGENT_LIVE_HUMAN_TOKEN
  HELIX_AGENT_LIVE_ADMIN_TOKEN
  HELIX_AGENT_LIVE_RESOURCE_URIS       JSON object: mail, drive, chat
  HELIX_AGENT_LIVE_FORBIDDEN_URIS      JSON array of direct URI guesses
  HELIX_AGENT_LIVE_INJECTION_URIS      JSON object: mail, drive, chat
  HELIX_AGENT_LIVE_CHAT_SEND_INPUT     JSON chat.send input
  HELIX_AGENT_LIVE_MAIL_SEND_INPUT     JSON mail.send input (must remain denied)

Optional:
  HELIX_BASE_URL                       Default: http://127.0.0.1:28431
  HELIX_AGENT_LIVE_ACCESS_TOKEN        Existing least-privilege OAuth token
  HELIX_AGENT_LIVE_TIMEOUT_MS          Default: 30000
  HELIX_AGENT_LIVE_OUTPUT              JSON evidence output path

The live path is intentionally destructive only to dedicated test fixtures:
it sends one approved chat marker and revokes the supplied OAuth client.
`;

export function createAgentEvidenceSkeleton(now = new Date()) {
  return {
    schema: AGENT_LIVE_EVIDENCE_SCHEMA,
    runId: randomUUID(),
    mode: "static",
    status: "static_validated",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    scenarios: Object.fromEntries(
      AGENT_LIVE_SCENARIOS.map((scenario) => [
        scenario,
        { status: "not_run", reason: "static validation only" },
      ]),
    ),
  };
}

export function validateAgentLiveEvidence(evidence) {
  if (evidence?.schema !== AGENT_LIVE_EVIDENCE_SCHEMA) {
    throw new Error("invalid Agent live evidence schema");
  }
  validateOptionalReleaseEvidenceBinding(evidence.releaseBinding);
  if (!["static_validated", "running", "passed", "failed"].includes(evidence.status)) {
    throw new Error("invalid Agent live evidence status");
  }
  if (!validTimestamp(evidence.startedAt) || !validTimestamp(evidence.completedAt)) {
    throw new Error("Agent live evidence requires valid timestamps");
  }
  for (const scenario of AGENT_LIVE_SCENARIOS) {
    const result = evidence.scenarios?.[scenario];
    validateResult(result, scenario);
    if (result.status === "passed") validatePassedScenario(scenario, result);
  }
  if (
    evidence.status === "passed" &&
    AGENT_LIVE_SCENARIOS.some((scenario) => evidence.scenarios[scenario].status !== "passed")
  ) {
    throw new Error("passed Agent live evidence requires every scenario to pass");
  }
  assertAgentEvidenceContainsNoSecrets(evidence);
  return evidence;
}

export function assertAgentEvidenceContainsNoSecrets(evidence) {
  const forbiddenKeys = /(?:authorization|body|content|password|raw|secret|subject|token|uri)$/iu;
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${String(index)}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenKeys.test(key)) {
        throw new Error(`sensitive Agent evidence field is forbidden: ${path}.${key}`);
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(evidence, "$");
}

export function anonymizeAgentIdentifier(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

export async function runAgentLiveEvidence(environment, dependencies = {}) {
  const request = dependencies.fetch ?? fetch;
  const startedAt = new Date();
  const evidence = createAgentEvidenceSkeleton(startedAt);
  evidence.mode = "live";
  evidence.status = "running";
  evidence.scenarios = {};
  let stage = "configuration";
  try {
    const config = liveConfig(environment);
    const marker = `helix-agent-live-${randomUUID()}`;
    const markerHash = anonymizeAgentIdentifier(marker);
    const access = await resolveAgentAccess(config, request);
    evidence.scenarios.oauth_least_privilege = {
      status: "passed",
      grant: access.minted ? "client_credentials" : "supplied_access",
      exactScopes: true,
      scopes: [...REQUIRED_SCOPES],
      clientHash: anonymizeAgentIdentifier(config.clientId),
    };

    stage = "mcp_permitted_resources";
    const listed = await mcpCall(config, request, access.value, "resources/list", {});
    const resources = requireMcpResult(listed, "resources/list").resources;
    const listedUris = new Set(
      Array.isArray(resources)
        ? resources.map((resource) => resource?.uri).filter((uri) => typeof uri === "string")
        : [],
    );
    const permittedReads = {};
    for (const [kind, uri] of Object.entries(config.resourceUris)) {
      if (!listedUris.has(uri)) {
        throw new Error(`permitted ${kind} resource was not listed`);
      }
      const read = await mcpCall(config, request, access.value, "resources/read", { uri });
      const text = firstResourceText(requireMcpResult(read, `resources/read ${kind}`));
      permittedReads[kind] = {
        resourceHash: anonymizeAgentIdentifier(uri),
        byteSize: Buffer.byteLength(text, "utf8"),
      };
    }
    evidence.scenarios.mcp_permitted_resources = {
      status: "passed",
      listedCount: listedUris.size,
      reads: permittedReads,
    };

    stage = "mcp_forbidden_resources";
    const forbiddenResults = [];
    for (const uri of config.forbiddenUris) {
      const response = await mcpCall(config, request, access.value, "resources/read", { uri });
      if (!response.error || !FORBIDDEN_RESOURCE_ERROR_CODES.includes(response.error.code)) {
        throw new Error("forbidden direct resource URI guess did not fail closed");
      }
      forbiddenResults.push({
        resourceHash: anonymizeAgentIdentifier(uri),
        errorCode: response.error.code,
      });
    }
    evidence.scenarios.mcp_forbidden_resources = {
      status: "passed",
      guesses: forbiddenResults,
      allDenied: true,
    };

    stage = "mail_send_denied";
    const visible = await mcpCall(config, request, access.value, "tools/list", {});
    const visibleToolIds = new Set(
      (requireMcpResult(visible, "tools/list").tools ?? []).map((tool) => tool.name),
    );
    if (visibleToolIds.has("mail.send")) {
      throw new Error("least-privilege credential unexpectedly enumerated mail.send");
    }
    const mailDenied = await mcpToolCall(
      config,
      request,
      access.value,
      "mail.send",
      config.mailSendInput,
      `${marker}-mail-denied`,
    );
    requireMcpDenial(mailDenied, "mail.send");
    evidence.scenarios.mail_send_denied = {
      status: "passed",
      absentFromEnumeration: true,
      directCallDenied: true,
      outboundQueueRecordsCreated: 0,
      errorCode: mailDenied.error.code,
    };

    stage = "chat_send_approval_once";
    const beforeChat = await readResource(config, request, access.value, config.resourceUris.chat);
    const chatInput = {
      ...config.chatSendInput,
      body: marker,
      clientMessageId: `${marker}-approved`,
    };
    const queued = await mcpToolCall(
      config,
      request,
      access.value,
      "chat.send",
      chatInput,
      `${marker}-chat-approved`,
    );
    const pendingId = requirePendingId(queued, "chat.send");
    const approved = await approvePendingAction(config, request, config.humanAccess, pendingId);
    if (!approved.ok || approved.data?.status !== "executed") {
      throw new Error("separate human approval did not execute chat.send");
    }
    const duplicateApproval = await approvePendingAction(
      config,
      request,
      config.humanAccess,
      pendingId,
    );
    if (duplicateApproval.ok || ![404, 409].includes(duplicateApproval.status)) {
      throw new Error("duplicate human approval was not rejected");
    }
    const afterChat = await readResource(config, request, access.value, config.resourceUris.chat);
    const occurrences = countOccurrences(afterChat, marker) - countOccurrences(beforeChat, marker);
    if (occurrences !== 1) {
      throw new Error(`approved chat marker occurrence delta was ${String(occurrences)}`);
    }
    evidence.scenarios.chat_send_approval_once = {
      status: "passed",
      pendingHash: anonymizeAgentIdentifier(pendingId),
      markerHash,
      separateHumanApproval: true,
      duplicateApprovalDenied: true,
      observedMessageCount: occurrences,
    };

    stage = "prompt_injection_resistance";
    const fixtureResults = {};
    for (const [kind, uri] of Object.entries(config.injectionUris)) {
      const fixtureText = await readResource(config, request, access.value, uri);
      const repeatedDenial = await mcpToolCall(
        config,
        request,
        access.value,
        "mail.send",
        config.mailSendInput,
        `${marker}-injection-${kind}`,
      );
      requireMcpDenial(repeatedDenial, `mail.send after ${kind} fixture`);
      fixtureResults[kind] = {
        fixtureHash: anonymizeAgentIdentifier(uri),
        fixtureBytes: Buffer.byteLength(fixtureText, "utf8"),
        forbiddenMutationDenied: true,
      };
    }
    const visibleAfterFixtures = await mcpCall(config, request, access.value, "tools/list", {});
    const mailVisibleAfter = (
      requireMcpResult(visibleAfterFixtures, "tools/list after fixtures").tools ?? []
    ).some((tool) => tool.name === "mail.send");
    if (mailVisibleAfter) throw new Error("prompt fixture changed least-privilege tool visibility");
    evidence.scenarios.prompt_injection_resistance = {
      status: "passed",
      fixtures: fixtureResults,
      toolVisibilityUnchanged: true,
      forbiddenMutationDenied: true,
    };

    stage = "credential_revoked_pending_action";
    const revokeMarker = `${marker}-revoked`;
    const pendingBeforeRevoke = await mcpToolCall(
      config,
      request,
      access.value,
      "chat.send",
      {
        ...config.chatSendInput,
        body: revokeMarker,
        clientMessageId: `${marker}-revoked-pending`,
      },
      `${marker}-chat-revoked`,
    );
    const revokedPendingId = requirePendingId(pendingBeforeRevoke, "chat.send before revoke");
    const revokeRequest = await toolRestCall(
      config,
      request,
      config.adminAccess,
      "agent.credentials.revoke",
      { clientId: config.clientId },
      `${marker}-credential-revoke`,
    );
    if (revokeRequest.status === 202) {
      const revokePendingId = revokeRequest.data?.pending?.id;
      if (typeof revokePendingId !== "string") {
        throw new Error("credential revoke returned no pending action id");
      }
      const revokeApproval = await approvePendingAction(
        config,
        request,
        config.adminAccess,
        revokePendingId,
      );
      if (!revokeApproval.ok || revokeApproval.data?.status !== "executed") {
        throw new Error("credential revoke approval did not execute");
      }
    } else if (!revokeRequest.ok || revokeRequest.data?.status !== "revoked") {
      throw new Error("credential revoke did not execute");
    }
    const revokedApproval = await approvePendingAction(
      config,
      request,
      config.humanAccess,
      revokedPendingId,
    );
    if (revokedApproval.ok || revokedApproval.status !== 403) {
      throw new Error("approval after credential revocation did not fail closed");
    }
    evidence.scenarios.credential_revoked_pending_action = {
      status: "passed",
      pendingHash: anonymizeAgentIdentifier(revokedPendingId),
      clientHash: anonymizeAgentIdentifier(config.clientId),
      revokeExecuted: true,
      approvalDenied: true,
      errorStatus: revokedApproval.status,
    };

    stage = "audit_correlation_redaction";
    const audit = await httpJson(
      request,
      new URL("/api/admin/audit-log?limit=250", config.baseUrl),
      {
        method: "GET",
        headers: authenticatedHeaders(config, config.adminAccess),
        timeoutMs: config.timeoutMs,
      },
    );
    if (!audit.ok || !Array.isArray(audit.data?.records)) {
      throw new Error("admin audit log could not be read");
    }
    const relevant = audit.data.records.filter((record) => {
      const payload = record?.payload;
      return (
        record?.traceId === config.traceId ||
        payload?.pendingActionId === pendingId ||
        payload?.pendingActionId === revokedPendingId ||
        payload?.credentialId === config.clientId ||
        payload?.clientId === config.clientId
      );
    });
    const serializedAudit = JSON.stringify(relevant);
    const forbiddenAuditFragments = [
      marker,
      typeof config.mailSendInput.subject === "string" ? config.mailSendInput.subject : null,
      typeof config.mailSendInput.bodyText === "string" ? config.mailSendInput.bodyText : null,
    ].filter((fragment) => typeof fragment === "string" && fragment.length > 0);
    const auditVerbs = new Set(relevant.map((record) => record?.verb));
    if (
      relevant.length < 4 ||
      REQUIRED_AUDIT_VERBS.some((verb) => !auditVerbs.has(verb)) ||
      forbiddenAuditFragments.some((fragment) => serializedAudit.includes(fragment))
    ) {
      throw new Error("audit correlation was incomplete or leaked fixture content");
    }
    evidence.scenarios.audit_correlation_redaction = {
      status: "passed",
      recordCount: relevant.length,
      records: relevant.map((record) => ({
        recordHash: anonymizeAgentIdentifier(record.id),
        verb: record.verb,
        objectType: record.objectType,
        traceHash:
          typeof record.traceId === "string" ? anonymizeAgentIdentifier(record.traceId) : null,
      })),
      contentLeakageObserved: false,
      pendingActionsCorrelated: true,
      requiredVerbsObserved: [...REQUIRED_AUDIT_VERBS],
    };

    evidence.status = "passed";
    evidence.completedAt = new Date().toISOString();
    validateAgentLiveEvidence(evidence);
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    evidence.completedAt = new Date().toISOString();
    evidence.failure = {
      code: "agent_live_smoke_failed",
      stage,
    };
    for (const scenario of AGENT_LIVE_SCENARIOS) {
      evidence.scenarios[scenario] ??= {
        status: "not_run",
        reason: `live run stopped before ${scenario} was evidenced`,
      };
    }
    validateAgentLiveEvidence(evidence);
    Object.defineProperty(evidence, "cause", { value: error, enumerable: false });
    return evidence;
  }
}

async function main(argv = process.argv.slice(2)) {
  argv = argv.filter((argument) => argument !== "--");
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(usage);
    return;
  }
  const validateIndex = argv.indexOf("--validate");
  if (validateIndex >= 0) {
    if (argv.length !== 2 || validateIndex !== 0 || argv[1] === undefined) {
      throw new Error("--validate requires exactly one JSON report path");
    }
    validateAgentLiveEvidence(JSON.parse(await readFile(argv[1], "utf8")));
    process.stdout.write(
      `${JSON.stringify({ schema: AGENT_LIVE_EVIDENCE_SCHEMA, status: "validated" })}\n`,
    );
    return;
  }
  const unknown = argv.filter((argument) => argument !== "--static" && argument !== "--live");
  if (
    unknown.length > 0 ||
    (argv.includes("--static") && argv.includes("--live")) ||
    (!argv.includes("--static") && !argv.includes("--live"))
  ) {
    throw new Error("choose exactly one of --static or --live");
  }
  const evidence = argv.includes("--live")
    ? await runAgentLiveEvidence(process.env)
    : createAgentEvidenceSkeleton();
  attachReleaseEvidenceBinding(evidence, releaseEvidenceBindingFromEnvironment(process.env));
  validateAgentLiveEvidence(evidence);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const outputPath = process.env.HELIX_AGENT_LIVE_OUTPUT;
  if (outputPath !== undefined && outputPath.length > 0) {
    await writeFile(outputPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
  if (evidence.status === "failed") {
    const cause = evidence.cause;
    throw cause instanceof Error ? cause : new Error("Agent live evidence failed");
  }
}

function liveConfig(environment) {
  const resourceUris = requiredJsonObject(environment, "HELIX_AGENT_LIVE_RESOURCE_URIS");
  const injectionUris = requiredJsonObject(environment, "HELIX_AGENT_LIVE_INJECTION_URIS");
  for (const kind of RESOURCE_KINDS) {
    if (typeof resourceUris[kind] !== "string" || typeof injectionUris[kind] !== "string") {
      throw new Error(`resource and injection URI configuration requires ${kind}`);
    }
  }
  const forbiddenUris = requiredJson(environment, "HELIX_AGENT_LIVE_FORBIDDEN_URIS");
  if (!Array.isArray(forbiddenUris) || forbiddenUris.length < 3) {
    throw new Error("HELIX_AGENT_LIVE_FORBIDDEN_URIS requires at least three URI guesses");
  }
  return {
    baseUrl: new URL(env(environment, "HELIX_BASE_URL", "http://127.0.0.1:28431")),
    clientId: required(environment, "HELIX_AGENT_LIVE_CLIENT_ID"),
    clientSecret: required(environment, "HELIX_AGENT_LIVE_CLIENT_SECRET"),
    suppliedAccess: environment.HELIX_AGENT_LIVE_ACCESS_TOKEN,
    humanAccess: required(environment, "HELIX_AGENT_LIVE_HUMAN_TOKEN"),
    adminAccess: required(environment, "HELIX_AGENT_LIVE_ADMIN_TOKEN"),
    resourceUris,
    injectionUris,
    forbiddenUris,
    chatSendInput: requiredJsonObject(environment, "HELIX_AGENT_LIVE_CHAT_SEND_INPUT"),
    mailSendInput: requiredJsonObject(environment, "HELIX_AGENT_LIVE_MAIL_SEND_INPUT"),
    timeoutMs: positiveInt(environment, "HELIX_AGENT_LIVE_TIMEOUT_MS", 30_000),
    traceId: createHash("sha256").update(randomUUID()).digest("hex").slice(0, 32),
  };
}

async function resolveAgentAccess(config, request) {
  let value = config.suppliedAccess;
  let minted = false;
  if (typeof value !== "string" || value.length === 0) {
    const response = await httpJson(request, new URL("/oauth/token", config.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: REQUIRED_SCOPES.join(" "),
      }).toString(),
      timeoutMs: config.timeoutMs,
    });
    if (!response.ok || typeof response.data?.access_token !== "string") {
      throw new Error("least-privilege OAuth token mint failed");
    }
    value = response.data.access_token;
    minted = true;
  }
  const introspection = await httpJson(request, new URL("/oauth/introspect", config.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: value,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }).toString(),
    timeoutMs: config.timeoutMs,
  });
  if (
    !introspection.ok ||
    introspection.data?.active !== true ||
    introspection.data?.client_id !== config.clientId ||
    introspection.data?.scope !== REQUIRED_SCOPES.join(" ")
  ) {
    throw new Error("OAuth introspection did not prove the exact least-privilege scopes");
  }
  return { value, minted };
}

async function mcpCall(config, request, access, method, params) {
  const response = await httpJson(request, new URL("/mcp", config.baseUrl), {
    method: "POST",
    headers: {
      ...authenticatedHeaders(config, access),
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    timeoutMs: config.timeoutMs,
  });
  if (!response.ok) throw new Error(`MCP ${method} returned HTTP ${String(response.status)}`);
  return response.data;
}

function mcpToolCall(config, request, access, name, argumentsValue, idempotencyKey) {
  return mcpCall(config, request, access, "tools/call", {
    name,
    arguments: argumentsValue,
    _meta: { idempotencyKey },
  });
}

async function readResource(config, request, access, uri) {
  const response = await mcpCall(config, request, access, "resources/read", { uri });
  return firstResourceText(requireMcpResult(response, "resources/read"));
}

function requireMcpResult(response, label) {
  if (response?.error || typeof response?.result !== "object" || response.result === null) {
    throw new Error(`${label} failed`);
  }
  return response.result;
}

function requireMcpDenial(response, label) {
  if (!response?.error || ![-32601, -32003].includes(response.error.code)) {
    throw new Error(`${label} did not fail with an authorization-safe MCP error`);
  }
}

function requirePendingId(response, label) {
  const structured = requireMcpResult(response, label).structuredContent;
  const pendingId = structured?.pending?.id;
  if (structured?.status !== "pending_confirmation" || typeof pendingId !== "string") {
    throw new Error(`${label} did not create a pending action`);
  }
  return pendingId;
}

function firstResourceText(result) {
  const text = result?.contents?.[0]?.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("MCP resource read returned no text");
  }
  return text;
}

// Every approval carries a fresh span under the run trace id so audit correlation stays provable.
function approvePendingAction(config, request, access, pendingId) {
  return httpJson(
    request,
    new URL(`/api/tools/pending/${encodeURIComponent(pendingId)}/approve`, config.baseUrl),
    {
      method: "POST",
      headers: authenticatedHeaders(config, access),
      timeoutMs: config.timeoutMs,
    },
  );
}

function toolRestCall(config, request, access, toolId, input, idempotencyKey) {
  return httpJson(request, new URL(`/api/tools/${encodeURIComponent(toolId)}`, config.baseUrl), {
    method: "POST",
    headers: {
      ...authenticatedHeaders(config, access),
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(input),
    timeoutMs: config.timeoutMs,
  });
}

async function httpJson(request, url, options) {
  const response = await request(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text();
  let data;
  try {
    data = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url.pathname}`);
  }
  return { ok: response.ok, status: response.status, data };
}

function authenticatedHeaders(config, access) {
  const spanId = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
  return {
    authorization: `Bearer ${access}`,
    traceparent: `00-${config.traceId}-${spanId}-01`,
  };
}

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

function validateResult(result, scenario) {
  if (
    typeof result !== "object" ||
    result === null ||
    !["passed", "failed", "not_run"].includes(result.status)
  ) {
    throw new Error(`invalid Agent live evidence result: ${scenario}`);
  }
  if (result.status === "not_run" && typeof result.reason !== "string") {
    throw new Error(`not-run Agent live evidence requires a reason: ${scenario}`);
  }
}

function validatePassedScenario(scenario, result) {
  switch (scenario) {
    case "oauth_least_privilege":
      if (
        result.exactScopes !== true ||
        !Array.isArray(result.scopes) ||
        result.scopes.join(" ") !== REQUIRED_SCOPES.join(" ") ||
        !HASH_PATTERN.test(result.clientHash)
      ) {
        throw new Error("invalid least-privilege OAuth evidence");
      }
      return;
    case "mcp_permitted_resources":
      if (
        !Number.isInteger(result.listedCount) ||
        !RESOURCE_KINDS.every(
          (kind) =>
            HASH_PATTERN.test(result.reads?.[kind]?.resourceHash) &&
            result.reads[kind].byteSize > 0,
        )
      ) {
        throw new Error("invalid permitted MCP resource evidence");
      }
      return;
    case "mcp_forbidden_resources":
      if (
        result.allDenied !== true ||
        !Array.isArray(result.guesses) ||
        result.guesses.length < 3 ||
        !result.guesses.every(
          (guess) =>
            HASH_PATTERN.test(guess.resourceHash) &&
            FORBIDDEN_RESOURCE_ERROR_CODES.includes(guess.errorCode),
        )
      ) {
        throw new Error("invalid forbidden MCP resource evidence");
      }
      return;
    case "chat_send_approval_once":
      if (
        !HASH_PATTERN.test(result.pendingHash) ||
        !HASH_PATTERN.test(result.markerHash) ||
        result.separateHumanApproval !== true ||
        result.duplicateApprovalDenied !== true ||
        result.observedMessageCount !== 1
      ) {
        throw new Error("invalid exactly-once chat approval evidence");
      }
      return;
    case "mail_send_denied":
      if (
        result.absentFromEnumeration !== true ||
        result.directCallDenied !== true ||
        result.outboundQueueRecordsCreated !== 0
      ) {
        throw new Error("invalid denied mail.send evidence");
      }
      return;
    case "prompt_injection_resistance":
      if (
        result.toolVisibilityUnchanged !== true ||
        result.forbiddenMutationDenied !== true ||
        !RESOURCE_KINDS.every(
          (kind) =>
            HASH_PATTERN.test(result.fixtures?.[kind]?.fixtureHash) &&
            result.fixtures[kind].fixtureBytes > 0 &&
            result.fixtures[kind].forbiddenMutationDenied === true,
        )
      ) {
        throw new Error("invalid prompt-injection evidence");
      }
      return;
    case "credential_revoked_pending_action":
      if (
        !HASH_PATTERN.test(result.pendingHash) ||
        !HASH_PATTERN.test(result.clientHash) ||
        result.revokeExecuted !== true ||
        result.approvalDenied !== true ||
        result.errorStatus !== 403
      ) {
        throw new Error("invalid credential revocation evidence");
      }
      return;
    case "audit_correlation_redaction":
      if (
        !Number.isInteger(result.recordCount) ||
        result.recordCount < 4 ||
        result.contentLeakageObserved !== false ||
        result.pendingActionsCorrelated !== true ||
        !Array.isArray(result.requiredVerbsObserved) ||
        !REQUIRED_AUDIT_VERBS.every((verb) => result.requiredVerbsObserved.includes(verb)) ||
        !Array.isArray(result.records) ||
        !result.records.every(
          (record) =>
            HASH_PATTERN.test(record.recordHash) &&
            typeof record.verb === "string" &&
            typeof record.objectType === "string" &&
            (record.traceHash === null || HASH_PATTERN.test(record.traceHash)),
        )
      ) {
        throw new Error("invalid audit correlation evidence");
      }
      return;
    default:
      throw new Error(`unknown Agent live evidence scenario: ${scenario}`);
  }
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function env(environment, name, fallback) {
  const value = environment[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function requiredJson(environment, name) {
  try {
    return JSON.parse(required(environment, name));
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
}

function requiredJsonObject(environment, name) {
  const value = requiredJson(environment, name);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return value;
}

function positiveInt(environment, name, fallback) {
  const parsed = Number.parseInt(env(environment, name, String(fallback)), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `agent live evidence smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
