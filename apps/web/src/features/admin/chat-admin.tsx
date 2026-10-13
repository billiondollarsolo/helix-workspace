/* Helix Admin — Chat retention, legal hold, and organization export.
 *
 * Wired to real Chat admin tools (`chat.retention.*`, `chat.legal_hold.set`,
 * `chat.export.organization`, `chat.room.list_organization`). When tools are
 * missing or the operator lacks `admin.chat`, controls disable with an explicit
 * reason — never a silent no-op.
 *
 * Rooms are chosen by name. Private rooms and direct messages stay out of the
 * pickers until the organization turns on "Administrators can see private
 * rooms"; agent-only rooms are listed on request either way.
 */

import { AppStatusPanel, WorkspaceFlagsPanel } from "@/features/admin/console/app-settings";
import { formatDuration } from "@/features/admin/console/format";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useServerSeededDraft } from "@/lib/use-server-seeded-draft";
import { ConfirmDestructive } from "@/features/admin/console/confirm-destructive";
import { AdminField, AdminInput, AdminSelect } from "@/features/admin/console/controls";
import { SettingToggle } from "@/features/admin/console/widgets";
import { tenantConfigQueryOptions } from "@/features/admin/tenant-config-api";
import {
  PageHeading,
  QueryFailureBanner,
  useQueryFailure,
  ErrorNotice,
  LoadingState,
  Notice,
} from "@/features/admin/console/primitives";
import {
  CHAT_EXPORT_ROOM_LIMIT,
  CHAT_ROOM_PICKER_LIMIT,
  chatAdminQueryKeys,
  chatOrganizationRoomsQueryOptions,
  chatRetentionQueryOptions,
  describeChatAdminUnavailable,
  describeChatRoom,
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
  type ChatOrganizationRoom,
  type ChatOrganizationRooms,
  type ChatRetentionFormInput,
  type ChatRetentionPolicyView,
} from "@/features/admin/chat-admin-api";

const PANEL = "grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4";

const PRIVATE_ROOMS_FLAG = "chat_admin_private_rooms";

