import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLiveFailureRecoveryEvidence,
  createStaticFailureRecoveryEvidence,
  FAILURE_RECOVERY_OBSERVATION_SCHEMA,
  FAILURE_RECOVERY_SCENARIOS,
  finalizeFailureRecoveryEvidence,
  validateFailureRecoveryEvidence,
  validateFailureRecoveryScenario,
} from "./failure-recovery-contract.mjs";
import { runFailureRecoveryEvidence } from "./failure-recovery-runner.mjs";

const startedAt = "2026-07-28T20:00:00.000Z";
const faultInjectedAt = "2026-07-28T20:01:00.000Z";
const recoveredAt = "2026-07-28T20:02:00.000Z";
const completedAt = "2026-07-28T20:03:00.000Z";

describe("V4 failure/recovery evidence contract", () => {
  it("keeps all nine destructive scenarios explicitly not-run in static mode", () => {
    const report = createStaticFailureRecoveryEvidence(new Date(startedAt));
    expect(validateFailureRecoveryEvidence(report)).toBe(report);
    expect(FAILURE_RECOVERY_SCENARIOS).toHaveLength(9);
    expect(Object.values(report.scenarios).every(({ status }) => status === "not_run")).toBe(true);
    expect(() => validateFailureRecoveryEvidence(report, { requirePass: true })).toThrow(
      "not release-ready",
    );
  });

  it("accepts only a complete disposable live run with all four assertions per scenario", () => {
    const report = createLiveFailureRecoveryEvidence({
      environmentId: "disposable-v4-fixture",
      startedAt: new Date(startedAt),
    });
    for (const contract of FAILURE_RECOVERY_SCENARIOS) {
      report.scenarios[contract.id] = passedObservation(contract);
    }
    finalizeFailureRecoveryEvidence(report, new Date(completedAt));

    expect(validateFailureRecoveryEvidence(report, { requirePass: true })).toBe(report);
    expect(report.status).toBe("passed");
  });

  it("rejects unobserved faults, duplicates, missing alerts, and incomplete recovery", () => {
    const contract = FAILURE_RECOVERY_SCENARIOS[0];
    const baseline = passedObservation(contract);

    expect(() =>
      validateFailureRecoveryScenario(
        {
          ...baseline,
          faultInjection: { ...baseline.faultInjection, observed: false },
        },
        contract,
      ),
    ).toThrow("fault-injection");
    expect(() =>
      validateFailureRecoveryScenario(
        {
          ...baseline,
          assertions: {
            ...baseline.assertions,
            noDuplicates: { ...baseline.assertions.noDuplicates, duplicateCount: 1 },
          },
        },
        contract,
      ),
    ).toThrow("retry/no-duplicate");
    expect(() =>
      validateFailureRecoveryScenario(
        {
          ...baseline,
          assertions: {
            ...baseline.assertions,
            alert: { ...baseline.assertions.alert, rules: [] },
          },
        },
        contract,
      ),
    ).toThrow("required alert");
    expect(() =>
      validateFailureRecoveryScenario(
        {
          ...baseline,
          assertions: {
            ...baseline.assertions,
            recovery: { ...baseline.assertions.recovery, healthy: false },
          },
        },
        contract,
      ),
    ).toThrow("recover to healthy");
  });

  it("rejects secret-bearing fields and a falsely promoted static report", () => {
    const staticReport = createStaticFailureRecoveryEvidence();
    staticReport.status = "passed";
    expect(() => validateFailureRecoveryEvidence(staticReport)).toThrow(
      "cannot claim live execution",
    );

    const report = createStaticFailureRecoveryEvidence();
    report.scenarios[FAILURE_RECOVERY_SCENARIOS[0].id].accessToken = "must-not-persist";
    expect(() => validateFailureRecoveryEvidence(report)).toThrow(
      "sensitive failure/recovery evidence field",
    );
  });

  it("keeps the unresolved low-space alert gap explicit", async () => {
    const rules = await readFile(
      resolve(
        import.meta.dirname,
        "../observability/prometheus/rules/helix-workspace-operations.yml",
      ),
      "utf8",
    );
    const expectedRules = new Set(FAILURE_RECOVERY_SCENARIOS.flatMap(({ alerts }) => alerts));
    const missing = [...expectedRules].filter((rule) => !rules.includes(`alert: ${rule}`));

    expect(missing).toEqual(["HelixNodeFilesystemLowSpace"]);
  });
});

