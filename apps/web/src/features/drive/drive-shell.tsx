import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  createDriveEntry,
  deleteDriveObject,
  moveDriveObject,
  restoreDriveObject,
  setDriveObjectStarred,
  shareDrive,
  trashDriveObject,
  uploadDriveFile,
  type DriveAccessRole,
  type DriveApiEntry,
  type DriveCreateKind,
} from "./api";
import { DriveAccessRequests } from "./drive-access-requests";
import {
  copyDriveObject,
  hideDriveShare,
  moveDriveFolder,
  requestDriveAccess,
} from "./drive-collaboration-api";
import { type DriveItemAction } from "./drive-item-menu";
import {
  fileItemFromEntry,
  folderItemFromEntry,
  type DriveFileItem,
  type DriveFolderItem,
} from "./drive-data";
import { DriveDetailsPanel } from "./drive-details-panel";
import { DriveMoveDialog } from "./drive-move-dialog";
import { DriveShareDialog } from "./drive-share-dialog";
import { DriveMain } from "./drive-file-list";
import "./drive-shell.css";
import { DriveSidebar } from "./drive-sidebar";
import { type DriveCrumb } from "./drive-view-types";
import {
  applyDriveScope,
  driveActorQueryOptions,
  driveItemsQueryOptions,
  driveQueryKeys,
  driveUploadStatusQueryOptions,
  entryFromSearchHit,
  type DriveScope,
} from "./queries";
import { driveShareTargetsFromInput } from "./share-access";
import { openDenialMessage } from "./upload-status-ui";
import { useDocumentSurfaceViewPreference } from "./view-preference";

interface DriveUploadInput {
  readonly file: File;
}

interface DriveUploadOutcome {
  readonly objectId: string;
  readonly fileName: string;
  readonly mimeType: string;
}

interface ProcessingDriveUpload extends DriveUploadOutcome {
  readonly initialState: "uploaded";
}

const DRIVE_CREATE_DEFAULT_NAMES: Record<DriveCreateKind, string> = {
  folder: "New folder",
};

const DRIVE_DEFAULT_LIST_LIMIT = 100;

const DRIVE_SEARCH_LIST_LIMIT = 50;

const DRIVE_MAX_LIST_LIMIT = 250;

const DRIVE_MAX_SEARCH_LIMIT = 100;

function sentinelLimit(displayLimit: number, maxLimit: number): number {
  return displayLimit < maxLimit ? displayLimit + 1 : displayLimit;
}

