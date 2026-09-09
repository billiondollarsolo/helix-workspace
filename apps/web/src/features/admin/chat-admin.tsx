/* Helix Admin — Chat retention, legal hold, and organization export.
 *
 * Wired to real Chat admin tools (`chat.retention.*`, `chat.legal_hold.set`,
 * `chat.export.organization`). When tools are missing or the operator lacks
 * `admin.chat`, controls disable with an explicit reason — never a silent
 * no-op.
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
  chatAdminQueryKeys,
  chatRetentionQueryOptions,
  describeChatAdminUnavailable,
  exportChatOrganization,
  formatRetentionSummary,
  mapExportFormToToolInput,
  mapLegalHoldFormToToolInput,
  mapRetentionFormToToolInput,
  retentionFormFromPolicy,
  setChatLegalHold,
  setChatRetentionPolicy,
  type ChatExportFormInput,
  type ChatExportResult,
  type ChatRetentionFormInput,
  type ChatRetentionPolicyView,
} from "@/features/admin/chat-admin-api";

const PANEL = "grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4";

/** What differs between enabling and disabling a legal hold. Everything else
 *  about the two confirmations was identical. */
const LEGAL_HOLD_COPY = {
  enable: {
    title: "Enable Chat legal hold",
    confirmLabel: "Enable legal hold",
    verb: "Enable",
    blastRadius:
      "While legal hold is on, retention sweeps and user edit/delete windows cannot remove message content for the held scope.",
  },
  disable: {
    title: "Disable Chat legal hold",
    confirmLabel: "Disable legal hold",
    verb: "Disable",
    blastRadius:
      "Messages that already passed the retention cutoff may be tombstoned on the next retention sweep after hold is cleared.",
  },
} as const;

