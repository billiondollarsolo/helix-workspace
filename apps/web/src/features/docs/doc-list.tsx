/* Docs list view — sidebar (New doc + folders + tag folders + templates) plus
   the main pane (card grid or table, driven by the shared document view preference).
   Ported from the design handoff (app-docs.jsx → DocsSidebar + DocList). */

import { useState, type CSSProperties } from "react";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { EditorsAlphaDisabledNotice } from "@/features/apps/editors-alpha";
import { setHelixDriveItemDragData } from "@/features/drive/drag-payload";
import { FileNameText } from "@/features/drive/file-name-text";
import { FileThumbnail } from "@/features/drive/file-thumbnail";
import {
  DocumentSurfaceViewToggle,
  useDocumentSurfaceViewPreference,
} from "@/features/drive/view-preference";
import {
  DOC_FOLDERS,
  DOC_TEMPLATES,
  FOLDER_EMPTY_STATES,
  type DocFolderId,
  type DocSummary,
} from "./data";

export interface DocListProps {
  /** All documents available (backend rows merged over seed data). */
  readonly documents: readonly DocSummary[];
  /** Active folder / tag-folder id. */
  readonly folder: string;
  /** Current search query — narrows the visible documents. */
  readonly query: string;
  readonly onFolder: (folder: string) => void;
  readonly onNewDoc: () => void;
  readonly onImportDocument: () => void;
  readonly onOpenDoc: (document: DocSummary) => void;
  readonly onMigrateDocument?: ((id: string) => void) | undefined;
  readonly onTrashDocument?: ((id: string) => void) | undefined;
  readonly onRestoreDocument?: ((id: string) => void) | undefined;
  readonly onDeleteDocumentForever?: ((id: string) => void) | undefined;
  readonly onSetDocumentStarred?: ((id: string, starred: boolean) => void) | undefined;
  /** True when the Docs backend could not be reached. */
  readonly isBackendUnavailable: boolean;
  /** True while the documents query is in flight (first paint, no data yet). */
  readonly isLoading?: boolean;
  readonly hasMore?: boolean;
  readonly onShowMore?: () => void;
  /** True while a `docs.create` request is in flight. */
  readonly isCreating?: boolean;
  readonly isImporting?: boolean;
  readonly migratingDocumentId?: string | null | undefined;
  readonly createError?: Error | null;
  readonly importError?: Error | null;
  readonly migrationError?: Error | null;
  readonly actionError?: Error | null;
  readonly busyDocumentId?: string | null | undefined;
  /** False when native editing/creation is disabled by Admin > Core apps. */
  readonly editorsEnabled?: boolean;
}

