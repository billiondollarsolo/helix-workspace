import { iconMap as Icons } from "@/components/icon-map";
import { Folder as FolderIcon, Plus as PlusIcon, Upload as UploadIcon } from "lucide-react";
import { useState } from "react";
import { type DriveCreateKind } from "./api";
import { type DriveScope } from "./queries";

interface DriveScopeItem {
  readonly id: DriveScope;
  readonly label: string;
  readonly icon: keyof typeof Icons;
}

/** Body of the "New" menu, shared by the sidebar dropdown and the mobile FAB.
 *  `onRun` lets each caller close its own menu around the chosen action. */
export function DriveNewMenuItems({
  onRun,
  onNewItem,
  onUploadFile,
}: {
  readonly onRun: (action: () => void) => void;
  readonly onNewItem: (kind: DriveCreateKind) => void;
  readonly onUploadFile: () => void;
}) {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="btn w-full justify-start font-normal"

        onClick={() => onRun(() => onNewItem("folder"))}
      >
        <FolderIcon size={16} />
        New folder
      </button>
      {null}
      <button
        type="button"
        role="menuitem"
        className="btn w-full justify-start font-normal"

        onClick={() => onRun(onUploadFile)}
      >
        <UploadIcon size={16} />
        Upload file
      </button>
    </>
  );
}

const DRIVE_SCOPES: readonly DriveScopeItem[] = [
  { id: "my", label: "My Drive", icon: "Drive" },
  { id: "shared", label: "Shared with me", icon: "Users" },
  { id: "recent", label: "Recent", icon: "History" },
  { id: "starred", label: "Starred", icon: "Star" },
  { id: "recordings", label: "Recordings", icon: "Video" },
  { id: "trash", label: "Trash", icon: "Trash" },
];

export function DriveSidebar({
  activeScope,
  onScopeChange,
  onPickFile,
  onNewItem,
  uploading,
  creating,
}: {
  readonly activeScope: DriveScope;
  readonly onScopeChange: (scope: DriveScope) => void;
  readonly onPickFile: () => void;
  readonly onNewItem: (kind: DriveCreateKind) => void;
  readonly uploading: boolean;
  readonly creating: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = uploading || creating;
  const handleMenuItem = (action: () => void) => {
    setMenuOpen(false);
    action();
  };
  return (
    <aside className="surf-sidebar">
      <div className="relative mb-3">
        <button
          type="button"
          className="btn primary lg w-full"

          onClick={() => setMenuOpen((prev) => !prev)}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <PlusIcon size={16} />
          {uploading ? "Uploading…" : creating ? "Creating…" : "New"}
        </button>
        {menuOpen ? (
          <>
            {/* Backdrop to close menu on outside click */}
            <div
              aria-hidden="true"
              className="fixed inset-0 [z-index:99]"
              onClick={() => setMenuOpen(false)}
            />
            <div
              role="menu"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setMenuOpen(false);
                }
              }}
              className="absolute [top:calc(100%_+_4px)] left-0 right-0 [z-index:100] bg-card [border:1px_solid_var(--border)] rounded-lg [box-shadow:0_4px_12px_rgba(0,0,0,.12)] p-1"
            >
              <DriveNewMenuItems
                onRun={handleMenuItem}
                onNewItem={onNewItem}
                onUploadFile={onPickFile}
              />
            </div>
          </>
        ) : null}
      </div>
      {DRIVE_SCOPES.map((item) => {
        const Icon = Icons[item.icon];
        const active = item.id === activeScope;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onScopeChange(item.id)}
            className="surf-nav-row"
          >
            <Icon size={16} />
            <span className="label">{item.label}</span>
          </button>
        );
      })}
    </aside>
  );
}
