/* Docs editor — outline rail, formatting toolbar, editable title, a real
   Yjs-backed collaborative Tiptap body, live presence/awareness, and a right
   rail switching between Comments / Suggestions (version history) / AI.

   Backend wiring:
   - Title rename  → `docs.update-title`
   - Export        → `docs.export` (toolbar download menu)
   - Body          → Yjs sync WebSocket (`/sync/docs/:docId?protocol=yjs`) via
                     `DocsCollabProvider` + Tiptap Collaboration extension.
   - Comments      → `docs.comment.create` + comments derived from `docs.export`
   - Suggestions   → `docs.suggestion.{create,list,resolve}`

   Seed data is used only as an offline fallback for non-backend documents. */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, type Editor } from "@tiptap/react";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import {
  createDocsComment,
  createDocsSuggestion,
  exportDocsDocument,
  resolveDocsSuggestion,
  updateDocsTitle,
  type DocsExportFormat,
  type DocsSuggestion,
} from "./api";
import type { DocsCollabPeer, DocsCollabStatus } from "./collab-provider";
import {
  DOC_AI_SUGGESTIONS,
  SLASH_ITEMS,
  type DocSummary,
  type OutlineEntry,
} from "./data";
import {
  docsCommentsQueryOptions,
  docsQueryKeys,
  docsSessionQueryOptions,
  docsSuggestionsQueryOptions,
  isBackendDocsDocumentId,
} from "./queries";
import { useCollabDoc } from "./use-collab-doc";

type RightRail = "comments" | "versions" | "ai";

export interface DocEditorProps {
  /** The document being edited. */
  readonly document: DocSummary;
  /** Return to the list view. */
  readonly onBack: () => void;
  /** Open the Share dialog. */
  readonly onShare: () => void;
  /** Hide the back button + outline collapse chrome when embedded in Drive. */
  readonly embedded?: boolean;
}

const PARAGRAPH_TYPES = [
  "Body text",
  "Heading 1",
  "Heading 2",
  "Heading 3",
] as const;

const FONT_SIZES = ["13", "14", "15", "16", "18", "20", "24", "28", "32", "40"] as const;

/** Offline seed body shown for non-backend (seed / synthetic) documents. */
const FALLBACK_BODY = `
<h2>Context</h2>
<p>This document consolidates the plan across product, engineering, and design.
It folds in feedback from the latest leadership review and customer signal.</p>
<h2>Open decisions</h2>
<p>The three open decisions below need product sign-off so the plan can go to
the board. Each owner has time blocked for async input.</p>
<ul><li>Atlas Holdings — willing to move, requesting 4-week notice</li>
<li>Northwind — blocked on SCIM provisioning</li>
<li>Brightline — flexible, will follow Northwind</li></ul>
`;

/**
 * Derives the current list of headings (h1/h2/h3) from a Tiptap editor's
 * ProseMirror document state and re-derives it whenever the document changes.
 */
function useOutline(editor: Editor | null): readonly OutlineEntry[] {
  const [outline, setOutline] = useState<readonly OutlineEntry[]>([]);

  useEffect(() => {
    if (editor === null) {
      setOutline([]);
      return;
    }

    const derive = () => {
      const entries: OutlineEntry[] = [];
      editor.state.doc.forEach((node) => {
        if (node.type.name === "heading") {
          const level = (node.attrs as { level: number }).level as 1 | 2 | 3;
          const text = node.textContent;
          if (text.length > 0) {
            entries.push({ level, text });
          }
        }
      });
      setOutline(entries);
    };

    // Derive immediately (covers the case where content is already loaded).
    derive();

    // Re-derive on every document change.
    editor.on("update", derive);
    return () => {
      editor.off("update", derive);
    };
  }, [editor]);

  return outline;
}

