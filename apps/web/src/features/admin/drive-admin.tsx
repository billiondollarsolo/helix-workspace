import { cn } from "@/lib/utils";
/* Helix Admin — Drive quota usage + lifecycle policy (D11).
 *
 * Wired to real Drive admin tools (`drive.quota.usage`, `drive.lifecycle.*`).
 * Storage byte *limits* remain under Workspace settings; this section shows
 * live usage and trash/orphan lifecycle controls. Missing tools or scopes
 * disable controls with an explicit reason — never a silent no-op.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useServerSeededDraft } from "@/lib/use-server-seeded-draft";
import { AppStatusPanel, WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminField, AdminInput } from "@/features/admin/console/controls";
import {
  LoadingState,
  PageHeading,
  PanelHeading,
  QueryFailureBanner,
  useQueryFailure,
  ErrorNotice,
  Notice,
} from "@/features/admin/console/primitives";
import {
  describeDriveAdminUnavailable,
  driveAdminQueryKeys,
  driveLifecycleQueryOptions,
  driveQuotaQueryOptions,
  formatLifecycleSummary,
  formatQuotaSummary,
  lifecycleFormFromPolicy,
  mapLifecycleFormToToolInput,
  setDriveLifecyclePolicy,
  type DriveLifecycleFormInput,
  type DriveLifecyclePolicy,
  type DriveQuotaUsage,
} from "@/features/admin/drive-admin-api";

const PANEL = "admin-card";

const DRIVE_FLAGS = [
  {
    key: "drive_s3_api",
    label: "S3-compatible access",
    description:
      "Lets people create access keys to use Drive from S3 tools such as the AWS CLI and rclone.",
  },
] as const;

export function policyToForm(policy: DriveLifecyclePolicy): DriveLifecycleFormInput {
  return lifecycleFormFromPolicy(policy);
}

/**
 * Admin UI for organization Drive storage usage and lifecycle policy.
 */
