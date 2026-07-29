import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  certificateExtensionUtf8,
  certificateValidAt,
  dssePreAuthEncoding,
  parseX509Certificate,
  strictBase64,
} from "./sigstore-codec.mjs";

import {
  GITHUB_CERTIFICATE_EXTENSION_OIDS,
  GITHUB_OIDC_ISSUER,
  HELIX_PAIRED_SOURCE_PROVENANCE_TYPE,
  INTOTO_STATEMENT_TYPE,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
} from "./constants.mjs";
import {
  exactObject,
  freshTimestamp,
  hash,
  isoDate,
  nonEmptyString,
} from "./validation-primitives.mjs";

export async function validateImageProvenanceArtifact(document, options) {
  const { name, digest, expectedBinding, referenceTime, trust } = options;
  exactObject(
    document,
    ["schema", "generatedAt", "subjectName", "subjectDigest", "bundle"],
    `${name} image provenance artifact`,
  );
  const generatedAt = isoDate(document.generatedAt, `${name} image provenance generatedAt`);
  if (generatedAt.getTime() > referenceTime.getTime()) {
    throw new Error(`${name} image provenance is from the future`);
  }
  if (document.subjectName !== trust.subjectNames[name] || document.subjectDigest !== digest) {
    throw new Error(`${name} provenance subject does not match the promoted image`);
  }
  const bundle = document.bundle;
  exactObject(
    bundle,
    ["mediaType", "verificationMaterial", "dsseEnvelope"],
    `${name} Sigstore bundle`,
  );
  if (bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE) {
    throw new Error(`${name} provenance must use a Sigstore bundle v0.3`);
  }
  exactObject(
    bundle.verificationMaterial,
    ["certificate", "tlogEntries", "timestampVerificationData"],
    `${name} Sigstore verification material`,
  );
  exactObject(
    bundle.verificationMaterial.certificate,
    ["rawBytes"],
    `${name} Sigstore certificate`,
  );
  if (
    !Array.isArray(bundle.verificationMaterial.tlogEntries) ||
    bundle.verificationMaterial.tlogEntries.length !== 1
  ) {
    throw new Error(`${name} Sigstore bundle must contain exactly one transparency-log entry`);
  }
  exactObject(
    bundle.verificationMaterial.timestampVerificationData,
    [],
    `${name} Sigstore timestamp verification data`,
  );
  const leaf = parseX509Certificate(
    bundle.verificationMaterial.certificate.rawBytes,
    `${name} Sigstore leaf certificate`,
  );
  const issuer = new X509Certificate(await readFile(trust.fulcioIssuerCertificatePath));
  if (!issuer.ca || leaf.issuer !== issuer.subject || !leaf.verify(issuer.publicKey)) {
    throw new Error(`${name} provenance certificate is not issued by the trusted Fulcio issuer`);
  }
  const identities = leaf.subjectAltName
    .split(/,\s*/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!identities.includes(`URI:${trust.workflowIdentity}`)) {
    throw new Error(`${name} provenance certificate workflow identity is not trusted`);
  }
  const extensions = Object.fromEntries(
    Object.entries(GITHUB_CERTIFICATE_EXTENSION_OIDS).map(([field, oid]) => [
      field,
      certificateExtensionUtf8(leaf.raw, oid),
    ]),
  );
  if (
    extensions.issuer !== GITHUB_OIDC_ISSUER ||
    extensions.sourceDigest !== expectedBinding.workspaceSha ||
    extensions.sourceRepository !== trust.repository ||
    extensions.sourceRef !== trust.sourceRef
  ) {
    throw new Error(`${name} provenance certificate GitHub source identity is not trusted`);
  }

  const envelope = bundle.dsseEnvelope;
  exactObject(envelope, ["payload", "payloadType", "signatures"], `${name} DSSE envelope`);
  if (envelope.payloadType !== "application/vnd.in-toto+json") {
    throw new Error(`${name} provenance payload type must be in-toto JSON`);
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw new Error(`${name} provenance must contain exactly one DSSE signature`);
  }
  exactObject(envelope.signatures[0], ["sig"], `${name} DSSE signature`);
  const payload = strictBase64(envelope.payload, `${name} DSSE payload`);
  const signature = strictBase64(envelope.signatures[0].sig, `${name} DSSE signature`);
  const signatureAlgorithm = leaf.publicKey.asymmetricKeyType === "ed25519" ? null : "sha256";
  if (
    !verify(
      signatureAlgorithm,
      dssePreAuthEncoding(envelope.payloadType, payload),
      leaf.publicKey,
      signature,
    )
  ) {
    throw new Error(`${name} provenance DSSE signature is invalid`);
  }
  const integratedAt = await verifyRekorTransparencyEntry(
    bundle.verificationMaterial.tlogEntries[0],
    {
      name,
      envelope,
      payload,
      leaf,
      trust,
      referenceTime,
    },
  );
  if (!certificateValidAt(leaf, integratedAt)) {
    throw new Error(
      `${name} provenance authenticated Rekor time is outside the signing certificate validity`,
    );
  }
  let statement;
  try {
    statement = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error(`${name} provenance payload is not valid JSON`);
  }
  validateProvenanceStatement(statement, {
    ...options,
    repository: trust.repository,
    workflowIdentity: trust.workflowIdentity,
    sourceRef: trust.sourceRef,
  });
}