export function DocEditor({ document, onBack, onShare, embedded = false }: DocEditorProps) {
  const queryClient = useQueryClient();
  const backendDocId = isBackendDocsDocumentId(document.id) ? document.id : null;

  const [showOutline, setShowOutline] = useState(true);
  const [rightRail, setRightRail] = useState<RightRail | null>("comments");
  const [activeOutline, setActiveOutline] = useState("");
  const [title, setTitle] = useState(document.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [suggestionMode, setSuggestionMode] = useState(false);

  const sessionQuery = useQuery(docsSessionQueryOptions());
  const session = sessionQuery.data ?? { actorId: "anonymous", name: "You" };

  const collab = useCollabDoc({
    backendDocId,
    user: { id: session.actorId, name: session.name },
    fallbackContent: FALLBACK_BODY,
    editable: !suggestionMode,
  });

  const outline = useOutline(collab.editor);

  useEffect(() => {
    setTitle(document.title);
    setEditingTitle(false);
  }, [document.id, document.title]);

  const renameMutation = useMutation({
    mutationFn: (nextTitle: string) => {
      if (backendDocId === null) {
        return Promise.resolve(null);
      }
      return updateDocsTitle({ docId: backendDocId, title: nextTitle });
    },
    onMutate: (nextTitle: string) => {
      // The title input is already optimistic; capture the prior value so a
      // failed rename can roll the editor's title back.
      return { previousTitle: document.title, nextTitle };
    },
    onError: (_error, _nextTitle, context) => {
      if (context !== undefined) {
        setTitle(context.previousTitle);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["docs", "documents"] });
      if (backendDocId !== null) {
        void queryClient.invalidateQueries({
          queryKey: docsQueryKeys.document(backendDocId),
        });
      }
    },
  });

  const commitTitle = useCallback(
    (nextTitle: string) => {
      const trimmed = nextTitle.trim();
      setEditingTitle(false);
      if (trimmed.length === 0 || trimmed === document.title) {
        setTitle(document.title);
        return;
      }
      setTitle(trimmed);
      renameMutation.mutate(trimmed);
    },
    [document.title, renameMutation],
  );

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, background: "var(--bg)" }}>
      {showOutline ? (
        <OutlineRail
          outline={outline}
          activeOutline={activeOutline}
          editor={collab.editor}
          onSelect={setActiveOutline}
          onCollapse={() => setShowOutline(false)}
        />
      ) : null}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <EditorToolbar
          embedded={embedded}
          showOutline={showOutline}
          editor={collab.editor}
          backendDocId={backendDocId}
          docTitle={title}
          suggestionMode={suggestionMode}
          onToggleSuggestionMode={() => setSuggestionMode((current) => !current)}
          onBack={onBack}
          onShowOutline={() => setShowOutline(true)}
          onShare={onShare}
          rightRail={rightRail}
          peers={collab.peers}
          status={collab.status}
          onToggleRail={(rail) =>
            setRightRail((current) => (current === rail ? null : rail))
          }
        />

        <TitleBar
          title={title}
          editing={editingTitle}
          status={collab.status}
          peerCount={collab.peers.length}
          renamePending={renameMutation.isPending}
          onStartEditing={() => setEditingTitle(true)}
          onChange={setTitle}
          onCommit={commitTitle}
          onCancel={() => {
            setTitle(document.title);
            setEditingTitle(false);
          }}
        />

        <DocumentBody
          editor={collab.editor}
          synced={collab.synced}
          suggestionMode={suggestionMode}
          backendDocId={backendDocId}
          onAddComment={(body, anchor) => {
            if (backendDocId === null) {
              return;
            }
            void createDocsComment({ docId: backendDocId, body, anchor }).then(() => {
              void queryClient.invalidateQueries({
                queryKey: docsQueryKeys.comments(backendDocId),
              });
            });
          }}
          onAddSuggestion={(beforeText, afterText) => {
            if (backendDocId === null) {
              return;
            }
            void createDocsSuggestion({ docId: backendDocId, beforeText, afterText }).then(
              () => {
                void queryClient.invalidateQueries({
                  queryKey: docsQueryKeys.suggestions(backendDocId),
                });
              },
            );
          }}
        />
      </div>

      {rightRail === "comments" ? (
        <CommentsRail backendDocId={backendDocId} editor={collab.editor} />
      ) : null}
      {rightRail === "versions" ? (
        <SuggestionsRail backendDocId={backendDocId} onClose={() => setRightRail(null)} />
      ) : null}
      {rightRail === "ai" ? <AiRail onClose={() => setRightRail(null)} /> : null}
    </div>
  );
}

