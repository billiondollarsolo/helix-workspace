import { Buffer } from "node:buffer";
import { URL } from "node:url";

import { validateReleaseEvidenceBinding } from "../release-evidence-binding.mjs";
import { ARTIFACT_SCHEMAS } from "./constants.mjs";
import {
  exactObject,
  hash,
  isoDate,
  nonEmptyString,
  nonNegativeInteger,
  object,
  owner,
  passed,
  positiveInteger,
  registerArtifactIdentity,
} from "./validation-primitives.mjs";

export function validateArtifactReference(
  reference,
  expectedSchema,
  label,
  context,
  expectations = {},
) {
  if (!(context.availableEvidence instanceof Map)) {
    throw new Error("available evidence path/digest map is required");
  }
  exactObject(reference, ["path", "sha256", "schema"], label);
  nonEmptyString(reference.path, `${label} path`);
  hash(reference.sha256, `${label} sha256`);
  if (reference.schema !== expectedSchema) {
    throw new Error(`${label} has an invalid artifact schema`);
  }
  const retained = context.availableEvidence.get(reference.path);
  if (
    retained === undefined ||
    retained.sha256 !== reference.sha256 ||
    !Buffer.isBuffer(retained.content)
  ) {
    throw new Error(`${label} path/digest is not retained in the evidence directory`);
  }
  let retainedDocument;
  try {
    retainedDocument = JSON.parse(retained.content.toString("utf8"));
  } catch {
    throw new Error(`${label} retained artifact must be a JSON document`);
  }
  if (
    retainedDocument === null ||
    typeof retainedDocument !== "object" ||
    Array.isArray(retainedDocument) ||
    retainedDocument.schema !== expectedSchema
  ) {
    throw new Error(`${label} retained document does not match its declared artifact schema`);
  }
  validateRetainedArtifact(retainedDocument, expectedSchema, label, expectations);
  registerArtifactIdentity(reference, label, context);
  return { reference, document: retainedDocument };
}

function validateSpdxArtifactReference(reference, label, context, expectations) {
  if (!(context.availableEvidence instanceof Map)) {
    throw new Error("available evidence path/digest map is required");
  }
  exactObject(reference, ["path", "sha256", "schema"], label);
  nonEmptyString(reference.path, `${label} path`);
  hash(reference.sha256, `${label} sha256`);
  if (reference.schema !== ARTIFACT_SCHEMAS.spdxDocument) {
    throw new Error(`${label} has an invalid SPDX artifact schema`);
  }
  const retained = context.availableEvidence.get(reference.path);
  if (
    retained === undefined ||
    retained.sha256 !== reference.sha256 ||
    !Buffer.isBuffer(retained.content)
  ) {
    throw new Error(`${label} path/digest is not retained in the evidence directory`);
  }
  let document;
  try {
    document = JSON.parse(retained.content.toString("utf8"));
  } catch {
    throw new Error(`${label} must be a retained JSON document`);
  }
  validateSpdxDocument(document, label, expectations);
  registerArtifactIdentity(reference, label, context);
  return { reference, document };
}

