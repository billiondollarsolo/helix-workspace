/* Row and card content for the Drive lists. Rendered inside SelectableList
   rows, so the row itself is the focus/selection target and the star and ⋮
   buttons stay separate controls (no nested interactives). */
import { EllipsisVertical as MoreIcon, Star as StarIcon } from "lucide-react";
import { useState, type DragEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu";
import type { SelectableRowState } from "@/components/ui/selectable-list";
import { cn } from "@/lib/utils";
import {
  isDriveMoveDrag,
  parseDriveMoveDragData,
  setDriveMoveDragData,
  setHelixDriveItemDragData,
} from "./drag-payload";
import { formatByteSize, formatModified, type DriveItem } from "./drive-data";
import { DriveMenuItems, type DriveAction, type DriveActionId } from "./drive-item-actions";
import { DriveTypeIcon } from "./drive-type-icon";
import { FileNameText } from "./file-name-text";
import { driveUploadStatusView } from "./upload-status-ui";
import { DriveMenuButton } from "./drive-menu-button";

export interface DriveItemViewHandlers {
  /** Owner column text: "me" for the viewer's own items. */
  readonly ownerLabel: (item: DriveItem) => string;
  /** Actions for the item's ⋮ menu (the selection when the item is selected). */
  readonly actionsFor: (item: DriveItem) => readonly DriveAction[];
  readonly onAction: (item: DriveItem, id: DriveActionId) => void;
  readonly onToggleStar: (item: DriveItem) => void;
  /** Ids that move when this item is dragged. */
  readonly dragIds: (item: DriveItem) => readonly string[];
  readonly onDropInto: (folder: DriveItem, ids: readonly string[]) => void;
  readonly trash: boolean;
}

interface DriveItemViewProps {
  readonly item: DriveItem;
  readonly state: SelectableRowState;
  readonly handlers: DriveItemViewHandlers;
}

/** Drag source for every item; folders are also drop targets for moves. */
function useDragProps(item: DriveItem, handlers: DriveItemViewHandlers) {
  const [over, setOver] = useState(false);
  const acceptsDrop = item.kind === "folder" && !handlers.trash;
  const accept = (event: DragEvent<HTMLDivElement>) => {
    if (!acceptsDrop || !isDriveMoveDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  return {
    "data-drive-id": item.id,
    "data-drop-over": over || undefined,
    draggable: !handlers.trash,
    onDragStart: (event: DragEvent<HTMLDivElement>) => {
      setDriveMoveDragData(event.dataTransfer, handlers.dragIds(item));
      if (item.kind === "file" && item.available) {
        setHelixDriveItemDragData(event.dataTransfer, {
          id: item.id,
          name: item.name,
          href: `/drive?file=${encodeURIComponent(item.id)}`,
          mimeType: item.mimeType ?? undefined,
        });
      }
      event.dataTransfer.effectAllowed = "copyMove";
    },
    onDragEnter: accept,
    onDragOver: accept,
    onDragLeave: () => setOver(false),
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      setOver(false);
      if (!acceptsDrop) return;
      const ids = parseDriveMoveDragData(event.dataTransfer).filter((id) => id !== item.id);
      if (ids.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      handlers.onDropInto(item, ids);
    },
  };
}

function ItemMenu({ item, state, handlers }: DriveItemViewProps) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <DriveMenuButton
          className="icon-btn drive-item-more"
          tabIndex={state.tabIndex}
          aria-label={`More actions for ${item.name}`}
        >
          <MoreIcon size={18} aria-hidden="true" />
        </DriveMenuButton>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-60">
        <DriveMenuItems
          actions={handlers.actionsFor(item)}
          onAction={(id) => handlers.onAction(item, id)}
        />
      </MenuContent>
    </Menu>
  );
}

function StarButton({ item, state, handlers }: DriveItemViewProps) {
  if (item.kind !== "file" || handlers.trash) return null;
  return (
    <button
      type="button"
      className={cn("icon-btn drive-item-star", item.starred && "is-starred")}
      tabIndex={state.tabIndex}
      aria-pressed={item.starred}
      aria-label={item.starred ? `Remove ${item.name} from starred` : `Add ${item.name} to starred`}
      disabled={!item.available}
      onClick={() => handlers.onToggleStar(item)}
    >
      <StarIcon size={16} aria-hidden="true" fill={item.starred ? "currentColor" : "none"} />
    </button>
  );
}

function StatusBadge({ item }: { readonly item: DriveItem }) {
  const view = driveUploadStatusView(item.uploadState);
  if (view === null || view.available || item.deletedAt !== null) return null;
  return (
    <span
      className="drive-upload-tone drive-status-badge type-chip"
      data-tone={view.tone}
      data-testid="drive-upload-status-badge"
      data-upload-state={view.state}
    >
      {item.uploadStatusLabel ?? view.label}
    </span>
  );
}

/** Secondary column: when it was trashed (Trash), else when it was modified. */
function dateLabel(item: DriveItem): string {
  return formatModified(item.deletedAt ?? item.updatedAt);
}

export function DriveListRowContent(props: DriveItemViewProps) {
  const { item, handlers } = props;
  const owner = handlers.ownerLabel(item);
  const dragProps = useDragProps(item, handlers);
  return (
    <div className="drive-list-row" {...dragProps}>
      <span className="drive-col-name">
        <DriveTypeIcon type={item.type} size={20} />
        <FileNameText name={item.name} className="type-body-sm min-w-0" />
        <StatusBadge item={item} />
        <StarButton {...props} />
      </span>
      <span className="drive-col-owner">
        <Avatar name={owner === "me" ? item.owner : owner} size={22} />
        <span className="truncate">{owner}</span>
      </span>
      <span className="drive-col-date">{dateLabel(item)}</span>
      <span className="drive-col-size">
        {item.kind === "folder" ? "—" : formatByteSize(item.byteSize)}
      </span>
      <span className="drive-col-meta">
        {owner} · {dateLabel(item)}
      </span>
      <ItemMenu {...props} />
    </div>
  );
}

export function DriveFolderTile(props: DriveItemViewProps) {
  const { item, handlers } = props;
  const dragProps = useDragProps(item, handlers);
  return (
    <div className="drive-folder-tile" {...dragProps}>
      <DriveTypeIcon type="folder" size={22} />
      <span className="type-body-sm font-medium truncate flex-1" title={item.name}>
        {item.name}
      </span>
      <ItemMenu {...props} />
    </div>
  );
}

export function DriveFileCard(props: DriveItemViewProps) {
  const { item, handlers } = props;
  const dragProps = useDragProps(item, handlers);
  return (
    <div className="drive-file-card" {...dragProps}>
      <div className="drive-file-card-title">
        <DriveTypeIcon type={item.type} size={18} />
        <FileNameText name={item.name} className="type-body-sm font-medium min-w-0 flex-1" />
        <ItemMenu {...props} />
      </div>
      <div className="drive-file-card-thumb" aria-hidden="true">
        <DriveTypeIcon type={item.type} size={56} />
      </div>
      <div className="drive-file-card-meta type-caption text-muted-foreground">
        <Avatar name={item.owner} size={18} />
        <span className="truncate flex-1">
          {handlers.trash ? "Trashed" : "Modified"} {dateLabel(item)}
        </span>
        <StatusBadge item={item} />
        <StarButton {...props} />
      </div>
    </div>
  );
}
