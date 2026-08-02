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
 * tripped itself, on every cold load. Hence `CHECK_RELEASE_INTERVAL_MS` and
 * `RATE_LIMIT_*` below. Both live here rather than in the shared clients:
 * a section that opens one request is not the cause, and loosening `retry`
 * for every caller would hide real faults on every other surface.
 *
 * Coverage. Five checks against the live admin section catalog. `CoverageNote` says so on
 * every load and in every state, because the way a status page does real
 * damage is an operator reading a quiet one as a checked workspace. */

import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueuer } from "@tanstack/react-pacer";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_ROOT,
  ADMIN_SECTION_IDS,
  type AdminSectionId,
} from "@/features/admin/admin-console-data";
import {
  adminUsersQueryKeys,
  adminUsersQueryOptions,
  type AdminUsersListResponse,
} from "@/features/admin/admin-users";
import {
  coreAppsAdminQueryOptions,
  coreAppsQueryKeys,
  type CoreAppsAdminStatus,
} from "@/features/admin/core-apps-api";
import {
  domainsQueryKeys,
  domainsQueryOptions,
  type DomainWithRecords,
} from "@/features/admin/domains-api";
import {
  securityPoliciesQueryKeys,
  securityPoliciesQueryOptions,
  securityPolicyLabels,
  type SecurityPolicy,
} from "@/features/admin/security-policies-api";
import {
  adminPlatformConfigQueryKey,
  adminPlatformConfigQueryOptions,
} from "@/features/admin/tier-readiness/api";
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

/* ------------------------------------------------------------------ */
/* Request budget                                                     */
/* ------------------------------------------------------------------ */

const CHECK_COUNT = 5;

/* One release every 250ms puts at most four of the five checks inside any
   one-second window, so this page cannot on its own exhaust the org's 5 rps
   budget — the spare slot is what the shell and the rest of the app are
   fetching alongside it. The cost is paid only by a genuinely cold console:
   a disabled query still serves whatever is already in the cache, so a check
   whose section has been visited renders immediately and never waits its
   turn. */
const CHECK_RELEASE_INTERVAL_MS = 250;

/* 429 is the one status where retrying is the correct client behaviour: it
   means "ask again later", and the limiter's window is a single second, so a
   check that waits it out gets a real answer. Every other status is reported
   to the operator instead — auto-retrying a 403 or a 500 only hides a real
   fault behind a spinner. Three attempts, then the banner. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 1_100;
const RATE_LIMIT_JITTER_MS = 400;

/* These clients throw plain `Error`s, so an HTTP status only survives in the
   message tail — `… (429).` from the schema-validating clients, `… with 429`
   from the hand-rolled ones. A backend `error` string ("Permission denied.")
   carries no trailing number and correctly does not match, which is why this
   only ever *adds* a retry and never suppresses a reported failure. */
const TRAILING_STATUS = /\(?(\d{3})\)?\.?\s*$/u;

function isRateLimited(error: Error): boolean {
  return TRAILING_STATUS.exec(error.message)?.[1] === "429";
}

/* Jittered, because checks refused in the same second must not come back in
   the same second either — that synchronised burst is what earned the refusal
   in the first place. */
function rateLimitBackoff(failureCount: number): number {
  return RATE_LIMIT_BACKOFF_MS * 2 ** failureCount + Math.random() * RATE_LIMIT_JITTER_MS;
}

/** What each check adds on top of the section's own `queryOptions`: its place
 *  in the release order, and retry-on-429-only. */
function checkOptions(released: number, order: number) {
  return {
    enabled: order < released,
    retry: (failureCount: number, error: Error) =>
      failureCount < RATE_LIMIT_RETRIES && isRateLimited(error),
    retryDelay: rateLimitBackoff,
  };
}

/** Releases the checks one at a time and reports how many may start.
 *
 *  The queue owns its timer and is stopped when the page unmounts, so
 *  navigating away mid-release cannot leave requests firing at a page nobody
 *  is on (house rule `helix/pacer-discipline`: scheduled work goes through
 *  Pacer, never a bare `setTimeout`). */
