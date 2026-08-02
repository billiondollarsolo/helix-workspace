import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RPO_HOURS,
  DEFAULT_RTO_HOURS,
  engineeringContract,
  evaluateBackupAge,
  evaluateEvidence,
  parseArgs,
  RESTORE_DRILL_EVIDENCE_SCHEMA,
} from "./rpo-rto-check.mjs";

const cleanup = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("rpo-rto-check", () => {
  it("exposes ADR-0006 engineering contract", () => {
    const contract = engineeringContract();
    expect(contract.rpoTargetHours).toBe(DEFAULT_RPO_HOURS);
    expect(contract.rtoTargetHours).toBe(DEFAULT_RTO_HOURS);
    expect(contract.contractualSla).toBe(false);
    expect(contract.multiRegionHaClaimed).toBe(false);
    expect(contract.availabilityObjectiveMonthly).toBe(0.995);
  });

  it("parses backup-age and evidence modes", () => {
    expect(parseArgs(["--print-contract"]).mode).toBe("contract");
    expect(parseArgs(["--backup-dir", "./backups", "--rpo-hours", "12"])).toMatchObject({
      mode: "backup-age",
      backupDir: "./backups",
      rpoHours: 12,
    });
    expect(parseArgs(["--evidence", "e.json", "--require-pass"])).toMatchObject({
      mode: "evidence",
      evidencePath: "e.json",
      requirePass: true,
    });
  });

  it("passes when newest recovery point is within RPO", async () => {
    const dir = join(tmpdir(), `helix-rpo-${Date.now()}`);
    cleanup.push(dir);
    await mkdir(dir, { recursive: true });
    const recoveryPoint = new Date("2026-08-02T12:00:00.000Z");
    await writeFile(
      join(dir, "sample.manifest.json"),
      JSON.stringify({
        schema: "helix.backup-manifest.v3",
        backupId: "b1",
        tier: "business",
        createdAt: recoveryPoint.toISOString(),
        recoverySet: {
          id: "a".repeat(64),
          databaseCapturedAt: recoveryPoint.toISOString(),
          objectsCapturedAt: recoveryPoint.toISOString(),
        },
      }),
      "utf8",
    );

    const report = await evaluateBackupAge({
      backupDir: dir,
      rpoHours: 24,
      now: new Date("2026-08-02T20:00:00.000Z"),
    });
    expect(report.status).toBe("passed");
    expect(report.newest.ageHours).toBe(8);
  });

  it("fails when newest recovery point exceeds RPO", async () => {
    const dir = join(tmpdir(), `helix-rpo-stale-${Date.now()}`);
    cleanup.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schema: "helix.backup-manifest.v3",
        backupId: "stale",
        tier: "business",
        recoverySet: {
          id: "b".repeat(64),
          databaseCapturedAt: "2026-08-01T00:00:00.000Z",
          objectsCapturedAt: "2026-08-01T00:00:00.000Z",
        },
      }),
      "utf8",
    );

    const report = await evaluateBackupAge({
      backupDir: dir,
      rpoHours: 24,
      now: new Date("2026-08-02T12:00:00.000Z"),
    });
    expect(report.status).toBe("failed");
    expect(report.newest.ageHours).toBe(36);
  });

  it("rejects static evidence as release proof", () => {
    const report = evaluateEvidence(
      {
        schema: RESTORE_DRILL_EVIDENCE_SCHEMA,
        mode: "static",
        status: "static_validated",
        metrics: { rpoHours: null, rtoHours: null, rpoTargetHours: 24, rtoTargetHours: 4 },
        scenarios: {
          rpo: { status: "not_run" },
          rto: { status: "not_run" },
        },
      },
      {},
    );
    expect(report.status).toBe("failed");
    expect(report.message).toMatch(/static/i);
  });

  it("passes live evidence within RPO and RTO targets", () => {
    const report = evaluateEvidence(
      {
        schema: RESTORE_DRILL_EVIDENCE_SCHEMA,
        mode: "live",
        status: "passed",
        metrics: { rpoHours: 6, rtoHours: 1.5, rpoTargetHours: 24, rtoTargetHours: 4 },
        scenarios: {
          rpo: { status: "passed", observedHours: 6, targetHours: 24 },
          rto: { status: "passed", observedHours: 1.5, targetHours: 4 },
        },
      },
      { rpoHours: 24, rtoHours: 4 },
    );
    expect(report.status).toBe("passed");
    expect(report.rpo.status).toBe("passed");
    expect(report.rto.status).toBe("passed");
  });

  it("fails live evidence when RTO exceeds target", () => {
    const report = evaluateEvidence(
      {
        schema: RESTORE_DRILL_EVIDENCE_SCHEMA,
        mode: "live",
        status: "passed",
        metrics: { rpoHours: 2, rtoHours: 5, rpoTargetHours: 24, rtoTargetHours: 4 },
        scenarios: {
          rpo: { status: "passed" },
          rto: { status: "passed" },
        },
      },
      { rpoHours: 24, rtoHours: 4 },
    );
    expect(report.status).toBe("failed");
    expect(report.rto.status).toBe("failed");
  });
});
