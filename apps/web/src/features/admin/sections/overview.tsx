/* Admin › Overview — the console's landing section.
 *
 * Overview answers one question: is anything wrong in this workspace? It adds
 * no telemetry of its own. Every figure is read from a query another section
 * already owns, on that section's own cache key, so landing here warms the
 * pages the operator is about to open instead of duplicating their traffic.
 *
 * The honesty rule this file exists to hold: a figure may only be rendered
 * from a response that actually arrived. `toSignal` is the single funnel — a
 * held failure and an absent payload both return before the reader function
 * can run, so no branch can turn "we could not look" into a zero or a green
 * chip. The same applies to the headline: "Nothing needs attention" is claimed
 * only when all five checks responded. Anything less is reported as the
 * partial reading it is.
 *
 * Two further constraints, both learned from this page misbehaving in a live
 * workspace:
 *
 * Request budget. Every request outside `/api/auth` is metered against the
 * tenant's `api_rps_limit` quota — five per second on the default plan
 * (`packages/contracts/src/tenant-config.ts`), counted per org over a
 * one-second sliding window (`installTenantApiRpsLimitHook`,
 * `apps/helix/src/server.ts`). Five checks leaving in the same tick, on top of
 * whatever the shell is fetching, put the org over that budget; one check came
 * back 429, and because every admin `queryOptions` in this app sets
 * `retry: false`, that refusal was permanent until the operator clicked Retry.
 * The console's front door was raising a red alarm about a limit it had
 * tripped itself, on every cold load. The pacing and the 429-only retry that
 * fixed it now live in `console/request-budget.ts` and apply to every admin
 * section, because this page was only where the problem was *found*, not the
 * only page that has it. The retry there is still 429-only: loosening `retry`
 * generally would hide real faults on every other surface.
 *
 * Coverage. Five checks against the live admin section catalog. `CoverageNote` says so on
 * every load and in every state, because the way a status page does real
 * damage is an operator reading a quiet one as a checked workspace. */

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ROOT,
  ADMIN_SECTION_IDS,
  type AdminSectionId,
} from "@/features/admin/admin-console-data";
import { type AdminUsersListResponse } from "@/features/admin/admin-users";
import { type CoreAppsAdminStatus } from "@/features/admin/core-apps-api";
import { type DomainWithRecords } from "@/features/admin/domains-api";
import { securityPolicyLabels, type SecurityPolicy } from "@/features/admin/security-policies-api";
import {} from "@/features/admin/tier-readiness/api";
import { titleForTier } from "@/features/admin/tier-readiness/format";
import type { PlatformConfigStatus } from "@/features/admin/tier-readiness/types";
import {
  HEADER_CELL,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
  type QueryFailure,
} from "@/features/admin/console/primitives";
import {
  adminOverviewQueryKey,
  adminOverviewQueryOptions,
  type AdminOverviewSignalData,
  type AdminOverviewSignalName,
} from "@/features/admin/admin-overview-api";

/* Re-exported so the console's section registry (`console/section-loaders.ts`)
   and this section's tests keep finding it on the module that owns the page. */
export { prefetchAdminOverviewQueries } from "@/features/admin/admin-overview-api";

/* The pacing that used to live here is gone with the requests it paced.
   Overview read five endpoints and released them one at a time so the burst
   could not exhaust the tenant's five-per-second budget; the server now serves
   all five readings in one response (`admin-overview-api.ts`), so there is
   nothing to stagger. `console/request-budget.ts` still owns the shared 429
   policy for every other section. */

/* ------------------------------------------------------------------ */
/* Signal model                                                       */
/* ------------------------------------------------------------------ */

/** `checking` and `unavailable` are states of the *reading*, not of the
 *  workspace. Only `attention` and `clear` are claims about the workspace, and
 *  only `toSignal` can produce them — from data that arrived. */
type SignalTone = "checking" | "unavailable" | "attention" | "clear";

const TONE_LABEL: Record<SignalTone, string> = {
  checking: "Checking…",
  unavailable: "Unavailable",
  attention: "Needs attention",
  /* Not "Healthy": all this claims is that the card's own rule did not fire.
     A card can be `clear` and still list policies that are off. */
  clear: "Nothing flagged",
};

const TONE_CHIP: Record<SignalTone, string> = {
  checking: "chip",
  unavailable: "chip danger",
  attention: "chip warning",
  clear: "chip success",
};

/** What a reader function extracts once a payload is in hand. `attention` is
 *  the sentence the page leads with; `null` means this signal's rule did not
 *  fire, which is a statement about live data and never about a missing one. */
interface Reading {
  readonly figure: string;
  readonly caption: string;
  readonly detail: string;
  readonly attention: string | null;
}

