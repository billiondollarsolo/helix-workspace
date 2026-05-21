import {
  ArchiveRestore,
  AudioLines,
  Check,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderInput,
  Grid2X2,
  Link2,
  List,
  MoreHorizontal,
  MoveRight,
  Play,
  Plus,
  Share2,
  ShieldCheck,
  Trash2,
  Upload,
  type LucideIcon,
  X,
} from "lucide-react";
import { useForm } from "@tanstack/react-form";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { useQuery } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { useVirtualizer, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";
import { SuggestionSlot } from "@helix/sdk-web";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { createDocsDocument, type DocsApiDocument } from "@/features/docs/api";
import { DocsShell } from "@/features/docs/docs-shell";
import { docsDocumentsQueryOptions } from "@/features/docs/queries";
import {
  deleteDriveObject,
  finalizeDriveUpload,
  moveDriveObject,
  prepareDriveUpload,
  restoreDriveObject,
  shareDrive,
  trashDriveObject,
  type DriveApiEntry,
  type DriveApiPreview,
  type DriveApiSearchHit,
} from "./api";
import {
  driveItemsQueryOptions,
  driveSuggestionsQueryOptions,
  fallbackDriveSuggestions,
  type DriveSuggestions,
} from "./queries";

type DriveView = "grid" | "list";
type DriveScope = "my-drive" | "documents" | "sheets" | "slides" | "shared" | "trash";
type DrivePreviewKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "document"
  | "office"
  | "archive";

interface DriveFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly itemCount: number;
  readonly updatedAt: string;
  readonly owner: string;
  readonly shared: boolean;
  readonly trashed: boolean;
}

interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly mimeType: string;
  readonly size: string;
  readonly updatedAt: string;
  readonly owner: string;
  readonly shared: boolean;
  readonly trashed: boolean;
  readonly kind: DrivePreviewKind;
  readonly preview?: DriveApiPreview;
  readonly previewText?: string;
  readonly previewUrl?: string;
  readonly syncState?: "local";
}

type DriveItem = DriveFolder | DriveFile;
type DriveSuggestionContext = Parameters<typeof SuggestionSlot>[0]["context"];

interface ShareTarget {
  readonly id: string;
  readonly label: string;
  readonly permission: "viewer" | "commenter" | "editor";
}

interface ShareDialogState {
  readonly itemIds: readonly string[];
}

interface MoveDialogState {
  readonly itemIds: readonly string[];
}

export interface DriveShellRouteState {
  readonly fileId?: string | null;
  readonly folderId: string | null;
  readonly includeTrashed: boolean;
  readonly query: string;
  readonly scope?: DriveScope;
}

const rootFolderId = "root";
const driveGridLaneCount = 3;
const driveGridGap = 10;
const driveGridItemEstimate = 204;
const driveListItemEstimate = 58;

const rootDriveFolder: DriveFolder = {
  id: rootFolderId,
  name: "My Drive",
  parentId: null,
  itemCount: 0,
  updatedAt: "",
  owner: "Unknown owner",
  shared: false,
  trashed: false,
};

const initialShareTargets: readonly ShareTarget[] = [
  { id: "target-team", label: "Product team", permission: "editor" },
  { id: "target-finance", label: "Finance reviewers", permission: "viewer" },
];

const shareLabelSchema = z.string().trim().min(1, "People or groups is required.");
const sharePermissionSchema = z.enum(["viewer", "commenter", "editor"]);

const navItems: ReadonlyArray<{
  readonly id: DriveScope;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { id: "my-drive", label: "My Drive", icon: Folder },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "sheets", label: "Sheets", icon: Grid2X2 },
  { id: "slides", label: "Slides", icon: Play },
  { id: "shared", label: "Shared with me", icon: Share2 },
  { id: "trash", label: "Trash", icon: Trash2 },
];

