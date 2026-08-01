/* Admin › Security › Policies — authentication, access, and data protection. */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
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
import {
  EmptyState,
  INPUT_STYLE,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";

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

/** Map a policy's enforcement to the design's level-chip text + on/off color. */
function policyLevel(policy: SecurityPolicy): { text: string; on: boolean } {
  if (!policy.enabled) {
    return { text: "Off", on: false };
  }
  if (policy.enforcement === "required") {
    return { text: "Required", on: true };
  }
  if (policy.enforcement === "optional") {
    return { text: "Active", on: true };
  }
  return { text: "Limited", on: false };
}

/** Render a policy's settings blob as a compact descriptive line. */
function policySettingsSummary(policy: SecurityPolicy): string {
  const settings = policy.settings;
  const get = (key: string): unknown => settings[key];
  switch (policy.policyType) {
    case "mfa": {
      const methods = get("allowedMethods");
      return Array.isArray(methods) ? `Methods: ${methods.join(", ")}` : "";
    }
    case "sso": {
      const provider = get("provider");
      const providerSummary = typeof provider === "string" ? `Provider: ${provider}` : "";
      const localSummary = "Local email/password: enabled";
      return [providerSummary, localSummary].filter(Boolean).join(" · ");
    }
    case "session": {
      const days = get("inactivityTimeoutDays");
      return typeof days === "number" ? `${String(days)}-day inactivity timeout` : "";
    }
    case "external_sharing": {
      const mode = get("mode");
      return typeof mode === "string" ? `Sharing mode: ${mode}` : "";
    }
    case "dlp": {
      const detectors = get("detectors");
      return Array.isArray(detectors) ? `Detectors: ${detectors.join(", ")}` : "";
    }
    case "device_trust": {
      const apps = get("protectedApps");
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

  return (
    <form
      style={{ marginTop: 12, display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ enabled, enforcement });
      }}
    >
      <label className="row gap-2" style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}>
        <input
          type="checkbox"
          aria-label={`Enable ${securityPolicyLabels[policy.policyType]}`}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          style={{ accentColor: "var(--accent)" }}
        />
        Policy enabled
      </label>
      <label style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
        Enforcement
        <select
          aria-label={`Enforcement for ${securityPolicyLabels[policy.policyType]}`}
          value={enforcement}
          onChange={(event) => setEnforcement(event.target.value as PolicyEnforcement)}
          style={{ ...INPUT_STYLE, width: "100%", marginTop: 4 }}
        >
          <option value="disabled">Disabled</option>
          <option value="optional">Optional</option>
          <option value="required">Required</option>
        </select>
      </label>
      {policy.policyType === "sso" ? (
        <label
          className="row gap-2"
          style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}
        >
          <input
            type="checkbox"
            aria-label="Local email/password login enabled"
            checked
            disabled
            readOnly
            style={{ accentColor: "var(--accent)" }}
          />
          Local email/password login remains enabled
        </label>
      ) : null}
      {/* Save is this card's single filled button; Cancel and the card's own
          Edit/Test controls stay outlined beside it. */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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

export function AdminSecurity() {
  const queryClient = useQueryClient();
  const policiesQuery = useQuery(securityPoliciesQueryOptions());
  const [editing, setEditing] = useState<SecurityPolicyType | null>(null);
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

      {/* Every one of these six is stored, versioned and audited, and none is
          read by any runtime path — no login checks the MFA policy, no share
          checks the external-sharing allowlist, no message is scanned against
          the DLP settings. A chip reading "Required" over a control that
          enforces nothing is the most dangerous thing this console could say,
          because an operator configures it and stops looking. Until the
          enforcement points exist, the page has to lead with what it is. */}
      <StateBanner kind="info">
        These policies are recorded and audited, but Helix does not enforce them yet. Saving one
        captures your intent and leaves an audit trail — it does not change what the platform
        allows. Configure the equivalent control at your identity provider or gateway until
        enforcement ships.
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
      {updateMutation.isError ? (
        <StateBanner kind="error">{updateMutation.error.message}</StateBanner>
      ) : null}
      {ssoTestMutation.isError ? (
        <StateBanner kind="error">{ssoTestMutation.error.message}</StateBanner>
      ) : null}
      {ssoTestResult === null ? null : (
        <StateBanner kind={ssoTestResult.status === "runtime_pending" ? "info" : "error"}>
          {ssoTestResult.message}
        </StateBanner>
      )}

      {policiesFailure !== null ? null : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {POLICY_GROUPS.map((label) => (
            <section key={label} aria-labelledby={POLICY_GROUP_HEADING_ID[label]}>
              <h2 className="mb-2 text-sm font-semibold" id={POLICY_GROUP_HEADING_ID[label]}>
                {label}
              </h2>
              {label === "Authentication" ? <LocalLoginSecurityCard /> : null}
              {/* A column with nothing in it is indistinguishable from a column
                  that failed to render; say which policies would live here. */}
              {policiesQuery.isSuccess && grouped[label].length === 0 ? (
                <EmptyState
                  icon={<Icons.Lock />}
                  title={
                    label === "Authentication"
                      ? "No authentication policies"
                      : "No access or data policies"
                  }
                >
                  {label === "Authentication"
                    ? "Multi-factor, single sign-on, and session policies appear here once the workspace defines them."
                    : "External sharing, data-loss prevention, and device-trust policies appear here once the workspace defines them."}
                </EmptyState>
              ) : null}
              {grouped[label].map((policy) => {
                const level = policyLevel(policy);
                const isEditing = editing === policy.policyType;
                const settingsSummary = policySettingsSummary(policy);
                return (
                  <div
                    key={policy.policyType}
                    className="panel"
                    style={{ padding: 16, marginBottom: 12 }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 4,
                          }}
                        >
                          {/* h3 under the column's h2 — one card is one policy,
                              and its name is the only thing identifying it. */}
                          <h3 className="m-0 font-semibold [font-size:var(--text-body)]">
                            {securityPolicyLabels[policy.policyType]}
                          </h3>
                          <span className={`chip ${level.on ? "success" : "warning"}`}>
                            <span className="chip-dot" />
                            {level.text}
                          </span>
                        </div>
                        {/* An empty summary would leave a key icon labelling
                            nothing, so the row renders only when there is a
                            setting to describe. */}
                        {settingsSummary.length === 0 ? null : (
                          <div
                            className="row gap-2"
                            style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}
                          >
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
                          setEditing((current) =>
                            current === policy.policyType ? null : policy.policyType,
                          )
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
    <div className="panel" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 4,
            }}
          >
            <h3 className="m-0 font-semibold [font-size:var(--text-body)]">
              Local email/password login
            </h3>
            <span className="chip success">
              <span className="chip-dot" />
              Enabled
            </span>
          </div>
          <div
            className="row gap-2"
            style={{ fontSize: "var(--text-meta)", color: "var(--text-2)" }}
          >
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
