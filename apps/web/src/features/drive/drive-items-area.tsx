/* The Drive item lists: list or grid layout, the right-click menu, loading,
   empty and error states, and the drop zone for uploads from the desktop. */
import {
  CheckCheck as SelectAllIcon,
  FileUp as FileUploadIcon,
  FolderPlus as NewFolderIcon,
  FolderUp as FolderUploadIcon,
  HardDrive as DriveIcon,
  SearchX as NoMatchIcon,
  Trash2 as TrashIcon,
  Upload as UploadIcon,
} from "lucide-react";
import {
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  isContextMenuKey,
} from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SelectableList, SelectAllCheckbox } from "@/components/ui/selectable-list";
import { Skeleton } from "@/components/ui/skeleton";
import { isOsFileDrag } from "./drag-payload";
import type { DriveItem } from "./drive-data";
import { DriveContextMenuItems, type DriveAction, type DriveActionId } from "./drive-item-actions";
import {
  DriveFileCard,
  DriveFolderTile,
  DriveListRowContent,
  type DriveItemViewHandlers,
} from "./drive-item-views";
import type { DriveNewActions } from "./drive-new-menu";
import type { DriveScope } from "./queries";
import type { DocumentSurfaceView } from "./view-preference";

const EMPTY_COPY: Record<DriveScope, { readonly title: string; readonly body: string }> = {
  home: { title: "Welcome to Drive", body: "Files and folders you work on will show up here." },
  my: { title: "Drop files here", body: "Or use the New button to upload files and folders." },
  shared: {
    title: "Nothing shared with you yet",
    body: "Files and folders others share with you appear here.",
  },
  recent: { title: "No recent files", body: "Files you add or change show up here." },
  starred: {
    title: "No starred files",
    body: "Add stars to files you want to find quickly later.",
  },
  recordings: {
    title: "No meeting recordings",
    body: "Recordings from your meetings are saved here.",
  },
  trash: {
    title: "Trash is empty",
    body: "Items moved to trash are deleted forever when their recovery period ends.",
  },
};

export interface DriveItemsAreaProps {
  readonly scope: DriveScope;
  readonly view: DocumentSurfaceView;
  readonly items: readonly DriveItem[];
  readonly loading: boolean;
  readonly error: Error | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  readonly searching: boolean;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectedKeysChange: (keys: Set<string>) => void;
  readonly activeKey: string | null;
  readonly onActiveKeyChange: (key: string) => void;
  readonly onOpen: (item: DriveItem) => void;
  readonly handlers: DriveItemViewHandlers;
  /** Actions for the right-clicked items. */
  readonly actionsFor: (targets: readonly DriveItem[]) => readonly DriveAction[];
  readonly onTargetsAction: (targets: readonly DriveItem[], id: DriveActionId) => void;
  readonly canCreate: boolean;
  readonly newActions: DriveNewActions;
  readonly onEmptyTrash: () => void;
  readonly onDropFiles: (files: readonly File[]) => void;
  readonly dropLabel: string;
}

const COARSE_POINTER = "(pointer: coarse)";

function subscribePointer(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(COARSE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Touch screens open items on tap (long-press selects via the menu); mice click to select. */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribePointer,
    () => typeof window.matchMedia === "function" && window.matchMedia(COARSE_POINTER).matches,
    () => false,
  );
}

/** Open the list's context menu for `row`, anchored at the row's lower left. */
export function openRowContextMenu(row: HTMLElement): void {
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new globalThis.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 24,
      clientY: rect.bottom,
    }),
  );
}

const LAYOUT_CLASS = {
  list: "drive-items",
  folders:
    "drive-items grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] max-[700px]:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] max-[700px]:gap-2",
  cards:
    "drive-items grid gap-3 grid-cols-[repeat(auto-fill,minmax(200px,1fr))] max-[700px]:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] max-[700px]:gap-2",
} as const;

