import { validateReleaseEvidenceBinding } from "../release-evidence-binding.mjs";
import { ARTIFACT_MAX_AGE_MS, FINAL_ARTIFACT_SCHEMAS } from "./constants.mjs";
import { isoDate, object, rejectSensitiveContent } from "./validation-primitives.mjs";

export function validateCommon(report, name, expectedBinding, referenceTime) {
  object(report, `${name} evidence`);
  rejectSensitiveContent(report, `${name} evidence`);
  const schema = FINAL_ARTIFACT_SCHEMAS[name];
  if (report.schema !== schema) throw new Error(`${name} evidence has an invalid schema`);
  isoDate(report.generatedAt, `${name}.generatedAt`);
  const age = referenceTime.getTime() - Date.parse(report.generatedAt);
  if (age < 0) {
    throw new Error(`${name} evidence cannot be generated after the manifest`);
  }
  if (age > ARTIFACT_MAX_AGE_MS[name]) {
    throw new Error(`${name} evidence is stale for final release`);
  }
  validateReleaseEvidenceBinding(report.releaseBinding, expectedBinding);
  return report;
}
