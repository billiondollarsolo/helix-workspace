import { cn } from "@/lib/utils";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  HardDrive as DriveIcon,
  Folder as FolderIcon,
  Plus as PlusIcon,
  Upload as UploadIcon,
} from "lucide-react";
import { type DragEvent, useMemo, useRef, useState } from "react";
import { type DriveCreateKind } from "./api";
import { type DriveFileItem, type DriveFolderItem } from "./drive-data";
import { DriveFileCard, DriveFileRow } from "./drive-file-card";
import { DriveNewMenuItems } from "./drive-sidebar";
import { type DriveCrumb, SCOPE_TITLE } from "./drive-view-types";
import { type DriveScope } from "./queries";
import { type DocumentSurfaceView, DocumentSurfaceViewToggle } from "./view-preference";

function DriveBreadcrumb({
  scope,
  trail,
  onNavigate,
}: {
  readonly scope: DriveScope;
  readonly trail: readonly DriveCrumb[];
  readonly onNavigate: (index: number) => void;
}) {
  return (
    <nav aria-label="Drive breadcrumb" className="flex items-center gap-1 min-w-0">
      <button
        type="button"
        onClick={() => onNavigate(-1)}
        disabled={trail.length === 0}
        className={cn(
          "[font-size:var(--text-h2)] font-semibold bg-transparent p-0",
          trail.length === 0 ? "text-foreground" : "text-primary",
        )}
      >
        {SCOPE_TITLE[scope]}
      </button>
      {trail.map((crumb, index) => (
        <span
          key={crumb.id ?? `crumb-${String(index)}`}
          className="flex items-center gap-1 min-w-0"
        >
          <ChevronRightIcon size={14} />
          <button
            type="button"
            onClick={() => onNavigate(index)}
            className={cn(
              "truncate",
              "[font-size:var(--text-h2)] font-semibold bg-transparent p-0 max-w-55",
              index === trail.length - 1 ? "text-foreground" : "text-primary",
            )}
            disabled={index === trail.length - 1}
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

export function DriveMain({
  view,
  onViewChange,
  scope,
  trail,
  onNavigateCrumb,
  folders,
  files,
  selectedFileId,
  onSelectFile,
  onOpenFolder,
  onSetStarred,
  onUpload,
  onDropFiles,
  onNewItem,
  loading,
  error,
  hasMore,
  onShowMore,
  uploadError,
  onRetry,
  uploading,
  creating,
}: {
  readonly view: DocumentSurfaceView;
  readonly onViewChange: (view: DocumentSurfaceView) => void;
  readonly scope: DriveScope;
  readonly trail: readonly DriveCrumb[];
  readonly onNavigateCrumb: (index: number) => void;
  readonly folders: readonly DriveFolderItem[];
  readonly files: readonly DriveFileItem[];
  readonly selectedFileId: string | null;
  readonly onSelectFile: (id: string) => void;
  readonly onOpenFolder: (folder: DriveFolderItem) => void;
  readonly onSetStarred: (id: string, starred: boolean) => void;
  readonly onUpload: () => void;
  readonly onDropFiles: (files: readonly File[]) => void;
  readonly onNewItem: (kind: DriveCreateKind) => void;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly hasMore: boolean;
  readonly onShowMore: () => void;
  readonly uploadError: Error | null;
  readonly onRetry: () => void;
  readonly uploading: boolean;
  readonly creating: boolean;
}) {
  const gridFiles = useMemo(() => files.filter((file) => file.type !== "folder"), [files]);
  const isEmpty = !loading && error === null && folders.length === 0 && files.length === 0;
  // Drag-and-drop: track enter depth with a counter so child element re-enters
  // don't flash the overlay off/on.
  const dragDepthRef = useRef(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) {
      setIsDragOver(true);
    }
  };
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Signal that we accept drop
    event.dataTransfer.dropEffect = "copy";
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) {
      onDropFiles(dropped);
    }
  };
  // Current folder name for the overlay label
  const currentFolderName =
    trail.length > 0 ? (trail[trail.length - 1]?.name ?? "My Drive") : "My Drive";
  // FAB menu state
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const busy = uploading || creating;
  const handleFabMenuItem = (action: () => void) => {
    setFabMenuOpen(false);
    action();
  };
  return (
    <div
      data-testid="drive-main"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="flex-1 flex flex-col p-6 overflow-y-auto min-w-0 relative"
    >
      {/* Drop overlay */}
      {isDragOver ? (
        <div className="drive-drop-overlay" data-testid="drive-drop-overlay" aria-hidden="true">
          <span className="drive-drop-overlay-icon">
            <UploadIcon size={40} />
          </span>
          <span className="drive-drop-overlay-label">
            Drop files to upload to {currentFolderName}
          </span>
        </div>
      ) : null}

      <div className="flex items-center mb-4 gap-3">
        <DriveBreadcrumb scope={scope} trail={trail} onNavigate={onNavigateCrumb} />
        <div className="ml-auto flex gap-1">
          <DocumentSurfaceViewToggle view={view} onViewChange={onViewChange} />
        </div>
      </div>

      {uploadError !== null ? (
        <div
          role="alert"
          className="[font-size:var(--text-meta)] [color:var(--danger,_#dc2626)] bg-muted [border:1px_solid_var(--border)] rounded-md [padding:8px_12px] mb-3"
        >
          Upload failed: {uploadError.message}
        </div>
      ) : null}

      {error !== null ? (
        <DriveErrorState message={error.message} onRetry={onRetry} />
      ) : loading ? (
        <DriveLoadingState />
      ) : isEmpty ? (
        <DriveEmptyState scope={scope} onUpload={onUpload} />
      ) : (
        <>
          {folders.length > 0 ? (
            <>
              <div className="section-label [padding:0_0_8px]">Folders</div>
              <div className="grid [grid-template-columns:repeat(auto-fill,_minmax(180px,_1fr))] gap-2 mb-6">
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => onOpenFolder(folder)}
                    className="bg-card [border:1px_solid_var(--border)] rounded-md [padding:10px_12px] flex items-center gap-2.5 text-left cursor-pointer"
                  >
                    <FolderIcon size={16} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate [font-size:var(--text-meta)] font-medium">
                        {folder.name}
                      </div>
                      <div className="[font-size:var(--text-chip)] text-muted-foreground">
                        {folder.itemCount > 0 ? `${String(folder.itemCount)} items` : "Open folder"}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="section-label [padding:0_0_8px]">Files</div>
          {gridFiles.length === 0 && view === "grid" ? (
            <div className="[font-size:var(--text-meta)] text-muted-foreground [padding:8px_0]">
              No files here yet.
            </div>
          ) : view === "grid" ? (
            <div className="grid [grid-template-columns:repeat(auto-fill,_minmax(180px,_1fr))] gap-3">
              {gridFiles.map((file) => (
                <DriveFileCard
                  key={file.id}
                  file={file}
                  selected={file.id === selectedFileId}
                  onSelect={() => onSelectFile(file.id)}
                  onSetStarred={(starred) => onSetStarred(file.id, starred)}
                />
              ))}
            </div>
          ) : (
            <div className="panel">
              <div className="grid [grid-template-columns:1fr_160px_120px_90px_32px] [padding:0_16px] h-8 items-center [font-size:var(--text-caption)] text-muted-foreground font-semibold uppercase [letter-spacing:.06em] [border-bottom:1px_solid_var(--border)] bg-muted">
                <span>Name</span>
                <span>Owner</span>
                <span>Modified</span>
                <span>Size</span>
                <span />
              </div>
              {files.map((file) => (
                <DriveFileRow
                  key={file.id}
                  file={file}
                  selected={file.id === selectedFileId}
                  onSelect={() => onSelectFile(file.id)}
                  onSetStarred={(starred) => onSetStarred(file.id, starred)}
                />
              ))}
            </div>
          )}
          {hasMore ? (
            <div className="flex justify-center mt-4.5">
              <button type="button" className="btn" onClick={onShowMore}>
                <ChevronDownIcon size={16} />
                Show more
              </button>
            </div>
          ) : null}
        </>
      )}

      {/* Floating Action Button (+ FAB) — bottom-right, same menu as the sidebar "New" button */}
      <div className="drive-fab-wrapper">
        {fabMenuOpen ? (
          <>
            {/* Backdrop to close FAB menu on outside click */}
            <div
              aria-hidden="true"
              className="fixed inset-0 [z-index:99]"
              onClick={() => setFabMenuOpen(false)}
            />
            <div
              role="menu"
              className="drive-fab-menu"
              data-testid="drive-fab-menu"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFabMenuOpen(false);
                }
              }}
            >
              <DriveNewMenuItems
                onRun={handleFabMenuItem}
                onNewItem={onNewItem}
                onUploadFile={onUpload}
              />
            </div>
          </>
        ) : null}
        <button
          type="button"
          className="drive-fab"
          data-testid="drive-fab"
          aria-label="New"
          aria-haspopup="menu"
          aria-expanded={fabMenuOpen}
          disabled={busy}
          onClick={() => setFabMenuOpen((prev) => !prev)}
        >
          <PlusIcon size={24} />
        </button>
      </div>
    </div>
  );
}

function DriveLoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="[font-size:var(--text-meta)] text-muted-foreground [padding:32px_0]"
    >
      Loading Drive…
    </div>
  );
}

function DriveErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2.5 [padding:32px_0]">
      <div className="[font-size:var(--text-body-sm)] font-semibold">Couldn’t load Drive</div>
      <div className="[font-size:var(--text-meta)] text-muted-foreground">{message}</div>
      <button type="button" className="btn sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function DriveEmptyState({
  scope,
  onUpload,
}: {
  readonly scope: DriveScope;
  readonly onUpload: () => void;
}) {
  const copy: Record<DriveScope, string> = {
    my: "This folder is empty. Upload a file to get started.",
    shared: "Nothing has been shared with you yet.",
    recent: "No recent files.",
    starred: "No starred files yet.",
    recordings: "No meeting recordings yet. Start a meeting and click Record.",
    trash: "Trash is empty.",
  };
  return (
    <div className="flex flex-col items-center gap-3 [padding:48px_0] text-muted-foreground">
      <DriveIcon size={40} />
      <div className="[font-size:var(--text-body-sm)]">{copy[scope]}</div>
      {scope === "my" ? (
        <button type="button" className="btn sm primary" onClick={onUpload}>
          <UploadIcon size={16} />
          Upload a file
        </button>
      ) : null}
    </div>
  );
}
