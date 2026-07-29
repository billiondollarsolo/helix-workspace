import {
  APPROVED_MVP_CORE_APPS,
  APPROVED_MVP_WEB_SURFACES,
  ARTIFACT_SCHEMAS,
  DISABLED_MVP_SURFACES,
  OCI_DIGEST_PATTERN,
  REQUIRED_PRODUCTION_IMAGES,
} from "./constants.mjs";
import { validateArtifactReference } from "./retained-artifacts.mjs";
import { validateImageProvenanceArtifact } from "./sigstore-rekor.mjs";
import {
  exactKeys,
  exactObject,
  exactStringSet,
  finite,
  freshTimestamp,
  hash,
  nonNegativeFinite,
  notAfter,
  object,
  orderedWindow,
  passed,
  positiveInteger,
  truth,
} from "./validation-primitives.mjs";

export async function validateProductionConfig(
  report,
  expectedBinding,
  artifactContext,
  referenceTime,
  provenanceTrust,
) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "environment",
    "resolved",
    "configurationSha256",
    "sourceCount",
    "unresolvedCount",
    "prohibitedValuesDetected",
    "mvpOnly",
    "mode",
    "securityTier",
    "coreApps",
    "webSurfaces",
    "disabledSurfaces",
    "featureControls",
    "productionImages",
    "imageProvenance",
  ]);
  passed(report.status, "production configuration status");
  if (report.environment !== "production" || report.resolved !== true || report.mvpOnly !== true) {
    throw new Error("production configuration must be resolved for the core Workspace MVP");
  }
  hash(report.configurationSha256, "production configuration digest");
  positiveInteger(report.sourceCount, "production configuration sourceCount");
  if (report.unresolvedCount !== 0 || report.prohibitedValuesDetected !== false) {
    throw new Error("production configuration contains unresolved or prohibited values");
  }
  if (report.mode !== "single-tenant" || report.securityTier !== "business") {
    throw new Error("production configuration must use the approved single-tenant Business tier");
  }
  exactStringSet(report.coreApps, APPROVED_MVP_CORE_APPS, "production core apps");
  exactStringSet(report.webSurfaces, APPROVED_MVP_WEB_SURFACES, "production web surfaces");
  exactStringSet(report.disabledSurfaces, DISABLED_MVP_SURFACES, "disabled MVP surfaces");
  exactObject(
    report.featureControls,
    [
      "mvpWebOnly",
      "editorMigrationsEnabled",
      "nativeEditorsEnabled",
      "fileEditingEnabled",
      "mailEnabled",
      "driveFileStorageEnabled",
      "serverReadableSecureChat",
      "agentWritesConfirmedByDefault",
    ],
    "production feature controls",
  );
  const expectedControls = {
    mvpWebOnly: true,
    editorMigrationsEnabled: false,
    nativeEditorsEnabled: false,
    fileEditingEnabled: false,
    mailEnabled: true,
    driveFileStorageEnabled: true,
    serverReadableSecureChat: true,
    agentWritesConfirmedByDefault: true,
  };
  for (const [field, expected] of Object.entries(expectedControls)) {
    if (report.featureControls[field] !== expected) {
      throw new Error(`production feature control ${field} violates the approved MVP boundary`);
    }
  }
  object(report.productionImages, "resolved production image inventory");
  exactKeys(report.productionImages, REQUIRED_PRODUCTION_IMAGES);
  for (const name of REQUIRED_PRODUCTION_IMAGES) {
    const digest = report.productionImages[name];
    if (!OCI_DIGEST_PATTERN.test(digest)) {
      throw new Error(`resolved production image ${name} must use an immutable OCI digest`);
    }
    if (
      (name === "application" && digest !== expectedBinding.applicationImageDigest) ||
      (name === "web" && digest !== expectedBinding.webImageDigest)
    ) {
      throw new Error(`resolved production image ${name} does not match the promoted release`);
    }
  }
  exactObject(report.imageProvenance, ["application", "web"], "production image provenance");
  for (const [name, digest] of [
    ["application", expectedBinding.applicationImageDigest],
    ["web", expectedBinding.webImageDigest],
  ]) {
    const retained = validateArtifactReference(
      report.imageProvenance[name],
      ARTIFACT_SCHEMAS.imageProvenance,
      `${name} image provenance`,
      artifactContext,
    );
    await validateImageProvenanceArtifact(retained.document, {
      name,
      digest,
      expectedBinding,
      referenceTime,
      trust: provenanceTrust,
    });
  }
  return {
    status: report.status,
    configurationSha256: report.configurationSha256,
    sourceCount: report.sourceCount,
    mvpOnly: true,
    mode: report.mode,
    securityTier: report.securityTier,
    coreApps: [...report.coreApps].sort(),
    webSurfaces: [...report.webSurfaces].sort(),
    disabledSurfaces: [...report.disabledSurfaces].sort(),
    featureControls: report.featureControls,
    productionImages: { ...report.productionImages },
    imageProvenance: Object.fromEntries(
      Object.entries(report.imageProvenance).map(([name, reference]) => [
        name,
        { path: reference.path, sha256: reference.sha256 },
      ]),
    ),
  };
}

