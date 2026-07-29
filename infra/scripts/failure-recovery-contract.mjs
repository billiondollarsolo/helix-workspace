import { createHash, randomUUID } from "node:crypto";
import { validateOptionalReleaseEvidenceBinding } from "./release-evidence-binding.mjs";

export const FAILURE_RECOVERY_REPORT_SCHEMA = "helix.failure-recovery-evidence.v1";
export const FAILURE_RECOVERY_OBSERVATION_SCHEMA = "helix.failure-recovery-observation.v1";

export const FAILURE_RECOVERY_SCENARIOS = [
  scenario({
    id: "mail_app_restart_undo_dispatch",
    faultMethod: "restart_app_during_undo_and_dispatch",
    faultCount: 2,
    userBehavior: "mail_queued_or_cancellable_then_delivered_once",
    noDuplicates: "one_outbound_submission_per_idempotency_key",
    alerts: ["HelixOutboxBacklogHigh", "HelixWorkerFailureRateHigh"],
    recovery: "mail_queue_drained_and_dispatch_healthy",
    minLogicalOperations: 2,
  }),
  scenario({
    id: "drive_scanner_restart",
    faultMethod: "restart_drive_scanner_during_scan",
    userBehavior: "drive_file_remains_quarantined_until_clean_verdict",
    noDuplicates: "one_active_version_and_one_terminal_scan_verdict",
    alerts: ["HelixDriveScannerUnavailable"],
    recovery: "scanner_reclaimed_upload_and_download_hash_matched",
  }),
  scenario({
    id: "nats_restart_active_chat",
    faultMethod: "restart_nats_during_active_chat",
    userBehavior: "chat_reports_reconnect_and_resumes_without_message_loss",
    noDuplicates: "one_chat_message_per_client_message_id",
    alerts: ["HelixDependencyUnavailable", "HelixChatReconnectSpike"],
    recovery: "chat_fanout_resumed_across_replicas",
  }),
  scenario({
    id: "redis_restart_rate_presence",
    faultMethod: "restart_redis_during_rate_limit_and_presence",
    userBehavior: "rate_limit_fails_safe_and_presence_recovers_by_ttl",
    noDuplicates: "one_rate_charge_per_request_identity",
    alerts: ["HelixDependencyUnavailable"],
    recovery: "redis_rate_limit_and_presence_checks_healthy",
  }),
  scenario({
    id: "object_store_denial",
    faultMethod: "deny_object_store_temporarily",
    userBehavior: "storage_operations_return_retryable_unavailable_without_false_success",
    noDuplicates: "one_committed_object_version_per_upload",
    alerts: ["HelixObjectStoreUnavailable"],
    recovery: "object_round_trip_and_integrity_check_healthy",
  }),
  scenario({
    id: "audit_destination_failure",
    faultMethod: "fail_critical_audit_destination",
    userBehavior: "critical_action_fails_closed_without_side_effect",
    noDuplicates: "zero_side_effects_for_failed_critical_action",
    alerts: ["HelixAuditShippingFailure"],
    recovery: "audit_append_and_critical_action_succeed_after_restore",
  }),
  scenario({
    id: "provider_agent_credential_expiry",
    faultMethod: "expire_provider_and_agent_credentials",
    faultCount: 2,
    userBehavior: "expired_credentials_are_denied_without_execution",
    noDuplicates: "zero_side_effects_from_expired_credentials",
    alerts: ["HelixMailProviderOutage", "HelixAgentCallFailureRateHigh"],
    recovery: "rotated_credentials_restore_provider_and_agent_calls",
    minLogicalOperations: 2,
  }),
  scenario({
    id: "disposable_volume_low_space",
    faultMethod: "fill_disposable_volume_to_low_space_threshold",
    userBehavior: "writes_stop_safely_before_exhaustion_and_reads_remain_available",
    noDuplicates: "one_committed_record_per_retried_write",
    alerts: ["HelixNodeFilesystemLowSpace"],
    recovery: "space_reclaimed_and_write_readback_healthy",
  }),
  scenario({
    id: "empty_environment_restore",
    faultMethod: "provision_empty_environment_and_restore_backup",
    userBehavior: "environment_stays_unready_until_consistency_checks_pass",
    noDuplicates: "restored_rows_objects_and_queue_entries_are_unique",
    alerts: ["HelixRestoreDrillStale"],
    recovery: "restored_environment_passes_hash_queue_audit_and_search_checks",
  }),
];

const EVIDENCE_SOURCES = new Set([
  "alertmanager",
  "api",
  "browser",
  "database",
  "log",
  "metric",
  "object_store",
  "queue",
  "restore",
]);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,255}$/u;
const SAFE_REASON = /^[a-z][a-z0-9_]{2,63}$/u;
const SENSITIVE_KEY =
  /(?:authorization|body|cookie|credential_value|email|filename|password|prompt|raw|secret|subject|tenant_name|token)$/iu;

