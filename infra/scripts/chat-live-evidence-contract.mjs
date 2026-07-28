import { createHash } from "node:crypto";

export const CHAT_LIVE_EVIDENCE_SCHEMA = "helix.chat-live-evidence.v1";

export const CHAT_LIVE_SCENARIOS = [
  "authenticated_browser_fanout",
  "non_member_denials",
  "multi_replica_nats_fanout",
  "app_restart_reconnect_durability",
  "redis_restart_reconnect_durability",
  "nats_restart_reconnect_durability",
  "clean_drive_attachment",
  "eicar_drive_attachment_denied",
  "invalid_origin_and_token_leakage",
  "pilot_load",
];

export const CHAT_RELEASE_LOAD_MINIMUMS = Object.freeze({
  users: 50,
  sockets: 100,
  durationSeconds: 30 * 60,
  p95LatencyMs: 2_000,
});

const RESULT_STATUSES = new Set(["passed", "failed", "not_run"]);
const SENSITIVE_FIELD =
  /(authorization|bearer|cookie|credential|password|secret|session|storage.?state|token)/iu;
const SENSITIVE_VALUE = /(authorization\s*:|bearer\s+[a-z0-9._~+/=-]+|access_token=)/iu;
const HASH_PATTERN = /^[a-f0-9]{20,64}$/u;

export function createChatEvidenceSkeleton(now = new Date()) {
  const generatedAt = canonicalTimestamp(now);
  return {
    schema: CHAT_LIVE_EVIDENCE_SCHEMA,
    generatedAt,
    mode: "not_run",
    status: "not_run",
    profile: {
      users: CHAT_RELEASE_LOAD_MINIMUMS.users,
      sockets: CHAT_RELEASE_LOAD_MINIMUMS.sockets,
      durationSeconds: CHAT_RELEASE_LOAD_MINIMUMS.durationSeconds,
      steadyMessagesPerSecond: 1,
      burstMessages: 20,
      burstIntervalSeconds: 60,
      thresholds: {
        p95LatencyMs: CHAT_RELEASE_LOAD_MINIMUMS.p95LatencyMs,
        p99LatencyMs: 5_000,
        maxErrorRate: 0.01,
        maxMemoryGrowthBytes: 268_435_456,
        maxEventLoopLagMs: 250,
        maxDbPoolPending: 0,
        maxRedisBacklog: 0,
        maxNatsBacklog: 0,
      },
    },
    environment: {
      replicaCount: 0,
      transport: "wss",
      tlsVerified: false,
    },
    scenarios: Object.fromEntries(
      CHAT_LIVE_SCENARIOS.map((name) => [
        name,
        {
          status: "not_run",
          reason:
            "Live Chat evidence requires two application replicas, authenticated browser sessions, PostgreSQL, Redis, NATS, Drive scanning, restart hooks, and metrics probes.",
        },
      ]),
    ),
  };
}