export function DriveAdminSection() {
  const queryClient = useQueryClient();
  const quotaQuery = useQuery(driveQuotaQueryOptions());
  const lifecycleQuery = useQuery(driveLifecycleQueryOptions());
  const quotaFailure = useQueryFailure(quotaQuery, () => {
    void queryClient.invalidateQueries({ queryKey: driveAdminQueryKeys.quota() });
  });
  const lifecycleFailure = useQueryFailure(lifecycleQuery, () => {
    void queryClient.invalidateQueries({ queryKey: driveAdminQueryKeys.lifecycle() });
  });

  const policy = lifecycleQuery.data;
  const usage = quotaQuery.data;
  const primaryFailure = lifecycleFailure ?? quotaFailure;
  const unavailableReason =
    primaryFailure === null ? null : describeDriveAdminUnavailable(primaryFailure.error);
  const controlsDisabled =
    unavailableReason !== null || lifecycleQuery.isPending || quotaQuery.isPending;

  /* Quota events and flag changes refetch this section; unsaved edits survive them. */
  const lifecycleDraft = useServerSeededDraft(policy, (loaded): DriveLifecycleFormInput =>
    loaded === undefined
      ? { trashRetentionDays: "30", orphanGraceHours: "24" }
      : lifecycleFormFromPolicy(loaded),
  );
  const { draft: form, setDraft: setForm } = lifecycleDraft;
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (input: Parameters<typeof setDriveLifecyclePolicy>[0]) =>
      setDriveLifecyclePolicy(input),
    onMutate: () => {
      setFormError(null);
      setStatusMessage(null);
    },
    onError: (error: unknown) => {
      setFormError(error instanceof Error ? error.message : "Failed to set lifecycle policy.");
    },
    onSuccess: async (result) => {
      setStatusMessage(
        `Lifecycle saved: ${String(result.trashRetentionDays)} day trash retention · ${String(result.orphanGraceHours)}h orphan grace.`,
      );
      await queryClient.invalidateQueries({ queryKey: driveAdminQueryKeys.lifecycle() });
      await queryClient.invalidateQueries({ queryKey: driveAdminQueryKeys.quota() });
    },
    onSettled: () => {
      setConfirmSave(false);
    },
  });

  /* Mapped once per render and read by both the Save button and the
     confirmation, so the two cannot disagree about what is being saved. */
  const pendingLifecycle = mapLifecycleFormToToolInput(form);

  const onSave = () => {
    if (typeof pendingLifecycle === "string") {
      setFormError(pendingLifecycle);
      return;
    }
    setConfirmSave(true);
  };

  return (
    <div className="admin-stack" data-testid="drive-admin-section">
      <PageHeading title="Drive" subtitle="Storage, sharing access, and cleanup for Drive." />
      <AppStatusPanel appId="drive" />
      <WorkspaceFlagsPanel title="Access" flags={DRIVE_FLAGS} />

      {lifecycleFailure !== null ? (
        <QueryFailureBanner
          summary="Drive operator controls are unavailable"
          subject="Drive lifecycle and quota"
          error={lifecycleFailure.error}
          isRetrying={lifecycleFailure.isRetrying}
          onRetry={lifecycleFailure.retry}
        >
          <p className="admin-unavailable-reason">{unavailableReason}</p>
        </QueryFailureBanner>
      ) : null}
      {quotaFailure !== null && lifecycleFailure === null ? (
        <QueryFailureBanner
          summary="Drive storage usage is unavailable"
          subject="Drive quota usage"
          error={quotaFailure.error}
          isRetrying={quotaFailure.isRetrying}
          onRetry={quotaFailure.retry}
        />
      ) : null}
      {statusMessage !== null ? <Notice>{statusMessage}</Notice> : null}
      {formError !== null ? <ErrorNotice>{formError}</ErrorNotice> : null}

      <section className={PANEL} aria-labelledby="drive-quota-heading">
        <PanelHeading
          id="drive-quota-heading"
          title="Storage"
          subtitle="Used across the organization. Set the limit in Workspace settings."
        />
        <QuotaPanel usage={usage} loading={quotaQuery.isPending} />
      </section>

      <section className={PANEL} aria-labelledby="drive-lifecycle-heading">
        <PanelHeading
          id="drive-lifecycle-heading"
          title="Cleanup"
          subtitle="How long files stay in trash, and when abandoned uploads are removed."
        />
        {policy !== undefined ? (
          <p className="m-0 text-[var(--text-2)] type-meta">{formatLifecycleSummary(policy)}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField label="Trash retention (days)">
            <AdminInput
              inputMode="numeric"
              value={form.trashRetentionDays}
              disabled={controlsDisabled || saveMutation.isPending}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, trashRetentionDays: event.target.value }))
              }
            />
          </AdminField>
          <AdminField label="Orphan grace (hours)">
            <AdminInput
              inputMode="numeric"
              value={form.orphanGraceHours}
              disabled={controlsDisabled || saveMutation.isPending}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, orphanGraceHours: event.target.value }))
              }
            />
          </AdminField>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={controlsDisabled || saveMutation.isPending}
            onClick={onSave}
          >
            Save lifecycle policy
          </Button>
        </div>
      </section>

      <ConfirmDestructive
        open={confirmSave}
        onOpenChange={setConfirmSave}
        title="Save Drive lifecycle policy"
        confirmLabel="Save policy"
        isPending={saveMutation.isPending}
        blastRadius="Trashed files become hard-delete eligible after the retention window. Orphan garbage collection uses the grace hours you set. Existing trash expiry timestamps on already-trashed objects are not rewritten."
        onConfirm={() => {
          if (typeof pendingLifecycle === "string") {
            setFormError(pendingLifecycle);
            setConfirmSave(false);
            return;
          }
          const submitted = form;
          saveMutation.mutate(pendingLifecycle, {
            onSuccess: () => lifecycleDraft.markSaved(submitted),
          });
        }}
      >
        Save trash retention of {form.trashRetentionDays} days and orphan grace of{" "}
        {form.orphanGraceHours} hours for this organization.
      </ConfirmDestructive>
    </div>
  );
}

function QuotaPanel({
  usage,
  loading,
}: {
  readonly usage: DriveQuotaUsage | undefined;
  readonly loading: boolean;
}) {
  if (loading && usage === undefined) {
    return <LoadingState label="Loading storage usage" count={1} />;
  }
  if (usage === undefined) {
    return <p className="m-0 text-[var(--text-3)] type-meta">Storage usage is unavailable.</p>;
  }
  const pct = usage.percentUsed ?? 0;
  const barWidth = usage.unlimited ? 0 : Math.min(100, pct);
  return (
    <div className="grid gap-2" data-testid="drive-quota-panel">
      <p className="m-0 font-medium">{formatQuotaSummary(usage)}</p>
      {!usage.unlimited && usage.limitBytes !== null ? (
        <div
          aria-hidden="true"
          className="h-2 [border-radius:999px] bg-muted [border:1px_solid_var(--border)] overflow-hidden"
        >
          <div
            className={cn(
              "h-full",
              pct >= 90 ? "[background:var(--danger)]" : "[background:var(--accent)]",
            )}
            style={{ width: `${String(barWidth)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
