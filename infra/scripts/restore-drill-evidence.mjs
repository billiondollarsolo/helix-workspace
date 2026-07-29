#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { BACKUP_MANIFEST_SCHEMA } from "./backup-manifest.mjs";
import {
  attachReleaseEvidenceBinding,
  releaseEvidenceBindingFromEnvironment,
  validateOptionalReleaseEvidenceBinding,
} from "./release-evidence-binding.mjs";

export const RESTORE_DRILL_EVIDENCE_SCHEMA = "helix.restore-drill-evidence.v1";
export const RESTORE_DRILL_SCENARIOS = [
  "manifest_integrity",
  "encrypted_restore",
  "off_host_retention_key_custody",
  "disposable_environment",
  "database_consistency",
  "object_version_consistency",
  "outbound_queue_consistency",
  "audit_chain",
  "sampled_corpus_hashes",
  "search_reindex",
  "rpo",
  "rto",
];
const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|authorization|cookie|credential|private.?key)/iu;

const usage = `Usage:
  infra/scripts/restore-drill-evidence.mjs --static [--output <path>]
  infra/scripts/restore-drill-evidence.mjs --live --manifest <path> [options]

Live evidence options:
  --started-at <ISO-8601>
  --completed-at <ISO-8601>
  --source-db <name>
  --target-db <name>
  --target-object-bucket <name>
  --manifest-integrity <passed|failed>
  --database-consistency <passed|failed>
  --object-version-consistency <passed|failed>
  --outbound-queue-consistency <passed|failed>
  --audit-chain <passed|failed>
  --sample-count <integer>
  --sample-matches <integer>
  --search-reindex <passed|failed|not_run>
  --output <path>
`;

