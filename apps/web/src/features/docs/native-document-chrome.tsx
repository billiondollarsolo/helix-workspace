import type { ReactNode } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  FileText,
  Hash,
  Highlighter,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  MessageSquarePlus,
  Palette,
  Redo2,
  Search,
  Sigma,
  Sparkles,
  Strikethrough,
  Table as TableIcon,
  Underline,
  Undo2,
} from "lucide-react";
import {
  EditorRibbon,
  RibbonButton,
  RibbonColorPicker,
  RibbonDivider,
  RibbonGroup,
  RibbonSelect,
  RibbonToggle,
  type MenuBarMenu,
  type MenuItem,
} from "@helix/editors-ui";

/** Editor command surface needed by the docs chrome. Mirrors the TipTap Editor shape. */
export interface DocsChromeEditorLike {
  chain(): DocsChromeChain;
  isActive(name: string, attributes?: Record<string, unknown>): boolean;
}

export interface DocsChromeChain {
  focus(): DocsChromeChain;
  setTextSelection(selection: { readonly from: number; readonly to: number }): DocsChromeChain;
  selectAll(): DocsChromeChain;
  toggleBold(): DocsChromeChain;
  toggleItalic(): DocsChromeChain;
  toggleUnderline(): DocsChromeChain;
  toggleStrike(): DocsChromeChain;
  setParagraph(): DocsChromeChain;
  toggleHeading(input: { readonly level: 1 | 2 | 3 }): DocsChromeChain;
  toggleBulletList(): DocsChromeChain;
  toggleOrderedList(): DocsChromeChain;
  toggleNativeChecklist(): DocsChromeChain;
  sinkListItem(typeOrName: string): DocsChromeChain;
  liftListItem(typeOrName: string): DocsChromeChain;
  toggleCodeBlock(): DocsChromeChain;
  toggleBlockquote(): DocsChromeChain;
  setNativeTextColor(color: string): DocsChromeChain;
  setNativeHighlightColor(color: string): DocsChromeChain;
  setNativeTextAlign(align: "left" | "center" | "right" | "justify"): DocsChromeChain;
  unsetAllMarks(): DocsChromeChain;
  clearNodes(): DocsChromeChain;
  undo(): DocsChromeChain;
  redo(): DocsChromeChain;
  run(): boolean;
}

export type DocsParagraphStyle =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "blockquote"
  | "codeBlock";

export type DocsDocumentMode = "editing" | "viewing";

export interface DocsChromeCallbacks {
  readonly onBack?: () => void;
  readonly onNewDocument?: () => void;
  readonly onOpenDocuments?: () => void;
  readonly onMakeCopy?: () => void;
  readonly onMoveToTrash?: () => void;
  readonly onCopyLink?: () => void;
  readonly onInsertLink?: () => void;
  readonly onInsertImage?: () => void;
  readonly onInsertTable?: () => void;
  readonly onInsertEquation?: () => void;
  readonly onInsertComment?: () => void;
  readonly onInsertTOC?: () => void;
  readonly onInsertBookmark?: () => void;
  readonly onInsertPageBreak?: () => void;
  readonly onInsertCrossReference?: () => void;
  readonly onInsertField?: () => void;
  readonly onInsertSmartChip?: () => void;
  readonly onCut?: () => void;
  readonly onCopy?: () => void;
  readonly onPaste?: () => void;
  readonly onPastePlain?: () => void;
  readonly onInsertFootnote?: () => void;
  readonly onOpenFindReplace?: () => void;
  readonly onOpenOutline?: () => void;
  readonly onOpenWordCount?: () => void;
  readonly onOpenSpelling?: () => void;
  readonly onOpenVersionHistory?: () => void;
  readonly onOpenShareDialog?: () => void;
  readonly onToggleRulers?: () => void;
  readonly onToggleNonPrintingCharacters?: () => void;
  readonly onToggleFullscreen?: () => void;
  readonly onExport?: (format: "docx" | "pdf" | "epub") => void;
  readonly onPrint?: () => void;
  readonly onRefreshFields?: () => void;
  readonly onAskAI?: () => void;
  readonly onSmartCompose?: () => void;
  readonly onRename?: () => void;
  readonly onSetParagraphStyle?: (style: DocsParagraphStyle) => void;
  readonly onSetTextAlign?: (align: "left" | "center" | "right" | "justify") => void;
  readonly onIndent?: () => void;
  readonly onOutdent?: () => void;
  readonly onToggleChecklist?: () => void;
  readonly onSetTextColor?: (color: string) => void;
  readonly onSetHighlightColor?: (color: string) => void;
  readonly onSetDocumentMode?: (mode: DocsDocumentMode) => void;
  readonly onOpenKeyboardShortcuts?: () => void;
  readonly onOpenAbout?: () => void;
}

