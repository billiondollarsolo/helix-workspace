import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWebPlatformHost } from "@helix/sdk-web";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Icons } from "@/components/icons";
import {
  nativeDocumentBlocksFromStateBase64,
  nativeDocumentInspectorSnapshotFromBlocks,
  nativeDocumentPlainTextFromBlocks,
  type NativeDocumentBlock,
  type NativeDocumentInspectorSnapshot,
  type NativeDocumentOutlineItem,
  type NativeDocumentStats,
} from "./native-document-content";
import {
  NATIVE_DOCUMENT_COMMAND_EVENT,
  type NativeDocumentCommandEventDetail,
} from "./native-document-commands";
import {
  dispatchNativeDocumentAnchorSelection,
  nativeDocumentAnchorDecorationFromRecord,
  type NativeDocumentAnchorDecoration,
  type NativeDocumentSelectionAnchor,
} from "./native-document-anchors";
import { NativeDocumentCommentsRail } from "./native-document-comments-rail";
import { NativeDocumentSuggestionsRail } from "./native-document-suggestions-rail";
import { NativeDocumentVersionsRail } from "./native-document-versions-rail";
import {
  answerDocsQuestion,
  clearDocsAskHistory,
  exportDocsDocument,
  updateDocsLayout,
  updateDocsTitle,
  type DocsAskHistoryItem,
  type DocsAskCitation,
  type DocsComment,
  type DocsExportFormat,
  type NativeDocumentLayoutSettings,
  type NativeDocumentSectionSettings,
  type NativeDocumentSession,
  type DocsSuggestion,
} from "./api";
import {
  docsCommentsQueryOptions,
  docsAskHistoryQueryOptions,
  docsQueryKeys,
  docsSuggestionsQueryOptions,
  nativeDocumentSessionQueryOptions,
} from "./queries";

const NativeDocumentEditor = lazy(() =>
  import("./native-document-editor").then((module) => ({
    default: module.NativeDocumentEditor,
  })),
);

type NativeDocumentLayoutMode = "page" | "pageless";
type NativeDocumentColumnCount = 1 | 2;
type NativeDocumentPageSize = "letter" | "a4";
type NativeDocumentOrientation = "portrait" | "landscape";

const DEFAULT_NATIVE_DOCUMENT_LAYOUT_SETTINGS: NativeDocumentLayoutSettings = {
  layoutMode: "page",
  columnCount: 1,
};

export interface NativeDocumentShellProps {
  readonly documentId: string;
}