function validateProvenanceStatement(statement, options) {
  const { name, digest, expectedBinding, repository } = options;
  exactObject(statement, ["_type", "subject", "predicateType", "predicate"], `${name} provenance`);
  if (
    statement._type !== INTOTO_STATEMENT_TYPE ||
    statement.predicateType !== HELIX_PAIRED_SOURCE_PROVENANCE_TYPE
  ) {
    throw new Error(`${name} provenance statement type is invalid`);
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error(`${name} provenance must contain exactly one subject`);
  }
  exactObject(statement.subject[0], ["name", "digest"], `${name} provenance subject`);
  exactObject(statement.subject[0].digest, ["sha256"], `${name} provenance subject digest`);
  if (
    statement.subject[0].name !== options.trust.subjectNames[name] ||
    statement.subject[0].digest.sha256 !== digest.slice("sha256:".length)
  ) {
    throw new Error(`${name} signed provenance subject does not match the promoted image`);
  }
  const predicate = statement.predicate;
  exactObject(predicate, ["schemaVersion", "workspace", "editors"], `${name} provenance predicate`);
  if (predicate.schemaVersion !== 1) throw new Error(`${name} provenance schema is invalid`);
  exactObject(predicate.workspace, ["repository", "sha"], `${name} workspace provenance`);
  exactObject(predicate.editors, ["repository", "sha"], `${name} editor provenance`);
  if (
    predicate.workspace.repository !== `https://github.com/${repository}` ||
    predicate.workspace.sha !== expectedBinding.workspaceSha ||
    predicate.editors.repository !== `https://github.com/${options.trust.editorsRepository}` ||
    predicate.editors.sha !== expectedBinding.editorsSha
  ) {
    throw new Error(`${name} provenance does not bind the exact workspace and editor revisions`);
  }
}

async function verifyRekorTransparencyEntry(entry, options) {
  const { name, envelope, payload, leaf, trust, referenceTime } = options;
  exactObject(
    entry,
    [
      "logIndex",
      "logId",
      "kindVersion",
      "integratedTime",
      "inclusionPromise",
      "inclusionProof",
      "canonicalizedBody",
    ],
    `${name} Rekor entry`,
  );
  exactObject(entry.logId, ["keyId"], `${name} Rekor log identity`);
  exactObject(entry.kindVersion, ["kind", "version"], `${name} Rekor entry kind`);
  if (entry.kindVersion.kind !== "dsse" || entry.kindVersion.version !== "0.0.1") {
    throw new Error(`${name} Rekor entry must use dsse v0.0.1`);
  }
  const logIndex = decimalSafeInteger(entry.logIndex, `${name} Rekor logIndex`);
  const integratedTime = decimalSafeInteger(entry.integratedTime, `${name} Rekor integratedTime`);
  const integratedAt = new Date(integratedTime * 1_000);
  freshTimestamp(
    integratedAt.toISOString(),
    referenceTime,
    24 * 60 * 60 * 1_000,
    `${name} authenticated Rekor integration`,
  );

  const rekorPublicKey = createPublicKey(await readFile(trust.rekorPublicKeyPath, "utf8"));
  if (!["ec", "ed25519", "rsa", "rsa-pss"].includes(rekorPublicKey.asymmetricKeyType)) {
    throw new Error(`${name} trusted Rekor public key type is unsupported`);
  }
  const computedLogId = createHash("sha256")
    .update(rekorPublicKey.export({ type: "spki", format: "der" }))
    .digest();
  const trustedLogId = hashBytes(trust.rekorLogId, `${name} trusted Rekor log ID`);
  const bundleLogId = strictBase64(entry.logId.keyId, `${name} Rekor bundle log ID`);
  if (
    bundleLogId.length !== 32 ||
    !bundleLogId.equals(computedLogId) ||
    !trustedLogId.equals(computedLogId)
  ) {
    throw new Error(`${name} Rekor log identity does not match protected trust`);
  }

  const canonicalizedBody = strictBase64(
    entry.canonicalizedBody,
    `${name} Rekor canonicalized body`,
  );
  validateRekorDsseBody(canonicalizedBody, { name, envelope, payload, leaf });

  exactObject(entry.inclusionPromise, ["signedEntryTimestamp"], `${name} Rekor inclusion promise`);
  const signedEntryTimestamp = strictBase64(
    entry.inclusionPromise.signedEntryTimestamp,
    `${name} Rekor signed entry timestamp`,
  );
  const setPayload = Buffer.from(
    JSON.stringify({
      body: entry.canonicalizedBody,
      integratedTime,
      logID: computedLogId.toString("hex"),
      logIndex,
    }),
  );
  if (!verifyRekorSignature(rekorPublicKey, setPayload, signedEntryTimestamp)) {
    throw new Error(`${name} Rekor signed entry timestamp is invalid`);
  }

  verifyRekorInclusionProof(entry.inclusionProof, {
    name,
    logIndex,
    leafBody: canonicalizedBody,
    publicKey: rekorPublicKey,
    logId: computedLogId,
    checkpointOrigin: trust.rekorCheckpointOrigin,
  });
  return integratedAt;
}