export function DriveShell({
  initialFileId,
  onRouteStateChange,
  routeState,
}: {
  readonly initialFileId?: string;
  readonly onRouteStateChange?: (state: DriveShellRouteState) => void;
  readonly routeState?: DriveShellRouteState;
} = {}) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const driveBrowserRef = useRef<HTMLDivElement | null>(null);
  const [folders, setFolders] = useState<readonly DriveFolder[]>([rootFolder()]);
  const [files, setFiles] = useState<readonly DriveFile[]>([]);
  const [backendOffline, setBackendOffline] = useState(false);
  const [scope, setScope] = useState<DriveScope>(
    routeState?.includeTrashed === true ? "trash" : (routeState?.scope ?? "my-drive"),
  );
  const [currentFolderId, setCurrentFolderId] = useState(routeState?.folderId ?? rootFolderId);
  const [view, setView] = useState<DriveView>("list");
  const [query, setQuery] = useState(routeState?.query ?? "");
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [previewId, setPreviewId] = useState("");
  const [shareDialog, setShareDialog] = useState<ShareDialogState | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  const [shareTargets, setShareTargets] = useState<readonly ShareTarget[]>(initialShareTargets);
  const normalizedQuery = query.trim();
  const [debouncedQuery] = useDebouncedValue(query, { wait: 300 });
  const debouncedNormalizedQuery = debouncedQuery.trim();
  const backendFolderId = currentFolderId === rootFolderId ? null : currentFolderId;
  const driveItemsQuery = useQuery(
    driveItemsQueryOptions({
      folderId: scope === "my-drive" ? backendFolderId : null,
      includeTrashed: scope === "trash",
      query: debouncedNormalizedQuery,
      limit: debouncedNormalizedQuery.length > 0 ? 50 : 100,
    }),
  );
  const docsDocumentsQuery = useQuery({
    ...docsDocumentsQueryOptions({ limit: 100 }),
    enabled: scope === "documents",
  });
  const isRootHome =
    scope === "my-drive" && currentFolderId === rootFolderId && normalizedQuery.length === 0;
  const driveSuggestionsQuery = useQuery({
    ...driveSuggestionsQueryOptions(),
    enabled: isRootHome,
  });
  /**
   * Suggestions to render in the Drive home. Prefer the backend query result;
   * when the backend is unavailable, derive suggestions from the locally
   * listed Drive entries so the Suggested sections are never empty offline.
   */
  const localSuggestions = useMemo<DriveSuggestions>(
    () =>
      fallbackDriveSuggestions([
        ...folders
          .filter((folder) => folder.id !== rootFolderId)
          .map(driveApiEntryFromFolder),
        ...files.map(driveApiEntryFromFile),
      ]),
    [files, folders],
  );
  const suggestionsBackendUnavailable =
    driveSuggestionsQuery.isError ||
    backendOffline ||
    (!driveSuggestionsQuery.isPending &&
      (driveSuggestionsQuery.data?.folders.length ?? 0) === 0 &&
      (driveSuggestionsQuery.data?.files.length ?? 0) === 0);
  const suggestions: DriveSuggestions =
    suggestionsBackendUnavailable || driveSuggestionsQuery.data === undefined
      ? localSuggestions
      : driveSuggestionsQuery.data;

  useEffect(() => {
    if (routeState === undefined) {
      return;
    }
    const nextFolderId = routeState.folderId ?? rootFolderId;
    setCurrentFolderId((current) => (current === nextFolderId ? current : nextFolderId));
    setQuery((current) => (current === routeState.query ? current : routeState.query));
    setScope((current) => {
      if (routeState.includeTrashed) {
        return "trash";
      }
      if (routeState.scope !== undefined) {
        return routeState.scope;
      }
      return current === "trash" ? "my-drive" : current;
    });
  }, [routeState]);

  useEffect(() => {
    const result = driveItemsQuery.data;
    if (result === undefined) {
      return;
    }
    setBackendOffline(false);

    if (result.mode === "search") {
      const nextFiles = result.hits.map(fileFromSearchHit);
      const routeFile = findDriveFile(nextFiles, initialFileId);
      setFolders([rootFolder()]);
      setFiles((current) => [
        ...clientOnlyFilesForFolder(current, currentFolderId).filter(
          (file) => !nextFiles.some((nextFile) => nextFile.id === file.id),
        ),
        ...nextFiles,
      ]);
      if (routeFile !== undefined) {
        setPreviewId(routeFile.id);
        setSelectedIds([routeFile.id]);
      } else {
        setPreviewId((current) =>
          current.length > 0 || result.hits.some((hit) => hit.objectId === current) ? current : "",
        );
        setSelectedIds([]);
      }
      return;
    }

    const backendFolders = result.entries
      .filter((entry) => entry.type === "folder")
      .map(folderFromEntry);
    const nextFolders = [rootFolder(), ...backendFolders];
    const nextFiles = result.entries.filter((entry) => entry.type === "file").map(fileFromEntry);
    const routeFile = findDriveFile(nextFiles, initialFileId);
    setFolders(nextFolders);
    setFiles((current) => [
      ...clientOnlyFilesForFolder(current, currentFolderId).filter(
        (file) => !nextFiles.some((nextFile) => nextFile.id === file.id),
      ),
      ...nextFiles,
    ]);
    if (routeFile !== undefined) {
      setScope(routeFile.trashed ? "trash" : "my-drive");
      setCurrentFolderId(routeFile.parentId ?? rootFolderId);
      setPreviewId(routeFile.id);
      setSelectedIds([routeFile.id]);
    } else {
      setPreviewId((current) =>
        current.length > 0 || result.entries.some((entry) => entry.id === current) ? current : "",
      );
      setSelectedIds([]);
    }
  }, [currentFolderId, driveItemsQuery.data, initialFileId]);

  useEffect(() => {
    const documents = docsDocumentsQuery.data;
    if (documents === undefined) {
      return;
    }

    const nextDocumentFiles = documents.map((document) =>
      driveFileFromDocsDocument(document, rootFolderId),
    );
    setFiles((current) => [
      ...current.filter(
        (file) =>
          file.kind !== "document" ||
          file.syncState === "local" ||
          !nextDocumentFiles.some((nextFile) => nextFile.id === file.id),
      ),
      ...nextDocumentFiles,
    ]);
    if (initialFileId !== undefined && nextDocumentFiles.some((file) => file.id === initialFileId)) {
      setScope("documents");
      setPreviewId(initialFileId);
      setSelectedIds([initialFileId]);
    }
  }, [docsDocumentsQuery.data, initialFileId]);

  useEffect(() => {
    if (!driveItemsQuery.isError) {
      return;
    }
    setBackendOffline(true);
    setFolders([rootFolder()]);
    setFiles((current) => current.filter((file) => file.syncState === "local"));
    setPreviewId("");
    setSelectedIds([]);
  }, [driveItemsQuery.isError]);

  const items = useMemo<readonly DriveItem[]>(() => [...folders, ...files], [files, folders]);
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const folderNamesById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );
  const previewItem = previewId.length > 0 ? itemById.get(previewId) : undefined;
  const selectedItems = selectedIds.map((id) => itemById.get(id)).filter(isDriveItem);
  const visibleItems = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();
    return items.filter((item) => {
      const matchesScope =
        scope === "trash"
          ? item.trashed
          : scope === "shared"
            ? item.shared && !item.trashed
            : scope === "documents"
              ? !item.trashed && !isDriveFolder(item) && item.kind === "document"
              : scope === "sheets"
                ? !item.trashed && !isDriveFolder(item) && isSheetFile(item)
                : scope === "slides"
                  ? !item.trashed && !isDriveFolder(item) && isSlideFile(item)
              : !item.trashed && item.parentId === currentFolderId;
      const matchesQuery = !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery);
      return matchesScope && matchesQuery;
    });
  }, [currentFolderId, debouncedQuery, items, scope]);
  const breadcrumbs = useMemo(
    () => buildBreadcrumbs(folders, currentFolderId),
    [currentFolderId, folders],
  );
  const previewSuggestionContext =
    previewItem && !isDriveFolder(previewItem)
      ? driveSuggestionContextForFile(previewItem, breadcrumbs)
      : undefined;
  const selectedDocumentId =
    previewItem !== undefined && !isDriveFolder(previewItem) && previewItem.kind === "document"
      ? previewItem.id
      : undefined;
  const allVisibleSelected =
    visibleItems.length > 0 && visibleItems.every((item) => selectedIds.includes(item.id));

  const resetSelection = () => setSelectedIds([]);

  const pushRouteState = (nextState: Partial<DriveShellRouteState>) => {
    const { fileId: nextStateFileId, ...restNextState } = nextState;
    const nextFileId =
      nextStateFileId === null
        ? undefined
        : (nextStateFileId ?? (previewId.length > 0 ? previewId : undefined));
    onRouteStateChange?.({
      folderId: currentFolderId === rootFolderId ? null : currentFolderId,
      includeTrashed: scope === "trash",
      query: normalizedQuery,
      scope: scope === "my-drive" ? undefined : scope,
      ...(nextFileId === undefined ? {} : { fileId: nextFileId }),
      ...restNextState,
    });
  };

  const openFolder = (folderId: string) => {
    setScope("my-drive");
    setCurrentFolderId(folderId);
    pushRouteState({
      fileId: null,
      folderId: folderId === rootFolderId ? null : folderId,
      includeTrashed: false,
    });
    resetSelection();
  };

  const selectScope = (nextScope: DriveScope) => {
    setScope(nextScope);
    if (nextScope !== "my-drive") {
      setCurrentFolderId(rootFolderId);
    }
    pushRouteState({
      fileId: null,
      folderId: nextScope === "my-drive" ? currentFolderIdForRoute(currentFolderId) : null,
      includeTrashed: nextScope === "trash",
      scope: nextScope === "my-drive" ? undefined : nextScope,
    });
    resetSelection();
  };

  const toggleItem = (itemId: string) => {
    setSelectedIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    );
  };

  const selectOnly = (itemId: string) => {
    setSelectedIds([itemId]);
    setPreviewId(itemId);
    const item = itemById.get(itemId);
    if (item !== undefined && !isDriveFolder(item) && item.kind === "document") {
      setScope("documents");
      pushRouteState({
        fileId: itemId,
        folderId: null,
        includeTrashed: false,
        scope: "documents",
      });
    }
  };

  const openDocument = (documentId: string) => {
    setScope("documents");
    setPreviewId(documentId);
    setSelectedIds([documentId]);
    pushRouteState({
      fileId: documentId,
      folderId: null,
      includeTrashed: false,
      scope: "documents",
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedIds(allVisibleSelected ? [] : visibleItems.map((item) => item.id));
  };

  const uploadFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (selectedFiles.length === 0) {
      return;
    }
    const uploadedFiles = selectedFiles.map<DriveFile>((file, index) => ({
      id: `upload-${Date.now()}-${index}`,
      name: file.name,
      parentId: currentFolderId,
      mimeType: file.type || "application/octet-stream",
      size: formatBytes(file.size),
      updatedAt: "Just now",
      owner: "Local upload",
      shared: false,
      trashed: false,
      kind: kindFromMime(file.type, file.name),
      syncState: "local",
    }));
    setFiles((current) => [...uploadedFiles, ...current]);
    setPreviewId(uploadedFiles[0]?.id ?? previewId);
    setSelectedIds(uploadedFiles.map((file) => file.id));
    for (const [index, file] of selectedFiles.entries()) {
      const optimisticFileId = uploadedFiles[index]?.id;
      void uploadFileToBackend(file, currentFolderId)
        .then((backendFile) => {
          setFiles((current) =>
            current.map((currentFile) =>
              currentFile.id === optimisticFileId ? backendFile : currentFile,
            ),
          );
          setPreviewId((current) => (current === optimisticFileId ? backendFile.id : current));
          setSelectedIds((current) =>
            current.map((selectedId) =>
              selectedId === optimisticFileId ? backendFile.id : selectedId,
            ),
          );
        })
        .catch(() => undefined);
    }
    event.target.value = "";
  };

  const createDocument = () => {
    const folderId = currentFolderId === rootFolderId ? null : currentFolderId;
    const fallbackDocument = driveFileFromDocsDocument({
      id: `doc-local-${Date.now()}`,
      title: "Untitled document",
      threadId: null,
      ownerActorId: "Maya Chen",
      createdByActorId: "Maya Chen",
      ydocState: null,
      ydocStateVector: null,
      updateSeq: 0,
      metadata: { source: "drive.local-fallback" },
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createDocsDocument({
      title: "Untitled document",
      initialMarkdown: "# Untitled document\n",
      folderId,
      metadata: {
        source: "web.drive-shell",
        driveFolderId: folderId,
      },
    })
      .then((document) => {
        const file = driveFileFromDocsDocument(document, currentFolderId);
        setFiles((current) => [file, ...current]);
        setScope("documents");
        setPreviewId(file.id);
        setSelectedIds([file.id]);
        pushRouteState({
          fileId: file.id,
          folderId: null,
          includeTrashed: false,
          scope: "documents",
        });
      })
      .catch(() => {
        const file = {
          ...fallbackDocument,
          parentId: currentFolderId,
          syncState: "local" as const,
        };
        setFiles((current) => [file, ...current]);
        setScope("documents");
        setPreviewId(file.id);
        setSelectedIds([file.id]);
        pushRouteState({
          fileId: file.id,
          folderId: null,
          includeTrashed: false,
          scope: "documents",
        });
      });
  };

  const trashItems = (itemIds: readonly string[]) => {
    void Promise.all(itemIds.map((itemId) => trashDriveObject(itemId).catch(() => null)));
    setFolders((current) =>
      current.map((folder) =>
        itemIds.includes(folder.id) ? { ...folder, trashed: true } : folder,
      ),
    );
    setFiles((current) =>
      current.map((file) => (itemIds.includes(file.id) ? { ...file, trashed: true } : file)),
    );
    resetSelection();
  };

  const restoreItems = (itemIds: readonly string[]) => {
    void Promise.all(itemIds.map((itemId) => restoreDriveObject(itemId).catch(() => null)));
    setFolders((current) =>
      current.map((folder) =>
        itemIds.includes(folder.id) ? { ...folder, trashed: false } : folder,
      ),
    );
    setFiles((current) =>
      current.map((file) => (itemIds.includes(file.id) ? { ...file, trashed: false } : file)),
    );
    resetSelection();
  };

  const deleteItems = (itemIds: readonly string[]) => {
    void Promise.all(itemIds.map((itemId) => deleteDriveObject(itemId).catch(() => undefined)));
    setFolders((current) => current.filter((folder) => !itemIds.includes(folder.id)));
    setFiles((current) => current.filter((file) => !itemIds.includes(file.id)));
    if (itemIds.includes(previewId)) {
      setPreviewId("");
    }
    resetSelection();
  };

  const moveItems = (itemIds: readonly string[], folderId: string) => {
    const backendFolderId = folderId === rootFolderId ? null : folderId;
    void Promise.all(
      itemIds.map((itemId) => moveDriveObject(itemId, backendFolderId).catch(() => null)),
    );
    setFolders((current) =>
      current.map((folder) =>
        itemIds.includes(folder.id) && folder.id !== folderId
          ? { ...folder, parentId: folderId }
          : folder,
      ),
    );
    setFiles((current) =>
      current.map((file) => (itemIds.includes(file.id) ? { ...file, parentId: folderId } : file)),
    );
    setMoveDialog(null);
    resetSelection();
  };

  const markShared = (itemIds: readonly string[]) => {
    setFolders((current) =>
      current.map((folder) => (itemIds.includes(folder.id) ? { ...folder, shared: true } : folder)),
    );
    setFiles((current) =>
      current.map((file) => (itemIds.includes(file.id) ? { ...file, shared: true } : file)),
    );
  };

  const shareItems = (itemIds: readonly string[], target: ShareTarget) => {
    void Promise.all(
      itemIds.map((itemId) =>
        shareDrive({
          objectId: itemId,
          actorIds: [target.label],
          role: target.permission === "viewer" ? "reader" : target.permission,
        }).catch(() => undefined),
      ),
    );
    setShareTargets((current) => [...current, target]);
    markShared(itemIds);
    setShareDialog(null);
  };

  const selectedActionIds =
    selectedIds.length > 0 ? selectedIds : previewItem ? [previewItem.id] : [];
  const toolbarLabel =
    selectedItems.length === 0
      ? `${visibleItems.length} items`
      : `${selectedItems.length} selected`;
  const virtualLaneCount = view === "grid" ? driveGridLaneCount : 1;
  const virtualItemEstimate = view === "grid" ? driveGridItemEstimate : driveListItemEstimate;
  const itemVirtualizer = useVirtualizer({
    count: visibleItems.length,
    estimateSize: () => virtualItemEstimate,
    getItemKey: (index) => visibleItems[index]?.id ?? index,
    getScrollElement: () => driveBrowserRef.current,
    lanes: virtualLaneCount,
    overscan: view === "grid" ? 9 : 10,
  });

  return (
    <section className="drive-page">
      <aside className="drive-sidebar" aria-label="Drive sections">
        <button
          className="drive-upload-button"
          onClick={() => uploadInputRef.current?.click()}
          type="button"
        >
          <Upload aria-hidden="true" size={18} />
          Upload
        </button>
        <button className="drive-upload-button secondary" onClick={createDocument} type="button">
          <Plus aria-hidden="true" size={18} />
          New doc
        </button>
        <input
          aria-label="Upload files"
          className="sr-only"
          multiple
          onChange={uploadFiles}
          ref={uploadInputRef}
          type="file"
        />
        <nav className="drive-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={scope === item.id ? "drive-nav-item active" : "drive-nav-item"}
                key={item.id}
                onClick={() => selectScope(item.id)}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="drive-storage">
          <div>
            <strong>Storage</strong>
            <span>18.7 GB of 100 GB</span>
          </div>
          <meter max={100} value={18.7}>
            18.7 GB
          </meter>
        </div>
      </aside>

      <div className="drive-workspace" role="main" aria-labelledby="drive-title">
        <header className="drive-header">
          <div>
            <h1 id="drive-title">Drive</h1>
            <Breadcrumbs breadcrumbs={breadcrumbs} scope={scope} onOpenFolder={openFolder} />
          </div>
          <div className="drive-header-actions">
            <button
              className="helix-button helix-button-secondary"
              onClick={() => setMoveDialog({ itemIds: selectedActionIds })}
              disabled={selectedActionIds.length === 0 || scope === "trash"}
              type="button"
            >
              <FolderInput aria-hidden="true" size={16} />
              Move
            </button>
            <button
              className="helix-button"
              onClick={() => setShareDialog({ itemIds: selectedActionIds })}
              disabled={selectedActionIds.length === 0 || scope === "trash"}
              type="button"
            >
              <Share2 aria-hidden="true" size={16} />
              Share
            </button>
          </div>
        </header>

        <div className="drive-toolbar">
          <span className="drive-selection-count">{toolbarLabel}</span>
          <div className="drive-action-group">
            {scope === "trash" ? (
              <>
                <button
                  className="helix-button helix-button-secondary"
                  disabled={selectedActionIds.length === 0}
                  onClick={() => restoreItems(selectedActionIds)}
                  type="button"
                >
                  <ArchiveRestore aria-hidden="true" size={16} />
                  Restore
                </button>
                <button
                  className="helix-button helix-button-destructive"
                  disabled={selectedActionIds.length === 0}
                  onClick={() => deleteItems(selectedActionIds)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} />
                  Delete
                </button>
              </>
            ) : (
              <button
                className="helix-button helix-button-secondary"
                disabled={selectedActionIds.length === 0}
                onClick={() => trashItems(selectedActionIds)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={16} />
                Trash
              </button>
            )}
            <div className="drive-view-toggle" aria-label="View mode">
              <button
                aria-label="Grid view"
                className={view === "grid" ? "active" : ""}
                onClick={() => setView("grid")}
                type="button"
              >
                <Grid2X2 aria-hidden="true" size={16} />
              </button>
              <button
                aria-label="List view"
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
                type="button"
              >
                <List aria-hidden="true" size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="drive-content">
          <div className="drive-browser" ref={driveBrowserRef}>
            {isRootHome ? (
              <DriveSuggestionsPanel
                isLoading={
                  driveSuggestionsQuery.isPending &&
                  !suggestionsBackendUnavailable
                }
                suggestions={suggestions}
                folderNames={folderNamesById}
                onOpenFolder={openFolder}
              />
            ) : null}
            {view === "grid" && visibleItems.length > 0 ? (
              <label className="drive-select-all">
                <input
                  checked={allVisibleSelected}
                  onChange={toggleVisibleSelection}
                  type="checkbox"
                />
                Select visible
              </label>
            ) : null}
            {backendOffline ? (
              <div className="drive-offline-state" role="status">
                Drive backend is offline. Showing local-only items that have not synced yet.
              </div>
            ) : null}
            {visibleItems.length === 0 ? (
              <DriveEmptyState
                isBackendOffline={backendOffline}
                isLoading={driveItemsQuery.isPending}
                query={normalizedQuery}
                scope={scope}
              />
            ) : (
              <DriveVirtualizedItems
                items={visibleItems}
                itemEstimate={virtualItemEstimate}
                laneCount={virtualLaneCount}
                onOpenDocument={openDocument}
                onOpenFolder={openFolder}
                onPreview={selectOnly}
                onShare={(itemId) => setShareDialog({ itemIds: [itemId] })}
                onToggle={toggleItem}
                selectedIds={selectedIds}
                virtualizer={itemVirtualizer}
                view={view}
              />
            )}
          </div>

          {selectedDocumentId !== undefined ? (
            <DriveDocumentEditorPanel
              documentId={selectedDocumentId}
              onClose={() => setPreviewId("")}
            />
          ) : previewItem ? (
            <PreviewPanel
              item={previewItem}
              onClose={() => setPreviewId("")}
              onOpenDocument={openDocument}
              onMove={(itemId) => setMoveDialog({ itemIds: [itemId] })}
              onShare={(itemId) => setShareDialog({ itemIds: [itemId] })}
              onTrash={(itemId) => trashItems([itemId])}
              suggestionContext={previewSuggestionContext}
            />
          ) : null}
        </div>
      </div>

      {shareDialog ? (
        <ShareDialog
          itemNames={shareDialog.itemIds.map(
            (itemId) => itemById.get(itemId)?.name ?? "Unknown item",
          )}
          onClose={() => setShareDialog(null)}
          onShare={(target) => {
            shareItems(shareDialog.itemIds, target);
          }}
          targets={shareTargets}
        />
      ) : null}

      {moveDialog ? (
        <MoveDialog
          folders={folders.filter(
            (folder) => !folder.trashed && !moveDialog.itemIds.includes(folder.id),
          )}
          itemNames={moveDialog.itemIds.map(
            (itemId) => itemById.get(itemId)?.name ?? "Unknown item",
          )}
          onClose={() => setMoveDialog(null)}
          onMove={(folderId) => moveItems(moveDialog.itemIds, folderId)}
        />
      ) : null}
    </section>
  );
}

function Breadcrumbs({
  breadcrumbs,
  onOpenFolder,
  scope,
}: {
  readonly breadcrumbs: readonly DriveFolder[];
  readonly onOpenFolder: (folderId: string) => void;
  readonly scope: DriveScope;
}) {
  if (scope === "documents") {
    return <p className="drive-breadcrumb">Documents in Drive</p>;
  }
  if (scope === "sheets") {
    return <p className="drive-breadcrumb">Sheets in Drive</p>;
  }
  if (scope === "slides") {
    return <p className="drive-breadcrumb">Slides in Drive</p>;
  }
  if (scope === "shared") {
    return <p className="drive-breadcrumb">Shared with me</p>;
  }
  if (scope === "trash") {
    return <p className="drive-breadcrumb">Trash</p>;
  }
  return (
    <nav className="drive-breadcrumb" aria-label="Folder breadcrumb">
      {breadcrumbs.map((folder, index) => (
        <span key={folder.id}>
          {index > 0 ? <ChevronRight aria-hidden="true" size={14} /> : null}
          <button onClick={() => onOpenFolder(folder.id)} type="button">
            {folder.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

function DriveEmptyState({
  isBackendOffline,
  isLoading,
  query,
  scope,
}: {
  readonly isBackendOffline: boolean;
  readonly isLoading: boolean;
  readonly query: string;
  readonly scope: DriveScope;
}) {
  let title = "No Drive files";
  let description = "Upload a file to add it to Drive.";

  if (isLoading) {
    title = "Loading Drive";
    description = "Checking Drive for your files.";
  } else if (isBackendOffline) {
    title = "Drive backend is offline";
    description = "No backend files are shown. Local uploads will appear here until they sync.";
  } else if (query.length > 0) {
    title = "No matching files";
    description = "Upload a file or change the current filter.";
  } else if (scope === "documents") {
    title = "No documents";
    description = "Create a doc or open a document from Drive.";
  } else if (scope === "sheets") {
    title = "No sheets";
    description = "Spreadsheet-style files in Drive will appear here.";
  } else if (scope === "slides") {
    title = "No slides";
    description = "Presentation-style files in Drive will appear here.";
  } else if (scope === "shared") {
    title = "No shared files";
    description = "Files shared with you will appear here.";
  } else if (scope === "trash") {
    title = "Trash is empty";
    description = "Deleted files will appear here before permanent removal.";
  }

  return (
    <div className="drive-empty-state">
      <Folder aria-hidden="true" size={24} />
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function DriveSuggestionsPanel({
  isLoading,
  suggestions,
  folderNames,
  onOpenFolder,
}: {
  readonly isLoading: boolean;
  readonly suggestions: DriveSuggestions | undefined;
  readonly folderNames: ReadonlyMap<string, string>;
  readonly onOpenFolder: (folderId: string) => void;
}) {
  const folders = suggestions?.folders ?? [];
  const files = suggestions?.files ?? [];

  return (
    <div className="drive-suggestions">
      <section className="drive-suggested-folders">
        <h2 className="drive-section-title">Suggested folders</h2>
        {isLoading ? (
          <p className="drive-suggestions-loading" role="status">
            Loading suggestions...
          </p>
        ) : folders.length === 0 ? (
          <p className="drive-suggestions-empty">No recent folders.</p>
        ) : (
          <div className="drive-suggested-cards">
            {folders.map((folder) => (
              <button
                className="drive-suggested-card"
                key={folder.id}
                onClick={() => onOpenFolder(folder.id)}
                type="button"
              >
                <span className="drive-suggested-card-icon" aria-hidden="true">
                  <Folder size={20} />
                </span>
                <span className="drive-suggested-card-name">{folder.name}</span>
                <span className="drive-suggested-card-meta">
                  {folder.ownerActorId ?? "Unknown owner"}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="drive-suggested-files">
        <h2 className="drive-section-title">Suggested files</h2>
        {isLoading ? (
          <p className="drive-suggestions-loading" role="status">
            Loading suggestions...
          </p>
        ) : files.length === 0 ? (
          <p className="drive-suggestions-empty">No recent files.</p>
        ) : (
          <Table className="drive-suggested-files-table drive-table" aria-label="Suggested files">
            <TableHeader className="drive-table-header">
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Reason suggested</TableHead>
                <TableHead scope="col">Owner</TableHead>
                <TableHead scope="col">Location</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <TableRow className="drive-item" key={file.id}>
                  <TableCell className="drive-table-name">
                    <span className="drive-table-name-cell">
                      <span className="drive-item-icon" aria-hidden="true">
                        <SuggestedFileIcon mimeType={file.mimeType ?? ""} />
                      </span>
                      <span className="drive-item-name">{file.name}</span>
                    </span>
                  </TableCell>
                  <TableCell>Recently modified</TableCell>
                  <TableCell className="drive-table-owner">
                    {file.ownerActorId ?? "Unknown owner"}
                  </TableCell>
                  <TableCell>
                    {file.folderId === null || file.folderId === undefined
                      ? "My Drive"
                      : (folderNames.get(file.folderId) ?? "My Drive")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function SuggestedFileIcon({ mimeType }: { readonly mimeType: string }) {
  const kind = suggestedFileKind(mimeType);
  if (kind === "sheet") {
    return <Grid2X2 size={18} />;
  }
  if (kind === "slide") {
    return <Play size={18} />;
  }
  return <FileText size={18} />;
}

function suggestedFileKind(mimeType: string): "doc" | "sheet" | "slide" | "folder" {
  if (
    mimeType === "application/vnd.helix.document" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    return "doc";
  }
  if (
    mimeType.includes("spreadsheet") ||
    mimeType === "application/vnd.ms-excel"
  ) {
    return "sheet";
  }
  if (
    mimeType.includes("presentation") ||
    mimeType === "application/vnd.ms-powerpoint"
  ) {
    return "slide";
  }
  return "doc";
}

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    readonly cellClassName?: string;
    readonly headClassName?: string;
  }
}

function useDriveItemColumns({
  onOpenDocument,
  onOpenFolder,
  onPreview,
  onShare,
  onToggle,
}: {
  readonly onOpenDocument: (documentId: string) => void;
  readonly onOpenFolder: (folderId: string) => void;
  readonly onPreview: (itemId: string) => void;
  readonly onShare: (itemId: string) => void;
  readonly onToggle: (itemId: string) => void;
}): ColumnDef<DriveItem>[] {
  return useMemo<ColumnDef<DriveItem>[]>(
    () => [
      {
        id: "selection",
        header: () => <span className="sr-only">Selection</span>,
        meta: { cellClassName: "drive-table-select", headClassName: "drive-table-select" },
        cell: ({ row }) => (
          <label className="drive-item-check" aria-label={`Select ${row.original.name}`}>
            <input
              checked={row.getIsSelected()}
              onChange={() => onToggle(row.original.id)}
              onClick={(event) => event.stopPropagation()}
              type="checkbox"
            />
          </label>
        ),
      },
      {
        accessorKey: "name",
        header: "Name",
        meta: { cellClassName: "drive-table-name", headClassName: "drive-table-name" },
        cell: ({ row }) => {
          const item = row.original;
          const Icon = iconForItem(item);
          const isFolder = isDriveFolder(item);
          const iconKind = driveFileIconKind(item);
          return (
            <button
              className="drive-table-name-cell"
              onClick={() => openDriveItem(item, { onOpenDocument, onOpenFolder, onPreview })}
              type="button"
            >
              <span className={`drive-item-icon ${isFolder ? "folder" : item.kind}`}>
                <Icon
                  aria-hidden="true"
                  className="drive-file-icon"
                  {...(iconKind === null ? {} : { "data-kind": iconKind })}
                  size={20}
                />
              </span>
              <span className="drive-item-name">{item.name}</span>
              {!isFolder && item.syncState === "local" ? (
                <span className="drive-shared-pill">Offline/local</span>
              ) : null}
            </button>
          );
        },
      },
      {
        accessorKey: "owner",
        header: "Owner",
        meta: { cellClassName: "drive-table-owner", headClassName: "drive-table-owner" },
      },
      {
        accessorKey: "updatedAt",
        header: "Modified",
        meta: { cellClassName: "drive-table-modified", headClassName: "drive-table-modified" },
      },
      {
        id: "size",
        header: "Size",
        meta: { cellClassName: "drive-table-size", headClassName: "drive-table-size" },
        cell: ({ row }) => {
          const item = row.original;
          return isDriveFolder(item) ? "" : item.size;
        },
      },
      {
        id: "sharing",
        header: "Sharing",
        meta: { cellClassName: "drive-table-sharing", headClassName: "drive-table-sharing" },
        cell: ({ row }) =>
          row.original.shared ? (
            <span className="drive-shared-pill">
              <Link2 aria-hidden="true" size={12} />
              Shared
            </span>
          ) : null,
      },
      {
        id: "actions",
        header: "Actions",
        meta: { cellClassName: "drive-table-actions", headClassName: "drive-table-actions" },
        cell: ({ row }) => (
          <button
            className="icon-button"
            aria-label={`Share ${row.original.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onShare(row.original.id);
            }}
            disabled={row.original.trashed}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" size={17} />
          </button>
        ),
      },
    ],
    [onOpenDocument, onOpenFolder, onPreview, onShare, onToggle],
  );
}

function openDriveItem(
  item: DriveItem,
  handlers: {
    readonly onOpenDocument: (documentId: string) => void;
    readonly onOpenFolder: (folderId: string) => void;
    readonly onPreview: (itemId: string) => void;
  },
) {
  if (isDriveFolder(item) && !item.trashed) {
    handlers.onOpenFolder(item.id);
    return;
  }
  if (!isDriveFolder(item) && item.kind === "document" && !item.trashed) {
    handlers.onOpenDocument(item.id);
    return;
  }
  handlers.onPreview(item.id);
}

function DriveVirtualizedItems({
  itemEstimate,
  items,
  laneCount,
  onOpenDocument,
  onOpenFolder,
  onPreview,
  onShare,
  onToggle,
  selectedIds,
  virtualizer,
  view,
}: {
  readonly itemEstimate: number;
  readonly items: readonly DriveItem[];
  readonly laneCount: number;
  readonly onOpenDocument: (documentId: string) => void;
  readonly onOpenFolder: (folderId: string) => void;
  readonly onPreview: (itemId: string) => void;
  readonly onShare: (itemId: string) => void;
  readonly onToggle: (itemId: string) => void;
  readonly selectedIds: readonly string[];
  readonly virtualizer: Virtualizer<HTMLDivElement, Element>;
  readonly view: DriveView;
}) {
  const tableData = useMemo<DriveItem[]>(() => [...items], [items]);
  const columns = useDriveItemColumns({
    onOpenDocument,
    onOpenFolder,
    onPreview,
    onShare,
    onToggle,
  });
  const rowSelection = useMemo(
    () => Object.fromEntries(selectedIds.map((id) => [id, true])),
    [selectedIds],
  );
  const table = useReactTable({
    columns,
    data: tableData,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (item) => item.id,
    state: {
      rowSelection,
    },
  });
  const tableRows = table.getRowModel().rows;
  const measuredVirtualItems = virtualizer.getVirtualItems();
  const virtualItems =
    measuredVirtualItems.length > 0
      ? measuredVirtualItems
      : fallbackVirtualItems(items.length, laneCount, itemEstimate);
  const totalSize = Math.max(
    virtualizer.getTotalSize(),
    Math.ceil(items.length / laneCount) * itemEstimate,
  );

  if (view === "list") {
    return (
      <Table
        className="drive-list drive-table"
        aria-label="Drive items"
        aria-rowcount={items.length + 1}
        data-testid="drive-virtualized-items"
      >
        <TableHeader className="drive-table-header">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                return (
                  <TableHead key={header.id} className={meta?.headClassName}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody
          style={{
            display: "block",
            minHeight: `${String(totalSize)}px`,
            position: "relative",
          }}
        >
          {virtualItems.map((virtualItem) => {
            const row = tableRows[virtualItem.index];
            if (row === undefined) {
              return null;
            }
            const selected = row.getIsSelected();
            return (
              <TableRow
                aria-rowindex={virtualItem.index + 2}
                aria-selected={selected}
                className={selected ? "drive-item selected" : "drive-item"}
                data-index={virtualItem.index}
                data-state={selected ? "selected" : undefined}
                key={row.id}
                style={virtualItemStyle(virtualItem, view, laneCount)}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta;
                  return (
                    <TableCell key={cell.id} className={meta?.cellClassName}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <div
      className="drive-grid"
      aria-label="Drive items"
      data-testid="drive-virtualized-items"
      style={{
        minHeight: `${String(totalSize)}px`,
        position: "relative",
      }}
    >
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        if (item === undefined) {
          return null;
        }
        return (
          <div
            data-index={virtualItem.index}
            key={virtualItem.key}
            style={virtualItemStyle(virtualItem, view, laneCount)}
          >
            <DriveItemRow
              item={item}
              onOpenFolder={onOpenFolder}
              onOpenDocument={onOpenDocument}
              onPreview={onPreview}
              onShare={onShare}
              onToggle={onToggle}
              selected={selectedIds.includes(item.id)}
              view={view}
            />
          </div>
        );
      })}
    </div>
  );
}

function fallbackVirtualItems(
  count: number,
  laneCount: number,
  itemEstimate: number,
): readonly VirtualItem[] {
  const virtualCount = Math.min(count, laneCount * 8);
  return Array.from({ length: virtualCount }, (_, index) => {
    const row = Math.floor(index / laneCount);
    const start = row * itemEstimate;
    return {
      end: start + itemEstimate,
      index,
      key: index,
      lane: index % laneCount,
      size: itemEstimate,
      start,
    };
  });
}

function virtualItemStyle(
  virtualItem: VirtualItem,
  view: DriveView,
  laneCount: number,
): CSSProperties {
  const baseStyle: CSSProperties = {
    left: 0,
    position: "absolute",
    top: 0,
    transform: `translateY(${String(virtualItem.start)}px)`,
  };
  if (view === "list") {
    return {
      ...baseStyle,
      minHeight: `${String(virtualItem.size)}px`,
      width: "100%",
    };
  }
  const totalGap = driveGridGap * (laneCount - 1);
  const width = `calc((100% - ${String(totalGap)}px) / ${String(laneCount)})`;
  return {
    ...baseStyle,
    left: `calc(${String(virtualItem.lane)} * (${width} + ${String(driveGridGap)}px))`,
    minHeight: `${String(virtualItem.size)}px`,
    width,
  };
}

function DriveItemRow({
  item,
  onOpenFolder,
  onOpenDocument,
  onPreview,
  onShare,
  onToggle,
  selected,
  tableCell = false,
  view,
}: {
  readonly item: DriveItem;
  readonly onOpenFolder: (folderId: string) => void;
  readonly onOpenDocument: (documentId: string) => void;
  readonly onPreview: (itemId: string) => void;
  readonly onShare: (itemId: string) => void;
  readonly onToggle: (itemId: string) => void;
  readonly selected: boolean;
  readonly tableCell?: boolean;
  readonly view: DriveView;
}) {
  const Icon = iconForItem(item);
  const isFolder = "itemCount" in item;
  const iconKind = driveFileIconKind(item);
  const openItem = () => {
    if (isFolder && !item.trashed) {
      onOpenFolder(item.id);
      return;
    }
    if (!isFolder && item.kind === "document" && !item.trashed) {
      onOpenDocument(item.id);
      return;
    }
    onPreview(item.id);
  };

  return (
    <article
      className={selected ? "drive-item selected" : "drive-item"}
      role={tableCell ? "cell" : undefined}
    >
      <label className="drive-item-check" aria-label={`Select ${item.name}`}>
        <input
          checked={selected}
          onChange={() => onToggle(item.id)}
          onClick={(event) => event.stopPropagation()}
          type="checkbox"
        />
      </label>
      <button className="drive-item-main" onClick={openItem} type="button">
        <span className={`drive-item-icon ${isFolder ? "folder" : item.kind}`}>
          <Icon
            aria-hidden="true"
            className="drive-file-icon"
            {...(iconKind === null ? {} : { "data-kind": iconKind })}
            size={view === "grid" ? 28 : 20}
          />
        </span>
        <span className="drive-item-name">{item.name}</span>
        <span className="drive-item-meta">{isFolder ? `${item.itemCount} items` : item.size}</span>
        <span className="drive-item-meta">{item.owner}</span>
        <span className="drive-item-meta">{item.updatedAt}</span>
        {!isFolder && item.syncState === "local" ? (
          <span className="drive-shared-pill">Offline/local</span>
        ) : null}
        {item.shared ? (
          <span className="drive-shared-pill">
            <Link2 aria-hidden="true" size={12} />
            Shared
          </span>
        ) : null}
      </button>
      <button
        className="icon-button"
        aria-label={`Share ${item.name}`}
        onClick={() => onShare(item.id)}
        disabled={item.trashed}
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={17} />
      </button>
    </article>
  );
}

function PreviewPanel({
  item,
  onClose,
  onOpenDocument,
  onMove,
  onShare,
  onTrash,
  suggestionContext,
}: {
  readonly item: DriveItem | undefined;
  readonly onClose: () => void;
  readonly onOpenDocument: (documentId: string) => void;
  readonly onMove: (itemId: string) => void;
  readonly onShare: (itemId: string) => void;
  readonly onTrash: (itemId: string) => void;
  readonly suggestionContext: DriveSuggestionContext | undefined;
}) {
  if (!item) {
    return null;
  }

  const isFolder = "itemCount" in item;

  return (
    <section className="drive-preview-panel" aria-label="Preview panel">
      <header>
        <div>
          <h2>{item.name}</h2>
          <p>{isFolder ? `${item.itemCount} items` : item.mimeType}</p>
          {!isFolder && item.syncState === "local" ? <p>Offline/local item</p> : null}
        </div>
        <button className="icon-button" aria-label="Close preview" onClick={onClose} type="button">
          <X aria-hidden="true" size={17} />
        </button>
      </header>
      <div className="drive-preview-frame">
        {isFolder ? <FolderPreview folder={item} /> : renderPreview(item)}
      </div>
      {!isFolder && item.kind === "image" ? (
        <SuggestionSlot
          className="drive-suggestion-slot"
          context={suggestionContext}
          emptyFallback={<div className="drive-suggestion-empty">No image description</div>}
          loadingFallback={<div className="drive-suggestion-empty">Loading image description</div>}
          slotId="drive.describe-image"
        />
      ) : null}
      {!isFolder ? (
        <SuggestionSlot
          className="drive-suggestion-slot"
          context={suggestionContext}
          emptyFallback={<div className="drive-suggestion-empty">No file summary</div>}
          loadingFallback={<div className="drive-suggestion-empty">Loading file summary</div>}
          slotId="drive.summarize-file"
        />
      ) : null}
      <dl className="drive-preview-meta">
        <div>
          <dt>Owner</dt>
          <dd>{item.owner}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{item.updatedAt}</dd>
        </div>
        <div>
          <dt>Sharing</dt>
          <dd>{item.shared ? "Shared" : "Private"}</dd>
        </div>
      </dl>
      <div className="drive-preview-actions">
        <button
          className="helix-button helix-button-secondary"
          disabled={item.trashed || isFolder}
          onClick={() => {
            if (!isFolder && item.kind === "document") {
              onOpenDocument(item.id);
            }
          }}
          type="button"
        >
          {isFolder || item.kind !== "document" ? (
            <Download aria-hidden="true" size={16} />
          ) : (
            <FileText aria-hidden="true" size={16} />
          )}
          {isFolder || item.kind !== "document" ? "Download" : "Open in Docs"}
        </button>
        <button
          className="helix-button helix-button-secondary"
          disabled={item.trashed}
          onClick={() => onMove(item.id)}
          type="button"
        >
          <MoveRight aria-hidden="true" size={16} />
          Move
        </button>
        <button
          className="helix-button"
          disabled={item.trashed}
          onClick={() => onShare(item.id)}
          type="button"
        >
          <Share2 aria-hidden="true" size={16} />
          Share
        </button>
        <button
          className="helix-button helix-button-destructive"
          disabled={item.trashed}
          onClick={() => onTrash(item.id)}
          type="button"
        >
          <Trash2 aria-hidden="true" size={16} />
          Trash
        </button>
      </div>
    </section>
  );
}

function DriveDocumentEditorPanel({
  documentId,
  onClose,
}: {
  readonly documentId: string;
  readonly onClose: () => void;
}) {
  return (
    <section className="drive-docs-panel" aria-label="Document editor">
      <button className="icon-button drive-docs-close" aria-label="Close document" onClick={onClose} type="button">
        <X aria-hidden="true" size={17} />
      </button>
      <DocsShell initialDocumentId={documentId} variant="drive-embedded" />
    </section>
  );
}

function driveSuggestionContextForFile(
  file: DriveFile,
  breadcrumbs: readonly DriveFolder[],
): DriveSuggestionContext {
  const previewText = file.preview?.kind === "text" ? file.preview.text : file.previewText;
  const imageUrl = file.preview?.kind === "image" ? file.preview.url : file.previewUrl;
  return {
    routePath: "/drive",
    resource: {
      id: file.id,
      type: "drive.file",
      label: file.name,
    },
    classification: "standard",
    input: previewText ?? file.name,
    metadata: {
      name: file.name,
      mimeType: file.mimeType,
      kind: file.kind,
      path: [...breadcrumbs.map((folder) => folder.name), file.name],
      previewText,
      imageUrl,
      owner: file.owner,
      shared: file.shared,
      trashed: file.trashed,
      updatedAt: file.updatedAt,
      syncState: file.syncState,
    },
  };
}

function FolderPreview({ folder }: { readonly folder: DriveFolder }) {
  return (
    <div className="drive-folder-preview">
      <Folder aria-hidden="true" size={42} />
      <strong>{folder.name}</strong>
      <span>{folder.itemCount} items</span>
    </div>
  );
}

function renderPreview(file: DriveFile): ReactNode {
  if (file.syncState === "local" && file.preview === undefined && file.previewUrl === undefined) {
    return (
      <div className="drive-preview-office">
        <File aria-hidden="true" size={40} />
        <strong>Offline/local file</strong>
        <span>This upload is visible locally until the Drive backend accepts it.</span>
      </div>
    );
  }
  if (file.preview?.status === "available") {
    if (file.preview.kind === "image" && file.preview.url !== undefined) {
      return <img alt="" className="drive-preview-image" src={file.preview.url} />;
    }
    if (file.preview.kind === "pdf" && file.preview.url !== undefined) {
      return <iframe className="drive-preview-pdf" src={file.preview.url} title={file.name} />;
    }
    if (file.preview.kind === "text" && file.preview.text !== undefined) {
      return <pre className="drive-preview-text">{file.preview.text}</pre>;
    }
  }
  if (file.preview?.status === "unsupported") {
    return (
      <div className="drive-preview-office">
        <FileText aria-hidden="true" size={40} />
        <strong>No generated preview</strong>
        <span>{file.preview.blocker ?? "This file can still be downloaded or shared."}</span>
      </div>
    );
  }
  if (file.kind === "image") {
    return <img alt="" className="drive-preview-image" src={file.previewUrl} />;
  }
  if (file.kind === "pdf") {
    return <iframe className="drive-preview-pdf" src={file.previewUrl} title={file.name} />;
  }
  if (file.kind === "video") {
    return (
      <div className="drive-preview-video">
        <video controls preload="metadata" />
        <div>
          <Play aria-hidden="true" size={28} />
          <span>Video preview renderer</span>
        </div>
      </div>
    );
  }
  if (file.kind === "audio") {
    return (
      <div className="drive-preview-audio">
        <AudioLines aria-hidden="true" size={36} />
        <audio controls preload="metadata" />
      </div>
    );
  }
  if (file.kind === "text") {
    return <pre className="drive-preview-text">{file.previewText}</pre>;
  }
  if (file.kind === "document") {
    return (
      <div className="drive-preview-office">
        <FileText aria-hidden="true" size={40} />
        <strong>Helix Docs document</strong>
        <span>{file.previewText ?? "Open this Drive-backed document in Docs to edit it."}</span>
      </div>
    );
  }
  if (file.kind === "office") {
    return (
      <div className="drive-preview-office">
        <FileText aria-hidden="true" size={40} />
        <strong>LibreOffice PDF conversion queued</strong>
        <span>{file.previewText}</span>
      </div>
    );
  }
  return (
    <div className="drive-preview-office">
      <FileArchive aria-hidden="true" size={40} />
      <strong>No first-party preview</strong>
      <span>This file can still be downloaded or shared.</span>
    </div>
  );
}

function ShareDialog({
  itemNames,
  onClose,
  onShare,
  targets,
}: {
  readonly itemNames: readonly string[];
  readonly onClose: () => void;
  readonly onShare: (target: ShareTarget) => void;
  readonly targets: readonly ShareTarget[];
}) {
  const shareForm = useForm({
    defaultValues: {
      label: "",
      permission: "viewer" as ShareTarget["permission"],
    },
    onSubmit: ({ value }) => {
      const trimmed = value.label.trim();
      if (!trimmed) {
        return;
      }
      onShare({ id: `target-${Date.now()}`, label: trimmed, permission: value.permission });
    },
  });

  const submit = () => {
    void shareForm.handleSubmit();
  };

  return (
    <div className="helix-dialog-backdrop" role="presentation">
      <form
        className="helix-dialog drive-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        aria-labelledby="drive-share-title"
      >
        <header>
          <h2 id="drive-share-title">Share</h2>
          <button
            className="icon-button"
            aria-label="Close share dialog"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <p>{itemNames.length === 1 ? itemNames[0] : `${itemNames.length} selected items`}</p>
        <shareForm.Field
          name="label"
          validators={{
            onChange: validateWith(shareLabelSchema),
            onSubmit: validateWith(shareLabelSchema),
          }}
        >
          {(field) => (
            <label className="drive-field">
              <span>People or groups</span>
              <input
                aria-describedby="drive-share-label-error"
                aria-invalid={field.state.meta.errors.length > 0}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="name@company.com or Team"
                value={field.state.value}
              />
              <FieldErrors id="drive-share-label-error" errors={field.state.meta.errors} />
            </label>
          )}
        </shareForm.Field>
        <shareForm.Field
          name="permission"
          validators={{
            onChange: validateWith(sharePermissionSchema),
            onSubmit: validateWith(sharePermissionSchema),
          }}
        >
          {(field) => (
            <label className="drive-field">
              <span>Permission</span>
              <select
                aria-describedby="drive-share-permission-error"
                aria-invalid={field.state.meta.errors.length > 0}
                onChange={(event) =>
                  field.handleChange(event.target.value as ShareTarget["permission"])
                }
                value={field.state.value}
              >
                <option value="viewer">Viewer</option>
                <option value="commenter">Commenter</option>
                <option value="editor">Editor</option>
              </select>
              <FieldErrors id="drive-share-permission-error" errors={field.state.meta.errors} />
            </label>
          )}
        </shareForm.Field>
        <div className="drive-share-list">
          {targets.map((target) => (
            <div key={target.id}>
              <ShieldCheck aria-hidden="true" size={15} />
              <span>{target.label}</span>
              <strong>{target.permission}</strong>
            </div>
          ))}
        </div>
        <div className="helix-dialog-actions">
          <button className="helix-button helix-button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="helix-button" type="submit">
            <Share2 aria-hidden="true" size={16} />
            Share
          </button>
        </div>
      </form>
    </div>
  );
}

function validateWith<T>(schema: z.ZodType<T>) {
  return ({ value }: { readonly value: unknown }) => {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
  };
}

function FieldErrors({ errors, id }: { readonly errors: readonly unknown[]; readonly id: string }) {
  const messages = errors.filter((error): error is string => typeof error === "string");
  return messages.length === 0 ? null : (
    <span id={id} role="alert">
      {messages.join(" ")}
    </span>
  );
}

function MoveDialog({
  folders,
  itemNames,
  onClose,
  onMove,
}: {
  readonly folders: readonly DriveFolder[];
  readonly itemNames: readonly string[];
  readonly onClose: () => void;
  readonly onMove: (folderId: string) => void;
}) {
  const [targetFolderId, setTargetFolderId] = useState(rootFolderId);

  return (
    <div className="helix-dialog-backdrop" role="presentation">
      <section className="helix-dialog drive-dialog" aria-labelledby="drive-move-title">
        <header>
          <h2 id="drive-move-title">Move</h2>
          <button
            className="icon-button"
            aria-label="Close move dialog"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <p>{itemNames.length === 1 ? itemNames[0] : `${itemNames.length} selected items`}</p>
        <div className="drive-move-targets" role="listbox" aria-label="Destination folder">
          {folders.map((folder) => (
            <button
              className={targetFolderId === folder.id ? "active" : ""}
              key={folder.id}
              onClick={() => setTargetFolderId(folder.id)}
              type="button"
            >
              <Folder aria-hidden="true" size={16} />
              <span>{folder.name}</span>
              {targetFolderId === folder.id ? <Check aria-hidden="true" size={15} /> : null}
            </button>
          ))}
        </div>
        <div className="helix-dialog-actions">
          <button className="helix-button helix-button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="helix-button" onClick={() => onMove(targetFolderId)} type="button">
            <FolderInput aria-hidden="true" size={16} />
            Move here
          </button>
        </div>
      </section>
    </div>
  );
}

function buildBreadcrumbs(
  folders: readonly DriveFolder[],
  folderId: string,
): readonly DriveFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: DriveFolder[] = [];
  let cursor: DriveFolder | undefined = byId.get(folderId);
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return path.length > 0 ? path : folders.filter((folder) => folder.id === rootFolderId);
}

type DriveFileIconKind = "folder" | "doc" | "sheet" | "slide";

/**
 * Resolves the color-coded icon kind for a Drive row, mirroring Google Drive's
 * type-based icon coloring. Generic files return null so the icon falls through
 * to the default muted color.
 */
function driveFileIconKind(item: DriveItem): DriveFileIconKind | null {
  if ("itemCount" in item) {
    return "folder";
  }
  const mimeType = item.mimeType;
  if (
    mimeType.includes("spreadsheet") ||
    mimeType === "application/vnd.ms-excel"
  ) {
    return "sheet";
  }
  if (
    mimeType.includes("presentation") ||
    mimeType === "application/vnd.ms-powerpoint"
  ) {
    return "slide";
  }
  if (
    mimeType === "application/vnd.helix.document" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword" ||
    item.kind === "document"
  ) {
    return "doc";
  }
  return null;
}

const driveFileIconByKind: Readonly<Record<DriveFileIconKind, LucideIcon>> = {
  folder: Folder,
  doc: FileText,
  sheet: Grid2X2,
  slide: Play,
};

function iconForItem(item: DriveItem): LucideIcon {
  const iconKind = driveFileIconKind(item);
  if (iconKind !== null) {
    return driveFileIconByKind[iconKind];
  }
  if ("itemCount" in item) {
    return Folder;
  }
  if (item.kind === "image") {
    return FileImage;
  }
  if (item.kind === "video") {
    return FileVideo;
  }
  if (item.kind === "audio") {
    return AudioLines;
  }
  if (
    item.kind === "text" ||
    item.kind === "pdf" ||
    item.kind === "document" ||
    item.kind === "office"
  ) {
    return FileText;
  }
  return File;
}

function kindFromMime(mimeType: string, name: string): DrivePreviewKind {
  const lowerName = name.toLowerCase();
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("text/") || lowerName.endsWith(".md")) {
    return "text";
  }
  if (mimeType === "application/vnd.helix.document" || lowerName.endsWith(".helixdoc")) {
    return "document";
  }
  if (
    [
      ".doc",
      ".docx",
      ".gslides",
      ".gsheet",
      ".ppt",
      ".pptx",
      ".xls",
      ".xlsx",
      ".odt",
      ".ods",
      ".odp",
    ].some((extension) => lowerName.endsWith(extension))
  ) {
    return "office";
  }
  if (lowerName.endsWith(".zip")) {
    return "archive";
  }
  return "archive";
}

function folderFromEntry(entry: DriveApiEntry): DriveFolder {
  return {
    id: entry.id,
    name: entry.name,
    parentId: entry.folderId ?? rootFolderId,
    itemCount: 0,
    updatedAt: formatTimestamp(entry.updatedAt),
    owner: entry.ownerActorId ?? "Unknown owner",
    shared: false,
    trashed: entry.deletedAt !== null,
  };
}

function rootFolder(): DriveFolder {
  return rootDriveFolder;
}

function isSheetFile(file: DriveFile): boolean {
  const lowerName = file.name.toLowerCase();
  return (
    file.mimeType.includes("spreadsheet") ||
    lowerName.endsWith(".gsheet") ||
    lowerName.endsWith(".xls") ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".ods")
  );
}

function isSlideFile(file: DriveFile): boolean {
  const lowerName = file.name.toLowerCase();
  return (
    file.mimeType.includes("presentation") ||
    lowerName.endsWith(".gslides") ||
    lowerName.endsWith(".ppt") ||
    lowerName.endsWith(".pptx") ||
    lowerName.endsWith(".odp")
  );
}

function currentFolderIdForRoute(folderId: string): string | null {
  return folderId === rootFolderId ? null : folderId;
}

function clientOnlyFilesForFolder(
  files: readonly DriveFile[],
  folderId: string,
): readonly DriveFile[] {
  return files.filter(
    (file) =>
      file.parentId === folderId &&
      (file.syncState === "local" || file.mimeType === "application/vnd.helix.document"),
  );
}

function fileFromEntry(entry: DriveApiEntry): DriveFile {
  const mimeType = entry.mimeType ?? "application/octet-stream";
  const preview = entry.preview ?? previewFromMetadata(mimeType, entry.metadata);
  return {
    id: entry.id,
    name: entry.name,
    parentId: entry.folderId ?? rootFolderId,
    mimeType,
    size: formatBytes(entry.byteSize ?? 0),
    updatedAt: formatTimestamp(entry.updatedAt),
    owner: entry.ownerActorId ?? "Unknown owner",
    shared: false,
    trashed: entry.deletedAt !== null,
    kind: kindFromPreview(preview) ?? kindFromMime(mimeType, entry.name),
    ...(preview === undefined ? {} : { preview }),
    previewText: preview?.text ?? previewTextFromMetadata(entry.metadata),
    previewUrl: preview?.url,
  };
}

/**
 * Convert a locally-modeled Drive folder into the DriveApiEntry shape so it can
 * feed the suggestion-derivation helpers when the backend is offline.
 */
function driveApiEntryFromFolder(folder: DriveFolder): DriveApiEntry {
  return {
    id: folder.id,
    type: "folder",
    name: folder.name,
    folderId: folder.parentId === rootFolderId ? null : folder.parentId,
    ownerActorId: folder.owner,
    metadata: {},
    deletedAt: folder.trashed ? new Date(0).toISOString() : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Convert a locally-modeled Drive file into the DriveApiEntry shape for the
 * offline suggestion fallback.
 */
function driveApiEntryFromFile(file: DriveFile): DriveApiEntry {
  return {
    id: file.id,
    type: "file",
    name: file.name,
    folderId: file.parentId === rootFolderId ? null : file.parentId,
    ownerActorId: file.owner,
    mimeType: file.mimeType,
    metadata: {},
    deletedAt: file.trashed ? new Date(0).toISOString() : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function uploadFileToBackend(file: File, folderId: string): Promise<DriveFile> {
  const mimeType = file.type || "application/octet-stream";
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const prepared = await prepareDriveUpload({
    name: file.name,
    folderId: folderId === rootFolderId ? null : folderId,
    mimeType,
    byteSize: file.size,
    sha256,
    metadata: { source: "web.drive-shell" },
  });
  if (prepared.uploadUrl !== null) {
    const uploadResponse = await fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: { "content-type": mimeType },
      body: file,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Drive upload PUT failed with ${String(uploadResponse.status)}`);
    }
  }
  const finalized = await finalizeDriveUpload({
    objectId: prepared.objectId,
    byteSize: file.size,
    sha256,
    mimeType,
    storageKey: prepared.storageKey,
    ...(prepared.uploadUrl === null ? { contentBase64: arrayBufferToBase64(bytes) } : {}),
    metadata: { source: "web.drive-shell" },
  });

  return fileFromEntry({
    id: prepared.objectId,
    type: "file",
    name: prepared.name,
    folderId: prepared.folderId,
    ownerActorId: prepared.ownerActorId,
    mimeType: finalized.mimeType,
    byteSize: finalized.byteSize,
    sha256: finalized.sha256,
    storageKey: finalized.storageKey,
    versionNumber: finalized.versionNumber,
    metadata: finalized.metadata,
    deletedAt: null,
    createdAt: finalized.createdAt,
    updatedAt: finalized.createdAt,
  });
}

function driveFileFromDocsDocument(document: DocsApiDocument, folderId = rootFolderId): DriveFile {
  return {
    id: document.id,
    name: `${document.title}.helixdoc`,
    parentId: folderId,
    mimeType: "application/vnd.helix.document",
    size: "Helix Doc",
    updatedAt: formatTimestamp(document.updatedAt),
    owner: document.ownerActorId ?? "Maya Chen",
    shared: false,
    trashed: document.deletedAt !== null,
    kind: "document",
    previewText: "Drive-backed collaborative document.",
  };
}

function fileFromSearchHit(hit: DriveApiSearchHit): DriveFile {
  const preview = hit.previewMetadata;
  return {
    id: hit.objectId,
    name: hit.name,
    parentId: hit.folderId ?? rootFolderId,
    mimeType: hit.mimeType,
    size: formatBytes(hit.byteSize),
    updatedAt: formatTimestamp(hit.updatedAt),
    owner: "Search result",
    shared: false,
    trashed: false,
    kind: kindFromPreview(preview) ?? kindFromMime(hit.mimeType, hit.name),
    ...(preview === undefined ? {} : { preview }),
    previewText: preview?.text ?? hit.preview,
    previewUrl: preview?.url,
  };
}

function findDriveFile(
  files: readonly DriveFile[],
  fileId: string | undefined,
): DriveFile | undefined {
  return fileId === undefined ? undefined : files.find((file) => file.id === fileId);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function previewTextFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return typeof metadata.previewText === "string" ? metadata.previewText : undefined;
}

function kindFromPreview(preview: DriveApiPreview | undefined): DrivePreviewKind | undefined {
  if (preview === undefined || preview.kind === "unsupported") {
    return undefined;
  }
  return preview.kind;
}

function previewFromMetadata(
  mimeType: string,
  metadata: Record<string, unknown> | undefined,
): DriveApiPreview | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const preview = metadata.preview;
  if (isRecord(preview)) {
    const kind = preview.kind;
    const status = preview.status;
    if (
      (kind === "text" ||
        kind === "image" ||
        kind === "pdf" ||
        kind === "office" ||
        kind === "unsupported") &&
      (status === "available" || status === "unsupported")
    ) {
      return {
        kind,
        status,
        mimeType: typeof preview.mimeType === "string" ? preview.mimeType : mimeType,
        ...(typeof preview.text === "string" ? { text: preview.text } : {}),
        ...(typeof preview.url === "string" ? { url: preview.url } : {}),
        ...(typeof preview.previewUrl === "string" ? { url: preview.previewUrl } : {}),
        ...(typeof preview.pageCount === "number" ? { pageCount: preview.pageCount } : {}),
        ...(typeof preview.width === "number" ? { width: preview.width } : {}),
        ...(typeof preview.height === "number" ? { height: preview.height } : {}),
        ...(typeof preview.blocker === "string" ? { blocker: preview.blocker } : {}),
        ...(typeof preview.generatedAt === "string" ? { generatedAt: preview.generatedAt } : {}),
      };
    }
  }

  if (typeof metadata.previewText === "string" && mimeType.startsWith("text/")) {
    return { kind: "text", status: "available", mimeType, text: metadata.previewText };
  }
  const previewUrl =
    typeof metadata.previewUrl === "string"
      ? metadata.previewUrl
      : typeof metadata.contentUrl === "string"
        ? metadata.contentUrl
        : undefined;
  if (previewUrl !== undefined && mimeType.startsWith("image/")) {
    return { kind: "image", status: "available", mimeType, url: previewUrl };
  }
  if (previewUrl !== undefined && mimeType === "application/pdf") {
    return { kind: "pdf", status: "available", mimeType, url: previewUrl };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function arrayBufferToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function isDriveItem(item: DriveItem | undefined): item is DriveItem {
  return Boolean(item);
}

function isDriveFolder(item: DriveItem): item is DriveFolder {
  return "itemCount" in item;
}
