import { randomUUID } from "node:crypto";

export const DATA_PLANE_EVIDENCE_SCHEMA = "helix.data-plane-live-evidence.v1";
export const DATA_PLANE_SCENARIOS = [
  "postgres_tls_only",
  "postgres_least_privilege_roles",
  "redis_tls_only",
  "redis_authentication",
  "nats_mutual_tls",
  "nats_authentication",
  "nats_subject_permissions",
  "certificate_rotation",
];

export function createDataPlaneEvidenceSkeleton(now = new Date()) {
  return {
    schema: DATA_PLANE_EVIDENCE_SCHEMA,
    mode: "static",
    status: "static_validated",
    runId: randomUUID(),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    scenarios: Object.fromEntries(
      DATA_PLANE_SCENARIOS.map((scenario) => [
        scenario,
        { status: "not_run", reason: "static validation only" },
      ]),
    ),
  };
}

export function validateDataPlaneEvidence(evidence, requirePassed = false) {
  if (evidence?.schema !== DATA_PLANE_EVIDENCE_SCHEMA) {
    throw new Error("invalid data-plane evidence schema");
  }
  if (!["static", "local"].includes(evidence.mode)) {
    throw new Error("invalid data-plane evidence mode");
  }
  if (!["static_validated", "running", "passed", "failed"].includes(evidence.status)) {
    throw new Error("invalid data-plane evidence status");
  }
  const startedAt = requireTimestamp(evidence.startedAt, "data-plane evidence startedAt");
  const completedAt = requireTimestamp(evidence.completedAt, "data-plane evidence completedAt");
  if (completedAt < startedAt) {
    throw new Error("data-plane evidence timestamps are out of order");
  }
  const scenarioNames =
    evidence.scenarios !== null && typeof evidence.scenarios === "object"
      ? Object.keys(evidence.scenarios)
      : [];
  if (
    scenarioNames.length !== DATA_PLANE_SCENARIOS.length ||
    new Set(scenarioNames).size !== scenarioNames.length ||
    DATA_PLANE_SCENARIOS.some((scenario) => !scenarioNames.includes(scenario))
  ) {
    throw new Error("data-plane evidence must contain every scenario exactly once");
  }
  for (const scenario of DATA_PLANE_SCENARIOS) {
    const result = evidence.scenarios?.[scenario];
    if (
      result === undefined ||
      !["passed", "failed", "not_run"].includes(result.status) ||
      (result.status === "passed" &&
        (!Number.isFinite(result.durationMs) || result.durationMs < 0)) ||
      (result.status !== "passed" &&
        (typeof result.reason !== "string" || result.reason.length === 0))
    ) {
      throw new Error(`invalid data-plane evidence result: ${scenario}`);
    }
  }
  const everyScenarioPassed = DATA_PLANE_SCENARIOS.every(
    (scenario) => evidence.scenarios[scenario].status === "passed",
  );
  if (
    evidence.mode === "static" &&
    (evidence.status !== "static_validated" ||
      DATA_PLANE_SCENARIOS.some((scenario) => evidence.scenarios[scenario].status !== "not_run"))
  ) {
    throw new Error("static data-plane evidence cannot claim live execution");
  }
  if (evidence.mode === "local" && evidence.status === "passed" && !everyScenarioPassed) {
    throw new Error("passed data-plane evidence requires every live scenario to pass");
  }
  if (
    requirePassed &&
    (evidence.mode !== "local" || evidence.status !== "passed" || !everyScenarioPassed)
  ) {
    const incomplete = DATA_PLANE_SCENARIOS.find(
      (scenario) => evidence.scenarios[scenario].status !== "passed",
    );
    throw new Error(
      `required data-plane evidence did not pass: ${incomplete ?? String(evidence.status)}`,
    );
  }
  assertNoSensitiveEvidence(evidence);
  return evidence;
}

export function assertNoSensitiveEvidence(evidence) {
  const forbidden =
    /(?:authorization|body|certificate|credential|key|password|secret|token|url)$/iu;
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${String(index)}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [name, entry] of Object.entries(value)) {
      if (forbidden.test(name)) {
        throw new Error(`sensitive data-plane evidence field is forbidden: ${path}.${name}`);
      }
      visit(entry, `${path}.${name}`);
    }
  };
  visit(evidence, "$");
}

function requireTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return milliseconds;
}