function OutlineRail({
  outline,
  activeOutline,
  editor,
  onSelect,
  onCollapse,
}: {
  readonly outline: readonly OutlineEntry[];
  readonly activeOutline: string;
  readonly editor: Editor | null;
  readonly onSelect: (text: string) => void;
  readonly onCollapse: () => void;
}) {
  /**
   * Scroll the nth heading of the given level+text into view in the editor.
   * We find the heading node by walking the ProseMirror document; `editor.commands.focus(pos)`
   * moves the cursor there and the browser scrolls it into view.
   */
  const scrollToHeading = (entry: OutlineEntry, index: number) => {
    if (editor === null) {
      return;
    }
    let found = 0;
    let targetPos: number | null = null;
    editor.state.doc.forEach((node, offset) => {
      if (targetPos !== null) {
        return;
      }
      if (
        node.type.name === "heading" &&
        (node.attrs as { level: number }).level === entry.level &&
        node.textContent === entry.text
      ) {
        if (found === index) {
          targetPos = offset + 1; // +1 to enter the node
        }
        found += 1;
      }
    });
    if (targetPos !== null) {
      editor.commands.focus(targetPos);
    }
  };

  return (
    <aside
      aria-label="Document outline"
      style={{
        width: 220,
        flexShrink: 0,
        padding: 16,
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        overflowY: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-3)",
            textTransform: "uppercase",
            letterSpacing: ".06em",
          }}
        >
          Outline
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Collapse outline"
          style={{ marginLeft: "auto" }}
          onClick={onCollapse}
        >
          <Icons.ChevronLeft />
        </button>
      </div>
      {outline.length === 0 ? (
        <p
          data-testid="outline-empty-hint"
          style={{ fontSize: 11, color: "var(--text-3)", margin: 0, lineHeight: 1.5 }}
        >
          Headings you add will appear here.
        </p>
      ) : (
        outline.map((entry, index) => {
          const active = entry.text === activeOutline;
          return (
            <button
              // Using index here is fine because outline entries are rendered in
              // document order and the same heading text at the same level will
              // share a position.  We include the level to make the key more
              // unique when the document has repeated headings.
              key={`${String(entry.level)}-${entry.text}-${String(index)}`}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() => {
                onSelect(entry.text);
                scrollToHeading(entry, index);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "3px 8px",
                paddingLeft: 8 + (entry.level - 1) * 12,
                fontSize: 12,
                color: active ? "var(--accent)" : "var(--text-2)",
                fontWeight: active ? 500 : 400,
                borderRadius: 4,
                background: active ? "var(--accent-soft)" : "transparent",
              }}
            >
              {entry.text}
            </button>
          );
        })
      )}
    </aside>
  );
}

function TitleBar({
  title,
  editing,
  status,
  peerCount,
  renamePending,
  onStartEditing,
  onChange,
  onCommit,
  onCancel,
}: {
  readonly title: string;
  readonly editing: boolean;
  readonly status: DocsCollabStatus | "offline";
  readonly peerCount: number;
  readonly renamePending: boolean;
  readonly onStartEditing: () => void;
  readonly onChange: (value: string) => void;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  return (
    <div
      style={{
        padding: "8px 16px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "var(--surface)",
      }}
    >
      <Icons.Doc />
      {editing ? (
        <input
          autoFocus
          aria-label="Document title"
          value={title}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onCommit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              onCancel();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--surface-2)",
            border: "1px solid var(--accent-soft-border)",
            borderRadius: 4,
            padding: "2px 6px",
            fontSize: 13,
            fontWeight: 600,
            outline: "none",
            boxShadow: "0 0 0 3px var(--accent-soft)",
          }}
        />
      ) : (
        <button
          type="button"
          className="truncate docs-title-button docs-title-rename-btn"
          title="Click to rename"
          onClick={onStartEditing}
          style={{
            fontSize: 13,
            fontWeight: 600,
            padding: "2px 6px",
            borderRadius: 4,
            color: "var(--text)",
            background: "transparent",
            border: "1px solid transparent",
            cursor: "text",
            maxWidth: "60%",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span className="truncate">{title}</span>
          <span
            className="docs-title-pencil"
            aria-hidden="true"
            style={{ flexShrink: 0, opacity: 0, transition: "opacity 0.15s" }}
          >
            <Icons.EditPen size={12} />
          </span>
        </button>
      )}
      <SavedChip status={status} renamePending={renamePending} />
      {status !== "offline" ? (
        <span className={peerCount > 0 ? "chip success" : "chip"}>
          <span className="chip-dot" />
          {peerCount + 1} editing
        </span>
      ) : null}
    </div>
  );
}

function SavedChip({
  status,
  renamePending,
}: {
  readonly status: DocsCollabStatus | "offline";
  readonly renamePending: boolean;
}) {
  if (renamePending) {
    return <span className="chip">Saving title…</span>;
  }
  if (status === "offline") {
    return (
      <span className="chip">
        <Icons.Globe size={11} /> Offline draft
      </span>
    );
  }
  if (status === "connected") {
    return (
      <span className="chip">
        <Icons.Check size={11} /> Synced
      </span>
    );
  }
  if (status === "connecting") {
    return <span className="chip">Connecting…</span>;
  }
  return (
    <span className="chip" style={{ color: "var(--warning)" }}>
      Reconnecting…
    </span>
  );
}