export function validateChatLiveEvidence(
  evidence,
  { requirePass = false, requireReleaseLoad = false } = {},
) {
  requireRecord(evidence, "Chat live evidence");
  if (evidence.schema !== CHAT_LIVE_EVIDENCE_SCHEMA) {
    throw new Error("unsupported Chat live evidence schema");
  }
  canonicalTimestamp(evidence.generatedAt);
  if (!["not_run", "live"].includes(evidence.mode)) {
    throw new Error("Chat live evidence mode must be not_run or live");
  }
  if (!RESULT_STATUSES.has(evidence.status)) {
    throw new Error("invalid Chat live evidence status");
  }
  validateProfile(evidence.profile);
  requireRecord(evidence.environment, "Chat live evidence environment");
  requireInteger(evidence.environment.replicaCount, "environment.replicaCount", 0);
  if (!["ws", "wss"].includes(evidence.environment.transport)) {
    throw new Error("environment.transport must be ws or wss");
  }
  if (typeof evidence.environment.tlsVerified !== "boolean") {
    throw new Error("environment.tlsVerified must be a boolean");
  }

  requireRecord(evidence.scenarios, "Chat live evidence scenarios");
  const scenarioNames = Object.keys(evidence.scenarios);
  if (
    scenarioNames.length !== CHAT_LIVE_SCENARIOS.length ||
    new Set(scenarioNames).size !== scenarioNames.length ||
    CHAT_LIVE_SCENARIOS.some((name) => !(name in evidence.scenarios))
  ) {
    throw new Error("Chat live evidence must contain every required scenario exactly once");
  }

  for (const name of CHAT_LIVE_SCENARIOS) {
    validateScenario(name, evidence.scenarios[name]);
  }

  const results = CHAT_LIVE_SCENARIOS.map((name) => evidence.scenarios[name].status);
  const derivedStatus = results.every((status) => status === "passed")
    ? "passed"
    : results.some((status) => status === "failed")
      ? "failed"
      : "not_run";
  if (evidence.status !== derivedStatus) {
    throw new Error(
      `Chat live evidence status ${evidence.status} does not match scenario status ${derivedStatus}`,
    );
  }
  if (evidence.mode === "not_run" && results.some((status) => status === "passed")) {
    throw new Error("not_run Chat evidence cannot contain passed scenarios");
  }
  if (evidence.status === "passed") {
    if (evidence.mode !== "live") {
      throw new Error("passed Chat evidence must use live mode");
    }
    if (evidence.environment.replicaCount < 2) {
      throw new Error("passed Chat evidence requires at least two application replicas");
    }
    if (evidence.environment.transport !== "wss" || !evidence.environment.tlsVerified) {
      throw new Error("passed Chat evidence requires verified WSS transport");
    }
  }

  assertNoSensitiveChatEvidence(evidence);
  if (requireReleaseLoad) {
    validateReleaseLoad(evidence);
  }
  if (requirePass && evidence.status !== "passed") {
    const incomplete = CHAT_LIVE_SCENARIOS.filter(
      (name) => evidence.scenarios[name].status !== "passed",
    );
    throw new Error(`required Chat live evidence did not pass: ${incomplete.join(", ")}`);
  }
  return evidence;
}

export function assertNoSensitiveChatEvidence(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveChatEvidence(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "invalid_origin_and_token_leakage" && SENSITIVE_FIELD.test(key)) {
        throw new Error(`sensitive Chat evidence field is forbidden: ${path}.${key}`);
      }
      assertNoSensitiveChatEvidence(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && SENSITIVE_VALUE.test(value)) {
    throw new Error(`sensitive Chat evidence value is forbidden: ${path}`);
  }
}

export function evidenceHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function validateProfile(profile) {
  requireRecord(profile, "Chat live evidence profile");
  for (const field of [
    "users",
    "sockets",
    "durationSeconds",
    "steadyMessagesPerSecond",
    "burstMessages",
    "burstIntervalSeconds",
  ]) {
    requireNumber(profile[field], `profile.${field}`, field === "burstMessages" ? 0 : 1);
  }
  requireRecord(profile.thresholds, "Chat live evidence thresholds");
  for (const field of [
    "p95LatencyMs",
    "p99LatencyMs",
    "maxErrorRate",
    "maxMemoryGrowthBytes",
    "maxEventLoopLagMs",
    "maxDbPoolPending",
    "maxRedisBacklog",
    "maxNatsBacklog",
  ]) {
    requireNumber(profile.thresholds[field], `profile.thresholds.${field}`, 0);
  }
  if (profile.thresholds.p99LatencyMs < profile.thresholds.p95LatencyMs) {
    throw new Error("p99 latency threshold cannot be lower than p95 threshold");
  }
  if (profile.thresholds.maxErrorRate > 1) {
    throw new Error("maxErrorRate must be between zero and one");
  }
}

function validateScenario(name, result) {
  requireRecord(result, `Chat scenario ${name}`);
  if (!RESULT_STATUSES.has(result.status)) {
    throw new Error(`Chat scenario ${name} has an invalid status`);
  }
  if (result.status !== "passed") {
    if (typeof result.reason !== "string" || result.reason.trim().length === 0) {
      throw new Error(`Chat scenario ${name} requires a reason when it did not pass`);
    }
    return;
  }
  if ("reason" in result) {
    throw new Error(`passed Chat scenario ${name} must not include a failure reason`);
  }
  canonicalTimestamp(result.startedAt);
  canonicalTimestamp(result.completedAt);
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
    throw new Error(`Chat scenario ${name} completion precedes its start`);
  }
  requireRecord(result.evidence, `Chat scenario ${name} evidence`);
  validatePassedScenarioEvidence(name, result.evidence);
}