const ROOM_VISIBILITY_FLAGS = [
  {
    key: PRIVATE_ROOMS_FLAG,
    label: "Administrators can see private rooms",
    description:
      "Lists private rooms and direct messages by name in the room pickers on this page. Off by default.",
  },
] as const;

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
  /* "" is the organization default; otherwise the room the policy applies to. */
  const [scopeRoomId, setScopeRoomId] = useState("");
  const [showAgentRooms, setShowAgentRooms] = useState(false);
  const retentionQuery = useQuery(
    chatRetentionQueryOptions(scopeRoomId === "" ? undefined : scopeRoomId),
  );
  const retentionFailure = useQueryFailure(retentionQuery, () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "chat", "retention"] });
  });
  const tenantConfigQuery = useQuery(tenantConfigQueryOptions());
  const roomsQuery = useQuery({
    ...chatOrganizationRoomsQueryOptions({
      includeAgentOnly: showAgentRooms,
      privateRoomsVisible: tenantConfigQuery.data?.effective.features[PRIVATE_ROOMS_FLAG] === true,
    }),
    /* Waits for the setting it is keyed on, so the list is not fetched twice. */
    enabled: !tenantConfigQuery.isPending,
  });
  const rooms = roomsQuery.data?.rooms ?? [];
  const scopeRoom = rooms.find((room) => room.id === scopeRoomId);
  const scopeName =
    scopeRoomId === ""
      ? null
      : scopeRoom === undefined
        ? "the selected room"
        : describeChatRoom(scopeRoom);
  const holdScope = scopeName ?? "the organization default";

  const policy = retentionQuery.data;
  const unavailableReason =
    retentionFailure === null ? null : describeChatAdminUnavailable(retentionFailure.error);
  const controlsDisabled = unavailableReason !== null || retentionQuery.isPending;

  /* Legal-hold toggles and other refetches must not wipe unsaved retention edits. */
  const retentionDraft = useServerSeededDraft(policy, (loaded): ChatRetentionFormInput =>
    loaded === undefined
      ? {
          retentionDays: "2555",
          editWindowMinutes: "1440",
          deleteWindowMinutes: "1440",
          roomId: scopeRoomId,
        }
      : retentionFormFromPolicy(loaded),
  );
  const { draft: loadedRetentionForm, setDraft: setRetentionForm } = retentionDraft;
  /* The picker, not the loaded policy, decides which room a save or hold applies to. */
  const retentionForm = { ...loadedRetentionForm, roomId: scopeRoomId };
  const [formError, setFormError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [exportForm, setExportForm] = useState<ChatExportFormInput>({
    from: "",
    to: "",
    limit: "1000",
    roomIds: [],
  });
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<ChatExportResult | null>(null);
  const [confirmRetention, setConfirmRetention] = useState(false);
  const [confirmHold, setConfirmHold] = useState<"enable" | "disable" | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);

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
        `Retention saved: messages kept for ${formatDuration(result.retentionDays * 86_400)}, editable for ${formatDuration(result.editWindowSeconds)}, deletable for ${formatDuration(result.deleteWindowSeconds)}.`,
      );
      await queryClient.invalidateQueries({
        queryKey: chatAdminQueryKeys.retention(result.roomId ?? undefined),
      });
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
      setStatusMessage(`Legal hold ${result.legalHold ? "enabled" : "disabled"} for ${holdScope}.`);
      await queryClient.invalidateQueries({
        queryKey: chatAdminQueryKeys.retention(result.roomId ?? undefined),
      });
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
  const exportRoomCount = exportForm.roomIds.length;

  function changeScope(roomId: string): void {
    /* Typed values belong to the scope they were typed for. */
    retentionDraft.reset();
    setFormError(null);
    setScopeRoomId(roomId);
  }

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

  return (
    <section className="grid gap-5">
      <PageHeading title="Chat" subtitle="Message retention, legal hold, and exports." />
      <AppStatusPanel appId="chat" />
      <WorkspaceFlagsPanel title="Room visibility" flags={ROOM_VISIBILITY_FLAGS}>
        <SettingToggle
          label="Show agent-only rooms"
          description="Adds rooms whose members are all agents to the room pickers, including private ones."
          checked={showAgentRooms}
          onCheckedChange={setShowAgentRooms}
        />
      </WorkspaceFlagsPanel>

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
        <LoadingState label="Loading Chat retention policy…" />
      ) : null}

      {statusMessage !== null ? <Notice>{statusMessage}</Notice> : null}
      {formError !== null ? <ErrorNotice>{formError}</ErrorNotice> : null}

      <section aria-labelledby="chat-retention-heading" className={PANEL}>
        <div className="grid gap-1">
          <h2 className="text-sm font-semibold" id="chat-retention-heading">
            Retention policy
          </h2>
          <p className="text-[var(--text-3)] type-caption">
            {policySummary ??
              "Platform default is 2555 days (~7 years) with 24-hour edit/delete windows until you set an organization policy."}
          </p>
          {controlsDisabled && unavailableReason !== null ? (
            <p className="admin-unavailable-reason text-[var(--text-3)] type-caption">
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
          <AdminField label="Edit window (minutes)">
            <AdminInput
              aria-label="Edit window in minutes"
              disabled={controlsDisabled || retentionMutation.isPending}
              inputMode="numeric"
              onChange={(event) =>
                setRetentionForm((current) => ({
                  ...current,
                  editWindowMinutes: event.target.value,
                }))
              }
              value={retentionForm.editWindowMinutes}
            />
          </AdminField>
          <AdminField label="Delete window (minutes)">
            <AdminInput
              aria-label="Delete window in minutes"
              disabled={controlsDisabled || retentionMutation.isPending}
              inputMode="numeric"
              onChange={(event) =>
                setRetentionForm((current) => ({
                  ...current,
                  deleteWindowMinutes: event.target.value,
                }))
              }
              value={retentionForm.deleteWindowMinutes}
            />
          </AdminField>
          <AdminField label="Applies to">
            <AdminSelect
              aria-label="Retention applies to"
              disabled={unavailableReason !== null || retentionMutation.isPending}
              onChange={(event) => changeScope(event.target.value)}
              value={scopeRoomId}
            >
              <option value="">Whole organization</option>
              {/* Keeps the choice selected if the room drops out of the list. */}
              {scopeRoomId !== "" && scopeRoom === undefined ? (
                <option value={scopeRoomId}>Selected room</option>
              ) : null}
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {describeChatRoom(room)}
                </option>
              ))}
            </AdminSelect>
          </AdminField>
        </div>
        <RoomListNote query={roomsQuery} />

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
          <p className="text-[var(--text-3)] type-caption">
            Exports stored Chat messages for this organization. Rate-limited (2/hour, 4/day).
            Deleted bodies are redacted; the export is audited.
          </p>
          {controlsDisabled && unavailableReason !== null ? (
            <p className="admin-unavailable-reason text-[var(--text-3)] type-caption">
              Export disabled: {unavailableReason}
            </p>
          ) : null}
        </div>

        {exportError !== null ? <ErrorNotice>{exportError}</ErrorNotice> : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
        </div>

        <ExportRoomChecklist
          rooms={rooms}
          selected={exportForm.roomIds}
          disabled={controlsDisabled || exportMutation.isPending}
          onChange={(roomIds) => setExportForm((current) => ({ ...current, roomIds }))}
        />
        <RoomListNote query={roomsQuery} />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={controlsDisabled || exportMutation.isPending}
            onClick={requestExport}
            type="button"
            variant="outline"
          >
            Run organization export
          </Button>
          {lastExport !== null ? (
            <span className="text-[var(--text-3)] type-caption">
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
        blastRadius="Applies to messages already stored for this organization (or the chosen room). A shorter period removes older messages the next time retention runs."
        onConfirm={() => {
          if (typeof pendingRetentionInput === "string") {
            setFormError(pendingRetentionInput);
            setConfirmRetention(false);
            return;
          }
          const submitted = retentionForm;
          retentionMutation.mutate(pendingRetentionInput, {
            onSuccess: () => retentionDraft.markSaved(submitted),
          });
        }}
      >
        Keep messages for {formatDuration(Number(retentionForm.retentionDays) * 86_400)}, editable
        for {formatDuration(Number(retentionForm.editWindowMinutes) * 60)} and deletable for{" "}
        {formatDuration(Number(retentionForm.deleteWindowMinutes) * 60)}
        {scopeName === null ? " as the organization default." : ` in ${scopeName}.`}
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
        {exportRoomCount === 0
          ? " from every room, including private rooms and direct messages"
          : ` from ${String(exportRoomCount)} chosen ${exportRoomCount === 1 ? "room" : "rooms"}`}
        {exportForm.from.trim() === "" && exportForm.to.trim() === ""
          ? "."
          : ` between ${exportForm.from.trim() || "the start"} and ${exportForm.to.trim() || "now"}.`}
      </ConfirmDestructive>
    </section>
  );
}

/** Why a picker may be shorter than the organization's room list. */
function RoomListNote({
  query,
}: {
  readonly query: { readonly data: ChatOrganizationRooms | undefined; readonly isError: boolean };
}) {
  if (query.isError) {
    return (
      <p className="m-0 text-[var(--text-3)] type-caption" role="status">
        Rooms couldn't be loaded, so only the whole organization can be chosen.
      </p>
    );
  }
  if (query.data === undefined) return null;
  const { hiddenPrivateCount, rooms } = query.data;
  const notes = [
    ...(hiddenPrivateCount > 0
      ? [
          `${String(hiddenPrivateCount)} private ${hiddenPrivateCount === 1 ? "room or direct message is" : "rooms and direct messages are"} not listed.`,
        ]
      : []),
    ...(rooms.length >= CHAT_ROOM_PICKER_LIMIT
      ? [`Showing the ${String(CHAT_ROOM_PICKER_LIMIT)} most recently active rooms.`]
      : []),
  ];
  return notes.length === 0 ? null : (
    <p className="m-0 text-[var(--text-3)] type-caption">{notes.join(" ")}</p>
  );
}

/** Rooms to export, ticked by name. None ticked exports every room. */
function ExportRoomChecklist({
  rooms,
  selected,
  disabled,
  onChange,
}: {
  readonly rooms: readonly ChatOrganizationRoom[];
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (roomIds: readonly string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = rooms.filter(
    (room) => needle === "" || describeChatRoom(room).toLowerCase().includes(needle),
  );
  const full = selected.length >= CHAT_EXPORT_ROOM_LIMIT;
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" disabled={disabled}>
      <legend className="admin-field-label p-0">
        Rooms ({selected.length === 0 ? "every room" : `${String(selected.length)} chosen`})
      </legend>
      {rooms.length === 0 ? (
        <p className="m-0 text-[var(--text-3)] type-caption">
          No rooms to choose from, so the export covers every room.
        </p>
      ) : (
        <>
          <AdminInput
            aria-label="Filter rooms"
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter rooms"
            type="search"
            value={filter}
          />
          <ul className="m-0 grid max-h-48 list-none gap-1 overflow-y-auto rounded-md border border-[var(--border)] p-2">
            {shown.map((room) => {
              const checked = selected.includes(room.id);
              return (
                <li key={room.id}>
                  <label className="flex items-center gap-2 type-meta">
                    <input
                      checked={checked}
                      disabled={!checked && full}
                      onChange={() =>
                        onChange(
                          checked
                            ? selected.filter((id) => id !== room.id)
                            : [...selected, room.id],
                        )
                      }
                      type="checkbox"
                    />
                    {describeChatRoom(room)}
                  </label>
                </li>
              );
            })}
            {shown.length === 0 ? (
              <li className="text-[var(--text-3)] type-caption">No rooms match.</li>
            ) : null}
          </ul>
          {selected.length > 0 ? (
            <div>
              <Button onClick={() => onChange([])} size="sm" type="button" variant="outline">
                Clear and export every room
              </Button>
            </div>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

/** Exported for tests that assert policy → form mapping without mounting React Query. */
export function policyToForm(policy: ChatRetentionPolicyView): ChatRetentionFormInput {
  return retentionFormFromPolicy(policy);
}