function useReleaseSchedule(count: number): number {
  const [released, setReleased] = useState(0);
  const queue = useQueuer<number>(
    (order) => {
      /* Idempotent in `order`: React remounts effects in development, so the
         same release can be enqueued twice and must not skip a check or count
         one twice. */
      setReleased((current) => Math.max(current, order + 1));
    },
    { wait: CHECK_RELEASE_INTERVAL_MS },
  );

  useEffect(() => {
    /* The unmount half of that development remount stops the queue, so a
       re-entered effect has to start it again or the remaining checks never
       leave. */
    queue.start();
    for (let order = 0; order < count; order += 1) {
      queue.addItem(order);
    }
  }, [count, queue]);

  return released;
}

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
      policy.runtimeStatus.mode === "partial" &&
      policy.enabled &&
      policy.enforcement === "required"
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
const DIRECTORY_QUERY_INPUT = { includeDisabled: true, limit: 250 } as const;

export function AdminOverview() {
  const queryClient = useQueryClient();

  /* Release order is card order, so a cold page fills left to right rather
     than in whatever order the network happens to answer. */
  const released = useReleaseSchedule(CHECK_COUNT);

  const domainsQuery = useQuery({ ...domainsQueryOptions(), ...checkOptions(released, 0) });
  const policiesQuery = useQuery({
    ...securityPoliciesQueryOptions(),
    ...checkOptions(released, 1),
  });
  const platformQuery = useQuery({
    ...adminPlatformConfigQueryOptions(),
    ...checkOptions(released, 2),
  });
  const directoryQuery = useQuery({
    ...adminUsersQueryOptions(DIRECTORY_QUERY_INPUT),
    ...checkOptions(released, 3),
  });
  const coreAppsQuery = useQuery({ ...coreAppsAdminQueryOptions(), ...checkOptions(released, 4) });

  /* Invalidate the shared key rather than the local observer's refetch, so a
     recovery here also un-sticks the section that owns the data. */
  const invalidate = (queryKey: QueryKey) => () => void queryClient.invalidateQueries({ queryKey });

  const domainsFailure = useQueryFailure(domainsQuery, invalidate(domainsQueryKeys.domains()));
  const policiesFailure = useQueryFailure(
    policiesQuery,
    invalidate(securityPoliciesQueryKeys.list()),
  );
  const platformFailure = useQueryFailure(platformQuery, invalidate(adminPlatformConfigQueryKey));
  const directoryFailure = useQueryFailure(
    directoryQuery,
    invalidate(adminUsersQueryKeys.list(DIRECTORY_QUERY_INPUT)),
  );
  const coreAppsFailure = useQueryFailure(coreAppsQuery, invalidate(coreAppsQueryKeys.admin()));

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
  /* Deliberately not paced. This burst is one the operator asked for and is
     watching, the button stays disabled across the whole thing (a query in
     429 backoff still reports `isFetching`), and pacing it would blink that
     button between waves. The retry above is what keeps a refused refresh from
     becoming a red banner. */
  const refreshAll = () => {
    for (const queryKey of [
      domainsQueryKeys.domains(),
      securityPoliciesQueryKeys.list(),
      adminPlatformConfigQueryKey,
      adminUsersQueryKeys.list(DIRECTORY_QUERY_INPUT),
      coreAppsQueryKeys.admin(),
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  return (
    <PageScroll>
      <PageHeading
        title="Workspace overview"
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

function SignalCard({ signal }: { readonly signal: Signal }) {
  const headingId = `admin-overview-${signal.id}`;
  return (
    <section aria-labelledby={headingId} className="panel p-3 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span className="text-[var(--text-3)] mt-0.5 shrink-0">{signal.icon}</span>
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
          <span className="text-xs text-[var(--text-3)]">{signal.caption}</span>
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
          <span className="text-[var(--text-3)]">Counted above: </span>
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