function validatePassedScenarioEvidence(name, evidence) {
  switch (name) {
    case "authenticated_browser_fanout":
      requireTrue(evidence.twoAuthenticatedBrowserContexts, name);
      requireTrue(evidence.bidirectionalMessagesObserved, name);
      requireTrue(evidence.realWebSockets, name);
      requireHash(evidence.roomHash, `${name}.roomHash`);
      requireInteger(evidence.messagesObserved, `${name}.messagesObserved`, 2);
      return;
    case "non_member_denials":
      requireTrue(evidence.roomAbsentFromList, name);
      requireTrue(evidence.restListDenied, name);
      requireTrue(evidence.restSearchDenied, name);
      requireTrue(evidence.restSendDenied, name);
      requireTrue(evidence.websocketSubscribeDenied, name);
      requireTrue(evidence.websocketSendDenied, name);
      return;
    case "multi_replica_nats_fanout":
      requireInteger(evidence.distinctReplicaEndpoints, `${name}.distinctReplicaEndpoints`, 2);
      requireTrue(evidence.replicaAToB, name);
      requireTrue(evidence.replicaBToA, name);
      requireHash(evidence.replicaAHash, `${name}.replicaAHash`);
      requireHash(evidence.replicaBHash, `${name}.replicaBHash`);
      if (evidence.replicaAHash === evidence.replicaBHash) {
        throw new Error(`${name} requires two distinct replica identity hashes`);
      }
      return;
    case "app_restart_reconnect_durability":
    case "redis_restart_reconnect_durability":
    case "nats_restart_reconnect_durability":
      requireTrue(evidence.restartHookSucceeded, name);
      requireTrue(evidence.dependencyIdentityChanged, name);
      requireInteger(evidence.reconnectsObserved, `${name}.reconnectsObserved`, 2);
      requireTrue(evidence.preRestartMessageDurable, name);
      requireTrue(evidence.postRestartFanoutObserved, name);
      requireNumber(evidence.recoveryMs, `${name}.recoveryMs`, 0);
      return;
    case "clean_drive_attachment":
      requireTrue(evidence.driveStateActive, name);
      requireTrue(evidence.chatMessageObserved, name);
      requireHash(evidence.objectHash, `${name}.objectHash`);
      requireHash(evidence.messageHash, `${name}.messageHash`);
      return;
    case "eicar_drive_attachment_denied":
      requireTrue(evidence.driveStateQuarantined, name);
      requireTrue(evidence.chatSendDenied, name);
      requireTrue(evidence.messageNotObserved, name);
      requireHash(evidence.objectHash, `${name}.objectHash`);
      return;
    case "invalid_origin_and_token_leakage":
      requireTrue(evidence.invalidOriginDenied, name);
      requireTrue(evidence.browserSocketUrlsClean, name);
      requireTrue(evidence.browserNetworkUrlsClean, name);
      requireTrue(evidence.authFailureResponseRedacted, name);
      requireTrue(evidence.applicationLogsRedacted, name);
      requireInteger(evidence.invalidOriginCloseCode, `${name}.invalidOriginCloseCode`, 4_000);
      requireInteger(evidence.logLinesInspected, `${name}.logLinesInspected`, 1);
      return;
    case "pilot_load":
      validateLoadEvidence(evidence);
      return;
    default:
      throw new Error(`unknown Chat live evidence scenario: ${name}`);
  }
}

