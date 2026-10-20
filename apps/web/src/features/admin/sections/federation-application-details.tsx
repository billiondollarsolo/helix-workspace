import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/features/admin/console/primitives";
import { CopyableId, RelativeTime } from "@/features/admin/console/widgets";
import type { FederationApplication } from "@/features/admin/federation-applications-api";
import {
  federationBackupsQueryOptions,
  type BackupTarget,
} from "@/features/admin/federation-backups-api";

export function ApplicationSynchronization({
  application,
  compact = false,
}: {
  readonly application: FederationApplication;
  readonly compact?: boolean;
}) {
  const overdue =
    application.status === "active" &&
    (!application.lastSyncedAt || Date.now() - Date.parse(application.lastSyncedAt) >= 45_000);
  return (
    <div className="grid gap-1" role="status">
      <p>
        Connection: {application.status.replaceAll("-", " ")}. Directory:{" "}
        {application.pending
          ? "changes pending"
          : application.status !== "active"
            ? "not active"
            : overdue
              ? "verification overdue"
              : "recently verified"}
        .
      </p>
      {!compact ? (
        <p>
          Last directory verification:{" "}
          <RelativeTime value={application.lastSyncedAt} fallback="not yet verified" />.
        </p>
      ) : null}
      {application.rotationPending ? <p>Connection credential delivery is pending.</p> : null}
      {overdue && !compact ? (
        <p>
          Managed access requires current directory authority. Check the app and connection if
          verification does not resume.
        </p>
      ) : null}
    </div>
  );
}

export function FederationApplicationDetails({
  application,
}: {
  readonly application: FederationApplication;
}) {
  const backups = useQuery(federationBackupsQueryOptions());
  const queries = useQueryClient();
  const targets =
    backups.data?.targets.filter((target) => target.applicationId === application.id) ?? [];
  return (
    <div className="grid min-w-0 gap-4" aria-label="Application details" role="region">
      <details className="admin-disclosure">
        <summary>Connection identifiers</summary>
        <dl className="admin-facts">
          <div>
            <dt>Application ID</dt>
            <dd>
              <CopyableId label="application ID" value={application.id} />
            </dd>
          </div>
          <div>
            <dt>Installation ID</dt>
            <dd>
              <CopyableId label="installation ID" value={application.installationId} />
            </dd>
          </div>
          <div>
            <dt>App tenancy ID</dt>
            <dd>
              <CopyableId label="app tenancy ID" value={application.tenantId} />
            </dd>
          </div>
        </dl>
      </details>
      <p>
        Workspace manages sign-in and directory access through this connection. App-specific
        policies and controls are managed in the application.
      </p>
      <p>
        <a href={application.origin} target="_blank" rel="noopener noreferrer">
          Open application
        </a>
      </p>
      <section className="admin-section" aria-label="Backup capability">
        <h2>Backup capability</h2>
        <p>
          Backup management requires separate enrollment and permissions. These observations do not
          change app access or authorize recovery operations.
        </p>
        {backups.isPending ? <LoadingState label="Loading backup capability" /> : null}
        {backups.error ? (
          <p role="alert">Backup status unavailable. {backups.error.message}</p>
        ) : null}
        {backups.data?.enabled === false ? (
          <p>Federated backup management is not enabled.</p>
        ) : null}
        {backups.data?.enabled && !backups.error && targets.length === 0 ? (
          <p>No backup worker is enrolled for this application.</p>
        ) : null}
        {targets.map((target) => (
          <BackupCapability key={target.id} target={target} available={!backups.isError} />
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={backups.isFetching}
            onClick={() =>
              void queries.invalidateQueries({
                queryKey: ["admin", "federation-backups"],
                exact: true,
              })
            }
          >
            {backups.isFetching ? "Refreshing…" : "Refresh backup status"}
          </Button>
          <Link to="/admin/$section" params={{ section: "federation-backups" }}>
            Manage federated backups
          </Link>
        </div>
      </section>
    </div>
  );
}

function BackupCapability({
  target,
  available,
}: {
  readonly target: BackupTarget;
  readonly available: boolean;
}) {
  const observation = target.observation;
  const stale = !target.observedAt || Date.now() - Date.parse(target.observedAt) >= 60_000;
  const current = available && target.status === "active" && !target.error && !stale;
  const latest = [...(observation?.jobs ?? [])]
    .reverse()
    .find((job) => job.status === "completed" && job.receipt)?.receipt;
  return (
    <section className="grid min-w-0 gap-2" aria-label={`Backup worker ${target.id}`}>
      <h3>
        Worker <CopyableId label="backup target ID" value={target.id} />
      </h3>
      <p>
        Status: {target.status.replaceAll("_", " ")}. {stale ? "Observation overdue." : ""} Last
        observed: <RelativeTime value={target.observedAt} fallback="never" />.
      </p>
      {target.error ? <p role="alert">{target.error}</p> : null}
      <p>
        Application health:{" "}
        {!current
          ? "unavailable; last observation is not current"
          : observation?.applicationHealthy == null
            ? "probe not configured"
            : observation.applicationHealthy
              ? "healthy"
              : "unavailable"}
        .
      </p>
      {observation ? (
        <>
          <p>
            Reported capabilities: {observation.capabilities.join(", ") || "none"}. Protocol:{" "}
            {observation.protocol}.
          </p>
          <p>
            Isolated restore:{" "}
            {!target.restoreEnabled
              ? "not enrolled"
              : !observation.capabilities.includes("restore")
                ? "not supported by the worker"
                : !current
                  ? "enrolled; status unavailable"
                  : "enrolled; requires a separate reviewed request"}
            .
          </p>
          <p>
            Scheduler:{" "}
            {observation.scheduler === "external" ? "external operator" : "backup worker"}. Policy
            authority at last observation:{" "}
            {observation.owner === "workspace" ? "Workspace" : "local operator"}.
          </p>
          {observation.scheduler === "external" ? (
            <p>
              The external operator owns the schedule; the Workspace interval does not schedule
              backups.
            </p>
          ) : null}
          <p>
            Last acknowledged policy: revision {observation.policy.revision};{" "}
            {observation.policy.enabled ? "enabled" : "disabled"};{" "}
            {observation.policy.intervalMinutes} minute interval; {observation.policy.retentionDays}{" "}
            day retention; destination {observation.policy.destinationRef}.
          </p>
          <p>
            Desired Workspace policy: revision {target.policy.revision}.{" "}
            {target.pending
              ? "Delivery pending; the desired policy is not yet acknowledged."
              : "No delivery pending."}
          </p>
          <p>
            Required coverage: {observation.requiredCoverage.join(", ")}. Alerts:{" "}
            {observation.alerts.map((alert) => alert.replaceAll("_", " ")).join(", ") ||
              "none reported"}
            .
          </p>
        </>
      ) : (
        <p>No worker observation is available.</p>
      )}
      <p>
        Artifact from last completed operation:{" "}
        <RelativeTime value={latest?.createdAt} fallback="none reported" />. Verified:{" "}
        <RelativeTime value={latest?.verifiedAt} fallback="not verified" />. Isolated restore:{" "}
        <RelativeTime value={latest?.restoredAt} fallback="not recorded" />.
      </p>
      {latest ? (
        <p>
          Version captured in that artifact: {latest.appVersion}; schema {latest.schemaVersion}.
          This is not a current version probe.
        </p>
      ) : null}
    </section>
  );
}
