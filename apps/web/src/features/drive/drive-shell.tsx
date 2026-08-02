// ponytail: drive-shell.tsx still >400 LOC (sidebar + grid/list + details panel composition);
// deferred split into features/drive/components/{sidebar,file-grid,details-panel}.tsx.

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
    - `drive.access.*` — details-panel access list and remove access.
   Mutations invalidate the Drive query cache. The typed handoff seed
   (`DRIVE_FOLDERS_SEED` / `DRIVE_FILES_SEED`) is used only as an offline
   fallback when the backend listing yields nothing AND the query errored. */

import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./drive-shell.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";
import { detectFormat } from "@/features/_open/format-detection";
import { setHelixDriveItemDragData } from "./drag-payload";
import { FileNameText } from "./file-name-text";
import { FileThumbnail } from "./file-thumbnail";
import {
  DocumentSurfaceViewToggle,
  useDocumentSurfaceViewPreference,
  type DocumentSurfaceView,
} from "./view-preference";
import {
  canCreateEditableCopyFromFormat,
  editableCopyUnavailableMessage,
} from "@/features/_open/conversion-capabilities";
import { Avatar } from "@/components/ui/avatar";
import {
  createDriveEntry,
  deleteDriveObject,
  driveDownloadResult,
  driveRawDownloadUrl,
  moveDriveObject,
  removeDriveAccess,
  restoreDriveObject,
  setDriveObjectStarred,
  shareDrive,
  trashDriveObject,
  updateDriveAccessRole,
  uploadDriveFile,
  type DriveAccessGrant,
  type DriveAccessRole,
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
  badgeStyleForTone,
  canOpenDriveObject,
  driveUploadStatusView,
  openDenialMessage,
} from "./upload-status-ui";
import {
  applyDriveScope,
  driveAccessQueryOptions,
  driveActorQueryOptions,
  driveItemsQueryOptions,
  driveUploadStatusQueryOptions,
  driveQueryKeys,
  entryFromSearchHit,
  type DriveScope,
} from "./queries";

interface DriveUploadInput {
  readonly file: File;
  readonly openAfterUpload: boolean;
}

interface DriveUploadOutcome {
  readonly objectId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly openAfterUpload: boolean;
}

interface ProcessingDriveUpload extends DriveUploadOutcome {
  readonly initialState: "uploaded";
}

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
const DRIVE_DEFAULT_LIST_LIMIT = 100;
const DRIVE_SEARCH_LIST_LIMIT = 50;
const DRIVE_MAX_LIST_LIMIT = 250;
const DRIVE_MAX_SEARCH_LIMIT = 100;

function sentinelLimit(displayLimit: number, maxLimit: number): number {
  return displayLimit < maxLimit ? displayLimit + 1 : displayLimit;
}

/** A `navigate()` target opening a specific editor item. */
type EditorDestination =
  | {
      readonly to: "/docs/$documentId";
      readonly params: { readonly documentId: string };
    }
  | {
      readonly to: "/sheets";
      readonly search: { readonly sheet: string };
    }
  | {
      readonly to: "/slides";
      readonly search: { readonly deck: string };
    }
  | {
      readonly to: "/pdf/$objectId";
      readonly params: { readonly objectId: string };
    }
  | {
      readonly to: "/media/$objectId";
      readonly params: { readonly objectId: string };
    };

type ImportableSurface = "docs" | "sheets" | "slides";

interface PendingConversion {
  readonly objectId: string;
  readonly fileName: string;
  readonly surface: ImportableSurface;
  readonly canCreateCopy: boolean;
  readonly formatLabel: string;
  readonly unavailableMessage: string;
}

/**
 * Maps a `drive.create` result (`{ id, app }`) to the editor route that opens
 * that item.
 */
function editorDestinationFor(app: string, id: string): EditorDestination | null {
  switch (app) {
    case "docs":
      return { to: "/docs/$documentId", params: { documentId: id } };
    case "sheets":
      return { to: "/sheets", search: { sheet: id } };
    case "slides":
      return { to: "/slides", search: { deck: id } };
    default:
      return null;
  }
}

/**
 * Maps a Drive file (raw upload like .docx / .xlsx / .pptx / .pdf / .md /
 * .csv / .rtf / .eml / .odt / .odp / .ods / …) to the right native editor
 * route, dispatching by the universal format-detection table. Native editors
 * are the only editor surface.
 *
 * Sharing the same detection table as the universal loader means routing
 * stays in lockstep with parser availability — adding a new format only
 * touches `_open/format-detection.ts`.
 */