function validateRekorDsseBody(canonicalizedBody, options) {
  const { name, envelope, payload, leaf } = options;
  let body;
  try {
    body = JSON.parse(canonicalizedBody.toString("utf8"));
  } catch {
    throw new Error(`${name} Rekor canonicalized body is not valid JSON`);
  }
  if (JSON.stringify(body) !== canonicalizedBody.toString("utf8")) {
    throw new Error(`${name} Rekor body is not in its canonical retained form`);
  }
  exactObject(body, ["apiVersion", "kind", "spec"], `${name} Rekor body`);
  if (body.apiVersion !== "0.0.1" || body.kind !== "dsse") {
    throw new Error(`${name} Rekor body must use dsse v0.0.1`);
  }
  exactObject(body.spec, ["envelopeHash", "payloadHash", "signatures"], `${name} Rekor DSSE body`);
  validateRekorHash(
    body.spec.envelopeHash,
    Buffer.from(JSON.stringify(envelope)),
    `${name} Rekor envelope hash`,
  );
  validateRekorHash(body.spec.payloadHash, payload, `${name} Rekor payload hash`);
  if (!Array.isArray(body.spec.signatures) || body.spec.signatures.length !== 1) {
    throw new Error(`${name} Rekor body must bind exactly one DSSE signature`);
  }
  exactObject(
    body.spec.signatures[0],
    ["signature", "verifier"],
    `${name} Rekor DSSE signature binding`,
  );
  if (body.spec.signatures[0].signature !== envelope.signatures[0].sig) {
    throw new Error(`${name} Rekor body does not bind the retained DSSE signature`);
  }
  let loggedCertificate;
  try {
    loggedCertificate = new X509Certificate(
      strictBase64(body.spec.signatures[0].verifier, `${name} Rekor certificate binding`),
    );
  } catch {
    throw new Error(`${name} Rekor body contains an invalid signing certificate`);
  }
  if (!loggedCertificate.raw.equals(leaf.raw)) {
    throw new Error(`${name} Rekor body does not bind the retained signing certificate`);
  }
}

function validateRekorHash(value, content, label) {
  exactObject(value, ["algorithm", "value"], label);
  if (
    value.algorithm !== "sha256" ||
    value.value !== createHash("sha256").update(content).digest("hex")
  ) {
    throw new Error(`${label} does not match the retained provenance`);
  }
}

