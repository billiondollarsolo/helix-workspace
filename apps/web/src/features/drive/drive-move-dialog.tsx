import { useQuery } from "@tanstack/react-query";
import { Folder as FolderIcon, X as XIcon } from "lucide-react";
import { useState } from "react";
import { type DriveApiEntry } from "./api";
import { driveMoveFoldersQueryOptions } from "./queries";

export function DriveMoveDialog({
  open,
  fileName,
  onClose,
  onMove,
}: {
  readonly open: boolean;
  readonly fileName: string;
  readonly onClose: () => void;
  readonly onMove: (folderId: string | null) => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const foldersQuery = useQuery(driveMoveFoldersQueryOptions(folderId, open));
  if (!open) return null;
  const folders = (foldersQuery.data?.entries ?? []).filter(
    (entry: DriveApiEntry) => entry.type === "folder",
  );
  return (
    <div className="fixed inset-0 [z-index:80] grid [place-items:center] p-6 [background:color-mix(in_srgb,_black_32%,_transparent)]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${fileName}`}
        className="[width:min(420px,_calc(100vw_-_32px))] bg-card rounded-lg [border:1px_solid_var(--border)] [box-shadow:0_24px_80px_rgba(15,_23,_42,_0.24)]"
      >
        <div className="flex items-center [padding:14px_16px] [border-bottom:1px_solid_var(--border)]">
          <h2 className="m-0 [font-size:var(--text-lg)]">Move to…</h2>
          <button type="button" className="icon-btn ml-auto" aria-label="Close" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="[padding:8px_12px] max-h-80 overflow-auto">
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="btn w-full justify-start font-normal mb-1"
              onClick={() => setFolderId(folder.id)}
            >
              <FolderIcon size={16} />
              {folder.name}
            </button>
          ))}
          {folders.length === 0 ? (
            <div className="[font-size:var(--text-caption)] text-muted-foreground [padding:12px]">
              No folders here.
            </div>
          ) : null}
        </div>
        <div className="flex gap-2 [padding:12px_16px] [border-top:1px_solid_var(--border)]">
          <button type="button" className="btn sm" onClick={() => setFolderId(null)}>
            My Drive root
          </button>
          <button type="button" className="btn sm primary ml-auto" onClick={() => onMove(folderId)}>
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}
