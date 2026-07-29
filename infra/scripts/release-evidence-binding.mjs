export const RELEASE_EVIDENCE_BINDING_SCHEMA = "helix.release-evidence-binding.v1";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const OCI_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SENSITIVE_FIELD_PATTERN =
  /(?:authorization|cookie|credential|password|private.?key|secret|token)/iu;

export function createReleaseEvidenceBinding({
  workspaceSha,
  editorsSha,
  applicationImageDigest,
  webImageDigest,
}) {
  return validateReleaseEvidenceBinding({
    schema: RELEASE_EVIDENCE_BINDING_SCHEMA,
    workspaceSha,
    editorsSha,
    applicationImageDigest,
    webImageDigest,
  });
}

export function releaseEvidenceBindingFromEnvironment(environment = {}) {
  const values = {
    workspaceSha: environment.HELIX_RELEASE_WORKSPACE_SHA,
    editorsSha: environment.HELIX_RELEASE_EDITORS_SHA,
    applicationImageDigest: environment.HELIX_RELEASE_APPLICATION_IMAGE_DIGEST,
    webImageDigest: environment.HELIX_RELEASE_WEB_IMAGE_DIGEST,
  };
  const supplied = Object.values(values).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (supplied.length === 0) return undefined;
  if (supplied.length !== Object.keys(values).length) {
    throw new Error("release evidence binding environment is incomplete");
  }
  return createReleaseEvidenceBinding(values);
}

export function attachReleaseEvidenceBinding(evidence, binding) {
  if (binding !== undefined) {
    const validated = validateReleaseEvidenceBinding(binding);
    if (evidence.releaseBinding !== undefined) {
      validateReleaseEvidenceBinding(evidence.releaseBinding, validated);
    } else {
      evidence.releaseBinding = validated;
    }
  }
  return evidence;
}

export function validateOptionalReleaseEvidenceBinding(binding) {
  if (binding === undefined) return undefined;
  return validateReleaseEvidenceBinding(binding);
}

export function validateReleaseEvidenceBinding(binding, expected) {
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error("release evidence binding must be an object");
  }
  const keys = Object.keys(binding).sort();
  const expectedKeys = [
    "applicationImageDigest",
    "editorsSha",
    "schema",
    "webImageDigest",
    "workspaceSha",
  ].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("release evidence binding contains unexpected, missing, or secret-like fields");
  }
  for (const key of keys) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      throw new Error(`release evidence binding contains a secret-like field: ${key}`);
    }
  }
  if (binding.schema !== RELEASE_EVIDENCE_BINDING_SCHEMA) {
    throw new Error("invalid release evidence binding schema");
  }
  if (!SHA_PATTERN.test(binding.workspaceSha)) {
    throw new Error("release evidence binding workspace SHA must be 40 lowercase hex characters");
  }
  if (!SHA_PATTERN.test(binding.editorsSha)) {
    throw new Error("release evidence binding editors SHA must be 40 lowercase hex characters");
  }
  if (!OCI_DIGEST_PATTERN.test(binding.applicationImageDigest)) {
    throw new Error("release evidence binding application image must be an OCI sha256 digest");
  }
  if (!OCI_DIGEST_PATTERN.test(binding.webImageDigest)) {
    throw new Error("release evidence binding web image must be an OCI sha256 digest");
  }
  if (expected !== undefined) {
    for (const field of [
      "workspaceSha",
      "editorsSha",
      "applicationImageDigest",
      "webImageDigest",
    ]) {
      if (binding[field] !== expected[field]) {
        throw new Error(`release evidence binding ${field} does not match the promoted release`);
      }
    }
  }
  return binding;
}
