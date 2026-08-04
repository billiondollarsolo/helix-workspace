/* Slides editor chrome — declarative menu bar and ribbon for the native
   presentation editor. Wraps the @helix/editors-ui primitives. All commands
   accept a context bag (`SlidesChromeContext`) so the editor wires them to
   the existing slides ops while keeping the chrome layout self-contained. */

import type { ReactNode } from "react";
import {
  EditorRibbon,
  RibbonButton,
  RibbonColorPicker,
  RibbonDivider,
  RibbonGroup,
  RibbonSelect,
  RibbonToggle,
  type MenuBarMenu,
} from "@helix/editors-ui";
import {
  AlignStartHorizontal as AlignLeft,
  TextAlignCenter as AlignCenter,
  AlignEndHorizontal as AlignRight,
  TextAlignJustify as AlignJustify,
  Bold,
  ChevronDown,
  ChevronUp,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Minus,
  PaintBucket,
  Play,
  Redo2,
  Shapes,
  Square,
  Strikethrough,
  TextCursorInput,
  Underline,
  Undo2,
  Video,
} from "lucide-react";
import {
  SLIDE_LAYOUT_OPTIONS,
  type SlideLayout,
  type SlideShape,
  type SlideShapeTextAlign,
  type SlideTheme,
  type SlideTransition,
} from "./seed";

export type SlidesTransitionValue = "none" | "fade" | "slide" | "zoom";

export interface SlidesChromeContext {
  readonly deckTitle: string;
  readonly deckTheme: SlideTheme;
  readonly slideCount: number;
  readonly activeSlideId: string | null;
  readonly activeSlideLayout: SlideLayout | null;
  readonly activeSlideTransition: SlideTransition | undefined;
  readonly activeShape: SlideShape | null;
  readonly canPasteShape: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly textAlign: SlideShapeTextAlign;
  readonly textColor: string;
  readonly highlightColor: string;
  readonly showGrid: boolean;
  readonly showRulers: boolean;
  readonly snapToGuides: boolean;
  readonly zoomPercent: number;

  // High-level actions wired by the editor.
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onCutShape: () => void;
  readonly onCopyShape: () => void;
  readonly onPasteShape: () => void;
  readonly onAddSlide: () => void;
  readonly onDuplicateSlide: () => void;
  readonly onDeleteSlide: () => void;
  readonly onNewDeck: () => void;
  readonly onOpenDeck: () => void;
  readonly onMakeDeckCopy: () => void;
  readonly onMoveDeckToTrash: () => void;
  readonly onPresentDeck: () => void;
  readonly onExportPptx: () => void;
  readonly onExportPdf: () => void;
  readonly onExportSvgSeries: () => void;
  readonly onChangeTheme: (next: SlideTheme) => void;
  readonly onChangeLayout: (next: SlideLayout) => void;
  readonly onChangeTransition: (next: SlidesTransitionValue) => void;
  readonly onChangeShapeFontFamily: (next: string) => void;
  readonly onChangeShapeFontSize: (next: string) => void;
  readonly onChangeShapeBold: (next: boolean) => void;
  readonly onChangeShapeItalic: (next: boolean) => void;
  readonly onChangeShapeUnderline: (next: boolean) => void;
  readonly onChangeShapeStrikethrough: (next: boolean) => void;
  readonly onChangeShapeTextAlign: (next: SlideShapeTextAlign) => void;
  readonly onChangeShapeTextColor: (next: string) => void;
  readonly onChangeShapeHighlightColor: (next: string) => void;
  readonly onToggleGrid: () => void;
  readonly onToggleRulers: () => void;
  readonly onToggleSnapToGuides: () => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onZoomFit: () => void;

  // Insert / shape ops supported by the native slide model.
  readonly onInsertTextBox: () => void;
  readonly onInsertShape: (kind: "rectangle" | "connector") => void;
  readonly onInsertImage: () => void;
  readonly onInsertMedia: () => void;

  // Arrange ops.
  readonly onShapeBringForward: () => void;
  readonly onShapeSendBackward: () => void;
  readonly onShapeBringToFront: () => void;
  readonly onShapeSendToBack: () => void;

  // Misc.
  readonly onOpenComments: () => void;
  readonly onOpenVersionHistory: () => void;
  readonly onShareDeck: () => void;
  readonly onCopyDeckLink: () => void;
  readonly onOpenHelp: () => void;
  readonly onOpenAi: () => void;
  readonly onOpenTransitions: () => void;
  readonly onOpenAnimations: () => void;
  readonly onSuggestLayout: () => void;
  readonly onRewriteBullets: () => void;
  readonly onDraftSpeakerNotes: () => void;
}

