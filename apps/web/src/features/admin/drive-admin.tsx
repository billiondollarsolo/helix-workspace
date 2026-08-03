/* Helix Admin — Drive quota usage + lifecycle policy (D11).
 *
 * Wired to real Drive admin tools (`drive.quota.usage`, `drive.lifecycle.*`).
 * Storage byte *limits* remain under Workspace settings; this section shows
 * live usage and trash/orphan lifecycle controls. Missing tools or scopes
 * disable controls with an explicit reason — never a silent no-op.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminField, AdminInput } from "@/features/admin/console/controls";
import {
  PageHeading,
  QueryFailureBanner,
  StateBanner,
  useQueryFailure,
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

const PANEL = "grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4";

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

  const [form, setForm] = useState<DriveLifecycleFormInput>({
    trashRetentionDays: "30",
    orphanGraceHours: "24",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);

  useEffect(() => {
    if (policy !== undefined) {
      setForm(lifecycleFormFromPolicy(policy));
    }
  }, [policy]);

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

  const onSave = () => {
    const mapped = mapLifecycleFormToToolInput(form);
    if (typeof mapped === "string") {
      setFormError(mapped);
      return;
    }
    setConfirmSave(true);
  };

  return (
    <div className="grid gap-6" data-testid="drive-admin-section">
      <PageHeading
        title="Drive"
        subtitle="Storage usage and trash/orphan lifecycle for this organization. Byte limits are set under Workspace settings."
      />

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
          retryVariant="outline"
        />
      ) : null}
      {statusMessage !== null ? <StateBanner kind="info">{statusMessage}</StateBanner> : null}
      {formError !== null ? <StateBanner kind="error">{formError}</StateBanner> : null}

      <section className={PANEL} aria-labelledby="drive-quota-heading">
        <h2 id="drive-quota-heading" className="m-0 text-[var(--text-h3)] font-semibold">
          Storage usage
        </h2>
        <p className="m-0 text-[var(--text-3)] [font-size:var(--text-meta)]">
          Live usage against the effective <code>storage_bytes_limit</code>. Change the limit in
          Workspace settings → Quotas.
        </p>
        <QuotaPanel usage={usage} loading={quotaQuery.isPending} />
      </section>

      <section className={PANEL} aria-labelledby="drive-lifecycle-heading">
        <h2 id="drive-lifecycle-heading" className="m-0 text-[var(--text-h3)] font-semibold">
          Lifecycle policy
        </h2>
        <p className="m-0 text-[var(--text-3)] [font-size:var(--text-meta)]">
          Controls how long trashed files are retained before hard-delete eligibility, and how long
          orphaned uploads wait before garbage collection.
        </p>
        {policy !== undefined ? (
          <p className="m-0 text-[var(--text-2)] [font-size:var(--text-meta)]">
            {formatLifecycleSummary(policy)}
          </p>
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
          const mapped = mapLifecycleFormToToolInput(form);
          if (typeof mapped === "string") {
            setFormError(mapped);
            setConfirmSave(false);
            return;
          }
          saveMutation.mutate(mapped);
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
    return (
      <p className="m-0 text-[var(--text-3)] [font-size:var(--text-meta)]" role="status">
        Loading storage usage…
      </p>
    );
  }
  if (usage === undefined) {
    return (
      <p className="m-0 text-[var(--text-3)] [font-size:var(--text-meta)]">
        Storage usage is unavailable.
      </p>
    );
  }
  const pct = usage.percentUsed ?? 0;
  const barWidth = usage.unlimited ? 0 : Math.min(100, pct);
  return (
    <div className="grid gap-2" data-testid="drive-quota-panel">
      <p className="m-0 font-medium">{formatQuotaSummary(usage)}</p>
      {!usage.unlimited && usage.limitBytes !== null ? (
        <div
          aria-hidden="true"
          style={{
            height: 8,
            borderRadius: 999,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${String(barWidth)}%`,
              height: "100%",
              background: pct >= 90 ? "var(--danger, #dc2626)" : "var(--accent, #2563eb)",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
