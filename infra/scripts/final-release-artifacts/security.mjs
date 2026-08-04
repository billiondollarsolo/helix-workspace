import {
  ARTIFACT_SCHEMAS,
  OCI_DIGEST_PATTERN,
  REQUIRED_PRODUCTION_IMAGES,
  REQUIRED_PRODUCTION_IMAGE_SUBJECTS,
} from "./constants.mjs";
import { validateArtifactReference } from "./retained-artifacts.mjs";
import {
  exactKeys,
  exactObject,
  freshTimestamp,
  futureDate,
  hash,
  isoDate,
  notAfter,
  object,
  owner,
  passed,
} from "./validation-primitives.mjs";

// Security scans, SBOMs, and manual reviews all share one freshness budget.
const SECURITY_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export function validateSecurityReview(
  report,
  referenceTime,
  productionImages,
  expectedBinding,
  artifactContext,
) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "threatModel",
    "repositoryScan",
    "dependencyAudit",
    "sensitiveDataScan",
    "containerScans",
    "sboms",
    "manualReview",
    "findings",
  ]);
  passed(report.status, "security review status");
  validateArtifactReference(
    report.threatModel,
    ARTIFACT_SCHEMAS.threatModel,
    "threat-model artifact",
    artifactContext,
    { releaseBinding: expectedBinding, role: "production-threat-model" },
  );
  for (const [field, schema] of [
    ["repositoryScan", ARTIFACT_SCHEMAS.repositoryScan],
    ["dependencyAudit", ARTIFACT_SCHEMAS.dependencyAudit],
    ["manualReview", ARTIFACT_SCHEMAS.manualReview],
  ]) {
    validateSecurityCheck(report[field], field, schema, artifactContext);
    notAfter(report[field].completedAt, report.generatedAt, `${field} completion`);
    freshTimestamp(
      report[field].completedAt,
      referenceTime,
      SECURITY_EVIDENCE_MAX_AGE_MS,
      `${field} completion`,
    );
  }
  validateSensitiveDataScan(report.sensitiveDataScan, artifactContext);
  notAfter(
    report.sensitiveDataScan.completedAt,
    report.generatedAt,
    "sensitiveDataScan completion",
  );
  freshTimestamp(
    report.sensitiveDataScan.completedAt,
    referenceTime,
    SECURITY_EVIDENCE_MAX_AGE_MS,
    "sensitiveDataScan completion",
  );
  validateNamedImageChecks(
    report.containerScans,
    "container scans",
    ARTIFACT_SCHEMAS.containerScan,
    productionImages,
    artifactContext,
  );
  validateNamedImageChecks(
    report.sboms,
    "SBOMs",
    ARTIFACT_SCHEMAS.sbom,
    productionImages,
    artifactContext,
  );
  for (const group of [report.containerScans, report.sboms]) {
    for (const check of Object.values(group)) {
      notAfter(check.completedAt, report.generatedAt, "security artifact completion");
      freshTimestamp(
        check.completedAt,
        referenceTime,
        SECURITY_EVIDENCE_MAX_AGE_MS,
        "security artifact completion",
      );
    }
  }
  for (const name of REQUIRED_PRODUCTION_IMAGES) {
    if (report.containerScans[name].imageDigest !== report.sboms[name].imageDigest) {
      throw new Error(`${name} container scan and SBOM do not cover the same image digest`);
    }
  }
  if (!Array.isArray(report.findings)) throw new Error("security findings must be an array");
  const findingIds = new Set();
  for (const finding of report.findings) {
    validateFinding(finding, referenceTime, artifactContext);
    if (findingIds.has(finding.findingIdHash)) {
      throw new Error("security finding identifier is duplicated");
    }
    findingIds.add(finding.findingIdHash);
  }
  const blocking = report.findings.some(
    ({ severity, disposition }) =>
      ["critical", "high"].includes(severity) &&
      !["resolved", "false_positive"].includes(disposition),
  );
  if (blocking) throw new Error("Critical/High security findings remain open");
  return {
    status: report.status,
    findingCount: report.findings.length,
    acceptedFindingCount: report.findings.filter(({ disposition }) => disposition === "accepted")
      .length,
    productionImages: Object.fromEntries(
      REQUIRED_PRODUCTION_IMAGES.map((name) => [name, report.containerScans[name].imageDigest]),
    ),
  };
}

