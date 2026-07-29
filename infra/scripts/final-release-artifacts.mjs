import { isoDate } from "./final-release-artifacts/validation-primitives.mjs";
import { validateCommon } from "./final-release-artifacts/common.mjs";
import {
  validateFullGates,
  validateMigration,
} from "./final-release-artifacts/gates-migration.mjs";
import {
  validateProductionConfig,
  validateSloSoak,
} from "./final-release-artifacts/config-slo.mjs";
import { validateSecurityReview } from "./final-release-artifacts/security.mjs";
import {
  validateBusinessReadiness,
  validateSupportReadiness,
} from "./final-release-artifacts/readiness.mjs";
import {
  validateProductionDecision,
  validateProtectedRepositoryState,
} from "./final-release-artifacts/protected-decision.mjs";

export {
  APPROVED_MVP_CORE_APPS,
  APPROVED_MVP_WEB_SURFACES,
  ARTIFACT_SCHEMAS,
  DISABLED_MVP_SURFACES,
  FINAL_ARTIFACT_SCHEMAS,
  REQUIRED_EDITORS_GATES,
  REQUIRED_PRODUCTION_IMAGES,
  REQUIRED_PRODUCTION_IMAGE_SUBJECTS,
  REQUIRED_WORKSPACE_GATES,
} from "./final-release-artifacts/constants.mjs";
export {
  canonicalJson,
  evidenceSetDigest,
  registerArtifactIdentity,
} from "./final-release-artifacts/validation-primitives.mjs";
export { validateSpdxDocument } from "./final-release-artifacts/retained-artifacts.mjs";

export async function validateFinalReleaseArtifacts({
  reports,
  expectedBinding,
  migrationHead,
  decisionPublicKeyPath,
  decisionSignerFingerprint,
  provenanceTrust,
  protectedStateTrust,
  expectedRepositoryState,
  generatedAt,
  evidenceSetSha256,
  availableEvidence,
}) {
  const referenceTime = isoDate(generatedAt, "manifest generatedAt");
  const artifactPaths = new Map();
  const artifactDigests = new Map();
  const artifactContext = { availableEvidence, artifactPaths, artifactDigests };
  const common = (name) => validateCommon(reports[name], name, expectedBinding, referenceTime);
  const fullGates = validateFullGates(
    common("fullGates"),
    expectedBinding,
    artifactContext,
    referenceTime,
  );
  const migration = validateMigration(
    common("migration"),
    migrationHead,
    expectedBinding,
    artifactContext,
    referenceTime,
  );
  const productionConfig = await validateProductionConfig(
    common("productionConfig"),
    expectedBinding,
    artifactContext,
    referenceTime,
    provenanceTrust,
  );
  const sloSoak = validateSloSoak(
    common("sloSoak"),
    expectedBinding,
    artifactContext,
    referenceTime,
  );
  const securityReview = validateSecurityReview(
    common("securityReview"),
    referenceTime,
    productionConfig.productionImages,
    expectedBinding,
    artifactContext,
  );
  const supportReadiness = validateSupportReadiness(
    common("supportReadiness"),
    expectedBinding,
    artifactContext,
    referenceTime,
  );
  const businessReadiness = validateBusinessReadiness(
    common("businessReadiness"),
    referenceTime,
    expectedBinding,
    artifactContext,
  );
  const protectedRepositoryState = await validateProtectedRepositoryState(
    common("protectedRepositoryState"),
    expectedBinding,
    expectedRepositoryState,
    protectedStateTrust,
    referenceTime,
  );
  const productionDecision = await validateProductionDecision(
    common("productionDecision"),
    decisionPublicKeyPath,
    decisionSignerFingerprint,
    evidenceSetSha256,
    referenceTime,
  );
  return {
    fullGates,
    migration,
    productionConfig,
    sloSoak,
    securityReview,
    supportReadiness,
    businessReadiness,
    protectedRepositoryState,
    productionDecision,
  };
}
