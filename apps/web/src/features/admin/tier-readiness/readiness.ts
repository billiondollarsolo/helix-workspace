/* Security tier readiness — projecting live backend requirements onto the
 * catalogue's readiness gates and service list.
 *
 * The platform measures readiness for the tier it is RUNNING and for no other.
 * So every gate on the screen is one of exactly two things, and they must never
 * be rendered alike:
 *
 *   measured     a live `BackendRequirement` — the platform looked and reported
 *                a status. This is the only thing that may carry a status, a
 *                percentage, or a blocking count.
 *   unevaluated  the tier catalogue says the tier wants this gate; nothing here
 *                has checked it. Carries no status at all.
 *
 * `statusByTier` in the catalogue is a hand-written guess at what a tier's gate
 * would say on some deployment. It used to be returned as `status` whenever the
 * backend was silent — which rendered as green "Ready" chips and a readiness
 * percentage for a platform nobody had measured. It is now read for one thing
 * only: whether the tier asks for the gate at all, which is a fact about the
 * tier definition rather than about this deployment. */

import {
  aiCostDefaultsByTier,
  readinessChecks,
  readinessRequirementKeyByCheckId,
} from "@/features/admin/tier-readiness/catalog";
import { formatKey, formatUsdLimit, formatValue } from "@/features/admin/tier-readiness/format";
import type {
  AICostAuditRow,
  AIConfigStatus,
  BackendReadinessStatus,
  BackendRequirement,
  CheckStatus,
  ReadinessCheck,
  RenderedReadinessCheck,
  RenderedService,
  RequiredService,
  RequirementField,
  ServiceStatus,
  TierId,
} from "@/features/admin/tier-readiness/types";

/** A gate the console can only *expect*. Deliberately has no `status` field:
 *  there is nothing to put in one, and an optional status would eventually be
 *  defaulted to something positive. */
export interface TierExpectation {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Whether the selected TIER asks for this gate — a property of the tier
   *  definition, not a measurement of this deployment. */
  readonly requiredByTier: boolean;
}

export interface TierGates {
  /** Gates the platform actually evaluated. Empty for any tier it is not
   *  running, because it evaluates nothing for those. */
  readonly measured: readonly RenderedReadinessCheck[];
  /** Gates the tier requires that nothing here has evaluated. */
  readonly unevaluated: readonly TierExpectation[];
}

export function readinessCheckFromBackend(requirement: BackendRequirement): RenderedReadinessCheck {
  return {
    id: requirement.key,
    title: requirement.label,
    detail: detailForBackendRequirement(requirement, fallbackBackendRequirementDetail(requirement)),
    expectedFields: formatRequirementFields(requirement.expected),
    observedFields: formatRequirementFields(requirement.observed),
    missing: requirement.missing,
    statusByTier: {
      personal: "not-required",
      business: "not-required",
      enterprise: "not-required",
      sovereign: "not-required",
    },
    status: backendStatusToCheckStatus(requirement.status),
  };
}

/** Splits a tier's gates into what the platform measured and what it did not.
 *
 *  `requirements === undefined` means the selected tier is not the one the
 *  platform is running (or there is no live config at all): every gate lands in
 *  `unevaluated`, and there is nothing to score. Passing a live list still
 *  yields expectations — a catalogue gate the backend did not report is exactly
 *  as unmeasured as one belonging to another tier, and giving it the
 *  catalogue's guess is how "Ready" appeared for gates nobody had checked. */
export function tierGatesForTier(
  tier: TierId,
  requirements: readonly BackendRequirement[] | undefined,
): TierGates {
  if (requirements === undefined) {
    return {
      measured: [],
      unevaluated: readinessChecks.map((check) => expectationFromCheck(check, tier)),
    };
  }

  const requirementByKey = new Map(
    requirements.map((requirement) => [requirement.key, requirement]),
  );
  const mappedRequirementKeys = new Set<string>();
  const measured: RenderedReadinessCheck[] = [];
  const unevaluated: TierExpectation[] = [];

  for (const check of readinessChecks) {
    const requirementKey = readinessRequirementKeyByCheckId[check.id];
    const requirement =
      requirementKey === undefined ? undefined : requirementByKey.get(requirementKey);
    if (requirement === undefined) {
      unevaluated.push(expectationFromCheck(check, tier));
      continue;
    }

    mappedRequirementKeys.add(requirement.key);
    measured.push(readinessCheckFromBackendRequirement(check, requirement));
  }

  for (const requirement of requirements) {
    if (!mappedRequirementKeys.has(requirement.key)) {
      measured.push(readinessCheckFromBackend(requirement));
    }
  }

  return { measured, unevaluated };
}

function expectationFromCheck(check: ReadinessCheck, tier: TierId): TierExpectation {
  return {
    id: check.id,
    title: check.title,
    detail: check.detail,
    requiredByTier: check.statusByTier[tier] !== "not-required",
  };
}

function readinessCheckFromBackendRequirement(
  check: ReadinessCheck,
  requirement: BackendRequirement,
): RenderedReadinessCheck {
  return {
    ...check,
    detail: detailForBackendRequirement(requirement, check.detail),
    expectedFields: formatRequirementFields(requirement.expected),
    observedFields: formatRequirementFields(requirement.observed),
    missing: requirement.missing,
    status: backendStatusToCheckStatus(requirement.status),
  };
}

