import { ARTIFACT_SCHEMAS } from "./constants.mjs";
import { validateArtifactReference } from "./retained-artifacts.mjs";
import {
  exactKeys,
  exactObject,
  finite,
  freshTimestamp,
  futureDate,
  isoDate,
  nonEmptyString,
  nonNegativeFinite,
  nonNegativeInteger,
  notAfter,
  orderedWindow,
  owner,
  passed,
  truth,
} from "./validation-primitives.mjs";

// Any non-zero count in these categories blocks the release outright, so the
// same list drives both the accepted incident-history shape and the gate.
const BLOCKING_INCIDENT_FIELDS = [
  "openSev1",
  "openSev2",
  "dataLossEvents",
  "crossTenantEvents",
  "malwareBypassEvents",
  "silentMailLossEvents",
  "unapprovedAgentWriteEvents",
];
const INCIDENT_HISTORY_WINDOW_FIELDS = ["startedAt", "completedAt"];

export function validateSupportReadiness(report, expectedBinding, artifactContext, referenceTime) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "supportOwner",
    "incidentOwner",
    "humanRotationAssigned",
    "runbookIndex",
    "limitations",
    "dogfood",
    "privatePilot",
    "incidentHistory",
  ]);
  passed(report.status, "support readiness status");
  owner(report.supportOwner, "support owner");
  owner(report.incidentOwner, "incident owner");
  truth(report.humanRotationAssigned, "human monitoring rotation");
  validateArtifactReference(
    report.runbookIndex,
    ARTIFACT_SCHEMAS.runbookIndex,
    "runbook index",
    artifactContext,
    { releaseBinding: expectedBinding, role: "production-runbook-index" },
  );
  validateArtifactReference(
    report.limitations,
    ARTIFACT_SCHEMAS.limitations,
    "limitations document",
    artifactContext,
    { releaseBinding: expectedBinding, role: "production-mvp-limitations" },
  );
  rolloutPeriod(report.dogfood, 14, "dogfood", "dogfood", expectedBinding, artifactContext);
  rolloutPeriod(
    report.privatePilot,
    28,
    "private pilot",
    "private-pilot",
    expectedBinding,
    artifactContext,
    true,
  );
  notAfter(report.dogfood.completedAt, report.generatedAt, "dogfood completion");
  notAfter(report.privatePilot.completedAt, report.generatedAt, "private pilot completion");
  freshTimestamp(
    report.privatePilot.completedAt,
    referenceTime,
    7 * 24 * 60 * 60 * 1_000,
    "private pilot completion",
  );
  if (Date.parse(report.privatePilot.startedAt) < Date.parse(report.dogfood.completedAt)) {
    throw new Error("private pilot must start after the dogfood exit review");
  }
  exactObject(
    report.incidentHistory,
    [...INCIDENT_HISTORY_WINDOW_FIELDS, "incidentCount", ...BLOCKING_INCIDENT_FIELDS],
    "incident history",
  );
  orderedWindow(
    report.incidentHistory.startedAt,
    report.incidentHistory.completedAt,
    "incident history",
  );
  notAfter(report.incidentHistory.completedAt, report.generatedAt, "incident history completion");
  freshTimestamp(
    report.incidentHistory.completedAt,
    referenceTime,
    7 * 24 * 60 * 60 * 1_000,
    "incident history completion",
  );
  if (
    Date.parse(report.incidentHistory.startedAt) > Date.parse(report.dogfood.startedAt) ||
    Date.parse(report.incidentHistory.completedAt) < Date.parse(report.privatePilot.completedAt)
  ) {
    throw new Error("incident history must cover the complete dogfood and private-pilot windows");
  }
  for (const field of Object.keys(report.incidentHistory).filter(
    (field) => !INCIDENT_HISTORY_WINDOW_FIELDS.includes(field),
  )) {
    nonNegativeInteger(report.incidentHistory[field], `incident history ${field}`);
  }
  for (const field of BLOCKING_INCIDENT_FIELDS) {
    if (report.incidentHistory[field] !== 0) {
      throw new Error(`support readiness has a blocking incident history: ${field}`);
    }
  }
  return {
    status: report.status,
    supportOwner: report.supportOwner,
    incidentOwner: report.incidentOwner,
    dogfoodDays: report.dogfood.durationDays,
    privatePilotDays: report.privatePilot.durationDays,
    incidentCount: report.incidentHistory.incidentCount,
  };
}

