import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import { strictBase64 } from "./sigstore-codec.mjs";
import {
  canonicalJson,
  exactKeys,
  exactObject,
  freshTimestamp,
  futureDate,
  hash,
  isoDate,
  nonEmptyString,
  object,
  owner,
  passed,
} from "./validation-primitives.mjs";

export async function validateProtectedRepositoryState(
  report,
  expectedBinding,
  expectedState,
  trust,
  referenceTime,
) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "observedAt",
    "repositories",
    "signature",
  ]);
  passed(report.status, "protected repository state status");
  const observedAt = isoDate(report.observedAt, "protected repository state observedAt");
  freshTimestamp(
    report.observedAt,
    referenceTime,
    60 * 60 * 1_000,
    "protected repository state observation",
  );
  if (observedAt.getTime() > Date.parse(report.generatedAt)) {
    throw new Error("protected repository state observation is after report generation");
  }
  object(expectedState, "expected protected repository state");
  object(trust, "protected repository state trust");
  exactObject(report.repositories, ["workspace", "editors"], "protected repositories");
  for (const [name, sha, tag] of [
    ["workspace", expectedBinding.workspaceSha, expectedState.workspaceTag],
    ["editors", expectedBinding.editorsSha, expectedState.editorsTag],
  ]) {
    const state = report.repositories[name];
    exactObject(
      state,
      ["repository", "branch", "branchSha", "tag", "tagSha"],
      `${name} protected state`,
    );
    if (
      state.repository !== expectedState.repositories[name] ||
      state.branch !== expectedState.branch ||
      state.branchSha !== sha ||
      state.tag !== tag ||
      state.tagSha !== sha
    ) {
      throw new Error(`${name} protected branch/tag state does not match the promoted release`);
    }
  }
  await verifyProtectedEd25519Signature(report, trust, "protected repository state");
  return {
    status: report.status,
    observedAt: report.observedAt,
    signer: report.signature.signer,
    workspaceSha: expectedBinding.workspaceSha,
    editorsSha: expectedBinding.editorsSha,
  };
}

async function verifyProtectedEd25519Signature(report, trust, label) {
  object(trust, `${label} trust`);
  exactObject(
    report.signature,
    ["algorithm", "signer", "signerFingerprint", "value"],
    `${label} signature`,
  );
  if (report.signature.algorithm !== "Ed25519")
    throw new Error(`${label} signature must be Ed25519`);
  if (report.signature.signer !== trust.signer)
    throw new Error(`${label} signer identity is not trusted`);
  hash(report.signature.signerFingerprint, `${label} signer fingerprint`);
  hash(trust.signerFingerprint, `${label} trusted signer fingerprint`);
  const publicKey = createPublicKey(await readFile(trust.publicKeyPath, "utf8"));
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw new Error(`${label} public key must be Ed25519`);
  const fingerprint = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  if (
    fingerprint !== report.signature.signerFingerprint ||
    fingerprint !== trust.signerFingerprint
  ) {
    throw new Error(`${label} signer fingerprint does not match the trusted public key`);
  }
  const signature = strictBase64(report.signature.value, `${label} signature`);
  const unsigned = {
    ...report,
    signature: {
      algorithm: report.signature.algorithm,
      signer: report.signature.signer,
      signerFingerprint: report.signature.signerFingerprint,
    },
  };
  if (
    signature.length !== 64 ||
    !verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, signature)
  ) {
    throw new Error(`${label} signature is invalid`);
  }
}

export async function validateProductionDecision(
  report,
  publicKeyPath,
  trustedSignerFingerprint,
  expectedEvidenceSetSha256,
  referenceTime,
) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "decision",
    "decidedAt",
    "owner",
    "rationale",
    "conditions",
    "evidenceSetSha256",
    "signature",
  ]);
  if (!["go", "conditional_go", "no_go"].includes(report.decision)) {
    throw new Error("production decision must be go, conditional_go, or no_go");
  }
  if (report.decision === "no_go") throw new Error("production decision is no_go");
  const decidedAt = isoDate(report.decidedAt, "production decision decidedAt");
  const generated = isoDate(report.generatedAt, "production decision generatedAt");
  if (decidedAt.getTime() > generated.getTime() || decidedAt.getTime() > referenceTime.getTime()) {
    throw new Error("production decision timestamp is in the future");
  }
  if (referenceTime.getTime() - decidedAt.getTime() > 24 * 60 * 60 * 1_000) {
    throw new Error("production decision is older than 24 hours");
  }
  owner(report.owner, "production decision owner");
  nonEmptyString(report.rationale, "production decision rationale");
  hash(report.evidenceSetSha256, "production decision evidence set");
  if (report.evidenceSetSha256 !== expectedEvidenceSetSha256) {
    throw new Error("production decision does not cover the exact release evidence set");
  }
  if (!Array.isArray(report.conditions)) throw new Error("decision conditions must be an array");
  const conditionIds = new Set();
  for (const condition of report.conditions) {
    exactObject(condition, ["conditionId", "summary", "owner", "expiresAt"], "decision condition");
    nonEmptyString(condition.conditionId, "decision condition ID");
    nonEmptyString(condition.summary, "decision condition summary");
    owner(condition.owner, "decision condition owner");
    futureDate(condition.expiresAt, referenceTime, "decision condition expiry");
    if (conditionIds.has(condition.conditionId)) {
      throw new Error("production decision condition ID is duplicated");
    }
    conditionIds.add(condition.conditionId);
  }
  if (
    (report.decision === "go" && report.conditions.length !== 0) ||
    (report.decision === "conditional_go" && report.conditions.length === 0)
  ) {
    throw new Error("production decision conditions do not match the decision");
  }
  exactObject(
    report.signature,
    ["algorithm", "signer", "signerFingerprint", "value"],
    "production decision signature",
  );
  if (report.signature.algorithm !== "Ed25519")
    throw new Error("decision signature must be Ed25519");
  owner(report.signature.signer, "decision signer");
  hash(report.signature.signerFingerprint, "decision signer fingerprint");
  if (publicKeyPath === undefined) {
    throw new Error(
      "protected verifier decision public key is required for final-release verification",
    );
  }
  hash(trustedSignerFingerprint, "trusted decision signer fingerprint");
  const publicKey = createPublicKey(await readFile(publicKeyPath, "utf8"));
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("decision public key must be Ed25519");
  }
  const fingerprint = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  if (
    fingerprint !== report.signature.signerFingerprint ||
    fingerprint !== trustedSignerFingerprint
  ) {
    throw new Error("decision signer fingerprint does not match the trusted public key");
  }
  const signature = Buffer.from(report.signature.value, "base64");
  const unsigned = {
    ...report,
    signature: {
      algorithm: report.signature.algorithm,
      signer: report.signature.signer,
      signerFingerprint: report.signature.signerFingerprint,
    },
  };
  if (
    signature.length !== 64 ||
    !verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, signature)
  ) {
    throw new Error("production decision signature is invalid");
  }
  return {
    decision: report.decision,
    decidedAt: report.decidedAt,
    owner: report.owner,
    signer: report.signature.signer,
    signerFingerprint: fingerprint,
    conditionCount: report.conditions.length,
  };
}
