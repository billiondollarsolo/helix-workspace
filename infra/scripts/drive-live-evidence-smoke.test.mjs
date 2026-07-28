import assert from "node:assert/strict";
import test from "node:test";
import {
  DRIVE_EVIDENCE_CASES,
  DRIVE_EVIDENCE_SCHEMA_VERSION,
  assertNoSensitiveDriveEvidence,
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

test("strict validation requires a timed live pass with case-specific measurements", () => {
  const report = passedDriveEvidence();
  assert.doesNotThrow(() => validateDriveEvidence(report, { requirePass: true }));

  assert.throws(
    () => validateDriveEvidence({ ...report, schemaVersion: 1 }, { requirePass: true }),
    /unsupported schema/u,
  );

  const staticPromotion = clone(report);
  staticPromotion.mode = "not_run";
  delete staticPromotion.startedAt;
  delete staticPromotion.completedAt;
  delete staticPromotion.durationMs;
  assert.throws(() => validateDriveEvidence(staticPromotion), /cannot claim live execution/u);

  const failed = clone(report);
  failed.cases[0] = {
    name: failed.cases[0].name,
    status: "fail",
    evidence: [],
    reason: "scan_failed",
  };
  failed.status = "failed";
  assert.throws(() => validateDriveEvidence(failed, { requirePass: true }), /incomplete/u);

  const timingMismatch = clone(report);
  timingMismatch.cases[0].durationMs += 1;
  assert.throws(() => validateDriveEvidence(timingMismatch), /inconsistent timing/u);

  const unexpectedContent = clone(report);
  unexpectedContent.cases[0].note = "arbitrary content must not enter release evidence";
  assert.throws(() => validateDriveEvidence(unexpectedContent), /unexpected or missing fields/u);

  const partialDenial = clone(report);
  partialDenial.cases[1].metrics.deniedSurfaces = 2;
  assert.throws(() => validateDriveEvidence(partialDenial), /deny every retrieval surface/u);

  const unbounded = clone(report);
  unbounded.cases[3].metrics.peakRssGrowthBytes = unbounded.cases[3].metrics.memoryBoundBytes + 1;
  assert.throws(() => validateDriveEvidence(unbounded), /exceeded its memory bound/u);
});

test("Drive evidence rejects sensitive fields", () => {
  assert.throws(
    () => assertNoSensitiveDriveEvidence({ result: { accessToken: "never-persist" } }),
    /sensitive Drive evidence field/u,
  );
});

function passedDriveEvidence() {
  const startedAt = "2026-07-28T20:00:00.000Z";
  const completedAt = "2026-07-28T20:00:01.000Z";
  const metrics = {
    clean_upload_hash: { uploadBytes: 12, scanLatencyMs: 10, hashMatched: true },
    eicar_denied: {
      retrievalSurfacesChecked: 4,
      deniedSurfaces: 4,
      scanLatencyMs: 12,
    },
    multipart_sse: {
      uploadBytes: 12,
      partCount: 2,
      serverSideEncryptionVerified: true,
    },
    gib_bounded_memory: {
      uploadBytes: 1024 ** 3,
      peakRssGrowthBytes: 1024,
      memoryBoundBytes: 2048,
      withinMemoryBound: true,
    },
    webdav_quarantine: {
      retrievalSurfacesChecked: 3,
      deniedSurfaces: 3,
      lockCycleVerified: true,
    },
    share_revoke: {
      revokeLatencyMs: 5,
      revokedAccessDenied: true,
      expirationVerified: true,
    },
    restart_recovery: { restartsObserved: 3, recoveryMs: 20, hashMatched: true },
    backup_restore: { restoredFiles: 2, restoredVersions: 3, hashMatched: true },
  };
  return {
    schemaVersion: DRIVE_EVIDENCE_SCHEMA_VERSION,
    generatedAt: completedAt,
    mode: "live",
    status: "passed",
    startedAt,
    completedAt,
    durationMs: 1_000,
    cases: DRIVE_EVIDENCE_CASES.map((name) => ({
      name,
      status: "pass",
      startedAt,
      completedAt,
      durationMs: 1_000,
      metrics: metrics[name],
      evidence: [{ source: "metric", ref: `drive/${name}`, observedAt: completedAt }],
    })),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