/** Build the File / Edit / View / Insert / Format / Tools / Help / AI / Share menus. */
export function buildSlidesMenus(ctx: SlidesChromeContext): MenuBarMenu[] {
  const hasShape = ctx.activeShape !== null;
  const hasSlide = ctx.activeSlideId !== null;

  return [
    {
      id: "file",
      label: "File",
      items: [
        {
          id: "file:new-deck",
          label: "New presentation",
          onSelect: ctx.onNewDeck,
        },
        {
          id: "file:open",
          label: "Open...",
          onSelect: ctx.onOpenDeck,
        },
        {
          id: "file:make-copy",
          label: "Make a copy",
          onSelect: ctx.onMakeDeckCopy,
        },
        {
          id: "file:move-trash",
          label: "Move to trash",
          destructive: true,
          onSelect: ctx.onMoveDeckToTrash,
        },
        { kind: "separator" },
        {
          id: "file:new-slide",
          label: "New slide",
          keybinding: "Ctrl+M",
          onSelect: ctx.onAddSlide,
        },
        {
          id: "file:duplicate-slide",
          label: "Duplicate slide",
          disabled: !hasSlide,
          onSelect: ctx.onDuplicateSlide,
        },
        { kind: "separator" },
        {
          id: "file:share",
          label: "Share",
          onSelect: ctx.onShareDeck,
        },
        { kind: "separator" },
        {
          kind: "submenu",
          id: "file:export",
          label: "Download",
          items: [
            {
              id: "file:export:pptx",
              label: "PowerPoint (.pptx)",
              onSelect: ctx.onExportPptx,
            },
            {
              id: "file:export:pdf",
              label: "PDF document (.pdf)",
              onSelect: ctx.onExportPdf,
            },
            {
              id: "file:export:svg",
              label: "SVG series (.zip)",
              onSelect: ctx.onExportSvgSeries,
            },
          ],
        },
        { kind: "separator" },
        {
          id: "file:version-history",
          label: "Version history",
          onSelect: ctx.onOpenVersionHistory,
        },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        {
          id: "edit:undo",
          label: "Undo",
          keybinding: "Ctrl+Z",
          disabled: !ctx.canUndo,
          onSelect: ctx.onUndo,
        },
        {
          id: "edit:redo",
          label: "Redo",
          keybinding: "Ctrl+Y",
          disabled: !ctx.canRedo,
          onSelect: ctx.onRedo,
        },
        { kind: "separator" },
        {
          id: "edit:cut",
          label: "Cut",
          keybinding: "Ctrl+X",
          disabled: !hasShape,
          onSelect: ctx.onCutShape,
        },
        {
          id: "edit:copy",
          label: "Copy",
          keybinding: "Ctrl+C",
          disabled: !hasShape,
          onSelect: ctx.onCopyShape,
        },
        {
          id: "edit:paste",
          label: "Paste",
          keybinding: "Ctrl+V",
          disabled: !ctx.canPasteShape,
          onSelect: ctx.onPasteShape,
        },
        {
          id: "edit:delete-slide",
          label: "Delete slide",
          disabled: !hasSlide,
          destructive: true,
          onSelect: ctx.onDeleteSlide,
        },
      ],
    },
    {
      id: "view",
      label: "View",
      items: [
        {
          id: "view:present",
          label: "Present",
          keybinding: "Ctrl+F5",
          disabled: ctx.slideCount === 0,
          onSelect: ctx.onPresentDeck,
        },
        { kind: "separator" },
        {
          id: "view:grid",
          label: ctx.showGrid ? "Hide grid" : "Show grid",
          onSelect: ctx.onToggleGrid,
        },
        {
          id: "view:rulers",
          label: ctx.showRulers ? "Hide rulers" : "Show rulers",
          onSelect: ctx.onToggleRulers,
        },
        {
          id: "view:guides",
          label: ctx.snapToGuides ? "Disable snap to guides" : "Snap to guides",
          onSelect: ctx.onToggleSnapToGuides,
        },
        { kind: "separator" },
        {
          id: "view:zoom-in",
          label: "Zoom in",
          keybinding: "Ctrl+=",
          disabled: ctx.zoomPercent >= 150,
          onSelect: ctx.onZoomIn,
        },
        {
          id: "view:zoom-out",
          label: "Zoom out",
          keybinding: "Ctrl+-",
          disabled: ctx.zoomPercent <= 50,
          onSelect: ctx.onZoomOut,
        },
        {
          id: "view:zoom-fit",
          label: "Fit to window",
          disabled: ctx.zoomPercent === 100,
          onSelect: ctx.onZoomFit,
        },
      ],
    },
    {
      id: "insert",
      label: "Insert",
      items: [
        {
          id: "insert:textbox",
          label: "Text box",
          disabled: !hasSlide,
          onSelect: ctx.onInsertTextBox,
        },
        {
          kind: "submenu",
          id: "insert:shape",
          label: "Shape",
          items: [
            {
              id: "insert:shape:rect",
              label: "Rectangle",
              disabled: !hasSlide,
              onSelect: () => ctx.onInsertShape("rectangle"),
            },
            {
              id: "insert:shape:connector",
              label: "Connector",
              disabled: !hasSlide,
              onSelect: () => ctx.onInsertShape("connector"),
            },
          ],
        },
        {
          id: "insert:image",
          label: "Image",
          disabled: !hasSlide,
          onSelect: ctx.onInsertImage,
        },
        {
          id: "insert:media",
          label: "Audio or video",
          disabled: !hasSlide,
          onSelect: ctx.onInsertMedia,
        },
        { kind: "separator" },
        {
          id: "insert:slide",
          label: "New slide",
          keybinding: "Ctrl+M",
          onSelect: ctx.onAddSlide,
        },
        {
          id: "insert:comment",
          label: "Comment",
          keybinding: "Ctrl+Alt+M",
          onSelect: ctx.onOpenComments,
        },
      ],
    },
    {
      id: "format",
      label: "Format",
      items: [
        {
          kind: "submenu",
          id: "format:text",
          label: "Text",
          items: [
            {
              id: "format:text:bold",
              label: "Bold",
              keybinding: "Ctrl+B",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeBold(!ctx.bold),
            },
            {
              id: "format:text:italic",
              label: "Italic",
              keybinding: "Ctrl+I",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeItalic(!ctx.italic),
            },
            {
              id: "format:text:underline",
              label: "Underline",
              keybinding: "Ctrl+U",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeUnderline(!ctx.underline),
            },
            {
              id: "format:text:strike",
              label: "Strikethrough",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeStrikethrough(!ctx.strikethrough),
            },
          ],
        },
        {
          kind: "submenu",
          id: "format:align",
          label: "Align & indent",
          items: [
            {
              id: "format:align:left",
              label: "Left",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeTextAlign("left"),
            },
            {
              id: "format:align:center",
              label: "Center",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeTextAlign("center"),
            },
            {
              id: "format:align:right",
              label: "Right",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeTextAlign("right"),
            },
            {
              id: "format:align:justify",
              label: "Justify",
              disabled: !hasShape,
              onSelect: () => ctx.onChangeShapeTextAlign("justify"),
            },
          ],
        },
        { kind: "separator" },
        {
          kind: "submenu",
          id: "format:arrange",
          label: "Order",
          items: [
            {
              id: "format:arrange:front",
              label: "Bring to front",
              disabled: !hasShape,
              onSelect: ctx.onShapeBringToFront,
            },
            {
              id: "format:arrange:forward",
              label: "Bring forward",
              disabled: !hasShape,
              onSelect: ctx.onShapeBringForward,
            },
            {
              id: "format:arrange:backward",
              label: "Send backward",
              disabled: !hasShape,
              onSelect: ctx.onShapeSendBackward,
            },
            {
              id: "format:arrange:back",
              label: "Send to back",
              disabled: !hasShape,
              onSelect: ctx.onShapeSendToBack,
            },
          ],
        },
      ],
    },
    {
      id: "tools",
      label: "Tools",
      items: [
        {
          id: "tools:comments",
          label: "Comments",
          onSelect: ctx.onOpenComments,
        },
        { kind: "separator" },
        {
          id: "tools:transitions",
          label: "Transitions",
          disabled: !hasSlide,
          onSelect: ctx.onOpenTransitions,
        },
        {
          id: "tools:animations",
          label: "Animations",
          disabled: !hasSlide,
          onSelect: ctx.onOpenAnimations,
        },
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [
        { id: "help:slides", label: "Slides help", onSelect: ctx.onOpenHelp },
        { id: "help:keyboard", label: "Keyboard shortcuts", onSelect: ctx.onOpenHelp },
      ],
    },
    {
      id: "ai",
      label: "AI",
      items: [
        {
          id: "ai:assistant",
          label: "Open AI assistant",
          onSelect: ctx.onOpenAi,
        },
        {
          id: "ai:suggest-layout",
          label: "Suggest layout",
          disabled: !hasSlide,
          onSelect: ctx.onSuggestLayout,
        },
        {
          id: "ai:rewrite",
          label: "Rewrite bullets",
          disabled: !hasSlide,
          onSelect: ctx.onRewriteBullets,
        },
        {
          id: "ai:draft-notes",
          label: "Draft speaker notes",
          disabled: !hasSlide,
          onSelect: ctx.onDraftSpeakerNotes,
        },
      ],
    },
    {
      id: "share",
      label: "Share",
      items: [
        { id: "share:invite", label: "Share with people", onSelect: ctx.onShareDeck },
        { id: "share:link", label: "Copy link", onSelect: ctx.onCopyDeckLink },
      ],
    },
  ];
}

const FONT_FAMILY_OPTIONS = [
  { value: "inter", label: "Inter" },
  { value: "serif", label: "Source Serif" },
  { value: "mono", label: "JetBrains Mono" },
  { value: "system", label: "System UI" },
] as const;

const FONT_SIZE_OPTIONS = [
  { value: "10", label: "10" },
  { value: "12", label: "12" },
  { value: "14", label: "14" },
  { value: "16", label: "16" },
  { value: "18", label: "18" },
  { value: "24", label: "24" },
  { value: "32", label: "32" },
  { value: "48", label: "48" },
] as const;

const TRANSITION_OPTIONS = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "slide", label: "Slide" },
  { value: "zoom", label: "Zoom" },
] as const;

