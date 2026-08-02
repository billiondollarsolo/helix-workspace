#!/usr/bin/env node
/**
 * RPO/RTO gate helper for Ops O4 / O-D.13 / O-K.16.
 *
 * Modes:
 *   --backup-dir <path>   Evaluate newest helix.backup-manifest.v3 (or sidecar)
 *                         age against --rpo-hours (ADR-0006 Business default: 24).
 *   --evidence <path>     Validate restore-drill evidence metrics against
 *                         --rpo-hours / --rto-hours (defaults 24 / 4).
 *   --print-contract      Emit the engineering contract JSON and exit 0.
 *
 * Safe by default: never modifies backups or production data. Exit 1 on gate fail
 * when --require-pass is set (or always for failed evidence status when required).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const RPO_RTO_CONTRACT_SCHEMA = "helix.rpo-rto-contract.v1";
export const BACKUP_MANIFEST_SCHEMA = "helix.backup-manifest.v3";
export const RESTORE_DRILL_EVIDENCE_SCHEMA = "helix.restore-drill-evidence.v1";

/** Business pilot targets from ADR-0006 (engineering objectives, not SLA). */
export const DEFAULT_RPO_HOURS = 24;
export const DEFAULT_RTO_HOURS = 4;

const usage = `Usage:
  infra/scripts/rpo-rto-check.mjs --print-contract
  infra/scripts/rpo-rto-check.mjs --backup-dir <path> [--rpo-hours 24] [--require-pass]
  infra/scripts/rpo-rto-check.mjs --evidence <path> [--rpo-hours 24] [--rto-hours 4] [--require-pass]
`;

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await runCheck(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.requirePass && report.status !== "passed") {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `rpo-rto-check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

export function engineeringContract() {
  return {
    schema: RPO_RTO_CONTRACT_SCHEMA,
    source: "docs/architecture/adr-0006-business-pilot-recovery-targets.md",
    documentation: "docs/architecture/ha-rpo-rto.md",
    availabilityObjectiveMonthly: 0.995,
    rpoTargetHours: DEFAULT_RPO_HOURS,
    rtoTargetHours: DEFAULT_RTO_HOURS,
    contractualSla: false,
    multiRegionHaClaimed: false,
    measurement: {
      rpo: "drill_started_at - manifest.recoverySet.databaseCapturedAt (hours)",
      rto: "drill_completed_at - drill_started_at (hours)",
    },
    tools: {
      backupAgeGate: "infra/scripts/rpo-rto-check.mjs --backup-dir",
      evidenceGate: "infra/scripts/rpo-rto-check.mjs --evidence",
      restoreDrill: "infra/scripts/restore-drill.sh",
      evidenceWriter: "infra/scripts/restore-drill-evidence.mjs",
    },
  };
}

export function parseArgs(argv) {
  const options = {
    mode: undefined,
    backupDir: undefined,
    evidencePath: undefined,
    rpoHours: DEFAULT_RPO_HOURS,
    rtoHours: DEFAULT_RTO_HOURS,
    requirePass: false,
    now: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--print-contract":
        options.mode = "contract";
        break;
      case "--backup-dir":
        options.mode = "backup-age";
        options.backupDir = requiredValue(argv, i, arg);
        i += 1;
        break;
      case "--evidence":
        options.mode = "evidence";
        options.evidencePath = requiredValue(argv, i, arg);
        i += 1;
        break;
      case "--rpo-hours":
        options.rpoHours = positiveNumber(requiredValue(argv, i, arg), "rpo hours");
        i += 1;
        break;
      case "--rto-hours":
        options.rtoHours = positiveNumber(requiredValue(argv, i, arg), "rto hours");
        i += 1;
        break;
      case "--require-pass":
        options.requirePass = true;
        break;
      case "--now":
        options.now = requiredValue(argv, i, arg);
        i += 1;
        break;
      case "-h":
      case "--help":
        process.stdout.write(usage);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}\n${usage}`);
    }
  }
  if (options.mode === undefined) {
    throw new Error(`mode required\n${usage}`);
  }
  return options;
}

export async function runCheck(options) {
  if (options.mode === "contract") {
    return { status: "passed", contract: engineeringContract() };
  }
  if (options.mode === "backup-age") {
    return evaluateBackupAge({
      backupDir: options.backupDir,
      rpoHours: options.rpoHours,
      now: options.now ? new Date(options.now) : new Date(),
    });
  }
  if (options.mode === "evidence") {
    const raw = await readFile(resolve(options.evidencePath), "utf8");
    const evidence = JSON.parse(raw);
    return evaluateEvidence(evidence, {
      rpoHours: options.rpoHours,
      rtoHours: options.rtoHours,
    });
  }
  throw new Error(`unsupported mode: ${String(options.mode)}`);
}

