/* SheetsList — the Sheets list view.

   Reads spreadsheets from the `sheets.list` tool via TanStack Query and
   merges them ahead of the typed seed (offline fallback). The per-row
   more-actions menu runs `sheets.delete`. Mirrors the Docs list layout:
   a card grid or table driven by the shared document view preference. */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { ShowMoreButton } from "@/components/show-more-button";
import { Avatar } from "@/components/ui/avatar";
import {
  EDITORS_ALPHA_DISABLED_TITLE,
  EditorsAlphaDisabledNotice,
} from "@/features/apps/editors-alpha";
import { setHelixDriveItemDragData } from "@/features/drive/drag-payload";
import { FileNameText } from "@/features/drive/file-name-text";
import { FileThumbnail } from "@/features/drive/file-thumbnail";
import {
  deleteDriveObject,
  restoreDriveObject,
  setDriveObjectStarred,
  trashDriveObject,
} from "@/features/drive/api";
import { driveQueryKeys } from "@/features/drive/queries";
import {
  DocumentSurfaceViewToggle,
  useDocumentSurfaceViewPreference,
} from "@/features/drive/view-preference";
import type { SheetListRow } from "./model";
import { sheetsListFromDriveQueryOptions, sheetsQueryKeys } from "./queries";
import {
  SHEETS_FOLDERS,
  SHEETS_TEMPLATES,
  headingForSheetsFolder,
  type SheetsFolderId,
} from "./list-taxonomy";

export interface SheetsListProps {
  /** Optional case-insensitive filter applied to the spreadsheet title. */
  query?: string;
  /** Opens a spreadsheet in the editor. */
  onOpen: (id: string, openMode: SheetListRow["openMode"]) => void;
  /** Runs the `sheets.create` tool. */
  onCreate?: () => void;
  /** Opens the native spreadsheet import file picker. */
  onImportCsv?: () => void;
  /** True while a create is in flight. */
  isCreating?: boolean;
  /** True while a spreadsheet import is in flight. */
  isImporting?: boolean;
  /** Surfaced when a create fails. */
  createError?: string | null;
  /** Surfaced when a spreadsheet import fails. */
  importError?: string | null;
  /** False when native editing/creation is disabled by Admin > Core apps. */
  editorsEnabled?: boolean;
}

const GRID_COLUMNS = "1fr 160px 140px 80px 32px";
const SHEETS_LIST_DEFAULT_LIMIT = 100;
const SHEETS_LIST_MAX_LIMIT = 250;

function sentinelLimit(displayLimit: number, maxLimit: number): number {
  return displayLimit < maxLimit ? displayLimit + 1 : displayLimit;
}

const thumbStyle: CSSProperties = {
  aspectRatio: "8 / 11",
  background: "var(--surface-2)",
  borderRadius: 4,
  padding: 8,
  overflow: "hidden",
  border: "1px solid var(--border)",
  backgroundImage:
    "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
  backgroundSize: "calc(100% / 5) 14px, 100% 14px",
};

const noticeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  marginBottom: 16,
  fontSize: "var(--text-meta)",
  color: "var(--text-2)",
  background: "var(--warning-soft)",
  borderRadius: 6,
};