function EditorToolbar({
  embedded,
  showOutline,
  editor,
  backendDocId,
  docTitle,
  suggestionMode,
  onToggleSuggestionMode,
  onBack,
  onShowOutline,
  onShare,
  rightRail,
  peers,
  status,
  onToggleRail,
}: {
  readonly embedded: boolean;
  readonly showOutline: boolean;
  readonly editor: Editor | null;
  readonly backendDocId: string | null;
  readonly docTitle: string;
  readonly suggestionMode: boolean;
  readonly onToggleSuggestionMode: () => void;
  readonly onBack: () => void;
  readonly onShowOutline: () => void;
  readonly onShare: () => void;
  readonly rightRail: RightRail | null;
  readonly peers: readonly DocsCollabPeer[];
  readonly status: DocsCollabStatus | "offline";
  readonly onToggleRail: (rail: RightRail) => void;
}) {
  const divider: CSSProperties = { height: 18, margin: "0 4px" };
  const [showExport, setShowExport] = useState(false);

  const setBlock = (value: string) => {
    if (editor === null) {
      return;
    }
    const chain = editor.chain().focus();
    if (value === "Heading 1") {
      chain.setHeading({ level: 1 }).run();
    } else if (value === "Heading 2") {
      chain.setHeading({ level: 2 }).run();
    } else if (value === "Heading 3") {
      chain.setHeading({ level: 3 }).run();
    } else {
      chain.setParagraph().run();
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Document formatting"
      style={{
        minHeight: 44,
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 4,
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      {embedded ? null : (
        <button type="button" className="icon-btn" aria-label="Back to documents" onClick={onBack}>
          <Icons.ArrowLeft />
        </button>
      )}
      {showOutline ? null : (
        <button type="button" className="icon-btn" aria-label="Show outline" onClick={onShowOutline}>
          <Icons.Menu />
        </button>
      )}
      <div className="v-divider" style={divider} />

      <select
        className="select"
        aria-label="Paragraph style"
        style={{ width: 110, height: 26, fontSize: 12 }}
        value={paragraphValue(editor)}
        onChange={(event) => setBlock(event.target.value)}
      >
        {PARAGRAPH_TYPES.map((type) => (
          <option key={type}>{type}</option>
        ))}
      </select>
      <select className="select" aria-label="Font size" style={{ width: 64, height: 26, fontSize: 12 }}>
        {FONT_SIZES.map((size) => (
          <option key={size}>{size}</option>
        ))}
      </select>

      <div className="v-divider" style={divider} />
      <ToolbarToggle
        label="Bold"
        title="Bold (⌘B)"
        active={editor?.isActive("bold") ?? false}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Icons.Bold />
      </ToolbarToggle>
      <ToolbarToggle
        label="Italic"
        title="Italic (⌘I)"
        active={editor?.isActive("italic") ?? false}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Icons.Italic />
      </ToolbarToggle>
      <ToolbarToggle
        label="Strikethrough"
        title="Strikethrough"
        active={editor?.isActive("strike") ?? false}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      >
        <Icons.Underline />
      </ToolbarToggle>
      <ToolbarToggle
        label="Inline code"
        title="Inline code"
        active={editor?.isActive("code") ?? false}
        onClick={() => editor?.chain().focus().toggleCode().run()}
      >
        <span style={{ fontSize: 11, fontWeight: 700 }}>{"<>"}</span>
      </ToolbarToggle>

      <div className="v-divider" style={divider} />
      <ToolbarToggle
        label="Bulleted list"
        title="Bulleted list"
        active={editor?.isActive("bulletList") ?? false}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <Icons.List />
      </ToolbarToggle>
      <ToolbarToggle
        label="Numbered list"
        title="Numbered list"
        active={editor?.isActive("orderedList") ?? false}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <Icons.ListNum />
      </ToolbarToggle>
      <ToolbarToggle
        label="Quote"
        title="Quote"
        active={editor?.isActive("blockquote") ?? false}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <Icons.Quote />
      </ToolbarToggle>
      <ToolbarToggle
        label="Code block"
        title="Code block"
        active={editor?.isActive("codeBlock") ?? false}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
      >
        <Icons.Code />
      </ToolbarToggle>
      <button
        type="button"
        className="icon-btn"
        aria-label="Insert divider"
        title="Insert divider"
        onClick={() => editor?.chain().focus().setHorizontalRule().run()}
      >
        <Icons.Divider />
      </button>

      <div className="v-divider" style={divider} />
      <button
        type="button"
        className={suggestionMode ? "btn sm primary" : "btn sm"}
        aria-pressed={suggestionMode}
        title="Suggestion mode — edits are proposed as tracked changes"
        onClick={onToggleSuggestionMode}
      >
        <Icons.EditPen /> Suggesting
      </button>
      <button
        type="button"
        className={rightRail === "ai" ? "btn sm primary" : "btn sm"}
        aria-pressed={rightRail === "ai"}
        onClick={() => onToggleRail("ai")}
      >
        <Icons.Sparkles /> Helix AI
      </button>

      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
        <PresenceStack peers={peers} status={status} />
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn sm"
            aria-label="Export document"
            aria-haspopup="menu"
            aria-expanded={showExport}
            disabled={backendDocId === null}
            onClick={() => setShowExport((current) => !current)}
          >
            <Icons.Download />
          </button>
          {showExport && backendDocId !== null ? (
            <ExportMenu
              docId={backendDocId}
              docTitle={docTitle}
              onClose={() => setShowExport(false)}
            />
          ) : null}
        </div>
        <button
          type="button"
          className={rightRail === "versions" ? "btn sm primary" : "btn sm"}
          aria-label="Suggestions"
          aria-pressed={rightRail === "versions"}
          onClick={() => onToggleRail("versions")}
        >
          <Icons.History />
        </button>
        <button
          type="button"
          className={rightRail === "comments" ? "btn sm primary" : "btn sm"}
          aria-label="Comments"
          aria-pressed={rightRail === "comments"}
          onClick={() => onToggleRail("comments")}
        >
          <Icons.Comment />
        </button>
        <button type="button" className="btn sm primary" onClick={onShare}>
          <Icons.Users /> Share
        </button>
      </span>
    </div>
  );
}

function ToolbarToggle({
  label,
  title,
  active,
  onClick,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? "icon-btn active" : "icon-btn"}
      aria-label={label}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      style={active ? { background: "var(--accent-soft)", color: "var(--accent)" } : undefined}
    >
      {children}
    </button>
  );
}

function PresenceStack({
  peers,
  status,
}: {
  readonly peers: readonly DocsCollabPeer[];
  readonly status: DocsCollabStatus | "offline";
}) {
  if (status === "offline") {
    return null;
  }
  if (peers.length === 0) {
    return (
      <span style={{ fontSize: 11, color: "var(--text-3)", marginRight: 8 }}>
        Only you
      </span>
    );
  }
  return (
    <span
      aria-label={`${String(peers.length)} collaborators online`}
      style={{ display: "flex", marginRight: 8 }}
    >
      {peers.slice(0, 4).map((peer, index) => (
        <span
          key={peer.clientId}
          title={peer.name}
          style={{
            marginLeft: index === 0 ? 0 : -6,
            border: `2px solid ${peer.color}`,
            borderRadius: 999,
            display: "inline-flex",
          }}
        >
          <Avatar name={peer.name} size={22} />
        </span>
      ))}
    </span>
  );
}

function ExportMenu({
  docId,
  docTitle,
  onClose,
}: {
  readonly docId: string;
  readonly docTitle: string;
  readonly onClose: () => void;
}) {
  const exportMutation = useMutation({
    mutationFn: (format: DocsExportFormat) =>
      exportDocsDocument({ docId, format, includeComments: format === "markdown" }),
    onMutate: () => {
      // Export is read-only; nothing to snapshot or roll back.
    },
    onError: () => {
      // Failure is rendered inline by the menu's `isError` branch.
    },
    onSuccess: (result) => {
      downloadExport(result.contentBase64, result.filename, result.mimeType);
      onClose();
    },
  });

  return (
    <div
      role="menu"
      aria-label="Export format"
      className="slash-menu"
      style={{ top: 30, right: 0, left: "auto", padding: 4, minWidth: 160 }}
    >
      {(["markdown", "pdf", "docx"] as const).map((format) => (
        <button
          key={format}
          type="button"
          role="menuitem"
          className="slash-item"
          disabled={exportMutation.isPending}
          onClick={() => exportMutation.mutate(format)}
        >
          <span className="slash-item-icon">
            <Icons.Download />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="slash-item-title">Export as {format.toUpperCase()}</div>
            <div className="slash-item-sub">{exportFilenameHint(docTitle, format)}</div>
          </div>
        </button>
      ))}
      {exportMutation.isError ? (
        <div className="slash-item-sub" style={{ padding: "6px 8px", color: "var(--warning)" }}>
          Export failed — try again.
        </div>
      ) : null}
    </div>
  );
}

function DocumentBody({
  editor,
  synced,
  suggestionMode,
  backendDocId,
  onAddComment,
  onAddSuggestion,
}: {
  readonly editor: Editor | null;
  readonly synced: boolean;
  readonly suggestionMode: boolean;
  readonly backendDocId: string | null;
  readonly onAddComment: (body: string, anchor: Record<string, unknown>) => void;
  readonly onAddSuggestion: (beforeText: string, afterText: string) => void;
}) {
  const [showSlash, setShowSlash] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [draftComment, setDraftComment] = useState("");
  const [draftSuggestion, setDraftSuggestion] = useState("");

  const slashItems = useMemo(
    () =>
      SLASH_ITEMS.filter((item) =>
        item.title.toLowerCase().includes(slashFilter.trim().toLowerCase()),
      ),
    [slashFilter],
  );

  const applySlash = (id: string) => {
    if (editor === null) {
      setShowSlash(false);
      return;
    }
    const chain = editor.chain().focus();
    switch (id) {
      case "h1":
        chain.setHeading({ level: 1 }).run();
        break;
      case "h2":
        chain.setHeading({ level: 2 }).run();
        break;
      case "ul":
        chain.toggleBulletList().run();
        break;
      case "ol":
        chain.toggleOrderedList().run();
        break;
      case "quote":
        chain.toggleBlockquote().run();
        break;
      case "code":
        chain.toggleCodeBlock().run();
        break;
      case "hr":
        chain.setHorizontalRule().run();
        break;
      default:
        chain.run();
    }
    setShowSlash(false);
  };

  const onSlashKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setShowSlash(false);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSlashIndex((index) => Math.min(slashItems.length - 1, index + 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSlashIndex((index) => Math.max(0, index - 1));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = slashItems[slashIndex];
      if (item !== undefined) {
        applySlash(item.id);
      }
    }
  };

  const selectedText = (): string => {
    if (editor === null) {
      return "";
    }
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, " ");
  };

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "32px 0",
        background: "var(--bg)",
      }}
    >
      <article
        style={{
          maxWidth: 760,
          margin: "0 auto",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "40px 72px 56px",
          minHeight: "100%",
        }}
      >
        {backendDocId !== null && !synced ? (
          <div
            role="status"
            style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 12 }}
          >
            Connecting to the collaboration session…
          </div>
        ) : null}

        {editor === null ? (
          <div style={{ fontSize: 13, color: "var(--text-3)" }}>Loading editor…</div>
        ) : (
          <EditorContent editor={editor} />
        )}

        <div style={{ marginTop: 16, position: "relative" }}>
          <button
            type="button"
            onClick={() => {
              setShowSlash(true);
              setSlashFilter("");
              setSlashIndex(0);
            }}
            style={{
              fontSize: 13,
              color: "var(--text-3)",
              padding: "4px 0",
              display: "block",
              textAlign: "left",
            }}
          >
            Type / to insert a block…
          </button>
          {showSlash ? (
            <div
              className="slash-menu"
              role="menu"
              aria-label="Insert block"
              style={{ top: 32, left: 0, padding: 4 }}
            >
              <div
                style={{
                  padding: "4px 8px 6px",
                  borderBottom: "1px solid var(--border)",
                  marginBottom: 4,
                }}
              >
                <input
                  autoFocus
                  aria-label="Filter blocks"
                  value={slashFilter}
                  placeholder="Filter…"
                  onChange={(event) => {
                    setSlashFilter(event.target.value);
                    setSlashIndex(0);
                  }}
                  onKeyDown={onSlashKeyDown}
                  style={{
                    width: "100%",
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontSize: 12,
                  }}
                />
              </div>
              {slashItems.length === 0 ? (
                <div className="slash-item-sub" style={{ padding: "6px 8px" }}>
                  No matching blocks
                </div>
              ) : null}
              {slashItems.map((item, index) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.id}
                    role="menuitem"
                    tabIndex={-1}
                    className={index === slashIndex ? "slash-item active" : "slash-item"}
                    onMouseEnter={() => setSlashIndex(index)}
                    onClick={() => applySlash(item.id)}
                  >
                    <span className="slash-item-icon">
                      <Icon />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="slash-item-title">{item.title}</div>
                      <div className="slash-item-sub">{item.sub}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {backendDocId !== null ? (
          <div
            style={{
              marginTop: 24,
              paddingTop: 16,
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {suggestionMode ? (
              <SelectionAction
                label="Propose a tracked-change suggestion"
                placeholder="Replacement text for the current selection…"
                buttonLabel="Suggest edit"
                value={draftSuggestion}
                onChange={setDraftSuggestion}
                onSubmit={() => {
                  const before = selectedText();
                  if (before.trim().length === 0 || draftSuggestion.trim().length === 0) {
                    return;
                  }
                  onAddSuggestion(before, draftSuggestion.trim());
                  setDraftSuggestion("");
                }}
              />
            ) : (
              <SelectionAction
                label="Comment on the current selection"
                placeholder="Add a comment…"
                buttonLabel="Comment"
                value={draftComment}
                onChange={setDraftComment}
                onSubmit={() => {
                  if (draftComment.trim().length === 0) {
                    return;
                  }
                  onAddComment(draftComment.trim(), { quote: selectedText() });
                  setDraftComment("");
                }}
              />
            )}
          </div>
        ) : null}
      </article>
    </div>
  );
}

function SelectionAction({
  label,
  placeholder,
  buttonLabel,
  value,
  onChange,
  onSubmit,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly buttonLabel: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input"
          aria-label={label}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit();
            }
          }}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn sm primary" onClick={onSubmit}>
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

function RailHeader({
  title,
  meta,
  onClose,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly onClose?: () => void;
}) {
  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
      {meta ? (
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>{meta}</span>
      ) : null}
      {onClose ? (
        <button
          type="button"
          className="icon-btn"
          aria-label={`Close ${title}`}
          style={{ marginLeft: meta ? 4 : "auto" }}
          onClick={onClose}
        >
          <Icons.X />
        </button>
      ) : null}
    </div>
  );
}

function CommentsRail({
  backendDocId,
  editor,
}: {
  readonly backendDocId: string | null;
  readonly editor: Editor | null;
}) {
  const queryClient = useQueryClient();
  const commentsQuery = useQuery({
    ...docsCommentsQueryOptions(backendDocId ?? ""),
    enabled: backendDocId !== null,
  });
  const [draft, setDraft] = useState("");

  const createMutation = useMutation({
    mutationFn: (body: string) => {
      if (backendDocId === null) {
        return Promise.reject(new Error("Document is not saved yet."));
      }
      const selection = editor?.state.selection;
      const quote =
        editor !== null && selection !== undefined
          ? editor.state.doc.textBetween(selection.from, selection.to, " ")
          : "";
      return createDocsComment({ docId: backendDocId, body, anchor: { quote } });
    },
    onMutate: () => {
      // Comments are derived from `docs.export`; no optimistic cache write —
      // the list is invalidated on success.
    },
    onError: () => {
      // Failure is rendered inline by the rail's `isError` branch.
    },
    onSuccess: () => {
      setDraft("");
      if (backendDocId !== null) {
        void queryClient.invalidateQueries({
          queryKey: docsQueryKeys.comments(backendDocId),
        });
      }
    },
  });

  const comments = commentsQuery.data ?? [];

  return (
    <aside
      aria-label="Comments"
      style={{
        width: 280,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <RailHeader
        title="Comments"
        meta={
          backendDocId === null
            ? "Save to comment"
            : `${String(comments.length)} open`
        }
      />
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {backendDocId === null ? (
          <div className="empty" style={{ padding: 32 }}>
            <Icons.Comment size={22} />
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
              Not saved yet
            </div>
            <div>Comments are available once the document is saved to the backend.</div>
          </div>
        ) : commentsQuery.isLoading ? (
          <div style={{ fontSize: 12, color: "var(--text-3)", padding: 12 }}>
            Loading comments…
          </div>
        ) : comments.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <Icons.Comment size={22} />
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>No comments</div>
            <div>Select text and add a comment to start a thread.</div>
          </div>
        ) : (
          comments.map((comment) => (
            <div
              key={comment.id}
              style={{
                marginBottom: 8,
                padding: 10,
                borderRadius: 6,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Avatar name={comment.author} size={20} />
                <span style={{ fontSize: 12, fontWeight: 500 }}>{comment.author}</span>
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text)" }}>
                {comment.body}
              </div>
            </div>
          ))
        )}
      </div>
      {backendDocId !== null ? (
        <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
          <textarea
            className="input"
            aria-label="New comment"
            placeholder="Add a comment…"
            value={draft}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            style={{ width: "100%", resize: "vertical", fontSize: 12, marginBottom: 6 }}
          />
          <button
            type="button"
            className="btn sm primary"
            disabled={draft.trim().length === 0 || createMutation.isPending}
            onClick={() => createMutation.mutate(draft.trim())}
            style={{ width: "100%" }}
          >
            {createMutation.isPending ? "Posting…" : "Comment"}
          </button>
          {createMutation.isError ? (
            <div style={{ fontSize: 11, color: "var(--warning)", marginTop: 4 }}>
              Could not post comment.
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function SuggestionsRail({
  backendDocId,
  onClose,
}: {
  readonly backendDocId: string | null;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const suggestionsQuery = useQuery({
    ...docsSuggestionsQueryOptions(backendDocId ?? ""),
    enabled: backendDocId !== null,
  });

  const resolveMutation = useMutation({
    mutationFn: (input: { readonly suggestionId: string; readonly status: "accepted" | "rejected" }) =>
      resolveDocsSuggestion(input),
    onMutate: () => {
      // No optimistic write — the suggestion list is invalidated on success.
    },
    onError: () => {
      // The rail keeps the suggestion in its pending state on failure.
    },
    onSuccess: () => {
      if (backendDocId !== null) {
        void queryClient.invalidateQueries({
          queryKey: docsQueryKeys.suggestions(backendDocId),
        });
      }
    },
  });

  const suggestions = suggestionsQuery.data ?? [];

  return (
    <aside
      aria-label="Version history"
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <RailHeader
        title="Suggestions"
        meta={backendDocId === null ? undefined : `${String(suggestions.length)} total`}
        onClose={onClose}
      />
      <div style={{ overflowY: "auto", padding: 10, flex: 1 }}>
        {backendDocId === null ? (
          <div className="empty" style={{ padding: 32 }}>
            <Icons.History size={22} />
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
              Not saved yet
            </div>
            <div>Suggestions appear once the document is saved.</div>
          </div>
        ) : suggestionsQuery.isLoading ? (
          <div style={{ fontSize: 12, color: "var(--text-3)" }}>Loading suggestions…</div>
        ) : suggestions.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <Icons.EditPen size={22} />
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
              No suggestions
            </div>
            <div>Turn on Suggesting mode to propose tracked changes.</div>
          </div>
        ) : (
          suggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              pending={resolveMutation.isPending}
              onResolve={(status) =>
                resolveMutation.mutate({ suggestionId: suggestion.id, status })
              }
            />
          ))
        )}
      </div>
    </aside>
  );
}

function SuggestionCard({
  suggestion,
  pending,
  onResolve,
}: {
  readonly suggestion: DocsSuggestion;
  readonly pending: boolean;
  readonly onResolve: (status: "accepted" | "rejected") => void;
}) {
  return (
    <div
      style={{
        marginBottom: 8,
        padding: 10,
        borderRadius: 6,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <Icons.EditPen size={14} />
        <span style={{ fontWeight: 500 }}>Suggested edit</span>
        <span
          className={
            suggestion.status === "accepted"
              ? "chip success"
              : suggestion.status === "rejected"
                ? "chip"
                : "chip"
          }
          style={{ marginLeft: "auto", fontSize: 10 }}
        >
          {suggestion.status}
        </span>
      </div>
      <div style={{ marginBottom: 4 }}>
        <span
          style={{
            background: "var(--warning-soft)",
            textDecoration: "line-through",
            padding: "0 2px",
          }}
        >
          {suggestion.beforeText}
        </span>
      </div>
      <div style={{ marginBottom: 6 }}>
        <span style={{ background: "var(--accent-soft)", padding: "0 2px" }}>
          {suggestion.afterText}
        </span>
      </div>
      {suggestion.reason.length > 0 ? (
        <div style={{ color: "var(--text-3)", marginBottom: 6 }}>{suggestion.reason}</div>
      ) : null}
      {suggestion.status === "pending" ? (
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn sm primary"
            disabled={pending}
            onClick={() => onResolve("accepted")}
          >
            Accept
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => onResolve("rejected")}
          >
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AiRail({ onClose }: { readonly onClose: () => void }) {
  return (
    <aside
      aria-label="Helix AI"
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
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Icons.Sparkles />
        <span style={{ fontSize: 12, fontWeight: 600 }}>Helix AI</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close Helix AI"
          style={{ marginLeft: "auto" }}
          onClick={onClose}
        >
          <Icons.X />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12, fontSize: 12 }}>
        <div
          style={{
            marginBottom: 10,
            color: "var(--text-3)",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: ".06em",
          }}
        >
          Suggested for this doc
        </div>
        {DOC_AI_SUGGESTIONS.map((suggestion) => {
          const Icon = suggestion.icon;
          return (
            <button
              key={suggestion.id}
              type="button"
              style={{
                width: "100%",
                textAlign: "left",
                padding: 10,
                borderRadius: 6,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  display: "grid",
                  placeItems: "center",
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  flexShrink: 0,
                }}
              >
                <Icon />
              </span>
              <span>
                <span style={{ display: "block", fontWeight: 500 }}>{suggestion.title}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--text-3)" }}>
                  {suggestion.sub}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            height: 34,
          }}
        >
          <Icons.Sparkles />
          <input
            placeholder="Ask Helix AI…"
            aria-label="Ask Helix AI"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 12,
            }}
          />
          <button type="button" className="icon-btn" aria-label="Send message">
            <Icons.Send />
          </button>
        </div>
      </div>
    </aside>
  );
}

function paragraphValue(editor: Editor | null): string {
  if (editor === null) {
    return "Body text";
  }
  if (editor.isActive("heading", { level: 1 })) {
    return "Heading 1";
  }
  if (editor.isActive("heading", { level: 2 })) {
    return "Heading 2";
  }
  if (editor.isActive("heading", { level: 3 })) {
    return "Heading 3";
  }
  return "Body text";
}

function exportFilenameHint(title: string, format: DocsExportFormat): string {
  const base =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 40) || "untitled";
  return `${base}.${format === "markdown" ? "md" : format}`;
}

/** Triggers a browser download for a base64-encoded export payload. */
function downloadExport(contentBase64: string, filename: string, mimeType: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
