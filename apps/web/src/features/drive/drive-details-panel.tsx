import { iconMap as Icons } from "@/components/icon-map";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft as ArrowLeftIcon,
  Download as DownloadIcon,
  History as HistoryIcon,
  Star as StarIcon,
  Trash2 as TrashIcon,
  Users as UsersIcon,
  X as XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  driveDownloadResult,
  driveRawDownloadUrl,
  removeDriveAccess,
  renameDriveObject,
  revertDriveVersion,
  updateDriveAccessRole,
  type DriveAccessGrant,
  type DriveAccessRole,
  type DriveApiEntry,
} from "./api";
import { DRIVE_FILE_META, formatModified, type DriveFileItem } from "./drive-data";
import { DriveWorkflows } from "./drive-workflows";
import { driveAccessQueryOptions, driveQueryKeys, driveVersionsQueryOptions } from "./queries";
import {
  DRIVE_ACCESS_ROLE_OPTIONS,
  driveAccessRoleLabel,
  driveAccessRoleValue,
} from "./share-access";
import { canOpenDriveObject, driveUploadStatusView, openDenialMessage } from "./upload-status-ui";

export function DriveDetailsPanel({
  file,
  entry,
  ownerName,
  currentActorId,
  isTrash,
  inSubfolder,
  busy,
  actionError,
  onClose,
  onTrash,
  onRestore,
  onDelete,
  onMoveToParent,
  onSetStarred,
  onShare,
  shareDone,
  onOpenShare,
  onCopy,
  onMove,
  onHideShared,
}: {
  readonly file: DriveFileItem;
  readonly entry: DriveApiEntry | null;
  readonly ownerName: string;
  readonly currentActorId: string | null;
  readonly isTrash: boolean;
  readonly inSubfolder: boolean;
  readonly busy: boolean;
  readonly actionError: Error | null;
  readonly onClose: () => void;
  readonly onTrash: (id: string) => void;
  readonly onRestore: (id: string) => void;
  readonly onDelete: (id: string) => void;

  readonly onMoveToParent: (id: string) => void;
  readonly onSetStarred: (id: string, starred: boolean) => void;
  readonly onShare: (id: string, targets: readonly string[], role: DriveAccessRole) => void;
  readonly shareDone: boolean;
  readonly onOpenShare: () => void;
  readonly onCopy: () => void;
  readonly onMove: () => void;
  readonly onHideShared?: () => void;
}) {
  const meta = DRIVE_FILE_META[file.type];
  const FileIcon = Icons[meta.icon];
  const [shareInput, setShareInput] = useState("");
  const [shareRole, setShareRole] = useState<DriveAccessRole>("reader");
  const [renameValue, setRenameValue] = useState(file.name);
  const openable = canOpenDriveObject({
    uploadState: file.uploadState ?? entry?.uploadState,
    available: file.available ?? entry?.available,
  });
  const statusView = driveUploadStatusView(file.uploadState ?? entry?.uploadState);
  // Owner label: when the entry is owned by the current actor, show the
  // session display name. Otherwise prefer the server-resolved display
  // name (via `entry.ownerDisplayName`) and fall back to file.owner
  // which already projects from the same field via fileItemFromEntry.
  const ownerLabel =
    entry?.ownerActorId === null || entry?.ownerActorId === currentActorId
      ? ownerName
      : (entry?.ownerDisplayName ?? entry?.ownerEmail ?? file.owner);
  // Recent activity from real entry timestamps.
  const activity = useMemo<
    ReadonlyArray<{
      readonly who: string;
      readonly what: string;
      readonly time: string;
    }>
  >(() => {
    if (entry === null) {
      return [{ who: file.owner, what: "edited", time: file.modified }];
    }
    const items: Array<{
      who: string;
      what: string;
      time: string;
    }> = [
      { who: ownerLabel, what: "edited", time: formatModified(entry.updatedAt) },
      { who: ownerLabel, what: "created", time: formatModified(entry.createdAt) },
    ];
    if (entry.deletedAt !== null) {
      items.unshift({
        who: ownerLabel,
        what: "moved to trash",
        time: formatModified(entry.deletedAt),
      });
    }
    return items;
  }, [entry, ownerLabel, file.owner, file.modified]);
  const download = entry === null ? null : driveDownloadResult(entry);
  const queryClient = useQueryClient();
  const accessQuery = useQuery(driveAccessQueryOptions(file.id, entry !== null && !isTrash));
  const versionsQuery = useQuery(driveVersionsQueryOptions(file.id, entry !== null && !isTrash));
  const renameMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (name: string) => renameDriveObject({ objectId: file.id, name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const revertMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (versionNumber: number) => revertDriveVersion(file.id, versionNumber),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["drive", "versions", file.id] });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const removeAccessMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (actorId: string) => removeDriveAccess(file.id, actorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.access(file.id) });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const updateAccessMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: { readonly actorId: string; readonly role: DriveAccessRole }) =>
      updateDriveAccessRole(file.id, input.actorId, input.role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.access(file.id) });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const onShareSubmit = () => {
    const ids = shareInput
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (ids.length > 0) {
      onShare(file.id, ids, shareRole);
      setShareInput("");
    }
  };
  return (
    <aside
      aria-label="File details"
      className="w-80 shrink-0 [border-left:1px_solid_var(--border)] bg-card flex flex-col"
    >
      <div className="[padding:10px_14px] flex items-center [border-bottom:1px_solid_var(--border)]">
        <span className="truncate [font-size:var(--text-body-sm)] font-semibold">Details</span>
        <button
          type="button"
          aria-label="Close details"
          className="icon-btn ml-auto"

          onClick={onClose}
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="overflow-y-auto flex-1">
        <div
          className="[aspect-ratio:4_/_3] bg-muted grid [place-items:center] [border-bottom:1px_solid_var(--border)]"
          style={{ color: meta.color }}
        >
          {<FileIcon size={56} />}
        </div>
        <div className="[padding:12px_14px]">
          <div className="flex gap-1.5 mb-1">
            <input
              className="input flex-1 min-w-0 [font-size:var(--text-body-sm)]"
              value={renameValue}
              aria-label="File name"
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <button
              type="button"
              className="btn sm"
              disabled={
                busy ||
                renameMutation.isPending ||
                renameValue.trim().length === 0 ||
                renameValue.trim() === file.name
              }
              onClick={() => renameMutation.mutate(renameValue.trim())}
            >
              Rename
            </button>
          </div>
          <div className="row gap-2 [font-size:var(--text-caption)] text-muted-foreground mb-3">
            <span className="uppercase">{file.type}</span>
            <span>·</span>
            <span>{file.size}</span>
          </div>

          {!openable && statusView !== null ? (
            <div
              role="status"
              data-testid="drive-details-unavailable"
              data-upload-state={statusView.state}
              className="drive-upload-tone [font-size:var(--text-caption)] mb-2.5 [padding:8px_10px] rounded-md"
              data-tone={statusView.tone}
            >
              {openDenialMessage(statusView.state)}
            </div>
          ) : null}

          {actionError !== null ? (
            <div
              role="alert"
              className="[font-size:var(--text-caption)] [color:var(--danger,_#dc2626)] mb-2.5"
            >
              {actionError.message}
            </div>
          ) : null}

          <div className="flex gap-1.5 mb-4">
            <button
              type="button"
              className="btn sm flex-1 justify-center"
              disabled={busy || entry === null || isTrash || !openable}
              onClick={() => onSetStarred(file.id, !file.starred)}
              aria-pressed={file.starred}
            >
              <StarIcon size={16} fill={file.starred ? "currentColor" : "none"} />
              {file.starred ? "Unstar" : "Star"}
            </button>

            <a
              className={cn(
                "btn sm primary",
                "flex-1 justify-center",
                openable && entry !== null ? "pointer-events-auto" : "pointer-events-none",
                openable && entry !== null ? "[opacity:1]" : "[opacity:0.5]",
              )}
              href={!openable || entry === null ? undefined : driveRawDownloadUrl(entry)}
              download={openable ? (entry?.name ?? download?.name) : undefined}
              aria-disabled={!openable || entry === null}
              title={openable ? "Download file" : openDenialMessage(statusView?.state)}
              onClick={(event) => {
                if (!openable || entry === null) {
                  event.preventDefault();
                }
              }}
            >
              <DownloadIcon size={16} />
              Download
            </a>
          </div>

          {isTrash ? (
            <div className="flex gap-1.5 mb-4">
              <button
                type="button"
                className="btn sm flex-1"

                disabled={busy}
                onClick={() => onRestore(file.id)}
              >
                <HistoryIcon size={16} />
                Restore
              </button>
              <button
                type="button"
                className="btn sm flex-1 [color:var(--danger,_#dc2626)]"

                disabled={busy}
                onClick={() => onDelete(file.id)}
              >
                <TrashIcon size={16} />
                Delete forever
              </button>
            </div>
          ) : (
            <div className="flex gap-1.5 mb-4">
              {inSubfolder ? (
                <button
                  type="button"
                  className="btn sm flex-1"

                  disabled={busy}
                  onClick={() => onMoveToParent(file.id)}
                >
                  <ArrowLeftIcon size={16} />
                  Move up
                </button>
              ) : null}
              <button
                type="button"
                className="btn sm flex-1 [color:var(--danger,_#dc2626)]"

                disabled={busy}
                onClick={() => onTrash(file.id)}
              >
                <TrashIcon size={16} />
                Move to trash
              </button>
            </div>
          )}
          {!isTrash ? (
            <div className="flex flex-wrap gap-1.5 mb-4">
              <button type="button" className="btn sm" disabled={busy} onClick={onCopy}>
                Make a copy
              </button>
              <button type="button" className="btn sm" disabled={busy} onClick={onMove}>
                Move to…
              </button>
              {onHideShared !== undefined ? (
                <button type="button" className="btn sm" disabled={busy} onClick={onHideShared}>
                  Remove from Shared with me
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="section-label [padding:8px_0_4px]">Owner</div>
          <div className="flex items-center gap-2 [font-size:var(--text-meta)] mb-3">
            <Avatar name={ownerLabel} size={24} />
            <span className="truncate">{ownerLabel}</span>
          </div>
          <div className="section-label [padding:8px_0_4px]">Modified</div>
          <div className="[font-size:var(--text-meta)] [color:var(--text-2)] mb-3">
            {entry !== null ? formatModified(entry.updatedAt) : file.modified}
          </div>

          {!isTrash ? (
            <>
              <div className="section-label [padding:8px_0_6px]">Share</div>
              <button
                type="button"
                className="btn sm w-full mb-1.5"
                disabled={busy}
                onClick={onOpenShare}
              >
                <UsersIcon size={16} />
                Share & links
              </button>
              <div className="flex gap-1.5 mb-1.5">
                <input
                  className="input flex-1 min-w-0 [font-size:var(--text-meta)]"
                  value={shareInput}
                  onChange={(event) => setShareInput(event.target.value)}
                  placeholder="Email, name, or actor ID"
                />
                <select
                  className="input w-28 [font-size:var(--text-meta)]"
                  aria-label="Share role"
                  value={shareRole}
                  onChange={(event) => setShareRole(event.target.value as DriveAccessRole)}
                >
                  {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                    <option key={option.role} value={option.role}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="btn sm w-full"

                disabled={busy || shareInput.trim().length === 0}
                onClick={onShareSubmit}
              >
                <UsersIcon size={16} />
                Share
              </button>
              {shareDone ? (
                <div className="[font-size:var(--text-caption)] text-muted-foreground mt-1.5">
                  Access granted.
                </div>
              ) : null}
              <AccessList
                grants={accessQuery.data ?? []}
                loading={accessQuery.isLoading}
                currentActorId={currentActorId}
                ownerActorId={entry?.ownerActorId ?? null}
                busy={removeAccessMutation.isPending || updateAccessMutation.isPending}
                onRemove={(actorId) => removeAccessMutation.mutate(actorId)}
                onRoleChange={(actorId, role) => updateAccessMutation.mutate({ actorId, role })}
              />
              {(versionsQuery.data ?? []).length > 0 ? (
                <>
                  <div className="section-label [padding:12px_0_6px]">Version history</div>
                  <ul className="grid gap-1.5 mb-3 [padding:0] [list-style:none]">
                    {(versionsQuery.data ?? []).slice(0, 8).map((version) => (
                      <li
                        key={String(version.versionNumber)}
                        className="flex items-center gap-2 [font-size:var(--text-caption)]"
                      >
                        <span className="flex-1 min-w-0 truncate">
                          v{String(version.versionNumber)}
                          {version.createdAt ? ` · ${formatModified(version.createdAt)}` : ""}
                        </span>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy || revertMutation.isPending}
                          onClick={() => revertMutation.mutate(version.versionNumber)}
                        >
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : null}

          {!isTrash && entry !== null ? (
            <DriveWorkflows
              resourceId={entry.id}
              resourceType={entry.type === "folder" ? "folder" : "object"}
            />
          ) : null}

          <div className="section-label [padding:16px_0_6px]">Recent activity</div>
          {activity.map((item) => (
            <div
              key={`${item.who}-${item.what}-${item.time}`}
              className="flex items-center gap-2 [padding:4px_0] [font-size:var(--text-caption)]"
            >
              <Avatar name={item.who} size={18} />
              <span className="truncate">
                <b className="font-medium">{item.who}</b> {item.what}
              </span>
              <span className="ml-auto text-muted-foreground">{item.time}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function AccessList({
  grants,
  loading,
  currentActorId,
  ownerActorId,
  busy,
  onRemove,
  onRoleChange,
}: {
  readonly grants: readonly DriveAccessGrant[];
  readonly loading: boolean;
  readonly currentActorId: string | null;
  readonly ownerActorId: string | null;
  readonly busy: boolean;
  readonly onRemove: (actorId: string) => void;
  readonly onRoleChange: (actorId: string, role: DriveAccessRole) => void;
}) {
  const canManageAll = currentActorId !== null && ownerActorId === currentActorId;
  if (loading) {
    return (
      <div className="[font-size:var(--text-caption)] text-muted-foreground mt-2">
        Loading access...
      </div>
    );
  }
  if (grants.length === 0) {
    return null;
  }
  return (
    <div className="mt-2.5">
      <div className="section-label [padding:4px_0_6px]">People with access</div>
      <div className="grid gap-1.5">
        {grants.map((grant) => {
          const label = grant.displayName ?? grant.email ?? grant.actorId;
          const canRemove =
            canManageAll || (currentActorId !== null && grant.actorId === currentActorId);
          return (
            <div
              key={grant.actorId}
              className="row gap-2 min-w-0 [font-size:var(--text-caption)] [padding:4px_0]"
            >
              <Avatar name={label} size={18} />
              <span className="truncate min-w-0">{label}</span>
              {canManageAll ? (
                <select
                  className="input w-28 h-7 [font-size:var(--text-caption)]"
                  aria-label={`Access role for ${label}`}
                  value={driveAccessRoleValue(grant.role)}
                  disabled={busy}
                  onChange={(event) =>
                    onRoleChange(grant.actorId, event.target.value as DriveAccessRole)
                  }
                >
                  {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                    <option key={option.role} value={option.role}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-muted-foreground">{driveAccessRoleLabel(grant.role)}</span>
              )}
              {canRemove ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove access for ${label}`}
                  disabled={busy}
                  onClick={() => onRemove(grant.actorId)}
                >
                  <XIcon size={16} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