function detailForBackendRequirement(requirement: BackendRequirement, fallback: string): string {
  const evidence = requirement.observed.evidence;
  return typeof evidence === "string" && evidence.trim().length > 0 ? evidence : fallback;
}

function fallbackBackendRequirementDetail(requirement: BackendRequirement): string {
  return requirement.required ? "Required for the current tier." : "Not required for this tier.";
}

export function backendStatusToCheckStatus(status: BackendReadinessStatus): CheckStatus {
  if (status === "ready") {
    return "ready";
  }
  if (status === "not_required") {
    return "not-required";
  }
  return status === "missing" ? "blocked" : "warning";
}

export function serviceFromBackendRequirement(
  service: RequiredService,
  requirement: BackendRequirement | undefined,
): RenderedService {
  if (requirement === undefined) {
    return service;
  }

  return {
    ...service,
    status: serviceStatusFromBackend(requirement.status),
    backendStatus: requirement.status,
    description:
      requirement.missing === undefined || requirement.missing.length === 0
        ? service.description
        : `${service.description}; missing ${requirement.missing.map(formatValue).join(", ")}`,
  };
}

export function serviceStatusFromBackend(status: BackendReadinessStatus): ServiceStatus {
  if (status === "ready" || status === "not_required") {
    return "configured";
  }
  if (status === "missing") {
    return "missing";
  }
  return "pending";
}

export function formatRequirementFields(
  value: Record<string, unknown>,
): readonly RequirementField[] {
  return Object.entries(value).map(([key, fieldValue]) => ({
    label: formatKey(key),
    value: formatValue(fieldValue),
  }));
}

/** What a posture row shows when the platform reported nothing for it. Not
 *  "off", not "on" — the backend did not say. */
const UNKNOWN = "Not reported";

/** The AI cost-limit rows shown in the tier audit table: tier default vs what
 *  the platform actually has configured, plus the evidence for each. */
export function aiCostAuditRowsForTier(
  tier: TierId,
  aiConfig: AIConfigStatus | undefined,
): readonly AICostAuditRow[] {
  const defaults = aiCostDefaultsByTier[tier];
  const configured = aiConfig?.costLimits;
  const audit = aiConfig?.audit;
  const privacy = aiConfig?.privacy;

  /* `tierDefault` and `configured` mean different things when a value is
   * absent, so they cannot share a formatter. The tier default comes from the
   * static catalogue, where "no limit recorded" IS the tier being unlimited —
   * a fact about the tier definition. The configured value comes from live
   * platform config, where absent means the platform did not report one, which
   * is not the same as reporting no cap.
   *
   * The evidence line has the same trap: "Using tier default" is only true
   * when the tier shown IS the tier the platform runs. Selecting a target tier
   * put a Business default beside a Personal live value and claimed the latter
   * came from the former. */
  const costRow = (
    id: string,
    label: string,
    tierDefaultValue: number | undefined,
    configuredValue: number | undefined,
  ): AICostAuditRow => ({
    id,
    label,
    tierDefault: formatUsdLimit(tierDefaultValue),
    configured: configuredValue === undefined ? UNKNOWN : formatUsdLimit(configuredValue),
    evidence:
      configuredValue === undefined ? "No limit reported by the platform" : "Live config override",
  });

  return [
    costRow(
      "per-user",
      "User daily AI cost",
      defaults?.perUserPerDayUSD,
      configured?.perUserPerDayUSD,
    ),
    costRow("per-org", "Org daily AI cost", defaults?.perOrgPerDayUSD, configured?.perOrgPerDayUSD),
    costRow(
      "per-agent",
      "Agent daily AI cost",
      defaults?.perAgentPerDayUSD,
      configured?.perAgentPerDayUSD,
    ),
    /* The two rows below describe security posture, so absent data must read as
     * unknown rather than as a positive finding. Both previously asserted one:
     * a missing `audit.logRequests` rendered "metadata-only", and
     * `classificationGating === false ? "Disabled" : "Enabled"` reported
     * "Enabled" for `undefined` — so with no AI config at all (including when
     * the config request failed) this table claimed request auditing and
     * external-provider gating were both on. */
    {
      id: "audit",
      label: "AI request audit",
      tierDefault: tier === "personal" ? "Metadata optional" : "Metadata required",
      configured: audit?.logRequests === undefined ? UNKNOWN : formatValue(audit.logRequests),
      evidence:
        audit?.retainDays === undefined
          ? "No AI audit config reported"
          : `${String(audit.retainDays)} day retention`,
    },
    {
      id: "classification",
      label: "Classification gating",
      tierDefault: tier === "personal" ? "Optional" : "Required for external providers",
      configured:
        privacy?.classificationGating === undefined
          ? UNKNOWN
          : privacy.classificationGating
            ? "Enabled"
            : "Disabled",
      evidence:
        privacy === undefined
          ? "No AI privacy config reported"
          : privacy.blockExternalForClassifications === undefined ||
              privacy.blockExternalForClassifications.length === 0
            ? "No external-AI classification blocks configured"
            : `Blocks ${privacy.blockExternalForClassifications.map(formatValue).join(", ")}`,
    },
  ];
}
