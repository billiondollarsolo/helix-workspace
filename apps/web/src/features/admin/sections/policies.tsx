/* Admin › Security › Policies — authentication, access, and data protection. */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAdminSectionSearch } from "@/features/admin/admin-section-search";
import {
  SECURITY_POLICY_TYPES,
  securityPoliciesQueryKeys,
  securityPoliciesQueryOptions,
  securityPolicyGroup,
  securityPolicyLabels,
  testSsoLogin,
  updateSecurityPolicy,
  type PolicyEnforcement,
  type SecurityPolicy,
  type SecurityPolicyType,
  type SsoTestLoginResponse,
} from "@/features/admin/security-policies-api";
import { AdminField, AdminSelect } from "@/features/admin/console/controls";
import {
  EmptyState,
  MutationError,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  StatusChip,
  useQueryFailure,
} from "@/features/admin/console/primitives";
import { optionalEnumSearchParam } from "@/lib/search-params";

/* Structural rather than importing `QueryClient`: the route loader only ever
   hands this helper an `ensureQueryData`, and typing it that way keeps the
   section free of a router/query-client dependency it does not otherwise have. */
interface AdminPoliciesRouteQueryClient {
  ensureQueryData(options: ReturnType<typeof securityPoliciesQueryOptions>): Promise<unknown>;
}

/** Warms the exact key `AdminPolicies` mounts, so the section's first request
 *  leaves while its chunk is still downloading. Failures are swallowed: the
 *  mounted `useQuery` re-reports them through `QueryFailureBanner`, and a
 *  rejected loader would blank the route over a fetch the page can recover. */