export interface DocsChromeState {
  readonly textColor: string;
  readonly highlightColor: string;
  readonly paragraphStyle: DocsParagraphStyle;
  readonly documentMode: DocsDocumentMode;
  readonly showRulers: boolean;
  readonly showNonPrintingCharacters: boolean;
}

export interface DocsChromeContext {
  readonly editor: DocsChromeEditorLike | null;
  readonly state: DocsChromeState;
  readonly callbacks: DocsChromeCallbacks;
}

const TODO_NOOP = (): void => {
  // TODO: wire when corresponding editor capability lands.
};

function runChain(
  editor: DocsChromeEditorLike | null,
  apply: (chain: DocsChromeChain) => DocsChromeChain,
): void {
  if (editor === null) return;
  try {
    apply(editor.chain().focus()).run();
  } catch {
    // ignore; editor commands are best-effort from chrome.
  }
}

function isActive(
  editor: DocsChromeEditorLike | null,
  name: string,
  attrs?: Record<string, unknown>,
): boolean {
  if (editor === null) return false;
  try {
    return editor.isActive(name, attrs);
  } catch {
    return false;
  }
}

const PARAGRAPH_STYLE_OPTIONS = [
  { value: "paragraph", label: "Normal text" },
  { value: "heading1", label: "Heading 1" },
  { value: "heading2", label: "Heading 2" },
  { value: "heading3", label: "Heading 3" },
  { value: "blockquote", label: "Quote" },
  { value: "codeBlock", label: "Code" },
] as const;

const TEXT_COLOR_PRESETS = [
  { value: "#000000", label: "Black" },
  { value: "#374151", label: "Gray 700" },
  { value: "#6b7280", label: "Gray 500" },
  { value: "#ef4444", label: "Red" },
  { value: "#f97316", label: "Orange" },
  { value: "#eab308", label: "Yellow" },
  { value: "#22c55e", label: "Green" },
  { value: "#0ea5e9", label: "Sky" },
  { value: "#6366f1", label: "Indigo" },
  { value: "#a855f7", label: "Purple" },
  { value: "#ec4899", label: "Pink" },
  { value: "#ffffff", label: "White" },
] as const;

const HIGHLIGHT_COLOR_PRESETS = [
  { value: "#fef08a", label: "Yellow" },
  { value: "#fecaca", label: "Red" },
  { value: "#fed7aa", label: "Orange" },
  { value: "#bbf7d0", label: "Green" },
  { value: "#bae6fd", label: "Blue" },
  { value: "#e9d5ff", label: "Purple" },
] as const;

/**
 * Build the menu bar definition. Returns the nine menus required by the
 * unified editor chrome (File, Edit, View, Insert, Format, Tools, AI, Share, Help).
 */
