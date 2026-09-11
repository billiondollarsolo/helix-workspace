import { iconMap as Icons } from "@/components/icon-map";
import { Folder as FolderIcon, Plus as PlusIcon, Upload as UploadIcon } from "lucide-react";
import { DriveSyncControl } from "./drive-sync-dialog";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type DriveCreateKind } from "./api";
import { driveQuotaQueryOptions, type DriveScope } from "./queries";

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
  onUploadFolder,
}: {
  readonly onRun: (action: () => void) => void;
  readonly onNewItem: (kind: DriveCreateKind) => void;
  readonly onUploadFile: () => void;
  readonly onUploadFolder: () => void;
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
      <button
        type="button"
        role="menuitem"
        className="btn w-full justify-start font-normal"
        onClick={() => onRun(onUploadFile)}
      >
        <UploadIcon size={16} />
        Upload file
      </button>
      <button
        type="button"
        role="menuitem"
        className="btn w-full justify-start font-normal"
        onClick={() => onRun(onUploadFolder)}
      >
        <FolderIcon size={16} />
        Upload folder
      </button>
    </>
  );
}

const DRIVE_SCOPES: readonly DriveScopeItem[] = [
  { id: "home", label: "Home", icon: "Sparkles" },
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
  onPickFolder,
  onNewItem,
  uploading,
  creating,
}: {
  readonly activeScope: DriveScope;
  readonly onScopeChange: (scope: DriveScope) => void;
  readonly onPickFile: () => void;
  readonly onPickFolder: () => void;
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
                onUploadFolder={onPickFolder}
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
      <div className="mt-auto pt-3">
        <DriveSyncControl />
        <DriveQuotaMeter />
      </div>
    </aside>
  );
}

function DriveQuotaMeter() {
  const quota = useQuery(driveQuotaQueryOptions());
  const used = quota.data?.usedBytes;
  const limit = quota.data?.limitBytes;
  const percent = quota.data?.percentUsed;
  if (used === undefined) return null;
  const label =
    quota.data?.unlimited === true || limit === null
      ? `${formatDriveBytes(used)} used`
      : `${formatDriveBytes(used)} of ${formatDriveBytes(limit ?? 0)}`;
  return (
    <div className="mb-3 [padding:8px_10px] rounded-md [border:1px_solid_var(--border)]">
      <div className="[font-size:var(--text-caption)] font-semibold mb-1">Storage</div>
      {limit !== null && quota.data?.unlimited !== true ? (
        <div
          className="h-1.5 rounded-full mb-1.5 [background:var(--border)] overflow-hidden"
          aria-hidden="true"
        >
          <div
            className="h-full [background:var(--accent)]"
            style={{ width: `${String(Math.min(100, percent ?? 0))}%` }}
          />
        </div>
      ) : null}
      <div className="[font-size:var(--text-caption)] text-muted-foreground">{label}</div>
    </div>
  );
}

function formatDriveBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? "KB"}`;
}