export function DocList({
  documents,
  folder,
  query,
  onFolder,
  onNewDoc,
  onImportDocument,
  onOpenDoc,
  onMigrateDocument,
  onTrashDocument,
  onRestoreDocument,
  onDeleteDocumentForever,
  onSetDocumentStarred,
  isBackendUnavailable,
  isLoading = false,
  hasMore = false,
  onShowMore,
  isCreating = false,
  isImporting = false,
  migratingDocumentId = null,
  createError = null,
  importError = null,
  migrationError = null,
  actionError = null,
  busyDocumentId = null,
  editorsEnabled = true,
}: DocListProps) {
  const visible = filterDocuments(documents, folder, query);
  const heading = headingForFolder(folder);
  const [view, setView] = useDocumentSurfaceViewPreference();

  return (
    <>
      <DocsSidebar
        folder={folder}
        onFolder={onFolder}
        onNewDoc={onNewDoc}
        onImportDocument={onImportDocument}
        isCreating={isCreating}
        isImporting={isImporting}
        editorsEnabled={editorsEnabled}
      />
      <div
        style={{
          padding: "24px 32px",
          overflowY: "auto",
          flex: 1,
          background: "var(--bg)",
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: "var(--text-h2)", fontWeight: 600 }}>{heading}</h1>
          <span style={{ marginLeft: 8, fontSize: "var(--text-meta)", color: "var(--text-3)" }}>
            {visible.length} item{visible.length === 1 ? "" : "s"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <DocumentSurfaceViewToggle view={view} onViewChange={setView} />
            <button className="btn" type="button">
              <Icons.Filter /> Filter
            </button>
            <button
              className="btn"
              type="button"
              onClick={onImportDocument}
              disabled={isImporting}
            >
              <Icons.Upload /> {isImporting ? "Importing..." : "Import"}
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={onNewDoc}
              disabled={isCreating || !editorsEnabled}
              title={
                editorsEnabled
                  ? undefined
                  : "Editors alpha is disabled by an admin. Import and preview files from Drive."
              }
            >
              <Icons.Plus /> New doc
            </button>
          </div>
        </div>

        {editorsEnabled ? null : <EditorsAlphaDisabledNotice surface="Docs" />}

        {isBackendUnavailable ? (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              marginBottom: 16,
              fontSize: "var(--text-meta)",
              color: "var(--text-2)",
              background: "var(--warning-soft)",
              borderRadius: 6,
            }}
          >
            <Icons.Globe />
            Docs unavailable — try again later.
          </div>
        ) : null}

        {createError !== null ? (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              marginBottom: 16,
              fontSize: "var(--text-meta)",
              color: "var(--text-2)",
              background: "var(--warning-soft)",
              borderRadius: 6,
            }}
          >
            <Icons.Doc />
            Document creation failed — {createError.message}
          </div>
        ) : null}

        {importError !== null ? (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              marginBottom: 16,
              fontSize: "var(--text-meta)",
              color: "var(--text-2)",
              background: "var(--warning-soft)",
              borderRadius: 6,
            }}
          >
            <Icons.Upload />
            Document import failed — {importError.message}
          </div>
        ) : null}

        {migrationError !== null ? (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              marginBottom: 16,
              fontSize: "var(--text-meta)",
              color: "var(--text-2)",
              background: "var(--warning-soft)",
              borderRadius: 6,
            }}
          >
            <Icons.Doc />
            Migration failed — {migrationError.message}
          </div>
        ) : null}

        {actionError !== null ? (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              marginBottom: 16,
              fontSize: "var(--text-meta)",
              color: "var(--text-2)",
              background: "var(--warning-soft)",
              borderRadius: 6,
            }}
          >
            <Icons.Trash />
            Document action failed — {actionError.message}
          </div>
        ) : null}

        {isLoading && visible.length === 0 ? (
          <div
            role="status"
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--text-3)",
              fontSize: "var(--text-body-sm)",
            }}
          >
            Loading documents…
          </div>
        ) : visible.length === 0 ? (
          <EmptyState folder={folder} hasQuery={query.trim().length > 0} />
        ) : view === "grid" ? (
          <>
            <div className="section-label" style={{ padding: "0 0 8px" }}>
              Documents
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: 12,
                marginBottom: 24,
              }}
            >
              {visible.map((document) => (
                <RecentCard
                  key={document.id}
                  document={document}
                  onOpen={() => onOpenDoc(document)}
                />
              ))}
            </div>
            {hasMore && onShowMore !== undefined ? (
              <ShowMoreButton label="Show more documents" onClick={onShowMore} />
            ) : null}
          </>
        ) : (
          <>
            <div className="section-label" style={{ padding: "0 0 8px" }}>
              All documents
            </div>
            <div className="panel">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 160px 140px 80px 96px",
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
                <span>Action</span>
              </div>
              {visible.map((document) => (
                <DocRow
                  key={document.id}
                  document={document}
                  isTrash={folder === "trash"}
                  isBusy={
                    busyDocumentId === document.id || migratingDocumentId === document.id
                  }
                  canMigrate={
                    editorsEnabled && isLegacyDocument(document) && onMigrateDocument !== undefined
                  }
                  onOpen={() => onOpenDoc(document)}
                  onMigrate={() => onMigrateDocument?.(document.id)}
                  onTrash={() => onTrashDocument?.(document.id)}
                  onRestore={() => onRestoreDocument?.(document.id)}
                  onDeleteForever={() => onDeleteDocumentForever?.(document.id)}
                  onSetStarred={(starred) => onSetDocumentStarred?.(document.id, starred)}
                />
              ))}
            </div>
            {hasMore && onShowMore !== undefined ? (
              <ShowMoreButton label="Show more documents" onClick={onShowMore} />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function ShowMoreButton({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
      <button type="button" className="btn" onClick={onClick}>
        <Icons.ChevronDown />
        {label}
      </button>
    </div>
  );
}

function isLegacyDocument(document: DocSummary): boolean {
  return document.editorEngine === "legacy-yjs";
}

function DocRow({
  document,
  isTrash,
  isBusy,
  canMigrate,
  onOpen,
  onMigrate,
  onTrash,
  onRestore,
  onDeleteForever,
  onSetStarred,
}: {
  readonly document: DocSummary;
  readonly isTrash: boolean;
  readonly isBusy: boolean;
  readonly canMigrate: boolean;
  readonly onOpen: () => void;
  readonly onMigrate: () => void;
  readonly onTrash: () => void;
  readonly onRestore: () => void;
  readonly onDeleteForever: () => void;
  readonly onSetStarred: (starred: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <div
        role="button"
        tabIndex={0}
        className="list-row"
        draggable
        onDragStart={(event) => {
          setHelixDriveItemDragData(event.dataTransfer, {
            id: document.id,
            name: document.title,
            href: documentDragHref(document),
            mimeType: document.mimeType,
            app: "docs",
          });
        }}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 160px 140px 80px 96px",
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
        <span className="row gap-2" style={{ minWidth: 0 }}>
          <Icons.Doc />
          <FileNameText name={document.title} style={{ flex: 1, minWidth: 0 }} />
        </span>
        <span className="row gap-2" style={{ minWidth: 0 }}>
          <Avatar name={document.owner} size={18} />
          <span className="truncate">{document.owner}</span>
        </span>
        <span style={{ color: "var(--text-2)" }}>{document.modified}</span>
        <span style={{ color: "var(--text-2)" }}>{document.shared} people</span>
        <span
          className="icon-btn"
          role="button"
          tabIndex={-1}
          aria-label={`More actions for ${document.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <Icons.MoreV />
        </span>
      </div>

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
            minWidth: 170,
            padding: 4,
          }}
        >
          {isTrash ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onRestore();
                }}
                style={docMenuItemStyle}
              >
                <Icons.History /> Restore
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onDeleteForever();
                }}
                style={{ ...docMenuItemStyle, color: "var(--danger)" }}
              >
                <Icons.Trash /> Delete forever
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onSetStarred(!document.starred);
                }}
                style={docMenuItemStyle}
              >
                <Icons.Star fill={document.starred ? "currentColor" : "none"} />{" "}
                {document.starred ? "Unstar" : "Star"}
              </button>
              {canMigrate ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={isBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuOpen(false);
                    onMigrate();
                  }}
                  style={docMenuItemStyle}
                >
                  <Icons.Doc /> {isBusy ? "Migrating..." : "Migrate"}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onTrash();
                }}
                style={{ ...docMenuItemStyle, color: "var(--danger)" }}
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

const docMenuItemStyle: CSSProperties = {
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

function documentDragHref(document: DocSummary): string {
  const suffix = document.openMode === "office" ? "?open=office" : "";
  return `/docs/${encodeURIComponent(document.id)}${suffix}`;
}

function DocsSidebar({
  folder,
  onFolder,
  onNewDoc,
  onImportDocument,
  isCreating = false,
  isImporting = false,
  editorsEnabled = true,
}: {
  readonly folder: string;
  readonly onFolder: (folder: string) => void;
  readonly onNewDoc: () => void;
  readonly onImportDocument: () => void;
  readonly isCreating?: boolean;
  readonly isImporting?: boolean;
  readonly editorsEnabled?: boolean;
}) {
  return (
    <aside aria-label="Docs navigation" className="surf-sidebar">
      <button
        className="btn primary lg"
        type="button"
        onClick={onNewDoc}
        disabled={isCreating || !editorsEnabled}
        title={
          editorsEnabled
            ? undefined
            : "Editors alpha is disabled by an admin. Import and preview files from Drive."
        }
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Plus /> {isCreating ? "Creating…" : "New doc"}
      </button>
      <button
        className="btn lg"
        type="button"
        onClick={onImportDocument}
        disabled={isImporting}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Upload /> {isImporting ? "Importing..." : "Import document"}
      </button>
      <nav aria-label="Document folders" style={{ overflowY: "auto", flex: 1 }}>
        {DOC_FOLDERS.map((entry) => {
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
        {DOC_TEMPLATES.map((template) => (
          <button key={template} type="button" className="surf-nav-row">
            <Icons.Doc />
            <span className="label">{template}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function RecentCard({
  document,
  onOpen,
}: {
  readonly document: DocSummary;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        setHelixDriveItemDragData(event.dataTransfer, {
          id: document.id,
          name: document.title,
          href: documentDragHref(document),
          mimeType: document.mimeType,
          app: "docs",
        });
      }}
      onClick={onOpen}
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
        objectId={document.id}
        name={document.title}
        mimeType={document.mimeType}
        preview={document.preview}
        aspectRatio="8 / 11"
        icon="Doc"
        color="#2563eb"
        fallback={<DocumentThumbnailPlaceholder />}
      />
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 2,
          }}
        >
          <FileNameText
            name={document.title}
            style={{ fontSize: "var(--text-meta)", fontWeight: 500, flex: 1, minWidth: 0 }}
          />
        </div>
        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
          {document.modified}
        </div>
      </div>
    </button>
  );
}

function DocumentThumbnailPlaceholder() {
  return (
    <div
      aria-hidden="true"
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        padding: 10,
        background: "var(--surface-2)",
      }}
    >
      <div
        style={{
          height: 4,
          background: "var(--text-3)",
          width: "70%",
          marginBottom: 4,
          borderRadius: 1,
        }}
      />
      {Array.from({ length: 14 }).map((_, index) => (
        <div
          key={`stripe-${String(index)}`}
          style={{
            height: 2,
            background: "var(--border-2)",
            width: `${50 + ((index * 13) % 50)}%`,
            marginBottom: 2,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

function EmptyState({ folder, hasQuery }: { readonly folder: string; readonly hasQuery: boolean }) {
  const fallback = FOLDER_EMPTY_STATES.all;
  const state = hasQuery
    ? {
        icon: Icons.Search,
        title: "No matching documents",
        body: "Try a different search term.",
      }
    : (FOLDER_EMPTY_STATES[folder as DocFolderId] ?? {
        icon: Icons.Doc,
        title: "No documents",
        body: "Try a different folder.",
      });
  const Icon = state.icon ?? fallback.icon;

  return (
    <div
      className="empty"
      style={{
        padding: 64,
        background: "var(--surface)",
        border: "1px dashed var(--border-2)",
        borderRadius: 12,
      }}
    >
      <Icon size={24} />
      <div style={{ fontSize: "var(--text-body)", fontWeight: 500, color: "var(--text)" }}>
        {state.title}
      </div>
      <div>{state.body}</div>
    </div>
  );
}

// `folderRowStyle` was removed in favor of the shared `.surf-nav-row`
// class — same look across drive/mail/docs/calendar/chat/sheets/slides.

/** Applies the active folder + search query to the document list. */
export function filterDocuments(
  documents: readonly DocSummary[],
  folder: string,
  query: string,
): readonly DocSummary[] {
  let rows =
    folder === "trash"
      ? documents.filter((document) => document.deletedAt !== null)
      : documents.filter((document) => document.deletedAt === null);
  if (folder === "mine") {
    rows = rows.filter((document) => document.mine);
  } else if (folder === "shared") {
    rows = rows.filter((document) => !document.mine);
  } else if (folder === "recent") {
    rows = rows.slice(0, 5);
  } else if (folder === "starred") {
    rows = rows.filter((document) => document.starred);
  }

  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return rows;
  }
  return rows.filter((document) =>
    `${document.title} ${document.owner} ${document.folder}`.toLowerCase().includes(normalized),
  );
}

function headingForFolder(folder: string): string {
  if (folder === "" || folder === "all") {
    return "Documents";
  }
  return DOC_FOLDERS.find((entry) => entry.id === folder)?.label ?? "Documents";
}