export function validateSloSoak(report, expectedBinding, artifactContext, referenceTime) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "window",
    "profile",
    "objectives",
    "noUnboundedMemoryGrowth",
    "stuckJobs",
    "telemetry",
    "report",
  ]);
  passed(report.status, "SLO/soak status");
  exactObject(report.window, ["startedAt", "completedAt", "durationHours"], "soak window");
  const duration = orderedWindow(report.window.startedAt, report.window.completedAt, "soak window");
  notAfter(report.window.completedAt, report.generatedAt, "soak completion");
  freshTimestamp(
    report.window.completedAt,
    referenceTime,
    7 * 24 * 60 * 60 * 1_000,
    "soak completion",
  );
  finite(report.window.durationHours, "soak durationHours");
  if (report.window.durationHours < 24 || duration < 24 * 60 * 60 * 1_000) {
    throw new Error("final release requires a real window of at least 24 hours");
  }
  exactObject(
    report.profile,
    [
      "users",
      "browserSockets",
      "representativeMail",
      "driveMaximumObjectBytes",
      "concurrentMcpReads",
      "pendingAgentWrites",
    ],
    "soak profile",
  );
  positiveInteger(report.profile.users, "soak profile users");
  positiveInteger(report.profile.browserSockets, "soak profile browserSockets");
  if (
    report.profile.users < 5 ||
    report.profile.users > 50 ||
    report.profile.browserSockets < 100
  ) {
    throw new Error("soak profile must cover 5-50 users and at least 100 browser sockets");
  }
  truth(report.profile.representativeMail, "soak representative Mail traffic");
  if (report.profile.driveMaximumObjectBytes < 1_073_741_824) {
    throw new Error("soak profile must include Drive objects through 1 GiB");
  }
  positiveInteger(report.profile.driveMaximumObjectBytes, "soak Drive maximum object bytes");
  positiveInteger(report.profile.concurrentMcpReads, "soak concurrent MCP reads");
  positiveInteger(report.profile.pendingAgentWrites, "soak pending agent writes");
  exactObject(
    report.objectives,
    [
      "availabilityPercent",
      "apiReadP95Ms",
      "apiMetadataWriteP95Ms",
      "chatVisibleP95Ms",
      "mailAcceptanceP95Ms",
    ],
    "SLO objectives",
  );
  const limits = {
    availabilityPercent: [99.5, 100],
    apiReadP95Ms: [0, 500],
    apiMetadataWriteP95Ms: [0, 750],
    chatVisibleP95Ms: [0, 2_000],
    mailAcceptanceP95Ms: [0, 60_000],
  };
  for (const [field, [minimum, maximum]] of Object.entries(limits)) {
    finite(report.objectives[field], `SLO ${field}`);
    if (report.objectives[field] < minimum || report.objectives[field] > maximum) {
      throw new Error(`SLO ${field} does not meet the release objective`);
    }
  }
  truth(report.noUnboundedMemoryGrowth, "soak memory bound");
  if (report.stuckJobs !== 0) throw new Error("soak evidence reports stuck jobs");
  exactObject(
    report.telemetry,
    [
      "p99LatencyMs",
      "errorRatePercent",
      "memoryGrowthBytes",
      "eventLoopLagP99Ms",
      "dbPoolPendingPeak",
      "redisBacklogPeak",
      "natsBacklogPeak",
      "queueAgeP95Ms",
      "scanConcurrencyPeak",
    ],
    "soak telemetry",
  );
  for (const [field, value] of Object.entries(report.telemetry)) {
    nonNegativeFinite(value, `soak telemetry ${field}`);
  }
  if (report.telemetry.errorRatePercent > 100) {
    throw new Error("soak telemetry errorRatePercent cannot exceed 100");
  }
  positiveInteger(report.telemetry.scanConcurrencyPeak, "soak scan concurrency peak");
  validateArtifactReference(
    report.report,
    ARTIFACT_SCHEMAS.soakReport,
    "SLO/soak report artifact",
    artifactContext,
    { releaseBinding: expectedBinding, role: "production-slo-soak-report" },
  );
  return {
    status: report.status,
    durationHours: report.window.durationHours,
    ...report.objectives,
  };
}