function editorDestinationForFile(
  fileName: string,
  fileMimeType: string | undefined,
  id: string,
): EditorDestination | null {
  const format = detectFormat(fileName, fileMimeType);
  switch (format.surface) {
    case "docs":
      return { to: "/docs/$documentId", params: { documentId: id } };
    case "sheets":
      return { to: "/sheets", search: { sheet: id } };
    case "slides":
      return { to: "/slides", search: { deck: id } };
    case "pdf":
      return { to: "/pdf/$objectId", params: { objectId: id } };
    case "image":
    case "audio":
    case "video":
    case "ebook":
    case "unknown":
      // Image/audio/video AND any recognized-but-unparseable format (Visio,
      // OneNote, EPUB, .one, .accdb, …) all open in the dedicated
      // `/media/:objectId` viewer. For media surfaces that renders the
      // matching player; for unsupported, the polished "Preview not
      // available — download to open in <recommended app>" card.
      return { to: "/media/$objectId", params: { objectId: id } };
  }
}

function driveFileDragHref(file: DriveFileItem): string {
  const format = detectFormat(file.name, file.mimeType);
  if (file.app === "docs") {
    const suffix = format.surface === "docs" ? "?open=office" : "";
    return `/docs/${encodeURIComponent(file.id)}${suffix}`;
  }
  if (file.app === "sheets") {
    const suffix = format.surface === "sheets" ? "&open=office" : "";
    return `/sheets?sheet=${encodeURIComponent(file.id)}${suffix}`;
  }
  if (file.app === "slides") {
    const suffix = format.surface === "slides" ? "&open=office" : "";
    return `/slides?deck=${encodeURIComponent(file.id)}${suffix}`;
  }
  return `/open/${encodeURIComponent(file.id)}`;
}

function importableSurfaceForFile(
  fileName: string,
  fileMimeType: string | undefined,
): Pick<
  PendingConversion,
  "surface" | "canCreateCopy" | "formatLabel" | "unavailableMessage"
> | null {
  const format = detectFormat(fileName, fileMimeType);
  if (
    format.supported &&
    (format.surface === "docs" || format.surface === "sheets" || format.surface === "slides")
  ) {
    return {
      surface: format.surface,
      canCreateCopy: canCreateEditableCopyFromFormat(format),
      formatLabel: format.label,
      unavailableMessage: editableCopyUnavailableMessage(format),
    };
  }
  return null;
}

