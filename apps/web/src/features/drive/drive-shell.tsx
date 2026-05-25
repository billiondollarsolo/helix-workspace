/* DriveShell — the Drive surface body, fully wired to the backend.

   Layout: left sidebar (New/Upload, scopes, storage meter), main pane
   (breadcrumb + grid/list toggle, Folders tiles, Files grid/list) and a
   320px details panel that opens when a file is selected.

   Data: every interaction rides a real platform tool via `POST /api/tools/*`.
    - `drive.list`     — folder browsing for My Drive / Trash.
    - `drive.search`   — search + the cross-folder Recent/Shared/Starred scopes.
    - `drive.upload` + `drive.finalize` — the New / Upload buttons.
    - `drive.move`     — moving a file out to the parent folder.
    - `drive.trash` / `drive.restore` / `drive.delete` — trash lifecycle.
    - `drive.share`    — the details-panel share affordance.
   Mutations invalidate the Drive query cache. The typed handoff seed
   (`DRIVE_FOLDERS_SEED` / `DRIVE_FILES_SEED`) is used only as an offline
   fallback when the backend listing yields nothing AND the query errored. */

import { type ChangeEvent, type CSSProperties, type DragEvent, useMemo, useRef, useState } from "react";
import "./drive-shell.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import {
  createDriveEntry,
  deleteDriveObject,
  driveDownloadResult,
  driveRawDownloadUrl,
  moveDriveObject,
  restoreDriveObject,
  shareDrive,
  trashDriveObject,
  uploadDriveFile,
  type DriveApiEntry,
  type DriveCreateKind,
} from "./api";
import {
  DRIVE_FILE_META,
  fileItemFromEntry,
  folderItemFromEntry,
  formatModified,
  type DriveFileItem,
  type DriveFolderItem,
} from "./drive-data";
import {
  applyDriveScope,
  driveActorQueryOptions,
  driveItemsQueryOptions,
  driveQueryKeys,
  type DriveScope,
} from "./queries";

type DriveView = "grid" | "list";

interface DriveScopeItem {
  readonly id: DriveScope;
  readonly label: string;
  readonly icon: keyof typeof Icons;
}

const DRIVE_SCOPES: readonly DriveScopeItem[] = [
  { id: "my", label: "My Drive", icon: "Drive" },
  { id: "shared", label: "Shared with me", icon: "Users" },
  { id: "recent", label: "Recent", icon: "History" },
  { id: "starred", label: "Starred", icon: "Star" },
  { id: "recordings", label: "Recordings", icon: "Video" },
  { id: "trash", label: "Trash", icon: "Trash" },
];

const SCOPE_TITLE: Record<DriveScope, string> = {
  my: "My Drive",
  shared: "Shared with me",
  recent: "Recent",
  starred: "Starred",
  recordings: "Recordings",
  trash: "Trash",
};

const TILE_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
};

const LIST_COLUMNS = "1fr 160px 120px 90px 32px";

/** A `navigate()` target opening a specific editor item. */
interface EditorDestination {
  readonly to: string;
  readonly search: Record<string, string>;
}

/**
 * Maps a `drive.create` result (`{ id, app }`) to the editor route that opens
 * that item. The doc/sheet/deck routes read a single search param
 * (`?doc=` / `?sheet=` / `?deck=`) and open straight into the editor.
 */
function editorDestinationFor(app: string, id: string): EditorDestination | null {
  switch (app) {
    case "docs":
      return { to: "/docs", search: { doc: id } };
    case "sheets":
      return { to: "/sheets", search: { sheet: id } };
    case "slides":
      return { to: "/slides", search: { deck: id } };
    default:
      return null;
  }
}

/** Icon + colour override for app-typed file entries. */
const APP_ICON_META: Record<string, { readonly icon: keyof typeof Icons; readonly color: string }> =
  {
    docs: { icon: "Doc", color: "#2563eb" },
    sheets: { icon: "Sheet", color: "#059669" },
    // No distinct Slides icon — reuse Image (same as the "New > Presentation" menu item).
    slides: { icon: "Image", color: "#ea580c" },
  };