const ROW_CLASS = {
  list: "drive-item-row drive-item-row-list",
  folders: "drive-item-row drive-item-row-folders rounded-[var(--radius-lg)]",
  cards: "drive-item-row drive-item-row-cards items-stretch rounded-[var(--radius-lg)]",
} as const;

function sectionTitles(scope: DriveScope, searching: boolean) {
  if (searching) return { folders: "Folders", files: "Search results" };
  if (scope === "home") return { folders: "Suggested folders", files: "Suggested files" };
  return { folders: "Folders", files: "Files" };
}

export function DriveItemsArea(props: DriveItemsAreaProps) {
  const {
    scope,
    view,
    items,
    selectedKeys,
    onSelectedKeysChange,
    handlers,
    canCreate,
    newActions,
  } = props;
  const coarsePointer = useCoarsePointer();
  const [menuTargets, setMenuTargets] = useState<readonly DriveItem[]>([]);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const byId = new Map(items.map((item) => [item.id, item]));
  const folders = items.filter((item) => item.kind === "folder");
  const files = items.filter((item) => item.kind === "file");
  const titles = sectionTitles(scope, props.searching);

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const row = event.target instanceof Element ? event.target.closest("[data-key]") : null;
    const key = row?.getAttribute("data-key") ?? null;
    const item = key === null ? undefined : byId.get(key);
    if (item === undefined) {
      setMenuTargets([]);
      return;
    }
    if (selectedKeys.has(item.id)) {
      setMenuTargets(items.filter((candidate) => selectedKeys.has(candidate.id)));
      return;
    }
    onSelectedKeysChange(new Set([item.id]));
    props.onActiveKeyChange(item.id);
    setMenuTargets([item]);
  };

  /** Shift+F10 / Menu on a focused row opens the menu at that row. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isContextMenuKey(event)) return;
    const row = event.target instanceof HTMLElement ? event.target.closest("[data-key]") : null;
    if (!(row instanceof HTMLElement)) return;
    event.preventDefault();
    openRowContextMenu(row);
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer) || !canCreate) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer) || !canCreate) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropping(false);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer) || !canCreate) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer) || !canCreate) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDropping(false);
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) props.onDropFiles(dropped);
  };

  const list = (
    entries: readonly DriveItem[],
    label: string,
    layout: "list" | "folders" | "cards",
  ) => (
    <SelectableList
      items={entries}
      getKey={(item) => item.id}
      getItemLabel={(item) => item.name}
      label={label}
      selectedKeys={selectedKeys}
      onSelectedKeysChange={onSelectedKeysChange}
      selectOnClick={!coarsePointer}
      onOpen={props.onOpen}
      onSelectAll={() => onSelectedKeysChange(new Set(items.map((item) => item.id)))}
      activeKey={props.activeKey}
      onActiveKeyChange={props.onActiveKeyChange}
      className={LAYOUT_CLASS[layout]}
      rowClassName={() => ROW_CLASS[layout]}
      renderItem={(item, state) =>
        layout === "list" ? (
          <DriveListRowContent item={item} state={state} handlers={handlers} />
        ) : layout === "folders" ? (
          <DriveFolderTile item={item} state={state} handlers={handlers} />
        ) : (
          <DriveFileCard item={item} state={state} handlers={handlers} />
        )
      }
    />
  );

  const body = (() => {
    if (props.error !== null) {
      return (
        <InlineError
          title="Couldn’t load Drive"
          message={props.error.message}
          onRetry={props.onRetry}
          retrying={props.retrying}
        />
      );
    }
    if (props.loading) {
      return (
        <Skeleton
          variant={view === "grid" ? "card" : "row"}
          count={view === "grid" ? 6 : 8}
          label="Loading files"
        />
      );
    }
    if (items.length === 0) {
      if (props.filtered || props.searching) {
        return (
          <EmptyState
            icon={<NoMatchIcon size={40} />}
            title="No items match"
            body={props.searching ? "Try different words." : "Try other filters, or clear them."}
            action={
              props.filtered ? (
                <button type="button" className="btn" onClick={props.onClearFilters}>
                  Clear filters
                </button>
              ) : undefined
            }
          />
        );
      }
      const copy = EMPTY_COPY[scope];
      return (
        <EmptyState
          icon={scope === "trash" ? <TrashIcon size={40} /> : <DriveIcon size={40} />}
          title={copy.title}
          body={copy.body}
          action={
            canCreate ? (
              <button type="button" className="btn primary" onClick={newActions.onFileUpload}>
                <UploadIcon size={16} aria-hidden="true" />
                Upload files
              </button>
            ) : undefined
          }
        />
      );
    }
    if (view === "list" && scope !== "home") {
      return (
        <div className="drive-list">
          <div className="drive-list-header">
            <span className="drive-list-header-check">
              <SelectAllCheckbox
                total={items.length}
                selectedCount={items.filter((item) => selectedKeys.has(item.id)).length}
                onToggle={(all) =>
                  onSelectedKeysChange(all ? new Set(items.map((item) => item.id)) : new Set())
                }
                label="Select all items"
              />
            </span>
            <span className="drive-list-row">
              <span className="drive-col-name">Name</span>
              <span className="drive-col-owner">Owner</span>
              <span className="drive-col-date">
                {scope === "trash" ? "Date trashed" : "Last modified"}
              </span>
              <span className="drive-col-size">File size</span>
            </span>
          </div>
          {list(items, props.searching ? "Search results" : "Files and folders", "list")}
        </div>
      );
    }
    return (
      <>
        {folders.length > 0 ? (
          <section aria-labelledby="drive-folders-heading" className="mb-6">
            <h2 id="drive-folders-heading" className="drive-section-title">
              {titles.folders}
            </h2>
            {list(folders, titles.folders, "folders")}
          </section>
        ) : null}
        {files.length > 0 ? (
          <section aria-labelledby="drive-files-heading">
            <h2 id="drive-files-heading" className="drive-section-title">
              {titles.files}
            </h2>
            {view === "list"
              ? list(files, titles.files, "list")
              : list(files, titles.files, "cards")}
          </section>
        ) : null}
      </>
    );
  })();

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) setMenuTargets([]);
      }}
    >
      <ContextMenuTrigger asChild onKeyDown={onKeyDown}>
        <div
          className="drive-items-area"
          data-testid="drive-main"
          onContextMenu={onContextMenu}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {dropping ? (
            <div className="drive-drop-overlay" data-testid="drive-drop-overlay" aria-hidden="true">
              <UploadIcon size={36} />
              <span>Drop files to upload them to {props.dropLabel}</span>
            </div>
          ) : null}
          {body}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-60">
        {menuTargets.length > 0 ? (
          <DriveContextMenuItems
            actions={props.actionsFor(menuTargets)}
            onAction={(id) => props.onTargetsAction(menuTargets, id)}
          />
        ) : canCreate ? (
          <>
            <ContextMenuItem icon={<NewFolderIcon size={16} />} onSelect={newActions.onNewFolder}>
              New folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem icon={<FileUploadIcon size={16} />} onSelect={newActions.onFileUpload}>
              File upload
            </ContextMenuItem>
            <ContextMenuItem
              icon={<FolderUploadIcon size={16} />}
              onSelect={newActions.onFolderUpload}
            >
              Folder upload
            </ContextMenuItem>
          </>
        ) : scope === "trash" && items.length > 0 ? (
          <ContextMenuItem icon={<TrashIcon size={16} />} destructive onSelect={props.onEmptyTrash}>
            Empty trash
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            icon={<SelectAllIcon size={16} />}
            disabled={items.length === 0}
            onSelect={() => onSelectedKeysChange(new Set(items.map((item) => item.id)))}
          >
            Select all
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