function shouldOpenUploadedFile(fileName: string, fileMimeType: string | undefined): boolean {
  return detectFormat(fileName, fileMimeType).surface !== "unknown";
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
  const driveSearch: Partial<{
    folder: string | null;
    scope: DriveScope;
    q: string;
    file: string;
  }> = useSearch({ strict: false });
  const queryClient = useQueryClient();
  const [view, setView] = useDocumentSurfaceViewPreference();
  const [scope, setScope] = useState<DriveScope>(driveSearch.scope ?? "my");
  const [trail, setTrail] = useState<readonly DriveCrumb[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(driveSearch.file ?? null);
  const [processingUpload, setProcessingUpload] = useState<ProcessingDriveUpload | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const folderId =
    trail.length > 0 ? (trail[trail.length - 1]?.id ?? null) : (driveSearch.folder ?? null);

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

  const driveQuery = driveSearch.q?.trim() ?? "";
  const baseListLimit = driveQuery.length > 0 ? DRIVE_SEARCH_LIST_LIMIT : DRIVE_DEFAULT_LIST_LIMIT;
  const maxListLimit =
    driveQuery.length > 0
      ? DRIVE_MAX_SEARCH_LIMIT
      : scope === "recent"
        ? DRIVE_SEARCH_LIST_LIMIT
        : DRIVE_MAX_LIST_LIMIT;
  const [listLimit, setListLimit] = useState(baseListLimit);
  useEffect(() => {
    setListLimit(baseListLimit);
  }, [baseListLimit, folderId, scope]);
  const effectiveListLimit = Math.min(listLimit, maxListLimit);
  const fetchListLimit = sentinelLimit(effectiveListLimit, maxListLimit);
  const itemsQuery = useQuery(
    driveItemsQueryOptions({
      folderId,
      query: driveQuery,
      scope,
      limit: fetchListLimit,
    }),
  );
  const uploadStatusQuery = useQuery(
    driveUploadStatusQueryOptions(processingUpload?.objectId ?? null),
  );

  const invalidateDrive = () => queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
  const invalidateSheets = () => queryClient.invalidateQueries({ queryKey: ["sheets"] });
  const invalidateSlides = () => queryClient.invalidateQueries({ queryKey: ["slides"] });
  const invalidateDocs = () => queryClient.invalidateQueries({ queryKey: ["docs"] });

  const uploadMutation = useMutation({
    mutationFn: async (input: DriveUploadInput): Promise<ProcessingDriveUpload> => {
      const uploaded = await uploadDriveFile({ file: input.file, folderId });
      return {
        objectId: uploaded.objectId,
        fileName: input.file.name,
        mimeType: input.file.type.length > 0 ? input.file.type : "application/octet-stream",
        openAfterUpload: input.openAfterUpload,
        initialState: "uploaded",
      };
    },
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (result) => {
      setProcessingUpload(result);
      void invalidateDrive();
      void invalidateDocs();
      void invalidateSheets();
      void invalidateSlides();
    },
  });

  useEffect(() => {
    const status = uploadStatusQuery.data;
    if (processingUpload === null || status?.state !== "active") return;
    void invalidateDrive();
    if (
      processingUpload.openAfterUpload &&
      shouldOpenUploadedFile(processingUpload.fileName, processingUpload.mimeType)
    ) {
      void navigate({
        to: "/open/$objectId",
        params: { objectId: processingUpload.objectId },
      });
    }
  }, [processingUpload, uploadStatusQuery.data]);

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

  const starMutation = useMutation({
    mutationFn: (vars: { readonly objectId: string; readonly starred: boolean }) =>
      setDriveObjectStarred(vars.objectId, vars.starred),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void invalidateDrive();
      void invalidateDocs();
      void invalidateSheets();
      void invalidateSlides();
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
    mutationFn: (vars: {
      readonly objectId: string;
      readonly actorIds: readonly string[];
      readonly actorRefs: readonly string[];
      readonly role: DriveAccessRole;
    }) =>
      shareDrive({
        objectId: vars.objectId,
        actorIds: vars.actorIds,
        actorRefs: vars.actorRefs,
        role: vars.role,
      }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void invalidateDrive();
    },
  });

  const navigateToEditor = (destination: EditorDestination): void => {
    if (destination.to === "/docs/$documentId") {
      void navigate({ to: destination.to, params: destination.params });
      return;
    }
    if (destination.to === "/pdf/$objectId" || destination.to === "/media/$objectId") {
      void navigate({ to: destination.to, params: destination.params });
      return;
    }
    void navigate({ to: destination.to, search: destination.search });
  };

  const createMutation = useMutation({
    mutationFn: (vars: { readonly kind: DriveCreateKind; readonly name: string }) =>
      createDriveEntry({ kind: vars.kind, name: vars.name, folderId }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (result) => {
      void invalidateDrive();
      // Doc/sheet/deck kinds return `{ id, app }` and open the new item's
      // editor. Folder kinds return a plain drive entry and stay in Drive.
      if (result.app !== undefined) {
        const destination = editorDestinationFor(result.app, result.id);
        if (destination !== null) {
          navigateToEditor(destination);
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
  const liveEntriesRaw = useMemo<readonly DriveApiEntry[]>(() => {
    const data = itemsQuery.data;
    if (data === undefined) {
      return [];
    }
    if (data.mode === "list") {
      return applyDriveScope(data.entries, scope, actorId);
    }
    return data.hits.map((hit) => entryFromSearchHit(hit));
  }, [itemsQuery.data, scope, actorId]);

  const hasMoreEntries =
    liveEntriesRaw.length > effectiveListLimit && effectiveListLimit < maxListLimit;
  const liveEntries = useMemo(
    () => liveEntriesRaw.slice(0, effectiveListLimit),
    [effectiveListLimit, liveEntriesRaw],
  );

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
  const [importing, setImporting] = useState<{ name: string; surface: string } | null>(null);
  const [importError, setImportErrorState] = useState<string | null>(null);
  const [pendingConversion, setPendingConversion] = useState<PendingConversion | null>(null);

  const requestEditableCopy = (entry: DriveApiEntry): boolean => {
    const conversion = importableSurfaceForFile(entry.name, entry.mimeType);
    if (conversion === null) {
      return false;
    }
    setPendingConversion({ objectId: entry.id, fileName: entry.name, ...conversion });
    return true;
  };

  const onOpenFile = (id: string) => {
    const entry = entryById.get(id);
    if (entry === undefined) {
      return;
    }
    // D8: never open/import non-active processing or quarantined objects.
    if (
      !canOpenDriveObject({
        uploadState: entry.uploadState,
        available: entry.available,
      })
    ) {
      setSelectedFileId(id);
      setImportErrorState(openDenialMessage(entry.uploadState));
      return;
    }
    if (CORE_WORKSPACE_STORAGE_ONLY) {
      setSelectedFileId(id);
      return;
    }
    if (entry.app != null) {
      const destination = editorDestinationFor(entry.app, id);
      if (destination !== null) {
        navigateToEditor(destination);
        return;
      }
    }
    if (requestEditableCopy(entry)) {
      return;
    }
    const destination = editorDestinationForFile(entry.name, entry.mimeType, id);
    if (destination !== null) {
      navigateToEditor(destination);
      return;
    }
    setSelectedFileId(id);
  };

  const onSelectFile = (id: string) => {
    const entry = entryById.get(id);
    // Always allow selection so quarantine/processing details are visible.
    // Content open paths are gated in onOpenFile / details panel actions.
    if (
      entry !== undefined &&
      !canOpenDriveObject({
        uploadState: entry.uploadState,
        available: entry.available,
      })
    ) {
      setSelectedFileId(id);
      return;
    }
    if (CORE_WORKSPACE_STORAGE_ONLY) {
      setSelectedFileId(entry === undefined ? null : id);
      return;
    }
    if (entry?.app != null) {
      const destination = editorDestinationFor(entry.app, id);
      if (destination !== null) {
        navigateToEditor(destination);
        return;
      }
    }
    // Raw Drive files (foreign formats: .docx / .xlsx / .pptx / .rtf / etc.)
    // stay user-owned. We ask before creating an editable Helix copy so a
    // click never silently mints a second file.
    if (entry !== undefined) {
      if (requestEditableCopy(entry)) {
        return;
      }
      // Non-editor surfaces (pdf, image, unknown) still go to detail pane.
    }
    setSelectedFileId(id);
  };

  /** Eagerly convert a foreign-format Drive blob to a native helix entity,
   *  then navigate to the new entity's URL. Shows a modal-style "Importing…"
   *  overlay until the conversion completes. */
  async function importAndOpen(
    objectId: string,
    fileName: string,
    surface: "docs" | "sheets" | "slides",
  ) {
    setImporting({ name: fileName, surface });
    setImportErrorState(null);
    try {
      const [{ loadDriveObjectForEditor }, { fetchDriveBlob }, converters] = await Promise.all([
        import("@/features/_open/universal-loader"),
        import("@/features/_open/drive-fetcher"),
        import("@/features/_open/converters"),
      ]);
      const [result, blob] = await Promise.all([
        loadDriveObjectForEditor(objectId, { expectedSurface: surface }),
        fetchDriveBlob(objectId),
      ]);
      if (result.kind !== "imported") {
        throw new Error(
          result.kind === "not-found" ? "File no longer exists in Drive." : "Format not supported.",
        );
      }
      let target;
      if (surface === "docs" && result.parsed.kind === "doc") {
        target = await converters.convertImportedDocToNative(blob, result.parsed, objectId);
      } else if (surface === "sheets" && result.parsed.kind === "sheet") {
        target = await converters.convertImportedSheetToNative(blob, result.parsed, objectId);
      } else if (surface === "slides" && result.parsed.kind === "deck") {
        target = await converters.convertImportedDeckToNative(blob, result.parsed, objectId);
      } else {
        throw new Error(
          `Parse result shape (${result.parsed.kind}) does not match surface (${surface}).`,
        );
      }

      switch (target.surface) {
        case "docs":
          navigateToEditor({ to: "/docs/$documentId", params: { documentId: target.id } });
          break;
        case "sheets":
          navigateToEditor({ to: "/sheets", search: { sheet: target.id } });
          break;
        case "slides":
          navigateToEditor({ to: "/slides", search: { deck: target.id } });
          break;
      }
    } catch (err) {
      if (err instanceof Error && err.name === "ConverterNotAvailableError") {
        setImportErrorState(`${err.message} The file is still downloadable via its details pane.`);
      } else {
        setImportErrorState(
          `Failed to import ${fileName}: ${(err as Error).message ?? String(err)}`,
        );
      }
      setSelectedFileId(objectId);
    } finally {
      setImporting(null);
    }
  }

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
      uploadMutation.mutate({ file: chosen, openAfterUpload: true });
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
      {processingUpload !== null ? (
        <div
          role={
            uploadStatusQuery.data?.state === "quarantined" ||
            uploadStatusQuery.data?.state === "scan_failed" ||
            uploadStatusQuery.isError
              ? "alert"
              : "status"
          }
          aria-live="polite"
          data-testid="drive-processing-banner"
          data-upload-state={uploadStatusQuery.data?.state ?? processingUpload.initialState}
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            zIndex: 9999,
            maxWidth: 420,
            padding: "12px 16px",
            borderRadius: 8,
            border:
              uploadStatusQuery.data?.state === "quarantined" ||
              uploadStatusQuery.data?.state === "scan_failed"
                ? "1px solid var(--danger, #dc2626)"
                : "1px solid var(--border)",
            background:
              uploadStatusQuery.data?.state === "quarantined" ||
              uploadStatusQuery.data?.state === "scan_failed"
                ? "var(--danger-soft, #fef2f2)"
                : "var(--surface)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <strong>{processingUpload.fileName}</strong>
          <div style={{ marginTop: 4, color: "var(--text-2)" }}>
            {uploadStatusQuery.isError
              ? "Upload stored safely, but its security scan status could not be refreshed."
              : (uploadStatusQuery.data?.label ?? "Queued for security scan")}
          </div>
          {uploadStatusQuery.data?.state === "quarantined" ||
          uploadStatusQuery.data?.state === "scan_failed" ? (
            <div
              style={{
                marginTop: 6,
                fontSize: "var(--text-meta)",
                color: "var(--danger, #dc2626)",
              }}
            >
              {openDenialMessage(uploadStatusQuery.data.state)}
            </div>
          ) : null}
          <button
            type="button"
            className="btn sm"
            style={{ marginTop: 8 }}
            onClick={() => setProcessingUpload(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {importing !== null ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "24px 32px",
              boxShadow: "var(--shadow-lg)",
              minWidth: 320,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>📄</div>
            <h2 style={{ margin: "0 0 8px 0", fontSize: "var(--text-h3)", fontWeight: 600 }}>
              Importing into helix-{importing.surface}…
            </h2>
            <p style={{ margin: 0, color: "var(--text-2)", fontSize: "var(--text-body)" }}>
              <code>{importing.name}</code>
            </p>
          </div>
        </div>
      ) : null}
      {importError !== null ? (
        <div
          role="alert"
          style={{
            position: "fixed",
            top: 24,
            right: 24,
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger)",
            padding: "12px 16px",
            borderRadius: 8,
            maxWidth: 400,
            zIndex: 9999,
          }}
        >
          <strong>Import failed</strong>
          <p style={{ margin: "4px 0 0 0", fontSize: "var(--text-caption)" }}>{importError}</p>
        </div>
      ) : null}
      {pendingConversion !== null ? (
        <DriveConversionDialog
          conversion={pendingConversion}
          onCancel={() => setPendingConversion(null)}
          onPreviewOnly={() => {
            setSelectedFileId(pendingConversion.objectId);
            setPendingConversion(null);
          }}
          onCreateCopy={() => {
            const conversion = pendingConversion;
            setPendingConversion(null);
            void importAndOpen(conversion.objectId, conversion.fileName, conversion.surface);
          }}
        />
      ) : null}
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
        onSetStarred={(id, starred) => starMutation.mutate({ objectId: id, starred })}
        onUpload={onPickFile}
        onDropFiles={(droppedFiles) => {
          const openAfterUpload = droppedFiles.length === 1;
          for (const file of droppedFiles) {
            uploadMutation.mutate({ file, openAfterUpload });
          }
        }}
        onNewItem={onNewItem}
        loading={itemsQuery.isLoading}
        error={itemsQuery.isError ? itemsQuery.error : null}
        hasMore={hasMoreEntries}
        onShowMore={() =>
          setListLimit((current) =>
            Math.min(
              current +
                (driveQuery.length > 0 ? DRIVE_SEARCH_LIST_LIMIT : DRIVE_DEFAULT_LIST_LIMIT),
              maxListLimit,
            ),
          )
        }
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
            shareMutation.isPending ||
            starMutation.isPending
          }
          actionError={
            trashMutation.error ??
            restoreMutation.error ??
            deleteMutation.error ??
            moveMutation.error ??
            starMutation.error ??
            shareMutation.error ??
            null
          }
          onClose={() => setSelectedFileId(null)}
          onTrash={(id) => trashMutation.mutate(id)}
          onRestore={(id) => restoreMutation.mutate(id)}
          onDelete={(id) => deleteMutation.mutate(id)}
          onOpen={onOpenFile}
          onMoveToParent={(id) =>
            moveMutation.mutate({
              objectId: id,
              folderId: trail.length > 1 ? (trail[trail.length - 2]?.id ?? null) : null,
            })
          }
          onSetStarred={(id, starred) => starMutation.mutate({ objectId: id, starred })}
          onShare={(id, targets, role) =>
            shareMutation.mutate({ objectId: id, role, ...driveShareTargetsFromInput(targets) })
          }
          shareDone={shareMutation.isSuccess}
        />
      ) : null}
    </>
  );
}

function DriveConversionDialog({
  conversion,
  onCancel,
  onPreviewOnly,
  onCreateCopy,
}: {
  readonly conversion: PendingConversion;
  readonly onCancel: () => void;
  readonly onPreviewOnly: () => void;
  readonly onCreateCopy: () => void;
}) {
  const surfaceLabel =
    conversion.surface === "docs"
      ? "document"
      : conversion.surface === "sheets"
        ? "spreadsheet"
        : "presentation";
  const appLabel =
    conversion.surface === "docs" ? "Docs" : conversion.surface === "sheets" ? "Sheets" : "Slides";

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        background: "rgba(15, 23, 42, 0.34)",
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="drive-conversion-title"
        style={{
          width: "min(460px, 100%)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "var(--shadow-lg)",
          padding: 18,
        }}
      >
        <div className="row gap-3" style={{ alignItems: "flex-start", marginBottom: 14 }}>
          <span
            aria-hidden="true"
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              display: "grid",
              placeItems: "center",
              background: "var(--brand-soft)",
              color: "var(--brand)",
              flexShrink: 0,
            }}
          >
            <Icons.Copy size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h2
              id="drive-conversion-title"
              style={{ margin: 0, fontSize: "var(--text-h3)", fontWeight: 650 }}
            >
              {conversion.canCreateCopy ? "Create editable copy?" : "Preview/download only"}
            </h2>
            <p
              style={{
                margin: "6px 0 0",
                color: "var(--text-2)",
                fontSize: "var(--text-body-sm)",
                lineHeight: 1.5,
              }}
            >
              {conversion.canCreateCopy ? (
                <>
                  Helix can create an editable {appLabel} {surfaceLabel} from{" "}
                  <strong>{conversion.fileName}</strong>. The original file stays unchanged in
                  Drive.
                </>
              ) : (
                <>
                  Helix can preview <strong>{conversion.fileName}</strong>, but{" "}
                  {conversion.unavailableMessage} The original file stays unchanged in Drive.
                </>
              )}
            </p>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            borderTop: "1px solid var(--border)",
            paddingTop: 14,
          }}
        >
          <a
            className="btn sm"
            href={`/api/drive/objects/${conversion.objectId}/content?download=1`}
            download={conversion.fileName}
          >
            Download original
          </a>
          <button type="button" className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn sm" onClick={onPreviewOnly}>
            Preview only
          </button>
          {conversion.canCreateCopy ? (
            <button type="button" className="btn sm primary" onClick={onCreateCopy}>
              <Icons.Copy />
              Create copy
            </button>
          ) : null}
        </div>
      </section>
    </div>
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
              {CORE_WORKSPACE_STORAGE_ONLY ? null : (
                <>
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
                </>
              )}
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
          <DocumentSurfaceViewToggle view={view} onViewChange={onViewChange} />
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
                      <div
                        className="truncate"
                        style={{ fontSize: "var(--text-meta)", fontWeight: 500 }}
                      >
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
                  onSetStarred={(starred) => onSetStarred(file.id, starred)}
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
                  onSetStarred={(starred) => onSetStarred(file.id, starred)}
                />
              ))}
            </div>
          )}
          {hasMore ? (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
              <button type="button" className="btn" onClick={onShowMore}>
                <Icons.ChevronDown />
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
              {CORE_WORKSPACE_STORAGE_ONLY ? null : (
                <>
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
                </>
              )}
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

function DriveUploadStatusBadge({
  file,
}: {
  readonly file: Pick<DriveFileItem, "uploadState" | "uploadStatusLabel" | "available">;
}) {
  const view = driveUploadStatusView(file.uploadState);
  if (view === null || view.available) {
    return null;
  }
  const toneStyle = badgeStyleForTone(view.tone);
  return (
    <span
      data-testid="drive-upload-status-badge"
      data-upload-state={view.state}
      title={file.uploadStatusLabel ?? view.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: "var(--text-chip, 10px)",
        fontWeight: 600,
        letterSpacing: "0.02em",
        textTransform: "uppercase",
        ...toneStyle,
      }}
    >
      {file.uploadStatusLabel ?? view.label}
    </span>
  );
}

function DriveFileCard({
  file,
  selected,
  onSelect,
  onSetStarred,
}: {
  readonly file: DriveFileItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onSetStarred: (starred: boolean) => void;
}) {
  const appMeta = file.app !== null ? (APP_ICON_META[file.app] ?? null) : null;
  const meta = appMeta ?? DRIVE_FILE_META[file.type];
  const openable = canOpenDriveObject({
    uploadState: file.uploadState,
    available: file.available,
  });
  return (
    <div
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
        position: "relative",
        opacity: openable ? 1 : 0.92,
      }}
    >
      <DriveStarToggle
        name={file.name}
        starred={file.starred}
        onSetStarred={onSetStarred}
        style={{ position: "absolute", top: 8, right: 8, zIndex: 1 }}
      />
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
            app: file.app,
          });
        }}
        onClick={onSelect}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          textAlign: "left",
          width: "100%",
          height: "100%",
          font: "inherit",
          color: "inherit",
        }}
      >
        <FileThumbnail
          objectId={file.id}
          name={file.name}
          mimeType={file.mimeType}
          preview={openable ? file.preview : undefined}
          icon={meta.icon}
          color={meta.color}
          aspectRatio="4 / 3"
        />
        <div style={{ padding: 10, width: "100%", boxSizing: "border-box" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 4,
            }}
          >
            <FileNameText
              name={file.name}
              style={{ fontSize: "var(--text-meta)", fontWeight: 500, flex: 1, minWidth: 0 }}
            />
          </div>
          <div style={{ marginBottom: 4 }}>
            <DriveUploadStatusBadge file={file} />
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
    </div>
  );
}

