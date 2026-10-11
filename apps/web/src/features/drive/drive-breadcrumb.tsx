/* Location breadcrumb. The current location is the page's h1 and, where it
   makes sense, a ▾ menu with folder actions. Ancestor crumbs accept dragged
   items so they can be moved up the tree. */
import { ChevronDown as MenuIcon, ChevronRight as SeparatorIcon } from "lucide-react";
import { useState, type DragEvent } from "react";
import { Menu, MenuContent, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { isDriveMoveDrag, parseDriveMoveDragData } from "./drag-payload";
import type { DriveItem } from "./drive-data";
import { DriveMenuItems, driveItemActions, type DriveActionId } from "./drive-item-actions";
import { DriveNewMenuItems, type DriveNewActions } from "./drive-new-menu";
import { DriveMenuButton } from "./drive-menu-button";

export interface DriveTrailCrumb {
  readonly id: string | null;
  readonly name: string;
  /** The folder itself, when it was opened from a list (deep links only know the id). */
  readonly item?: DriveItem;
}

function DropCrumb({
  crumb,
  onNavigate,
  onDropItems,
}: {
  readonly crumb: DriveTrailCrumb;
  readonly onNavigate: () => void;
  readonly onDropItems: (ids: readonly string[]) => void;
}) {
  const [over, setOver] = useState(false);
  const accept = (event: DragEvent<HTMLButtonElement>) => {
    if (!isDriveMoveDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  return (
    <button
      type="button"
      className="drive-crumb"
      data-drop-over={over || undefined}
      onClick={onNavigate}
      onDragEnter={accept}
      onDragOver={accept}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const ids = parseDriveMoveDragData(event.dataTransfer);
        if (ids.length === 0) return;
        event.preventDefault();
        onDropItems(ids);
      }}
    >
      {crumb.name}
    </button>
  );
}

export function DriveBreadcrumb({
  trail,
  canCreate,
  newActions,
  onNavigate,
  onDropItems,
  onFolderAction,
}: {
  /** Root first; the last crumb is the current location. */
  readonly trail: readonly DriveTrailCrumb[];
  /** New and upload are offered where items can be created (My Drive and its folders). */
  readonly canCreate: boolean;
  readonly newActions: DriveNewActions;
  readonly onNavigate: (index: number) => void;
  readonly onDropItems: (target: DriveTrailCrumb, ids: readonly string[]) => void;
  readonly onFolderAction: (folder: DriveItem, action: DriveActionId) => void;
}) {
  const current = trail.at(-1);
  if (current === undefined) return null;
  const folder = current.item;
  const folderActions =
    folder === undefined
      ? []
      : driveItemActions([folder], { trash: false }).filter((action) => action.id !== "open");
  const hasMenu = canCreate || folderActions.length > 0;

  return (
    <nav aria-label="Location" className="drive-breadcrumb">
      <ol>
        {trail.slice(0, -1).map((crumb, index) => (
          <li key={crumb.id ?? "root"}>
            <DropCrumb
              crumb={crumb}
              onNavigate={() => onNavigate(index)}
              onDropItems={(ids) => onDropItems(crumb, ids)}
            />
            <SeparatorIcon size={18} aria-hidden="true" className="text-muted-foreground" />
          </li>
        ))}
        <li aria-current="location" className="min-w-0">
          <h1 className="drive-location">
            {hasMenu ? (
              <Menu>
                <MenuTrigger asChild>
                  <DriveMenuButton
                    className="drive-location-button"
                    aria-label={`${current.name}, folder actions`}
                  >
                    <span className="truncate">{current.name}</span>
                    <MenuIcon size={20} aria-hidden="true" />
                  </DriveMenuButton>
                </MenuTrigger>
                <MenuContent className="min-w-60">
                  {canCreate ? <DriveNewMenuItems {...newActions} /> : null}
                  {canCreate && folderActions.length > 0 ? <MenuSeparator /> : null}
                  {folder === undefined ? null : (
                    <DriveMenuItems
                      actions={folderActions}
                      onAction={(id) => onFolderAction(folder, id)}
                    />
                  )}
                </MenuContent>
              </Menu>
            ) : (
              <span className="drive-location-text truncate">{current.name}</span>
            )}
          </h1>
        </li>
      </ol>
    </nav>
  );
}