const COLOR_PRESETS = [
  { value: "#111827", label: "Slate" },
  { value: "#1f2937", label: "Charcoal" },
  { value: "#6b7280", label: "Gray" },
  { value: "#ef4444", label: "Red" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#10b981", label: "Emerald" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#8b5cf6", label: "Violet" },
  { value: "#ec4899", label: "Pink" },
  { value: "#ffffff", label: "White" },
  { value: "#fef3c7", label: "Yellow highlight" },
  { value: "#dbeafe", label: "Blue highlight" },
] as const;

/** Build the formatting ribbon as a React subtree of RibbonGroups. */
export function buildSlidesRibbon(ctx: SlidesChromeContext): ReactNode {
  const hasShape = ctx.activeShape !== null;
  const hasSlide = ctx.activeSlideId !== null;
  const transitionValue: SlidesTransitionValue = ctx.activeSlideTransition?.type ?? "none";

  return (
    <>
      <RibbonGroup label="Undo">
        <RibbonButton
          icon={<Undo2 className="size-4" aria-hidden="true" />}
          label="Undo"
          keybinding="Ctrl+Z"
          disabled={!ctx.canUndo}
          onClick={ctx.onUndo}
        />
        <RibbonButton
          icon={<Redo2 className="size-4" aria-hidden="true" />}
          label="Redo"
          keybinding="Ctrl+Y"
          disabled={!ctx.canRedo}
          onClick={ctx.onRedo}
        />
      </RibbonGroup>
      <RibbonDivider />
      <RibbonGroup label="Font">
        <RibbonSelect<string>
          ariaLabel="Font family"
          value={ctx.fontFamily}
          onChange={ctx.onChangeShapeFontFamily}
          options={FONT_FAMILY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          width={130}
          disabled={!hasShape}
        />
        <RibbonSelect<string>
          ariaLabel="Font size"
          value={ctx.fontSize}
          onChange={ctx.onChangeShapeFontSize}
          options={FONT_SIZE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          width={72}
          disabled={!hasShape}
        />
      </RibbonGroup>
      <RibbonDivider />
      <RibbonGroup label="Text">
        <RibbonToggle
          icon={<Bold className="size-4" aria-hidden="true" />}
          label="Bold"
          keybinding="Ctrl+B"
          pressed={ctx.bold}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeBold(!ctx.bold)}
        />
        <RibbonToggle
          icon={<Italic className="size-4" aria-hidden="true" />}
          label="Italic"
          keybinding="Ctrl+I"
          pressed={ctx.italic}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeItalic(!ctx.italic)}
        />
        <RibbonToggle
          icon={<Underline className="size-4" aria-hidden="true" />}
          label="Underline"
          keybinding="Ctrl+U"
          pressed={ctx.underline}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeUnderline(!ctx.underline)}
        />
        <RibbonToggle
          icon={<Strikethrough className="size-4" aria-hidden="true" />}
          label="Strikethrough"
          pressed={ctx.strikethrough}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeStrikethrough(!ctx.strikethrough)}
        />
        <RibbonColorPicker
          icon={<PaintBucket className="size-4" aria-hidden="true" />}
          ariaLabel="Text color"
          value={ctx.textColor}
          onChange={ctx.onChangeShapeTextColor}
          presets={COLOR_PRESETS}
        />
        <RibbonColorPicker
          icon={<Highlighter className="size-4" aria-hidden="true" />}
          ariaLabel="Highlight color"
          value={ctx.highlightColor}
          onChange={ctx.onChangeShapeHighlightColor}
          presets={COLOR_PRESETS}
        />
      </RibbonGroup>
      <RibbonDivider />
      <RibbonGroup label="Align">
        <RibbonToggle
          icon={<AlignLeft className="size-4" aria-hidden="true" />}
          label="Align left"
          pressed={ctx.textAlign === "left"}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeTextAlign("left")}
        />
        <RibbonToggle
          icon={<AlignCenter className="size-4" aria-hidden="true" />}
          label="Align center"
          pressed={ctx.textAlign === "center"}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeTextAlign("center")}
        />
        <RibbonToggle
          icon={<AlignRight className="size-4" aria-hidden="true" />}
          label="Align right"
          pressed={ctx.textAlign === "right"}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeTextAlign("right")}
        />
        <RibbonToggle
          icon={<AlignJustify className="size-4" aria-hidden="true" />}
          label="Justify"
          pressed={ctx.textAlign === "justify"}
          disabled={!hasShape}
          onClick={() => ctx.onChangeShapeTextAlign("justify")}
        />
      </RibbonGroup>
      <RibbonDivider />
      <RibbonGroup label="Insert">
        <RibbonButton
          icon={<TextCursorInput className="size-4" aria-hidden="true" />}
          label="Insert text box"
          disabled={!hasSlide}
          onClick={ctx.onInsertTextBox}
        />
        <RibbonButton
          icon={<Shapes className="size-4" aria-hidden="true" />}
          label="Insert shape"
          disabled={!hasSlide}
          onClick={() => ctx.onInsertShape("rectangle")}
        />
        <RibbonButton
          icon={<ImageIcon className="size-4" aria-hidden="true" />}
          label="Insert image"
          disabled={!hasSlide}
          onClick={ctx.onInsertImage}
        />
        <RibbonButton
          icon={<Video className="size-4" aria-hidden="true" />}
          label="Insert media"
          disabled={!hasSlide}
          onClick={ctx.onInsertMedia}
        />
      </RibbonGroup>
      <RibbonDivider />
      <RibbonGroup label="Arrange">
        <RibbonButton
          icon={<ChevronUp className="size-4" aria-hidden="true" />}
          label="Bring forward"
          disabled={!hasShape}
          onClick={ctx.onShapeBringForward}
        />
        <RibbonButton
          icon={<ChevronDown className="size-4" aria-hidden="true" />}
          label="Send backward"
          disabled={!hasShape}
          onClick={ctx.onShapeSendBackward}
        />
        <RibbonButton
          icon={<Square className="size-4" aria-hidden="true" />}
          label="Bring to front"
          disabled={!hasShape}
          onClick={ctx.onShapeBringToFront}
        />
        <RibbonButton
          icon={<Minus className="size-4" aria-hidden="true" />}
          label="Send to back"
          disabled={!hasShape}
          onClick={ctx.onShapeSendToBack}
        />
      </RibbonGroup>
      <RibbonDivider />
      <RibbonGroup label="Slide">
        <RibbonSelect<SlideLayout>
          ariaLabel="Slide layout"
          value={ctx.activeSlideLayout ?? "title"}
          onChange={ctx.onChangeLayout}
          options={SLIDE_LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          width={140}
          disabled={!hasSlide}
        />
        <RibbonSelect<SlidesTransitionValue>
          ariaLabel="Slide transition"
          value={transitionValue}
          onChange={ctx.onChangeTransition}
          options={TRANSITION_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
          }))}
          width={120}
          disabled={!hasSlide}
        />
        <RibbonButton
          icon={<Play className="size-4" aria-hidden="true" />}
          label="Present"
          keybinding="Ctrl+F5"
          disabled={ctx.slideCount === 0}
          onClick={ctx.onPresentDeck}
        />
      </RibbonGroup>
    </>
  );
}

/** Convenience wrapper that builds the `<EditorRibbon>` with the full set of groups. */
export function SlidesRibbon({ ctx }: { readonly ctx: SlidesChromeContext }): ReactNode {
  return (
    <EditorRibbon ariaLabel="Slides formatting toolbar">{buildSlidesRibbon(ctx)}</EditorRibbon>
  );
}