function DriveFileRow({
  file,
  selected,
  onSelect,
  onOpenFolder,
  onSetStarred,
}: {
  readonly file: DriveFileItem;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpenFolder: () => void;
  readonly onSetStarred: (starred: boolean) => void;
}) {
  const appMeta = file.app !== null ? (APP_ICON_META[file.app] ?? null) : null;
  const meta = appMeta ?? DRIVE_FILE_META[file.type];
  const FileIcon = Icons[meta.icon];
  const openable =
    file.type === "folder" ||
    canOpenDriveObject({
      uploadState: file.uploadState,
      available: file.available,
    });
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-disabled={!openable && file.type !== "folder"}
      draggable={openable && file.type !== "folder"}
      onDragStart={(event) => {
        if (!openable || file.type === "folder") {
          event.preventDefault();
          return;
        }
        setHelixDriveItemDragData(event.dataTransfer, {
          id: file.id,
          name: file.name,
          href: driveFileDragHref(file),
          mimeType: file.mimeType,
          app: file.app,
        });
      }}
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
        {file.type !== "folder" ? (
          <DriveStarToggle
            name={file.name}
            starred={file.starred}
            onSetStarred={onSetStarred}
            asButton={false}
          />
        ) : null}
        <span style={{ color: meta.color, display: "inline-flex" }}>
          <FileIcon />
        </span>
        <FileNameText name={file.name} style={{ flex: 1, minWidth: 0 }} />
        <DriveUploadStatusBadge file={file} />
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

function DriveStarToggle({
  name,
  starred,
  onSetStarred,
  style,
  asButton = true,
}: {
  readonly name: string;
  readonly starred: boolean;
  readonly onSetStarred: (starred: boolean) => void;
  readonly style?: CSSProperties;
  readonly asButton?: boolean;
}) {
  const content = <Icons.Star fill={starred ? "currentColor" : "none"} />;
  const commonProps = {
    className: "icon-btn",
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
    style: {
      color: starred ? "var(--warning, #f59e0b)" : "var(--text-3)",
      background: "var(--surface)",
      ...style,
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
  onOpen,
  onMoveToParent,
  onSetStarred,
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
  readonly onOpen: (id: string) => void;
  readonly onMoveToParent: (id: string) => void;
  readonly onSetStarred: (id: string, starred: boolean) => void;
  readonly onShare: (id: string, targets: readonly string[], role: DriveAccessRole) => void;
  readonly shareDone: boolean;
}) {
  const appMeta = file.app !== null ? (APP_ICON_META[file.app] ?? null) : null;
  const meta = appMeta ?? DRIVE_FILE_META[file.type];
  const FileIcon = Icons[meta.icon];
  const [shareInput, setShareInput] = useState("");
  const [shareRole, setShareRole] = useState<DriveAccessRole>("reader");
  const openable = canOpenDriveObject({
    uploadState: file.uploadState ?? entry?.uploadState,
    available: file.available ?? entry?.available,
  });
  const statusView = driveUploadStatusView(file.uploadState ?? entry?.uploadState);

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
      items.unshift({
        who: ownerLabel,
        what: "moved to trash",
        time: formatModified(entry.deletedAt),
      });
    }
    return items;
  }, [entry, ownerLabel, file.owner, file.modified]);

  const download = entry === null ? null : driveDownloadResult(entry);
  const queryClient = useQueryClient();
  const accessQuery = useQuery(driveAccessQueryOptions(file.id, entry !== null && !isTrash));
  const removeAccessMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (actorId: string) => removeDriveAccess(file.id, actorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.access(file.id) });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });
  const updateAccessMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: { readonly actorId: string; readonly role: DriveAccessRole }) =>
      updateDriveAccessRole(file.id, input.actorId, input.role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.access(file.id) });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
    },
  });

  const onShareSubmit = () => {
    const ids = shareInput
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (ids.length > 0) {
      onShare(file.id, ids, shareRole);
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
          <div
            style={{
              fontSize: "var(--text-body)",
              fontWeight: 600,
              marginBottom: 4,
              wordBreak: "break-word",
            }}
          >
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

          {!openable && statusView !== null ? (
            <div
              role="status"
              data-testid="drive-details-unavailable"
              data-upload-state={statusView.state}
              style={{
                fontSize: "var(--text-caption)",
                marginBottom: 10,
                padding: "8px 10px",
                borderRadius: 6,
                ...badgeStyleForTone(statusView.tone),
              }}
            >
              {openDenialMessage(statusView.state)}
            </div>
          ) : null}

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
            <button
              type="button"
              className="btn sm primary"
              disabled={entry === null || !openable}
              title={openable ? "Open file" : openDenialMessage(statusView?.state)}
              onClick={() => onOpen(file.id)}
              style={{ flex: 1, justifyContent: "center" }}
            >
              <Icons.Eye />
              Open
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy || entry === null || isTrash || !openable}
              onClick={() => onSetStarred(file.id, !file.starred)}
              aria-pressed={file.starred}
              style={{ flex: 1, justifyContent: "center" }}
            >
              <Icons.Star fill={file.starred ? "currentColor" : "none"} />
              {file.starred ? "Unstar" : "Star"}
            </button>
            {/* Native editor docs (docs/sheets/slides) carry their content as
                Yjs state inside the typed table, not as a raw blob in RustFS,
                so the "Download" stream returns nothing useful. Hide the
                button for those; the editor surfaces its own export flow. */}
            <a
              className="btn sm"
              href={!openable || entry === null ? undefined : driveRawDownloadUrl(entry)}
              download={openable ? download?.name : undefined}
              aria-disabled={download === null || !openable}
              title={openable ? "Download file" : openDenialMessage(statusView?.state)}
              onClick={(event) => {
                if (!openable || download === null) {
                  event.preventDefault();
                }
              }}
              hidden={entry?.app !== null && entry?.app !== undefined}
              style={{
                flex: 1,
                justifyContent: "center",
                pointerEvents: openable && download !== null ? "auto" : "none",
                opacity: openable && download !== null ? 1 : 0.5,
              }}
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
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "var(--text-meta)",
              marginBottom: 12,
            }}
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
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <input
                  className="input"
                  value={shareInput}
                  onChange={(event) => setShareInput(event.target.value)}
                  placeholder="Email, name, or actor ID"
                  style={{ flex: 1, minWidth: 0, fontSize: "var(--text-meta)" }}
                />
                <select
                  className="input"
                  aria-label="Share role"
                  value={shareRole}
                  onChange={(event) => setShareRole(event.target.value as DriveAccessRole)}
                  style={{ width: 112, fontSize: "var(--text-meta)" }}
                >
                  {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                    <option key={option.role} value={option.role}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
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
                <div
                  style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 6 }}
                >
                  Access granted.
                </div>
              ) : null}
              <AccessList
                grants={accessQuery.data ?? []}
                loading={accessQuery.isLoading}
                currentActorId={currentActorId}
                ownerActorId={entry?.ownerActorId ?? null}
                busy={removeAccessMutation.isPending || updateAccessMutation.isPending}
                onRemove={(actorId) => removeAccessMutation.mutate(actorId)}
                onRoleChange={(actorId, role) => updateAccessMutation.mutate({ actorId, role })}
              />
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

