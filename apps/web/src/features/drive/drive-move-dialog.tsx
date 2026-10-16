/* Move dialog: a folder browser and the keyboard alternative to dragging
   items onto a folder or breadcrumb. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft as BackIcon, ChevronRight as EnterIcon } from "lucide-react";
import { useState } from "react";
import { Dialog } from "@/components/ui/helix-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import type { DriveItem } from "./drive-data";
import { DriveTypeIcon } from "./drive-type-icon";
import { driveFolderChildrenQueryOptions, driveQueryKeys } from "./queries";
import type { DriveMoveTarget } from "./use-drive-actions";

interface Crumb {
  readonly id: string | null;
  readonly name: string;
}

export function DriveMoveDialog({
  items,
  onMove,
  onClose,
}: {
  readonly items: readonly DriveItem[];
  readonly onMove: (target: DriveMoveTarget) => void;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState<readonly Crumb[]>([{ id: null, name: "My Drive" }]);
  const [highlighted, setHighlighted] = useState<Crumb | null>(null);
  const location = path.at(-1) ?? { id: null, name: "My Drive" };
  const children = useQuery(driveFolderChildrenQueryOptions(location.id));
  const movingIds = new Set(items.map((item) => item.id));
  const folders = (children.data ?? []).filter((folder) => !movingIds.has(folder.id));
  const target = highlighted ?? location;
  const alreadyThere = items.every((item) => item.folderId === target.id);
  const title =
    items.length === 1 ? `Move “${items[0]?.name ?? ""}”` : `Move ${String(items.length)} items`;

  return (
    <Dialog
      modal={false}
      title={<h2 className="type-h3 m-0">{title}</h2>}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={alreadyThere}
            onClick={() => onMove({ id: target.id, name: target.name })}
          >
            {highlighted === null ? "Move here" : "Move"}
          </button>
        </>
      }
    >
      <div className="flex items-center gap-1 mb-2">
        {path.length > 1 ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Back to ${path.at(-2)?.name ?? "My Drive"}`}
            onClick={() => {
              setHighlighted(null);
              setPath((current) => current.slice(0, -1));
            }}
          >
            <BackIcon size={18} />
          </button>
        ) : null}
        <p className="type-body-sm font-semibold m-0 truncate" aria-live="polite">
          {location.name}
        </p>
      </div>
      {children.isLoading ? (
        <Skeleton variant="row" count={4} label="Loading folders" />
      ) : children.isError ? (
        <InlineError
          variant="compact"
          title="Couldn’t load folders"
          message={children.error.message}
          onRetry={() =>
            void queryClient.invalidateQueries({
              queryKey: driveQueryKeys.folderChildren(location.id),
            })
          }
        />
      ) : folders.length === 0 ? (
        <p className="type-body-sm text-muted-foreground m-0 py-4">No folders here.</p>
      ) : (
        <ul className="drive-move-list" aria-label={`Folders in ${location.name}`}>
          {folders.map((folder) => {
            const selected = highlighted?.id === folder.id;
            return (
              <li key={folder.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="drive-move-option"
                  aria-pressed={selected}
                  onClick={() =>
                    setHighlighted(selected ? null : { id: folder.id, name: folder.name })
                  }
                  onDoubleClick={() => {
                    setHighlighted(null);
                    setPath((current) => [...current, { id: folder.id, name: folder.name }]);
                  }}
                >
                  <DriveTypeIcon type="folder" size={18} />
                  <span className="truncate">{folder.name}</span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Open ${folder.name}`}
                  onClick={() => {
                    setHighlighted(null);
                    setPath((current) => [...current, { id: folder.id, name: folder.name }]);
                  }}
                >
                  <EnterIcon size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