export function validateBusinessReadiness(report, referenceTime, expectedBinding, artifactContext) {
  exactKeys(report, [
    "schema",
    "generatedAt",
    "releaseBinding",
    "status",
    "currency",
    "monthlyEstimate",
    "perUserEstimate",
    "model",
    "limits",
    "risks",
  ]);
  passed(report.status, "business readiness status");
  if (!/^[A-Z]{3}$/u.test(report.currency)) throw new Error("cost currency must be ISO-style");
  nonNegativeFinite(report.monthlyEstimate, "monthly estimate");
  nonNegativeFinite(report.perUserEstimate, "per-user estimate");
  validateArtifactReference(
    report.model,
    ARTIFACT_SCHEMAS.costModel,
    "cost model",
    artifactContext,
    { releaseBinding: expectedBinding, role: "production-cost-model" },
  );
  exactObject(
    report.limits,
    [
      "organizations",
      "minimumUsers",
      "maximumUsers",
      "managedOutboundProvider",
      "directMx",
      "regulatedData",
      "agentWritesConfirmedByDefault",
      "nativeEditorsEnabled",
    ],
    "release limits",
  );
  const limits = report.limits;
  if (
    limits.organizations !== 1 ||
    limits.minimumUsers !== 5 ||
    limits.maximumUsers !== 50 ||
    limits.managedOutboundProvider !== true ||
    limits.directMx !== false ||
    limits.regulatedData !== false ||
    limits.agentWritesConfirmedByDefault !== true ||
    limits.nativeEditorsEnabled !== false
  ) {
    throw new Error("business limits do not match the approved MVP decisions");
  }
  if (!Array.isArray(report.risks)) throw new Error("accepted risks must be an array");
  const riskIds = new Set();
  for (const risk of report.risks) {
    exactObject(
      risk,
      ["riskId", "summary", "status", "owner", "expiresAt", "mitigation"],
      "accepted risk",
    );
    nonEmptyString(risk.riskId, "risk ID");
    nonEmptyString(risk.summary, "risk summary");
    if (!["accepted", "closed"].includes(risk.status)) throw new Error("risk status is invalid");
    owner(risk.owner, "risk owner");
    if (riskIds.has(risk.riskId)) throw new Error("accepted risk ID is duplicated");
    riskIds.add(risk.riskId);
    validateArtifactReference(
      risk.mitigation,
      ARTIFACT_SCHEMAS.riskMitigation,
      `risk ${risk.riskId} mitigation`,
      artifactContext,
      {
        releaseBinding: expectedBinding,
        role: "accepted-risk-mitigation",
        riskId: risk.riskId,
      },
    );
    if (risk.status === "accepted") futureDate(risk.expiresAt, referenceTime, "risk expiry");
    else isoDate(risk.expiresAt, "closed risk expiry");
  }
  return {
    status: report.status,
    currency: report.currency,
    monthlyEstimate: report.monthlyEstimate,
    maximumUsers: limits.maximumUsers,
    acceptedRiskCount: report.risks.filter(({ status }) => status === "accepted").length,
  };
}

function rolloutPeriod(
  period,
  minimumDays,
  label,
  phase,
  expectedBinding,
  artifactContext,
  privatePilot = false,
) {
  exactObject(
    period,
    [
      "status",
      "startedAt",
      "completedAt",
      "durationDays",
      "observations",
      "exitReview",
      ...(privatePilot ? ["independentSecurityReview"] : []),
    ],
    label,
  );
  passed(period.status, `${label} status`);
  const duration = orderedWindow(period.startedAt, period.completedAt, label);
  finite(period.durationDays, `${label} durationDays`);
  if (period.durationDays < minimumDays || duration < minimumDays * 24 * 60 * 60 * 1_000) {
    throw new Error(`${label} must cover at least ${minimumDays} days`);
  }
  validateArtifactReference(
    period.observations,
    ARTIFACT_SCHEMAS.rolloutObservations,
    `${label} observations`,
    artifactContext,
    { releaseBinding: expectedBinding, role: "rollout-observations", phase },
  );
  validateArtifactReference(
    period.exitReview,
    ARTIFACT_SCHEMAS.rolloutExitReview,
    `${label} exit review`,
    artifactContext,
    { releaseBinding: expectedBinding, role: "rollout-exit-review", phase },
  );
  if (privatePilot) {
    validateArtifactReference(
      period.independentSecurityReview,
      ARTIFACT_SCHEMAS.independentSecurityReview,
      "private pilot independent security review",
      artifactContext,
      {
        releaseBinding: expectedBinding,
        role: "independent-security-review",
        phase,
      },
    );
  }
}