export async function evaluateBackupAge({ backupDir, rpoHours, now = new Date() }) {
  const dir = resolve(backupDir);
  const candidates = await findManifestCandidates(dir);
  if (candidates.length === 0) {
    return {
      status: "failed",
      mode: "backup-age",
      message: `no backup manifests found under ${dir}`,
      rpoTargetHours: rpoHours,
      newest: null,
    };
  }

  let newest = null;
  for (const candidate of candidates) {
    const ageHours = elapsedHours(candidate.recoveryPoint, now);
    if (newest === null || candidate.recoveryPoint > newest.recoveryPoint) {
      newest = {
        path: candidate.path,
        recoveryPoint: candidate.recoveryPoint.toISOString(),
        backupId: candidate.backupId,
        tier: candidate.tier,
        ageHours,
      };
    }
  }

  const withinRpo = newest.ageHours <= rpoHours;
  return {
    status: withinRpo ? "passed" : "failed",
    mode: "backup-age",
    rpoTargetHours: rpoHours,
    evaluatedAt: now.toISOString(),
    newest,
    message: withinRpo
      ? `newest recovery point is ${newest.ageHours.toFixed(2)}h old (≤ ${rpoHours}h RPO)`
      : `newest recovery point is ${newest.ageHours.toFixed(2)}h old (exceeds ${rpoHours}h RPO)`,
  };
}

export function evaluateEvidence(evidence, { rpoHours = DEFAULT_RPO_HOURS, rtoHours = DEFAULT_RTO_HOURS }) {
  if (evidence?.schema !== RESTORE_DRILL_EVIDENCE_SCHEMA) {
    throw new Error(`unexpected evidence schema: ${String(evidence?.schema)}`);
  }

  const metrics = evidence.metrics ?? {};
  const observedRpo = metrics.rpoHours;
  const observedRto = metrics.rtoHours;
  const rpoTarget = Number(metrics.rpoTargetHours ?? rpoHours);
  const rtoTarget = Number(metrics.rtoTargetHours ?? rtoHours);

  if (evidence.mode === "static") {
    return {
      status: "failed",
      mode: "evidence",
      message: "static restore-drill evidence is not release RPO/RTO proof",
      evidenceStatus: evidence.status,
      rpo: { observedHours: observedRpo, targetHours: rpoTarget, status: "not_run" },
      rto: { observedHours: observedRto, targetHours: rtoTarget, status: "not_run" },
    };
  }

  const rpoScenario = evidence.scenarios?.rpo;
  const rtoScenario = evidence.scenarios?.rto;
  const rpoOk =
    typeof observedRpo === "number" &&
    Number.isFinite(observedRpo) &&
    observedRpo <= rpoHours &&
    rpoScenario?.status === "passed";
  const rtoOk =
    typeof observedRto === "number" &&
    Number.isFinite(observedRto) &&
    observedRto <= rtoHours &&
    rtoScenario?.status === "passed";
  const overallPassed = evidence.status === "passed" && rpoOk && rtoOk;

  return {
    status: overallPassed ? "passed" : "failed",
    mode: "evidence",
    evidenceStatus: evidence.status,
    rpo: {
      observedHours: observedRpo,
      targetHours: rpoHours,
      status: rpoOk ? "passed" : "failed",
      scenarioStatus: rpoScenario?.status ?? "missing",
    },
    rto: {
      observedHours: observedRto,
      targetHours: rtoHours,
      status: rtoOk ? "passed" : "failed",
      scenarioStatus: rtoScenario?.status ?? "missing",
    },
    message: overallPassed
      ? `live evidence within RPO ≤ ${rpoHours}h and RTO ≤ ${rtoHours}h`
      : `live evidence failed RPO/RTO gate (rpo=${String(observedRpo)}, rto=${String(observedRto)}, evidence=${evidence.status})`,
  };
}

async function findManifestCandidates(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findManifestCandidates(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!(entry.name === "manifest.json" || entry.name.endsWith(".manifest.json"))) {
      continue;
    }
    try {
      const raw = await readFile(full, "utf8");
      const manifest = JSON.parse(raw);
      if (manifest?.schema !== BACKUP_MANIFEST_SCHEMA) continue;
      const recoveryPointRaw =
        manifest.recoverySet?.databaseCapturedAt ?? manifest.databaseCapturedAt ?? manifest.createdAt;
      if (typeof recoveryPointRaw !== "string") continue;
      const recoveryPoint = new Date(recoveryPointRaw);
      if (Number.isNaN(recoveryPoint.getTime())) continue;
      out.push({
        path: full,
        recoveryPoint,
        backupId: String(manifest.backupId ?? "unknown"),
        tier: String(manifest.tier ?? "unknown"),
      });
    } catch {
      // Skip unreadable or non-JSON sidecars; gate fails only if none parse.
    }
  }

  // Also accept a top-level directory that is itself empty of nested files but
  // may only contain archives: fall back to mtime of *.manifest.json already handled.
  if (out.length === 0) {
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".sha256") && !entry.name.endsWith(".tar.gz")) continue;
      // No recovery point without a manifest — skip.
    }
  }

  // Touch dir to ensure it exists (throws if not).
  await stat(dir);
  return out;
}

function elapsedHours(from, to) {
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("invalid time interval for RPO age calculation");
  }
  return ms / (1000 * 60 * 60);
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function positiveNumber(raw, label) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return n;
}

function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}
