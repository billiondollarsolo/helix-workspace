import { iconMap as Icons } from "@/components/icon-map";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { EllipsisVertical as MoreVIcon, Star as StarIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent } from "react";
import { setHelixDriveItemDragData } from "./drag-payload";
import { DRIVE_FILE_META, type DriveFileItem } from "./drive-data";
import { FileNameText } from "./file-name-text";
import { FileTypeIcon } from "./file-type-icon";
import { canOpenDriveObject, driveUploadStatusView } from "./upload-status-ui";

function driveFileDragHref(file: DriveFileItem): string {
  return `/drive?file=${encodeURIComponent(file.id)}`;
}

function DriveUploadStatusBadge({
  file,
}: {
  readonly file: Pick<DriveFileItem, "uploadState" | "uploadStatusLabel" | "available">;
}) {
  const view = driveUploadStatusView(file.uploadState);
  if (view === null || view.available) {
    return null;
  }
  return (
    <span
      data-testid="drive-upload-status-badge"
      data-upload-state={view.state}
      title={file.uploadStatusLabel ?? view.label}
      className="drive-upload-tone inline-flex items-center gap-1 [padding:1px_6px] [border-radius:999px] [font-size:var(--text-chip,_10px)] font-semibold [letter-spacing:0.02em] uppercase"
      data-tone={view.tone}
    >
      {file.uploadStatusLabel ?? view.label}
    </span>
  );
}

export function DriveFileCard({
  file,
  selected,
  onSelect,
  onSetStarred,
  onOpenMenu,
}: {
  readonly file: DriveFileItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onSetStarred: (starred: boolean) => void;
  readonly onOpenMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const meta = DRIVE_FILE_META[file.type];
  const openable = canOpenDriveObject({
    uploadState: file.uploadState,
    available: file.available,
  });
  return (
    <div
      className={cn(
        "drive-file-card render-contained-card",
        "bg-card rounded-lg p-0 flex flex-col text-left overflow-hidden relative",
        selected
          ? "[box-shadow:0_0_0_3px_var(--accent-soft)] [border:1px_solid_var(--accent)]"
          : "[box-shadow:none] [border:1px_solid_var(--border)]",
        openable ? "[opacity:1]" : "[opacity:0.92]",
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event);
      }}
    >
      <DriveStarToggle
        name={file.name}
        starred={file.starred}
        onSetStarred={onSetStarred}
        className="absolute top-2 right-10 [z-index:1]"
      />
      <button
        type="button"
        className="icon-btn absolute top-2 right-2 [z-index:1] bg-card"
        aria-label={`Actions for ${file.name}`}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(event);
        }}
      >
        <MoreVIcon size={16} />
      </button>
      <button
        type="button"
        aria-pressed={selected}
        aria-disabled={!openable}
        draggable={openable}
        onDragStart={(event) => {
          if (!openable) {
            event.preventDefault();
            return;
          }
          setHelixDriveItemDragData(event.dataTransfer, {
            id: file.id,
            name: file.name,
            href: driveFileDragHref(file),
            mimeType: file.mimeType,
          });
        }}
        onClick={onSelect}
        className="[border:none] bg-transparent p-0 flex flex-col text-left w-full h-full [font:inherit] [color:inherit]"
      >
        <FileTypeIcon name={file.name} icon={meta.icon} color={meta.color} aspectRatio="4 / 3" />
        <div className="p-2.5 w-full [box-sizing:border-box]">
          <div className="flex items-center gap-1.5 mb-1">
            <FileNameText
              name={file.name}
              className="[font-size:var(--text-meta)] font-medium flex-1 min-w-0"
            />
          </div>
          <div className="mb-1">
            <DriveUploadStatusBadge file={file} />
          </div>
          <div className="[font-size:var(--text-caption)] text-muted-foreground flex items-center gap-1.5">
            <Avatar name={file.owner} size={14} />
            <span className="truncate">{file.modified}</span>
          </div>
        </div>
      </button>
    </div>
  );
}

export function DriveFileRow({
  file,
  selected,
  onSelect,
  onSetStarred,
  onOpenMenu,
}: {
  readonly file: DriveFileItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onSetStarred: (starred: boolean) => void;
  readonly onOpenMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const meta = DRIVE_FILE_META[file.type];
  const FileIcon = Icons[meta.icon];
  // DriveFileRow is only used for non-folder file rows (folders render separately).
  const openable = canOpenDriveObject({
    uploadState: file.uploadState,
    available: file.available,
  });
  return (
    <div
      className={cn(
        "drive-file-row render-contained-list-item",
        "grid [grid-template-columns:1fr_160px_120px_90px_32px] [padding:0_16px] h-9 items-center [font-size:var(--text-meta)] w-full text-left [border-bottom:1px_solid_var(--border)]",
        selected ? "[background:var(--accent-soft)]" : "bg-transparent",
      )}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-disabled={!openable}
      draggable={openable}
      onDragStart={(event) => {
        if (!openable) {
          event.preventDefault();
          return;
        }
        setHelixDriveItemDragData(event.dataTransfer, {
          id: file.id,
          name: file.name,
          href: driveFileDragHref(file),
          mimeType: file.mimeType,
        });
      }}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="row gap-2 min-w-0">
        <DriveStarToggle
          name={file.name}
          starred={file.starred}
          onSetStarred={onSetStarred}
          asButton={false}
        />
        <span className="inline-flex" style={{ color: meta.color }}>
          <FileIcon size={16} />
        </span>
        <FileNameText name={file.name} className="flex-1 min-w-0" />
        <DriveUploadStatusBadge file={file} />
      </div>
      <div className="row gap-2">
        <Avatar name={file.owner} size={18} />
        <span className="truncate">{file.owner}</span>
      </div>
      <span className="[color:var(--text-2)]">{file.modified}</span>
      <span className="[color:var(--text-2)]">{file.size}</span>
      <button
        type="button"
        className="icon-btn inline-flex"
        aria-label={`Actions for ${file.name}`}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(event);
        }}
      >
        <MoreVIcon size={16} />
      </button>
    </div>
  );
}

function DriveStarToggle({
  name,
  starred,
  onSetStarred,
  className,
  asButton = true,
}: {
  readonly name: string;
  readonly starred: boolean;
  readonly onSetStarred: (starred: boolean) => void;
  readonly className?: string;
  readonly asButton?: boolean;
}) {
  const content = <StarIcon size={16} fill={starred ? "currentColor" : "none"} />;
  const commonProps = {
    className: cn(
      "icon-btn bg-card",
      starred ? "[color:var(--warning,_#f59e0b)]" : "text-muted-foreground",
      className,
    ),
    "aria-pressed": starred,
    "aria-label": `${starred ? "Unstar" : "Star"} ${name}`,
    title: starred ? "Unstar" : "Star",
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      onSetStarred(!starred);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        onSetStarred(!starred);
      }
    },
  };
  if (asButton) {
    return (
      <button type="button" {...commonProps}>
        {content}
      </button>
    );
  }
  return (
    <span role="button" tabIndex={0} {...commonProps}>
      {content}
    </span>
  );
}
