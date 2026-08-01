/* Admin › Apps & integrations › OAuth apps — third-party grants on workspace data. */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import {
  defaultOAuthAppsInput,
  oauthAppsQueryKeys,
  oauthAppsQueryOptions,
  revokeOAuthApp,
  setOAuthAppStatus,
  type OAuthApp,
  type OAuthAppRisk,
  type OAuthAppsQueryInput,
  type OAuthAppStatus,
} from "@/features/admin/oauth-apps-api";
import {
  EmptyRow,
  EmptyState,
  HEADER_CELL,
  INPUT_STYLE,
  PageHeading,
  PageScroll,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
} from "@/features/admin/console/primitives";

/* ------------------------------------------------------------------ */
/* Apps                                                               */
/* ------------------------------------------------------------------ */

const APPS_GRID = "1fr 1.4fr 70px 90px 100px 180px";

/** Ties the disabled filters to the sentence explaining why, so a screen reader
 *  reaches the reason from the control rather than by hunting for it. */
const FILTERS_REASON_ID = "oauth-apps-filters-unavailable";

const NO_GRANTS_REASON =
  "No app has been granted OAuth access yet, so there is nothing to filter. These controls come back as soon as a grant exists.";

/** The console's inputs carry their colours inline, which overrides the browser's
 *  own disabled rendering — a disabled filter has to be dimmed by hand. */
const DISABLED_CONTROL: React.CSSProperties = { opacity: 0.55, cursor: "not-allowed" };

function riskVariant(risk: OAuthAppRisk): string {
  return risk === "high" ? "danger" : risk === "medium" ? "warning" : "success";
}

function statusVariant(status: OAuthAppStatus): string {
  if (status === "approved") {
    return "success";
  }
  if (status === "blocked" || status === "revoked") {
    return "danger";
  }
  return "warning";
}

interface AppsRow {
  readonly id: string | null;
  readonly name: string;
  readonly scope: string;
  readonly users: number;
  readonly risk: OAuthAppRisk;
  readonly status: OAuthAppStatus;
}

/** What the operator is about to revoke, captured at click time.
 *
 *  The list refetches on its own and rows can reorder or disappear underneath
 *  an open dialog; reading the name and the user count off a live row would let
 *  the confirmation describe one app while revoking another. */
interface RevokeTarget {
  readonly id: string;
  readonly name: string;
  readonly users: number;
}

/** The blast radius sentence, built from the API's own `userCount`.
 *
 *  `userCount` is required by the OAuth app schema, so there is always a real
 *  number here — no branch may guess one. Zero is a fact worth stating, not a
 *  reason to fall back to vague copy. */
function tokenHolderNote(users: number): string {
  if (users === 1) {
    return "1 user currently holds a token for this app. Their token stops working the moment you revoke.";
  }
  if (users === 0) {
    return "No user currently holds a token for this app, so revoking ends the registration rather than any live session.";
  }
  return `${String(users)} users currently hold tokens for this app. Every one of those tokens stops working the moment you revoke.`;
}