export async function prefetchAdminPoliciesQuery(queryClient: AdminPoliciesRouteQueryClient) {
  await queryClient.ensureQueryData(securityPoliciesQueryOptions()).catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Security                                                           */
/* ------------------------------------------------------------------ */

/* The two columns are the page's real sections, so each one is a labelled
   region headed by an `h2` under the page `h1` — as `<div className="section-label">`
   the whole page outline was a lone `h1` and neither column could be reached by
   heading navigation. Ids are fixed strings rather than slugs derived from the
   label so an `aria-labelledby` link cannot silently break on a rename. */
type PolicyGroup = "Authentication" | "Access & data";

const POLICY_GROUPS: readonly PolicyGroup[] = ["Authentication", "Access & data"];

const POLICY_GROUP_HEADING_ID: Record<PolicyGroup, string> = {
  Authentication: "policy-group-authentication",
  "Access & data": "policy-group-access-data",
};

/* What each column would hold, said where the column is empty — a blank column
   is otherwise indistinguishable from one that failed to render. Keyed by group
   for the same reason as the heading ids above. */
const POLICY_GROUP_EMPTY: Record<PolicyGroup, { readonly title: string; readonly body: string }> = {
  Authentication: {
    title: "No authentication policies",
    body: "Multi-factor, single sign-on, and session policies appear here once the workspace defines them.",
  },
  "Access & data": {
    title: "No access or data policies",
    body: "External sharing, data-loss prevention, and device-trust policies appear here once the workspace defines them.",
  },
};

/**
 * Map a policy to the level-chip. Prefer server `runtimeStatus` so a recorded
 * intent never renders as "Required" when Helix does not enforce the control.
 */
function policyLevel(policy: SecurityPolicy): { text: string; on: boolean } {
  const runtime = policy.runtimeStatus;
  if (runtime !== undefined) {
    switch (runtime.displayLevel) {
      case "off":
        return { text: "Off", on: false };
      case "recorded":
        return { text: "Recorded", on: false };
      case "required":
        return { text: "Required", on: true };
      case "active":
        return { text: runtime.mode === "partial" ? "Partial" : "Active", on: true };
      default:
        return { text: "Off", on: false };
    }
  }
  if (!policy.enabled) {
    return { text: "Off", on: false };
  }
  if (policy.enforcement === "required") {
    // Without runtimeStatus, never claim Required — prefer Recorded.
    return { text: "Recorded", on: false };
  }
  if (policy.enforcement === "optional") {
    return { text: "Active", on: true };
  }
  return { text: "Limited", on: false };
}

/** Render a policy's settings blob as a compact descriptive line. */
function policySettingsSummary(policy: SecurityPolicy): string {
  const settings = policy.settings;
  switch (policy.policyType) {
    case "mfa": {
      const methods = settings.allowedMethods;
      return Array.isArray(methods) ? `Methods: ${methods.join(", ")}` : "";
    }
    case "sso": {
      /* Local login is always on (see `LocalLoginSecurityCard`), so it is the
         one part of this line that is never conditional. */
      const provider = settings.provider;
      const localSummary = "Local email/password: enabled";
      return typeof provider === "string"
        ? `Provider: ${provider} · ${localSummary}`
        : localSummary;
    }
    case "session": {
      const days = settings.inactivityTimeoutDays;
      return typeof days === "number" ? `${String(days)}-day inactivity timeout` : "";
    }
    case "external_sharing": {
      const mode = settings.mode;
      return typeof mode === "string" ? `Sharing mode: ${mode}` : "";
    }
    case "dlp": {
      const detectors = settings.detectors;
      return Array.isArray(detectors) ? `Detectors: ${detectors.join(", ")}` : "";
    }
    case "device_trust": {
      const apps = settings.protectedApps;
      return Array.isArray(apps) && apps.length > 0
        ? `Protected: ${apps.join(", ")}`
        : "No protected apps";
    }
    default:
      return "";
  }
}

interface PolicyEditFormProps {
  readonly policy: SecurityPolicy;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (input: { enabled: boolean; enforcement: PolicyEnforcement }) => void;
}

function PolicyEditForm({ policy, pending, onCancel, onSubmit }: PolicyEditFormProps) {
  const [enabled, setEnabled] = useState(policy.enabled);
  const [enforcement, setEnforcement] = useState<PolicyEnforcement>(policy.enforcement);
  const requiredUnavailable =
    policy.runtimeStatus?.mode === "recorded_only" ||
    policy.policyType === "sso" ||
    policy.policyType === "dlp" ||
    policy.policyType === "device_trust";

  return (
    <form
      className="mt-3 grid gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ enabled, enforcement });
      }}
    >
      <label className="row gap-2 text-[var(--text-2)] [font-size:var(--text-meta)]">
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          aria-label={`Enable ${securityPolicyLabels[policy.policyType]}`}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Policy enabled
      </label>
      {/* The accessible name keeps the policy in it: every card on this page
          shows a control captioned "Enforcement", and a screen reader moving
          between them would otherwise hear the same name six times. */}
      <AdminField label="Enforcement">
        <AdminSelect
          aria-label={`Enforcement for ${securityPolicyLabels[policy.policyType]}`}
          value={enforcement === "required" && requiredUnavailable ? "optional" : enforcement}
          onChange={(event) => setEnforcement(event.target.value as PolicyEnforcement)}
        >
          <option value="disabled">Disabled</option>
          <option value="optional">Optional</option>
          {requiredUnavailable ? null : <option value="required">Required</option>}
        </AdminSelect>
      </AdminField>
      {requiredUnavailable ? (
        <p className="m-0 text-[var(--text-3)] [font-size:var(--text-meta)]">
          Required is unavailable until Helix enforces this control at runtime.
        </p>
      ) : null}
      {policy.policyType === "sso" ? (
        <label className="row gap-2 text-[var(--text-2)] [font-size:var(--text-meta)]">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            aria-label="Local email/password login enabled"
            checked
            disabled
            readOnly
          />
          Local email/password login remains enabled
        </label>
      ) : null}
      {/* Save is this card's single filled button; Cancel and the card's own
          Edit/Test controls stay outlined beside it. */}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save policy"}
        </Button>
      </div>
    </form>
  );
}

function policyTypeFromSearch(value: string | undefined): SecurityPolicyType | null {
  return optionalEnumSearchParam(value, SECURITY_POLICY_TYPES) ?? null;
}