export function NativeDocumentShell({ documentId }: NativeDocumentShellProps) {
  const queryClient = useQueryClient();
  const platformHost = useWebPlatformHost();
  const sessionQuery = useQuery(nativeDocumentSessionQueryOptions(documentId));
  const openCommentsQuery = useQuery(docsCommentsQueryOptions(documentId, "open"));
  const pendingSuggestionsQuery = useQuery(docsSuggestionsQueryOptions(documentId, "pending"));
  const [printPreview, setPrintPreview] = useState(false);
  const [layoutMode, setLayoutMode] = useState<NativeDocumentLayoutMode>("page");
  const [columnCount, setColumnCount] = useState<NativeDocumentColumnCount>(1);
  const [sectionPageSize, setSectionPageSize] = useState<NativeDocumentPageSize>("letter");
  const [sectionOrientation, setSectionOrientation] =
    useState<NativeDocumentOrientation>("portrait");
  const [layoutSections, setLayoutSections] = useState<readonly NativeDocumentSectionSettings[]>(
    [],
  );
  const [selectionAnchor, setSelectionAnchor] = useState<NativeDocumentSelectionAnchor | null>(
    null,
  );
  const [liveInspectorSnapshot, setLiveInspectorSnapshot] =
    useState<NativeDocumentInspectorSnapshot | null>(null);
  const titleMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (title: string) => updateDocsTitle({ docId: documentId, title }),
    onSuccess: (document) => {
      queryClient.setQueryData<NativeDocumentSession>(
        docsQueryKeys.nativeSession(documentId),
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                document: {
                  ...current.document,
                  title: document.title,
                  updatedAt: document.updatedAt,
                },
              },
      );
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.document(documentId) });
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
    },
  });
  const layoutMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (layoutSettings: NativeDocumentLayoutSettings) =>
      updateDocsLayout({ docId: documentId, layoutSettings }),
    onSuccess: (document, layoutSettings) => {
      queryClient.setQueryData<NativeDocumentSession>(
        docsQueryKeys.nativeSession(documentId),
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                document: {
                  ...current.document,
                  layoutSettings,
                  updatedAt: document.updatedAt,
                },
              },
      );
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.document(documentId) });
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
    },
  });
  const exportMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (format: DocsExportFormat) =>
      exportDocsDocument({
        docId: documentId,
        format,
        includeComments: true,
      }),
    onSuccess: (exported) => {
      downloadDocsExport(exported);
    },
  });
  const session = sessionQuery.data;
  useEffect(() => {
    const layoutSettings =
      session?.document.layoutSettings ?? DEFAULT_NATIVE_DOCUMENT_LAYOUT_SETTINGS;
    const section = primaryNativeDocumentSection(layoutSettings);
    setLayoutMode(layoutSettings.layoutMode);
    setColumnCount(layoutSettings.columnCount);
    setSectionPageSize(section.pageSize);
    setSectionOrientation(section.orientation);
    setLayoutSections(layoutSettings.sections ?? []);
  }, [
    session?.document.id,
    session?.document.layoutSettings?.layoutMode,
    session?.document.layoutSettings?.columnCount,
    session?.document.layoutSettings?.sections,
  ]);
  const blocks = useMemo(
    () => nativeDocumentBlocksFromStateBase64(session?.document.stateBase64 ?? null),
    [session?.document.stateBase64],
  );
  const sessionInspectorSnapshot = useMemo(
    () => nativeDocumentInspectorSnapshotFromBlocks(blocks),
    [blocks],
  );
  const outline = liveInspectorSnapshot?.outline ?? sessionInspectorSnapshot.outline;
  const stats = liveInspectorSnapshot?.stats ?? sessionInspectorSnapshot.stats;
  const askDocumentBlocks = liveInspectorSnapshot?.blocks ?? blocks;
  const askDocumentText = useMemo(
    () => nativeDocumentPlainTextFromBlocks(askDocumentBlocks),
    [askDocumentBlocks],
  );
  const anchorDecorations = useMemo(
    () =>
      nativeDocumentAnchorDecorationsFromRecords({
        comments: openCommentsQuery.data ?? [],
        suggestions: pendingSuggestionsQuery.data ?? [],
      }),
    [openCommentsQuery.data, pendingSuggestionsQuery.data],
  );

  useEffect(() => {
    if (session === undefined) {
      return undefined;
    }
    return platformHost.registerCommandPaletteItems([
      {
        id: `docs:${session.document.id}:ask`,
        pluginId: "com.helix.docs",
        label: "Ask this document",
        group: "Document",
        keywords: ["ask", "ai", "question", session.document.title],
        shortcut: "Docs",
        order: 10,
        run: () => focusNativeDocumentControl("native-document-ask-question"),
      },
      {
        id: `docs:${session.document.id}:find`,
        pluginId: "com.helix.docs",
        label: "Find in document",
        group: "Document",
        keywords: ["search", "find", session.document.title],
        shortcut: "⌘F",
        order: 20,
        run: () => dispatchNativeDocumentCommand({ command: "find" }),
      },
      {
        id: `docs:${session.document.id}:toc`,
        pluginId: "com.helix.docs",
        label: "Insert table of contents",
        group: "Document",
        keywords: ["toc", "outline", "contents"],
        order: 30,
        run: () => dispatchNativeDocumentCommand({ command: "insert-toc" }),
      },
      {
        id: `docs:${session.document.id}:bookmark`,
        pluginId: "com.helix.docs",
        label: "Insert bookmark",
        group: "Document",
        keywords: ["bookmark", "reference", "anchor"],
        order: 35,
        run: () => dispatchNativeDocumentCommand({ command: "insert-bookmark" }),
      },
      {
        id: `docs:${session.document.id}:refresh-fields`,
        pluginId: "com.helix.docs",
        label: "Refresh document fields",
        group: "Document",
        keywords: ["fields", "date", "author", "property"],
        order: 40,
        run: () => dispatchNativeDocumentCommand({ command: "refresh-fields" }),
      },
      ...(["person", "doc", "event"] as const).map((kind, index) => ({
        id: `docs:${session.document.id}:chip:${kind}`,
        pluginId: "com.helix.docs",
        label: `Insert @${kind} smart chip`,
        group: "Document",
        keywords: ["smart chip", "chip", `@${kind}`],
        order: 50 + index,
        run: () => dispatchNativeDocumentCommand({ command: "insert-smart-chip", kind }),
      })),
      {
        id: `docs:${session.document.id}:comments`,
        pluginId: "com.helix.docs",
        label: "Jump to document comments",
        group: "Document",
        keywords: ["comments", "review"],
        order: 70,
        run: () => focusNativeDocumentControl("native-document-comments-panel"),
      },
      {
        id: `docs:${session.document.id}:suggestions`,
        pluginId: "com.helix.docs",
        label: "Jump to document suggestions",
        group: "Document",
        keywords: ["suggestions", "tracked changes", "review"],
        order: 80,
        run: () => focusNativeDocumentControl("native-document-suggestions-panel"),
      },
      {
        id: `docs:${session.document.id}:versions`,
        pluginId: "com.helix.docs",
        label: "Jump to version history",
        group: "Document",
        keywords: ["versions", "history", "restore"],
        order: 90,
        run: () => focusNativeDocumentControl("native-document-versions-panel"),
      },
      {
        id: `docs:${session.document.id}:export-docx`,
        pluginId: "com.helix.docs",
        label: "Export document as DOCX",
        group: "Document",
        keywords: ["export", "download", "word"],
        order: 100,
        run: () => exportMutation.mutate("docx"),
      },
      {
        id: `docs:${session.document.id}:export-pdf`,
        pluginId: "com.helix.docs",
        label: "Export document as PDF",
        group: "Document",
        keywords: ["export", "download", "pdf"],
        order: 110,
        run: () => exportMutation.mutate("pdf"),
      },
      {
        id: `docs:${session.document.id}:export-epub`,
        pluginId: "com.helix.docs",
        label: "Export document as EPUB",
        group: "Document",
        keywords: ["export", "download", "epub"],
        order: 120,
        run: () => exportMutation.mutate("epub"),
      },
      {
        id: `docs:${session.document.id}:print`,
        pluginId: "com.helix.docs",
        label: "Print document",
        group: "Document",
        keywords: ["print"],
        order: 130,
        run: () => window.print(),
      },
    ]);
  }, [exportMutation, platformHost, session]);

  function updateLayoutSettings(layoutSettings: NativeDocumentLayoutSettings) {
    const section = primaryNativeDocumentSection(layoutSettings);
    setLayoutMode(layoutSettings.layoutMode);
    setColumnCount(layoutSettings.columnCount);
    setSectionPageSize(section.pageSize);
    setSectionOrientation(section.orientation);
    setLayoutSections(layoutSettings.sections ?? []);
    layoutMutation.mutate(layoutSettings);
  }

  if (sessionQuery.isLoading) {
    return (
      <NativeDocumentFrame title="Loading..." status="Opening">
        <DocumentPageSkeleton />
      </NativeDocumentFrame>
    );
  }

  if (sessionQuery.isError || session === undefined) {
    return (
      <NativeDocumentFrame title="Document" status="Unavailable">
        <div style={EMPTY_STATE_STYLE}>
          <div style={EMPTY_STATE_TITLE_STYLE}>Could not open this document.</div>
          <div style={EMPTY_STATE_BODY_STYLE}>
            {sessionQuery.error instanceof Error
              ? sessionQuery.error.message
              : "The document session could not be loaded."}
          </div>
          <Link to="/docs" className="btn sm">
            Back to Docs
          </Link>
        </div>
      </NativeDocumentFrame>
    );
  }

  return (
    <NativeDocumentFrame
      title={
        <NativeDocumentTitleEditor
          title={session.document.title}
          disabled={titleMutation.isPending}
          error={titleMutation.error instanceof Error ? titleMutation.error.message : null}
          onResetError={() => titleMutation.reset()}
          onSave={(title) => titleMutation.mutateAsync(title)}
        />
      }
      status={
        titleMutation.isPending
          ? "Renaming"
          : titleMutation.isError
            ? "Rename failed"
            : layoutMutation.isPending
              ? "Saving layout"
              : layoutMutation.isError
                ? "Layout save failed"
                : "Connected"
      }
      actions={
        <>
          <div style={TOOLBAR_SEGMENT_STYLE} aria-label="Document layout">
            <button
              className={layoutMode === "page" ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={layoutMode === "page"}
              onClick={() => {
                updateLayoutSettings(
                  nativeDocumentLayoutSettingsFromState(
                    "page",
                    columnCount,
                    sectionPageSize,
                    sectionOrientation,
                    layoutSections,
                  ),
                );
              }}
            >
              <Icons.Doc />
              Page
            </button>
            <button
              className={layoutMode === "pageless" ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={layoutMode === "pageless"}
              onClick={() => {
                updateLayoutSettings(
                  nativeDocumentLayoutSettingsFromState(
                    "pageless",
                    columnCount,
                    sectionPageSize,
                    sectionOrientation,
                    layoutSections,
                  ),
                );
              }}
            >
              <Icons.Doc />
              Pageless
            </button>
          </div>
          <div style={TOOLBAR_SEGMENT_STYLE} aria-label="Document columns">
            <button
              className={columnCount === 1 ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={columnCount === 1}
              onClick={() => {
                updateLayoutSettings(
                  nativeDocumentLayoutSettingsFromState(
                    layoutMode,
                    1,
                    sectionPageSize,
                    sectionOrientation,
                    layoutSections,
                  ),
                );
              }}
            >
              <Icons.Grid />1 col
            </button>
            <button
              className={columnCount === 2 ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={columnCount === 2}
              onClick={() => {
                updateLayoutSettings(
                  nativeDocumentLayoutSettingsFromState(
                    layoutMode,
                    2,
                    sectionPageSize,
                    sectionOrientation,
                    layoutSections,
                  ),
                );
              }}
            >
              <Icons.Grid />2 col
            </button>
          </div>
          <label style={TOOLBAR_FIELD_STYLE}>
            <span className="sr-only">Section page size</span>
            <select
              aria-label="Section page size"
              className="btn sm"
              value={sectionPageSize}
              onChange={(event) => {
                const pageSize = event.target.value === "a4" ? "a4" : "letter";
                updateLayoutSettings(
                  nativeDocumentLayoutSettingsFromState(
                    layoutMode,
                    columnCount,
                    pageSize,
                    sectionOrientation,
                    layoutSections,
                  ),
                );
              }}
            >
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </select>
          </label>
          <div style={TOOLBAR_SEGMENT_STYLE} aria-label="Section orientation">
            <button
              className={sectionOrientation === "portrait" ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={sectionOrientation === "portrait"}
              onClick={() => {
                updateLayoutSettings(
                  nativeDocumentLayoutSettingsFromState(
                    layoutMode,
                    columnCount,
                    sectionPageSize,
                    "portrait",
                    layoutSections,
                  ),
                );
              }}
            >
              <Icons.Doc />
              Portrait
            </button>
            <button
              className={sectionOrientation === "landscape" ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={sectionOrientation === "landscape"}
              onClick={() => {
                updateLayoutSettings(
                  nativeDocumentLayoutSettingsFromState(
                    layoutMode,
                    columnCount,
                    sectionPageSize,
                    "landscape",
                    layoutSections,
                  ),
                );
              }}
            >
              <Icons.Doc />
              Landscape
            </button>
          </div>
          <button
            className="btn sm"
            type="button"
            aria-pressed={printPreview}
            onClick={() => {
              setPrintPreview((current) => !current);
            }}
          >
            <Icons.Eye />
            Preview
          </button>
          <button
            className="btn sm"
            type="button"
            onClick={() => {
              window.print();
            }}
          >
            <Icons.Print />
            Print
          </button>
          <button
            className="btn sm"
            type="button"
            disabled={exportMutation.isPending}
            onClick={() => {
              exportMutation.mutate("docx");
            }}
          >
            <Icons.Download />
            DOCX
          </button>
          <button
            className="btn sm"
            type="button"
            disabled={exportMutation.isPending}
            onClick={() => {
              exportMutation.mutate("pdf");
            }}
          >
            <Icons.Download />
            PDF
          </button>
          <button
            className="btn sm"
            type="button"
            disabled={exportMutation.isPending}
            onClick={() => {
              exportMutation.mutate("epub");
            }}
          >
            <Icons.Download />
            EPUB
          </button>
        </>
      }
    >
      <main style={PAGE_WRAP_STYLE}>
        <div
          className={
            printPreview
              ? "native-document-workspace native-document-workspace--print-preview"
              : "native-document-workspace"
          }
          style={DOCUMENT_WORKSPACE_STYLE}
        >
          <article
            className={`native-document-page native-document-page--${layoutMode}`}
            data-layout-mode={layoutMode}
            data-column-count={String(columnCount)}
            style={nativeDocumentPageStyle(layoutMode)}
            aria-label={session.document.title}
          >
            <header style={PAGE_HEADER_STYLE}>
              <p style={EYEBROW_STYLE}>{session.document.editorEngine}</p>
              <h1 style={TITLE_STYLE}>{session.document.title}</h1>
            </header>
            <dl
              className="native-document-session-facts"
              style={SESSION_GRID_STYLE}
              aria-label="Document session"
            >
              <SessionFact label="Format" value={`v${String(session.document.formatVersion)}`} />
              <SessionFact label="Updates" value={String(session.document.updateSeq)} />
              <SessionFact label="Sync" value={session.sync.protocol.toUpperCase()} />
              <SessionFact
                label="State"
                value={session.document.stateBase64 === null ? "Empty" : "Loaded"}
              />
            </dl>
            <Suspense fallback={<DocumentBlocks blocks={blocks} columnCount={columnCount} />}>
              <NativeDocumentEditor
                session={session}
                anchorDecorations={anchorDecorations}
                columnCount={columnCount}
                onInspectorSnapshotChange={setLiveInspectorSnapshot}
                onSelectionAnchorChange={setSelectionAnchor}
              />
            </Suspense>
          </article>
          <aside
            className="native-document-side-rail"
            style={SIDE_RAIL_STYLE}
            aria-label="Document side rail"
          >
            <DocumentInspector outline={outline} stats={stats} />
            <NativeDocumentAskPanel
              documentId={session.document.id}
              documentBlocks={askDocumentBlocks}
              documentText={askDocumentText}
              selectionAnchor={selectionAnchor}
            />
            <NativeDocumentSuggestionsRail
              documentId={session.document.id}
              formatVersion={session.document.formatVersion}
              selectionAnchor={selectionAnchor}
            />
            <NativeDocumentVersionsRail documentId={session.document.id} />
            <NativeDocumentCommentsRail
              documentId={session.document.id}
              formatVersion={session.document.formatVersion}
              selectionAnchor={selectionAnchor}
            />
          </aside>
        </div>
      </main>
    </NativeDocumentFrame>
  );
}

export function nativeDocumentAnchorDecorationsFromRecords(input: {
  readonly comments: readonly Pick<DocsComment, "id" | "anchor">[];
  readonly suggestions: readonly Pick<DocsSuggestion, "id" | "anchor">[];
}): readonly NativeDocumentAnchorDecoration[] {
  const decorations: NativeDocumentAnchorDecoration[] = [];
  for (const comment of input.comments) {
    const decoration = nativeDocumentAnchorDecorationFromRecord({
      id: comment.id,
      kind: "comment",
      anchor: comment.anchor,
    });
    if (decoration !== null) {
      decorations.push(decoration);
    }
  }
  for (const suggestion of input.suggestions) {
    const decoration = nativeDocumentAnchorDecorationFromRecord({
      id: suggestion.id,
      kind: "suggestion",
      anchor: suggestion.anchor,
    });
    if (decoration !== null) {
      decorations.push(decoration);
    }
  }
  return decorations;
}

function dispatchNativeDocumentCommand(detail: NativeDocumentCommandEventDetail): void {
  window.dispatchEvent(new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail }));
}

function focusNativeDocumentControl(id: string): void {
  const element = document.getElementById(id);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    element.focus();
  }
}

function formatAskHistoryTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "recent";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function downloadDocsExport(exported: {
  readonly filename: string;
  readonly mimeType: string;
  readonly contentBase64: string;
}): void {
  const blob = new Blob([base64ToArrayBuffer(exported.contentBase64)], {
    type: exported.mimeType,
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = exported.filename;
  link.rel = "noopener";
  link.click();
  URL.revokeObjectURL(url);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function NativeDocumentFrame({
  title,
  status,
  actions,
  children,
}: {
  readonly title: ReactNode;
  readonly status: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div style={SHELL_STYLE}>
      <header className="native-document-toolbar" style={TOOLBAR_STYLE}>
        <Link to="/docs" className="btn sm" aria-label="Back to Docs">
          <Icons.ArrowLeft />
        </Link>
        <div style={TITLE_WRAP_STYLE}>
          <div style={TOOLBAR_TITLE_SLOT_STYLE}>{title}</div>
          <div style={TOOLBAR_STATUS_STYLE}>{status}</div>
        </div>
        {actions === undefined ? null : <div style={TOOLBAR_ACTIONS_STYLE}>{actions}</div>}
      </header>
      {children}
    </div>
  );
}

function NativeDocumentTitleEditor({
  title,
  disabled,
  error,
  onResetError,
  onSave,
}: {
  readonly title: string;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onResetError: () => void;
  readonly onSave: (title: string) => Promise<unknown>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const normalizedTitle = draftTitle.trim();
  const canSave = normalizedTitle.length > 0 && normalizedTitle !== title && !disabled;

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(title);
    }
  }, [isEditing, title]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (normalizedTitle.length === 0) {
      return;
    }
    if (normalizedTitle === title) {
      setIsEditing(false);
      return;
    }
    try {
      await onSave(normalizedTitle);
      setIsEditing(false);
    } catch {
      // The mutation state renders the error inline and keeps the draft open.
    }
  }

  if (isEditing) {
    return (
      <form style={TITLE_FORM_STYLE} onSubmit={(event) => void handleSubmit(event)}>
        <input
          aria-label="Document title"
          value={draftTitle}
          disabled={disabled}
          maxLength={255}
          onChange={(event) => {
            setDraftTitle(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setDraftTitle(title);
              setIsEditing(false);
              onResetError();
            }
          }}
          style={TITLE_INPUT_STYLE}
        />
        <button className="btn sm primary" type="submit" disabled={!canSave}>
          Save
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={disabled}
          onClick={() => {
            setDraftTitle(title);
            setIsEditing(false);
            onResetError();
          }}
        >
          Cancel
        </button>
        {error === null ? null : (
          <span role="status" style={TITLE_ERROR_STYLE}>
            {error}
          </span>
        )}
      </form>
    );
  }

  return (
    <div style={TITLE_DISPLAY_STYLE}>
      <span className="truncate" style={TOOLBAR_TITLE_STYLE}>
        {title}
      </span>
      <button
        className="btn sm"
        type="button"
        aria-label="Rename document"
        onClick={() => {
          onResetError();
          setDraftTitle(title);
          setIsEditing(true);
        }}
      >
        <Icons.EditPen />
        Rename
      </button>
    </div>
  );
}

function DocumentPageSkeleton() {
  return (
    <main style={PAGE_WRAP_STYLE}>
      <article style={PAGE_STYLE} aria-label="Loading document">
        <div style={{ ...SKELETON_STYLE, width: "40%", height: 18 }} />
        <div style={{ ...SKELETON_STYLE, width: "70%", height: 34, marginTop: 18 }} />
        <div style={{ ...SKELETON_STYLE, width: "100%", height: 12, marginTop: 42 }} />
        <div style={{ ...SKELETON_STYLE, width: "92%", height: 12, marginTop: 14 }} />
        <div style={{ ...SKELETON_STYLE, width: "80%", height: 12, marginTop: 14 }} />
      </article>
    </main>
  );
}

function SessionFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={SESSION_FACT_STYLE}>
      <dt style={SESSION_LABEL_STYLE}>{label}</dt>
      <dd style={SESSION_VALUE_STYLE}>{value}</dd>
    </div>
  );
}

function DocumentInspector({
  outline,
  stats,
}: {
  readonly outline: readonly NativeDocumentOutlineItem[];
  readonly stats: NativeDocumentStats;
}) {
  return (
    <section
      id="native-document-outline-panel"
      style={INSPECTOR_STYLE}
      aria-label="Document outline and stats"
      tabIndex={-1}
    >
      <section style={INSPECTOR_SECTION_STYLE}>
        <h2 style={INSPECTOR_TITLE_STYLE}>Outline</h2>
        {outline.length === 0 ? (
          <p style={INSPECTOR_EMPTY_STYLE}>No headings</p>
        ) : (
          <ol style={OUTLINE_LIST_STYLE}>
            {outline.map((item) => (
              <li
                key={item.id}
                style={{ ...OUTLINE_ITEM_STYLE, paddingLeft: (item.level - 1) * 10 }}
              >
                <a href={`#${item.id}`} style={OUTLINE_LINK_STYLE}>
                  {item.title}
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section style={INSPECTOR_SECTION_STYLE}>
        <h2 style={INSPECTOR_TITLE_STYLE}>Stats</h2>
        <dl style={STATS_GRID_STYLE}>
          <SessionFact label="Words" value={String(stats.wordCount)} />
          <SessionFact label="Characters" value={String(stats.characterCount)} />
          <SessionFact label="Blocks" value={String(stats.blockCount)} />
          <SessionFact label="Headings" value={String(stats.headingCount)} />
        </dl>
      </section>
    </section>
  );
}

function NativeDocumentAskPanel({
  documentId,
  documentBlocks,
  documentText,
  selectionAnchor,
}: {
  readonly documentId: string;
  readonly documentBlocks: readonly NativeDocumentBlock[];
  readonly documentText: string;
  readonly selectionAnchor: NativeDocumentSelectionAnchor | null;
}) {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<DocsAskHistoryItem | null>(null);
  const historyQuery = useQuery(docsAskHistoryQueryOptions(documentId));
  useEffect(() => {
    setAnswer(null);
  }, [documentId]);
  const sourceText = selectionAnchor?.text.trim() || documentText.trim();
  const scopedToSelection = selectionAnchor !== null && selectionAnchor.text.trim().length > 0;
  const sourceCitations = useMemo(
    () => nativeDocumentAskCitationsFromSource({ blocks: documentBlocks, selectionAnchor }),
    [documentBlocks, selectionAnchor],
  );
  const askMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: (input: {
      readonly question: string;
      readonly sourceText: string;
      readonly bodyText: string;
      readonly sourceScope: "document" | "selection";
      readonly citations: readonly DocsAskCitation[];
    }) =>
      answerDocsQuestion({
        docId: documentId,
        question: input.question,
        selection: input.sourceText,
        body: input.bodyText,
        sourceScope: input.sourceScope,
        citations: input.citations,
      }),
    onSuccess: (historyItem) => {
      setAnswer(historyItem);
      queryClient.setQueryData<readonly DocsAskHistoryItem[]>(
        docsQueryKeys.askHistory(documentId),
        (current = []) => [historyItem, ...current.filter((item) => item.id !== historyItem.id)],
      );
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.askHistory(documentId) });
    },
  });
  const clearHistoryMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => clearDocsAskHistory({ docId: documentId }),
    onSuccess: () => {
      setAnswer(null);
      queryClient.setQueryData(docsQueryKeys.askHistory(documentId), []);
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.askHistory(documentId) });
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (question.trim().length === 0 || sourceText.length === 0 || askMutation.isPending) {
      return;
    }
    askMutation.mutate({
      question: question.trim(),
      sourceText,
      bodyText: documentText.trim(),
      sourceScope: scopedToSelection ? "selection" : "document",
      citations: sourceCitations,
    });
  };

  const clearHistory = () => {
    if (!clearHistoryMutation.isPending) {
      clearHistoryMutation.mutate();
    }
  };
  const history = historyQuery.data ?? [];

  return (
    <section
      id="native-document-ask-panel"
      style={INSPECTOR_SECTION_STYLE}
      aria-label="Ask this document"
      tabIndex={-1}
    >
      <div style={ASK_HEADER_STYLE}>
        <h2 style={INSPECTOR_TITLE_STYLE}>Ask this document</h2>
        <span style={ASK_SCOPE_STYLE}>{scopedToSelection ? "Selection" : "Document"}</span>
      </div>
      <form style={ASK_FORM_STYLE} onSubmit={onSubmit}>
        <label style={ASK_LABEL_STYLE} htmlFor="native-document-ask-question">
          Question
        </label>
        <textarea
          id="native-document-ask-question"
          value={question}
          rows={3}
          onChange={(event) => {
            setQuestion(event.currentTarget.value);
          }}
          style={ASK_TEXTAREA_STYLE}
        />
        <button
          className="btn primary sm"
          type="submit"
          disabled={
            question.trim().length === 0 || sourceText.length === 0 || askMutation.isPending
          }
        >
          <Icons.Sparkles />
          {askMutation.isPending ? "Asking..." : "Ask"}
        </button>
      </form>
      {sourceText.length === 0 ? (
        <p style={ASK_HELP_STYLE}>Document text is empty.</p>
      ) : scopedToSelection ? (
        <p style={ASK_HELP_STYLE}>Using selected text: {selectionAnchor.text}</p>
      ) : null}
      {askMutation.isError ? <p style={ASK_ERROR_STYLE}>Could not answer this question.</p> : null}
      {answer === null ? null : (
        <article style={ASK_ANSWER_STYLE} aria-label="Document answer">
          <p style={ASK_ANSWER_TEXT_STYLE}>{answer.answer}</p>
          <AnswerCitations documentId={documentId} item={answer} />
        </article>
      )}
      {history.length === 0 ? null : (
        <section style={ASK_HISTORY_STYLE} aria-label="Ask this document history">
          <div style={ASK_HISTORY_HEADER_STYLE}>
            <h3 style={ASK_HISTORY_TITLE_STYLE}>Recent answers</h3>
            <button className="btn ghost sm" type="button" onClick={clearHistory}>
              <Icons.Trash />
              Clear
            </button>
          </div>
          <ol style={ASK_HISTORY_LIST_STYLE}>
            {history.map((item) => (
              <li key={item.id} style={ASK_HISTORY_ITEM_STYLE}>
                <button
                  type="button"
                  style={ASK_HISTORY_BUTTON_STYLE}
                  onClick={() => {
                    setAnswer(item);
                    setQuestion(item.question);
                  }}
                >
                  <span style={ASK_HISTORY_QUESTION_STYLE}>{item.question}</span>
                  <span style={ASK_HISTORY_META_STYLE}>
                    {item.sourceScope === "selection" ? "Selection" : "Document"} -{" "}
                    {formatAskHistoryTime(item.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}

function AnswerCitations({
  documentId,
  item,
}: {
  readonly documentId: string;
  readonly item: DocsAskHistoryItem;
}) {
  const citations = nativeDocumentAskCitationsFromHistory(item);
  return (
    <footer style={ASK_CITATION_STYLE}>
      <span style={ASK_CITATION_TITLE_STYLE}>Sources</span>
      <ol style={ASK_CITATION_LIST_STYLE}>
        {citations.map((citation, index) => {
          const selection = citation.selection;
          return (
            <li key={`${citation.label}-${String(index)}`} style={ASK_CITATION_ITEM_STYLE}>
              {selection === undefined ? (
                <span>
                  <strong>{citation.label}</strong>: {citation.excerpt}
                </span>
              ) : (
                <button
                  type="button"
                  style={ASK_CITATION_BUTTON_STYLE}
                  onClick={() => {
                    dispatchNativeDocumentAnchorSelection({
                      documentId,
                      selection,
                    });
                  }}
                >
                  <strong>{citation.label}</strong>: {citation.excerpt}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </footer>
  );
}

function nativeDocumentAskCitationsFromSource(input: {
  readonly blocks: readonly NativeDocumentBlock[];
  readonly selectionAnchor: NativeDocumentSelectionAnchor | null;
}): readonly DocsAskCitation[] {
  const selectedText = input.selectionAnchor?.text.trim();
  if (
    input.selectionAnchor !== null &&
    selectedText !== undefined &&
    selectedText.length > 0 &&
    input.selectionAnchor.to > input.selectionAnchor.from
  ) {
    return [
      {
        label: "Selected text",
        excerpt: nativeDocumentAskExcerpt(selectedText),
        sourceScope: "selection",
        selection: {
          from: input.selectionAnchor.from,
          to: input.selectionAnchor.to,
          text: input.selectionAnchor.text,
        },
      },
    ];
  }
  const citations: DocsAskCitation[] = [];
  collectNativeDocumentAskBlockCitations(input.blocks, citations, "Document");
  return citations.slice(0, 3);
}

function collectNativeDocumentAskBlockCitations(
  blocks: readonly NativeDocumentBlock[],
  citations: DocsAskCitation[],
  currentSection: string,
): void {
  let section = currentSection;
  for (const block of blocks) {
    if (citations.length >= 3) {
      return;
    }
    if (block.kind === "heading") {
      const heading = block.text.trim();
      if (heading.length > 0) {
        section = heading;
        citations.push({
          label: `Heading: ${heading}`,
          excerpt: nativeDocumentAskExcerpt(heading),
          sourceScope: "document",
        });
      }
      continue;
    }
    if (block.kind === "bulletList" || block.kind === "orderedList") {
      collectNativeDocumentAskBlockCitations(block.items, citations, section);
      continue;
    }
    if (block.kind === "listItem") {
      const text = block.text.trim();
      if (text.length > 0) {
        citations.push({
          label: section,
          excerpt: nativeDocumentAskExcerpt(text),
          sourceScope: "document",
        });
      }
      collectNativeDocumentAskBlockCitations(block.items, citations, section);
      continue;
    }
    const text = block.text.trim();
    if (text.length > 0) {
      citations.push({
        label: section,
        excerpt: nativeDocumentAskExcerpt(text),
        sourceScope: "document",
      });
    }
  }
}

function nativeDocumentAskCitationsFromHistory(
  item: DocsAskHistoryItem,
): readonly DocsAskCitation[] {
  if (item.citations !== undefined && item.citations.length > 0) {
    return item.citations;
  }
  const rawCitations = item.metadata.citations;
  if (Array.isArray(rawCitations)) {
    const citations = rawCitations.flatMap((raw) => nativeDocumentAskCitationFromValue(raw));
    if (citations.length > 0) {
      return citations;
    }
  }
  return [
    {
      label: item.sourceScope === "selection" ? "Selected text" : "Document",
      excerpt: item.sourceExcerpt,
      sourceScope: item.sourceScope,
    },
  ];
}

function nativeDocumentAskCitationFromValue(value: unknown): readonly DocsAskCitation[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.label !== "string" ||
    typeof record.excerpt !== "string" ||
    (record.sourceScope !== "document" && record.sourceScope !== "selection")
  ) {
    return [];
  }
  const selection = nativeDocumentAskSelectionFromValue(record.selection);
  const label = nativeDocumentAskExcerpt(record.label);
  const excerpt = nativeDocumentAskExcerpt(record.excerpt);
  if (label.length === 0 || excerpt.length === 0) {
    return [];
  }
  return [
    {
      label,
      excerpt,
      sourceScope: record.sourceScope,
      ...(selection === null ? {} : { selection }),
    },
  ];
}

function nativeDocumentAskSelectionFromValue(value: unknown): NativeDocumentSelectionAnchor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.from !== "number" ||
    typeof record.to !== "number" ||
    typeof record.text !== "string" ||
    !Number.isSafeInteger(record.from) ||
    !Number.isSafeInteger(record.to) ||
    record.to <= record.from ||
    record.text.trim().length === 0
  ) {
    return null;
  }
  return { from: record.from, to: record.to, text: record.text };
}

function nativeDocumentAskExcerpt(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function DocumentBlocks({
  blocks,
  columnCount = 1,
}: {
  readonly blocks: readonly NativeDocumentBlock[];
  readonly columnCount?: NativeDocumentColumnCount;
}) {
  const headingCounter = { value: 0 };
  return (
    <section style={nativeDocumentBodyStyle(columnCount)} aria-label="Document body">
      {blocks.map((block, index) => (
        <DocumentBlockView
          key={`${block.kind}-${String(index)}`}
          block={block}
          headingCounter={headingCounter}
        />
      ))}
    </section>
  );
}

function DocumentBlockView({
  block,
  headingCounter,
}: {
  readonly block: NativeDocumentBlock;
  readonly headingCounter: { value: number };
}) {
  if (block.kind === "heading") {
    const HeadingTag = headingTag(block.level);
    const hasTitle = block.text.trim().length > 0;
    const headingId = hasTitle ? `heading-${String(headingCounter.value + 1)}` : undefined;
    if (hasTitle) {
      headingCounter.value += 1;
    }
    return (
      <HeadingTag
        {...(headingId === undefined ? {} : { id: headingId, tabIndex: -1 })}
        style={DOCUMENT_HEADING_STYLE}
      >
        {block.text}
      </HeadingTag>
    );
  }
  if (block.kind === "codeBlock") {
    return <pre style={DOCUMENT_CODE_STYLE}>{block.text}</pre>;
  }
  if (block.kind === "bulletList") {
    return (
      <ul style={DOCUMENT_LIST_STYLE}>
        {block.items.map((item, index) => (
          <DocumentListItem
            key={`bullet-${String(index)}`}
            block={item}
            headingCounter={headingCounter}
          />
        ))}
      </ul>
    );
  }
  if (block.kind === "orderedList") {
    return (
      <ol style={DOCUMENT_LIST_STYLE}>
        {block.items.map((item, index) => (
          <DocumentListItem
            key={`ordered-${String(index)}`}
            block={item}
            headingCounter={headingCounter}
          />
        ))}
      </ol>
    );
  }
  if (block.kind === "listItem") {
    return <DocumentListItem block={block} headingCounter={headingCounter} />;
  }
  return <p style={DOCUMENT_PARAGRAPH_STYLE}>{block.text}</p>;
}

function DocumentListItem({
  block,
  headingCounter,
}: {
  readonly block: NativeDocumentBlock;
  readonly headingCounter: { value: number };
}) {
  if (block.kind === "listItem") {
    const nestedBlocks = block.items.filter((item) => item.kind !== "paragraph");
    const text = block.text.length > 0 ? block.text : " ";
    return (
      <li style={DOCUMENT_LIST_ITEM_STYLE}>
        {text}
        {nestedBlocks.map((item, index) => (
          <DocumentBlockView
            key={`nested-${String(index)}`}
            block={item}
            headingCounter={headingCounter}
          />
        ))}
      </li>
    );
  }
  return (
    <li style={DOCUMENT_LIST_ITEM_STYLE}>
      <DocumentBlockView block={block} headingCounter={headingCounter} />
    </li>
  );
}

function headingTag(level: number): "h2" | "h3" | "h4" {
  if (level <= 1) {
    return "h2";
  }
  if (level === 2) {
    return "h3";
  }
  return "h4";
}

function nativeDocumentPageStyle(layoutMode: NativeDocumentLayoutMode): CSSProperties {
  return {
    ...PAGE_STYLE,
    ...(layoutMode === "pageless" ? PAGELESS_PAGE_STYLE : {}),
  };
}

function nativeDocumentBodyStyle(columnCount: NativeDocumentColumnCount): CSSProperties {
  return {
    ...DOCUMENT_BODY_STYLE,
    ...(columnCount === 2 ? TWO_COLUMN_DOCUMENT_BODY_STYLE : {}),
  };
}

function primaryNativeDocumentSection(layoutSettings: NativeDocumentLayoutSettings): {
  readonly pageSize: NativeDocumentPageSize;
  readonly orientation: NativeDocumentOrientation;
} {
  const section = layoutSettings.sections?.[0];
  return {
    pageSize: section?.pageSize === "a4" ? "a4" : "letter",
    orientation: section?.orientation === "landscape" ? "landscape" : "portrait",
  };
}

function nativeDocumentLayoutSettingsFromState(
  layoutMode: NativeDocumentLayoutMode,
  columnCount: NativeDocumentColumnCount,
  pageSize: NativeDocumentPageSize,
  orientation: NativeDocumentOrientation,
  sections: readonly NativeDocumentSectionSettings[],
): NativeDocumentLayoutSettings {
  const [primarySection, ...restSections] = sections;
  return {
    layoutMode,
    columnCount,
    sections: [
      {
        ...primarySection,
        id: "default",
        title: primarySection?.title ?? "Document",
        layoutMode,
        columnCount,
        pageSize,
        orientation,
      },
      ...restSections,
    ],
  };
}

const SHELL_STYLE = {
  display: "flex",
  minHeight: "100%",
  flexDirection: "column",
  background: "var(--bg)",
} satisfies CSSProperties;

const TOOLBAR_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minHeight: 56,
  padding: "8px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
} satisfies CSSProperties;

const TITLE_WRAP_STYLE = {
  display: "grid",
  flex: 1,
  minWidth: 0,
  gap: 2,
} satisfies CSSProperties;

const TOOLBAR_ACTIONS_STYLE = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginLeft: "auto",
} satisfies CSSProperties;

const TOOLBAR_SEGMENT_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: 2,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const TOOLBAR_FIELD_STYLE = {
  display: "inline-flex",
  alignItems: "center",
} satisfies CSSProperties;

const TOOLBAR_TITLE_STYLE = {
  fontSize: "var(--text-body)",
  fontWeight: 600,
  color: "var(--text-1)",
} satisfies CSSProperties;

const TOOLBAR_TITLE_SLOT_STYLE = {
  minWidth: 0,
} satisfies CSSProperties;

const TITLE_DISPLAY_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  maxWidth: "100%",
} satisfies CSSProperties;

const TITLE_FORM_STYLE = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  minWidth: 0,
  maxWidth: "100%",
} satisfies CSSProperties;

const TITLE_INPUT_STYLE = {
  width: "min(320px, 100%)",
  minWidth: 180,
  height: 32,
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text-1)",
  font: "inherit",
  fontSize: "var(--text-body)",
  fontWeight: 600,
  padding: "0 10px",
} satisfies CSSProperties;

const TITLE_ERROR_STYLE = {
  color: "var(--danger)",
  fontSize: "var(--text-caption)",
  fontWeight: 600,
} satisfies CSSProperties;

const TOOLBAR_STATUS_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const PAGE_WRAP_STYLE = {
  display: "flex",
  flex: 1,
  justifyContent: "center",
  overflow: "auto",
  padding: "32px 16px",
} satisfies CSSProperties;

const DOCUMENT_WORKSPACE_STYLE = {
  display: "grid",
  alignItems: "start",
  gap: 16,
  width: "min(100%, 1140px)",
} satisfies CSSProperties;

const PAGE_STYLE = {
  width: "100%",
  maxWidth: 900,
  minHeight: 640,
  padding: "56px min(8vw, 72px)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  boxShadow: "0 18px 50px color-mix(in oklab, var(--text-1) 8%, transparent)",
} satisfies CSSProperties;

const PAGELESS_PAGE_STYLE = {
  maxWidth: "100%",
  minHeight: 0,
  border: "1px solid transparent",
  boxShadow: "none",
} satisfies CSSProperties;

const TWO_COLUMN_DOCUMENT_BODY_STYLE = {
  columnCount: 2,
  columnGap: 40,
} satisfies CSSProperties;

const PAGE_HEADER_STYLE = {
  display: "grid",
  gap: 8,
  marginBottom: 36,
} satisfies CSSProperties;

const EYEBROW_STYLE = {
  margin: 0,
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const TITLE_STYLE = {
  margin: 0,
  fontSize: "1.75rem",
  lineHeight: 1.25,
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const SESSION_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))",
  gap: 12,
  margin: 0,
} satisfies CSSProperties;

const SESSION_FACT_STYLE = {
  display: "grid",
  gap: 4,
  padding: 12,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const SESSION_LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const SESSION_VALUE_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  fontWeight: 600,
  color: "var(--text-1)",
} satisfies CSSProperties;

const INSPECTOR_STYLE = {
  display: "grid",
  gap: 16,
} satisfies CSSProperties;

const SIDE_RAIL_STYLE = {
  display: "grid",
  gap: 16,
  position: "sticky",
  top: 16,
} satisfies CSSProperties;

const INSPECTOR_SECTION_STYLE = {
  display: "grid",
  gap: 12,
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
} satisfies CSSProperties;

const INSPECTOR_TITLE_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const INSPECTOR_EMPTY_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const OUTLINE_LIST_STYLE = {
  display: "grid",
  gap: 8,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const OUTLINE_ITEM_STYLE = {
  fontSize: "var(--text-body-sm)",
  lineHeight: 1.35,
  color: "var(--text-2)",
} satisfies CSSProperties;

const OUTLINE_LINK_STYLE = {
  color: "inherit",
  textDecoration: "none",
} satisfies CSSProperties;

const STATS_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 8,
  margin: 0,
} satisfies CSSProperties;

const ASK_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} satisfies CSSProperties;

const ASK_SCOPE_STYLE = {
  flexShrink: 0,
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  color: "var(--text-3)",
} satisfies CSSProperties;

const ASK_FORM_STYLE = {
  display: "grid",
  gap: 8,
} satisfies CSSProperties;

const ASK_LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  color: "var(--text-2)",
} satisfies CSSProperties;

const ASK_TEXTAREA_STYLE = {
  width: "100%",
  minHeight: 84,
  resize: "vertical",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text-1)",
  font: "inherit",
  fontSize: "var(--text-body-sm)",
  lineHeight: 1.5,
  padding: 10,
} satisfies CSSProperties;

const ASK_HELP_STYLE = {
  margin: 0,
  fontSize: "var(--text-caption)",
  lineHeight: 1.45,
  color: "var(--text-3)",
} satisfies CSSProperties;

const ASK_ERROR_STYLE = {
  margin: 0,
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  color: "var(--danger)",
} satisfies CSSProperties;

const ASK_ANSWER_STYLE = {
  whiteSpace: "pre-wrap",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
  padding: 10,
  fontSize: "var(--text-body-sm)",
  lineHeight: 1.55,
  color: "var(--text-1)",
} satisfies CSSProperties;

const ASK_ANSWER_TEXT_STYLE = {
  margin: 0,
} satisfies CSSProperties;

const ASK_CITATION_STYLE = {
  marginTop: 8,
  paddingTop: 8,
  borderTop: "1px solid var(--border)",
  fontSize: "var(--text-caption)",
  lineHeight: 1.45,
  color: "var(--text-3)",
} satisfies CSSProperties;

const ASK_CITATION_TITLE_STYLE = {
  display: "block",
  marginBottom: 6,
  fontWeight: 700,
  color: "var(--text-2)",
} satisfies CSSProperties;

const ASK_CITATION_LIST_STYLE = {
  display: "grid",
  gap: 6,
  margin: 0,
  paddingLeft: 16,
} satisfies CSSProperties;

const ASK_CITATION_ITEM_STYLE = {
  margin: 0,
} satisfies CSSProperties;

const ASK_CITATION_BUTTON_STYLE = {
  padding: 0,
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: "inherit",
  lineHeight: "inherit",
  textAlign: "left",
  textDecoration: "underline",
  cursor: "pointer",
} satisfies CSSProperties;

const ASK_HISTORY_STYLE = {
  display: "grid",
  gap: 8,
} satisfies CSSProperties;

const ASK_HISTORY_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} satisfies CSSProperties;

const ASK_HISTORY_TITLE_STYLE = {
  margin: 0,
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  color: "var(--text-2)",
} satisfies CSSProperties;

const ASK_HISTORY_LIST_STYLE = {
  display: "grid",
  gap: 6,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const ASK_HISTORY_ITEM_STYLE = {
  minWidth: 0,
} satisfies CSSProperties;

const ASK_HISTORY_BUTTON_STYLE = {
  display: "grid",
  gap: 2,
  width: "100%",
  minHeight: 48,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  color: "var(--text-1)",
  textAlign: "left",
  cursor: "pointer",
} satisfies CSSProperties;

const ASK_HISTORY_QUESTION_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-body-sm)",
  fontWeight: 600,
} satisfies CSSProperties;

const ASK_HISTORY_META_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const DOCUMENT_BODY_STYLE = {
  display: "grid",
  gap: 14,
  marginTop: 36,
  color: "var(--text-1)",
} satisfies CSSProperties;

const DOCUMENT_HEADING_STYLE = {
  margin: "16px 0 0",
  scrollMarginTop: 72,
  fontSize: "1.25rem",
  lineHeight: 1.35,
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const DOCUMENT_PARAGRAPH_STYLE = {
  margin: 0,
  minHeight: 20,
  fontSize: "var(--text-body)",
  lineHeight: 1.7,
  color: "var(--text-2)",
} satisfies CSSProperties;

const DOCUMENT_LIST_STYLE = {
  margin: 0,
  paddingLeft: 24,
  display: "grid",
  gap: 8,
  fontSize: "var(--text-body)",
  lineHeight: 1.7,
  color: "var(--text-2)",
} satisfies CSSProperties;

const DOCUMENT_LIST_ITEM_STYLE = {
  paddingLeft: 4,
} satisfies CSSProperties;

const DOCUMENT_CODE_STYLE = {
  margin: 0,
  whiteSpace: "pre-wrap",
  overflowX: "auto",
  borderRadius: 6,
  padding: 12,
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-body-sm)",
  lineHeight: 1.6,
  color: "var(--text-1)",
} satisfies CSSProperties;

const EMPTY_STATE_STYLE = {
  display: "grid",
  justifyItems: "start",
  alignContent: "start",
  gap: 12,
  padding: 24,
} satisfies CSSProperties;

const EMPTY_STATE_TITLE_STYLE = {
  fontSize: "var(--text-body)",
  fontWeight: 600,
  color: "var(--text-1)",
} satisfies CSSProperties;

const EMPTY_STATE_BODY_STYLE = {
  maxWidth: 560,
  fontSize: "var(--text-body-sm)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const SKELETON_STYLE = {
  borderRadius: 6,
  background: "color-mix(in oklab, var(--text-3) 16%, transparent)",
} satisfies CSSProperties;