export function buildDocsMenus(ctx: DocsChromeContext): MenuBarMenu[] {
  const { editor, callbacks } = ctx;
  const cb = callbacks;

  const fileMenu: MenuBarMenu = {
    id: "file",
    label: "File",
    items: [
      { id: "file.new", label: "New document", onSelect: cb.onNewDocument ?? TODO_NOOP },
      { id: "file.open", label: "Open...", onSelect: cb.onOpenDocuments ?? TODO_NOOP },
      { kind: "separator" },
      { id: "file.rename", label: "Rename", onSelect: cb.onRename ?? TODO_NOOP },
      { id: "file.makeCopy", label: "Make a copy", onSelect: cb.onMakeCopy ?? TODO_NOOP },
      {
        id: "file.moveToTrash",
        label: "Move to trash",
        destructive: true,
        onSelect: cb.onMoveToTrash ?? TODO_NOOP,
      },
      { kind: "separator" },
      {
        kind: "submenu",
        id: "file.download",
        label: "Download",
        items: [
          {
            id: "file.download.docx",
            label: "Microsoft Word (.docx)",
            onSelect: () => cb.onExport?.("docx"),
          },
          {
            id: "file.download.pdf",
            label: "PDF (.pdf)",
            onSelect: () => cb.onExport?.("pdf"),
          },
          {
            id: "file.download.epub",
            label: "EPUB (.epub)",
            onSelect: () => cb.onExport?.("epub"),
          },
        ],
      },
      { id: "file.print", label: "Print", keybinding: "Ctrl+P", onSelect: cb.onPrint ?? TODO_NOOP },
      { kind: "separator" },
      {
        id: "file.versionHistory",
        label: "Version history",
        onSelect: cb.onOpenVersionHistory ?? TODO_NOOP,
      },
    ],
  };

  const editMenu: MenuBarMenu = {
    id: "edit",
    label: "Edit",
    items: [
      {
        id: "edit.undo",
        label: "Undo",
        keybinding: "Ctrl+Z",
        onSelect: () => runChain(editor, (c) => c.undo()),
      },
      {
        id: "edit.redo",
        label: "Redo",
        keybinding: "Ctrl+Shift+Z",
        onSelect: () => runChain(editor, (c) => c.redo()),
      },
      { kind: "separator" },
      { id: "edit.cut", label: "Cut", keybinding: "Ctrl+X", onSelect: cb.onCut ?? TODO_NOOP },
      { id: "edit.copy", label: "Copy", keybinding: "Ctrl+C", onSelect: cb.onCopy ?? TODO_NOOP },
      { id: "edit.paste", label: "Paste", keybinding: "Ctrl+V", onSelect: cb.onPaste ?? TODO_NOOP },
      {
        id: "edit.pastePlain",
        label: "Paste without formatting",
        keybinding: "Ctrl+Shift+V",
        onSelect: cb.onPastePlain ?? TODO_NOOP,
      },
      { kind: "separator" },
      {
        id: "edit.selectAll",
        label: "Select all",
        keybinding: "Ctrl+A",
        onSelect: () => runChain(editor, (c) => c.selectAll()),
      },
      {
        id: "edit.findReplace",
        label: "Find and replace",
        keybinding: "Ctrl+F",
        onSelect: cb.onOpenFindReplace ?? TODO_NOOP,
      },
    ],
  };

  const viewMenu: MenuBarMenu = {
    id: "view",
    label: "View",
    items: [
      {
        kind: "submenu",
        id: "view.mode",
        label: "Mode",
        items: [
          {
            kind: "checkbox",
            id: "view.mode.editing",
            label: "Editing",
            checked: ctx.state.documentMode === "editing",
            onCheckedChange: () => cb.onSetDocumentMode?.("editing"),
          },
          {
            kind: "checkbox",
            id: "view.mode.viewing",
            label: "Viewing",
            checked: ctx.state.documentMode === "viewing",
            onCheckedChange: () => cb.onSetDocumentMode?.("viewing"),
          },
        ],
      },
      { kind: "separator" },
      { id: "view.outline", label: "Show outline", onSelect: cb.onOpenOutline ?? TODO_NOOP },
      {
        id: "view.rulers",
        label: ctx.state.showRulers ? "Hide ruler" : "Show ruler",
        onSelect: cb.onToggleRulers ?? TODO_NOOP,
      },
      {
        id: "view.nonprinting",
        label: ctx.state.showNonPrintingCharacters
          ? "Hide non-printing characters"
          : "Show non-printing characters",
        onSelect: cb.onToggleNonPrintingCharacters ?? TODO_NOOP,
      },
      { kind: "separator" },
      { id: "view.fullscreen", label: "Full screen", onSelect: cb.onToggleFullscreen ?? TODO_NOOP },
    ],
  };

  const insertMenu: MenuBarMenu = {
    id: "insert",
    label: "Insert",
    items: [
      { id: "insert.image", label: "Image", onSelect: cb.onInsertImage ?? TODO_NOOP },
      { id: "insert.table", label: "Table", onSelect: cb.onInsertTable ?? TODO_NOOP },
      {
        id: "insert.link",
        label: "Link",
        keybinding: "Ctrl+K",
        onSelect: cb.onInsertLink ?? TODO_NOOP,
      },
      {
        id: "insert.comment",
        label: "Comment",
        keybinding: "Ctrl+Alt+M",
        onSelect: cb.onInsertComment ?? TODO_NOOP,
      },
      { kind: "separator" },
      { id: "insert.equation", label: "Equation", onSelect: cb.onInsertEquation ?? TODO_NOOP },
      { id: "insert.toc", label: "Table of contents", onSelect: cb.onInsertTOC ?? TODO_NOOP },
      { id: "insert.bookmark", label: "Bookmark", onSelect: cb.onInsertBookmark ?? TODO_NOOP },
      {
        id: "insert.crossRef",
        label: "Cross-reference",
        onSelect: cb.onInsertCrossReference ?? TODO_NOOP,
      },
      { kind: "separator" },
      { id: "insert.field", label: "Field", onSelect: cb.onInsertField ?? TODO_NOOP },
      { id: "insert.smartChip", label: "Smart chip", onSelect: cb.onInsertSmartChip ?? TODO_NOOP },
      { id: "insert.pageBreak", label: "Page break", onSelect: cb.onInsertPageBreak ?? TODO_NOOP },
      { id: "insert.footnote", label: "Footnote", onSelect: cb.onInsertFootnote ?? TODO_NOOP },
    ],
  };

  const formatMenu: MenuBarMenu = {
    id: "format",
    label: "Format",
    items: [
      {
        id: "format.bold",
        label: "Bold",
        keybinding: "Ctrl+B",
        onSelect: () => runChain(editor, (c) => c.toggleBold()),
      },
      {
        id: "format.italic",
        label: "Italic",
        keybinding: "Ctrl+I",
        onSelect: () => runChain(editor, (c) => c.toggleItalic()),
      },
      {
        id: "format.underline",
        label: "Underline",
        keybinding: "Ctrl+U",
        onSelect: () => runChain(editor, (c) => c.toggleUnderline()),
      },
      {
        id: "format.strike",
        label: "Strikethrough",
        onSelect: () => runChain(editor, (c) => c.toggleStrike()),
      },
      { kind: "separator" },
      {
        kind: "submenu",
        id: "format.paragraph",
        label: "Paragraph styles",
        items: [
          {
            id: "format.paragraph.normal",
            label: "Normal text",
            onSelect: () => runChain(editor, (c) => c.setParagraph()),
          },
          {
            id: "format.paragraph.h1",
            label: "Heading 1",
            onSelect: () => runChain(editor, (c) => c.toggleHeading({ level: 1 })),
          },
          {
            id: "format.paragraph.h2",
            label: "Heading 2",
            onSelect: () => runChain(editor, (c) => c.toggleHeading({ level: 2 })),
          },
          {
            id: "format.paragraph.h3",
            label: "Heading 3",
            onSelect: () => runChain(editor, (c) => c.toggleHeading({ level: 3 })),
          },
          {
            id: "format.paragraph.quote",
            label: "Quote",
            onSelect: () => runChain(editor, (c) => c.toggleBlockquote()),
          },
          {
            id: "format.paragraph.code",
            label: "Code",
            onSelect: () => runChain(editor, (c) => c.toggleCodeBlock()),
          },
        ],
      },
      {
        kind: "submenu",
        id: "format.align",
        label: "Align",
        items: [
          {
            id: "format.align.left",
            label: "Left",
            onSelect: () => setDocsTextAlign(editor, callbacks, "left"),
          },
          {
            id: "format.align.center",
            label: "Center",
            onSelect: () => setDocsTextAlign(editor, callbacks, "center"),
          },
          {
            id: "format.align.right",
            label: "Right",
            onSelect: () => setDocsTextAlign(editor, callbacks, "right"),
          },
          {
            id: "format.align.justify",
            label: "Justify",
            onSelect: () => setDocsTextAlign(editor, callbacks, "justify"),
          },
        ],
      },
      {
        kind: "submenu",
        id: "format.lists",
        label: "Lists",
        items: [
          {
            id: "format.lists.bullet",
            label: "Bulleted list",
            onSelect: () => runChain(editor, (c) => c.toggleBulletList()),
          },
          {
            id: "format.lists.numbered",
            label: "Numbered list",
            onSelect: () => runChain(editor, (c) => c.toggleOrderedList()),
          },
          {
            id: "format.lists.checklist",
            label: "Checklist",
            onSelect: () => runChain(editor, (c) => c.toggleNativeChecklist()),
          },
        ],
      },
      { kind: "separator" },
      {
        id: "format.clear",
        label: "Clear formatting",
        keybinding: "Ctrl+\\",
        onSelect: () => runChain(editor, (c) => c.unsetAllMarks().clearNodes()),
      },
    ],
  };

  const toolsMenu: MenuBarMenu = {
    id: "tools",
    label: "Tools",
    items: [
      {
        id: "tools.spelling",
        label: "Spelling and grammar",
        onSelect: cb.onOpenSpelling ?? TODO_NOOP,
      },
      {
        id: "tools.wordCount",
        label: "Word count",
        keybinding: "Ctrl+Shift+C",
        onSelect: cb.onOpenWordCount ?? TODO_NOOP,
      },
      { kind: "separator" },
      {
        id: "tools.findReplace",
        label: "Find and replace",
        keybinding: "Ctrl+F",
        onSelect: cb.onOpenFindReplace ?? TODO_NOOP,
      },
      {
        id: "tools.refreshFields",
        label: "Refresh fields",
        onSelect: cb.onRefreshFields ?? TODO_NOOP,
      },
      { kind: "separator" },
      { id: "tools.preferences", label: "Preferences", onSelect: TODO_NOOP },
    ],
  };

  const aiMenu: MenuBarMenu = {
    id: "ai",
    label: "AI",
    items: [
      { id: "ai.ask", label: "Ask this document", onSelect: cb.onAskAI ?? TODO_NOOP },
      { id: "ai.compose", label: "Smart compose", onSelect: cb.onSmartCompose ?? TODO_NOOP },
    ],
  };

  const shareMenu: MenuBarMenu = {
    id: "share",
    label: "Share",
    items: [
      {
        id: "share.invite",
        label: "Share with people",
        onSelect: cb.onOpenShareDialog ?? TODO_NOOP,
      },
      { id: "share.copyLink", label: "Copy link", onSelect: cb.onCopyLink ?? TODO_NOOP },
    ],
  };

  const helpMenu: MenuBarMenu = {
    id: "help",
    label: "Help",
    items: [
      {
        id: "help.shortcuts",
        label: "Keyboard shortcuts",
        keybinding: "Ctrl+/",
        onSelect: cb.onOpenKeyboardShortcuts ?? TODO_NOOP,
      },
      { id: "help.about", label: "About Helix Docs", onSelect: cb.onOpenAbout ?? TODO_NOOP },
    ],
  };

  return [
    fileMenu,
    editMenu,
    viewMenu,
    insertMenu,
    formatMenu,
    toolsMenu,
    aiMenu,
    shareMenu,
    helpMenu,
  ];
}