const DRIVE_ACCESS_ROLE_OPTIONS: ReadonlyArray<{
  readonly role: DriveAccessRole;
  readonly label: string;
}> = [
  { role: "reader", label: "Viewer" },
  { role: "commenter", label: "Commenter" },
  { role: "editor", label: "Editor" },
];

function driveAccessRoleValue(role: string): DriveAccessRole {
  return role === "commenter" || role === "editor" ? role : "reader";
}

function driveAccessRoleLabel(role: string): string {
  return DRIVE_ACCESS_ROLE_OPTIONS.find((option) => option.role === role)?.label ?? role;
}

function AccessList({
  grants,
  loading,
  currentActorId,
  ownerActorId,
  busy,
  onRemove,
  onRoleChange,
}: {
  readonly grants: readonly DriveAccessGrant[];
  readonly loading: boolean;
  readonly currentActorId: string | null;
  readonly ownerActorId: string | null;
  readonly busy: boolean;
  readonly onRemove: (actorId: string) => void;
  readonly onRoleChange: (actorId: string, role: DriveAccessRole) => void;
}) {
  const canManageAll = currentActorId !== null && ownerActorId === currentActorId;
  if (loading) {
    return (
      <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)", marginTop: 8 }}>
        Loading access...
      </div>
    );
  }
  if (grants.length === 0) {
    return null;
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div className="section-label" style={{ padding: "4px 0 6px" }}>
        People with access
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {grants.map((grant) => {
          const label = grant.displayName ?? grant.email ?? grant.actorId;
          const canRemove =
            canManageAll || (currentActorId !== null && grant.actorId === currentActorId);
          return (
            <div
              key={grant.actorId}
              className="row gap-2"
              style={{
                minWidth: 0,
                fontSize: "var(--text-caption)",
                padding: "4px 0",
              }}
            >
              <Avatar name={label} size={18} />
              <span className="truncate" style={{ minWidth: 0 }}>
                {label}
              </span>
              {canManageAll ? (
                <select
                  className="input"
                  aria-label={`Access role for ${label}`}
                  value={driveAccessRoleValue(grant.role)}
                  disabled={busy}
                  onChange={(event) =>
                    onRoleChange(grant.actorId, event.target.value as DriveAccessRole)
                  }
                  style={{ width: 112, height: 28, fontSize: "var(--text-caption)" }}
                >
                  {DRIVE_ACCESS_ROLE_OPTIONS.map((option) => (
                    <option key={option.role} value={option.role}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ color: "var(--text-3)" }}>{driveAccessRoleLabel(grant.role)}</span>
              )}
              {canRemove ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove access for ${label}`}
                  disabled={busy}
                  onClick={() => onRemove(grant.actorId)}
                >
                  <Icons.X />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function driveShareTargetsFromInput(targets: readonly string[]): {
  readonly actorIds: readonly string[];
  readonly actorRefs: readonly string[];
} {
  const actorIds: string[] = [];
  const actorRefs: string[] = [];
  for (const target of targets) {
    if (UUID_PATTERN.test(target)) {
      actorIds.push(target);
    } else {
      actorRefs.push(target);
    }
  }
  return { actorIds, actorRefs };
}