export function createStaticFailureRecoveryEvidence(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    schema: FAILURE_RECOVERY_REPORT_SCHEMA,
    runId: randomUUID(),
    mode: "static",
    environmentClass: "none",
    environmentIdHash: null,
    status: "not_run",
    startedAt: timestamp,
    completedAt: timestamp,
    scenarios: Object.fromEntries(
      FAILURE_RECOVERY_SCENARIOS.map(({ id }) => [
        id,
        { status: "not_run", reasonCode: "static_contract_validation_only" },
      ]),
    ),
  };
}

export function createLiveFailureRecoveryEvidence({
  runId = randomUUID(),
  environmentId,
  startedAt = new Date(),
} = {}) {
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    throw new Error("live failure/recovery evidence requires an environment id");
  }
  return {
    schema: FAILURE_RECOVERY_REPORT_SCHEMA,
    runId,
    mode: "live",
    environmentClass: "disposable",
    environmentIdHash: hashIdentifier(environmentId),
    status: "running",
    startedAt: startedAt.toISOString(),
    completedAt: null,
    scenarios: Object.fromEntries(
      FAILURE_RECOVERY_SCENARIOS.map(({ id }) => [
        id,
        { status: "not_run", reasonCode: "live_scenario_not_started" },
      ]),
    ),
  };
}

export function validateFailureRecoveryEvidence(report, { requirePass = false } = {}) {
  if (!isRecord(report) || report.schema !== FAILURE_RECOVERY_REPORT_SCHEMA) {
    throw new Error("invalid failure/recovery evidence schema");
  }
  validateOptionalReleaseEvidenceBinding(report.releaseBinding);
  if (!["static", "live"].includes(report.mode)) {
    throw new Error("invalid failure/recovery evidence mode");
  }
  if (!["not_run", "running", "passed", "failed"].includes(report.status)) {
    throw new Error("invalid failure/recovery evidence status");
  }
  requireTimestamp(report.startedAt, "report startedAt");
  if (report.completedAt !== null) {
    requireTimestamp(report.completedAt, "report completedAt");
  }
  const scenarioIds = FAILURE_RECOVERY_SCENARIOS.map(({ id }) => id);
  const resultIds = isRecord(report.scenarios) ? Object.keys(report.scenarios) : [];
  if (
    resultIds.length !== scenarioIds.length ||
    new Set(resultIds).size !== resultIds.length ||
    scenarioIds.some((id) => !resultIds.includes(id))
  ) {
    throw new Error("failure/recovery report must contain every scenario exactly once");
  }
  for (const contract of FAILURE_RECOVERY_SCENARIOS) {
    validateFailureRecoveryScenario(report.scenarios[contract.id], contract);
  }

  if (report.mode === "static") {
    if (
      report.environmentClass !== "none" ||
      report.environmentIdHash !== null ||
      report.status !== "not_run" ||
      scenarioIds.some((id) => report.scenarios[id].status !== "not_run")
    ) {
      throw new Error("static failure/recovery evidence cannot claim live execution");
    }
  } else if (
    report.environmentClass !== "disposable" ||
    !/^[a-f0-9]{24}$/u.test(report.environmentIdHash ?? "")
  ) {
    throw new Error("live failure/recovery evidence must identify a disposable environment");
  }

  if (
    report.status === "passed" &&
    (report.mode !== "live" ||
      report.completedAt === null ||
      scenarioIds.some((id) => report.scenarios[id].status !== "passed"))
  ) {
    throw new Error("passed failure/recovery evidence requires every live scenario to pass");
  }
  if (requirePass && report.status !== "passed") {
    throw new Error(`failure/recovery evidence is not release-ready: ${String(report.status)}`);
  }
  assertFailureRecoveryEvidenceContainsNoSecrets(report);
  return report;
}

