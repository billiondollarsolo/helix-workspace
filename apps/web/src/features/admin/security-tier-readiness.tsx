/* Admin security tier readiness: live tier, target gates, and confirmed changes. */

import { AdminSecurityRelatedNav } from "@/features/admin/admin-related-nav";
import {
  resolveClosedSearchParam,
  useAdminSectionSearch,
} from "@/features/admin/admin-section-search";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { PageHeading, StateBanner } from "@/features/admin/console/primitives";
import {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
  updatePlatformTier,
} from "@/features/admin/tier-readiness/api";
import {
  serviceById,
  serviceRequirementKeyById,
  statusText,
  tiers,
} from "@/features/admin/tier-readiness/catalog";
import {
  backendStatusText,
  formatValue,
  titleForTier,
} from "@/features/admin/tier-readiness/format";

import {
  serviceFromBackendRequirement,
  tierGatesForTier,
} from "@/features/admin/tier-readiness/readiness";
import type {
  CheckStatus,
  PlatformConfigStatus,
  RenderedReadinessCheck,
  RequirementField,
  TierId,
} from "@/features/admin/tier-readiness/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AlertTriangle, CheckCircle2, CircleDashed, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

export {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
  prefetchAdminReadinessQueries,
} from "@/features/admin/tier-readiness/api";
export {
  aiCostAuditRowsForTier,
  backendStatusToCheckStatus,
  formatRequirementFields,
  readinessCheckFromBackend,
  serviceFromBackendRequirement,
  serviceStatusFromBackend,
  tierGatesForTier,
} from "@/features/admin/tier-readiness/readiness";
export type { PlatformConfigPatch, TierId } from "@/features/admin/tier-readiness/types";

const TIER_IDS = [
  "personal",
  "business",
  "enterprise",
  "sovereign",
] as const satisfies readonly TierId[];