function validateRetainedArtifact(document, schema, label, expectations) {
  if (schema === ARTIFACT_SCHEMAS.imageProvenance) return;
  if (schema === ARTIFACT_SCHEMAS.commandReport) {
    exactObject(
      document,
      ["schema", "status", "command", "revision", "completedAt", "exitCode"],
      label,
    );
    passed(document.status, `${label} status`);
    if (document.command !== expectations.command) {
      throw new Error(`${label} does not cover the exact command`);
    }
    if (document.revision !== expectations.revision) {
      throw new Error(`${label} does not cover the exact revision`);
    }
    if (document.completedAt !== expectations.completedAt) {
      throw new Error(`${label} completion does not match its summary`);
    }
    isoDate(document.completedAt, `${label} completedAt`);
    if (document.exitCode !== 0) throw new Error(`${label} exit code must be zero`);
    return;
  }
  if (schema === ARTIFACT_SCHEMAS.containerScan) {
    exactObject(
      document,
      ["schema", "status", "completedAt", "imageDigest", "scanner", "critical", "high"],
      label,
    );
    passed(document.status, `${label} status`);
    compareRetainedCompletionAndDigest(document, expectations, label);
    nonEmptyString(document.scanner, `${label} scanner`);
    nonNegativeInteger(document.critical, `${label} critical findings`);
    nonNegativeInteger(document.high, `${label} high findings`);
    if (document.critical !== 0 || document.high !== 0) {
      throw new Error(`${label} reports blocking High/Critical vulnerabilities`);
    }
    return;
  }
  if (schema === ARTIFACT_SCHEMAS.sbom) {
    exactObject(
      document,
      [
        "schema",
        "status",
        "completedAt",
        "imageDigest",
        "imageSubject",
        "format",
        "packageCount",
        "documentSha256",
        "spdxArtifact",
      ],
      label,
    );
    passed(document.status, `${label} status`);
    compareRetainedCompletionAndDigest(document, expectations, label);
    if (document.imageSubject !== expectations.imageSubject) {
      throw new Error(`${label} image subject does not match the production image`);
    }
    if (document.format !== "spdx-json") throw new Error(`${label} must be SPDX JSON`);
    positiveInteger(document.packageCount, `${label} packageCount`);
    hash(document.documentSha256, `${label} document digest`);
    const spdx = validateSpdxArtifactReference(
      document.spdxArtifact,
      `${label} SPDX document`,
      expectations.artifactContext,
      {
        imageDigest: document.imageDigest,
        imageSubject: document.imageSubject,
        packageCount: document.packageCount,
      },
    );
    if (document.documentSha256 !== spdx.reference.sha256) {
      throw new Error(`${label} document digest does not match its retained SPDX document`);
    }
    return;
  }
  if (
    [
      ARTIFACT_SCHEMAS.repositoryScan,
      ARTIFACT_SCHEMAS.dependencyAudit,
      ARTIFACT_SCHEMAS.manualReview,
    ].includes(schema)
  ) {
    exactObject(
      document,
      ["schema", "status", "completedAt", "critical", "high", "medium", "low"],
      label,
    );
    passed(document.status, `${label} status`);
    compareRetainedCompletionAndDigest(document, expectations, label);
    for (const severity of ["critical", "high", "medium", "low"]) {
      nonNegativeInteger(document[severity], `${label} ${severity} findings`);
    }
    if (document.critical !== 0 || document.high !== 0) {
      throw new Error(`${label} reports blocking High/Critical findings`);
    }
    return;
  }
  if (schema === ARTIFACT_SCHEMAS.sensitiveDataScan) {
    exactObject(document, ["schema", "status", "completedAt", "scope", "matchCount"], label);
    passed(document.status, `${label} status`);
    compareRetainedCompletionAndDigest(document, expectations, label);
    if (document.scope !== expectations.scope) throw new Error(`${label} scope does not match`);
    nonNegativeInteger(document.matchCount, `${label} matchCount`);
    if (document.matchCount !== 0) throw new Error(`${label} reports sensitive-data matches`);
    return;
  }
  if (schema === ARTIFACT_SCHEMAS.findingDisposition) {
    exactObject(
      document,
      ["schema", "status", "completedAt", "findingIdHash", "disposition", "owner"],
      label,
    );
    passed(document.status, `${label} status`);
    isoDate(document.completedAt, `${label} completedAt`);
    for (const field of ["findingIdHash", "disposition", "owner"]) {
      if (document[field] !== expectations[field]) {
        throw new Error(`${label} ${field} does not match its finding`);
      }
    }
    return;
  }

  const genericSchemas = new Map([
    [ARTIFACT_SCHEMAS.rollbackPlan, "approved"],
    [ARTIFACT_SCHEMAS.soakReport, "passed"],
    [ARTIFACT_SCHEMAS.threatModel, "approved"],
    [ARTIFACT_SCHEMAS.runbookIndex, "passed"],
    [ARTIFACT_SCHEMAS.limitations, "passed"],
    [ARTIFACT_SCHEMAS.rolloutObservations, "passed"],
    [ARTIFACT_SCHEMAS.rolloutExitReview, "passed"],
    [ARTIFACT_SCHEMAS.independentSecurityReview, "passed"],
    [ARTIFACT_SCHEMAS.costModel, "passed"],
    [ARTIFACT_SCHEMAS.riskMitigation, "passed"],
  ]);
  const expectedStatus = genericSchemas.get(schema);
  if (expectedStatus === undefined) throw new Error(`${label} has no semantic validator`);
  const phaseBound = [
    ARTIFACT_SCHEMAS.rolloutObservations,
    ARTIFACT_SCHEMAS.rolloutExitReview,
    ARTIFACT_SCHEMAS.independentSecurityReview,
  ].includes(schema);
  const riskBound = schema === ARTIFACT_SCHEMAS.riskMitigation;
  exactObject(
    document,
    [
      "schema",
      "status",
      "completedAt",
      "owner",
      "releaseBinding",
      "role",
      ...(phaseBound ? ["phase"] : []),
      ...(riskBound ? ["riskId"] : []),
    ],
    label,
  );
  if (document.status !== expectedStatus)
    throw new Error(`${label} status is not ${expectedStatus}`);
  isoDate(document.completedAt, `${label} completedAt`);
  owner(document.owner, `${label} owner`);
  validateReleaseEvidenceBinding(document.releaseBinding, expectations.releaseBinding);
  if (document.role !== expectations.role) {
    throw new Error(`${label} role does not match its release-readiness use`);
  }
  if (phaseBound && document.phase !== expectations.phase) {
    throw new Error(`${label} phase does not match its rollout period`);
  }
  if (riskBound && document.riskId !== expectations.riskId) {
    throw new Error(`${label} riskId does not match its accepted risk`);
  }
}