export function AdminSecurity() {
  const queryClient = useQueryClient();
  const policiesQuery = useQuery(securityPoliciesQueryOptions());
  const { search, patchSearch } = useAdminSectionSearch("policies");
  const editing = policyTypeFromSearch(search.policy);
  const setEditing = (policyType: SecurityPolicyType | null) => {
    patchSearch({ policy: policyType ?? undefined });
  };
  const [ssoTestResult, setSsoTestResult] = useState<SsoTestLoginResponse | null>(null);

  const updateMutation = useMutation({
    mutationFn: (input: {
      policyType: SecurityPolicyType;
      enabled: boolean;
      enforcement: PolicyEnforcement;
    }) =>
      updateSecurityPolicy(input.policyType, {
        enabled: input.enabled,
        enforcement: input.enforcement,
      }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({
        queryKey: securityPoliciesQueryKeys.list(),
      });
    },
  });

  const ssoTestMutation = useMutation({
    mutationFn: () => testSsoLogin(),
    onMutate: () => {
      setSsoTestResult(null);
    },
    onError: () => undefined,
    onSuccess: (result) => {
      setSsoTestResult(result);
      void queryClient.invalidateQueries({
        queryKey: securityPoliciesQueryKeys.list(),
      });
    },
  });

  const policies = policiesQuery.data ?? [];

  /* Retry by invalidating the key, not by the observer's own refetch: the
     policy list is read by anything else holding this key too. */
  const policiesFailure = useQueryFailure(policiesQuery, () => {
    void queryClient.invalidateQueries({ queryKey: securityPoliciesQueryKeys.list() });
  });

  const grouped = useMemo(() => {
    const sections: Record<PolicyGroup, SecurityPolicy[]> = {
      Authentication: [],
      "Access & data": [],
    };
    for (const policy of policies) {
      sections[securityPolicyGroup[policy.policyType]].push(policy);
    }
    return sections;
  }, [policies]);

  return (
    <PageScroll>
      {/* Titled for the sidebar entry that opens it (Security › Policies), not
          for the module: an operator who clicks a label must land on a page
          carrying that name. The subtitle carries the scope the old
          "Security policies" title was doing double duty for. */}
      <PageHeading
        title="Policies"
        subtitle="Authentication, access, and data protection across the workspace"
      />

      {/* Chips use server runtimeStatus: external sharing and admin MFA are live;
          SSO/DLP/device trust remain recorded-only and cannot be set to Required.
          Partial controls (MFA, session) never claim full Required. */}
      <StateBanner kind="info">
        Policy chips show runtime status, not intent alone. External sharing and org admin MFA are
        enforced on live API paths. SSO, DLP, and device trust are recorded and audited only — Helix
        will not let you set them to Required until enforcement ships. Prefer your identity provider
        or gateway for those controls in the meantime.
      </StateBanner>

      {policiesFailure !== null ? (
        <QueryFailureBanner
          summary="Security policies are unavailable"
          subject="security policies"
          error={policiesFailure.error}
          isRetrying={policiesFailure.isRetrying}
          onRetry={policiesFailure.retry}
          /* The policy cards are the whole page; with them gone the retry is
             the only action on screen. */
          retryVariant="default"
        >
          No policy can be read or edited until this loads. Enforcement already in effect is
          unchanged — this is a console read failure, not a policy change.
        </QueryFailureBanner>
      ) : policiesQuery.isPending ? (
        <StateBanner kind="loading">Loading security policies…</StateBanner>
      ) : null}
      <MutationError error={updateMutation.error} />
      <MutationError error={ssoTestMutation.error} />
      {ssoTestResult === null ? null : (
        <StateBanner kind={ssoTestResult.status === "runtime_pending" ? "info" : "error"}>
          {ssoTestResult.message}
        </StateBanner>
      )}

      {policiesFailure !== null ? null : (
        <div className="grid gap-4 lg:grid-cols-2">
          {POLICY_GROUPS.map((label) => (
            <section key={label} aria-labelledby={POLICY_GROUP_HEADING_ID[label]}>
              <h2 className="mb-2 text-sm font-semibold" id={POLICY_GROUP_HEADING_ID[label]}>
                {label}
              </h2>
              {label === "Authentication" ? <LocalLoginSecurityCard /> : null}
              {policiesQuery.isSuccess && grouped[label].length === 0 ? (
                <EmptyState icon={<Icons.Lock />} title={POLICY_GROUP_EMPTY[label].title}>
                  {POLICY_GROUP_EMPTY[label].body}
                </EmptyState>
              ) : null}
              {grouped[label].map((policy) => {
                const level = policyLevel(policy);
                const isEditing = editing === policy.policyType;
                const settingsSummary = policySettingsSummary(policy);
                return (
                  <div key={policy.policyType} className="panel mb-3 p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex-1">
                        <div className="mb-1 flex items-center gap-2">
                          {/* h3 under the column's h2 — one card is one policy,
                              and its name is the only thing identifying it. */}
                          <h3 className="m-0 font-semibold [font-size:var(--text-body)]">
                            {securityPolicyLabels[policy.policyType]}
                          </h3>
                          <StatusChip tone={level.on ? "success" : "warning"} label={level.text} />
                        </div>
                        {/* An empty summary would leave a key icon labelling
                            nothing, so the row renders only when there is a
                            setting to describe. */}
                        {settingsSummary.length === 0 ? null : (
                          <div className="row gap-2 text-[var(--text-2)] [font-size:var(--text-meta)]">
                            <Icons.Key /> {settingsSummary}
                          </div>
                        )}
                      </div>
                      {/* The visible word changes with the disclosure, so the
                          accessible name has to change with it — "Close" under
                          an "Edit …" label is a name/label mismatch. */}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-expanded={isEditing}
                        aria-label={
                          isEditing
                            ? `Close ${securityPolicyLabels[policy.policyType]} editor`
                            : `Edit ${securityPolicyLabels[policy.policyType]}`
                        }
                        onClick={() =>
                          setEditing(editing === policy.policyType ? null : policy.policyType)
                        }
                      >
                        {isEditing ? "Close" : "Edit"}
                      </Button>
                      {policy.policyType === "sso" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label="Test SSO login"
                          disabled={ssoTestMutation.isPending}
                          onClick={() => ssoTestMutation.mutate()}
                        >
                          {ssoTestMutation.isPending ? "Testing…" : "Test login"}
                        </Button>
                      ) : null}
                    </div>
                    {isEditing ? (
                      <PolicyEditForm
                        policy={policy}
                        pending={updateMutation.isPending}
                        onCancel={() => setEditing(null)}
                        onSubmit={(input) =>
                          updateMutation.mutate({
                            policyType: policy.policyType,
                            ...input,
                          })
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </PageScroll>
  );
}

/* The "Enabled" chip here is hardcoded, and that is correct rather than the
 * fabrication it resembles: local email/password login cannot be turned off.
 * `apps/helix/src/platform/admin/security-policies.ts:92` types the field as
 * `z.literal(true).default(true)`, and :495-498 coerces an incoming `false`
 * back to `true`. It is the owner/admin lockout-recovery path, so the platform
 * refuses to let an SSO misconfiguration strand an operator. Reading it from
 * the policy would render a value that has exactly one possible state. */
function LocalLoginSecurityCard() {
  return (
    <div className="panel mb-3 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-2">
            <h3 className="m-0 font-semibold [font-size:var(--text-body)]">
              Local email/password login
            </h3>
            <StatusChip tone="success" label="Enabled" />
          </div>
          <div className="row gap-2 text-[var(--text-2)] [font-size:var(--text-meta)]">
            <Icons.Lock /> Owner/admin recovery path; SSO is additive.
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          type="button"
          aria-label="Open local login"
          onClick={() => {
            window.location.assign("/login");
          }}
        >
          Open
        </Button>
      </div>
    </div>
  );
}
