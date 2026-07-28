import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DRIVE_EVIDENCE_CASES = [
  "clean_upload_hash",
  "eicar_denied",
  "multipart_sse",
  "gib_bounded_memory",
  "webdav_quarantine",
  "share_revoke",
  "restart_recovery",
  "backup_restore",
];

export function notRunDriveEvidence(now = new Date()) {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mode: "not_run",
    cases: DRIVE_EVIDENCE_CASES.map((name) => ({
      name,
      status: "not_run",
      evidence: [],
      reason:
        "Live Drive evidence requires provisioned PostgreSQL, object storage, ClamAV, and TLS.",
    })),
  };
}

export function validateDriveEvidence(report, { requirePass = false } = {}) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Drive evidence report must be an object.");
  }
  if (report.schemaVersion !== 1 || typeof report.generatedAt !== "string") {
    throw new Error("Drive evidence report has an unsupported schema.");
  }
  if (!Array.isArray(report.cases) || report.cases.length !== DRIVE_EVIDENCE_CASES.length) {
    throw new Error("Drive evidence report must contain every required case exactly once.");
  }
  const names = report.cases.map((entry) => entry?.name);
  if (
    new Set(names).size !== names.length ||
    DRIVE_EVIDENCE_CASES.some((name) => !names.includes(name))
  ) {
    throw new Error("Drive evidence report case names are incomplete or duplicated.");
  }
  for (const entry of report.cases) {
    if (!["pass", "fail", "not_run"].includes(entry.status) || !Array.isArray(entry.evidence)) {
      throw new Error(
        `Drive evidence case '${String(entry.name)}' has an invalid status or evidence.`,
      );
    }
    if (entry.status === "pass" && entry.evidence.length === 0) {
      throw new Error(`Drive evidence case '${entry.name}' cannot pass without evidence.`);
    }
    if (entry.status !== "pass" && typeof entry.reason !== "string") {
      throw new Error(`Drive evidence case '${entry.name}' requires a reason.`);
    }
    if (requirePass && entry.status !== "pass") {
      throw new Error(`Drive live evidence is incomplete: '${entry.name}' is ${entry.status}.`);
    }
  }
  return report;
}

async function main(argv) {
  const reportPath = argv[0];
  if (reportPath === undefined) {
    process.stdout.write(`${JSON.stringify(notRunDriveEvidence(), null, 2)}\n`);
    return;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  validateDriveEvidence(report, { requirePass: argv.includes("--require-pass") });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
