/* The Drive surface body (rendered inside SurfaceFrame): sidebar, location
   breadcrumb, filter/selection toolbar, item lists, details panel, dialogs,
   keyboard shortcuts and the upload panel. Drive stores, shares and
   downloads files; it never previews, edits or converts them. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronDown as MoreIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Dialog } from "@/components/ui/helix-dialog";
import { notify } from "@/components/ui/toast";
import { useShortcuts } from "@/lib/shortcuts/use-shortcuts";
import { driveItemUrl, driveRawDownloadUrl } from "./api";
import { DriveAccessNeeded } from "./drive-access-needed";
import { DriveAccessRequests } from "./drive-access-requests";
import { DriveBreadcrumb, type DriveTrailCrumb } from "./drive-breadcrumb";
import {
  canDeleteForever,
  driveItemFromEntry,
  trashRetentionDays,
  type DriveItem,
} from "./drive-data";
import { DriveDetailsPanel } from "./drive-details-panel";
import { DriveConfirmDialog, DriveNameDialog } from "./drive-dialogs";
import { driveItemActions, type DriveActionId } from "./drive-item-actions";
import { DriveItemsArea, openRowContextMenu } from "./drive-items-area";
import { DriveMoveDialog } from "./drive-move-dialog";
import { DriveNewFab, type DriveNewActions } from "./drive-new-menu";
import { useDriveOpenedAt } from "./drive-opened";
import { DriveShareDialog } from "./drive-share-dialog";
import "./drive-shell.css";
import { DriveSidebar } from "./drive-sidebar";
import {
  DEFAULT_DRIVE_SORT,
  filterDriveItems,
  hasDriveFilters,
  NO_DRIVE_FILTERS,
  sortDriveItems,
  type DriveFilters,
  type DriveSort,
} from "./drive-sort-filter";
import { DriveFilterBar, DriveSelectionBar } from "./drive-toolbar";
import { DriveUploadPanel } from "./drive-upload-panel";
import { SCOPE_TITLE } from "./drive-view-types";
import { DriveWorkflows } from "./drive-workflows";
import {
  applyDriveScope,
  driveAccessQueryOptions,
  driveActorQueryOptions,
  driveFetchLimit,
  driveItemsQueryOptions,
  driveListLimits,
  driveQueryKeys,
  entryFromSearchHit,
  type DriveScope,
} from "./queries";
import { openDenialMessage } from "./upload-status-ui";
import { useDriveActions } from "./use-drive-actions";
import { useDriveUploads } from "./use-drive-uploads";
import { useDocumentSurfaceViewPreference } from "./view-preference";

type Confirmation =
  | { readonly kind: "delete"; readonly items: readonly DriveItem[] }
  | { readonly kind: "empty"; readonly items: readonly DriveItem[] };

/** The server refused the item, or says there is none: either way, not this person's to open. */
function isAccessError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  return status === 403 || status === 404;
}