/** Recent is capped at the search page size; browsing and search each get their own ceiling. */
function maxDriveListLimit(hasQuery: boolean, scope: DriveScope): number {
  if (hasQuery) {
    return DRIVE_MAX_SEARCH_LIMIT;
  }
  if (scope === "recent") {
    return DRIVE_SEARCH_LIST_LIMIT;
  }
  return DRIVE_MAX_LIST_LIMIT;
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
  const [shareOpen, setShareOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
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
  const maxListLimit = maxDriveListLimit(driveQuery.length > 0, scope);
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
  // The scan came back bad — the banner turns red and grows an explanation.
  // Distinct from `uploadStatusQuery.isError`, which only means we could not
  // refresh the status (the upload itself is still fine).
  const uploadScanFailed =
    uploadStatusQuery.data?.state === "quarantined" ||
    uploadStatusQuery.data?.state === "scan_failed";
  const invalidateDrive = () => queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
  const uploadMutation = useMutation({
    mutationFn: async (input: DriveUploadInput): Promise<ProcessingDriveUpload> => {
      const uploaded = await uploadDriveFile({ file: input.file, folderId });
      return {
        objectId: uploaded.objectId,
        fileName: input.file.name,
        mimeType: input.file.type.length > 0 ? input.file.type : "application/octet-stream",
        initialState: "uploaded",
      };
    },
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (result) => {
      setProcessingUpload(result);
      void invalidateDrive();
    },
  });
  useEffect(() => {
    const status = uploadStatusQuery.data;
    if (processingUpload === null || status?.state !== "active") return;
    void invalidateDrive();
    {
      setSelectedFileId(processingUpload.objectId);
      setProcessingUpload(null);
      return;
    }
  }, [processingUpload, uploadStatusQuery.data, navigate]);
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
    },
  });
  const copyMutation = useMutation({
    mutationFn: (objectId: string) => copyDriveObject(objectId),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void invalidateDrive();
    },
  });
  const hideMutation = useMutation({
    mutationFn: (objectId: string) => hideDriveShare(objectId, true),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setSelectedFileId(null);
      void invalidateDrive();
    },
  });
  const requestAccessMutation = useMutation({
    mutationFn: (objectId: string) => requestDriveAccess(objectId),
    onMutate: () => undefined,
    onError: () => undefined,
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
    mutationFn: (vars: {
      readonly objectId: string;
      readonly folderId: string | null;
      readonly isFolder?: boolean;
    }) =>
      vars.isFolder === true
        ? moveDriveFolder(vars.objectId, vars.folderId)
        : moveDriveObject(vars.objectId, vars.folderId),
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
  const createMutation = useMutation({
    mutationFn: (vars: { readonly kind: DriveCreateKind; readonly name: string }) =>
      createDriveEntry({ kind: vars.kind, name: vars.name, folderId }),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void invalidateDrive();
    },
  });
  const onNewItem = (kind: DriveCreateKind) => {
    createMutation.mutate({ kind, name: DRIVE_CREATE_DEFAULT_NAMES[kind] });
  };
  // Live backend entries for the current scope/folder. Search results are
  // already promoted into entry shape inside `driveItemsQueryOptions`.
  const liveEntriesRaw = useMemo<readonly DriveApiEntry[]>(() => {
    const data = itemsQuery.data;
    if (data === undefined) {
      return [];
    }
    if (data.mode === "list") {
      return applyDriveScope(data.entries, scope, actorId, folderId);
    }
    return data.hits.map((hit) => entryFromSearchHit(hit));
  }, [itemsQuery.data, scope, actorId, folderId]);
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
  const onSelectFile = (id: string) => {
    setSelectedFileId(entryById.has(id) ? id : null);
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
      uploadMutation.mutate({
        file: chosen,
      });
    }
    event.target.value = "";
  };
  const isTrashScope = scope === "trash";
  const dialogTarget =
    selectedFile ??
    (selectedEntry !== null ? { id: selectedEntry.id, name: selectedEntry.name } : null);
  const onItemAction = (id: string, action: DriveItemAction) => {
    if (action === "share") {
      setSelectedFileId(id);
      setShareOpen(true);
      return;
    }
    if (action === "copy") {
      copyMutation.mutate(id);
      return;
    }
    if (action === "move") {
      setSelectedFileId(id);
      setMoveOpen(true);
      return;
    }
    if (action === "star") {
      const starred = files.find((file) => file.id === id)?.starred === true;
      starMutation.mutate({ objectId: id, starred: !starred });
      return;
    }
    if (action === "trash") {
      trashMutation.mutate(id);
      return;
    }
    hideMutation.mutate(id);
  };
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={onFileChosen}
      />
      {processingUpload !== null ? (
        <div
          role={uploadScanFailed || uploadStatusQuery.isError ? "alert" : "status"}
          aria-live="polite"
          data-testid="drive-processing-banner"
          data-upload-state={uploadStatusQuery.data?.state ?? processingUpload.initialState}
          className={cn(
            "fixed top-5 right-5 [z-index:9999] max-w-105 [padding:12px_16px] rounded-lg [box-shadow:var(--shadow-lg)]",
            uploadScanFailed
              ? "[border:1px_solid_var(--danger,_#dc2626)]"
              : "[border:1px_solid_var(--border)]",
            uploadScanFailed ? "[background:var(--danger-soft,_#fef2f2)]" : "bg-card",
          )}
        >
          <strong>{processingUpload.fileName}</strong>
          <div className="mt-1 [color:var(--text-2)]">
            {uploadStatusQuery.isError
              ? "Upload stored safely, but its security scan status could not be refreshed."
              : (uploadStatusQuery.data?.label ?? "Queued for security scan")}
          </div>
          {uploadScanFailed ? (
            <div className="mt-1.5 [font-size:var(--text-meta)] [color:var(--danger,_#dc2626)]">
              {openDenialMessage(uploadStatusQuery.data?.state)}
            </div>
          ) : null}
          <button
            type="button"
            className="btn sm mt-2"

            onClick={() => setProcessingUpload(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {itemsQuery.isError && typeof driveSearch.file === "string" ? (
        <div className="fixed bottom-5 right-5 [z-index:40] bg-card [border:1px_solid_var(--border)] rounded-lg p-3 [box-shadow:var(--shadow-lg)]">
          <div className="[font-size:var(--text-body-sm)] font-semibold mb-1">You need access</div>
          <div className="[font-size:var(--text-caption)] text-muted-foreground mb-2">
            Ask the owner to share this file with you.
          </div>
          <button
            type="button"
            className="btn sm primary"
            disabled={requestAccessMutation.isPending}
            onClick={() => requestAccessMutation.mutate(driveSearch.file as string)}
          >
            {requestAccessMutation.isSuccess ? "Request sent" : "Request access"}
          </button>
        </div>
      ) : null}
      <DriveSidebar
        activeScope={scope}
        onScopeChange={onScopeChange}
        onPickFile={onPickFile}
        onNewItem={onNewItem}
        uploading={uploadMutation.isPending}
        creating={createMutation.isPending}
      />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <DriveAccessRequests />
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
            for (const file of droppedFiles) {
              uploadMutation.mutate({ file });
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
          canHideShared={scope === "shared"}
          onItemAction={onItemAction}
        />
      </div>
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
            starMutation.isPending ||
            copyMutation.isPending ||
            hideMutation.isPending
          }
          actionError={
            trashMutation.error ??
            restoreMutation.error ??
            deleteMutation.error ??
            moveMutation.error ??
            starMutation.error ??
            shareMutation.error ??
            copyMutation.error ??
            hideMutation.error ??
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
          onSetStarred={(id, starred) => starMutation.mutate({ objectId: id, starred })}
          onShare={(id, targets, role) =>
            shareMutation.mutate({ objectId: id, role, ...driveShareTargetsFromInput(targets) })
          }
          shareDone={shareMutation.isSuccess}
          onOpenShare={() => setShareOpen(true)}
          onCopy={() => copyMutation.mutate(selectedFile.id)}
          onMove={() => setMoveOpen(true)}
          onHideShared={
            scope === "shared" && selectedEntry?.ownerActorId !== actorId
              ? () => hideMutation.mutate(selectedFile.id)
              : undefined
          }
        />
      ) : null}
      {dialogTarget !== null ? (
        <DriveShareDialog
          objectId={dialogTarget.id}
          objectName={dialogTarget.name}
          ownerActorId={selectedEntry?.ownerActorId ?? null}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : null}
      {dialogTarget !== null ? (
        <DriveMoveDialog
          open={moveOpen}
          fileName={dialogTarget.name}
          onClose={() => setMoveOpen(false)}
          onMove={(folderId) => {
            moveMutation.mutate({
              objectId: dialogTarget.id,
              folderId,
              isFolder: selectedEntry?.type === "folder",
            });
            setMoveOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