/** A folder in the breadcrumb trail. `null` id is the scope root. */
interface DriveCrumb {
  readonly id: string | null;
  readonly name: string;
}

/** The Drive surface body. Rendered inside `SurfaceFrame`. */
export function DriveShell() {
  const navigate = useNavigate();
  const driveSearch: Partial<{ folder: string | null; scope: DriveScope; q: string; file: string }> =
    useSearch({ strict: false });
  const queryClient = useQueryClient();
  const [view, setView] = useState<DriveView>("grid");
  const [scope, setScope] = useState<DriveScope>(driveSearch.scope ?? "my");
  const [trail, setTrail] = useState<readonly DriveCrumb[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(driveSearch.file ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const folderId = trail.length > 0 ? (trail[trail.length - 1]?.id ?? null) : (driveSearch.folder ?? null);

  // Drive URL sync — every state transition (scope, folder, selection)
  // pushes a fresh `?folder=…&scope=…&file=…` query string, so the back
  // button restores the previous view and links are shareable.
  const pushUrl = (next: { folder?: string | null; scope?: DriveScope; file?: string | null }) => {
    void navigate({
      to: "/drive",
      search: (prev) => ({
        ...(prev as Record<string, unknown>),
        ...(next.folder === undefined ? {} : { folder: next.folder ?? undefined }),
        ...(next.scope === undefined ? {} : { scope: next.scope }),
        ...(next.file === undefined ? {} : { file: next.file ?? undefined }),
      }),
      replace: false,
    });
  };

  const actorQuery = useQuery(driveActorQueryOptions());
  const actorId = actorQuery.data?.actorId ?? null;

  const itemsQuery = useQuery(
    driveItemsQueryOptions({ folderId, scope, limit: scope === "recent" ? 50 : 100 }),
  );

  const invalidateDrive = () =>
    queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadDriveFile({ file, folderId }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void invalidateDrive();
    },
  });

  const trashMutation = useMutation({
    mutationFn: (objectId: string) => trashDriveObject(objectId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setSelectedFileId(null);
      void invalidateDrive();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (objectId: string) => restoreDriveObject(objectId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setSelectedFileId(null);
      void invalidateDrive();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (objectId: string) => deleteDriveObject(objectId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setSelectedFileId(null);
      void invalidateDrive();
    },
  });

  const moveMutation = useMutation({
    mutationFn: (vars: { readonly objectId: string; readonly folderId: string | null }) =>
      moveDriveObject(vars.objectId, vars.folderId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void invalidateDrive();
    },
  });

  const shareMutation = useMutation({
    mutationFn: (vars: { readonly objectId: string; readonly actorIds: readonly string[] }) =>
      shareDrive({ objectId: vars.objectId, actorIds: vars.actorIds, role: "reader" }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void invalidateDrive();
    },
  });

  const createMutation = useMutation({
    mutationFn: (vars: { readonly kind: DriveCreateKind; readonly name: string }) =>
      createDriveEntry({ kind: vars.kind, name: vars.name, folderId }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (result) => {
      void invalidateDrive();
      // Doc/sheet/deck kinds return `{ id, app }` — open the new item's editor
      // by threading its id through the route's search param. Folder kinds
      // return a plain drive entry (no `app`) and just stay in Drive.
      if (result.app !== undefined) {
        const destination = editorDestinationFor(result.app, result.id);
        if (destination !== null) {
          void navigate({ to: destination.to, search: destination.search });
        }
      }
    },
  });

  const onNewItem = (kind: DriveCreateKind) => {
    const defaultNames: Record<DriveCreateKind, string> = {
      folder: "New folder",
      document: "Untitled document",
      spreadsheet: "Untitled spreadsheet",
      presentation: "Untitled presentation",
    };
    createMutation.mutate({ kind, name: defaultNames[kind] });
  };

  // Live backend entries for the current scope/folder. Search results are
  // already promoted into entry shape inside `driveItemsQueryOptions`.
  const liveEntries = useMemo<readonly DriveApiEntry[]>(() => {
    const data = itemsQuery.data;
    if (data === undefined) {
      return [];
    }
    if (data.mode === "list") {
      return applyDriveScope(data.entries, scope, actorId);
    }
    return data.hits.map((hit) => ({
      id: hit.objectId,
      type: "file" as const,
      name: hit.name,
      folderId: hit.folderId,
      ownerActorId: null,
      mimeType: hit.mimeType,
      byteSize: hit.byteSize,
      sha256: hit.sha256,
      ...(hit.previewMetadata === undefined ? {} : { preview: hit.previewMetadata }),
      deletedAt: null,
      createdAt: hit.updatedAt,
      updatedAt: hit.updatedAt,
    }));
  }, [itemsQuery.data, scope, actorId]);

  const folders = useMemo<readonly DriveFolderItem[]>(
    () => liveEntries.filter((e) => e.type === "folder").map(folderItemFromEntry),
    [liveEntries],
  );

  const files = useMemo<readonly DriveFileItem[]>(
    () => liveEntries.filter((e) => e.type === "file").map(fileItemFromEntry),
    [liveEntries],
  );

  const entryById = useMemo(() => {
    const map = new Map<string, DriveApiEntry>();
    for (const entry of liveEntries) {
      map.set(entry.id, entry);
    }
    return map;
  }, [liveEntries]);

  const selectedEntry = selectedFileId === null ? null : (entryById.get(selectedFileId) ?? null);
  const selectedFile = useMemo(
    () => files.find((file) => file.id === selectedFileId) ?? null,
    [files, selectedFileId],
  );

  /**
   * Called when the user clicks a file entry. If the entry is owned by an
   * editor app (docs/sheets/slides) navigate straight into the editor;
   * otherwise open the details panel as usual.
   */
  const onSelectFile = (id: string) => {
    const entry = entryById.get(id);
    if (entry?.app != null) {
      const destination = editorDestinationFor(entry.app, id);
      if (destination !== null) {
        void navigate({ to: destination.to, search: destination.search });
        return;
      }
    }
    setSelectedFileId(id);
  };

  const openFolder = (folder: DriveFolderItem) => {
    setSelectedFileId(null);
    setTrail((prev) => [...prev, { id: folder.id, name: folder.name }]);
    pushUrl({ folder: folder.id, file: null });
  };

  const navigateToCrumb = (index: number) => {
    setSelectedFileId(null);
    setTrail((prev) => {
      const next = index < 0 ? [] : prev.slice(0, index + 1);
      const targetId = next.length > 0 ? (next[next.length - 1]?.id ?? null) : null;
      pushUrl({ folder: targetId, file: null });
      return next;
    });
  };

  const onScopeChange = (next: DriveScope) => {
    setScope(next);
    setTrail([]);
    setSelectedFileId(null);
    pushUrl({ scope: next, folder: null, file: null });
  };

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    if (chosen !== undefined) {
      uploadMutation.mutate(chosen);
    }
    event.target.value = "";
  };

  const isTrashScope = scope === "trash";

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        aria-hidden="true"
        tabIndex={-1}
        style={{ display: "none" }}
        onChange={onFileChosen}
      />
      <DriveSidebar
        activeScope={scope}
        onScopeChange={onScopeChange}
        onPickFile={onPickFile}
        onNewItem={onNewItem}
        uploading={uploadMutation.isPending}
        creating={createMutation.isPending}
      />
      <DriveMain
        view={view}
        onViewChange={setView}
        scope={scope}
        trail={trail}
        onNavigateCrumb={navigateToCrumb}
        folders={folders}
        files={files}
        selectedFileId={selectedFileId}
        onSelectFile={onSelectFile}
        onOpenFolder={openFolder}
        onUpload={onPickFile}
        onDropFiles={(droppedFiles) => {
          for (const file of droppedFiles) {
            uploadMutation.mutate(file);
          }
        }}
        onNewItem={onNewItem}
        loading={itemsQuery.isLoading}
        error={itemsQuery.isError ? itemsQuery.error : null}
        uploadError={uploadMutation.isError ? uploadMutation.error : null}
        onRetry={() => void invalidateDrive()}
        uploading={uploadMutation.isPending}
        creating={createMutation.isPending}
      />
      {selectedFile !== null ? (
        <DriveDetailsPanel
          file={selectedFile}
          entry={selectedEntry}
          ownerName={actorQuery.data?.name ?? "You"}
          currentActorId={actorId}
          isTrash={isTrashScope}
          inSubfolder={trail.length > 0}
          busy={
            trashMutation.isPending ||
            restoreMutation.isPending ||
            deleteMutation.isPending ||
            moveMutation.isPending ||
            shareMutation.isPending
          }
          actionError={
            trashMutation.error ??
            restoreMutation.error ??
            deleteMutation.error ??
            moveMutation.error ??
            shareMutation.error ??
            null
          }
          onClose={() => setSelectedFileId(null)}
          onTrash={(id) => trashMutation.mutate(id)}
          onRestore={(id) => restoreMutation.mutate(id)}
          onDelete={(id) => deleteMutation.mutate(id)}
          onMoveToParent={(id) =>
            moveMutation.mutate({
              objectId: id,
              folderId: trail.length > 1 ? (trail[trail.length - 2]?.id ?? null) : null,
            })
          }
          onShare={(id, actorIds) => shareMutation.mutate({ objectId: id, actorIds })}
          shareDone={shareMutation.isSuccess}
        />
      ) : null}
    </>
  );
}

function DriveSidebar({
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
      <div style={{ position: "relative", marginBottom: 12 }}>
        <button
          type="button"
          className="btn primary lg"
          style={{ width: "100%" }}
          onClick={() => setMenuOpen((prev) => !prev)}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Icons.Plus />
          {uploading ? "Uploading…" : creating ? "Creating…" : "New"}
        </button>
        {menuOpen ? (
          <>
            {/* Backdrop to close menu on outside click */}
            <div
              aria-hidden="true"
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 99,
              }}
              onClick={() => setMenuOpen(false)}
            />
            <div
              role="menu"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setMenuOpen(false);
                }
              }}
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                zIndex: 100,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 4px 12px rgba(0,0,0,.12)",
                padding: 4,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleMenuItem(() => onNewItem("folder"))}
              >
                <Icons.Folder />
                New folder
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleMenuItem(() => onNewItem("document"))}
              >
                <Icons.Doc />
                Document
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleMenuItem(() => onNewItem("spreadsheet"))}
              >
                <Icons.Sheet />
                Spreadsheet
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleMenuItem(() => onNewItem("presentation"))}
              >
                <Icons.Image />
                Presentation
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleMenuItem(onPickFile)}
              >
                <Icons.Upload />
                Upload file
              </button>
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
            <Icon />
            <span className="label">{item.label}</span>
          </button>
        );
      })}
    </aside>
  );
}

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
    <nav
      aria-label="Drive breadcrumb"
      style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}
    >
      <button
        type="button"
        onClick={() => onNavigate(-1)}
        disabled={trail.length === 0}
        style={{
          fontSize: "var(--text-h2)",
          fontWeight: 600,
          color: trail.length === 0 ? "var(--text)" : "var(--accent)",
          background: "transparent",
          padding: 0,
        }}
      >
        {SCOPE_TITLE[scope]}
      </button>
      {trail.map((crumb, index) => (
        <span
          key={crumb.id ?? `crumb-${String(index)}`}
          style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}
        >
          <Icons.ChevronRight size={14} />
          <button
            type="button"
            onClick={() => onNavigate(index)}
            className="truncate"
            disabled={index === trail.length - 1}
            style={{
              fontSize: "var(--text-h2)",
              fontWeight: 600,
              color: index === trail.length - 1 ? "var(--text)" : "var(--accent)",
              background: "transparent",
              padding: 0,
              maxWidth: 220,
            }}
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

function DriveMain({
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
  onUpload,
  onDropFiles,
  onNewItem,
  loading,
  error,
  uploadError,
  onRetry,
  uploading,
  creating,
}: {
  readonly view: DriveView;
  readonly onViewChange: (view: DriveView) => void;
  readonly scope: DriveScope;
  readonly trail: readonly DriveCrumb[];
  readonly onNavigateCrumb: (index: number) => void;
  readonly folders: readonly DriveFolderItem[];
  readonly files: readonly DriveFileItem[];
  readonly selectedFileId: string | null;
  readonly onSelectFile: (id: string) => void;
  readonly onOpenFolder: (folder: DriveFolderItem) => void;
  readonly onUpload: () => void;
  readonly onDropFiles: (files: readonly File[]) => void;
  readonly onNewItem: (kind: DriveCreateKind) => void;
  readonly loading: boolean;
  readonly error: Error | null;
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
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: 24,
        overflowY: "auto",
        minWidth: 0,
        position: "relative",
      }}
    >
      {/* Drop overlay */}
      {isDragOver ? (
        <div className="drive-drop-overlay" data-testid="drive-drop-overlay" aria-hidden="true">
          <span className="drive-drop-overlay-icon">
            <Icons.Upload size={40} />
          </span>
          <span className="drive-drop-overlay-label">
            Drop files to upload to {currentFolderName}
          </span>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", marginBottom: 16, gap: 12 }}>
        <DriveBreadcrumb scope={scope} trail={trail} onNavigate={onNavigateCrumb} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button
            type="button"
            aria-label="Grid view"
            aria-pressed={view === "grid"}
            className={`btn sm ${view === "grid" ? "primary" : ""}`}
            onClick={() => onViewChange("grid")}
          >
            <Icons.Grid />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={view === "list"}
            className={`btn sm ${view === "list" ? "primary" : ""}`}
            onClick={() => onViewChange("list")}
          >
            <Icons.List />
          </button>
          <button type="button" className="btn sm">
            <Icons.Filter />
            Filter
          </button>
        </div>
      </div>

      {uploadError !== null ? (
        <div
          role="alert"
          style={{
            fontSize: "var(--text-meta)",
            color: "var(--danger, #dc2626)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 12,
          }}
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
              <div className="section-label" style={{ padding: "0 0 8px" }}>
                Folders
              </div>
              <div style={{ ...TILE_GRID, gap: 8, marginBottom: 24 }}>
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => onOpenFolder(folder)}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "10px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <Icons.Folder />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="truncate" style={{ fontSize: "var(--text-meta)", fontWeight: 500 }}>
                        {folder.name}
                      </div>
                      <div style={{ fontSize: "var(--text-chip)", color: "var(--text-3)" }}>
                        {folder.itemCount > 0 ? `${String(folder.itemCount)} items` : "Open folder"}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="section-label" style={{ padding: "0 0 8px" }}>
            Files
          </div>
          {gridFiles.length === 0 && view === "grid" ? (
            <div style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", padding: "8px 0" }}>
              No files here yet.
            </div>
          ) : view === "grid" ? (
            <div style={{ ...TILE_GRID, gap: 12 }}>
              {gridFiles.map((file) => (
                <DriveFileCard
                  key={file.id}
                  file={file}
                  selected={file.id === selectedFileId}
                  onSelect={() => onSelectFile(file.id)}
                />
              ))}
            </div>
          ) : (
            <div className="panel">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: LIST_COLUMNS,
                  padding: "0 16px",
                  height: 32,
                  alignItems: "center",
                  fontSize: "var(--text-caption)",
                  color: "var(--text-3)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                  borderBottom: "1px solid var(--border)",
                  background: "var(--surface-2)",
                }}
              >
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
                  onOpenFolder={() => onOpenFolder({ id: file.id, name: file.name, itemCount: 0 })}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Floating Action Button (+ FAB) — bottom-right, same menu as the sidebar "New" button */}
      <div className="drive-fab-wrapper">
        {fabMenuOpen ? (
          <>
            {/* Backdrop to close FAB menu on outside click */}
            <div
              aria-hidden="true"
              style={{ position: "fixed", inset: 0, zIndex: 99 }}
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
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleFabMenuItem(() => onNewItem("folder"))}
              >
                <Icons.Folder />
                New folder
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleFabMenuItem(() => onNewItem("document"))}
              >
                <Icons.Doc />
                Document
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleFabMenuItem(() => onNewItem("spreadsheet"))}
              >
                <Icons.Sheet />
                Spreadsheet
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleFabMenuItem(() => onNewItem("presentation"))}
              >
                <Icons.Image />
                Presentation
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", fontWeight: 400 }}
                onClick={() => handleFabMenuItem(onUpload)}
              >
                <Icons.Upload />
                Upload file
              </button>
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
          <Icons.Plus size={24} />
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
      style={{ fontSize: "var(--text-meta)", color: "var(--text-3)", padding: "32px 0" }}
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
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 10,
        padding: "32px 0",
      }}
    >
      <div style={{ fontSize: "var(--text-body-sm)", fontWeight: 600 }}>Couldn’t load Drive</div>
      <div style={{ fontSize: "var(--text-meta)", color: "var(--text-3)" }}>{message}</div>
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        padding: "48px 0",
        color: "var(--text-3)",
      }}
    >
      <Icons.Drive size={40} />
      <div style={{ fontSize: "var(--text-body-sm)" }}>{copy[scope]}</div>
      {scope === "my" ? (
        <button type="button" className="btn sm primary" onClick={onUpload}>
          <Icons.Upload />
          Upload a file
        </button>
      ) : null}
    </div>
  );
}