if (isMain()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidence =
      options.mode === "static" ? createStaticEvidence() : await createLiveEvidence(options);
    attachReleaseEvidenceBinding(evidence, releaseEvidenceBindingFromEnvironment(process.env));
    validateRestoreDrillEvidence(evidence);
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    if (options.output !== undefined) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, serialized, "utf8");
    }
    process.stdout.write(serialized);
    if (options.requirePass && evidence.status !== "passed") {
      throw new Error(`strict live evidence did not pass: ${evidence.status}`);
    }
  } catch (error) {
    process.stderr.write(
      `restore drill evidence failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

export function createStaticEvidence(now = new Date()) {
  return {
    schema: RESTORE_DRILL_EVIDENCE_SCHEMA,
    runId: `static-${now.toISOString()}`,
    mode: "static",
    status: "static_validated",
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    metrics: { rpoHours: null, rtoHours: null, rpoTargetHours: 24, rtoTargetHours: 4 },
    scenarios: Object.fromEntries(
      RESTORE_DRILL_SCENARIOS.map((scenario) => [scenario, { status: "not_run" }]),
    ),
  };
}

export async function createLiveEvidence(options) {
  const manifestBytes = await readFile(options.manifest);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const startedAt = canonicalTimestamp(options.startedAt, "started at");
  const completedAt = canonicalTimestamp(options.completedAt, "completed at");
  const recoveryPoint = canonicalTimestamp(
    manifest.recoverySet?.databaseCapturedAt,
    "database recovery point",
  );
  const rpoHours = elapsedHours(recoveryPoint, startedAt, "RPO");
  const rtoHours = elapsedHours(startedAt, completedAt, "RTO");
  const manifestValid =
    options.manifestIntegrity === "passed" && manifest.schema === BACKUP_MANIFEST_SCHEMA;
  const encrypted = ["age", "kms"].includes(manifest.encryption?.method);
  const offHostContract =
    String(manifest.resilience?.offHostUri ?? "").startsWith("s3://") &&
    Number(manifest.resilience?.retentionDays ?? 0) > 0 &&
    String(manifest.encryption?.keyCustodyRef ?? "").length > 0 &&
    manifest.encryption?.plaintextKeyMaterialIncluded === false;
  const disposableDatabase =
    options.sourceDb.length > 0 &&
    options.targetDb.length > 0 &&
    options.sourceDb !== options.targetDb;
  const sourceObjectBucket = String(manifest.objects?.bucket ?? "");
  const disposableObjects =
    manifest.objects?.included === true &&
    options.targetObjectBucket.length > 0 &&
    options.targetObjectBucket !== sourceObjectBucket;
  const sampleCount = nonnegativeInteger(options.sampleCount, "sample count");
  const sampleMatches = nonnegativeInteger(options.sampleMatches, "sample matches");
  const databaseSnapshot = manifest.artifacts?.find(
    ({ path }) => path === manifest.database?.consistencyArtifact,
  );
  const versionInventory = manifest.artifacts?.find(
    ({ path }) => path === manifest.objects?.versionInventoryArtifact,
  );
  const scenarios = {
    manifest_integrity: {
      status: passFail(manifestValid),
      schema: String(manifest.schema ?? "unknown"),
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      recoverySetHash: String(manifest.recoverySet?.id ?? ""),
    },
    encrypted_restore: {
      status: passFail(encrypted),
      method: String(manifest.encryption?.method ?? "none"),
      plaintextKeyMaterialObserved: false,
    },
    off_host_retention_key_custody: {
      status: passFail(offHostContract),
      offHostCopyRecorded: String(manifest.resilience?.offHostUri ?? "").startsWith("s3://"),
      retentionDays: Number(manifest.resilience?.retentionDays ?? 0),
      keyCustodyReferenceRecorded: String(manifest.encryption?.keyCustodyRef ?? "").length > 0,
      plaintextKeyMaterialObserved: false,
    },
    disposable_environment: {
      status: passFail(disposableDatabase && disposableObjects),
      sourceDatabaseHash: anonymize(options.sourceDb),
      targetDatabaseHash: anonymize(options.targetDb),
      sourceObjectBucketHash: anonymize(sourceObjectBucket),
      targetObjectBucketHash: anonymize(options.targetObjectBucket),
      databaseIsolated: disposableDatabase,
      objectStoreIsolated: disposableObjects,
    },
    database_consistency: {
      status: options.databaseConsistency,
      expectedSnapshotSha256: String(databaseSnapshot?.sha256 ?? ""),
      exactMatch: options.databaseConsistency === "passed",
    },
    object_version_consistency: {
      status: options.objectVersionConsistency,
      versionInventorySha256: String(versionInventory?.sha256 ?? ""),
      isolatedRestore: options.objectVersionConsistency === "passed",
    },
    outbound_queue_consistency: {
      status: options.outboundQueueConsistency,
      exactMatch: options.outboundQueueConsistency === "passed",
    },
    audit_chain: {
      status: options.auditChain,
      invalidLinks: options.auditChain === "passed" ? 0 : null,
    },
    sampled_corpus_hashes: {
      status: passFail(sampleCount > 0 && sampleMatches === sampleCount),
      sampleCount,
      matchingCount: sampleMatches,
    },
    search_reindex: {
      status: options.searchReindex,
      rebuiltFromRestoredDatabase: options.searchReindex === "passed",
    },
    rpo: {
      status: passFail(rpoHours <= 24),
      observedHours: rpoHours,
      targetHours: 24,
      recoveryPoint,
    },
    rto: {
      status: passFail(rtoHours <= 4),
      observedHours: rtoHours,
      targetHours: 4,
    },
  };
  const allPassed = RESTORE_DRILL_SCENARIOS.every(
    (scenario) => scenarios[scenario].status === "passed",
  );
  return {
    schema: RESTORE_DRILL_EVIDENCE_SCHEMA,
    runId: `restore-${createHash("sha256")
      .update(`${String(manifest.backupId)}:${startedAt}:${completedAt}`)
      .digest("hex")
      .slice(0, 20)}`,
    mode: "live",
    status: allPassed ? "passed" : "failed",
    startedAt,
    completedAt,
    backup: {
      backupIdHash: anonymize(String(manifest.backupId ?? "")),
      recoverySetHash: String(manifest.recoverySet?.id ?? ""),
      tier: String(manifest.tier ?? "unknown"),
      offHostContractPresent: offHostContract,
    },
    metrics: { rpoHours, rtoHours, rpoTargetHours: 24, rtoTargetHours: 4 },
    scenarios,
  };
}

export function validateRestoreDrillEvidence(evidence) {
  assertContainsNoSecrets(evidence);
  if (evidence?.schema !== RESTORE_DRILL_EVIDENCE_SCHEMA) {
    throw new Error(`unexpected restore drill evidence schema: ${String(evidence?.schema)}`);
  }
  validateOptionalReleaseEvidenceBinding(evidence.releaseBinding);
  if (!["static", "live"].includes(evidence.mode)) throw new Error("invalid evidence mode");
  if (!["static_validated", "passed", "failed"].includes(evidence.status)) {
    throw new Error("invalid evidence status");
  }
  for (const scenario of RESTORE_DRILL_SCENARIOS) {
    const result = evidence.scenarios?.[scenario];
    if (result === undefined) throw new Error(`missing restore drill scenario: ${scenario}`);
    if (!["passed", "failed", "not_run"].includes(result.status)) {
      throw new Error(`invalid restore drill scenario status: ${scenario}`);
    }
  }
  if (Object.keys(evidence.scenarios).length !== RESTORE_DRILL_SCENARIOS.length) {
    throw new Error("restore drill evidence contains unknown scenarios");
  }
  if (evidence.mode === "static") {
    if (
      evidence.status !== "static_validated" ||
      RESTORE_DRILL_SCENARIOS.some((scenario) => evidence.scenarios[scenario].status !== "not_run")
    ) {
      throw new Error("static restore evidence cannot claim live checks");
    }
  }
  if (evidence.status === "passed") {
    if (evidence.mode !== "live") throw new Error("passed restore evidence must be live");
    const incomplete = RESTORE_DRILL_SCENARIOS.filter(
      (scenario) => evidence.scenarios[scenario].status !== "passed",
    );
    if (incomplete.length > 0) {
      throw new Error(`passed restore evidence requires every scenario: ${incomplete.join(", ")}`);
    }
    if (evidence.metrics.rpoHours > 24 || evidence.metrics.rtoHours > 4) {
      throw new Error("passed restore evidence exceeds the RPO/RTO target");
    }
    validatePassedDetails(evidence);
  }
  return evidence;
}

function validatePassedDetails(evidence) {
  const scenarios = evidence.scenarios;
  if (
    !/^[a-f0-9]{64}$/u.test(scenarios.manifest_integrity.manifestSha256) ||
    !/^[a-f0-9]{64}$/u.test(scenarios.manifest_integrity.recoverySetHash)
  ) {
    throw new Error("passed restore evidence requires manifest and recovery-set digests");
  }
  if (
    !["age", "kms"].includes(scenarios.encrypted_restore.method) ||
    scenarios.encrypted_restore.plaintextKeyMaterialObserved !== false
  ) {
    throw new Error("passed restore evidence requires encrypted recovery without plaintext keys");
  }
  if (
    scenarios.off_host_retention_key_custody.offHostCopyRecorded !== true ||
    scenarios.off_host_retention_key_custody.retentionDays <= 0 ||
    scenarios.off_host_retention_key_custody.keyCustodyReferenceRecorded !== true
  ) {
    throw new Error("passed restore evidence requires off-host retention and key custody");
  }
  if (
    scenarios.disposable_environment.databaseIsolated !== true ||
    scenarios.disposable_environment.objectStoreIsolated !== true
  ) {
    throw new Error("passed restore evidence requires disposable database and object targets");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(scenarios.database_consistency.expectedSnapshotSha256) ||
    scenarios.database_consistency.exactMatch !== true ||
    !/^[a-f0-9]{64}$/u.test(scenarios.object_version_consistency.versionInventorySha256) ||
    scenarios.object_version_consistency.isolatedRestore !== true ||
    scenarios.outbound_queue_consistency.exactMatch !== true ||
    scenarios.audit_chain.invalidLinks !== 0
  ) {
    throw new Error("passed restore evidence requires database/object/queue/audit observations");
  }
  if (
    scenarios.sampled_corpus_hashes.sampleCount <= 0 ||
    scenarios.sampled_corpus_hashes.matchingCount !== scenarios.sampled_corpus_hashes.sampleCount ||
    scenarios.search_reindex.rebuiltFromRestoredDatabase !== true
  ) {
    throw new Error("passed restore evidence requires corpus hashes and restored-data reindex");
  }
  if (
    scenarios.rpo.observedHours !== evidence.metrics.rpoHours ||
    scenarios.rto.observedHours !== evidence.metrics.rtoHours ||
    scenarios.rpo.targetHours !== 24 ||
    scenarios.rto.targetHours !== 4
  ) {
    throw new Error("passed restore evidence has inconsistent RPO/RTO measurements");
  }
}

export function assertContainsNoSecrets(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertContainsNoSecrets(entry, `${path}[${String(index)}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw new Error(`sensitive restore evidence field is forbidden: ${path}.${key}`);
      }
      assertContainsNoSecrets(entry, `${path}.${key}`);
    }
  }
}