function validateLoadEvidence(evidence) {
  for (const field of [
    "actualUsers",
    "actualSockets",
    "durationSeconds",
    "messagesAttempted",
    "messagesObserved",
    "errors",
  ]) {
    requireInteger(evidence[field], `pilot_load.${field}`, 0);
  }
  for (const field of [
    "errorRate",
    "p95LatencyMs",
    "p99LatencyMs",
    "memoryStartBytes",
    "memoryPeakBytes",
    "memoryEndBytes",
    "memoryGrowthBytes",
    "eventLoopLagPeakMs",
    "dbPoolPendingPeak",
    "redisBacklogPeak",
    "natsBacklogPeak",
  ]) {
    requireNumber(evidence[field], `pilot_load.${field}`, 0);
  }
  requireTrue(evidence.steadyTrafficObserved, "pilot_load");
  requireTrue(evidence.burstTrafficObserved, "pilot_load");
  requireTrue(evidence.noUnboundedMemoryGrowth, "pilot_load");
  requireTrue(evidence.backlogsWithinLimits, "pilot_load");
}

function validateReleaseLoad(evidence) {
  const load = evidence.scenarios.pilot_load;
  if (evidence.status !== "passed" || load.status !== "passed") {
    throw new Error("release Chat evidence requires a passed pilot load");
  }
  const measured = load.evidence;
  if (
    evidence.profile.users < CHAT_RELEASE_LOAD_MINIMUMS.users ||
    measured.actualUsers < CHAT_RELEASE_LOAD_MINIMUMS.users
  ) {
    throw new Error(
      `release Chat load requires at least ${CHAT_RELEASE_LOAD_MINIMUMS.users} users`,
    );
  }
  if (
    evidence.profile.sockets < CHAT_RELEASE_LOAD_MINIMUMS.sockets ||
    measured.actualSockets < CHAT_RELEASE_LOAD_MINIMUMS.sockets
  ) {
    throw new Error(
      `release Chat load requires at least ${CHAT_RELEASE_LOAD_MINIMUMS.sockets} sockets`,
    );
  }
  if (
    evidence.profile.durationSeconds < CHAT_RELEASE_LOAD_MINIMUMS.durationSeconds ||
    measured.durationSeconds < CHAT_RELEASE_LOAD_MINIMUMS.durationSeconds
  ) {
    throw new Error(
      `release Chat load requires at least ${CHAT_RELEASE_LOAD_MINIMUMS.durationSeconds} seconds`,
    );
  }
  if (
    evidence.profile.thresholds.p95LatencyMs > CHAT_RELEASE_LOAD_MINIMUMS.p95LatencyMs ||
    measured.p95LatencyMs > CHAT_RELEASE_LOAD_MINIMUMS.p95LatencyMs
  ) {
    throw new Error(
      `release Chat load p95 must be at most ${CHAT_RELEASE_LOAD_MINIMUMS.p95LatencyMs} ms`,
    );
  }
  if (measured.p99LatencyMs > evidence.profile.thresholds.p99LatencyMs) {
    throw new Error("release Chat load p99 exceeds its declared threshold");
  }
  if (measured.errorRate > evidence.profile.thresholds.maxErrorRate) {
    throw new Error("release Chat load error rate exceeds its declared threshold");
  }
  if (measured.memoryGrowthBytes > evidence.profile.thresholds.maxMemoryGrowthBytes) {
    throw new Error("release Chat load memory growth exceeds its declared threshold");
  }
  if (measured.eventLoopLagPeakMs > evidence.profile.thresholds.maxEventLoopLagMs) {
    throw new Error("release Chat load event-loop lag exceeds its declared threshold");
  }
  if (measured.dbPoolPendingPeak > evidence.profile.thresholds.maxDbPoolPending) {
    throw new Error("release Chat load database pool waiters exceed their declared threshold");
  }
  if (
    measured.redisBacklogPeak > evidence.profile.thresholds.maxRedisBacklog ||
    measured.natsBacklogPeak > evidence.profile.thresholds.maxNatsBacklog
  ) {
    throw new Error("release Chat load backlog exceeds its declared threshold");
  }
}

function canonicalTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid Chat evidence timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

function requireRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function requireTrue(value, name) {
  if (value !== true) {
    throw new Error(`${name} must be true`);
  }
}

function requireHash(value, name) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${name} must be a content-free evidence hash`);
  }
}

function requireNumber(value, name, minimum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}`);
  }
}

function requireInteger(value, name, minimum) {
  requireNumber(value, name, minimum);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer`);
  }
}