describe("opt-in V4 failure/recovery runner", () => {
  it("does not invoke a harness in static mode", async () => {
    const runHarness = vi.fn();
    const report = await runFailureRecoveryEvidence(
      { mode: "static" },
      { runHarness, now: () => new Date(startedAt) },
    );
    expect(report.status).toBe("not_run");
    expect(runHarness).not.toHaveBeenCalled();
  });

  it("refuses live faults without both the CLI opt-in and disposable acknowledgement", async () => {
    await expect(
      runFailureRecoveryEvidence(
        {
          mode: "live",
          allowFaultInjection: false,
          environment: liveEnvironment(),
        },
        { stat: fakeFileStat },
      ),
    ).rejects.toThrow("--allow-fault-injection");

    await expect(
      runFailureRecoveryEvidence(
        {
          mode: "live",
          allowFaultInjection: true,
          environment: { ...liveEnvironment(), HELIX_FAILURE_RECOVERY_ACK: "no" },
        },
        { stat: fakeFileStat },
      ),
    ).rejects.toThrow("acknowledgement");
  });

  it("runs every scenario and validates harness observations before passing", async () => {
    const runHarness = vi.fn(async ({ contract }) => passedObservation(contract));
    const clock = [new Date(startedAt), new Date(completedAt)];
    const report = await runFailureRecoveryEvidence(
      {
        mode: "live",
        allowFaultInjection: true,
        environment: liveEnvironment(),
      },
      {
        stat: fakeFileStat,
        runHarness,
        now: () => clock.shift() ?? new Date(completedAt),
      },
    );

    expect(report.status).toBe("passed");
    expect(runHarness).toHaveBeenCalledTimes(9);
    expect(validateFailureRecoveryEvidence(report, { requirePass: true })).toBe(report);
  });

  it("records a safe failed result instead of promoting invalid harness output", async () => {
    const runHarness = vi.fn(async ({ contract }) =>
      contract.id === FAILURE_RECOVERY_SCENARIOS[3].id
        ? { status: "passed" }
        : passedObservation(contract),
    );
    const report = await runFailureRecoveryEvidence(
      {
        mode: "live",
        allowFaultInjection: true,
        environment: liveEnvironment(),
      },
      { stat: fakeFileStat, runHarness },
    );

    expect(report.status).toBe("failed");
    expect(report.scenarios[FAILURE_RECOVERY_SCENARIOS[3].id]).toEqual({
      status: "failed",
      reasonCode: "harness_contract_or_execution_failed",
    });
    expect(() => validateFailureRecoveryEvidence(report, { requirePass: true })).toThrow(
      "not release-ready",
    );
  });
});

function passedObservation(contract) {
  const evidence = (source, suffix) => ({
    source,
    observedAt: recoveredAt,
    ref: `v4/${contract.id}/${suffix}`,
  });
  return {
    schema: FAILURE_RECOVERY_OBSERVATION_SCHEMA,
    scenarioId: contract.id,
    status: "passed",
    startedAt,
    faultInjectedAt,
    recoveredAt,
    completedAt,
    faultInjection: {
      method: contract.faultMethod,
      count: contract.faultCount,
      observed: true,
    },
    assertions: {
      userBehavior: {
        status: "passed",
        code: contract.userBehavior,
        evidence: [evidence("api", "user-behavior")],
      },
      noDuplicates: {
        status: "passed",
        code: contract.noDuplicates,
        logicalOperationCount: contract.minLogicalOperations,
        attemptCount: contract.minLogicalOperations + contract.faultCount,
        sideEffectCount:
          contract.id === "audit_destination_failure" ||
          contract.id === "provider_agent_credential_expiry"
            ? 0
            : contract.minLogicalOperations,
        distinctIdempotencyKeyCount: contract.minLogicalOperations,
        duplicateCount: 0,
        evidence: [evidence("database", "dedupe-query")],
      },
      alert: {
        status: "passed",
        rules: [...contract.alerts],
        firedAt: recoveredAt,
        resourceId: `scenario:${contract.id}`,
        evidence: [evidence("alertmanager", "alert")],
      },
      recovery: {
        status: "passed",
        code: contract.recovery,
        healthy: true,
        evidence: [evidence("metric", "recovery")],
      },
    },
  };
}

function liveEnvironment() {
  return {
    HELIX_FAILURE_RECOVERY_ACK: "I_ACKNOWLEDGE_DISPOSABLE_FAULT_INJECTION",
    HELIX_FAILURE_RECOVERY_ENVIRONMENT_CLASS: "disposable",
    HELIX_FAILURE_RECOVERY_ENVIRONMENT_ID: "disposable-v4-fixture",
    HELIX_FAILURE_RECOVERY_HARNESS: "/tmp/helix-v4-harness.mjs",
  };
}

function fakeFileStat() {
  return Promise.resolve({ isFile: () => true });
}