export function SheetsList({
  query = "",
  onOpen,
  onCreate,
  onImportCsv,
  isCreating = false,
  isImporting = false,
  createError,
  importError,
  editorsEnabled = true,
}: SheetsListProps) {
  const normalized = query.trim().toLowerCase();
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [folder, setFolder] = useState<SheetsFolderId>("all");
  const [view, setView] = useDocumentSurfaceViewPreference();
  const [listLimit, setListLimit] = useState(SHEETS_LIST_DEFAULT_LIMIT);

  const fetchListLimit = sentinelLimit(listLimit, SHEETS_LIST_MAX_LIMIT);
  const sheetsQuery = useQuery(sheetsListFromDriveQueryOptions({ limit: fetchListLimit, query }));
  const isBackendUnavailable = sheetsQuery.isError;

  useEffect(() => {
    setListLimit(SHEETS_LIST_DEFAULT_LIMIT);
  }, [normalized]);

  const invalidateLists = () => {
    void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
  };

  const trashMutation = useMutation({
    mutationFn: (objectId: string) => trashDriveObject(objectId),
    onMutate: () => {
      setDeleteError(null);
    },
    onError: (error: unknown) => {
      setDeleteError(error instanceof Error ? error.message : String(error));
    },
    onSettled: invalidateLists,
  });

  const restoreMutation = useMutation({
    mutationFn: (objectId: string) => restoreDriveObject(objectId),
    onMutate: () => {
      setDeleteError(null);
    },
    onError: (error: unknown) => {
      setDeleteError(error instanceof Error ? error.message : String(error));
    },
    onSettled: invalidateLists,
  });

  const deleteForeverMutation = useMutation({
    mutationFn: (objectId: string) => deleteDriveObject(objectId),
    onMutate: () => {
      setDeleteError(null);
    },
    onError: (error: unknown) => {
      setDeleteError(error instanceof Error ? error.message : String(error));
    },
    onSettled: invalidateLists,
  });

  const starMutation = useMutation({
    mutationFn: (vars: { readonly objectId: string; readonly starred: boolean }) =>
      setDriveObjectStarred(vars.objectId, vars.starred),
    onMutate: () => {
      setDeleteError(null);
    },
    onError: (error: unknown) => {
      setDeleteError(error instanceof Error ? error.message : String(error));
    },
    onSettled: invalidateLists,
  });

  const rawDriveRows = sheetsQuery.data ?? [];
  const driveRows = rawDriveRows.slice(0, listLimit);
  const filteredByFolder = useMemo(
    () => filterSheetsByFolder(driveRows, folder),
    [driveRows, folder],
  );
  const sheets: readonly SheetListRow[] = normalized
    ? filteredByFolder.filter((sheet) => sheet.title.toLowerCase().includes(normalized))
    : filteredByFolder;
  const heading = headingForSheetsFolder(folder);
  const hasMore = rawDriveRows.length > listLimit && listLimit < SHEETS_LIST_MAX_LIMIT;
  const showMore = () =>
    setListLimit((current) => Math.min(current + SHEETS_LIST_DEFAULT_LIMIT, SHEETS_LIST_MAX_LIMIT));

  const createErrorMessage = createError ?? undefined;
  const importErrorMessage = importError ?? undefined;
  const deleteErrorMessage = deleteError ?? undefined;

  return (
    <>
      <SheetsSidebar
        folder={folder}
        onFolder={setFolder}
        onNewSheet={() => onCreate?.()}
        onImportXlsx={() => onImportCsv?.()}
        isCreating={isCreating}
        isImporting={isImporting}
        editorsEnabled={editorsEnabled}
      />
      <div
        className="flex-1"
        style={{ overflowY: "auto", padding: "24px 32px", background: "var(--bg)", minWidth: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: "var(--text-h2)", fontWeight: 600 }}>{heading}</h1>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <DocumentSurfaceViewToggle view={view} onViewChange={setView} />
            <button type="button" className="btn">
              <Icons.Filter /> Filter
            </button>
            <button
              type="button"
              className="btn"
              disabled={isImporting}
              onClick={() => onImportCsv?.()}
            >
              <Icons.Upload /> {isImporting ? "Importing..." : "Import"}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={isCreating || !editorsEnabled}
              title={editorsEnabled ? undefined : EDITORS_ALPHA_DISABLED_TITLE}
              onClick={() => onCreate?.()}
            >
              <Icons.Plus /> {isCreating ? "Creating…" : "New sheet"}
            </button>
          </div>
        </div>

        {editorsEnabled ? null : <EditorsAlphaDisabledNotice surface="Sheets" />}

        {isBackendUnavailable ? (
          <div role="status" style={noticeStyle}>
            <Icons.Globe />
            Sheets backend unavailable — showing seeded spreadsheets only.
          </div>
        ) : null}

        {createErrorMessage !== undefined ? (
          <div
            role="alert"
            style={{ ...noticeStyle, background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            <Icons.X />
            Could not create spreadsheet: {createErrorMessage}
          </div>
        ) : null}

        {importErrorMessage !== undefined ? (
          <div
            role="alert"
            style={{ ...noticeStyle, background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            <Icons.X />
            Could not import spreadsheet: {importErrorMessage}
          </div>
        ) : null}

        {deleteErrorMessage !== undefined ? (
          <div
            role="alert"
            style={{ ...noticeStyle, background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            <Icons.X />
            Could not delete spreadsheet: {deleteErrorMessage}
          </div>
        ) : null}

        {sheetsQuery.isLoading ? (
          <div className="empty" role="status">
            <Icons.Sheet size={28} />
            <div>Loading spreadsheets…</div>
          </div>
        ) : sheets.length === 0 ? (
          <div className="empty">
            <Icons.Search size={28} />
            <div>{emptySheetsMessage(folder, normalized.length > 0 ? query : null)}</div>
          </div>
        ) : (
          <>
            {view === "grid" ? (
              <>
                <div className="section-label" style={{ padding: "0 0 8px" }}>
                  Spreadsheets
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                    gap: 12,
                    marginBottom: 24,
                  }}
                >
                  {sheets.map((sheet) => (
                    <SheetCard key={sheet.id} sheet={sheet} onOpen={onOpen} />
                  ))}
                </div>
                {hasMore ? (
                  <ShowMoreButton label="Show more spreadsheets" onClick={showMore} />
                ) : null}
              </>
            ) : (
              <>
                <div className="section-label" style={{ padding: "0 0 8px" }}>
                  All spreadsheets
                </div>
                <div className="panel">
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: GRID_COLUMNS,
                      padding: "8px 16px",
                      fontSize: "var(--text-caption)",
                      color: "var(--text-3)",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: ".06em",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <span>Name</span>
                    <span>Owner</span>
                    <span>Modified</span>
                    <span>Shared</span>
                    <span />
                  </div>
                  {sheets.map((sheet) => (
                    <SheetRow
                      key={sheet.id}
                      sheet={sheet}
                      onOpen={onOpen}
                      isTrash={folder === "trash"}
                      onTrash={(id) => trashMutation.mutate(id)}
                      onRestore={(id) => restoreMutation.mutate(id)}
                      onDeleteForever={(id) => deleteForeverMutation.mutate(id)}
                      onSetStarred={(id, starred) => starMutation.mutate({ objectId: id, starred })}
                      isBusy={
                        (trashMutation.isPending && trashMutation.variables === sheet.id) ||
                        (restoreMutation.isPending && restoreMutation.variables === sheet.id) ||
                        (deleteForeverMutation.isPending &&
                          deleteForeverMutation.variables === sheet.id) ||
                        (starMutation.isPending && starMutation.variables?.objectId === sheet.id)
                      }
                    />
                  ))}
                </div>
                {hasMore ? (
                  <ShowMoreButton label="Show more spreadsheets" onClick={showMore} />
                ) : null}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function SheetCard({
  sheet,
  onOpen,
}: {
  readonly sheet: SheetListRow;
  readonly onOpen: (id: string, openMode: SheetListRow["openMode"]) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        setHelixDriveItemDragData(event.dataTransfer, {
          id: sheet.id,
          name: sheet.title,
          href: sheetDragHref(sheet),
          mimeType: sheet.mimeType,
          app: "sheets",
        });
      }}
      onClick={() => onOpen(sheet.id, sheet.openMode)}
      title={sheet.title}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        textAlign: "left",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <FileThumbnail
        objectId={sheet.id}
        name={sheet.title}
        mimeType={sheet.mimeType}
        preview={sheet.preview}
        aspectRatio="8 / 11"
        icon="Sheet"
        color="#059669"
        fallback={<SheetThumbnailPlaceholder title={sheet.title} />}
      />
      <div>
        <FileNameText
          name={sheet.title}
          style={{ fontSize: "var(--text-meta)", fontWeight: 500, minWidth: 0 }}
        />
        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
          {sheet.modified}
        </div>
      </div>
    </button>
  );
}

function SheetThumbnailPlaceholder({ title }: { readonly title: string }) {
  return (
    <div
      style={{
        ...thumbStyle,
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        border: 0,
        borderRadius: 0,
      }}
    >
      <div
        style={{
          fontSize: "var(--text-6)",
          fontWeight: 600,
          color: "var(--text-2)",
        }}
      >
        <FileNameText name={title} />
      </div>
    </div>
  );
}

function SheetsSidebar({
  folder,
  onFolder,
  onNewSheet,
  onImportXlsx,
  isCreating = false,
  isImporting = false,
  editorsEnabled = true,
}: {
  readonly folder: SheetsFolderId;
  readonly onFolder: (folder: SheetsFolderId) => void;
  readonly onNewSheet: () => void;
  readonly onImportXlsx: () => void;
  readonly isCreating?: boolean;
  readonly isImporting?: boolean;
  readonly editorsEnabled?: boolean;
}) {
  return (
    <aside aria-label="Sheets navigation" className="surf-sidebar">
      <button
        className="btn primary lg"
        type="button"
        onClick={onNewSheet}
        disabled={isCreating || !editorsEnabled}
        title={editorsEnabled ? undefined : EDITORS_ALPHA_DISABLED_TITLE}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Plus /> {isCreating ? "Creating…" : "New sheet"}
      </button>
      <button
        className="btn lg"
        type="button"
        onClick={onImportXlsx}
        disabled={isImporting}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Upload /> {isImporting ? "Importing..." : "Import XLSX"}
      </button>
      <nav aria-label="Spreadsheet folders" style={{ overflowY: "auto", flex: 1 }}>
        {SHEETS_FOLDERS.map((entry) => {
          const Icon = entry.icon;
          const selected = folder === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onFolder(entry.id)}
              className="surf-nav-row"
            >
              <Icon />
              <span className="label">{entry.label}</span>
            </button>
          );
        })}

        <div className="surf-section-label">Templates</div>
        {SHEETS_TEMPLATES.map((template) => (
          <button key={template} type="button" className="surf-nav-row">
            <Icons.Sheet />
            <span className="label">{template}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

/** Apply the active folder selection to the spreadsheet list using Drive metadata. */
export function filterSheetsByFolder(
  rows: readonly SheetListRow[],
  folder: SheetsFolderId,
): readonly SheetListRow[] {
  const scopedRows =
    folder === "trash"
      ? rows.filter((row) => row.deletedAt !== null && row.deletedAt !== undefined)
      : rows.filter((row) => row.deletedAt === null || row.deletedAt === undefined);
  if (folder === "mine") {
    return scopedRows.filter((row) => row.mine ?? row.owner.toLowerCase() === "you");
  }
  if (folder === "recent") {
    return scopedRows.slice(0, 5);
  }
  if (folder === "shared") {
    return scopedRows.filter((row) => row.mine === false);
  }
  if (folder === "starred") {
    return scopedRows.filter((row) => row.starred === true);
  }
  return scopedRows;
}

function emptySheetsMessage(folder: SheetsFolderId, query: string | null): string {
  if (query !== null) {
    return `No spreadsheets match “${query}”.`;
  }
  if (folder === "shared") {
    return "No shared spreadsheets yet.";
  }
  if (folder === "starred") {
    return "No starred spreadsheets yet.";
  }
  if (folder === "trash") {
    return "Trash is empty.";
  }
  if (folder === "mine") {
    return "No spreadsheets owned by you yet.";
  }
  if (folder === "recent") {
    return "No recent spreadsheets yet.";
  }
  return "No spreadsheets yet — create your first one.";
}

interface SheetRowProps {
  readonly sheet: SheetListRow;
  readonly onOpen: (id: string, openMode: SheetListRow["openMode"]) => void;
  readonly isTrash: boolean;
  readonly onTrash: (id: string) => void;
  readonly onRestore: (id: string) => void;
  readonly onDeleteForever: (id: string) => void;
  readonly onSetStarred: (id: string, starred: boolean) => void;
  readonly isBusy: boolean;
}

function SheetRow({
  sheet,
  onOpen,
  isTrash,
  onTrash,
  onRestore,
  onDeleteForever,
  onSetStarred,
  isBusy,
}: SheetRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const canManageDriveObject = sheet.source === "backend";

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="list-row"
        draggable
        onDragStart={(event) => {
          setHelixDriveItemDragData(event.dataTransfer, {
            id: sheet.id,
            name: sheet.title,
            href: sheetDragHref(sheet),
            mimeType: sheet.mimeType,
            app: "sheets",
          });
        }}
        onClick={() => onOpen(sheet.id, sheet.openMode)}
        disabled={isBusy}
        style={{
          display: "grid",
          gridTemplateColumns: GRID_COLUMNS,
          padding: "0 16px",
          height: 36,
          alignItems: "center",
          fontSize: "var(--text-meta)",
          width: "100%",
          textAlign: "left",
          borderBottom: "1px solid var(--border)",
          opacity: isBusy ? 0.5 : 1,
        }}
      >
        <div className="row gap-2" style={{ minWidth: 0 }}>
          <span style={{ color: "#059669", display: "flex" }}>
            <Icons.Sheet />
          </span>
          <FileNameText name={sheet.title} style={{ minWidth: 0 }} />
        </div>
        <div className="row gap-2" style={{ minWidth: 0 }}>
          <Avatar name={sheet.owner} size={18} />
          <span className="truncate">{sheet.owner}</span>
        </div>
        <span style={{ color: "var(--text-2)" }}>{sheet.modified}</span>
        <span style={{ color: "var(--text-2)" }}>{sheet.shared} people</span>
        <span
          role="button"
          tabIndex={-1}
          className="icon-btn"
          aria-label={`More actions for ${sheet.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <Icons.MoreV />
        </span>
      </button>

      {menuOpen ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 12,
            top: 32,
            zIndex: 10,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            minWidth: 160,
            padding: 4,
          }}
        >
          {isTrash ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={!canManageDriveObject || isBusy}
                title={canManageDriveObject ? undefined : "This item is not stored in Drive"}
                onClick={() => {
                  setMenuOpen(false);
                  onRestore(sheet.id);
                }}
                style={sheetMenuItemStyle}
              >
                <Icons.History /> Restore
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={!canManageDriveObject || isBusy}
                title={canManageDriveObject ? undefined : "This item is not stored in Drive"}
                onClick={() => {
                  setMenuOpen(false);
                  onDeleteForever(sheet.id);
                }}
                style={{
                  ...sheetMenuItemStyle,
                  color: canManageDriveObject ? "var(--danger)" : "var(--text-3)",
                }}
              >
                <Icons.Trash /> Delete forever
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={!canManageDriveObject || isBusy}
                title={canManageDriveObject ? undefined : "This item is not stored in Drive"}
                onClick={() => {
                  setMenuOpen(false);
                  onSetStarred(sheet.id, !sheet.starred);
                }}
                style={sheetMenuItemStyle}
              >
                <Icons.Star fill={sheet.starred ? "currentColor" : "none"} />{" "}
                {sheet.starred ? "Unstar" : "Star"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={!canManageDriveObject || isBusy}
                title={canManageDriveObject ? undefined : "This item is not stored in Drive"}
                onClick={() => {
                  setMenuOpen(false);
                  onTrash(sheet.id);
                }}
                style={{
                  ...sheetMenuItemStyle,
                  color: canManageDriveObject ? "var(--danger)" : "var(--text-3)",
                }}
              >
                <Icons.Trash /> Move to trash
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

const sheetMenuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  fontSize: "var(--text-meta)",
  textAlign: "left",
  borderRadius: 4,
  background: "transparent",
};

function sheetDragHref(sheet: SheetListRow): string {
  const suffix = sheet.openMode === "office" ? "&open=office" : "";
  return `/sheets?sheet=${encodeURIComponent(sheet.id)}${suffix}`;
}