/** Build the Google-style ribbon for the docs editor. */
export function buildDocsRibbon(ctx: DocsChromeContext): ReactNode {
  const { editor, state, callbacks } = ctx;
  const editable = editor !== null;

  return (
    <EditorRibbon ariaLabel="Document formatting">
      <RibbonGroup label="History">
        <RibbonButton
          icon={<Undo2 className="h-4 w-4" aria-hidden="true" />}
          label="Undo"
          keybinding="Ctrl+Z"
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.undo())}
        />
        <RibbonButton
          icon={<Redo2 className="h-4 w-4" aria-hidden="true" />}
          label="Redo"
          keybinding="Ctrl+Shift+Z"
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.redo())}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Paragraph style">
        <RibbonSelect<DocsParagraphStyle>
          ariaLabel="Paragraph style"
          value={state.paragraphStyle}
          options={[...PARAGRAPH_STYLE_OPTIONS]}
          width={148}
          disabled={!editable}
          onChange={(next: DocsParagraphStyle) => {
            callbacks.onSetParagraphStyle?.(next);
            switch (next) {
              case "paragraph":
                runChain(editor, (c) => c.setParagraph());
                break;
              case "heading1":
                runChain(editor, (c) => c.toggleHeading({ level: 1 }));
                break;
              case "heading2":
                runChain(editor, (c) => c.toggleHeading({ level: 2 }));
                break;
              case "heading3":
                runChain(editor, (c) => c.toggleHeading({ level: 3 }));
                break;
              case "blockquote":
                runChain(editor, (c) => c.toggleBlockquote());
                break;
              case "codeBlock":
                runChain(editor, (c) => c.toggleCodeBlock());
                break;
            }
          }}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Text formatting">
        <RibbonToggle
          icon={<Bold className="h-4 w-4" aria-hidden="true" />}
          label="Bold"
          keybinding="Ctrl+B"
          pressed={isActive(editor, "bold")}
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.toggleBold())}
        />
        <RibbonToggle
          icon={<Italic className="h-4 w-4" aria-hidden="true" />}
          label="Italic"
          keybinding="Ctrl+I"
          pressed={isActive(editor, "italic")}
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.toggleItalic())}
        />
        <RibbonToggle
          icon={<Underline className="h-4 w-4" aria-hidden="true" />}
          label="Underline"
          keybinding="Ctrl+U"
          pressed={isActive(editor, "underline")}
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.toggleUnderline())}
        />
        <RibbonToggle
          icon={<Strikethrough className="h-4 w-4" aria-hidden="true" />}
          label="Strikethrough"
          pressed={isActive(editor, "strike")}
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.toggleStrike())}
        />
        <RibbonColorPicker
          icon={<Palette className="h-4 w-4" aria-hidden="true" />}
          ariaLabel="Text color"
          value={state.textColor}
          onChange={(next: string) => {
            callbacks.onSetTextColor?.(next);
            runChain(editor, (c) => c.setNativeTextColor(next));
          }}
          presets={[...TEXT_COLOR_PRESETS]}
        />
        <RibbonColorPicker
          icon={<Highlighter className="h-4 w-4" aria-hidden="true" />}
          ariaLabel="Highlight color"
          value={state.highlightColor}
          onChange={(next: string) => {
            callbacks.onSetHighlightColor?.(next);
            runChain(editor, (c) => c.setNativeHighlightColor(next));
          }}
          presets={[...HIGHLIGHT_COLOR_PRESETS]}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Alignment">
        <RibbonButton
          icon={<AlignLeft className="h-4 w-4" aria-hidden="true" />}
          label="Align left"
          disabled={!editable}
          onClick={() => setDocsTextAlign(editor, callbacks, "left")}
        />
        <RibbonButton
          icon={<AlignCenter className="h-4 w-4" aria-hidden="true" />}
          label="Align center"
          disabled={!editable}
          onClick={() => setDocsTextAlign(editor, callbacks, "center")}
        />
        <RibbonButton
          icon={<AlignRight className="h-4 w-4" aria-hidden="true" />}
          label="Align right"
          disabled={!editable}
          onClick={() => setDocsTextAlign(editor, callbacks, "right")}
        />
        <RibbonButton
          icon={<AlignJustify className="h-4 w-4" aria-hidden="true" />}
          label="Justify"
          disabled={!editable}
          onClick={() => setDocsTextAlign(editor, callbacks, "justify")}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Lists">
        <RibbonToggle
          icon={<List className="h-4 w-4" aria-hidden="true" />}
          label="Bulleted list"
          pressed={isActive(editor, "bulletList")}
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.toggleBulletList())}
        />
        <RibbonToggle
          icon={<ListOrdered className="h-4 w-4" aria-hidden="true" />}
          label="Numbered list"
          pressed={isActive(editor, "orderedList")}
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.toggleOrderedList())}
        />
        <RibbonButton
          icon={<CheckSquare className="h-4 w-4" aria-hidden="true" />}
          label="Checklist"
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.toggleNativeChecklist())}
        />
        <RibbonButton
          icon={<IndentDecrease className="h-4 w-4" aria-hidden="true" />}
          label="Decrease indent"
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.liftListItem("listItem"))}
        />
        <RibbonButton
          icon={<IndentIncrease className="h-4 w-4" aria-hidden="true" />}
          label="Increase indent"
          disabled={!editable}
          onClick={() => runChain(editor, (c) => c.sinkListItem("listItem"))}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Insert">
        <RibbonButton
          icon={<LinkIcon className="h-4 w-4" aria-hidden="true" />}
          label="Insert link"
          keybinding="Ctrl+K"
          disabled={!editable}
          onClick={callbacks.onInsertLink ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<ImageIcon className="h-4 w-4" aria-hidden="true" />}
          label="Insert image"
          disabled={!editable}
          onClick={callbacks.onInsertImage ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<TableIcon className="h-4 w-4" aria-hidden="true" />}
          label="Insert table"
          disabled={!editable}
          onClick={callbacks.onInsertTable ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Sigma className="h-4 w-4" aria-hidden="true" />}
          label="Insert equation"
          disabled={!editable}
          onClick={callbacks.onInsertEquation ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<MessageSquarePlus className="h-4 w-4" aria-hidden="true" />}
          label="Add comment"
          disabled={!editable}
          onClick={callbacks.onInsertComment ?? TODO_NOOP}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Tools">
        <RibbonButton
          icon={<FileText className="h-4 w-4" aria-hidden="true" />}
          label="Insert table of contents"
          disabled={!editable}
          onClick={callbacks.onInsertTOC ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Hash className="h-4 w-4" aria-hidden="true" />}
          label="Insert bookmark"
          disabled={!editable}
          onClick={callbacks.onInsertBookmark ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Search className="h-4 w-4" aria-hidden="true" />}
          label="Find and replace"
          keybinding="Ctrl+F"
          disabled={!editable}
          onClick={callbacks.onOpenFindReplace ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
          label="Ask AI"
          disabled={!editable}
          onClick={callbacks.onAskAI ?? TODO_NOOP}
        />
      </RibbonGroup>
    </EditorRibbon>
  );
}

function setDocsTextAlign(
  editor: DocsChromeEditorLike | null,
  callbacks: DocsChromeCallbacks,
  align: "left" | "center" | "right" | "justify",
): void {
  callbacks.onSetTextAlign?.(align);
  runChain(editor, (c) => c.setNativeTextAlign(align));
}

// Re-export type aliases for ease of consumption in tests.
export type { MenuBarMenu, MenuItem };