function parseArgs(args) {
  const options = {
    mode: undefined,
    output: undefined,
    manifest: undefined,
    startedAt: undefined,
    completedAt: undefined,
    sourceDb: "",
    targetDb: "",
    targetObjectBucket: "",
    manifestIntegrity: "failed",
    databaseConsistency: "failed",
    objectVersionConsistency: "failed",
    outboundQueueConsistency: "failed",
    auditChain: "failed",
    sampleCount: 0,
    sampleMatches: 0,
    searchReindex: "not_run",
    requirePass: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--static") {
      options.mode = "static";
      continue;
    }
    if (argument === "--live") {
      options.mode = "live";
      continue;
    }
    if (argument === "--require-pass") {
      options.requirePass = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage);
      process.exit(0);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${argument} requires a value`);
    index += 1;
    const key = {
      "--output": "output",
      "--manifest": "manifest",
      "--started-at": "startedAt",
      "--completed-at": "completedAt",
      "--source-db": "sourceDb",
      "--target-db": "targetDb",
      "--target-object-bucket": "targetObjectBucket",
      "--manifest-integrity": "manifestIntegrity",
      "--database-consistency": "databaseConsistency",
      "--object-version-consistency": "objectVersionConsistency",
      "--outbound-queue-consistency": "outboundQueueConsistency",
      "--audit-chain": "auditChain",
      "--sample-count": "sampleCount",
      "--sample-matches": "sampleMatches",
      "--search-reindex": "searchReindex",
    }[argument];
    if (key === undefined) throw new Error(`unknown option: ${argument}`);
    options[key] = value;
  }
  if (!["static", "live"].includes(options.mode)) throw new Error("choose --static or --live");
  if (options.mode === "live") {
    for (const key of ["manifest", "startedAt", "completedAt"]) {
      if (options[key] === undefined) throw new Error(`live evidence requires ${key}`);
    }
    for (const key of [
      "manifestIntegrity",
      "databaseConsistency",
      "objectVersionConsistency",
      "outboundQueueConsistency",
      "auditChain",
    ]) {
      status(options[key], key, false);
    }
    status(options.searchReindex, "search reindex", true);
  }
  if (options.output !== undefined) options.output = resolve(options.output);
  if (options.manifest !== undefined) options.manifest = resolve(options.manifest);
  return options;
}

function status(value, name, allowNotRun) {
  const allowed = allowNotRun ? ["passed", "failed", "not_run"] : ["passed", "failed"];
  if (!allowed.includes(value)) throw new Error(`${name} must be ${allowed.join(" or ")}`);
  return value;
}

function passFail(value) {
  return value ? "passed" : "failed";
}

function elapsedHours(from, to, name) {
  const result = (Date.parse(to) - Date.parse(from)) / 3_600_000;
  if (!Number.isFinite(result) || result < 0) throw new Error(`${name} interval is invalid`);
  return Math.round(result * 1_000_000) / 1_000_000;
}

function canonicalTimestamp(value, name) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be ISO-8601`);
  return parsed.toISOString();
}

function nonnegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be nonnegative`);
  return parsed;
}

function anonymize(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}
