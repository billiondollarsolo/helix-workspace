import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DATA_PLANE_EVIDENCE_SCHEMA,
  DATA_PLANE_SCENARIOS,
  assertNoSensitiveEvidence,
  createDataPlaneEvidenceSkeleton,
  validateDataPlaneEvidence,
} from "./data-plane-live-evidence.mjs";

const execFileAsync = promisify(execFile);

describe("data-plane live evidence contract", () => {
  it("represents every scenario as explicitly not run in static mode", () => {
    const evidence = validateDataPlaneEvidence(
      createDataPlaneEvidenceSkeleton(new Date("2026-07-28T12:00:00.000Z")),
    );
    expect(evidence.schema).toBe(DATA_PLANE_EVIDENCE_SCHEMA);
    expect(Object.keys(evidence.scenarios)).toEqual(DATA_PLANE_SCENARIOS);
    expect(Object.values(evidence.scenarios).every((result) => result.status === "not_run")).toBe(
      true,
    );
  });

  it("requires every live scenario to pass when used as release evidence", () => {
    const evidence = createDataPlaneEvidenceSkeleton();
    expect(() => validateDataPlaneEvidence(evidence, true)).toThrow(
      "required data-plane evidence did not pass",
    );
    evidence.mode = "local";
    evidence.status = "passed";
    for (const scenario of DATA_PLANE_SCENARIOS) {
      evidence.scenarios[scenario] = { status: "passed", durationMs: 1 };
    }
    expect(() => validateDataPlaneEvidence(evidence, true)).not.toThrow();
  });

  it("rejects static promotion, failed/incomplete runs, and extra scenarios", () => {
    const staticPromotion = createDataPlaneEvidenceSkeleton();
    staticPromotion.status = "passed";
    for (const scenario of DATA_PLANE_SCENARIOS) {
      staticPromotion.scenarios[scenario] = { status: "passed", durationMs: 1 };
    }
    expect(() => validateDataPlaneEvidence(staticPromotion, true)).toThrow(
      "static data-plane evidence cannot claim live execution",
    );

    const failed = createDataPlaneEvidenceSkeleton();
    failed.mode = "local";
    failed.status = "failed";
    expect(() => validateDataPlaneEvidence(failed, true)).toThrow(
      "required data-plane evidence did not pass",
    );

    const extra = createDataPlaneEvidenceSkeleton();
    extra.scenarios.unreviewed = { status: "passed", durationMs: 1 };
    expect(() => validateDataPlaneEvidence(extra)).toThrow("every scenario exactly once");
  });

  it("rejects sensitive fields from evidence", () => {
    for (const unsafe of [
      { password: "value" },
      { clientCertificate: "pem" },
      { connectionUrl: "value" },
      { accessToken: "value" },
    ]) {
      expect(() => assertNoSensitiveEvidence({ result: unsafe })).toThrow(
        "sensitive data-plane evidence field is forbidden",
      );
    }
  });

  it("emits truthful static evidence without passed claims", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["infra/scripts/data-plane-live-evidence.mjs", "--static"],
      { cwd: process.cwd() },
    );
    const evidence = JSON.parse(stdout);
    expect(() => validateDataPlaneEvidence(evidence)).not.toThrow();
    expect(evidence.status).toBe("static_validated");
    expect(stdout).not.toMatch(/"status":\s*"passed"/u);
  });
});