function validateSecurityCheck(check, label, artifactSchema, artifactContext) {
  exactObject(check, ["status", "completedAt", "artifact"], label);
  passed(check.status, `${label} status`);
  isoDate(check.completedAt, `${label} completedAt`);
  validateArtifactReference(check.artifact, artifactSchema, `${label} artifact`, artifactContext, {
    completedAt: check.completedAt,
  });
}

function validateSensitiveDataScan(check, artifactContext) {
  exactObject(check, ["status", "completedAt", "scope", "artifact"], "sensitiveDataScan");
  if (check.scope !== "repository-and-release-packet") {
    throw new Error("sensitive-data scan must cover the repository and complete release packet");
  }
  passed(check.status, "sensitiveDataScan status");
  isoDate(check.completedAt, "sensitiveDataScan completedAt");
  validateArtifactReference(
    check.artifact,
    ARTIFACT_SCHEMAS.sensitiveDataScan,
    "sensitiveDataScan artifact",
    artifactContext,
    { completedAt: check.completedAt, scope: check.scope },
  );
}

function validateNamedImageChecks(
  checks,
  label,
  artifactSchema,
  productionImages,
  artifactContext,
) {
  object(checks, label);
  exactKeys(checks, REQUIRED_PRODUCTION_IMAGES);
  for (const name of REQUIRED_PRODUCTION_IMAGES) {
    const check = checks[name];
    exactObject(check, ["status", "completedAt", "imageDigest", "artifact"], `${label}.${name}`);
    passed(check.status, `${label}.${name} status`);
    isoDate(check.completedAt, `${label}.${name} completedAt`);
    if (!OCI_DIGEST_PATTERN.test(check.imageDigest)) {
      throw new Error(`${label}.${name} imageDigest must be an immutable OCI digest`);
    }
    if (check.imageDigest !== productionImages[name]) {
      throw new Error(`${label}.${name} does not cover the resolved production image`);
    }
    validateArtifactReference(
      check.artifact,
      artifactSchema,
      `${label}.${name} artifact`,
      artifactContext,
      {
        completedAt: check.completedAt,
        imageDigest: check.imageDigest,
        imageSubject: REQUIRED_PRODUCTION_IMAGE_SUBJECTS[name],
        artifactContext,
      },
    );
  }
}

function validateFinding(finding, referenceTime, artifactContext) {
  exactObject(
    finding,
    ["findingIdHash", "severity", "disposition", "owner", "expiresAt", "artifact"],
    "security finding",
  );
  hash(finding.findingIdHash, "finding ID");
  if (!["critical", "high", "medium", "low"].includes(finding.severity)) {
    throw new Error("security finding severity is invalid");
  }
  if (!["resolved", "false_positive", "accepted"].includes(finding.disposition)) {
    throw new Error("security finding disposition is invalid");
  }
  owner(finding.owner, "security finding owner");
  validateArtifactReference(
    finding.artifact,
    ARTIFACT_SCHEMAS.findingDisposition,
    `security finding ${finding.findingIdHash} disposition`,
    artifactContext,
    {
      findingIdHash: finding.findingIdHash,
      disposition: finding.disposition,
      owner: finding.owner,
    },
  );
  if (finding.disposition === "accepted") {
    if (!["medium", "low"].includes(finding.severity)) {
      throw new Error("only Medium/Low security findings may be accepted");
    }
    futureDate(finding.expiresAt, referenceTime, "security finding expiry");
  } else {
    isoDate(finding.expiresAt, "security finding expiry");
  }
}
