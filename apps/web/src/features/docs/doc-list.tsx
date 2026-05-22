/* Docs list view — sidebar (New doc + folders + tag folders + templates) plus
   the main pane (Recent grid with striped thumbnails + All-documents table).
   Ported from the design handoff (app-docs.jsx → DocsSidebar + DocList). */

import type { CSSProperties } from "react";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import {
  DOC_FOLDERS,
  DOC_TAG_FOLDERS,
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
  readonly onOpenDoc: (id: string) => void;
  /** True when the Docs backend could not be reached. */
  readonly isBackendUnavailable: boolean;
  /** True while a `docs.create` request is in flight. */
  readonly isCreating?: boolean;
}

export function DocList({
  documents,
  folder,
  query,
  onFolder,
  onNewDoc,
  onOpenDoc,
  isBackendUnavailable,
  isCreating = false,
}: DocListProps) {
  const visible = filterDocuments(documents, folder, query);
  const heading = headingForFolder(folder);

  return (
    <>
      <DocsSidebar
        folder={folder}
        onFolder={onFolder}
        onNewDoc={onNewDoc}
        isCreating={isCreating}
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
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{heading}</h1>
          <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-3)" }}>
            {visible.length} item{visible.length === 1 ? "" : "s"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn" type="button">
              <Icons.Filter /> Filter
            </button>
            <button className="btn primary" type="button" onClick={onNewDoc}>
              <Icons.Plus /> New doc
            </button>
          </div>
        </div>

        {isBackendUnavailable ? (
          <div
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              marginBottom: 16,
              fontSize: 12,
              color: "var(--text-2)",
              background: "var(--warning-soft)",
              borderRadius: 6,
            }}
          >
            <Icons.Globe />
            Docs backend unavailable — showing seeded documents only.
          </div>
        ) : null}

        {visible.length === 0 ? (
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
                  onOpen={() => onOpenDoc(document.id)}
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
                  gridTemplateColumns: "1fr 160px 140px 80px 32px",
                  padding: "8px 16px",
                  fontSize: 11,
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
              {visible.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  className="list-row"
                  onClick={() => onOpenDoc(document.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 160px 140px 80px 32px",
                    padding: "0 16px",
                    height: 36,
                    alignItems: "center",
                    fontSize: 12,
                    width: "100%",
                    textAlign: "left",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span className="row gap-2" style={{ minWidth: 0 }}>
                    <Icons.Doc />
                    <span className="truncate">{document.title}</span>
                  </span>
                  <span className="row gap-2" style={{ minWidth: 0 }}>
                    <Avatar name={document.owner} size={18} />
                    <span className="truncate">{document.owner}</span>
                  </span>
                  <span style={{ color: "var(--text-2)" }}>{document.modified}</span>
                  <span style={{ color: "var(--text-2)" }}>{document.shared} people</span>
                  <span
                    className="icon-btn"
                    role="presentation"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Icons.MoreV />
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function DocsSidebar({
  folder,
  onFolder,
  onNewDoc,
  isCreating = false,
}: {
  readonly folder: string;
  readonly onFolder: (folder: string) => void;
  readonly onNewDoc: () => void;
  readonly isCreating?: boolean;
}) {
  return (
    <aside
      aria-label="Docs navigation"
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        padding: "10px 8px",
        minHeight: 0,
      }}
    >
      <button
        className="btn primary lg"
        type="button"
        onClick={onNewDoc}
        disabled={isCreating}
        style={{ width: "100%", marginBottom: 12 }}
      >
        <Icons.Plus /> {isCreating ? "Creating…" : "New doc"}
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
              style={folderRowStyle(selected)}
            >
              <Icon />
              <span style={{ flex: 1, textAlign: "left" }}>{entry.label}</span>
            </button>
          );
        })}

        <div className="section-label">Folders</div>
        {DOC_TAG_FOLDERS.map((tag) => {
          const selected = folder === tag.id;
          return (
            <button
              key={tag.id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => onFolder(tag.id)}
              style={folderRowStyle(selected)}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: tag.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, textAlign: "left" }}>{tag.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          style={{ ...folderRowStyle(false), color: "var(--text-3)" }}
        >
          <Icons.Plus />
          <span>New folder</span>
        </button>

        <div className="section-label">Templates</div>
        {DOC_TEMPLATES.map((template) => (
          <button key={template} type="button" style={folderRowStyle(false)}>
            <Icons.Doc />
            <span style={{ flex: 1, textAlign: "left" }}>{template}</span>
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
        <div className="truncate" style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>
          {document.title}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>{document.modified}</div>
      </div>
    </button>
  );
}

function EmptyState({
  folder,
  hasQuery,
}: {
  readonly folder: string;
  readonly hasQuery: boolean;
}) {
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
      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>{state.title}</div>
      <div>{state.body}</div>
    </div>
  );
}

function folderRowStyle(selected: boolean): CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 10,
    height: 30,
    padding: "0 10px",
    borderRadius: 6,
    fontSize: 13,
    background: selected ? "var(--accent-soft)" : "transparent",
    color: selected ? "var(--accent)" : "var(--text)",
    fontWeight: selected ? 600 : 400,
  };
}

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
  } else if (DOC_TAG_FOLDERS.some((tag) => tag.id === folder)) {
    rows = rows.filter((document) => document.folder === folder);
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
  const known = DOC_FOLDERS.find((entry) => entry.id === folder);
  if (known !== undefined) {
    return known.label;
  }
  return DOC_TAG_FOLDERS.find((tag) => tag.id === folder)?.label ?? "Documents";
}
