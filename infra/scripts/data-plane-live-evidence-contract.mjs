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
    if (requirePassed && result.status !== "passed") {
      throw new Error(`required data-plane evidence did not pass: ${scenario}`);
    }
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
