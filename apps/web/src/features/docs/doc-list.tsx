/* Docs list view — sidebar (New doc + folders + tag folders + templates) plus
   the main pane (Recent grid with striped thumbnails + All-documents table).
   Ported from the design handoff (app-docs.jsx → DocsSidebar + DocList). */

import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
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
  readonly onImportDocx: () => void;
  readonly onOpenDoc: (document: DocSummary) => void;
  readonly onMigrateDocument?: ((id: string) => void) | undefined;
  /** True when the Docs backend could not be reached. */
  readonly isBackendUnavailable: boolean;
  /** True while the documents query is in flight (first paint, no data yet). */
  readonly isLoading?: boolean;
  /** True while a `docs.create` request is in flight. */
  readonly isCreating?: boolean;
  readonly isImporting?: boolean;
  readonly migratingDocumentId?: string | null | undefined;
  readonly createError?: Error | null;
  readonly importError?: Error | null;
  readonly migrationError?: Error | null;
}

export function DocList({
  documents,
  folder,
  query,
  onFolder,
  onNewDoc,
  onImportDocx,
  onOpenDoc,
  onMigrateDocument,
  isBackendUnavailable,
  isLoading = false,
  isCreating = false,
  isImporting = false,
  migratingDocumentId = null,
  createError = null,
  importError = null,
  migrationError = null,
}: DocListProps) {
  const visible = filterDocuments(documents, folder, query);
  const heading = headingForFolder(folder);

  return (
    <>
      <DocsSidebar
        folder={folder}
        onFolder={onFolder}
        onNewDoc={onNewDoc}
        onImportDocx={onImportDocx}
        isCreating={isCreating}
        isImporting={isImporting}
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
            <button className="btn" type="button">
              <Icons.Filter /> Filter
            </button>
            <button className="btn" type="button" onClick={onImportDocx} disabled={isImporting}>
              <Icons.Upload /> {isImporting ? "Importing..." : "Import DOCX"}
            </button>
            <button className="btn primary" type="button" onClick={onNewDoc}>
              <Icons.Plus /> New doc
            </button>
          </div>
        </div>

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
            DOCX import failed — {importError.message}
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
        ) : (
          <>
            <div className="section-label" style={{ padding: "0 0 8px" }}>
              Recent
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: 12,
                marginBottom: 24,
              }}
            >
              {visible.slice(0, 4).map((document) => (
                <RecentCard
                  key={document.id}
                  document={document}
                  onOpen={() => onOpenDoc(document)}
                />
              ))}
            </div>

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
                <div
                  key={document.id}
                  role="button"
                  tabIndex={0}
                  className="list-row"
                  onClick={() => onOpenDoc(document)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenDoc(document);
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
                  }}
                >
                  <span className="row gap-2" style={{ minWidth: 0 }}>
                    <Icons.Doc />
                    <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
                      {document.title}
                    </span>
                    {document.formatLabel ? <DocFormatChip label={document.formatLabel} /> : null}
                  </span>
                  <span className="row gap-2" style={{ minWidth: 0 }}>
                    <Avatar name={document.owner} size={18} />
                    <span className="truncate">{document.owner}</span>
                  </span>
                  <span style={{ color: "var(--text-2)" }}>{document.modified}</span>
                  <span style={{ color: "var(--text-2)" }}>{document.shared} people</span>
                  {isLegacyDocument(document) && onMigrateDocument !== undefined ? (
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Migrate ${document.title} to native editor`}
                      disabled={migratingDocumentId === document.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        onMigrateDocument(document.id);
                      }}
                    >
                      <Icons.Doc />{" "}
                      {migratingDocumentId === document.id ? "Migrating..." : "Migrate"}
                    </button>
                  ) : (
                    <span
                      className="icon-btn"
                      role="presentation"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Icons.MoreV />
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function isLegacyDocument(document: DocSummary): boolean {
  return document.editorEngine === "legacy-yjs";
}

function DocsSidebar({
  folder,
  onFolder,
  onNewDoc,
  onImportDocx,
  isCreating = false,
  isImporting = false,
}: {
  readonly folder: string;
  readonly onFolder: (folder: string) => void;
  readonly onNewDoc: () => void;
  readonly onImportDocx: () => void;
  readonly isCreating?: boolean;
  readonly isImporting?: boolean;
}) {
  return (
    <aside aria-label="Docs navigation" className="surf-sidebar">
      <button
        className="btn primary lg"
        type="button"
        onClick={onNewDoc}
        disabled={isCreating}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Plus /> {isCreating ? "Creating…" : "New doc"}
      </button>
      <button
        className="btn lg"
        type="button"
        onClick={onImportDocx}
        disabled={isImporting}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Upload /> {isImporting ? "Importing..." : "Import DOCX"}
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
      <div
        aria-hidden="true"
        style={{
          aspectRatio: "8 / 11",
          background: "var(--surface-2)",
          borderRadius: 4,
          padding: 10,
          overflow: "hidden",
          border: "1px solid var(--border)",
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
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 2,
          }}
        >
          <div
            className="truncate"
            style={{ fontSize: "var(--text-meta)", fontWeight: 500, flex: 1, minWidth: 0 }}
          >
            {document.title}
          </div>
          {document.formatLabel ? <DocFormatChip label={document.formatLabel} /> : null}
        </div>
        <div style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
          {document.modified}
        </div>
      </div>
    </button>
  );
}

/** Small uppercase chip showing the doc's original format (e.g. "MD",
 *  "DOCX"). Lives next to the doc title in both the recent-cards grid and
 *  the all-documents table so the user can tell formats apart at a glance. */
function DocFormatChip({ label }: { readonly label: string }) {
  return (
    <span
      aria-label={`Format: ${label}`}
      style={{
        flexShrink: 0,
        padding: "0 5px",
        height: 16,
        lineHeight: "16px",
        borderRadius: 3,
        fontSize: "var(--text-overline)",
        fontWeight: 700,
        letterSpacing: ".04em",
        color: "var(--accent)",
        background: "var(--accent-soft)",
        border: "1px solid var(--accent)33",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
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
  let rows = documents;
  if (folder === "mine") {
    rows = rows.filter((document) => document.mine);
  } else if (folder === "shared") {
    rows = rows.filter((document) => !document.mine);
  } else if (folder === "recent") {
    rows = rows.slice(0, 5);
  } else if (folder === "starred") {
    rows = rows.filter((document) => document.starred);
  } else if (folder === "trash") {
    rows = [];
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
