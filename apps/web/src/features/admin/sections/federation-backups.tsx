import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomId } from "@/lib/random-id";
import { Button } from "@/components/ui/button";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { PageHeading, LoadingState } from "@/features/admin/console/primitives";
import { federationApplicationsQueryOptions } from "@/features/admin/federation-applications-api";
import {
  federationBackupJobsQueryOptions,
  federationBackupsQueryOptions,
  federationBackupMutation,
  type BackupTarget,
} from "@/features/admin/federation-backups-api";

export function FederationBackups() {
  const targets = useQuery(federationBackupsQueryOptions()),
    jobs = useQuery(federationBackupJobsQueryOptions());
  const queries = useQueryClient();
  const recoveryId = useRef(randomId());
  const [adding, setAdding] = useState(false),
    [manifest, setManifest] = useState("");
  const refresh = async () => {
    await Promise.all([
      queries.invalidateQueries({ queryKey: ["admin", "federation-backups"] }),
      queries.invalidateQueries({ queryKey: ["admin", "federation-backup-jobs"] }),
    ]);
  };
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) =>
      federationBackupMutation(path, "POST", body),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: refresh,
  });
  const recoverySet = useMutation({
    mutationFn: () =>
      federationBackupMutation("federation-recovery-sets", "POST", { id: recoveryId.current }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (value) => {
      setManifest(JSON.stringify(value, null, 2));
      recoveryId.current = randomId();
    },
  });
  return (
    <>
      <PageHeading
        title="Federated backups"
        subtitle="Manage approved backup workers. Each app keeps its own backups, keys and local recovery."
        actions={
          <Button
            disabled={targets.data?.enabled !== true}
            onClick={() => setAdding((value) => !value)}
          >
            + Add backup target
          </Button>
        }
      />
      <p>
        Schedules run at the target through Workspace outages. Identity pairing grants no backup
        access. Restores create isolated targets; promoting them into production remains an operator
        action.
      </p>
      {targets.isPending ? <LoadingState label="Loading federated backup status" /> : null}
      {targets.data?.enabled === false ? (
        <p>
          Enable Workspace federation and install an operator-approved backup worker before
          connecting recovery.
        </p>
      ) : null}
      {[targets.error, jobs.error, action.error, recoverySet.error]
        .filter(Boolean)
        .map((error, index) => (
          <p key={index} role="alert">
            {error?.message}
          </p>
        ))}
      {adding ? (
        <Enrollment
          targets={targets.data?.targets ?? []}
          done={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      ) : null}
      {(targets.data?.targets ?? []).map((target) => (
        <Target key={target.id} target={target} refresh={refresh} />
      ))}
      <section className="admin-card grid gap-3" aria-label="Recovery operations">
        <h2>Recovery operations</h2>
        {(jobs.data?.jobs ?? []).length === 0 ? <p>No requested operations.</p> : null}
        {(jobs.data?.jobs ?? []).map((job) => (
          <div key={job.id} className="grid gap-2">
            <p>
              {job.request.kind} — {job.status.replaceAll("_", " ")}
              {job.error ? `: ${job.error}` : ""}
            </p>
            {job.canApprove ? (
              <Button
                variant="secondary"
                disabled={action.isPending}
                onClick={() =>
                  action.mutate({ path: `federation-backup-jobs/${job.id}/approve`, body: {} })
                }
              >
                Approve isolated restore
              </Button>
            ) : null}
          </div>
        ))}
        <Button
          variant="secondary"
          disabled={recoverySet.isPending || !targets.data?.targets.length}
          onClick={() => recoverySet.mutate()}
        >
          Record federation recovery set
        </Button>
        <p>
          Sets label independently captured snapshots. Complete requires a recent, verified receipt
          for Workspace and every connected app; it does not claim atomic cross-app recovery.
        </p>
        {manifest ? (
          <AdminField label="Recovery set manifest">
            <textarea className="admin-control" readOnly rows={10} value={manifest} />
          </AdminField>
        ) : null}
      </section>
    </>
  );
}
function Enrollment({ targets, done }: { targets: BackupTarget[]; done: () => Promise<void> }) {
  const applications = useQuery(federationApplicationsQueryOptions());
  const [application, setApplication] = useState("workspace"),
    [key, setKey] = useState(""),
    [restore, setRestore] = useState(""),
    [validation, setValidation] = useState("");
  const operation = useRef(randomId());
  const mutation = useMutation({
    mutationFn: (input: unknown) => federationBackupMutation("federation-backups", "POST", input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      setKey("");
      setRestore("");
      await done();
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !/^[a-f0-9]{64}$/u.test(key.trim()) ||
      (restore && (!/^[a-f0-9]{64}$/u.test(restore.trim()) || restore.trim() === key.trim()))
    ) {
      setValidation(
        "Enter separate complete backup and optional restore capabilities from the installation operator.",
      );
      return;
    }
    setValidation("");
    const applicationId = application === "workspace" ? null : application;
    mutation.mutate({
      id: targets.find((target) => target.applicationId === applicationId)?.id ?? operation.current,
      applicationId,
      managementKey: key.trim(),
      ...(restore ? { restoreKey: restore.trim() } : {}),
    });
  }
  return (
    <form
      className="admin-card grid gap-3"
      onSubmit={submit}
      noValidate
      aria-label="Connect backup worker"
    >
      <h2>Connect backup worker</h2>
      <p>
        The operator must install the worker at this app's trusted address and approve its
        destinations, retention floor and fixed recovery commands. Reconnecting an existing target
        rotates only its recovery capability.
      </p>
      <AdminField label="Application">
        <AdminSelect
          value={application}
          onChange={(event) => {
            setApplication(event.target.value);
            operation.current = randomId();
          }}
        >
          <option value="workspace">This Workspace</option>
          {applications.data?.applications
            .filter((app) => app.status === "active")
            .map((app) => (
              <option key={app.id} value={app.id}>
                {app.origin}
              </option>
            ))}
        </AdminSelect>
      </AdminField>
      <AdminField label="Backup management capability">
        <AdminInput
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          required
          maxLength={64}
        />
      </AdminField>
      <AdminField label="Independent restore capability (optional)">
        <AdminInput
          type="password"
          autoComplete="off"
          value={restore}
          onChange={(event) => setRestore(event.target.value)}
          maxLength={64}
        />
      </AdminField>
      {validation || mutation.error ? (
        <p role="alert">{validation || mutation.error?.message}</p>
      ) : null}
      <Button type="submit" disabled={mutation.isPending}>
        Review and connect recovery
      </Button>
    </form>
  );
}
function Target({ target, refresh }: { target: BackupTarget; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false),
    [restoring, setRestoring] = useState(false),
    [detaching, setDetaching] = useState(false);
  const operation = useRef(randomId());
  const action = useMutation({
    mutationFn: (kind: string) =>
      federationBackupMutation(`federation-backups/${target.id}/jobs`, "POST", {
        id: operation.current,
        kind,
      }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      operation.current = randomId();
      await refresh();
    },
  });
  const detach = useMutation({
    mutationFn: () => federationBackupMutation(`federation-backups/${target.id}`, "DELETE"),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      setDetaching(false);
      await refresh();
    },
  });
  const observation = target.observation;
  const latest = [...(observation?.jobs ?? [])]
    .reverse()
    .find((job) => job.status === "completed" && job.receipt);
  const stale = !target.observedAt || Date.now() - Date.parse(target.observedAt) > 60000;
  return (
    <section className="admin-card grid gap-3" aria-label={`Backups for ${target.origin}`}>
      <h2>
        {target.applicationId ? "Connected app" : "Workspace"} — {target.origin}
      </h2>
      <p>
        {target.status.replaceAll("_", " ")} ·{" "}
        {target.pending ? "Policy delivery pending" : `Policy revision ${target.policy.revision}`} ·{" "}
        {stale ? "Status overdue" : `Observed ${new Date(target.observedAt!).toLocaleString()}`}
      </p>
      <p>
        Application:{" "}
        {observation?.applicationHealthy == null
          ? "health probe not configured"
          : observation.applicationHealthy
            ? "healthy"
            : "unavailable"}
        . Scheduler: {observation?.scheduler ?? "unknown"}. Owner: {observation?.owner ?? "unknown"}
        .
      </p>
      <p>
        Latest completed recovery artifact:{" "}
        {latest?.receipt ? new Date(latest.receipt.createdAt).toLocaleString() : "none"}. Verified:{" "}
        {latest?.receipt?.verifiedAt ?? "not yet"}. Restore drill:{" "}
        {latest?.receipt?.restoredAt ?? "not yet"}.
      </p>
      <p>
        Required coverage: {observation?.requiredCoverage.join(", ") ?? "unknown"}. Alerts:{" "}
        {observation?.alerts.map((value) => value.replaceAll("_", " ")).join(", ") ||
          "none reported"}
        .
      </p>
      {target.error || action.error || detach.error ? (
        <p role="alert">{target.error ?? action.error?.message ?? detach.error?.message}</p>
      ) : null}
      {target.status === "active" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={action.isPending || !observation?.capabilities.includes("backup")}
            onClick={() => action.mutate("backup")}
          >
            Back up now
          </Button>
          <Button
            variant="secondary"
            disabled={observation?.scheduler !== "worker"}
            onClick={() => setEditing((value) => !value)}
          >
            Edit backup policy
          </Button>
          <Button
            variant="secondary"
            disabled={!target.restoreEnabled || !observation?.capabilities.includes("restore")}
            onClick={() => setRestoring((value) => !value)}
          >
            Request isolated restore
          </Button>
          <Button variant="secondary" onClick={() => setDetaching(true)}>
            Disconnect backup management
          </Button>
        </div>
      ) : null}
      {observation?.scheduler === "external" ? (
        <p>
          Its existing CNPG/Barman or operator scheduler remains authoritative. Change that schedule
          through deployment configuration.
        </p>
      ) : null}
      {target.status === "active" && editing ? (
        <Policy
          target={target}
          done={async () => {
            setEditing(false);
            await refresh();
          }}
        />
      ) : null}
      {target.status === "active" ? (
        restoring ? (
          <VerifyRestore key="restore" target={target} refresh={refresh} />
        ) : (
          <VerifyRestore key="verify" target={target} refresh={refresh} verifyOnly />
        )
      ) : null}
      <ConfirmDestructive
        open={detaching}
        onOpenChange={setDetaching}
        title="Disconnect backup management"
        confirmLabel="Disconnect"
        isPending={detach.isPending}
        onConfirm={() => detach.mutate()}
        blastRadius="Workspace recovery credentials are revoked. The worker retains its last policy and continues backups under local operator ownership. No backup is deleted."
      >
        Disconnect this recovery capability?
      </ConfirmDestructive>
    </section>
  );
}
function Policy({ target, done }: { target: BackupTarget; done: () => Promise<void> }) {
  const [draft, setDraft] = useState(target.policy),
    [review, setReview] = useState(false),
    [validation, setValidation] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      federationBackupMutation(`federation-backups/${target.id}/policy`, "PUT", {
        ...draft,
        revision: draft.revision + 1,
      }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: done,
  });
  const changed = target.policy.revision !== draft.revision;
  return (
    <form
      className="grid gap-3"
      noValidate
      aria-label="Backup policy"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !Number.isInteger(draft.intervalMinutes) ||
          draft.intervalMinutes < 5 ||
          draft.intervalMinutes > 10080 ||
          !Number.isInteger(draft.retentionDays) ||
          draft.retentionDays < (target.observation?.minimumRetentionDays ?? 1) ||
          draft.retentionDays > 3650
        ) {
          setValidation(
            "Choose an interval from 5 to 10080 minutes and retention within the operator's allowed range.",
          );
          return;
        }
        setValidation("");
        if (!draft.enabled || draft.retentionDays < target.policy.retentionDays) setReview(true);
        else mutation.mutate();
      }}
    >
      <AdminField label="Schedule">
        <AdminSelect
          value={draft.enabled ? "enabled" : "disabled"}
          onChange={(event) => setDraft({ ...draft, enabled: event.target.value === "enabled" })}
        >
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </AdminSelect>
      </AdminField>
      <AdminField label="Interval in minutes">
        <AdminInput
          type="number"
          min={5}
          max={10080}
          required
          value={draft.intervalMinutes}
          onChange={(event) => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })}
        />
      </AdminField>
      <AdminField label="Minimum retention in days">
        <AdminInput
          type="number"
          min={target.observation?.minimumRetentionDays ?? 1}
          max={3650}
          required
          value={draft.retentionDays}
          onChange={(event) => setDraft({ ...draft, retentionDays: Number(event.target.value) })}
        />
      </AdminField>
      <AdminField label="Approved destination">
        <AdminSelect
          value={draft.destinationRef}
          onChange={(event) => setDraft({ ...draft, destinationRef: event.target.value })}
        >
          {target.observation?.destinations.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </AdminSelect>
      </AdminField>
      {changed ? (
        <p role="status">
          The saved policy changed. Your draft is retained.{" "}
          <Button type="button" variant="secondary" onClick={() => setDraft(target.policy)}>
            Use current policy
          </Button>
        </p>
      ) : null}
      {validation ? <p role="alert">{validation}</p> : null}
      {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
      <Button type="submit" disabled={mutation.isPending || changed}>
        Save backup policy
      </Button>
      <ConfirmDestructive
        open={review}
        onOpenChange={setReview}
        title="Review recovery policy change"
        confirmLabel="Save policy"
        isPending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
        blastRadius={`Schedule ${draft.enabled ? "enabled" : "disabled"}; minimum retention ${draft.retentionDays} days at ${draft.destinationRef}. Existing backup retention remains subject to the operator's destination rules.`}
      >
        Review the operation and its recovery impact before continuing.
      </ConfirmDestructive>
    </form>
  );
}
function VerifyRestore({
  target,
  refresh,
  verifyOnly = false,
}: {
  target: BackupTarget;
  refresh: () => Promise<void>;
  verifyOnly?: boolean;
}) {
  const receipts = [
    ...new Map(
      (target.observation?.jobs ?? [])
        .filter((job) => job.status === "completed" && job.receipt)
        .map((job) => [job.receipt!.backupId, job.receipt!]),
    ).values(),
  ];
  const [backupId, setBackupId] = useState(""),
    [name, setName] = useState(""),
    [review, setReview] = useState(false),
    [error, setError] = useState("");
  const operation = useRef(randomId());
  const mutation = useMutation({
    mutationFn: (kind: "verify" | "restore") =>
      federationBackupMutation(`federation-backups/${target.id}/jobs`, "POST", {
        id: operation.current,
        kind,
        backupId,
        ...(kind === "restore"
          ? {
              targetDatabase: `helix_restore_${name}`,
              ...(target.applicationId === null
                ? { targetObjectBucket: `helix-restore-${name.replaceAll("_", "-")}` }
                : {}),
            }
          : {}),
      }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: async () => {
      operation.current = randomId();
      setReview(false);
      await refresh();
    },
  });
  return (
    <form
      className="grid gap-3"
      noValidate
      aria-label={verifyOnly ? "Verify backup" : "Isolated restore"}
      onSubmit={(event) => {
        event.preventDefault();
        if (!backupId || (!verifyOnly && !/^[a-z0-9][a-z0-9_]{0,31}$/u.test(name))) {
          setError(
            "Choose a backup and a new recovery name using lowercase letters, digits and underscores.",
          );
          return;
        }
        setError("");
        if (verifyOnly) mutation.mutate("verify");
        else setReview(true);
      }}
    >
      <AdminField label="Recovery artifact">
        <AdminSelect
          value={backupId}
          onChange={(event) => {
            setBackupId(event.target.value);
            operation.current = randomId();
          }}
          required
        >
          <option value="">Choose a completed backup</option>
          {receipts
            .filter((receipt) => verifyOnly || receipt.verifiedAt)
            .map((receipt) => (
              <option key={receipt.backupId} value={receipt.backupId}>
                {new Date(receipt.createdAt).toLocaleString()} · {receipt.appVersion}
              </option>
            ))}
        </AdminSelect>
      </AdminField>
      {!verifyOnly ? (
        <AdminField label="New isolated recovery name">
          <AdminInput
            value={name}
            maxLength={32}
            required
            onChange={(event) => {
              setName(event.target.value);
              operation.current = randomId();
            }}
          />
        </AdminField>
      ) : null}
      {error || mutation.error ? <p role="alert">{error || mutation.error?.message}</p> : null}
      <Button
        type="submit"
        variant="secondary"
        disabled={mutation.isPending || !receipts.length || target.status !== "active"}
      >
        {verifyOnly ? "Verify selected backup" : "Review isolated restore"}
      </Button>
      <ConfirmDestructive
        open={review}
        onOpenChange={setReview}
        title="Request isolated restore"
        confirmLabel="Request restore"
        isPending={mutation.isPending}
        onConfirm={() => mutation.mutate("restore")}
        blastRadius={`Restore ${backupId} into new database helix_restore_${name}${target.applicationId === null ? ` and bucket helix-restore-${name.replaceAll("_", "-")}` : ""}. Production is not replaced. Another recovery administrator must approve when policy requires it.`}
      >
        Review the operation and its recovery impact before continuing.
      </ConfirmDestructive>
    </form>
  );
}
