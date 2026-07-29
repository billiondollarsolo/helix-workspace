import { describe, expect, it } from "vitest";
import {
  RELEASE_EVIDENCE_BINDING_SCHEMA,
  attachReleaseEvidenceBinding,
  createReleaseEvidenceBinding,
  releaseEvidenceBindingFromEnvironment,
  validateReleaseEvidenceBinding,
} from "./release-evidence-binding.mjs";

const expected = {
  workspaceSha: "a".repeat(40),
  editorsSha: "d".repeat(40),
  applicationImageDigest: `sha256:${"b".repeat(64)}`,
  webImageDigest: `sha256:${"c".repeat(64)}`,
};

describe("release evidence binding", () => {
  it("creates and attaches the exact canonical binding", () => {
    const binding = createReleaseEvidenceBinding(expected);
    expect(binding).toEqual({ schema: RELEASE_EVIDENCE_BINDING_SCHEMA, ...expected });
    expect(attachReleaseEvidenceBinding({ status: "passed" }, binding)).toEqual({
      status: "passed",
      releaseBinding: binding,
    });
  });

  it("requires all environment values together while leaving developer mode optional", () => {
    expect(releaseEvidenceBindingFromEnvironment({})).toBeUndefined();
    expect(() =>
      releaseEvidenceBindingFromEnvironment({
        HELIX_RELEASE_WORKSPACE_SHA: expected.workspaceSha,
      }),
    ).toThrow("incomplete");
    expect(
      releaseEvidenceBindingFromEnvironment({
        HELIX_RELEASE_WORKSPACE_SHA: expected.workspaceSha,
        HELIX_RELEASE_EDITORS_SHA: expected.editorsSha,
        HELIX_RELEASE_APPLICATION_IMAGE_DIGEST: expected.applicationImageDigest,
        HELIX_RELEASE_WEB_IMAGE_DIGEST: expected.webImageDigest,
      }),
    ).toEqual({ schema: RELEASE_EVIDENCE_BINDING_SCHEMA, ...expected });
  });

  it("fails closed on malformed, mismatched, and secret-like fields", () => {
    const binding = createReleaseEvidenceBinding(expected);
    expect(() =>
      validateReleaseEvidenceBinding(binding, { ...expected, workspaceSha: "d".repeat(40) }),
    ).toThrow("does not match");
    expect(() =>
      validateReleaseEvidenceBinding({ ...binding, signingSecret: "must-not-persist" }),
    ).toThrow("unexpected, missing, or secret-like");
    expect(() =>
      validateReleaseEvidenceBinding({ ...binding, applicationImageDigest: "latest" }),
    ).toThrow("OCI sha256");
  });
});