export function SecurityTierReadiness() {
  const { search, patchSearch } = useAdminSectionSearch("tier-readiness");
  const [tierConfirmOpen, setTierConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const platformConfigQuery = useQuery(adminPlatformConfigQueryOptions());
  const liveTier = platformConfigQuery.data?.config.security.tier;

  /* URL `?tier=` wins when present; otherwise follow the live platform tier. */
  const selectedTierId: TierId = resolveClosedSearchParam(
    search.tier,
    TIER_IDS,
    liveTier ?? "business",
  );
  const setSelectedTierId = (tier: TierId) => {
    patchSearch({ tier });
  };
  const tierMutation = useMutation({
    mutationFn: updatePlatformTier,
    onMutate: async (tier) => {
      await queryClient.cancelQueries({ queryKey: adminPlatformConfigQueryKey });
      const previousPlatformConfig = queryClient.getQueryData<PlatformConfigStatus>(
        adminPlatformConfigQueryKey,
      );

      queryClient.setQueryData<PlatformConfigStatus | undefined>(
        adminPlatformConfigQueryKey,
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                config: {
                  ...current.config,
                  security: {
                    ...current.config.security,
                    tier,
                  },
                },
              },
      );

      return { previousPlatformConfig };
    },
    onError: (_error, _tier, context) => {
      if (context?.previousPlatformConfig !== undefined) {
        queryClient.setQueryData(adminPlatformConfigQueryKey, context.previousPlatformConfig);
      }
    },
    onSuccess: (status) => {
      queryClient.setQueryData(adminPlatformConfigQueryKey, status);
      setSelectedTierId(status.config.security.tier);
    },
    onSettled: () => {
      // Closes on failure too — "Could not apply the tier draft." renders in
      // the panel behind the dialog, so an open dialog would hide it.
      setTierConfirmOpen(false);
    },
  });

  const selectedTier = tiers.find((tier) => tier.id === selectedTierId) ?? tiers[1];
  if (selectedTier === undefined) {
    throw new Error(`Unknown security tier: ${selectedTierId}`);
  }

  const backendStatus = platformConfigQuery.data;
  /* The platform evaluates readiness for the tier it is RUNNING and for nothing
     else, so this is `undefined` for every other target tier — which is the
     usual case on this screen, since picking a target tier is its point. */
  const measuredRequirements =
    backendStatus !== undefined && backendStatus.config.security.tier === selectedTierId
      ? backendStatus.readiness.requirements
      : undefined;
  /* Three states, and the two unscored ones are NOT the same thing:
     - "unscoreable": the config API gave us nothing usable, so we cannot even
       say which tier is live.
     - "not-evaluated": the platform is live and answering, but the operator is
       looking at a tier it does not run. The catalogue still knows which gates
       that tier requires; nothing knows whether this deployment meets them.
     Neither may produce a score, and both must confirm before applying — but
     "backend unavailable" is the wrong sentence to show an operator whose
     backend is fine and simply has not measured the tier they picked. */
  const readinessMode: "measured" | "not-evaluated" | "unscoreable" =
    platformConfigQuery.isError || backendStatus === undefined
      ? "unscoreable"
      : measuredRequirements === undefined
        ? "not-evaluated"
        : "measured";
  const requiredServiceList = useMemo(() => {
    if (platformConfigQuery.isError) {
      return [];
    }
    return selectedTier.requiredServiceIds
      .map((serviceId) => serviceById.get(serviceId))
      .filter((service) => service !== undefined)
      .map((service) =>
        serviceFromBackendRequirement(
          service,
          measuredRequirements?.find(
            (requirement) => requirement.key === serviceRequirementKeyById[service.id],
          ),
        ),
      );
  }, [measuredRequirements, platformConfigQuery.isError, selectedTier]);
  const tierGates = useMemo(
    () => tierGatesForTier(selectedTierId, measuredRequirements),
    [measuredRequirements, selectedTierId],
  );
  /* Measured gates carry statuses; expectations never do. With no usable config
     we show neither — the screen's job then is to report the outage, not to
     page through catalogue text about a platform it cannot reach. */
  const measuredChecks = readinessMode === "measured" ? tierGates.measured : [];
  const unevaluatedGates = readinessMode === "unscoreable" ? [] : tierGates.unevaluated;
  /* `null` means "we cannot score this", never "nothing is wrong".
   *
   * Scoring covers the gates the platform actually measured and nothing else. A
   * percentage over an empty set is the bug this guards: zero ready divided by
   * zero actionable printed "100%" and "0 blocking" — a clean bill of health for
   * a platform nobody had looked at. Both the config outage and a target tier
   * the platform has not evaluated land there, so both stay unscored.
   *
   * Measured gates that are all `not-required` are different: the platform did
   * look, and Tier 1 legitimately has almost nothing to satisfy. That is 100%. */
  const readiness = useMemo(() => {
    if (readinessMode !== "measured" || measuredChecks.length === 0) {
      return null;
    }
    const actionable = measuredChecks.filter((check) => check.status !== "not-required");
    const ready = actionable.filter((check) => check.status === "ready").length;
    return {
      /* `actionable.length === 0` here is NOT the empty-list bug this file was
         audited for: the guard above already returned null unless the platform
         measured at least one gate. Reaching this line means it looked and
         graded every gate `not_required`, which is genuinely 100% — nothing
         required, nothing blocking. The bug was scoring an unmeasured list. */
      percent: actionable.length === 0 ? 100 : Math.round((ready / actionable.length) * 100),
      blocking: measuredChecks.filter((check) => check.status === "blocked").length,
    };
  }, [measuredChecks, readinessMode]);
  const blockingChecks = useMemo(
    () => measuredChecks.filter((check) => check.status === "blocked"),
    [measuredChecks],
  );
  /* `readiness === null` is "we could not score this platform", and treating it
     as "nothing is blocking" is the same mistake the old 100%-for-no-data score
     made — so an unscored tier confirms too.
     Confirmation is what makes de-emphasising the button safe: the action stays
     reachable for the operator who legitimately stages a tier ahead of its
     gates, it just stops being the page's loudest control. */
  const applyNeedsConfirmation = readiness === null || blockingChecks.length > 0;
  const selectedTierTitle = titleForTier(selectedTierId);
  const currentTierTitle =
    backendStatus === undefined ? "Unavailable" : titleForTier(backendStatus.config.security.tier);
  /* One sentence for the third state, reused by the score's label, the note
     under Apply, and the confirmation's blast radius, so the operator reads the
     same explanation wherever they meet it. */
  const notEvaluatedReason = `${selectedTierTitle} is not the tier this platform runs (${currentTierTitle}), and readiness is only reported for the live tier`;
  const isLiveTierSelected =
    backendStatus !== undefined && backendStatus.config.security.tier === selectedTierId;
  /* One three-way state behind both the score's accessible name and its visible
     caption, so a screen reader and the page cannot end up describing different
     readiness states. */
  const scoreSummary =
    readiness !== null
      ? {
          label: `${readiness.percent}% readiness, ${readiness.blocking} blocking`,
          caption: `${readiness.blocking} blocking`,
        }
      : readinessMode === "not-evaluated"
        ? {
            label: `Readiness for ${selectedTierTitle} not evaluated — ${notEvaluatedReason}`,
            caption: "not evaluated",
          }
        : {
            label: "Readiness unknown — no live platform config",
            caption: "readiness unknown",
          };
  const readinessSummaryText = summariseReadiness({
    isPending: platformConfigQuery.isPending,
    backendStatus,
    readinessMode,
    readiness,
    selectedTierTitle,
  });

  return (
    /* No `role="main"`: SurfaceFrame / PageScroll already own the page shell. */
    <section className="admin-tier-page grid gap-4">
      <PageHeading
        title="Tier readiness"
        subtitle="See the live security tier, pick a target, review gates that block it, and apply when ready."
        meta={
          <div
            className="admin-tier-score"
            data-unknown={readiness === null ? "" : undefined}
            aria-label={scoreSummary.label}
          >
            <strong>{readiness === null ? "—" : `${readiness.percent}%`}</strong>
            <span>{scoreSummary.caption}</span>
          </div>
        }
      />
      <AdminSecurityRelatedNav current="tier-readiness" />

      <p className="admin-tier-live-status m-0 text-sm text-muted-foreground" role="status">
        {platformConfigQuery.isPending
          ? "Loading platform config"
          : backendStatus !== undefined
            ? `Live platform config connected · live tier ${currentTierTitle}`
            : "Admin config API unavailable or unauthorized"}
      </p>

      <div id="tier-panel-readiness" className="grid gap-4">
        <div className="admin-tier-selector" aria-label="Target security tier" role="group">
          {tiers.map((tier) => {
            const isSelected = tier.id === selectedTierId;
            const isLive = liveTier === tier.id;
            return (
              <button
                className={isSelected ? "selected" : ""}
                key={tier.id}
                onClick={() => setSelectedTierId(tier.id)}
                disabled={tierMutation.isPending}
                type="button"
                aria-pressed={isSelected}
              >
                <span>{tier.shortName}</span>
                <strong>{tier.title}</strong>
                <small>{isLive ? "Live on this platform" : tier.target}</small>
              </button>
            );
          })}
        </div>

        {!isLiveTierSelected && backendStatus !== undefined ? (
          <StateBanner kind="info">
            You are reviewing <strong>{selectedTierTitle}</strong>. The platform is running{" "}
            <strong>{currentTierTitle}</strong>, so gates below are catalogue requirements — not
            live measurements — until you apply this tier.
          </StateBanner>
        ) : null}

        <div className="admin-tier-grid">
          <section
            className="admin-tier-panel admin-tier-readiness"
            aria-labelledby="readiness-title"
          >
            <div className="admin-tier-panel-header">
              <div>
                <p className="admin-tier-kicker">Gates</p>
                <h2 id="readiness-title">
                  {selectedTier.shortName}: {selectedTier.title}
                </h2>
                <p>{selectedTier.serviceSummary}</p>
              </div>
              {readiness === null ? null : (
                <div className="admin-tier-progress" aria-hidden="true">
                  <span style={{ width: `${readiness.percent}%` }} />
                </div>
              )}
            </div>

            <div className="admin-check-list">
              {readinessMode === "unscoreable" ? (
                <p>
                  Readiness gates are unavailable until the admin config API returns a valid
                  response.
                </p>
              ) : null}
              {measuredChecks.map((check) => (
                <article className="admin-check-row" data-status={check.status} key={check.id}>
                  <StatusIcon status={check.status} />
                  <div>
                    <h3>{check.title}</h3>
                    {check.detail.length > 0 ? <p>{check.detail}</p> : null}
                    <RequirementFacts check={check} />
                  </div>
                  <span>{statusText[check.status]}</span>
                </article>
              ))}
              {unevaluatedGates.length === 0 ? null : (
                <div
                  aria-label={`Gates not evaluated for ${selectedTierTitle}`}
                  className="admin-check-list"
                  role="group"
                >
                  <p>
                    {readinessMode === "not-evaluated"
                      ? `${notEvaluatedReason}. These are the gates ${selectedTierTitle} requires, from this console's tier catalogue — not measurements of this deployment.`
                      : `The platform reported no result for these gates, so nothing here has evaluated them.`}
                  </p>
                  {unevaluatedGates.map((gate) => (
                    <article className="admin-check-row" data-status="unknown" key={gate.id}>
                      <CircleDashed aria-hidden="true" size={20} />
                      <div>
                        <h3>{gate.title}</h3>
                        {gate.detail.length > 0 ? <p>{gate.detail}</p> : null}
                      </div>
                      <span>
                        {gate.requiredByTier ? "Not evaluated" : "Not required at this tier"}
                      </span>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>

          <aside className="admin-tier-panel admin-tier-summary" aria-labelledby="summary-title">
            <p className="admin-tier-kicker">Apply</p>
            <h2 id="summary-title">{currentTierTitle} platform state</h2>
            <dl>
              <div>
                <dt>Selected tier</dt>
                <dd>{selectedTierTitle}</dd>
              </div>
              <div>
                <dt>Live tier</dt>
                <dd>{currentTierTitle}</dd>
              </div>
              <div>
                <dt>Readiness</dt>
                <dd>{readinessSummaryText}</dd>
              </div>
              <div>
                <dt>Backend requirements</dt>
                <dd>
                  {platformConfigQuery.isPending
                    ? "Loading"
                    : backendStatus === undefined
                      ? "Unavailable"
                      : measuredRequirements === undefined
                        ? `Live gates only for ${currentTierTitle}`
                        : `${measuredRequirements.length} live gates`}
                </dd>
              </div>
            </dl>
            <p className="admin-tier-live-status-row" role="status">
              {platformConfigQuery.isPending ? (
                <CircleDashed aria-hidden="true" size={16} />
              ) : (
                <ShieldCheck aria-hidden="true" size={16} />
              )}
              {platformConfigQuery.isPending
                ? "Loading config API"
                : backendStatus !== undefined
                  ? "Config API connected"
                  : "Config API unavailable"}
            </p>
            <button
              aria-describedby={applyNeedsConfirmation ? "apply-tier-note" : undefined}
              className={
                applyNeedsConfirmation ? "helix-button helix-button-secondary" : "helix-button"
              }
              disabled={tierMutation.isPending || backendStatus === undefined}
              onClick={() => {
                if (applyNeedsConfirmation) {
                  setTierConfirmOpen(true);
                  return;
                }
                tierMutation.mutate(selectedTierId);
              }}
              type="button"
            >
              Apply tier draft
            </button>
            {applyNeedsConfirmation ? (
              <p className="admin-tier-apply-note" id="apply-tier-note">
                {readiness !== null
                  ? `${blockingSummary(blockingChecks.length, selectedTierTitle)}. Applying it asks you to confirm first.`
                  : readinessMode === "not-evaluated"
                    ? `${selectedTierTitle} has not been evaluated on this platform — it reports gates only for ${currentTierTitle}. Applying it asks you to confirm first.`
                    : `Readiness for ${selectedTierTitle} could not be scored. Applying it asks you to confirm first.`}
              </p>
            ) : null}
            <ConfirmDestructive
              open={tierConfirmOpen}
              onOpenChange={setTierConfirmOpen}
              title={`Apply ${selectedTierTitle} tier`}
              blastRadius={
                blockingChecks.length > 0
                  ? `${blockingSummary(blockingChecks.length, selectedTierTitle)}: ${blockingChecks
                      .map((check) => check.title)
                      .join(", ")}. Applying the tier does not clear them.`
                  : readinessMode === "not-evaluated"
                    ? `Nothing has evaluated this platform against ${selectedTierTitle}: ${notEvaluatedReason}. The ${String(unevaluatedGates.length)} gates listed are what the tier requires, not what was measured here.`
                    : `Readiness for ${selectedTierTitle} could not be scored — the admin config API returned no usable gate data, so nothing has verified that this platform meets the tier.`
              }
              confirmLabel={`Apply ${selectedTierTitle}`}
              isPending={tierMutation.isPending}
              onConfirm={() => tierMutation.mutate(selectedTierId)}
            >
              Sets this deployment&apos;s security tier to {selectedTierTitle}. The configuration is
              applied whether or not the platform currently satisfies the tier&apos;s readiness
              gates.
            </ConfirmDestructive>
            {tierMutation.isError ? <p role="alert">Could not apply the tier draft.</p> : null}
            {platformConfigQuery.isError ? (
              <p role="alert">
                {platformConfigQuery.error instanceof Error
                  ? platformConfigQuery.error.message
                  : "Admin config API is unavailable or missing admin config scope."}
              </p>
            ) : null}
          </aside>
        </div>

        <section className="admin-tier-panel" aria-labelledby="services-title">
          <div className="admin-tier-panel-header">
            <div>
              <p className="admin-tier-kicker">Services</p>
              <h2 id="services-title">Runtime dependencies for {selectedTier.title}</h2>
              <p>
                {platformConfigQuery.isPending
                  ? "Loading platform config."
                  : readinessMode === "unscoreable"
                    ? "Connect the admin config API to see backend-managed service health."
                    : readinessMode === "not-evaluated"
                      ? `No service here has been checked against ${selectedTier.title}: gates are reported only for the live tier (${currentTierTitle}).`
                      : "Live readiness gates are reflected for backend-managed services only. Cards without a live gate stay “Not verified”."}
              </p>
            </div>
          </div>
          <div className="admin-service-grid">
            {requiredServiceList.length === 0 ? (
              <p>
                Service gates are unavailable until the admin config API returns a valid response.
              </p>
            ) : (
              requiredServiceList.map((service) => (
                <article
                  className="admin-service-card"
                  data-status={service.backendStatus === undefined ? "unknown" : service.status}
                  key={service.id}
                >
                  <service.icon aria-hidden="true" size={20} />
                  <div>
                    <h3>{service.name}</h3>
                    <p>{service.description}</p>
                  </div>
                  <span>
                    {service.backendStatus === undefined
                      ? "Not verified"
                      : backendStatusText(service.backendStatus)}
                  </span>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

/** The summary panel's Readiness line. The three unscored states each get their
 *  own sentence: "Backend unavailable" is not the same as a live platform that
 *  simply has not measured the tier the operator picked, and neither is a tier
 *  the platform measured but reported no gates for. */
function summariseReadiness({
  isPending,
  backendStatus,
  readinessMode,
  readiness,
  selectedTierTitle,
}: {
  readonly isPending: boolean;
  readonly backendStatus: PlatformConfigStatus | undefined;
  readonly readinessMode: "measured" | "not-evaluated" | "unscoreable";
  readonly readiness: { readonly percent: number; readonly blocking: number } | null;
  readonly selectedTierTitle: string;
}): string {
  if (isPending) {
    return "Loading";
  }
  if (backendStatus === undefined || readinessMode === "unscoreable") {
    return "Backend unavailable";
  }
  if (readinessMode === "not-evaluated") {
    return `Not evaluated for ${selectedTierTitle}`;
  }
  if (readiness === null) {
    return "No gates reported";
  }
  return backendStatus.readiness.ready ? "Ready" : `${readiness.blocking} blocking`;
}
/** "2 readiness gates block Enterprise" — the count and the tier in one clause,
 *  reused by the button's caption and the confirmation's blast radius so the
 *  operator reads the same sentence in both places. */
function blockingSummary(count: number, tierTitle: string): string {
  return count === 1
    ? `1 readiness gate blocks ${tierTitle}`
    : `${String(count)} readiness gates block ${tierTitle}`;
}

function StatusIcon({ status }: { readonly status: CheckStatus }) {
  if (status === "ready") {
    return <CheckCircle2 aria-hidden="true" size={20} />;
  }

  if (status === "blocked") {
    return <AlertTriangle aria-hidden="true" size={20} />;
  }

  return <CircleDashed aria-hidden="true" size={20} />;
}

function RequirementFacts({ check }: { readonly check: RenderedReadinessCheck }) {
  if (
    check.expectedFields === undefined &&
    check.observedFields === undefined &&
    check.missing === undefined
  ) {
    return null;
  }

  return (
    <div className="admin-requirement-facts">
      <RequirementFactGroup title="Expected" fields={check.expectedFields} />
      <RequirementFactGroup title="Observed" fields={check.observedFields} />
      {check.missing === undefined ? null : (
        <div className="admin-requirement-fact-group">
          <span>Missing</span>
          <ul>
            {check.missing.map((item) => (
              <li key={item}>{formatValue(item)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RequirementFactGroup({
  title,
  fields,
}: {
  readonly title: string;
  readonly fields: readonly RequirementField[] | undefined;
}) {
  if (fields === undefined || fields.length === 0) {
    return null;
  }

  return (
    <div className="admin-requirement-fact-group">
      <span>{title}</span>
      <dl>
        {fields.map((field) => (
          <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