function downloadFile(item: DriveItem) {
  const link = document.createElement("a");
  link.href = driveRawDownloadUrl(item);
  link.download = item.name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

export function DriveShell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search: Partial<{ folder: string; scope: DriveScope; q: string; file: string }> = useSearch(
    { strict: false },
  );
  const scope: DriveScope = search.scope ?? "my";
  const query = search.q?.trim() ?? "";
  const searching = query.length > 0;
  const [view, setView] = useDocumentSurfaceViewPreference();
  const actor = useQuery(driveActorQueryOptions());
  const actorId = actor.data?.actorId ?? null;
  const [openedAt, recordOpened] = useDriveOpenedAt(actorId);
  const actions = useDriveActions();
  const uploads = useDriveUploads();

  const [trail, setTrail] = useState<readonly DriveTrailCrumb[]>([]);
  const urlFolder = search.folder ?? null;
  useEffect(() => {
    setTrail((current) => {
      if ((current.at(-1)?.id ?? null) === urlFolder) return current;
      if (urlFolder === null) return [];
      const index = current.findIndex((crumb) => crumb.id === urlFolder);
      return index >= 0 ? current.slice(0, index + 1) : [{ id: urlFolder, name: "Folder" }];
    });
  }, [urlFolder]);
  const folderId = trail.at(-1)?.id ?? urlFolder;

  const [sort, setSort] = useState<DriveSort>(DEFAULT_DRIVE_SORT);
  const [filters, setFilters] = useState<DriveFilters>(NO_DRIVE_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(search.file !== undefined);
  const [shareTarget, setShareTarget] = useState<DriveItem | null>(null);
  const [renameTarget, setRenameTarget] = useState<DriveItem | null>(null);
  const [moveTargets, setMoveTargets] = useState<readonly DriveItem[] | null>(null);
  const [workflowTarget, setWorkflowTarget] = useState<DriveItem | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const { base: baseLimit, max: maxLimit } = driveListLimits(scope, searching);
  const [listLimit, setListLimit] = useState(baseLimit);
  useEffect(() => {
    setListLimit(baseLimit);
    setSelected(new Set());
    setFilters(NO_DRIVE_FILTERS);
  }, [baseLimit, folderId, scope]);
  const limit = Math.min(listLimit, maxLimit);
  const itemsQuery = useQuery(
    driveItemsQueryOptions({
      folderId,
      query,
      scope,
      limit: driveFetchLimit(limit, maxLimit),
    }),
  );

  const allItems = useMemo<readonly DriveItem[]>(() => {
    const data = itemsQuery.data;
    if (data === undefined) return [];
    const entries =
      data.mode === "list"
        ? applyDriveScope(data.entries, scope, actorId, folderId)
        : data.hits.map(entryFromSearchHit);
    return entries.map(driveItemFromEntry);
  }, [itemsQuery.data, scope, actorId, folderId]);
  const hasMore = allItems.length > limit && limit < maxLimit;
  const sortable = !searching && scope !== "home" && scope !== "recent";
  const items = useMemo(() => {
    const filtered = filterDriveItems(allItems.slice(0, limit), filters, { actorId });
    return sortable
      ? sortDriveItems(filtered, sort, { actorId, openedAt })
      : [...filtered].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1));
  }, [allItems, limit, filters, actorId, sortable, sort, openedAt]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );
  // A `?file=` deep link selects that file once it has loaded.
  const linkedFileRef = useRef<string | null>(null);
  useEffect(() => {
    const file = search.file;
    if (file === undefined || linkedFileRef.current === file) return;
    if (!allItems.some((item) => item.id === file)) return;
    linkedFileRef.current = file;
    setSelected(new Set([file]));
    setActiveKey(file);
  }, [search.file, allItems]);

  const isTrash = scope === "trash";
  // At the top of Shared with me every item belongs to someone else.
  const actionContext = {
    trash: isTrash,
    shared: scope === "shared" && folderId === null && !searching,
  };
  // A link to something this person cannot open: offer to ask its owner.
  const linkedFile = search.file;
  const linkedFileMissing =
    linkedFile !== undefined &&
    itemsQuery.isSuccess &&
    !allItems.some((item) => item.id === linkedFile);
  const linkedFileAccess = useQuery({
    ...driveAccessQueryOptions(linkedFile ?? "", linkedFileMissing),
    // A refusal is the answer here, not something to try again.
    retry: false,
  });
  const accessNeeded: { readonly id: string; readonly kind: "file" | "folder" } | null =
    urlFolder !== null && isAccessError(itemsQuery.error)
      ? { id: urlFolder, kind: "folder" }
      : linkedFile !== undefined && linkedFileMissing && isAccessError(linkedFileAccess.error)
        ? { id: linkedFile, kind: "file" }
        : null;
  const canCreate = !searching && !isTrash && (scope === "my" || folderId !== null);
  const createTarget = canCreate ? folderId : null;
  const rootCrumb: DriveTrailCrumb = {
    id: null,
    name: searching ? "Search results" : SCOPE_TITLE[scope],
  };
  const crumbs = searching ? [rootCrumb] : [rootCrumb, ...trail];
  const locationName = crumbs.at(-1)?.name ?? SCOPE_TITLE[scope];

  const itemLocation = (item: DriveItem) => {
    if (item.folderId === folderId && !searching) return locationName;
    if (item.folderId === null) {
      return actorId !== null && item.ownerActorId !== actorId ? "Shared with me" : "My Drive";
    }
    return trail.find((crumb) => crumb.id === item.folderId)?.name ?? "A folder in Drive";
  };

  /** Folder moves keep the scope and drop any search or linked file, like Drive. */
  const pushFolder = (folder: string | null) => {
    void navigate({
      to: "/drive",
      search: (prev) => ({
        ...(prev as Record<string, unknown>),
        folder: folder ?? undefined,
        file: undefined,
        q: undefined,
      }),
    });
  };

  const openFolder = (folder: DriveItem) => {
    recordOpened(folder.id);
    const crumb = { id: folder.id, name: folder.name, item: folder };
    setTrail((current) => (searching ? [crumb] : [...current, crumb]));
    pushFolder(folder.id);
  };
  const navigateToCrumb = (index: number) => {
    const next = trail.slice(0, index);
    setTrail(next);
    pushFolder(next.at(-1)?.id ?? null);
  };
  const onScopeChange = (next: DriveScope) => {
    setTrail([]);
    void navigate({ to: "/drive", search: { scope: next } });
  };

  const download = (targets: readonly DriveItem[]) => {
    for (const item of targets) {
      if (item.kind !== "file") continue;
      if (!item.available) {
        notify({ message: openDenialMessage(item.uploadState), tone: "error" });
        continue;
      }
      recordOpened(item.id);
      downloadFile(item);
    }
  };

  const openItem = (item: DriveItem) => {
    if (isTrash) {
      setDetailsOpen(true);
      return;
    }
    if (item.kind === "folder") openFolder(item);
    else download([item]);
  };

  const runAction = (targets: readonly DriveItem[], id: DriveActionId) => {
    const first = targets[0];
    if (first === undefined) return;
    switch (id) {
      case "open":
        openItem(first);
        return;
      case "download":
        download(targets);
        return;
      case "share":
        setShareTarget(first);
        return;
      case "copy-link":
        navigator.clipboard.writeText(driveItemUrl(first)).then(
          () => notify({ message: "Link copied" }),
          () => notify({ message: "Couldn’t copy the link", tone: "error" }),
        );
        return;
      case "rename":
        setRenameTarget(first);
        return;
      case "copy":
        void actions.copy(targets);
        return;
      case "move":
        setMoveTargets(targets);
        return;
      case "star":
      case "unstar":
        void actions.setStarred(targets, id === "star");
        return;
      case "details":
        recordOpened(first.id);
        setSelected(new Set([first.id]));
        setDetailsOpen(true);
        return;
      case "workflows":
        setWorkflowTarget(first);
        return;
      case "remove-shared":
        setSelected(new Set());
        void actions.removeFromShared(targets);
        return;
      case "trash":
        setSelected(new Set());
        void actions.trash(targets);
        return;
      case "restore":
        setSelected(new Set());
        void actions.restore(targets);
        return;
      case "delete-forever":
        setConfirmation({ kind: "delete", items: targets });
        return;
    }
  };

  const newActions: DriveNewActions = {
    onNewFolder: () => setNewFolderOpen(true),
    onFileUpload: () => fileInputRef.current?.click(),
    onFolderUpload: () => folderInputRef.current?.click(),
  };
  const onFilesChosen = (event: ChangeEvent<HTMLInputElement>, folderUpload: boolean) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (chosen.length === 0) return;
    if (folderUpload) void uploads.uploadFolder(chosen, createTarget);
    else uploads.uploadFiles(chosen, createTarget);
  };
  const moveInto = (target: { id: string | null; name: string }, ids: readonly string[]) => {
    const moving = allItems.filter((item) => ids.includes(item.id));
    setSelected(new Set());
    void actions.move(moving, target);
  };

  const single = selectedItems.length === 1 ? selectedItems[0] : undefined;
  const activeItem = items.find((item) => item.id === activeKey);
  const focusTarget = single ?? activeItem;
  const selectionActions = driveItemActions(selectedItems, actionContext);
  useShortcuts("drive", {
    "drive.new-folder": canCreate ? newActions.onNewFolder : undefined,
    "drive.upload": canCreate ? newActions.onFileUpload : undefined,
    "drive.upload-folder": canCreate ? newActions.onFolderUpload : undefined,
    "drive.open": focusTarget === undefined ? undefined : () => openItem(focusTarget),
    "drive.context-menu":
      focusTarget === undefined
        ? undefined
        : () => {
            const row = document.querySelector<HTMLElement>(
              `[role="row"][data-key="${CSS.escape(focusTarget.id)}"]`,
            );
            if (row === null) return false;
            row.focus();
            openRowContextMenu(row);
          },
    "drive.details": () => setDetailsOpen((open) => !open),
    "drive.star":
      selectedItems.length === 0 || isTrash
        ? undefined
        : () =>
            runAction(
              selectedItems,
              selectedItems.every((item) => item.starred) ? "unstar" : "star",
            ),
    "drive.rename": single === undefined || isTrash ? undefined : () => setRenameTarget(single),
    "drive.trash":
      selectedItems.length === 0 || isTrash ? undefined : () => runAction(selectedItems, "trash"),
  });

  const ownerLabel = (item: DriveItem) =>
    actorId !== null && item.ownerActorId === actorId ? "me" : item.owner;
  const retentionDays = isTrash ? trashRetentionDays(allItems) : null;
  const deletable = allItems.filter((item) => canDeleteForever(item));

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="drive-file-input"
        onChange={(event) => onFilesChosen(event, false)}
      />
      <input
        ref={(node) => {
          folderInputRef.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        data-testid="drive-folder-input"
        onChange={(event) => onFilesChosen(event, true)}
      />
      <DriveSidebar
        activeScope={scope}
        onScopeChange={onScopeChange}
        onMoveToRoot={(ids) => moveInto({ id: null, name: "My Drive" }, ids)}
        newActions={newActions}
      />
      <div className="drive-main">
        <div className="drive-header">
          <DriveBreadcrumb
            trail={crumbs}
            canCreate={canCreate}
            newActions={newActions}
            onNavigate={navigateToCrumb}
            onDropItems={(target, ids) =>
              moveInto({ id: target.id, name: target.id === null ? "My Drive" : target.name }, ids)
            }
            onFolderAction={(folder, id) => runAction([folder], id)}
          />
          {selectedItems.length > 0 ? (
            <DriveSelectionBar
              count={selectedItems.length}
              actions={selectionActions}
              onAction={(id) => runAction(selectedItems, id)}
              onClear={() => setSelected(new Set())}
            />
          ) : (
            <DriveFilterBar
              items={allItems}
              actorId={actorId}
              filters={filters}
              onFiltersChange={setFilters}
              sort={sort}
              onSortChange={setSort}
              sortable={sortable}
              view={view}
              onViewChange={setView}
              detailsOpen={detailsOpen}
              onToggleDetails={() => setDetailsOpen((open) => !open)}
            />
          )}
          {isTrash && allItems.length > 0 ? (
            <div className="drive-trash-banner" role="note">
              <span className="flex-1">
                {retentionDays === null
                  ? "Items in trash are deleted forever when their recovery period ends."
                  : `Items in trash are deleted forever after ${String(retentionDays)} days.`}
              </span>
              <button
                type="button"
                className="btn sm ghost"
                disabled={deletable.length === 0}
                title={
                  deletable.length === 0
                    ? "Items can be deleted forever once their recovery period ends."
                    : undefined
                }
                onClick={() => setConfirmation({ kind: "empty", items: deletable })}
              >
                Empty trash
              </button>
            </div>
          ) : null}
        </div>
        <div className="drive-content">
          {isTrash ? null : <DriveAccessRequests />}
          {accessNeeded === null ? (
            <DriveItemsArea
              scope={scope}
              view={view}
              items={items}
              loading={itemsQuery.isLoading}
              error={itemsQuery.isError ? itemsQuery.error : null}
              retrying={itemsQuery.isFetching}
              onRetry={() => void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all })}
              filtered={hasDriveFilters(filters)}
              onClearFilters={() => setFilters(NO_DRIVE_FILTERS)}
              searching={searching}
              selectedKeys={selected}
              onSelectedKeysChange={setSelected}
              activeKey={activeKey}
              onActiveKeyChange={setActiveKey}
              onOpen={openItem}
              handlers={{
                ownerLabel,
                actionsFor: (item) =>
                  driveItemActions(selected.has(item.id) ? selectedItems : [item], actionContext),
                onAction: (item, id) =>
                  runAction(selected.has(item.id) ? selectedItems : [item], id),
                onToggleStar: (item) => void actions.setStarred([item], !item.starred),
                dragIds: (item) =>
                  selected.has(item.id) ? selectedItems.map((entry) => entry.id) : [item.id],
                onDropInto: (folder, ids) => moveInto({ id: folder.id, name: folder.name }, ids),
                trash: isTrash,
              }}
              actionsFor={(targets) => driveItemActions(targets, actionContext)}
              onTargetsAction={runAction}
              canCreate={canCreate}
              newActions={newActions}
              onEmptyTrash={() => setConfirmation({ kind: "empty", items: deletable })}
              onDropFiles={(files) => uploads.uploadFiles(files, createTarget)}
              dropLabel={locationName}
            />
          ) : (
            <DriveAccessNeeded
              key={accessNeeded.id}
              itemId={accessNeeded.id}
              kind={accessNeeded.kind}
            />
          )}
          {hasMore ? (
            <div className="flex justify-center py-4">
              <button
                type="button"
                className="btn"
                onClick={() => setListLimit((current) => Math.min(current + baseLimit, maxLimit))}
              >
                <MoreIcon size={16} aria-hidden="true" />
                Show more
              </button>
            </div>
          ) : null}
        </div>
        <div className="drive-fab-slot">
          <DriveNewFab {...newActions} />
        </div>
      </div>
      {detailsOpen ? (
        <DriveDetailsPanel
          key={single?.id ?? "none"}
          item={single ?? null}
          ownerLabel={single === undefined ? "" : ownerLabel(single)}
          location={single === undefined ? locationName : itemLocation(single)}
          isTrash={isTrash}
          busy={actions.busy}
          currentActorId={actorId}
          onClose={() => setDetailsOpen(false)}
          onManageAccess={() => {
            if (single !== undefined) setShareTarget(single);
          }}
        />
      ) : null}

      {shareTarget === null ? null : (
        <DriveShareDialog
          target={{
            id: shareTarget.id,
            kind: shareTarget.kind,
            name: shareTarget.name,
            ownerActorId: shareTarget.ownerActorId,
            ownerName:
              actorId !== null && shareTarget.ownerActorId === actorId
                ? (actor.data?.name ?? "You")
                : shareTarget.owner,
          }}
          onClose={() => setShareTarget(null)}
        />
      )}
      {renameTarget === null ? null : (
        <DriveNameDialog
          title="Rename"
          label="New name"
          initialName={renameTarget.name}
          submitLabel="OK"
          onClose={() => setRenameTarget(null)}
          onSubmit={(name) => actions.rename(renameTarget, name)}
        />
      )}
      {newFolderOpen ? (
        <DriveNameDialog
          title="New folder"
          label="Folder name"
          initialName="Untitled folder"
          submitLabel="Create"
          onClose={() => setNewFolderOpen(false)}
          onSubmit={async (name) => (await actions.createFolder(name, createTarget)) !== null}
        />
      ) : null}
      {moveTargets === null ? null : (
        <DriveMoveDialog
          items={moveTargets}
          onClose={() => setMoveTargets(null)}
          onMove={(target) => {
            const targets = moveTargets;
            setMoveTargets(null);
            setSelected(new Set());
            void actions.move(targets, target);
          }}
        />
      )}
      {workflowTarget === null ? null : (
        <Dialog
          title={<h2 className="type-h3 m-0 truncate">Requests and approvals</h2>}
          onClose={() => setWorkflowTarget(null)}
          width="min(520px, calc(100vw - 32px))"
        >
          <DriveWorkflows
            resourceId={workflowTarget.id}
            resourceType={workflowTarget.kind === "folder" ? "folder" : "object"}
          />
        </Dialog>
      )}
      <DriveConfirmDialog
        open={confirmation !== null}
        title={confirmation?.kind === "empty" ? "Empty trash?" : "Delete forever?"}
        description={
          confirmation?.kind === "empty"
            ? `${String(confirmation.items.length)} item${confirmation.items.length === 1 ? "" : "s"} will be deleted forever. Items still in their recovery period stay in trash. You can’t undo this.`
            : `${confirmation?.items.length === 1 ? `“${confirmation.items[0]?.name ?? ""}”` : `${String(confirmation?.items.length ?? 0)} items`} will be deleted forever. You can’t undo this.`
        }
        confirmLabel={confirmation?.kind === "empty" ? "Empty trash" : "Delete forever"}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        onConfirm={() => {
          const items = confirmation?.items ?? [];
          setConfirmation(null);
          setSelected(new Set());
          void actions.deleteForever(items);
        }}
      />
      <DriveUploadPanel
        tasks={uploads.tasks}
        onCancel={uploads.cancel}
        onRetry={uploads.retry}
        onClose={uploads.clear}
      />
    </>
  );
}