export function AdminApps() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"all" | OAuthAppStatus>("all");
  const [riskFilter, setRiskFilter] = useState<"all" | OAuthAppRisk>("all");
  const [query, setQuery] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<RevokeTarget | null>(null);

  const queryInput = useMemo<OAuthAppsQueryInput>(
    () => ({
      limit: defaultOAuthAppsInput.limit,
      ...(statusFilter === "all" ? {} : { status: statusFilter }),
      ...(riskFilter === "all" ? {} : { risk: riskFilter }),
      ...(query.trim().length === 0 ? {} : { query: query.trim() }),
    }),
    [statusFilter, riskFilter, query],
  );
  const appsQuery = useQuery(oauthAppsQueryOptions(queryInput));

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: oauthAppsQueryKeys.all() });

  const statusMutation = useMutation({
    mutationFn: (input: { id: string; status: "approved" | "pending" | "blocked" }) =>
      setOAuthAppStatus(input.id, input.status),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });
  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeOAuthApp(id),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => invalidate(),
  });

  const rows = useMemo<readonly AppsRow[]>(
    () =>
      (appsQuery.data?.apps ?? []).map((app: OAuthApp) => ({
        id: app.id,
        name: app.name,
        scope: app.scopeSummary || app.scopes.join(", ") || "—",
        users: app.userCount,
        risk: app.risk,
        status: app.status,
      })),
    [appsQuery.data],
  );

  const mutating = statusMutation.isPending || revokeMutation.isPending;

  /* The filters are part of the query key, so retrying has to re-run the
     request the operator is actually looking at — invalidate that key rather
     than the observer's own refetch, which lint bans. */
  const appsFailure = useQueryFailure(appsQuery, () => {
    void queryClient.invalidateQueries({ queryKey: oauthAppsQueryKeys.list(queryInput) });
  });

  const filtersActive = statusFilter !== "all" || riskFilter !== "all" || query.trim().length > 0;

  /* The workspace has no grants at all — not "none matched", which is a state
     only a filter can produce, and which must leave the filters live so the
     operator can clear them. */
  const noGrants = appsQuery.isSuccess && rows.length === 0 && !filtersActive;

  /* Every filter re-keys the query, so leaving them live over a failed or
     empty list offers three controls that cannot change what is on screen.
     Disabled with the reason beside them, per the console's no-dead-control
     rule; both conditions clear themselves the moment the list has rows. */
  const filtersDisabled = appsFailure !== null || noGrants;
  const filterStyle: React.CSSProperties = filtersDisabled
    ? { ...INPUT_STYLE, ...DISABLED_CONTROL }
    : INPUT_STYLE;

  return (
    <PageScroll>
      {/* Named for the sidebar entry that opens it: "App permissions" sent an
          operator looking for OAuth grants to a page that appeared to be about
          something else, and "Apps" in this console also means the first-party
          modules under Workspace apps. */}
      <PageHeading
        title="OAuth apps"
        subtitle="Third-party apps that have OAuth access to Helix Workspace data"
      />

      <div style={{ marginBottom: 12 }}>
        <div
          aria-label="OAuth app filters"
          role="group"
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <div
            className="search"
            style={
              filtersDisabled
                ? { maxWidth: 280, height: 30, ...DISABLED_CONTROL }
                : { maxWidth: 280, height: 30 }
            }
          >
            <Icons.Search />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter apps…"
              aria-label="Filter apps"
              aria-describedby={noGrants ? FILTERS_REASON_ID : undefined}
              disabled={filtersDisabled}
            />
          </div>
          <select
            aria-label="Filter by status"
            aria-describedby={noGrants ? FILTERS_REASON_ID : undefined}
            value={statusFilter}
            disabled={filtersDisabled}
            onChange={(event) => setStatusFilter(event.target.value as "all" | OAuthAppStatus)}
            style={filterStyle}
          >
            <option value="all">All statuses</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            <option value="blocked">Blocked</option>
            <option value="revoked">Revoked</option>
          </select>
          <select
            aria-label="Filter by risk"
            aria-describedby={noGrants ? FILTERS_REASON_ID : undefined}
            value={riskFilter}
            disabled={filtersDisabled}
            onChange={(event) => setRiskFilter(event.target.value as "all" | OAuthAppRisk)}
            style={filterStyle}
          >
            <option value="all">All risk levels</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        {/* Never a dead control: with nothing to filter, the reason sits under
          the controls it disables. The failure case states its own reason in
          the banner below, so it is not repeated here. */}
        {noGrants ? (
          <p
            className="admin-unavailable-reason"
            id={FILTERS_REASON_ID}
            style={{ margin: "6px 0 0" }}
          >
            {NO_GRANTS_REASON}
          </p>
        ) : null}
      </div>

      {appsFailure !== null ? (
        <QueryFailureBanner
          summary="OAuth apps are unavailable"
          subject="OAuth apps"
          error={appsFailure.error}
          isRetrying={appsFailure.isRetrying}
          onRetry={appsFailure.retry}
          /* The grant table is the page; with it gone the retry is the only
             thing left to do here. */
          retryVariant="default"
        >
          The search, status, and risk filters stay disabled until the list loads — each one re-runs
          this same request. Existing grants are unaffected; this is a console read failure, and no
          app has lost or gained access.
        </QueryFailureBanner>
      ) : appsQuery.isPending ? (
        <StateBanner kind="loading">Loading OAuth apps…</StateBanner>
      ) : null}
      {statusMutation.isError ? (
        <StateBanner kind="error">{statusMutation.error.message}</StateBanner>
      ) : null}
      {revokeMutation.isError ? (
        <StateBanner kind="error">{revokeMutation.error.message}</StateBanner>
      ) : null}

      {/* A column header over nothing is not an explanation. This is the
          shadow-IT surface, and blank is its normal state — so blank has to say
          what a grant is, why the list is worth watching, and what to do with a
          row when one turns up. A filtered-to-nothing table keeps its header and
          the inline row instead: there the frame is the context. */}
      {appsFailure === null && noGrants ? (
        <EmptyState icon={<Icons.Grid />} title="No app has been granted OAuth access">
          An OAuth grant is a standing authorization: a workspace user consents once, and the app
          keeps its own token for workspace data until an admin revokes it. This is where apps
          someone connected on their own become visible to you. Each row that appears carries the
          scope the app asked for and how many users hold a token for it — approve the ones this
          workspace sanctions, block the ones it does not, and revoke to delete every token already
          issued.
        </EmptyState>
      ) : null}

      {appsFailure !== null || noGrants ? null : (
        <div className="panel">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: APPS_GRID,
              padding: "0 16px",
              height: 32,
              alignItems: "center",
              borderBottom: "1px solid var(--border)",
              background: "var(--surface-2)",
              ...HEADER_CELL,
            }}
          >
            <span>App</span>
            <span>Requested scope</span>
            <span>Users</span>
            <span>Risk</span>
            <span>Status</span>
            <span />
          </div>
          {rows.length === 0 ? (
            /* "No grants exist" is the EmptyState above and is only ever said
               after a successful load. The last branch here is a not-loaded
               list, which must not read as an empty one. */
            <EmptyRow>
              {appsQuery.isPending
                ? "Loading apps…"
                : filtersActive
                  ? "No OAuth apps match the filters."
                  : "The OAuth app list is not loaded."}
            </EmptyRow>
          ) : (
            rows.map((app, index) => (
              <div
                key={app.id ?? app.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: APPS_GRID,
                  padding: "0 16px",
                  height: 40,
                  alignItems: "center",
                  fontSize: "var(--text-meta)",
                  borderBottom: index < rows.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div className="row gap-2">
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 5,
                      background: "var(--surface-2)",
                      border: "1px solid var(--border)",
                      display: "grid",
                      placeItems: "center",
                      fontSize: "var(--text-caption)",
                      fontWeight: 600,
                    }}
                  >
                    {app.name[0]}
                  </div>
                  <span style={{ fontWeight: 500 }}>{app.name}</span>
                </div>
                <span className="truncate" style={{ color: "var(--text-2)" }}>
                  {app.scope}
                </span>
                <span>{app.users}</span>
                <span>
                  <span className={`chip ${riskVariant(app.risk)}`}>
                    <span className="chip-dot" />
                    {app.risk}
                  </span>
                </span>
                <span>
                  <span className={`chip ${statusVariant(app.status)}`}>{app.status}</span>
                </span>
                {/* Approve and Block are peers — both flip a status the operator
                    can flip straight back — so they carry the same weight.
                    Revoke is the one action here that cannot be undone, and it
                    used to be the third identical grey button in the row. */}
                <div style={{ display: "flex", gap: 6, justifySelf: "flex-end" }}>
                  {app.id !== null && app.status !== "revoked" ? (
                    <>
                      {app.status !== "approved" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Approve ${app.name}`}
                          disabled={mutating}
                          onClick={() =>
                            statusMutation.mutate({ id: app.id ?? "", status: "approved" })
                          }
                        >
                          Approve
                        </Button>
                      ) : null}
                      {app.status !== "blocked" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Block ${app.name}`}
                          disabled={mutating}
                          onClick={() =>
                            statusMutation.mutate({ id: app.id ?? "", status: "blocked" })
                          }
                        >
                          Block
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        aria-label={`Revoke ${app.name}`}
                        disabled={mutating}
                        onClick={() =>
                          setRevokeTarget({
                            id: app.id ?? "",
                            name: app.name,
                            users: app.users,
                          })
                        }
                      >
                        Revoke
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Irreversible and it reaches past the app itself, so the confirmation
          carries a blast radius but no typed phrase: a revoked grant is
          recoverable by the users re-authorizing, not by a support ticket. */}
      {revokeTarget === null ? null : (
        <ConfirmDestructive
          open
          onOpenChange={(next) => {
            if (!next) {
              setRevokeTarget(null);
            }
          }}
          title="Revoke OAuth app"
          blastRadius={tokenHolderNote(revokeTarget.users)}
          confirmLabel="Revoke access"
          isPending={revokeMutation.isPending}
          onConfirm={() =>
            revokeMutation.mutate(revokeTarget.id, {
              /* Close on settle, not on success: the failure message renders in
                 the page banner behind this dialog's overlay, so staying open
                 would hide the only report of what went wrong. */
              onSettled: () => setRevokeTarget(null),
            })
          }
        >
          Revoking <strong>{revokeTarget.name}</strong> deletes every OAuth token issued to it. The
          app loses access to workspace data immediately, and this console cannot restore it — each
          user would have to authorize the app again.
        </ConfirmDestructive>
      )}
    </PageScroll>
  );
}
