import { useQuery } from "@tanstack/react-query";
import {
  Clock as RecentIcon,
  Cloud as StorageIcon,
  HardDrive as MyDriveIcon,
  House as HomeIcon,
  Star as StarredIcon,
  Trash2 as TrashIcon,
  Users as SharedIcon,
  Video as RecordingsIcon,
  type LucideIcon,
} from "lucide-react";
import type { DragEvent } from "react";
import { isDriveMoveDrag, parseDriveMoveDragData } from "./drag-payload";
import { formatByteSize } from "./drive-data";
import { DriveNewButton, type DriveNewActions } from "./drive-new-menu";
import { SCOPE_TITLE } from "./drive-view-types";
import { driveStorageUsageQueryOptions, type DriveScope } from "./queries";

const DRIVE_SCOPES: readonly { readonly id: DriveScope; readonly icon: LucideIcon }[] = [
  { id: "home", icon: HomeIcon },
  { id: "my", icon: MyDriveIcon },
  { id: "shared", icon: SharedIcon },
  { id: "recent", icon: RecentIcon },
  { id: "starred", icon: StarredIcon },
  { id: "recordings", icon: RecordingsIcon },
  { id: "trash", icon: TrashIcon },
];

/** "X GB used", plus a bar against the organization limit when an admin set one. */
function DriveStorageMeter() {
  const storage = useQuery(driveStorageUsageQueryOptions());
  if (storage.data === undefined) return null;
  const { usedBytes, limitBytes, organizationUsedBytes } = storage.data;
  const limited = limitBytes !== null && organizationUsedBytes !== null;
  const percent =
    limited && limitBytes > 0 ? Math.min(100, (organizationUsedBytes / limitBytes) * 100) : 0;
  return (
    <section aria-label="Storage" className="drive-storage">
      <div className="flex items-center gap-2 type-body-sm">
        <StorageIcon size={16} aria-hidden="true" />
        <span>Storage</span>
      </div>
      {limited ? (
        <div
          role="meter"
          aria-label="Organization storage used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={`${formatByteSize(organizationUsedBytes)} of ${formatByteSize(limitBytes)}`}
          className="drive-storage-bar"
          data-full={percent >= 90 || undefined}
        >
          <span style={{ width: `${String(percent)}%` }} />
        </div>
      ) : null}
      <p className="type-caption text-muted-foreground m-0">
        {formatByteSize(usedBytes) === "—" ? "0 B" : formatByteSize(usedBytes)} used
      </p>
      {limited ? (
        <p className="type-caption text-muted-foreground m-0">
          Organization: {formatByteSize(organizationUsedBytes)} of {formatByteSize(limitBytes)}
        </p>
      ) : null}
    </section>
  );
}

export function DriveSidebar({
  activeScope,
  onScopeChange,
  onMoveToRoot,
  newActions,
}: {
  readonly activeScope: DriveScope;
  readonly onScopeChange: (scope: DriveScope) => void;
  /** Dropping dragged items on My Drive moves them to the root. */
  readonly onMoveToRoot: (ids: readonly string[]) => void;
  readonly newActions: DriveNewActions;
}) {
  const acceptMove = (event: DragEvent<HTMLButtonElement>) => {
    if (!isDriveMoveDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  return (
    <aside className="surf-sidebar drive-sidebar" aria-label="Drive">
      <div className="mb-2">
        <DriveNewButton {...newActions} />
      </div>
      <nav aria-label="Drive locations" className="flex flex-col gap-[var(--sidebar-gap)]">
        {DRIVE_SCOPES.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeScope;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onScopeChange(item.id)}
              onDragOver={item.id === "my" ? acceptMove : undefined}
              onDrop={
                item.id === "my"
                  ? (event) => {
                      const ids = parseDriveMoveDragData(event.dataTransfer);
                      if (ids.length === 0) return;
                      event.preventDefault();
                      onMoveToRoot(ids);
                    }
                  : undefined
              }
              className="surf-nav-row"
            >
              <Icon size={18} aria-hidden="true" />
              <span className="label">{SCOPE_TITLE[item.id]}</span>
            </button>
          );
        })}
      </nav>
      <div className="mt-auto pt-3">
        <DriveStorageMeter />
      </div>
    </aside>
  );
}
