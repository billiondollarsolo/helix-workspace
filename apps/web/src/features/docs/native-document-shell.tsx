import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { Link, useRouter } from "@tanstack/react-router";
import { useWebPlatformHost } from "@helix/sdk-web";
import {
  EditorAppBar,
  EditorSidePanel,
  EditorWorkspace,
  type EditorAppBarHandle,
  type SidePanelTab,
} from "@helix/editors-ui";
import { Edit3, History, List as ListIcon, MessageSquare, Sparkles } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Icons } from "@/components/icons";
import { trashDriveObject } from "@/features/drive/api";
import { DriveShareDialog } from "@/features/drive/drive-share-dialog";
import { driveQueryKeys } from "@/features/drive/queries";
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
import { NativeDocumentRuler, NativeDocumentVerticalRuler } from "./native-document-ruler";
import { NativeDocumentSuggestionsRail } from "./native-document-suggestions-rail";
import { NativeDocumentVersionsRail } from "./native-document-versions-rail";
import {
  answerDocsQuestion,
  clearDocsAskHistory,
  copyDocsDocument,
  createDocsDocument,
  exportDocsDocument,
  updateDocsTitle,
  type DocsAskHistoryItem,
  type DocsAskCitation,
  type DocsComment,
  type DocsExportFormat,
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
import {
  buildDocsMenus,
  buildDocsRibbon,
  type DocsChromeContext,
  type DocsDocumentMode,
  type DocsChromeEditorLike,
  type DocsParagraphStyle,
} from "./native-document-chrome";

const NativeDocumentEditor = lazy(() =>
  import("./native-document-editor").then((module) => ({
    default: module.NativeDocumentEditor,
  })),
);

type NativeDocumentLayoutMode = "page" | "pageless";
type NativeDocumentColumnCount = 1 | 2;
type NativeDocumentHelpDialog = "shortcuts" | "about";

const DEFAULT_NATIVE_DOCUMENT_LAYOUT_SETTINGS = {
  layoutMode: "page",
  columnCount: 1,
} as const;
const NATIVE_DOCUMENT_RULER_PREFERENCE_KEY = "helix.docs.showRulers";
const NATIVE_DOCUMENT_NONPRINTING_PREFERENCE_KEY = "helix.docs.showNonPrinting";
const NATIVE_DOCUMENT_MODE_PREFERENCE_KEY = "helix.docs.documentMode";

export interface NativeDocumentShellProps {
  readonly documentId: string;
}

export function NativeDocumentShell({ documentId }: NativeDocumentShellProps) {
  const queryClient = useQueryClient();
  const platformHost = useWebPlatformHost();
  const router = useTryRouter();
  const sessionQuery = useQuery(nativeDocumentSessionQueryOptions(documentId));
  const openCommentsQuery = useQuery(docsCommentsQueryOptions(documentId, "open"));
  const pendingSuggestionsQuery = useQuery(docsSuggestionsQueryOptions(documentId, "pending"));
  const invalidateDocumentVersions = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: docsQueryKeys.versions(documentId) });
  }, [documentId, queryClient]);
  const refreshDocumentVersions = useDebouncedCallback(invalidateDocumentVersions, {
    wait: 900,
  });
  const [layoutMode, setLayoutMode] = useState<NativeDocumentLayoutMode>("page");
  const [columnCount, setColumnCount] = useState<NativeDocumentColumnCount>(1);
  const [selectionAnchor, setSelectionAnchor] = useState<NativeDocumentSelectionAnchor | null>(
    null,
  );
  const lastEditorSelectionRef = useRef<{ readonly from: number; readonly to: number } | null>(
    null,
  );
  const appBarRef = useRef<EditorAppBarHandle | null>(null);
  const [liveInspectorSnapshot, setLiveInspectorSnapshot] =
    useState<NativeDocumentInspectorSnapshot | null>(null);
  // Default closed — matches Google Docs / Office where comments + side
  // panels stay tucked behind a toggle until the user opens them. Keeps the
  // editing surface as the primary focus.
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string>("comments");
  const [chromeEditor, setChromeEditor] = useState<DocsChromeEditorLike | null>(null);
  const [hasRecoveredDocumentDraft, setHasRecoveredDocumentDraft] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [helpDialog, setHelpDialog] = useState<NativeDocumentHelpDialog | null>(null);
  const [textColor, setTextColor] = useState<string>("#000000");
  const [highlightColor, setHighlightColor] = useState<string>("#fef08a");
  const [paragraphStyle, setParagraphStyle] = useState<DocsParagraphStyle>("paragraph");
  const [documentMode, setDocumentMode] = useState<DocsDocumentMode>(() =>
    nativeDocumentModeFromStorage(window.localStorage.getItem(NATIVE_DOCUMENT_MODE_PREFERENCE_KEY)),
  );
  const [showRulers, setShowRulers] = useState(
    () => window.localStorage.getItem(NATIVE_DOCUMENT_RULER_PREFERENCE_KEY) !== "false",
  );
  const [showNonPrintingCharacters, setShowNonPrintingCharacters] = useState(
    () => window.localStorage.getItem(NATIVE_DOCUMENT_NONPRINTING_PREFERENCE_KEY) === "true",
  );
  const updateLastEditorSelection = useCallback(
    (range: { readonly from: number; readonly to: number } | null) => {
      lastEditorSelectionRef.current = range;
    },
    [],
  );

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
  const createMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () =>
      createDocsDocument({
        title: "Untitled document",
        initialMarkdown: "",
        editorEngine: "helix-native-document",
        formatVersion: 1,
        metadata: { createdFrom: "web.native-document-shell" },
      }),
    onSuccess: (document) => {
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      void router?.navigate({ to: "/docs/$documentId", params: { documentId: document.id } });
    },
  });
  const makeCopyMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => {
      if (session === undefined) {
        throw new Error("Document session is not loaded.");
      }
      return copyDocsDocument({
        docId: session.document.id,
        title: `${session.document.title} (Copy)`,
        metadata: {
          createdFrom: "web.native-document-shell.make-copy",
        },
      });
    },
    onSuccess: (document) => {
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      void router?.navigate({ to: "/docs/$documentId", params: { documentId: document.id } });
    },
  });
  const trashMutation = useMutation({
    onMutate: () => undefined,
    onError: () => undefined,
    mutationFn: () => trashDriveObject(documentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      void router?.navigate({ to: "/docs" });
    },
  });
  const session = sessionQuery.data;
  useEffect(() => {
    setHasRecoveredDocumentDraft(false);
  }, [documentId]);
  useEffect(() => {
    const layoutSettings =
      session?.document.layoutSettings ?? DEFAULT_NATIVE_DOCUMENT_LAYOUT_SETTINGS;
    setLayoutMode(layoutSettings.layoutMode);
    setColumnCount(layoutSettings.columnCount);
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
        run: () => {
          setSidePanelOpen(true);
          setActiveTabId("ask");
          focusNativeDocumentControl("native-document-ask-question");
        },
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
      ...(["person", "doc", "file", "event"] as const).map((kind, index) => ({
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
        run: () => {
          setSidePanelOpen(true);
          setActiveTabId("comments");
          focusNativeDocumentControl("native-document-comments-panel");
        },
      },
      {
        id: `docs:${session.document.id}:suggestions`,
        pluginId: "com.helix.docs",
        label: "Jump to document suggestions",
        group: "Document",
        keywords: ["suggestions", "tracked changes", "review"],
        order: 80,
        run: () => {
          setSidePanelOpen(true);
          setActiveTabId("suggestions");
          focusNativeDocumentControl("native-document-suggestions-panel");
        },
      },
      {
        id: `docs:${session.document.id}:versions`,
        pluginId: "com.helix.docs",
        label: "Jump to version history",
        group: "Document",
        keywords: ["versions", "history", "restore"],
        order: 90,
        run: () => {
          setSidePanelOpen(true);
          setActiveTabId("versions");
          focusNativeDocumentControl("native-document-versions-panel");
        },
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

  if (sessionQuery.isLoading) {
    return (
      <NativeDocumentChromeFrame title="Loading…" status={{ kind: "saving", label: "Opening" }}>
        <DocumentPageSkeleton />
      </NativeDocumentChromeFrame>
    );
  }

  if (sessionQuery.isError || session === undefined) {
    return (
      <NativeDocumentChromeFrame title="Document" status={{ kind: "error", label: "Unavailable" }}>
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
      </NativeDocumentChromeFrame>
    );
  }

  const status = titleMutation.isPending
    ? { kind: "saving" as const, label: "Renaming" }
    : titleMutation.isError
      ? { kind: "error" as const, label: "Rename failed" }
      : createMutation.isPending
        ? { kind: "saving" as const, label: "Creating document" }
        : createMutation.isError
          ? { kind: "error" as const, label: "Create failed" }
          : makeCopyMutation.isPending
            ? { kind: "saving" as const, label: "Making copy" }
            : makeCopyMutation.isError
              ? { kind: "error" as const, label: "Copy failed" }
              : trashMutation.isPending
                ? { kind: "saving" as const, label: "Moving to trash" }
                : trashMutation.isError
                  ? { kind: "error" as const, label: "Trash failed" }
                  : hasRecoveredDocumentDraft
                    ? { kind: "offline" as const, label: "Recovered" }
                    : { kind: "live" as const, label: "Connected" };

  const chromeCtx: DocsChromeContext = {
    editor: chromeEditor,
    state: {
      textColor,
      highlightColor,
      paragraphStyle,
      documentMode,
      showRulers,
      showNonPrintingCharacters,
    },
    callbacks: {
      onBack: () => {
        void router?.navigate({ to: "/docs" });
      },
      onNewDocument: () => createMutation.mutate(),
      onOpenDocuments: () => {
        void router?.navigate({ to: "/docs" });
      },
      onMakeCopy: () => makeCopyMutation.mutate(),
      onMoveToTrash: () => trashMutation.mutate(),
      onCopyLink: () => {
        void copyTextToClipboard(window.location.href).catch(() => undefined);
      },
      onOpenShareDialog: () => setShareDialogOpen(true),
      onRename: () => appBarRef.current?.beginRename(),
      onOpenFindReplace: () => dispatchNativeDocumentCommand({ command: "find" }),
      onCut: () =>
        dispatchNativeDocumentCommandWithSelection(chromeEditor, lastEditorSelectionRef.current, {
          command: "cut",
        }),
      onCopy: () =>
        dispatchNativeDocumentCommandWithSelection(chromeEditor, lastEditorSelectionRef.current, {
          command: "copy",
        }),
      onPaste: () =>
        dispatchNativeDocumentCommandWithSelection(chromeEditor, lastEditorSelectionRef.current, {
          command: "paste",
        }),
      onPastePlain: () =>
        dispatchNativeDocumentCommandWithSelection(chromeEditor, lastEditorSelectionRef.current, {
          command: "paste-plain",
        }),
      onInsertLink: () => dispatchNativeDocumentCommand({ command: "insert-link" }),
      onOpenOutline: () => {
        setSidePanelOpen(true);
        setActiveTabId("outline");
      },
      onOpenWordCount: () => {
        setSidePanelOpen(true);
        setActiveTabId("outline");
      },
      onInsertTOC: () => dispatchNativeDocumentCommand({ command: "insert-toc" }),
      onInsertImage: () => dispatchNativeDocumentCommand({ command: "insert-image" }),
      onInsertTable: () => dispatchNativeDocumentCommand({ command: "insert-table" }),
      onInsertEquation: () => dispatchNativeDocumentCommand({ command: "insert-equation" }),
      onInsertBookmark: () => dispatchNativeDocumentCommand({ command: "insert-bookmark" }),
      onInsertCrossReference: () =>
        dispatchNativeDocumentCommand({ command: "insert-cross-reference" }),
      onInsertField: () => dispatchNativeDocumentCommand({ command: "insert-field" }),
      onInsertSmartChip: () => dispatchNativeDocumentCommand({ command: "open-smart-chip-picker" }),
      onInsertPageBreak: () => dispatchNativeDocumentCommand({ command: "insert-page-break" }),
      onInsertFootnote: () => dispatchNativeDocumentCommand({ command: "insert-footnote" }),
      onRefreshFields: () => dispatchNativeDocumentCommand({ command: "refresh-fields" }),
      onAskAI: () => {
        setSidePanelOpen(true);
        setActiveTabId("ask");
      },
      onSmartCompose: () => dispatchNativeDocumentCommand({ command: "smart-compose" }),
      onOpenKeyboardShortcuts: () => setHelpDialog("shortcuts"),
      onOpenAbout: () => setHelpDialog("about"),
      onOpenVersionHistory: () => {
        setSidePanelOpen(true);
        setActiveTabId("versions");
      },
      onToggleRulers: () => {
        setShowRulers((current) => {
          const next = !current;
          window.localStorage.setItem(NATIVE_DOCUMENT_RULER_PREFERENCE_KEY, String(next));
          return next;
        });
      },
      onToggleNonPrintingCharacters: () => {
        setShowNonPrintingCharacters((current) => {
          const next = !current;
          window.localStorage.setItem(NATIVE_DOCUMENT_NONPRINTING_PREFERENCE_KEY, String(next));
          return next;
        });
      },
      onSetDocumentMode: (mode) => {
        setDocumentMode(mode);
        window.localStorage.setItem(NATIVE_DOCUMENT_MODE_PREFERENCE_KEY, mode);
      },
      onToggleFullscreen: () => toggleNativeDocumentFullscreen(),
      onPrint: () => window.print(),
      onExport: (format) => exportMutation.mutate(format),
      onInsertComment: () => {
        setSidePanelOpen(true);
        setActiveTabId("comments");
      },
      onSetTextColor: (color) => {
        setTextColor(color);
        restoreLastEditorSelection(chromeEditor, lastEditorSelectionRef.current);
      },
      onSetHighlightColor: (color) => {
        setHighlightColor(color);
        restoreLastEditorSelection(chromeEditor, lastEditorSelectionRef.current);
      },
      onSetParagraphStyle: (style) => setParagraphStyle(style),
    },
  };

  const menus = buildDocsMenus(chromeCtx);
  const ribbon = buildDocsRibbon(chromeCtx);

  const sidePanelTabs: SidePanelTab[] = [
    {
      id: "comments",
      label: "Comments",
      icon: <MessageSquare className="h-4 w-4" aria-hidden="true" />,
      badge: openCommentsQuery.data?.length,
      content: (
        <NativeDocumentCommentsRail
          documentId={session.document.id}
          formatVersion={session.document.formatVersion}
          selectionAnchor={selectionAnchor}
        />
      ),
    },
    {
      id: "suggestions",
      label: "Suggestions",
      icon: <Edit3 className="h-4 w-4" aria-hidden="true" />,
      badge: pendingSuggestionsQuery.data?.length,
      content: (
        <NativeDocumentSuggestionsRail
          documentId={session.document.id}
          formatVersion={session.document.formatVersion}
          selectionAnchor={selectionAnchor}
        />
      ),
    },
    {
      id: "versions",
      label: "Versions",
      icon: <History className="h-4 w-4" aria-hidden="true" />,
      content: <NativeDocumentVersionsRail documentId={session.document.id} />,
    },
    {
      id: "outline",
      label: "Outline",
      icon: <ListIcon className="h-4 w-4" aria-hidden="true" />,
      content: <DocumentInspector outline={outline} stats={stats} />,
    },
    {
      id: "ask",
      label: "Ask",
      icon: <Sparkles className="h-4 w-4" aria-hidden="true" />,
      content: (
        <NativeDocumentAskPanel
          documentId={session.document.id}
          documentBlocks={askDocumentBlocks}
          documentText={askDocumentText}
          selectionAnchor={selectionAnchor}
        />
      ),
    },
  ];

  return (
    <div
      className="flex flex-col h-full min-h-screen bg-[var(--bg)]"
      role="region"
      aria-label="Native document"
    >
      <EditorAppBar
        ref={appBarRef}
        onBack={() => void router?.navigate({ to: "/docs" })}
        title={session.document.title}
        onTitleChange={(next) => {
          if (next.trim().length > 0 && next !== session.document.title) {
            void titleMutation.mutateAsync(next.trim());
          }
        }}
        status={status}
        menus={menus}
        sidePanelOpen={sidePanelOpen}
        onSidePanelToggle={() => setSidePanelOpen((open) => !open)}
        onOpenVersionHistory={() => {
          setSidePanelOpen(true);
          setActiveTabId("versions");
        }}
        onShare={() => setShareDialogOpen(true)}
      />
      {ribbon}
      <EditorWorkspace
        sidePanel={
          <EditorSidePanel
            open={sidePanelOpen}
            onOpenChange={setSidePanelOpen}
            tabs={sidePanelTabs}
            activeTabId={activeTabId}
            onActiveTabChange={setActiveTabId}
          />
        }
      >
        <main style={PAGE_WRAP_STYLE}>
          {/* Floating outline-rail icon — pinned to the far left of the doc
              workspace like Google Docs. Toggles the Outline tab in the side
              panel. */}
          <button
            type="button"
            aria-label="Show document outline"
            title="Show document outline"
            onClick={() => {
              setSidePanelOpen(true);
              setActiveTabId("outline");
            }}
            style={{
              position: "absolute",
              top: 18,
              left: 16,
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "var(--surface-2)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 5,
            }}
          >
            <ListIcon className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="native-document-workspace" style={DOCUMENT_WORKSPACE_STYLE}>
            {/* Google-Docs page-with-rulers wrapper. Horizontal ruler sits
                flush above the page (no gap), vertical ruler hugs the
                left edge. The wrapper is sized to vertical-ruler + page so
                everything lines up. */}
            <div
              style={{
                display: "block",
                width: 850 + (showRulers ? 22 : 0), // page + optional vertical ruler
                margin: "0 auto",
                position: "relative",
              }}
            >
              {/* Horizontal ruler offset right by the vertical-ruler width so
                  the inch ticks line up with the page columns, not the rail. */}
              {showRulers ? (
                <div data-native-document-rulers="true">
                  <div style={{ paddingLeft: 22 }}>
                    <NativeDocumentRuler pageWidth={850} sidePadding={96} />
                  </div>
                </div>
              ) : null}
              <div style={{ display: "flex", alignItems: "flex-start" }}>
                {showRulers ? (
                  <NativeDocumentVerticalRuler pageHeight={1100} verticalPadding={72} />
                ) : null}
                <article
                  className={`native-document-page native-document-page--${layoutMode}`}
                  data-layout-mode={layoutMode}
                  data-column-count={String(columnCount)}
                  style={nativeDocumentPageStyle(layoutMode)}
                  aria-label={session.document.title}
                >
                  <Suspense fallback={<DocumentBlocks blocks={blocks} columnCount={columnCount} />}>
                    <NativeDocumentEditor
                      key={nativeDocumentEditorInstanceKey(session)}
                      session={session}
                      anchorDecorations={anchorDecorations}
                      columnCount={columnCount}
                      editable={documentMode === "editing"}
                      showNonPrintingCharacters={showNonPrintingCharacters}
                      onContentChange={refreshDocumentVersions}
                      onRecoveryStatusChange={setHasRecoveredDocumentDraft}
                      onInspectorSnapshotChange={setLiveInspectorSnapshot}
                      onSelectionAnchorChange={setSelectionAnchor}
                      onSelectionRangeChange={updateLastEditorSelection}
                      onEditorReady={setChromeEditor}
                    />
                  </Suspense>
                </article>
              </div>
            </div>
          </div>
        </main>
      </EditorWorkspace>
      <DriveShareDialog
        objectId={session.document.id}
        objectName={session.document.title}
        ownerActorId={session.document.ownerActorId}
        open={shareDialogOpen}
        shareUrl={window.location.href}
        onOpenChange={setShareDialogOpen}
      />
      {helpDialog === null ? null : (
        <NativeDocumentHelpDialogSurface
          kind={helpDialog}
          documentTitle={session.document.title}
          onClose={() => setHelpDialog(null)}
        />
      )}
    </div>
  );
}

export function nativeDocumentEditorInstanceKey(session: {
  readonly document: Pick<NativeDocumentSession["document"], "id" | "stateBase64" | "updateSeq">;
}): string {
  const state = session.document.stateBase64 ?? "";
  return [
    session.document.id,
    String(session.document.updateSeq),
    String(state.length),
    state,
  ].join(":");
}

function restoreLastEditorSelection(
  editor: DocsChromeEditorLike | null,
  range: { readonly from: number; readonly to: number } | null,
): void {
  if (editor === null || range === null) {
    return;
  }
  try {
    editor.chain().focus().setTextSelection(range).run();
  } catch {
    // Selection restoration is best-effort; if the stored range no longer
    // exists, the following formatting command applies at the current cursor.
  }
}

async function copyTextToClipboard(value: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) {
    throw new Error("Clipboard is not available.");
  }
  await clipboard.writeText(value);
}

function toggleNativeDocumentFullscreen(): void {
  if (document.fullscreenElement === null) {
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    return;
  }
  void document.exitFullscreen?.().catch(() => undefined);
}

function useTryRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

function NativeDocumentChromeFrame({
  title,
  status,
  children,
}: {
  readonly title: string;
  readonly status: {
    readonly kind: "saving" | "saved" | "live" | "offline" | "error";
    readonly label?: string;
  };
  readonly children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col h-full min-h-screen bg-[var(--bg)]"
      role="region"
      aria-label="Native document"
    >
      <EditorAppBar title={title} status={status} />
      {children}
    </div>
  );
}

function NativeDocumentHelpDialogSurface({
  kind,
  documentTitle,
  onClose,
}: {
  readonly kind: NativeDocumentHelpDialog;
  readonly documentTitle: string;
  readonly onClose: () => void;
}) {
  const title = kind === "shortcuts" ? "Keyboard shortcuts" : "About Helix Docs";
  return (
    <div style={HELP_DIALOG_BACKDROP_STYLE} role="presentation" onMouseDown={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={HELP_DIALOG_STYLE}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div style={HELP_DIALOG_HEADER_STYLE}>
          <h2 style={HELP_DIALOG_TITLE_STYLE}>{title}</h2>
          <button type="button" className="btn sm ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {kind === "shortcuts" ? (
          <dl style={HELP_SHORTCUT_GRID_STYLE}>
            <dt>Find in document</dt>
            <dd>Ctrl+F</dd>
            <dt>Copy</dt>
            <dd>Ctrl+C</dd>
            <dt>Cut</dt>
            <dd>Ctrl+X</dd>
            <dt>Paste</dt>
            <dd>Ctrl+V</dd>
            <dt>Word count</dt>
            <dd>Ctrl+Shift+C</dd>
            <dt>Print</dt>
            <dd>Ctrl+P</dd>
          </dl>
        ) : (
          <div style={HELP_ABOUT_STYLE}>
            <p>
              Helix Docs native editor for <strong>{documentTitle}</strong>.
            </p>
            <p>
              Supports native editing, autosave, version history, comments, suggestions, Drive
              sharing, and Workspace-style import/export workflows.
            </p>
          </div>
        )}
      </section>
    </div>
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

function dispatchNativeDocumentCommandWithSelection(
  editor: DocsChromeEditorLike | null,
  range: { readonly from: number; readonly to: number } | null,
  detail: NativeDocumentCommandEventDetail,
): void {
  restoreLastEditorSelection(editor, range);
  dispatchNativeDocumentCommand(detail);
}

function nativeDocumentModeFromStorage(value: string | null): DocsDocumentMode {
  return value === "viewing" ? "viewing" : "editing";
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

const PAGE_WRAP_STYLE = {
  position: "relative", // anchor for the floating outline button
  display: "flex",
  flex: 1,
  justifyContent: "center",
  overflow: "auto",
  padding: "32px 16px",
} satisfies CSSProperties;

const DOCUMENT_WORKSPACE_STYLE = {
  // Switched off grid+justify-items (collapsed children to min-content width)
  // in favor of a plain block container. The ruler + article use their own
  // marginInline:auto for horizontal centering.
  display: "block",
  width: "100%",
  maxWidth: 1140,
  marginInline: "auto",
} satisfies CSSProperties;

const PAGE_STYLE = {
  // Fixed 850px so it composes deterministically next to the vertical ruler
  // and any future left rail. Outer wrapper handles the responsive squish.
  width: 850,
  flexShrink: 0,
  minHeight: 1100, // ~A4 height — even empty docs feel like a page
  padding: "72px min(8vw, 96px)",
  // Theme-aware paper: uses --surface (lighter in light mode, dark card in
  // dark mode) so the page reads as a paper island vs the --bg backdrop in
  // both themes, like Google Docs / Office both honor system theme.
  background: "var(--surface)",
  color: "var(--text-1)",
  borderRadius: 2,
  border: "1px solid var(--border)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 8px 32px rgba(0,0,0,0.08)",
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

const HELP_DIALOG_BACKDROP_STYLE = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "rgba(15, 23, 42, 0.38)",
} satisfies CSSProperties;

const HELP_DIALOG_STYLE = {
  width: "min(520px, 100%)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
  boxShadow: "0 24px 80px rgba(15, 23, 42, 0.24)",
  padding: 18,
  color: "var(--text-1)",
} satisfies CSSProperties;

const HELP_DIALOG_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 14,
} satisfies CSSProperties;

const HELP_DIALOG_TITLE_STYLE = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
} satisfies CSSProperties;

const HELP_SHORTCUT_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "10px 18px",
  margin: 0,
  fontSize: 13,
} satisfies CSSProperties;

const HELP_ABOUT_STYLE = {
  display: "grid",
  gap: 10,
  fontSize: 13,
  lineHeight: 1.5,
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
