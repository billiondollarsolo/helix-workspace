import assert from "node:assert/strict";
import test from "node:test";
import {
  DRIVE_EVIDENCE_CASES,
  notRunDriveEvidence,
  validateDriveEvidence,
} from "./drive-live-evidence-smoke.mjs";

test("static Drive evidence is truthful and complete", () => {
  const report = notRunDriveEvidence(new Date("2026-07-28T00:00:00.000Z"));
  assert.equal(report.mode, "not_run");
  assert.deepEqual(
    report.cases.map((entry) => entry.name),
    DRIVE_EVIDENCE_CASES,
  );
  assert.ok(report.cases.every((entry) => entry.status === "not_run"));
  assert.doesNotThrow(() => validateDriveEvidence(report));
});

test("strict validation rejects missing, duplicate, and unevidenced pass cases", () => {
  const report = notRunDriveEvidence();
  assert.throws(
    () => validateDriveEvidence({ ...report, cases: report.cases.slice(1) }),
    /every required case/u,
  );
  assert.throws(
    () =>
      validateDriveEvidence({
        ...report,
        cases: report.cases.map((entry, index) =>
          index === 0 ? { ...entry, status: "pass", evidence: [], reason: undefined } : entry,
        ),
      }),
    /cannot pass without evidence/u,
  );
  assert.throws(() => validateDriveEvidence(report, { requirePass: true }), /incomplete/u);
});