function downloadExportJson(result: ChatExportResult): void {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `helix-chat-export-${result.exportId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Admin UI for organization Chat retention windows, legal hold, and exports.
 */
export function ChatAdminSection() {
  const queryClient = useQueryClient();
  const retentionQuery = useQuery(chatRetentionQueryOptions());
  const retentionFailure = useQueryFailure(retentionQuery, () => {
    void queryClient.invalidateQueries({ queryKey: chatAdminQueryKeys.retention() });
  });

  const policy = retentionQuery.data;
  const unavailableReason =
    retentionFailure === null ? null : describeChatAdminUnavailable(retentionFailure.error);
  const controlsDisabled = unavailableReason !== null || retentionQuery.isPending;

  const [retentionForm, setRetentionForm] = useState<ChatRetentionFormInput>({
    retentionDays: "2555",
    editWindowSeconds: "86400",
    deleteWindowSeconds: "86400",
    roomId: "",
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [exportForm, setExportForm] = useState<ChatExportFormInput>({
    from: "",
    to: "",
    limit: "1000",
    roomIds: "",
  });
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<ChatExportResult | null>(null);
  const [confirmRetention, setConfirmRetention] = useState(false);
  const [confirmHold, setConfirmHold] = useState<"enable" | "disable" | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);

  useEffect(() => {
    if (policy !== undefined) {
      setRetentionForm(retentionFormFromPolicy(policy));
    }
  }, [policy]);

  const retentionMutation = useMutation({
    mutationFn: (input: Parameters<typeof setChatRetentionPolicy>[0]) =>
      setChatRetentionPolicy(input),
    onMutate: () => {
      setFormError(null);
      setStatusMessage(null);
    },
    onError: (error: unknown) => {
      setFormError(error instanceof Error ? error.message : "Failed to set retention policy.");
    },
    onSuccess: async (result) => {
      setStatusMessage(
        `Retention saved: ${String(result.retentionDays)} days · edit ${String(result.editWindowSeconds)}s · delete ${String(result.deleteWindowSeconds)}s.`,
      );
      await queryClient.invalidateQueries({ queryKey: chatAdminQueryKeys.retention() });
    },
    onSettled: () => {
      setConfirmRetention(false);
    },
  });

  const holdMutation = useMutation({
    mutationFn: (input: Parameters<typeof setChatLegalHold>[0]) => setChatLegalHold(input),
    onMutate: () => {
      setFormError(null);
      setStatusMessage(null);
    },
    onError: (error: unknown) => {
      setFormError(error instanceof Error ? error.message : "Failed to set legal hold.");
    },
    onSuccess: async (result) => {
      setStatusMessage(
        result.legalHold
          ? "Legal hold enabled for the organization default scope."
          : "Legal hold disabled for the organization default scope.",
      );
      await queryClient.invalidateQueries({ queryKey: chatAdminQueryKeys.retention() });
    },
    onSettled: () => {
      setConfirmHold(null);
    },
  });

  const exportMutation = useMutation({
    mutationFn: (input: Parameters<typeof exportChatOrganization>[0]) =>
      exportChatOrganization(input),
    onMutate: () => {
      setExportError(null);
      setStatusMessage(null);
    },
    onError: (error: unknown) => {
      setExportError(error instanceof Error ? error.message : "Failed to export Chat messages.");
    },
    onSuccess: (result) => {
      setLastExport(result);
      downloadExportJson(result);
      setStatusMessage(
        `Export ${result.exportId} generated with ${String(result.messages.length)} message(s)${result.truncated ? " (truncated)" : ""}.`,
      );
    },
    onSettled: () => {
      setConfirmExport(false);
    },
  });

  const policySummary = policy === undefined ? null : formatRetentionSummary(policy);

  function requestRetentionSave(): void {
    const mapped = mapRetentionFormToToolInput(retentionForm);
    if (typeof mapped === "string") {
      setFormError(mapped);
      return;
    }
    setFormError(null);
    setConfirmRetention(true);
  }

  function requestHoldToggle(enabled: boolean): void {
    const mapped = mapLegalHoldFormToToolInput({
      enabled,
      roomId: retentionForm.roomId,
    });
    if (typeof mapped === "string") {
      setFormError(mapped);
      return;
    }
    setFormError(null);
    setConfirmHold(enabled ? "enable" : "disable");
  }

  function requestExport(): void {
    const mapped = mapExportFormToToolInput(exportForm);
    if (typeof mapped === "string") {
      setExportError(mapped);
      return;
    }
    setExportError(null);
    setConfirmExport(true);
  }

  const pendingRetentionInput = mapRetentionFormToToolInput(retentionForm);
  const pendingExportInput = mapExportFormToToolInput(exportForm);
  /* Only the scope that is actually being confirmed needs mapping — enable and
     disable are never open at once. */
  const pendingHold =
    confirmHold === null
      ? null
      : mapLegalHoldFormToToolInput({
          enabled: confirmHold === "enable",
          roomId: retentionForm.roomId,
        });
  const holdScope =
    retentionForm.roomId.trim() === ""
      ? "the organization default scope"
      : `room ${retentionForm.roomId.trim()}`;

  return (
    <section className="grid gap-5">
      <PageHeading
        title="Chat"
        subtitle="Organization retention windows, legal hold, and message exports. Chat is server-readable (not E2EE); exports and policy changes are audited."
      />

      {retentionFailure !== null ? (
        <QueryFailureBanner
          summary="Chat retention controls are unavailable"
          subject="Chat retention and export"
          error={retentionFailure.error}
          isRetrying={retentionFailure.isRetrying}
          onRetry={retentionFailure.retry}
        >
          <p className="admin-unavailable-reason">{unavailableReason}</p>
        </QueryFailureBanner>
      ) : null}

      {retentionQuery.isPending && retentionFailure === null ? (
        <StateBanner kind="loading">Loading Chat retention policy…</StateBanner>
      ) : null}

      {statusMessage !== null ? <StateBanner kind="info">{statusMessage}</StateBanner> : null}
      {formError !== null ? <StateBanner kind="error">{formError}</StateBanner> : null}

      <section aria-labelledby="chat-retention-heading" className={PANEL}>
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold" id="chat-retention-heading">
            Retention policy
          </h2>
          <p className="text-[var(--text-3)] [font-size:var(--text-caption)]">
            {policySummary ??
              "Platform default is 2555 days (~7 years) with 24-hour edit/delete windows until you set an organization policy."}
          </p>
          {controlsDisabled && unavailableReason !== null ? (
            <p className="admin-unavailable-reason text-[var(--text-3)] [font-size:var(--text-caption)]">
              Controls disabled: {unavailableReason}
            </p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AdminField label="Retention days">
            <AdminInput
              aria-label="Retention days"
              disabled={controlsDisabled || retentionMutation.isPending}
              inputMode="numeric"
              onChange={(event) =>
                setRetentionForm((current) => ({
                  ...current,
                  retentionDays: event.target.value,
                }))
              }
              value={retentionForm.retentionDays}
            />
          </AdminField>
          <AdminField label="Edit window (seconds)">
            <AdminInput
              aria-label="Edit window in seconds"
              disabled={controlsDisabled || retentionMutation.isPending}
              inputMode="numeric"
              onChange={(event) =>
                setRetentionForm((current) => ({
                  ...current,
                  editWindowSeconds: event.target.value,
                }))
              }
              value={retentionForm.editWindowSeconds}
            />
          </AdminField>
          <AdminField label="Delete window (seconds)">
            <AdminInput
              aria-label="Delete window in seconds"
              disabled={controlsDisabled || retentionMutation.isPending}
              inputMode="numeric"
              onChange={(event) =>
                setRetentionForm((current) => ({
                  ...current,
                  deleteWindowSeconds: event.target.value,
                }))
              }
              value={retentionForm.deleteWindowSeconds}
            />
          </AdminField>
          <AdminField label="Room ID override (optional)">
            <AdminInput
              aria-label="Room ID override"
              disabled={controlsDisabled || retentionMutation.isPending}
              onChange={(event) =>
                setRetentionForm((current) => ({
                  ...current,
                  roomId: event.target.value,
                }))
              }
              placeholder="org default when empty"
              value={retentionForm.roomId}
            />
          </AdminField>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={controlsDisabled || retentionMutation.isPending}
            onClick={requestRetentionSave}
            type="button"
          >
            Save retention policy
          </Button>
          <Button
            disabled={controlsDisabled || holdMutation.isPending || policy?.legalHold === true}
            onClick={() => requestHoldToggle(true)}
            type="button"
            variant="outline"
          >
            Enable legal hold
          </Button>
          <Button
            disabled={controlsDisabled || holdMutation.isPending || policy?.legalHold !== true}
            onClick={() => requestHoldToggle(false)}
            type="button"
            variant="outline"
          >
            Disable legal hold
          </Button>
        </div>
      </section>

      <section aria-labelledby="chat-export-heading" className={PANEL}>
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold" id="chat-export-heading">
            Organization export
          </h2>
          <p className="text-[var(--text-3)] [font-size:var(--text-caption)]">
            Exports stored Chat messages for this organization. Rate-limited (2/hour, 4/day).
            Deleted bodies are redacted; the export is audited.
          </p>
          {controlsDisabled && unavailableReason !== null ? (
            <p className="admin-unavailable-reason text-[var(--text-3)] [font-size:var(--text-caption)]">
              Export disabled: {unavailableReason}
            </p>
          ) : null}
        </div>

        {exportError !== null ? <StateBanner kind="error">{exportError}</StateBanner> : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AdminField label="From (ISO datetime, optional)">
            <AdminInput
              aria-label="Export from datetime"
              disabled={controlsDisabled || exportMutation.isPending}
              onChange={(event) =>
                setExportForm((current) => ({ ...current, from: event.target.value }))
              }
              placeholder="2026-01-01T00:00:00.000Z"
              value={exportForm.from}
            />
          </AdminField>
          <AdminField label="To (ISO datetime, optional)">
            <AdminInput
              aria-label="Export to datetime"
              disabled={controlsDisabled || exportMutation.isPending}
              onChange={(event) =>
                setExportForm((current) => ({ ...current, to: event.target.value }))
              }
              placeholder="2026-12-31T23:59:59.000Z"
              value={exportForm.to}
            />
          </AdminField>
          <AdminField label="Message limit">
            <AdminInput
              aria-label="Export message limit"
              disabled={controlsDisabled || exportMutation.isPending}
              inputMode="numeric"
              onChange={(event) =>
                setExportForm((current) => ({ ...current, limit: event.target.value }))
              }
              value={exportForm.limit}
            />
          </AdminField>
          <AdminField label="Room IDs (comma-separated, optional)">
            <AdminInput
              aria-label="Export room IDs"
              disabled={controlsDisabled || exportMutation.isPending}
              onChange={(event) =>
                setExportForm((current) => ({ ...current, roomIds: event.target.value }))
              }
              placeholder="all rooms when empty"
              value={exportForm.roomIds}
            />
          </AdminField>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={controlsDisabled || exportMutation.isPending}
            onClick={requestExport}
            type="button"
          >
            Run organization export
          </Button>
          {lastExport !== null ? (
            <span className="text-[var(--text-3)] [font-size:var(--text-caption)]">
              Last export {lastExport.exportId}: {String(lastExport.messages.length)} messages
              {lastExport.truncated ? " (truncated)" : ""}
            </span>
          ) : null}
        </div>
      </section>

      <ConfirmDestructive
        open={confirmRetention}
        onOpenChange={setConfirmRetention}
        title="Save Chat retention policy"
        confirmLabel="Save policy"
        isPending={retentionMutation.isPending}
        blastRadius="Applies to messages already stored for this organization (or the named room). Shorter retention will cause older messages to be tombstoned by the retention worker."
        onConfirm={() => {
          if (typeof pendingRetentionInput === "string") {
            setFormError(pendingRetentionInput);
            setConfirmRetention(false);
            return;
          }
          retentionMutation.mutate(pendingRetentionInput);
        }}
      >
        Save retention of {retentionForm.retentionDays} days with edit window{" "}
        {retentionForm.editWindowSeconds}s and delete window {retentionForm.deleteWindowSeconds}s
        {retentionForm.roomId.trim() === ""
          ? " as the organization default."
          : ` for room ${retentionForm.roomId.trim()}.`}
      </ConfirmDestructive>

      {/* One dialog, not two: enable and disable are the same confirmation with
          the verb flipped, and they can never be open at the same time. The
          copy that genuinely differs — the title, the button, and what each
          direction costs — lives in `LEGAL_HOLD_COPY`. */}
      <ConfirmDestructive
        open={confirmHold !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmHold(null);
        }}
        title={LEGAL_HOLD_COPY[confirmHold ?? "enable"].title}
        confirmLabel={LEGAL_HOLD_COPY[confirmHold ?? "enable"].confirmLabel}
        isPending={holdMutation.isPending}
        blastRadius={LEGAL_HOLD_COPY[confirmHold ?? "enable"].blastRadius}
        onConfirm={() => {
          if (pendingHold === null) {
            return;
          }
          if (typeof pendingHold === "string") {
            setFormError(pendingHold);
            setConfirmHold(null);
            return;
          }
          holdMutation.mutate(pendingHold);
        }}
      >
        {LEGAL_HOLD_COPY[confirmHold ?? "enable"].verb} legal hold for {holdScope}.
      </ConfirmDestructive>

      <ConfirmDestructive
        open={confirmExport}
        onOpenChange={setConfirmExport}
        title="Export organization Chat"
        confirmLabel="Run export"
        isPending={exportMutation.isPending}
        blastRadius="Creates an audited export of stored Chat messages for this organization. Rate-limited to 2 per hour and 4 per day. Message bodies of deleted messages are redacted."
        onConfirm={() => {
          if (typeof pendingExportInput === "string") {
            setExportError(pendingExportInput);
            setConfirmExport(false);
            return;
          }
          exportMutation.mutate(pendingExportInput);
        }}
      >
        Export up to {exportForm.limit} messages
        {exportForm.roomIds.trim() === "" ? " from all rooms" : " from the listed rooms"}
        {exportForm.from.trim() === "" && exportForm.to.trim() === ""
          ? "."
          : ` between ${exportForm.from.trim() || "the start"} and ${exportForm.to.trim() || "now"}.`}
      </ConfirmDestructive>
    </section>
  );
}

/** Exported for tests that assert policy → form mapping without mounting React Query. */
export function policyToForm(policy: ChatRetentionPolicyView): ChatRetentionFormInput {
  return retentionFormFromPolicy(policy);
}