function compareRetainedCompletionAndDigest(document, expectations, label) {
  isoDate(document.completedAt, `${label} completedAt`);
  if (expectations.completedAt !== undefined && document.completedAt !== expectations.completedAt) {
    throw new Error(`${label} completion does not match its summary`);
  }
  if (expectations.imageDigest !== undefined && document.imageDigest !== expectations.imageDigest) {
    throw new Error(`${label} image digest does not match its summary`);
  }
}

export function validateSpdxDocument(document, label, expectations) {
  object(document, label);
  const allowedTopLevelFields = new Set([
    "SPDXID",
    "annotations",
    "comment",
    "creationInfo",
    "dataLicense",
    "documentDescribes",
    "documentNamespace",
    "externalDocumentRefs",
    "files",
    "hasExtractedLicensingInfos",
    "name",
    "packages",
    "relationships",
    "snippets",
    "spdxVersion",
  ]);
  const unknownFields = Object.keys(document).filter((field) => !allowedTopLevelFields.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`${label} contains fields outside the SPDX 2.3 JSON schema`);
  }
  if (
    document.spdxVersion !== "SPDX-2.3" ||
    document.dataLicense !== "CC0-1.0" ||
    document.SPDXID !== "SPDXRef-DOCUMENT"
  ) {
    throw new Error(`${label} is not an SPDX 2.3 JSON document`);
  }
  const expectedName = `${expectations.imageSubject}@${expectations.imageDigest}`;
  if (document.name !== expectedName) {
    throw new Error(`${label} name does not bind the exact image subject and digest`);
  }
  nonEmptyString(document.documentNamespace, `${label} documentNamespace`);
  let namespace;
  try {
    namespace = new URL(document.documentNamespace);
  } catch {
    throw new Error(`${label} documentNamespace must be an absolute URL`);
  }
  if (
    namespace.protocol !== "https:" ||
    namespace.username.length > 0 ||
    namespace.password.length > 0
  ) {
    throw new Error(`${label} documentNamespace must be a credential-free HTTPS URL`);
  }
  exactObject(document.creationInfo, ["created", "creators"], `${label} creationInfo`);
  isoDate(document.creationInfo.created, `${label} creationInfo.created`);
  if (
    !Array.isArray(document.creationInfo.creators) ||
    document.creationInfo.creators.length === 0 ||
    document.creationInfo.creators.some(
      (creator) =>
        typeof creator !== "string" ||
        !/^(?:Organization|Person|Tool): [^\r\n]{1,200}$/u.test(creator),
    )
  ) {
    throw new Error(`${label} creationInfo must identify at least one SPDX creator`);
  }
  if (
    !Array.isArray(document.documentDescribes) ||
    document.documentDescribes.length !== 1 ||
    !/^SPDXRef-[A-Za-z0-9.-]+$/u.test(document.documentDescribes[0])
  ) {
    throw new Error(`${label} must describe exactly one container-image package`);
  }
  if (!Array.isArray(document.packages) || document.packages.length !== expectations.packageCount) {
    throw new Error(`${label} package inventory does not match its retained summary`);
  }
  const packageIds = new Set();
  for (const entry of document.packages) {
    object(entry, `${label} package`);
    if (
      typeof entry.SPDXID !== "string" ||
      !/^SPDXRef-[A-Za-z0-9.-]+$/u.test(entry.SPDXID) ||
      packageIds.has(entry.SPDXID)
    ) {
      throw new Error(`${label} package SPDX identifiers must be valid and unique`);
    }
    packageIds.add(entry.SPDXID);
    nonEmptyString(entry.name, `${label} package name`);
  }
  const described = document.packages.find(
    (entry) => entry.SPDXID === document.documentDescribes[0],
  );
  if (
    described === undefined ||
    described.name !== expectations.imageSubject ||
    described.versionInfo !== expectations.imageDigest ||
    described.primaryPackagePurpose !== "CONTAINER"
  ) {
    throw new Error(`${label} described package does not bind the exact container image`);
  }
  if (
    !Array.isArray(described.checksums) ||
    !described.checksums.some(
      (checksum) =>
        checksum !== null &&
        typeof checksum === "object" &&
        !Array.isArray(checksum) &&
        checksum.algorithm === "SHA256" &&
        checksum.checksumValue === expectations.imageDigest.slice("sha256:".length),
    )
  ) {
    throw new Error(`${label} described package does not contain the exact image SHA-256`);
  }
}