export function validateFailureRecoveryScenario(observation, contractOrId) {
  const contract =
    typeof contractOrId === "string"
      ? FAILURE_RECOVERY_SCENARIOS.find(({ id }) => id === contractOrId)
      : contractOrId;
  if (contract === undefined) {
    throw new Error(`unknown failure/recovery scenario: ${String(contractOrId)}`);
  }
  if (!isRecord(observation) || !["not_run", "failed", "passed"].includes(observation.status)) {
    throw new Error(`${contract.id} has an invalid scenario result`);
  }
  if (observation.status !== "passed") {
    if (!SAFE_REASON.test(String(observation.reasonCode ?? ""))) {
      throw new Error(`${contract.id} requires a safe reasonCode`);
    }
    return observation;
  }
  if (
    observation.schema !== FAILURE_RECOVERY_OBSERVATION_SCHEMA ||
    observation.scenarioId !== contract.id
  ) {
    throw new Error(`${contract.id} has an invalid passed observation identity`);
  }
  const startedAt = requireTimestamp(observation.startedAt, `${contract.id} startedAt`);
  const faultInjectedAt = requireTimestamp(
    observation.faultInjectedAt,
    `${contract.id} faultInjectedAt`,
  );
  const recoveredAt = requireTimestamp(observation.recoveredAt, `${contract.id} recoveredAt`);
  const completedAt = requireTimestamp(observation.completedAt, `${contract.id} completedAt`);
  if (
    !(startedAt <= faultInjectedAt && faultInjectedAt <= recoveredAt && recoveredAt <= completedAt)
  ) {
    throw new Error(`${contract.id} observation timestamps are out of order`);
  }
  if (
    !isRecord(observation.faultInjection) ||
    observation.faultInjection.method !== contract.faultMethod ||
    observation.faultInjection.observed !== true ||
    observation.faultInjection.count !== contract.faultCount
  ) {
    throw new Error(`${contract.id} lacks observed fault-injection evidence`);
  }
  const assertions = observation.assertions;
  if (!isRecord(assertions)) {
    throw new Error(`${contract.id} lacks recovery assertions`);
  }
  validateAssertion(assertions.userBehavior, contract.userBehavior, `${contract.id} user behavior`);

  const dedupe = assertions.noDuplicates;
  validateAssertion(dedupe, contract.noDuplicates, `${contract.id} no-duplicates`);
  if (
    !isNonnegativeInteger(dedupe.logicalOperationCount) ||
    dedupe.logicalOperationCount < contract.minLogicalOperations ||
    !isNonnegativeInteger(dedupe.attemptCount) ||
    dedupe.attemptCount < dedupe.logicalOperationCount ||
    !isNonnegativeInteger(dedupe.sideEffectCount) ||
    dedupe.sideEffectCount > dedupe.logicalOperationCount ||
    !isNonnegativeInteger(dedupe.distinctIdempotencyKeyCount) ||
    dedupe.distinctIdempotencyKeyCount !== dedupe.logicalOperationCount ||
    dedupe.duplicateCount !== 0
  ) {
    throw new Error(`${contract.id} does not prove retry/no-duplicate behavior`);
  }

  const alert = assertions.alert;
  if (
    !isRecord(alert) ||
    alert.status !== "passed" ||
    !sameStringSet(alert.rules, contract.alerts) ||
    typeof alert.resourceId !== "string" ||
    !SAFE_REFERENCE.test(alert.resourceId)
  ) {
    throw new Error(`${contract.id} does not prove the required alert fired`);
  }
  requireTimestamp(alert.firedAt, `${contract.id} alert firedAt`);
  validateEvidence(alert.evidence, `${contract.id} alert`, new Set(["alertmanager", "metric"]));

  const recovery = assertions.recovery;
  validateAssertion(recovery, contract.recovery, `${contract.id} recovery`);
  if (recovery.healthy !== true) {
    throw new Error(`${contract.id} did not recover to healthy`);
  }
  return observation;
}

export function finalizeFailureRecoveryEvidence(report, completedAt = new Date()) {
  report.completedAt = completedAt.toISOString();
  const statuses = Object.values(report.scenarios).map(({ status }) => status);
  report.status = statuses.every((status) => status === "passed") ? "passed" : "failed";
  return validateFailureRecoveryEvidence(report);
}

export function assertFailureRecoveryEvidenceContainsNoSecrets(report) {
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${String(index)}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new Error(`sensitive failure/recovery evidence field is forbidden: ${path}.${key}`);
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(report, "$");
}

export function hashIdentifier(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function scenario(input) {
  return {
    faultCount: 1,
    minLogicalOperations: 1,
    ...input,
  };
}

function validateAssertion(assertion, expectedCode, label) {
  if (!isRecord(assertion) || assertion.status !== "passed" || assertion.code !== expectedCode) {
    throw new Error(`${label} assertion did not pass`);
  }
  validateEvidence(assertion.evidence, label);
}

function validateEvidence(evidence, label, allowedSources = EVIDENCE_SOURCES) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error(`${label} requires non-empty observed evidence`);
  }
  for (const item of evidence) {
    if (
      !isRecord(item) ||
      !allowedSources.has(item.source) ||
      typeof item.ref !== "string" ||
      !SAFE_REFERENCE.test(item.ref)
    ) {
      throw new Error(`${label} contains invalid evidence`);
    }
    requireTimestamp(item.observedAt, `${label} evidence observedAt`);
  }
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every((value) => typeof value === "string") &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function requireTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return milliseconds;
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
