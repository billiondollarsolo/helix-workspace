import { Avatar } from "@/components/ui/avatar";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Users as UsersIcon,
  X as XIcon,
} from "lucide-react";
import { useState } from "react";
import { renameDriveObject, type DriveApiEntry } from "./api";
import { formatModified, type DriveFolderItem } from "./drive-data";
import { DriveMutationFeedback } from "./drive-mutation-feedback";
import { driveQueryKeys } from "./queries";

/** Details for a selected folder: rename, open, and share with inherited access. */
export function DriveFolderDetailsPanel({
  folder,
  entry,
  ownerName,
  currentActorId,
  onClose,
  onOpen,
  onOpenShare,
}: {
  readonly folder: DriveFolderItem;
  readonly entry: DriveApiEntry | null;
  readonly ownerName: string;
  readonly currentActorId: string | null;
  readonly onClose: () => void;
  readonly onOpen: () => void;
  readonly onOpenShare: () => void;
}) {
  const queryClient = useQueryClient();
  const [renameValue, setRenameValue] = useState(folder.name);
  const renameMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (name: string) => renameDriveObject({ objectId: folder.id, name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const ownerLabel =
    entry === null || entry.ownerActorId === null || entry.ownerActorId === currentActorId
      ? ownerName
      : (entry.ownerDisplayName ?? entry.ownerEmail ?? "Unknown owner");
  const trimmed = renameValue.trim();
  return (
    <aside
      aria-label="Folder details"
      className="w-80 shrink-0 [border-left:1px_solid_var(--border)] bg-card flex flex-col"
    >
      <div className="[padding:10px_14px] flex items-center [border-bottom:1px_solid_var(--border)]">
        <span className="truncate type-body-sm font-semibold">Folder details</span>
        <button
          type="button"
          aria-label="Close folder details"
          className="icon-btn ml-auto"
          onClick={onClose}
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className="overflow-y-auto flex-1">
        <div className="[aspect-ratio:4_/_3] bg-muted grid [place-items:center] [border-bottom:1px_solid_var(--border)] text-muted-foreground">
          <FolderIcon size={56} />
        </div>
        <div className="[padding:12px_14px]">
          <form
            className="flex gap-1.5 mb-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmed.length > 0 && trimmed !== folder.name) {
                renameMutation.mutate(trimmed);
              }
            }}
          >
            <input
              className="input flex-1 min-w-0 type-body-sm"
              value={renameValue}
              aria-label="Folder name"
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <button
              type="submit"
              className="btn sm"
              disabled={renameMutation.isPending || trimmed.length === 0 || trimmed === folder.name}
            >
              Rename
            </button>
          </form>
          <DriveMutationFeedback
            success={renameMutation.isSuccess ? "Renamed." : null}
            error={renameMutation.error}
          />

          <div className="flex gap-1.5 mb-4 mt-2">
            <button type="button" className="btn sm flex-1 justify-center" onClick={onOpen}>
              <FolderOpenIcon size={16} />
              Open
            </button>
            <button
              type="button"
              className="btn sm primary flex-1 justify-center"
              onClick={onOpenShare}
            >
              <UsersIcon size={16} />
              Share
            </button>
          </div>
          <p className="type-caption text-muted-foreground mb-3">
            People you add get access to everything inside this folder.
          </p>

          <div className="section-label [padding:8px_0_4px]">Owner</div>
          <div className="flex items-center gap-2 type-meta mb-3">
            <Avatar name={ownerLabel} size={24} />
            <span className="truncate">{ownerLabel}</span>
          </div>
          {entry !== null ? (
            <>
              <div className="section-label [padding:8px_0_4px]">Modified</div>
              <div className="type-meta [color:var(--text-2)] mb-3">
                {formatModified(entry.updatedAt)}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
