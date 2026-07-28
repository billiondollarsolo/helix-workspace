import { readFile } from "node:fs/promises";
import process from "node:process";
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
export const DRIVE_EVIDENCE_SCHEMA_VERSION = 2;

const DRIVE_EVIDENCE_SOURCES = new Set([
  "api",
  "backup",
  "browser",
  "clamav",
  "database",
  "metric",
  "object_store",
  "process",
  "restore",
  "webdav",
]);
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,255}$/u;
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|body|cookie|credential|email|filename|key|password|prompt|raw|secret|subject|token|url)$/iu;

export function notRunDriveEvidence(now = new Date()) {
  return {
    schemaVersion: DRIVE_EVIDENCE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    mode: "not_run",
    status: "not_run",
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
  if (report.schemaVersion !== DRIVE_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("Drive evidence report has an unsupported schema.");
  }
  requireExactKeys(
    report,
    report.mode === "live"
      ? [
          "schemaVersion",
          "generatedAt",
          "mode",
          "status",
          "startedAt",
          "completedAt",
          "durationMs",
          "cases",
        ]
      : ["schemaVersion", "generatedAt", "mode", "status", "cases"],
    "Drive evidence report",
  );
  requireTimestamp(report.generatedAt, "Drive evidence generatedAt");
  if (!["not_run", "live"].includes(report.mode)) {
    throw new Error("Drive evidence mode must be not_run or live.");
  }
  if (!["not_run", "passed", "failed"].includes(report.status)) {
    throw new Error("Drive evidence status must be not_run, passed, or failed.");
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
    if (entry.status === "pass") {
      requireExactKeys(
        entry,
        ["name", "status", "startedAt", "completedAt", "durationMs", "metrics", "evidence"],
        `Drive evidence case '${entry.name}'`,
      );
      validatePassedCase(entry);
    } else if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      throw new Error(`Drive evidence case '${entry.name}' requires a reason.`);
    } else {
      requireExactKeys(
        entry,
        ["name", "status", "evidence", "reason"],
        `Drive evidence case '${entry.name}'`,
      );
    }
  }
  const passed = report.cases.every(({ status }) => status === "pass");
  if (report.mode === "not_run") {
    if (report.status !== "not_run" || report.cases.some(({ status }) => status !== "not_run")) {
      throw new Error("not-run Drive evidence cannot claim live execution.");
    }
  } else {
    const startedAt = requireTimestamp(report.startedAt, "Drive live evidence startedAt");
    const completedAt = requireTimestamp(report.completedAt, "Drive live evidence completedAt");
    if (completedAt < startedAt) {
      throw new Error("Drive live evidence timestamps are out of order.");
    }
    if (report.durationMs !== completedAt - startedAt) {
      throw new Error("Drive live evidence duration does not match its timestamps.");
    }
    const derivedStatus = passed ? "passed" : "failed";
    if (report.status !== derivedStatus) {
      throw new Error(`Drive live evidence status must be ${derivedStatus}.`);
    }
  }
  if (requirePass && (report.mode !== "live" || report.status !== "passed" || !passed)) {
    const incomplete = report.cases
      .filter(({ status }) => status !== "pass")
      .map(({ name, status }) => `'${name}' is ${status}`);
    throw new Error(
      `Drive live evidence is incomplete: ${incomplete.join(", ") || String(report.status)}.`,
    );
  }
  assertNoSensitiveDriveEvidence(report);
  return report;
}

export function assertNoSensitiveDriveEvidence(report) {
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${String(index)}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw new Error(`sensitive Drive evidence field is forbidden: ${path}.${key}`);
      }
      visit(entry, `${path}.${key}`);
    }
  };
  visit(report, "$");
}

function validatePassedCase(entry) {
  const startedAt = requireTimestamp(entry.startedAt, `${entry.name} startedAt`);
  const completedAt = requireTimestamp(entry.completedAt, `${entry.name} completedAt`);
  if (completedAt < startedAt || entry.durationMs !== completedAt - startedAt) {
    throw new Error(`Drive evidence case '${entry.name}' has inconsistent timing.`);
  }
  for (const item of entry.evidence) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !DRIVE_EVIDENCE_SOURCES.has(item.source) ||
      typeof item.ref !== "string" ||
      !SAFE_REFERENCE.test(item.ref)
    ) {
      throw new Error(
        `Drive evidence case '${entry.name}' contains an invalid evidence reference.`,
      );
    }
    requireExactKeys(item, ["source", "ref", "observedAt"], `${entry.name} evidence reference`);
    requireTimestamp(item.observedAt, `${entry.name} evidence observedAt`);
  }
  validateMetrics(entry.name, entry.metrics);
}

function validateMetrics(name, metrics) {
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error(`Drive evidence case '${name}' requires measured metrics.`);
  }
  const validators = DRIVE_METRIC_VALIDATORS[name];
  if (
    validators === undefined ||
    Object.keys(metrics).length !== Object.keys(validators).length ||
    Object.entries(validators).some(([key, validate]) => !validate(metrics[key]))
  ) {
    throw new Error(`Drive evidence case '${name}' has incomplete or invalid measured metrics.`);
  }
  if (
    ["eicar_denied", "webdav_quarantine"].includes(name) &&
    metrics.deniedSurfaces !== metrics.retrievalSurfacesChecked
  ) {
    throw new Error(`Drive evidence case '${name}' did not deny every retrieval surface.`);
  }
  if (name === "gib_bounded_memory" && metrics.peakRssGrowthBytes > metrics.memoryBoundBytes) {
    throw new Error("Drive evidence case 'gib_bounded_memory' exceeded its memory bound.");
  }
}

const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const trueValue = (value) => value === true;
const oneGiB = 1024 ** 3;

const DRIVE_METRIC_VALIDATORS = {
  clean_upload_hash: {
    uploadBytes: positiveInteger,
    scanLatencyMs: nonnegative,
    hashMatched: trueValue,
  },
  eicar_denied: {
    retrievalSurfacesChecked: positiveInteger,
    deniedSurfaces: positiveInteger,
    scanLatencyMs: nonnegative,
  },
  multipart_sse: {
    uploadBytes: positiveInteger,
    partCount: (value) => Number.isSafeInteger(value) && value >= 2,
    serverSideEncryptionVerified: trueValue,
  },
  gib_bounded_memory: {
    uploadBytes: (value) => Number.isSafeInteger(value) && value >= oneGiB,
    peakRssGrowthBytes: nonnegative,
    memoryBoundBytes: positiveInteger,
    withinMemoryBound: trueValue,
  },
  webdav_quarantine: {
    retrievalSurfacesChecked: positiveInteger,
    deniedSurfaces: positiveInteger,
    lockCycleVerified: trueValue,
  },
  share_revoke: {
    revokeLatencyMs: nonnegative,
    revokedAccessDenied: trueValue,
    expirationVerified: trueValue,
  },
  restart_recovery: {
    restartsObserved: positiveInteger,
    recoveryMs: nonnegative,
    hashMatched: trueValue,
  },
  backup_restore: {
    restoredFiles: positiveInteger,
    restoredVersions: positiveInteger,
    hashMatched: trueValue,
  },
};

function requireTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp.`);
  }
  return milliseconds;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} contains unexpected or missing fields.`);
  }
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