function DriveFileCard({
  file,
  selected,
  onSelect,
}: {
  readonly file: DriveFileItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const appMeta = file.app !== null ? (APP_ICON_META[file.app] ?? null) : null;
  const meta = appMeta ?? DRIVE_FILE_META[file.type];
  const FileIcon = Icons[meta.icon];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        background: "var(--surface)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 8,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        textAlign: "left",
        overflow: "hidden",
        boxShadow: selected ? "0 0 0 3px var(--accent-soft)" : "none",
      }}
    >
      <div
        style={{
          aspectRatio: "4 / 3",
          background: "var(--surface-2)",
          display: "grid",
          placeItems: "center",
          color: meta.color,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <FileIcon size={36} />
      </div>
      <div style={{ padding: 10 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <div className="truncate" style={{ fontSize: "var(--text-meta)", fontWeight: 500, flex: 1, minWidth: 0 }}>
            {file.name}
          </div>
          {file.formatLabel ? <FormatChip label={file.formatLabel} color={meta.color} /> : null}
        </div>
        <div
          style={{
            fontSize: "var(--text-caption)",
            color: "var(--text-3)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Avatar name={file.owner} size={14} />
          <span className="truncate">{file.modified}</span>
        </div>
      </div>
    </button>
  );
}

/** Small uppercase chip that shows the file format (e.g. "DOCX", "PDF",
 *  "MD") so the user can tell file types apart at a glance. Tinted with the
 *  same accent color as the file's icon. */
function FormatChip({ label, color }: { readonly label: string; readonly color: string }) {
  return (
    <span
      style={{
        flexShrink: 0,
        padding: "0 5px",
        height: 16,
        lineHeight: "16px",
        borderRadius: 3,
        fontSize: "var(--text-overline)",
        fontWeight: 700,
        letterSpacing: ".04em",
        color,
        background: "var(--surface-2)",
        border: `1px solid ${color}33`,
        textTransform: "uppercase",
      }}
      aria-label={`Format: ${label}`}
    >
      {label}
    </span>
  );
}

function DriveFileRow({
  file,
  selected,
  onSelect,
  onOpenFolder,
}: {
  readonly file: DriveFileItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpenFolder: () => void;
}) {
  const appMeta = file.app !== null ? (APP_ICON_META[file.app] ?? null) : null;
  const meta = appMeta ?? DRIVE_FILE_META[file.type];
  const FileIcon = Icons[meta.icon];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={file.type === "folder" ? onOpenFolder : onSelect}
      style={{
        display: "grid",
        gridTemplateColumns: LIST_COLUMNS,
        padding: "0 16px",
        height: 36,
        alignItems: "center",
        fontSize: "var(--text-meta)",
        width: "100%",
        textAlign: "left",
        background: selected ? "var(--accent-soft)" : "transparent",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="row gap-2" style={{ minWidth: 0 }}>
        <span style={{ color: meta.color, display: "inline-flex" }}>
          <FileIcon />
        </span>
        <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{file.name}</span>
        {file.formatLabel ? <FormatChip label={file.formatLabel} color={meta.color} /> : null}
      </div>
      <div className="row gap-2">
        <Avatar name={file.owner} size={18} />
        <span className="truncate">{file.owner}</span>
      </div>
      <span style={{ color: "var(--text-2)" }}>{file.modified}</span>
      <span style={{ color: "var(--text-2)" }}>{file.size}</span>
      <span
        className="icon-btn"
        role="presentation"
        aria-hidden="true"
        style={{ display: "inline-flex" }}
      >
        <Icons.MoreV />
      </span>
    </button>
  );
}

function DriveDetailsPanel({
  file,
  entry,
  ownerName,
  currentActorId,
  isTrash,
  inSubfolder,
  busy,
  actionError,
  onClose,
  onTrash,
  onRestore,
  onDelete,
  onMoveToParent,
  onShare,
  shareDone,
}: {
  readonly file: DriveFileItem;
  readonly entry: DriveApiEntry | null;
  readonly ownerName: string;
  readonly currentActorId: string | null;
  readonly isTrash: boolean;
  readonly inSubfolder: boolean;
  readonly busy: boolean;
  readonly actionError: Error | null;
  readonly onClose: () => void;
  readonly onTrash: (id: string) => void;
  readonly onRestore: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onMoveToParent: (id: string) => void;
  readonly onShare: (id: string, actorIds: readonly string[]) => void;
  readonly shareDone: boolean;
}) {
  const appMeta = file.app !== null ? (APP_ICON_META[file.app] ?? null) : null;
  const meta = appMeta ?? DRIVE_FILE_META[file.type];
  const FileIcon = Icons[meta.icon];
  const [shareInput, setShareInput] = useState("");

  // Owner label: when the entry is owned by the current actor, show the
  // session display name. Otherwise prefer the server-resolved display
  // name (via `entry.ownerDisplayName`) and fall back to file.owner
  // which already projects from the same field via fileItemFromEntry.
  const ownerLabel =
    entry?.ownerActorId === null || entry?.ownerActorId === currentActorId
      ? ownerName
      : (entry?.ownerDisplayName ?? entry?.ownerEmail ?? file.owner);

  // Recent activity from real entry timestamps.
  const activity = useMemo<
    ReadonlyArray<{ readonly who: string; readonly what: string; readonly time: string }>
  >(() => {
    if (entry === null) {
      return [{ who: file.owner, what: "edited", time: file.modified }];
    }
    const items: Array<{ who: string; what: string; time: string }> = [
      { who: ownerLabel, what: "edited", time: formatModified(entry.updatedAt) },
      { who: ownerLabel, what: "created", time: formatModified(entry.createdAt) },
    ];
    if (entry.deletedAt !== null) {
      items.unshift({ who: ownerLabel, what: "moved to trash", time: formatModified(entry.deletedAt) });
    }
    return items;
  }, [entry, ownerLabel, file.owner, file.modified]);

  const download = entry === null ? null : driveDownloadResult(entry);

  const onShareSubmit = () => {
    const ids = shareInput
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (ids.length > 0) {
      onShare(file.id, ids);
      setShareInput("");
    }
  };

  return (
    <aside
      aria-label="File details"
      style={{
        width: 320,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="truncate" style={{ fontSize: "var(--text-body-sm)", fontWeight: 600 }}>
          Details
        </span>
        <button
          type="button"
          aria-label="Close details"
          className="icon-btn"
          style={{ marginLeft: "auto" }}
          onClick={onClose}
        >
          <Icons.X />
        </button>
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        <div
          style={{
            aspectRatio: "4 / 3",
            background: "var(--surface-2)",
            display: "grid",
            placeItems: "center",
            color: meta.color,
            borderBottom: "1px solid var(--border)",
          }}
        >
          {entry?.preview?.kind === "image" && entry.preview.url !== undefined ? (
            <img
              src={entry.preview.url}
              alt={file.name}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <FileIcon size={56} />
          )}
        </div>
        <div style={{ padding: "12px 14px" }}>
          <div style={{ fontSize: "var(--text-body)", fontWeight: 600, marginBottom: 4, wordBreak: "break-word" }}>
            {file.name}
          </div>
          <div
            className="row gap-2"
            style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginBottom: 12 }}
          >
            <span style={{ textTransform: "uppercase" }}>{file.type}</span>
            <span>·</span>
            <span>{file.size}</span>
          </div>

          {actionError !== null ? (
            <div
              role="alert"
              style={{
                fontSize: "var(--text-caption)",
                color: "var(--danger, #dc2626)",
                marginBottom: 10,
              }}
            >
              {actionError.message}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
            <a
              className="btn sm primary"
              href={download?.url ?? "#"}
              // Native editor URLs and the PDF viewer stay in-tab; raw
              // previews pop a new tab so the user keeps their place.
              target={
                entry?.app === null || entry?.app === undefined
                  ? download?.url.startsWith("/pdf/") === true
                    ? "_self"
                    : "_blank"
                  : "_self"
              }
              rel="noreferrer"
              aria-disabled={download === null}
              style={{ flex: 1, justifyContent: "center" }}
            >
              <Icons.Eye />
              Open
            </a>
            {/* Native editor docs (docs/sheets/slides) carry their content as
                Yjs state inside the typed table, not as a raw blob in RustFS,
                so the "Download" stream returns nothing useful. Hide the
                button for those; the editor surfaces its own export flow. */}
            <a
              className="btn sm"
              href={entry === null ? "#" : driveRawDownloadUrl(entry)}
              download={download?.name}
              aria-disabled={download === null}
              hidden={entry?.app !== null && entry?.app !== undefined}
              style={{ flex: 1, justifyContent: "center" }}
            >
              <Icons.Download />
              Download
            </a>
          </div>

          {isTrash ? (
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              <button
                type="button"
                className="btn sm"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => onRestore(file.id)}
              >
                <Icons.History />
                Restore
              </button>
              <button
                type="button"
                className="btn sm"
                style={{ flex: 1, color: "var(--danger, #dc2626)" }}
                disabled={busy}
                onClick={() => onDelete(file.id)}
              >
                <Icons.Trash />
                Delete forever
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {inSubfolder ? (
                <button
                  type="button"
                  className="btn sm"
                  style={{ flex: 1 }}
                  disabled={busy}
                  onClick={() => onMoveToParent(file.id)}
                >
                  <Icons.ArrowLeft />
                  Move up
                </button>
              ) : null}
              <button
                type="button"
                className="btn sm"
                style={{ flex: 1, color: "var(--danger, #dc2626)" }}
                disabled={busy}
                onClick={() => onTrash(file.id)}
              >
                <Icons.Trash />
                Move to trash
              </button>
            </div>
          )}

          <div className="section-label" style={{ padding: "8px 0 4px" }}>
            Owner
          </div>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--text-meta)", marginBottom: 12 }}
          >
            <Avatar name={ownerLabel} size={24} />
            <span className="truncate">{ownerLabel}</span>
          </div>
          <div className="section-label" style={{ padding: "8px 0 4px" }}>
            Modified
          </div>
          <div style={{ fontSize: "var(--text-meta)", color: "var(--text-2)", marginBottom: 12 }}>
            {entry !== null ? formatModified(entry.updatedAt) : file.modified}
          </div>

          {!isTrash ? (
            <>
              <div className="section-label" style={{ padding: "8px 0 6px" }}>
                Share
              </div>
              <input
                className="input"
                value={shareInput}
                onChange={(event) => setShareInput(event.target.value)}
                placeholder="Actor ID(s) to share with"
                style={{ width: "100%", fontSize: "var(--text-meta)", marginBottom: 6 }}
              />
              <button
                type="button"
                className="btn sm"
                style={{ width: "100%" }}
                disabled={busy || shareInput.trim().length === 0}
                onClick={onShareSubmit}
              >
                <Icons.Users />
                Share
              </button>
              {shareDone ? (
                <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 6 }}>
                  Access granted.
                </div>
              ) : null}
            </>
          ) : null}

          <div className="section-label" style={{ padding: "16px 0 6px" }}>
            Recent activity
          </div>
          {activity.map((item) => (
            <div
              key={`${item.who}-${item.what}-${item.time}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                fontSize: "var(--text-caption)",
              }}
            >
              <Avatar name={item.who} size={18} />
              <span className="truncate">
                <b style={{ fontWeight: 500 }}>{item.who}</b> {item.what}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--text-3)" }}>{item.time}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
