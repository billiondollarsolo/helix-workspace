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
  // Required by the shared menu/ribbon command contract for disabled controls.
};

const DOCS_COMMAND_UNAVAILABLE = "This command is not available in this editor yet.";

function optionalCommand(action: (() => void) | undefined): {
  readonly onSelect: () => void;
  readonly disabled: boolean;
  readonly disabledReason?: string;
} {
  if (action !== undefined) {
    return { onSelect: action, disabled: false };
  }
  return {
    onSelect: TODO_NOOP,
    disabled: true,
    disabledReason: DOCS_COMMAND_UNAVAILABLE,
  };
}

function ribbonDisabledReason(
  editable: boolean,
  action: (() => void) | undefined,
): string | undefined {
  if (!editable) {
    return "Switch to editing mode to use this command.";
  }
  return action === undefined ? DOCS_COMMAND_UNAVAILABLE : undefined;
}

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
      { id: "file.new", label: "New document", ...optionalCommand(cb.onNewDocument) },
      { id: "file.open", label: "Open…", ...optionalCommand(cb.onOpenDocuments) },
      { kind: "separator" },
      { id: "file.rename", label: "Rename", ...optionalCommand(cb.onRename) },
      { id: "file.makeCopy", label: "Make a copy", ...optionalCommand(cb.onMakeCopy) },
      {
        id: "file.moveToTrash",
        label: "Move to trash",
        destructive: true,
        ...optionalCommand(cb.onMoveToTrash),
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
            ...optionalCommand(cb.onExport === undefined ? undefined : () => cb.onExport?.("docx")),
          },
          {
            id: "file.download.pdf",
            label: "PDF (.pdf)",
            ...optionalCommand(cb.onExport === undefined ? undefined : () => cb.onExport?.("pdf")),
          },
          {
            id: "file.download.epub",
            label: "EPUB (.epub)",
            ...optionalCommand(cb.onExport === undefined ? undefined : () => cb.onExport?.("epub")),
          },
        ],
      },
      {
        id: "file.print",
        label: "Print",
        keybinding: "Ctrl+P",
        ...optionalCommand(cb.onPrint),
      },
      { kind: "separator" },
      {
        id: "file.versionHistory",
        label: "Version history",
        ...optionalCommand(cb.onOpenVersionHistory),
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
      { id: "edit.cut", label: "Cut", keybinding: "Ctrl+X", ...optionalCommand(cb.onCut) },
      { id: "edit.copy", label: "Copy", keybinding: "Ctrl+C", ...optionalCommand(cb.onCopy) },
      { id: "edit.paste", label: "Paste", keybinding: "Ctrl+V", ...optionalCommand(cb.onPaste) },
      {
        id: "edit.pastePlain",
        label: "Paste without formatting",
        keybinding: "Ctrl+Shift+V",
        ...optionalCommand(cb.onPastePlain),
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
        ...optionalCommand(cb.onOpenFindReplace),
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
            disabled: cb.onSetDocumentMode === undefined,
            disabledReason:
              cb.onSetDocumentMode === undefined ? DOCS_COMMAND_UNAVAILABLE : undefined,
            onCheckedChange: () => cb.onSetDocumentMode?.("editing"),
          },
          {
            kind: "checkbox",
            id: "view.mode.viewing",
            label: "Viewing",
            checked: ctx.state.documentMode === "viewing",
            disabled: cb.onSetDocumentMode === undefined,
            disabledReason:
              cb.onSetDocumentMode === undefined ? DOCS_COMMAND_UNAVAILABLE : undefined,
            onCheckedChange: () => cb.onSetDocumentMode?.("viewing"),
          },
        ],
      },
      { kind: "separator" },
      { id: "view.outline", label: "Show outline", ...optionalCommand(cb.onOpenOutline) },
      {
        id: "view.rulers",
        label: ctx.state.showRulers ? "Hide ruler" : "Show ruler",
        ...optionalCommand(cb.onToggleRulers),
      },
      {
        id: "view.nonprinting",
        label: ctx.state.showNonPrintingCharacters
          ? "Hide non-printing characters"
          : "Show non-printing characters",
        ...optionalCommand(cb.onToggleNonPrintingCharacters),
      },
      { kind: "separator" },
      {
        id: "view.fullscreen",
        label: "Full screen",
        ...optionalCommand(cb.onToggleFullscreen),
      },
    ],
  };

  const insertMenu: MenuBarMenu = {
    id: "insert",
    label: "Insert",
    items: [
      { id: "insert.image", label: "Image", ...optionalCommand(cb.onInsertImage) },
      { id: "insert.table", label: "Table", ...optionalCommand(cb.onInsertTable) },
      {
        id: "insert.link",
        label: "Link",
        keybinding: "Ctrl+K",
        ...optionalCommand(cb.onInsertLink),
      },
      {
        id: "insert.comment",
        label: "Comment",
        keybinding: "Ctrl+Alt+M",
        ...optionalCommand(cb.onInsertComment),
      },
      { kind: "separator" },
      { id: "insert.equation", label: "Equation", ...optionalCommand(cb.onInsertEquation) },
      { id: "insert.toc", label: "Table of contents", ...optionalCommand(cb.onInsertTOC) },
      { id: "insert.bookmark", label: "Bookmark", ...optionalCommand(cb.onInsertBookmark) },
      {
        id: "insert.crossRef",
        label: "Cross-reference",
        ...optionalCommand(cb.onInsertCrossReference),
      },
      { kind: "separator" },
      { id: "insert.field", label: "Field", ...optionalCommand(cb.onInsertField) },
      { id: "insert.smartChip", label: "Smart chip", ...optionalCommand(cb.onInsertSmartChip) },
      { id: "insert.pageBreak", label: "Page break", ...optionalCommand(cb.onInsertPageBreak) },
      { id: "insert.footnote", label: "Footnote", ...optionalCommand(cb.onInsertFootnote) },
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
        ...optionalCommand(cb.onOpenSpelling),
      },
      {
        id: "tools.wordCount",
        label: "Word count",
        keybinding: "Ctrl+Shift+C",
        ...optionalCommand(cb.onOpenWordCount),
      },
      { kind: "separator" },
      {
        id: "tools.findReplace",
        label: "Find and replace",
        keybinding: "Ctrl+F",
        ...optionalCommand(cb.onOpenFindReplace),
      },
      {
        id: "tools.refreshFields",
        label: "Refresh fields",
        ...optionalCommand(cb.onRefreshFields),
      },
      { kind: "separator" },
      { id: "tools.preferences", label: "Preferences", ...optionalCommand(undefined) },
    ],
  };

  const aiMenu: MenuBarMenu = {
    id: "ai",
    label: "AI",
    items: [
      { id: "ai.ask", label: "Ask this document", ...optionalCommand(cb.onAskAI) },
      { id: "ai.compose", label: "Smart compose", ...optionalCommand(cb.onSmartCompose) },
    ],
  };

  const shareMenu: MenuBarMenu = {
    id: "share",
    label: "Share",
    items: [
      {
        id: "share.invite",
        label: "Share with people",
        ...optionalCommand(cb.onOpenShareDialog),
      },
      { id: "share.copyLink", label: "Copy link", ...optionalCommand(cb.onCopyLink) },
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
        ...optionalCommand(cb.onOpenKeyboardShortcuts),
      },
      { id: "help.about", label: "About Helix Docs", ...optionalCommand(cb.onOpenAbout) },
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
          disabled={!editable || callbacks.onInsertLink === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onInsertLink)}
          onClick={callbacks.onInsertLink ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<ImageIcon className="h-4 w-4" aria-hidden="true" />}
          label="Insert image"
          disabled={!editable || callbacks.onInsertImage === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onInsertImage)}
          onClick={callbacks.onInsertImage ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<TableIcon className="h-4 w-4" aria-hidden="true" />}
          label="Insert table"
          disabled={!editable || callbacks.onInsertTable === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onInsertTable)}
          onClick={callbacks.onInsertTable ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Sigma className="h-4 w-4" aria-hidden="true" />}
          label="Insert equation"
          disabled={!editable || callbacks.onInsertEquation === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onInsertEquation)}
          onClick={callbacks.onInsertEquation ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<MessageSquarePlus className="h-4 w-4" aria-hidden="true" />}
          label="Add comment"
          disabled={!editable || callbacks.onInsertComment === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onInsertComment)}
          onClick={callbacks.onInsertComment ?? TODO_NOOP}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Tools">
        <RibbonButton
          icon={<FileText className="h-4 w-4" aria-hidden="true" />}
          label="Insert table of contents"
          disabled={!editable || callbacks.onInsertTOC === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onInsertTOC)}
          onClick={callbacks.onInsertTOC ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Hash className="h-4 w-4" aria-hidden="true" />}
          label="Insert bookmark"
          disabled={!editable || callbacks.onInsertBookmark === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onInsertBookmark)}
          onClick={callbacks.onInsertBookmark ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Search className="h-4 w-4" aria-hidden="true" />}
          label="Find and replace"
          keybinding="Ctrl+F"
          disabled={!editable || callbacks.onOpenFindReplace === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onOpenFindReplace)}
          onClick={callbacks.onOpenFindReplace ?? TODO_NOOP}
        />
        <RibbonButton
          icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
          label="Ask AI"
          disabled={!editable || callbacks.onAskAI === undefined}
          disabledReason={ribbonDisabledReason(editable, callbacks.onAskAI)}
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