function verifyRekorInclusionProof(proof, options) {
  const { name, logIndex, leafBody, publicKey, logId, checkpointOrigin } = options;
  exactObject(
    proof,
    ["logIndex", "rootHash", "treeSize", "hashes", "checkpoint"],
    `${name} Rekor inclusion proof`,
  );
  const proofIndex = decimalSafeInteger(proof.logIndex, `${name} Rekor proof logIndex`);
  const treeSize = decimalSafeInteger(proof.treeSize, `${name} Rekor proof treeSize`);
  if (proofIndex !== logIndex || logIndex >= treeSize || treeSize < 1) {
    throw new Error(`${name} Rekor inclusion proof position is invalid`);
  }
  if (!Array.isArray(proof.hashes)) {
    throw new Error(`${name} Rekor inclusion proof hashes must be an array`);
  }
  const hashes = proof.hashes.map((value, index) => {
    const decoded = strictBase64(value, `${name} Rekor inclusion proof hash ${String(index)}`);
    if (decoded.length !== 32) {
      throw new Error(`${name} Rekor inclusion proof hash ${String(index)} is not SHA-256`);
    }
    return decoded;
  });
  const rootHash = strictBase64(proof.rootHash, `${name} Rekor inclusion root hash`);
  if (rootHash.length !== 32) throw new Error(`${name} Rekor inclusion root is not SHA-256`);
  const calculatedRoot = calculateMerkleRoot(
    createHash("sha256")
      .update(Buffer.concat([Buffer.from([0]), leafBody]))
      .digest(),
    logIndex,
    treeSize,
    hashes,
    `${name} Rekor inclusion proof`,
  );
  if (!calculatedRoot.equals(rootHash)) {
    throw new Error(`${name} Rekor inclusion proof does not bind the logged body`);
  }
  exactObject(proof.checkpoint, ["envelope"], `${name} Rekor checkpoint`);
  verifyRekorCheckpoint(proof.checkpoint.envelope, {
    name,
    treeSize,
    rootHash,
    publicKey,
    logId,
    checkpointOrigin,
  });
}

function calculateMerkleRoot(leafHash, index, treeSize, proof, label) {
  let current = leafHash;
  let nodeIndex = index;
  let lastNode = treeSize - 1;
  for (const sibling of proof) {
    if ((nodeIndex & 1) === 1 || nodeIndex === lastNode) {
      current = merkleNodeHash(sibling, current);
      while ((nodeIndex & 1) === 0 && nodeIndex !== 0) {
        nodeIndex = Math.floor(nodeIndex / 2);
        lastNode = Math.floor(lastNode / 2);
      }
    } else {
      current = merkleNodeHash(current, sibling);
    }
    nodeIndex = Math.floor(nodeIndex / 2);
    lastNode = Math.floor(lastNode / 2);
  }
  if (lastNode !== 0) throw new Error(`${label} has an invalid proof length`);
  return current;
}

function merkleNodeHash(left, right) {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([1]), left, right]))
    .digest();
}

function verifyRekorCheckpoint(envelope, options) {
  const { name, treeSize, rootHash, publicKey, logId, checkpointOrigin } = options;
  nonEmptyString(envelope, `${name} Rekor checkpoint envelope`);
  if (!envelope.endsWith("\n")) {
    throw new Error(`${name} Rekor checkpoint envelope must end with a newline`);
  }
  const separator = envelope.indexOf("\n\n");
  if (separator < 0) throw new Error(`${name} Rekor checkpoint envelope is malformed`);
  const signedText = envelope.slice(0, separator + 1);
  const signedLines = signedText.slice(0, -1).split("\n");
  if (
    signedLines.length !== 3 ||
    signedLines[0] !== checkpointOrigin ||
    decimalSafeInteger(signedLines[1], `${name} Rekor checkpoint tree size`) !== treeSize ||
    signedLines[2] !== rootHash.toString("base64")
  ) {
    throw new Error(`${name} Rekor checkpoint does not bind the inclusion root`);
  }
  const signatureLines = envelope.slice(separator + 2, -1).split("\n");
  const expectedSigner = checkpointOrigin.split(" ", 1)[0];
  if (signatureLines.length !== 1 || !signatureLines[0].startsWith(`— ${expectedSigner} `)) {
    throw new Error(`${name} Rekor checkpoint signer identity is not trusted`);
  }
  const noteSignature = strictBase64(
    signatureLines[0].slice(`— ${expectedSigner} `.length),
    `${name} Rekor checkpoint signature`,
  );
  if (
    noteSignature.length <= 4 ||
    !noteSignature.subarray(0, 4).equals(logId.subarray(0, 4)) ||
    !verifyRekorSignature(publicKey, Buffer.from(signedText), noteSignature.subarray(4))
  ) {
    throw new Error(`${name} Rekor checkpoint signature is invalid`);
  }
}

function verifyRekorSignature(publicKey, payload, signature) {
  const algorithm = publicKey.asymmetricKeyType === "ed25519" ? null : "sha256";
  return verify(algorithm, payload, publicKey, signature);
}

function decimalSafeInteger(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be a canonical decimal string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}

function hashBytes(value, label) {
  hash(value, label);
  return Buffer.from(value.slice("sha256:".length), "hex");
}