interface SignalDefinition {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly section: AdminSectionId;
  readonly linkLabel: string;
  /** Names the surface in `describeFailure`'s cause sentence. */
  readonly subject: string;
}

interface Signal extends SignalDefinition, Reading {
  readonly tone: SignalTone;
  readonly failure: QueryFailure | null;
}

/** The one place a `Reading` can be produced.
 *
 *  Argument order encodes the precedence: a held failure outranks stale data,
 *  and an absent payload never reaches `read`. There is deliberately no
 *  else-branch here that yields a figure without a response behind it — the
 *  console's recurring bug is exactly that shape (`x === false ? "Disabled" :
 *  "Enabled"` reporting Enabled for undefined). */
function toSignal<T>(
  definition: SignalDefinition,
  query: { readonly data: T | undefined },
  failure: QueryFailure | null,
  read: (data: T) => Reading,
): Signal {
  if (failure !== null) {
    return {
      ...definition,
      tone: "unavailable",
      figure: "—",
      caption: "not read",
      detail: "Not counted either way. The banner above carries the reason and a retry.",
      attention: null,
      failure,
    };
  }
  if (query.data === undefined) {
    return {
      ...definition,
      tone: "checking",
      figure: "—",
      caption: "reading…",
      detail: "Waiting on the workspace.",
      attention: null,
      failure: null,
    };
  }
  const reading = read(query.data);
  return {
    ...definition,
    ...reading,
    tone: reading.attention === null ? "clear" : "attention",
    failure: null,
  };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/** Names in an operator-readable list, capped so a long list cannot push the
 *  card off a single screen. */
function nameList(names: readonly string[], cap = 3): string {
  if (names.length <= cap) {
    return names.join(", ");
  }
  return `${names.slice(0, cap).join(", ")} +${String(names.length - cap)} more`;
}

/* ------------------------------------------------------------------ */
/* Readers — one per query, pure, only ever called with real data      */
/* ------------------------------------------------------------------ */

function readDomains(domains: readonly DomainWithRecords[]): Reading {
  const total = domains.length;
  if (total === 0) {
    return {
      figure: "0",
      caption: "domains registered",
      detail: "Mail cannot be delivered until a domain is registered and verified.",
      attention: "No domains are registered.",
    };
  }
  const verified = domains.filter((it) => it.domain.verificationStatus === "verified").length;
  const failed = domains.filter((it) => it.domain.verificationStatus === "failed").length;
  const pending = domains.filter((it) => it.domain.verificationStatus === "pending").length;
  const unverified = failed + pending;
  return {
    figure: `${String(verified)}/${String(total)}`,
    caption: `${plural(total, "domain", "domains")} verified`,
    detail:
      unverified === 0
        ? "Every registered domain is verified."
        : `${String(failed)} failed, ${String(pending)} pending verification.`,
    attention:
      unverified === 0
        ? null
        : `${String(unverified)} of ${String(total)} ${plural(total, "domain", "domains")} ${plural(unverified, "is", "are")} not verified.`,
  };
}

/**
 * Runtime-enforced only. Prefer server `runtimeStatus` so recorded-only
 * policies never count as enforced when stored as required. Without
 * runtimeStatus, SSO/DLP/device_trust never count (honest fail-closed).
 */
function isEnforced(policy: SecurityPolicy): boolean {
  if (policy.runtimeStatus !== undefined) {
    if (policy.runtimeStatus.displayLevel === "required") {
      return true;
    }
    // Partial controls (admin MFA, session) with required intent are live on
    // some paths — count them as enforced for the overview ratio.
    return (
      policy.runtimeStatus.mode === "partial" && policy.enabled && policy.enforcement === "required"
    );
  }
  if (
    policy.policyType === "sso" ||
    policy.policyType === "dlp" ||
    policy.policyType === "device_trust"
  ) {
    return false;
  }
  return policy.enabled && policy.enforcement === "required";
}

function readPolicies(policies: readonly SecurityPolicy[]): Reading {
  const total = policies.length;
  if (total === 0) {
    return {
      figure: "0",
      caption: "policy records",
      detail: "The workspace returned no security-policy records.",
      attention: "No security policies are configured.",
    };
  }
  const enforced = policies.filter(isEnforced).length;
  const unenforced = policies.filter((policy) => !isEnforced(policy));
  const mfa = policies.find((policy) => policy.policyType === "mfa");
  return {
    figure: `${String(enforced)}/${String(total)}`,
    caption: `${plural(total, "policy", "policies")} enforced`,
    /* The second sentence is what reconciles this card with the headline: a
       figure of 0/6 beside a count of one otherwise reads as five findings the
       band forgot. Only MFA escalates, so the card says so where the six are
       listed rather than leaving the operator to infer a bug. */
    detail:
      unenforced.length === 0
        ? "Every returned policy is runtime-enforced (or partially enforced) at required."
        : `Not runtime-enforced: ${nameList(unenforced.map((policy) => securityPolicyLabels[policy.policyType]))}. Only an unenforced multi-factor policy is counted above.`,
    /* Only MFA is escalated, and only when its record is present. An absent
       record is unknown — reporting it as "not enforced" would be inventing a
       policy state the backend never sent. */
    attention:
      mfa !== undefined && !isEnforced(mfa) ? "Multi-factor authentication is not enforced." : null,
  };
}

/** `readiness.requirements` is the one field the platform-config guard checks
 *  only as an array — the elements are unvalidated. Counting defensively means
 *  a shape we do not recognise contributes nothing rather than a wrong number;
 *  `readiness.ready` (a validated boolean) is what raises the attention. */
function countUnmetRequirements(requirements: PlatformConfigStatus["readiness"]["requirements"]) {
  return requirements.filter(
    (requirement: unknown) =>
      typeof requirement === "object" &&
      requirement !== null &&
      "status" in requirement &&
      (requirement.status === "missing" || requirement.status === "degraded"),
  ).length;
}

function readPlatform(status: PlatformConfigStatus): Reading {
  const tier = titleForTier(status.config.security.tier);
  if (status.readiness.ready) {
    return {
      figure: tier,
      caption: "security tier",
      detail: "The platform reports this tier's requirements as met.",
      attention: null,
    };
  }
  const unmet = countUnmetRequirements(status.readiness.requirements);
  return {
    figure: tier,
    caption: "security tier",
    detail:
      unmet === 0
        ? "The platform reports the tier as not ready."
        : `${String(unmet)} ${plural(unmet, "requirement is", "requirements are")} missing or degraded.`,
    attention: `The ${tier} tier is not ready.`,
  };
}

function readDirectory(page: AdminUsersListResponse): Reading {
  const total = page.users.length;
  if (total === 0) {
    return {
      figure: "0",
      caption: "accounts",
      detail: "The directory returned no accounts.",
      attention: "The directory has no accounts.",
    };
  }
  const disabled = page.users.filter((user) => user.disabledAt !== null).length;
  /* The directory endpoint pages. A `nextCursor` means this is the first page
     of a longer list, so the count is a floor — hence the trailing "+". */
  const truncated = page.nextCursor !== null;
  return {
    figure: truncated ? `${String(total)}+` : String(total),
    caption: `${plural(total, "account", "accounts")}${truncated ? " (first page)" : ""}`,
    detail: `${String(disabled)} suspended, ${String(total - disabled)} active.`,
    attention: null,
  };
}

function readCoreApps(status: CoreAppsAdminStatus): Reading {
  const total = status.apps.length;
  if (total === 0) {
    return {
      figure: "0",
      caption: "workspace apps",
      detail: "The platform returned no core apps.",
      attention: "No workspace apps were returned.",
    };
  }
  const enabled = status.apps.filter((app) => app.enabled);
  const off = status.apps.filter((app) => !app.enabled);
  return {
    figure: `${String(enabled.length)}/${String(total)}`,
    caption: `${plural(total, "app", "apps")} enabled`,
    detail:
      off.length === 0
        ? "Every core app is enabled."
        : `Off: ${nameList(off.map((app) => app.name))}.`,
    attention: enabled.length === 0 ? "No workspace apps are enabled." : null,
  };
}

/* ------------------------------------------------------------------ */
/* Coverage                                                           */
/* ------------------------------------------------------------------ */

const SECTION_LABELS = new Map<AdminSectionId, string>(
  ADMIN_NAV_GROUPS.flatMap((group) =>
    group.items.map((item): [AdminSectionId, string] => [item.id, item.label]),
  ),
);

interface Coverage {
  readonly checked: number;
  readonly total: number;
  readonly unchecked: readonly AdminSectionId[];
}

/** What this page can and cannot see, derived from the checks themselves and
 *  the console's own section registry — so adding or dropping a check moves
 *  the sentence with it instead of leaving a stale number on screen. */
function coverageOf(signals: readonly Signal[]): Coverage {
  const checked = new Set(signals.map((signal) => signal.section));
  /* Overview is not in the denominator: it is this page, not a section this
     page could check. */
  const unchecked = ADMIN_SECTION_IDS.filter((id) => id !== ADMIN_NAV_ROOT.id && !checked.has(id));
  return { checked: checked.size, total: checked.size + unchecked.length, unchecked };
}

/** Sits under the headline in all four of its states, including the clean one.
 *  "Nothing needs attention" is true of five sections; an operator who reads it
 *  as true of the workspace has been misled by omission, and this is the
 *  sentence that stops that. */
function CoverageNote({ coverage }: { readonly coverage: Coverage }) {
  return (
    <p className="mt-2 mb-0 text-xs text-[var(--text-2)]">
      These checks read {coverage.checked} of the console&apos;s {coverage.total} sections. The
      other {coverage.unchecked.length} are not read here at all — a section can be misconfigured,
      or answering 404 for every request, and nothing on this page will say so. A quiet Overview is
      not a checked workspace.
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                           */
/* ------------------------------------------------------------------ */

/* Deliberately the same key the directory section builds, so Overview reads
   the directory's cache rather than opening a sixth request — `includeDisabled`
   is also what makes the suspended count answerable at all. If
   `sections/users.tsx` changes its page size these silently stop sharing:
   the figures stay correct, the request stops being free. */
/* Structural rather than importing `QueryClient`: the route loader only ever
   hands this helper an `ensureQueryData`, and typing it that way keeps the
   section free of a router/query-client dependency it does not otherwise have. */
export function AdminOverview() {
  const queryClient = useQueryClient();

  /* One request for the whole page. This used to be five — the five endpoints
     the cards read — released one at a time by a queue so they would not
     exhaust the tenant's five-per-second budget in a single tick. The server
     fans out instead now (`GET /api/admin/overview`), so there is nothing left
     to pace and the page no longer throttles itself on its own front door. */
  const overviewQuery = useQuery(adminOverviewQueryOptions());
  const overview = overviewQuery.data;

  const retryOverview = () => {
    void queryClient.invalidateQueries({ queryKey: adminOverviewQueryKey });
  };

  /* Per signal, not per request. The aggregate reports each source's own
     status, so one dead endpoint still leaves the other four cards accurate —
     the property five separate requests provided for free, and the one a naive
     aggregate would have destroyed.

     `useQueryFailure` wants something query-shaped, so each signal is adapted
     into one: a transport failure fails every card, a per-signal `unavailable`
     fails only its own. */
  const signalOf = <Name extends AdminOverviewSignalName>(name: Name) => {
    const signal = overview?.[name];
    const reason = signal?.status === "unavailable" ? signal.reason : null;
    return {
      /* `signals` is a record of differently-typed payloads, so indexing it with
         a generic key widens to their union. The cast narrows back to the one
         this name actually carries — `AdminOverview` is the single place that
         mapping is declared. */
      data: signal?.status === "ok" ? (signal.data as AdminOverviewSignalData<Name>) : undefined,
      error: overviewQuery.error ?? (reason === null ? null : new Error(reason)),
      isSuccess: signal?.status === "ok",
      isFetching: overviewQuery.isFetching,
    };
  };

  const domainsQuery = signalOf("domains");
  const policiesQuery = signalOf("policies");
  const platformQuery = signalOf("platformConfig");
  const directoryQuery = signalOf("directory");
  const coreAppsQuery = signalOf("coreApps");

  /* Invalidate the shared key rather than the local observer's refetch, so a
     recovery here also un-sticks the section that owns the data. */
  const domainsFailure = useQueryFailure(domainsQuery, retryOverview);
  const policiesFailure = useQueryFailure(policiesQuery, retryOverview);
  const platformFailure = useQueryFailure(platformQuery, retryOverview);
  const directoryFailure = useQueryFailure(directoryQuery, retryOverview);
  const coreAppsFailure = useQueryFailure(coreAppsQuery, retryOverview);

  const signals: readonly Signal[] = [
    toSignal(
      {
        id: "domains",
        title: "Domains",
        icon: <Icons.Globe />,
        section: "domains",
        linkLabel: "Open Domains",
        subject: "domains",
      },
      domainsQuery,
      domainsFailure,
      readDomains,
    ),
    toSignal(
      {
        id: "policies",
        title: "Security policies",
        icon: <Icons.Lock />,
        section: "policies",
        linkLabel: "Open Policies",
        subject: "security policies",
      },
      policiesQuery,
      policiesFailure,
      readPolicies,
    ),
    toSignal(
      {
        id: "platform",
        title: "Tier readiness",
        icon: <Icons.Shield />,
        section: "tier-readiness",
        linkLabel: "Open Tier readiness",
        subject: "platform configuration",
      },
      platformQuery,
      platformFailure,
      readPlatform,
    ),
    toSignal(
      {
        id: "directory",
        title: "Directory",
        icon: <Icons.Users />,
        section: "users",
        linkLabel: "Open Users",
        subject: "the directory",
      },
      directoryQuery,
      directoryFailure,
      readDirectory,
    ),
    toSignal(
      {
        id: "apps",
        title: "Workspace apps",
        icon: <Icons.Briefcase />,
        section: "workspace-apps",
        linkLabel: "Open Workspace apps",
        subject: "workspace apps",
      },
      coreAppsQuery,
      coreAppsFailure,
      readCoreApps,
    ),
  ];

  /* `flatMap` rather than `filter`, so `failure` narrows to non-null without a
     cast at the render site. */
  const failures = signals.flatMap((signal) =>
    signal.failure === null ? [] : [{ signal, failure: signal.failure }],
  );

  const coverage = coverageOf(signals);

  const queries = [domainsQuery, policiesQuery, platformQuery, directoryQuery, coreAppsQuery];
  const isRefreshing = queries.some((query) => query.isFetching);
  /* One request, so there is no burst left to pace — this used to fan five
     invalidations out at once and rely on the 429 retry to survive its own
     refresh. */
  const refreshAll = retryOverview;

  return (
    <PageScroll>
      <PageHeading
        title="Overview"
        subtitle="Live status from the sections below — Overview stores nothing of its own."
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isRefreshing}
            onClick={refreshAll}
          >
            <Icons.Refresh /> {isRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      <AttentionBand signals={signals} />
      <CoverageNote coverage={coverage} />

      {/* Full page width, not inside the card that failed. `describeFailure`'s
          cause sentence plus a raw backend message do not fit a 240px column —
          they wrap to one word a line and push the grid off screen, which
          costs the operator the one thing this page is for. The card still
          says it is unavailable and points here. */}
      {failures.map(({ signal, failure }) => (
        <QueryFailureBanner
          key={signal.id}
          summary={`${signal.title} could not be read`}
          subject={signal.subject}
          error={failure.error}
          isRetrying={failure.isRetrying}
          onRetry={failure.retry}
        >
          Its card below is excluded from the summary above rather than counted as clear.
        </QueryFailureBanner>
      ))}

      {/* A real h2 rather than a jump from the page h1 to the card h3s. */}
      <h2 className="mt-4 mb-2" style={HEADER_CELL}>
        Checks
      </h2>
      {/* 200px lands five cards on one row at the console's 1280px cap, so the
          whole answer is above the fold; it reflows below that. */}
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
        {signals.map((signal) => (
          <SignalCard key={signal.id} signal={signal} />
        ))}
      </div>

      {/* Enterprise detail bands reuse the same five query payloads — no extra
          rps. Partial / failed queries stay labeled unavailable, never green. */}
      <h2 className="mt-6 mb-2" style={HEADER_CELL}>
        Operational detail
      </h2>
      <div className="grid gap-3 lg:grid-cols-2">
        <EnterpriseDetailBand
          title="Security & tier"
          section="tier-readiness"
          linkLabel="Open Tier readiness"
          tone={signals.find((s) => s.id === "platform")?.tone ?? "checking"}
        >
          {platformFailure !== null ? (
            <p className="m-0 text-xs text-[var(--text-2)]">
              Tier readiness could not be read — see the banner above.
            </p>
          ) : platformQuery.data === undefined ? (
            <p className="m-0 text-xs text-[var(--text-2)]">Reading platform configuration…</p>
          ) : (
            <SecurityTierDetail status={platformQuery.data} />
          )}
        </EnterpriseDetailBand>

        <EnterpriseDetailBand
          title="People & domains"
          section="users"
          linkLabel="Open Users"
          tone={
            domainsFailure !== null || directoryFailure !== null
              ? "unavailable"
              : domainsQuery.data === undefined || directoryQuery.data === undefined
                ? "checking"
                : signals.find((s) => s.id === "domains")?.tone === "attention" ||
                    signals.find((s) => s.id === "directory")?.tone === "attention"
                  ? "attention"
                  : "clear"
          }
        >
          {domainsFailure !== null || directoryFailure !== null ? (
            <p className="m-0 text-xs text-[var(--text-2)]">
              Directory or domains could not be read — see the banner above.
            </p>
          ) : domainsQuery.data === undefined || directoryQuery.data === undefined ? (
            <p className="m-0 text-xs text-[var(--text-2)]">Reading people and domains…</p>
          ) : (
            <PeopleDomainsDetail domains={domainsQuery.data} directory={directoryQuery.data} />
          )}
        </EnterpriseDetailBand>

        <EnterpriseDetailBand
          title="App enablement"
          section="workspace-apps"
          linkLabel="Open Workspace apps"
          tone={signals.find((s) => s.id === "apps")?.tone ?? "checking"}
        >
          {coreAppsFailure !== null ? (
            <p className="m-0 text-xs text-[var(--text-2)]">
              Workspace apps could not be read — see the banner above.
            </p>
          ) : coreAppsQuery.data === undefined ? (
            <p className="m-0 text-xs text-[var(--text-2)]">Reading workspace apps…</p>
          ) : (
            <WorkspaceAppsDetail status={coreAppsQuery.data} />
          )}
        </EnterpriseDetailBand>

        <EnterpriseDetailBand
          title="AI & mail spam"
          section="ai-providers"
          linkLabel="Open AI providers"
          tone={
            platformFailure !== null
              ? "unavailable"
              : platformQuery.data === undefined
                ? "checking"
                : "clear"
          }
        >
          {platformFailure !== null ? (
            <p className="m-0 text-xs text-[var(--text-2)]">
              AI config is part of platform-config and could not be read.
            </p>
          ) : platformQuery.data === undefined ? (
            <p className="m-0 text-xs text-[var(--text-2)]">Reading AI configuration…</p>
          ) : (
            <AiMailDetail status={platformQuery.data} />
          )}
        </EnterpriseDetailBand>
      </div>

      {/* Rare detail: an operator acting on a figure needs the figure, not its
          provenance. An operator who distrusts a figure needs exactly this. */}
      <details className="admin-disclosure" style={{ marginTop: 16 }}>
        <summary>Where these five figures come from, and what they do not cover</summary>
        <ul
          style={{
            margin: "8px 0 0",
            paddingInlineStart: 20,
            fontSize: "var(--text-meta)",
            color: "var(--text-2)",
            display: "grid",
            gap: 4,
          }}
        >
          <li>
            Domains counts verification status per registered domain. It does not check individual
            DNS records — open Domains for the MX/SPF/DKIM/DMARC detail.
          </li>
          <li>
            Security policies counts records the workspace returned, and calls a policy enforced
            only when runtime status says so (not mere stored intent). Recorded-only controls never
            count as enforced. A policy type with no record is absent, not off, and is left out of
            the count.
          </li>
          <li>
            Tier readiness reports the live tier and the platform&apos;s own ready flag. The
            per-gate breakdown lives in Tier readiness.
          </li>
          <li>
            Directory counts the first page of accounts the admin API returns. A trailing
            &ldquo;+&rdquo; means the directory is longer than the page.
          </li>
          <li>
            Workspace apps counts org-wide enablement. An app can be enabled org-wide and still not
            be served by the node you are talking to.
          </li>
          <li>
            There is no sign-in, session, or delivery telemetry behind any of this — none of it is
            collected yet, so none of it is claimed here.
          </li>
          {/* Named, not just counted: an operator deciding whether Overview is
              enough for a shift handover needs the actual list. */}
          <li>
            No check on this page reads{" "}
            {coverage.unchecked.map((id) => SECTION_LABELS.get(id) ?? id).join(", ")}. Open those
            sections to see their state; a clean Overview says nothing about any of them.
          </li>
        </ul>
      </details>
    </PageScroll>
  );
}

/* ------------------------------------------------------------------ */
/* Attention band — the page's headline                                */
/* ------------------------------------------------------------------ */

/** The lead. Its four states are mutually exclusive and none of them can read
 *  as clean while a check is still pending or unreadable — the whole point of
 *  the surface is that "we could not look" must not look like "nothing is
 *  wrong". */
function AttentionBand({ signals }: { readonly signals: readonly Signal[] }) {
  const flagged = signals.filter((signal) => signal.tone === "attention");
  const unavailable = signals.filter((signal) => signal.tone === "unavailable");
  const checking = signals.filter((signal) => signal.tone === "checking");
  const answered = signals.length - unavailable.length - checking.length;

  const gap = describeGap(unavailable.length, checking.length);

  if (flagged.length > 0) {
    return (
      <section
        aria-labelledby="admin-overview-attention"
        className="panel p-4"
        style={{ background: "var(--warning-soft)", borderColor: "transparent" }}
      >
        <h2
          id="admin-overview-attention"
          className="m-0 text-base font-semibold flex items-center gap-2"
        >
          <Icons.Shield />
          {flagged.length} {plural(flagged.length, "thing needs", "things need")} attention
        </h2>
        <ul className="mt-3 grid gap-2 list-none p-0 m-0">
          {flagged.map((signal, index) => (
            <li key={signal.id} className="flex flex-wrap items-center gap-2">
              {/* Not stretched to the full 1280px cap: pushing the control to
                  the far right of the band breaks the link between a sentence
                  and the button that acts on it. */}
              <span className="min-w-0 text-sm">{signal.attention}</span>
              {/* One primary per card: the first (most severe by card order)
                  gets it, the rest stay secondary. */}
              <Button asChild size="xs" variant={index === 0 ? "default" : "outline"}>
                <Link to="/admin/$section" params={{ section: signal.section }}>
                  {signal.linkLabel}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
        {gap === null ? null : (
          <p className="mt-3 mb-0 text-xs text-[var(--text-2)]">
            {gap} This list is what the checks that responded can see, not the whole workspace.
          </p>
        )}
      </section>
    );
  }

  if (unavailable.length > 0) {
    /* Never the clean state. Some checks could not be read, so the strongest
       honest claim is scoped to the ones that answered — and it has to say
       out loud that it is not a clean bill of health, because an operator
       reading "nothing needs attention" will stop looking. */
    return (
      <StateBanner kind="info">
        Nothing needs attention in the {answered} of {signals.length}{" "}
        {plural(signals.length, "check", "checks")} that responded. {gap} This is not a clean bill
        of health for the workspace.
      </StateBanner>
    );
  }

  if (checking.length > 0) {
    return (
      <StateBanner kind="loading">
        Checking domains, security policies, tier readiness, the directory, and workspace apps…
      </StateBanner>
    );
  }

  /* The only place the page speaks for the whole workspace, and it is reached
     only when every check answered and every rule stayed silent. The sentence
     claims exactly that and nothing more: spelling out "every domain is
     verified, MFA is enforced, …" would assert states no rule actually tested
     — an absent MFA record, for one, never raises attention. */
  return (
    <section
      aria-labelledby="admin-overview-clear"
      className="panel p-4"
      style={{ background: "var(--success-soft)", borderColor: "transparent" }}
    >
      <h2 id="admin-overview-clear" className="m-0 text-base font-semibold flex items-center gap-2">
        <Icons.Check />
        Nothing needs attention
      </h2>
      <p className="mt-2 mb-0 text-sm">
        All {signals.length} checks responded and none of them is flagging a problem. The figures
        behind them are below.
      </p>
    </section>
  );
}

/** One sentence naming what the page could not see, or `null` when it saw
 *  everything. */
function describeGap(unavailable: number, checking: number): string | null {
  if (unavailable > 0 && checking > 0) {
    return `${String(unavailable)} ${plural(unavailable, "check is", "checks are")} unavailable and ${String(checking)} still loading.`;
  }
  if (unavailable > 0) {
    return `${String(unavailable)} ${plural(unavailable, "check is", "checks are")} unavailable — the ${plural(unavailable, "card", "cards")} below ${plural(unavailable, "says", "say")} which.`;
  }
  if (checking > 0) {
    return `${String(checking)} ${plural(checking, "check is", "checks are")} still loading.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Signal card                                                         */
/* ------------------------------------------------------------------ */

function EnterpriseDetailBand({
  title,
  section,
  linkLabel,
  tone,
  children,
}: {
  readonly title: string;
  readonly section: AdminSectionId;
  readonly linkLabel: string;
  readonly tone: SignalTone;
  readonly children: ReactNode;
}) {
  const headingId = `admin-overview-detail-${section}`;
  return (
    <section
      aria-labelledby={headingId}
      className="panel p-4 flex flex-col gap-3"
      data-overview-band="detail"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="m-0 text-sm font-semibold">
          {title}
        </h3>
        <span className={`${TONE_CHIP[tone]} shrink-0`}>{TONE_LABEL[tone]}</span>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      <div>
        <Button asChild size="xs" variant="outline">
          <Link to="/admin/$section" params={{ section }}>
            {linkLabel}
          </Link>
        </Button>
      </div>
    </section>
  );
}

function SecurityTierDetail({ status }: { readonly status: PlatformConfigStatus }) {
  const tier = titleForTier(status.config.security.tier);
  const unmet = countUnmetRequirements(status.readiness.requirements);
  const requirementLines = status.readiness.requirements
    .filter(
      (requirement: unknown): requirement is { readonly key?: string; readonly status?: string } =>
        typeof requirement === "object" && requirement !== null,
    )
    .filter((requirement) => requirement.status === "missing" || requirement.status === "degraded")
    .map((requirement) => String(requirement.key ?? "requirement"))
    .slice(0, 6);

  return (
    <dl className="m-0 grid gap-1 text-xs">
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Security tier</dt>
        <dd className="m-0 font-medium">{tier}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Readiness</dt>
        <dd className="m-0 font-medium">{status.readiness.ready ? "Ready" : "Not ready"}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Unmet requirements</dt>
        <dd className="m-0 font-medium tabular-nums">{String(unmet)}</dd>
      </div>
      {requirementLines.length === 0 ? null : (
        <p className="m-0 mt-1 text-[var(--text-2)]">Attention: {nameList(requirementLines, 4)}.</p>
      )}
    </dl>
  );
}

function PeopleDomainsDetail({
  domains,
  directory,
}: {
  readonly domains: readonly DomainWithRecords[];
  readonly directory: AdminUsersListResponse;
}) {
  const verified = domains.filter((it) => it.domain.verificationStatus === "verified").length;
  const pending = domains.filter((it) => it.domain.verificationStatus === "pending").length;
  const failed = domains.filter((it) => it.domain.verificationStatus === "failed").length;
  const suspended = directory.users.filter((user) => user.disabledAt !== null).length;
  const active = directory.users.length - suspended;
  const domainNames = domains.map((it) => it.domain.domain);

  return (
    <dl className="m-0 grid gap-1 text-xs">
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Domains</dt>
        <dd className="m-0 font-medium tabular-nums">
          {String(verified)}/{String(domains.length)} verified
        </dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Verification queue</dt>
        <dd className="m-0 font-medium tabular-nums">
          {String(pending)} pending, {String(failed)} failed
        </dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Directory (this page)</dt>
        <dd className="m-0 font-medium tabular-nums">
          {String(active)} active, {String(suspended)} suspended
          {directory.nextCursor !== null ? " +" : ""}
        </dd>
      </div>
      {domainNames.length === 0 ? null : (
        <p className="m-0 mt-1 text-[var(--text-2)]">Registered: {nameList(domainNames, 4)}.</p>
      )}
    </dl>
  );
}

function WorkspaceAppsDetail({ status }: { readonly status: CoreAppsAdminStatus }) {
  const enabled = status.apps.filter((app) => app.enabled).map((app) => app.name);
  const disabled = status.apps.filter((app) => !app.enabled).map((app) => app.name);
  return (
    <dl className="m-0 grid gap-1 text-xs">
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Enabled</dt>
        <dd className="m-0 font-medium">{enabled.length === 0 ? "None" : nameList(enabled, 6)}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Disabled</dt>
        <dd className="m-0 font-medium">
          {disabled.length === 0 ? "None" : nameList(disabled, 6)}
        </dd>
      </div>
      <p className="m-0 mt-1 text-[var(--text-2)]">
        Org-wide enablement only — a node may still not serve an enabled app.
      </p>
    </dl>
  );
}

function AiMailDetail({ status }: { readonly status: PlatformConfigStatus }) {
  const ai = status.config.ai;
  const key =
    ai?.operatorLlm?.apiKeyConfigured === true ? "Stored in Admin" : "Not stored (env may apply)";
  const model = ai?.operatorLlm?.model?.trim() || "Not set in Admin";
  const base = ai?.operatorLlm?.baseUrl?.trim() || "Not set in Admin";
  const spam =
    ai?.mailSpamAi?.betaEnabled === true
      ? "Enabled (beta)"
      : ai?.mailSpamAi?.betaEnabled === false
        ? "Disabled in Admin"
        : "Unset (env default)";

  return (
    <dl className="m-0 grid gap-1 text-xs">
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Operator API key</dt>
        <dd className="m-0 font-medium">{key}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Model</dt>
        <dd className="m-0 max-w-[12rem] truncate font-medium" title={model}>
          {model}
        </dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Base URL</dt>
        <dd className="m-0 max-w-[12rem] truncate font-medium" title={base}>
          {base}
        </dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-[var(--text-2)]">Mail spam AI</dt>
        <dd className="m-0 font-medium">{spam}</dd>
      </div>
      <p className="m-0 mt-1 text-[var(--text-2)]">
        Configure under AI → AI providers. Cost limits and observability stay separate.
      </p>
    </dl>
  );
}

function SignalCard({ signal }: { readonly signal: Signal }) {
  const headingId = `admin-overview-${signal.id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="panel p-3 flex flex-col gap-2"
      data-overview-band="check"
    >
      <div className="flex items-start gap-2">
        <span className="text-[var(--text-2)] mt-0.5 shrink-0">{signal.icon}</span>
        <h3 id={headingId} className="m-0 min-w-0 text-sm font-semibold">
          {signal.title}
        </h3>
      </div>

      {/* The chip sits with the figure, not the title: a five-across row is
          ~200px wide, and "Needs attention" beside "Security policies" leaves
          neither of them readable. Beside the number it also reads as what it
          is — the qualifier on that number. */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums leading-none">{signal.figure}</span>
          <span className="text-xs text-[var(--text-2)]">{signal.caption}</span>
        </p>
        <span className={`${TONE_CHIP[signal.tone]} ml-auto shrink-0`}>
          {TONE_LABEL[signal.tone]}
        </span>
      </div>

      <p className="m-0 text-xs text-[var(--text-2)]">{signal.detail}</p>

      {/* The card's contribution to the headline, in the headline's own words.
          Without it a figure like 0/6 and a count of "2 things" are two numbers
          an operator has to reconcile alone — and the reconciliation is not
          guessable, because a card can list six findings and escalate one. This
          renders the same string the band counted, so the two cannot drift. */}
      {signal.attention === null ? null : (
        <p className="m-0 text-xs">
          <span className="text-[var(--text-2)]">Counted above: </span>
          {signal.attention}
        </p>
      )}

      <div className="mt-auto pt-1">
        <Button asChild size="xs" variant={signal.tone === "attention" ? "default" : "outline"}>
          <Link to="/admin/$section" params={{ section: signal.section }}>
            {signal.linkLabel}
          </Link>
        </Button>
      </div>
    </section>
  );
}
