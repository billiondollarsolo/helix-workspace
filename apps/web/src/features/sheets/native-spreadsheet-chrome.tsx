/* Sheets chrome — shared editor chrome (menus + ribbon + side panel tabs) built
   on top of `@helix/editors-ui` primitives. The host editor
   (`native-spreadsheet-editor.tsx`) owns all the state and mutations; this
   module just wires those callbacks into the unified chrome surfaces. */

import type { ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  Bold,
  ChartArea,
  Filter as FilterIcon,
  Grid2x2,
  History,
  Image as ImageIcon,
  Italic,
  Lock,
  MessageSquare,
  Minus,
  PaintBucket,
  Plus,
  Redo,
  Sigma,
  Sparkles,
  Square,
  Strikethrough,
  Table2,
  Tag,
  Type,
  Underline,
  Undo,
  WrapText,
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
  type SidePanelTab,
} from "@helix/editors-ui";

/* ── Public context shape ───────────────────────────────────────────────── */

export type SheetsNumberFormat = "plain" | "number" | "currency" | "percent" | "date" | "custom";
export type SheetsHorizontalAlign = "left" | "center" | "right";
export type SheetsVerticalAlign = "top" | "middle" | "bottom";
export type SheetsSortDirection = "asc" | "desc";
export type SheetsBorderPreset =
  | "all"
  | "outer"
  | "inner"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "none";

export interface SheetsChromeContext {
  /* Cell selection / format state. */
  readonly hasSelection: boolean;
  readonly selectionLocked: boolean;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly textColor: string;
  readonly fillColor: string;
  readonly numberFormat: SheetsNumberFormat;
  readonly horizontalAlign: SheetsHorizontalAlign;
  readonly verticalAlign: SheetsVerticalAlign;
  readonly wrapText: boolean;
  readonly mergeCellsEnabled: boolean;

  /* Format setters. */
  readonly setFontFamily: (next: string) => void;
  readonly setFontSize: (next: string) => void;
  readonly setBold: (next: boolean) => void;
  readonly setItalic: (next: boolean) => void;
  readonly setUnderline: (next: boolean) => void;
  readonly setStrikethrough: (next: boolean) => void;
  readonly setTextColor: (color: string) => void;
  readonly setFillColor: (color: string) => void;
  readonly setNumberFormat: (next: SheetsNumberFormat) => void;
  readonly increaseDecimals: () => void;
  readonly decreaseDecimals: () => void;
  readonly setPercent: () => void;
  readonly setCurrency: () => void;
  readonly setHorizontalAlign: (next: SheetsHorizontalAlign) => void;
  readonly setVerticalAlign: (next: SheetsVerticalAlign) => void;
  readonly setWrapText: (next: boolean) => void;
  readonly applyBorderPreset: (preset: SheetsBorderPreset) => void;
  readonly mergeSelectedCells: () => void;

  /* History. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undo: () => void;
  readonly redo: () => void;

  /* Cell clipboard. */
  readonly canCutCopyCells: boolean;
  readonly canPasteCells: boolean;
  readonly cutCells: () => void;
  readonly copyCells: () => void;
  readonly pasteCells: () => void;

  /* Data ops. */
  readonly sortRangeAsc: () => void;
  readonly sortRangeDesc: () => void;
  readonly toggleFilter: () => void;
  readonly filterActive: boolean;

  /* Insert ops. */
  readonly insertChart: () => void;
  readonly insertPivotTable: () => void;
  readonly insertImage: () => void;
  readonly insertFunction: (kind: string) => void;
  readonly availableFunctions: ReadonlyArray<{ readonly value: string; readonly label: string }>;

  /* Row/column ops. */
  readonly insertRowAbove: () => void;
  readonly insertRowBelow: () => void;
  readonly insertColumnLeft: () => void;
  readonly insertColumnRight: () => void;
  readonly deleteRow: () => void;
  readonly deleteColumn: () => void;
  readonly rowColOpsEnabled: boolean;

  /* File / share / AI menu callbacks. */
  readonly onShare: () => void;
  readonly onNewSpreadsheet: () => void;
  readonly onOpenSpreadsheet: () => void;
  readonly onMakeCopy: () => void;
  readonly onMoveToTrash: () => void;
  readonly onExportCsv: () => void;
  readonly onExportTsv: () => void;
  readonly onExportXlsx: () => void;
  readonly onExportOds: () => void;
  readonly onAnalyzeRange: () => void;
  readonly onCopyLink: () => void;
  readonly onOpenKeyboardShortcuts: () => void;

  /* Side panel: open a specific tab. */
  readonly openSidePanelTab: (tabId: SheetsSidePanelTabId) => void;
}

/* ── Menus ──────────────────────────────────────────────────────────────── */

export const SHEETS_MENU_IDS = [
  "file",
  "edit",
  "view",
  "insert",
  "format",
  "data",
  "tools",
  "help",
  "ai",
  "share",
] as const;
export type SheetsMenuId = (typeof SHEETS_MENU_IDS)[number];

export function buildSheetsMenus(ctx: SheetsChromeContext): MenuBarMenu[] {
  const fileItems: MenuItem[] = [
    { id: "file-new", label: "New spreadsheet", onSelect: ctx.onNewSpreadsheet },
    { id: "file-open", label: "Open...", onSelect: ctx.onOpenSpreadsheet },
    { id: "file-make-copy", label: "Make a copy", onSelect: ctx.onMakeCopy },
    {
      id: "file-move-trash",
      label: "Move to trash",
      destructive: true,
      onSelect: ctx.onMoveToTrash,
    },
    { kind: "separator" },
    {
      kind: "submenu",
      id: "file-export",
      label: "Download",
      items: [
        { id: "file-export-xlsx", label: "Microsoft Excel (.xlsx)", onSelect: ctx.onExportXlsx },
        { id: "file-export-ods", label: "OpenDocument (.ods)", onSelect: ctx.onExportOds },
        {
          id: "file-export-csv",
          label: "Comma separated values (.csv)",
          onSelect: ctx.onExportCsv,
        },
        { id: "file-export-tsv", label: "Tab separated values (.tsv)", onSelect: ctx.onExportTsv },
      ],
    },
    { kind: "separator" },
    {
      id: "file-version-history",
      label: "Version history",
      onSelect: () => ctx.openSidePanelTab("versions"),
    },
    { kind: "separator" },
    { id: "file-share", label: "Share", onSelect: ctx.onShare },
  ];

  const editItems: MenuItem[] = [
    {
      id: "edit-undo",
      label: "Undo",
      keybinding: "Mod+Z",
      disabled: !ctx.canUndo,
      onSelect: ctx.undo,
    },
    {
      id: "edit-redo",
      label: "Redo",
      keybinding: "Mod+Shift+Z",
      disabled: !ctx.canRedo,
      onSelect: ctx.redo,
    },
    { kind: "separator" },
    {
      id: "edit-cut",
      label: "Cut",
      keybinding: "Mod+X",
      disabled: !ctx.canCutCopyCells,
      onSelect: ctx.cutCells,
    },
    {
      id: "edit-copy",
      label: "Copy",
      keybinding: "Mod+C",
      disabled: !ctx.canCutCopyCells,
      onSelect: ctx.copyCells,
    },
    {
      id: "edit-paste",
      label: "Paste",
      keybinding: "Mod+V",
      disabled: !ctx.canPasteCells,
      onSelect: ctx.pasteCells,
    },
  ];

  const viewItems: MenuItem[] = [
    {
      id: "view-comments",
      label: "Show comments",
      onSelect: () => ctx.openSidePanelTab("comments"),
    },
    {
      id: "view-filters",
      label: "Show filter views",
      onSelect: () => ctx.openSidePanelTab("filters"),
    },
    {
      id: "view-names",
      label: "Show named ranges",
      onSelect: () => ctx.openSidePanelTab("names"),
    },
  ];

  const insertItems: MenuItem[] = [
    { id: "insert-chart", label: "Chart", onSelect: ctx.insertChart },
    { id: "insert-pivot", label: "Pivot table", onSelect: ctx.insertPivotTable },
    { id: "insert-image", label: "Image", onSelect: ctx.insertImage },
    { kind: "separator" },
    {
      id: "insert-row-above",
      label: "Row above",
      disabled: !ctx.rowColOpsEnabled,
      onSelect: ctx.insertRowAbove,
    },
    {
      id: "insert-row-below",
      label: "Row below",
      disabled: !ctx.rowColOpsEnabled,
      onSelect: ctx.insertRowBelow,
    },
    {
      id: "insert-col-left",
      label: "Column left",
      disabled: !ctx.rowColOpsEnabled,
      onSelect: ctx.insertColumnLeft,
    },
    {
      id: "insert-col-right",
      label: "Column right",
      disabled: !ctx.rowColOpsEnabled,
      onSelect: ctx.insertColumnRight,
    },
  ];

  const formatItems: MenuItem[] = [
    {
      kind: "checkbox",
      id: "format-bold",
      label: "Bold",
      keybinding: "Mod+B",
      checked: ctx.bold,
      onCheckedChange: (next: boolean) => ctx.setBold(next),
    },
    {
      kind: "checkbox",
      id: "format-italic",
      label: "Italic",
      keybinding: "Mod+I",
      checked: ctx.italic,
      onCheckedChange: (next: boolean) => ctx.setItalic(next),
    },
    { kind: "separator" },
    {
      id: "format-number",
      label: "Number format",
      onSelect: () => ctx.setNumberFormat("number"),
    },
    {
      id: "format-currency",
      label: "Currency",
      onSelect: ctx.setCurrency,
    },
    {
      id: "format-percent",
      label: "Percent",
      onSelect: ctx.setPercent,
    },
  ];

  const dataItems: MenuItem[] = [
    {
      id: "data-sort-asc",
      label: "Sort range A → Z",
      onSelect: ctx.sortRangeAsc,
    },
    {
      id: "data-sort-desc",
      label: "Sort range Z → A",
      onSelect: ctx.sortRangeDesc,
    },
    { kind: "separator" },
    {
      kind: "checkbox",
      id: "data-filter",
      label: "Create a filter",
      checked: ctx.filterActive,
      onCheckedChange: () => ctx.toggleFilter(),
    },
    {
      id: "data-named-ranges",
      label: "Named ranges",
      onSelect: () => ctx.openSidePanelTab("names"),
    },
    {
      id: "data-protected-ranges",
      label: "Protect sheets and ranges",
      onSelect: () => ctx.openSidePanelTab("permissions"),
    },
  ];

  const toolsItems: MenuItem[] = [
    {
      id: "tools-comments",
      label: "Comments",
      onSelect: () => ctx.openSidePanelTab("comments"),
    },
    {
      id: "tools-validation",
      label: "Data validation",
      onSelect: () => ctx.openSidePanelTab("cells"),
    },
    {
      id: "tools-conditional",
      label: "Conditional formatting",
      onSelect: () => ctx.openSidePanelTab("cells"),
    },
  ];

  const helpItems: MenuItem[] = [
    {
      id: "help-shortcuts",
      label: "Keyboard shortcuts",
      keybinding: "Mod+/",
      onSelect: ctx.onOpenKeyboardShortcuts,
    },
  ];

  const aiItems: MenuItem[] = [
    {
      id: "ai-analyze",
      label: "Analyze selected range",
      onSelect: ctx.onAnalyzeRange,
    },
    {
      id: "ai-open",
      label: "Open AI panel",
      onSelect: () => ctx.openSidePanelTab("ai"),
    },
  ];

  const shareItems: MenuItem[] = [
    { id: "share-open", label: "Share with people", onSelect: ctx.onShare },
    { id: "share-copy-link", label: "Copy link", onSelect: ctx.onCopyLink },
    { kind: "separator" },
    { id: "share-export-xlsx", label: "Download as XLSX", onSelect: ctx.onExportXlsx },
    { id: "share-export-csv", label: "Download as CSV", onSelect: ctx.onExportCsv },
  ];

  return [
    { id: "file", label: "File", items: fileItems },
    { id: "edit", label: "Edit", items: editItems },
    { id: "view", label: "View", items: viewItems },
    { id: "insert", label: "Insert", items: insertItems },
    { id: "format", label: "Format", items: formatItems },
    { id: "data", label: "Data", items: dataItems },
    { id: "tools", label: "Tools", items: toolsItems },
    { id: "help", label: "Help", items: helpItems },
    { id: "ai", label: "AI", items: aiItems },
    { id: "share", label: "Share", items: shareItems },
  ];
}

/* ── Ribbon ─────────────────────────────────────────────────────────────── */

const FONT_FAMILY_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
] as const;

const FONT_SIZE_OPTIONS = [
  { value: "10", label: "10" },
  { value: "11", label: "11" },
  { value: "12", label: "12" },
  { value: "14", label: "14" },
  { value: "18", label: "18" },
] as const;

const NUMBER_FORMAT_OPTIONS: ReadonlyArray<{ value: SheetsNumberFormat; label: string }> = [
  { value: "plain", label: "Plain" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
  { value: "date", label: "Date" },
  { value: "custom", label: "Custom" },
];

const VALIGN_OPTIONS: ReadonlyArray<{ value: SheetsVerticalAlign; label: string }> = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
];

const TEXT_COLOR_PRESETS = [
  { value: "#1f2937", label: "Default" },
  { value: "#b91c1c", label: "Red" },
  { value: "#047857", label: "Green" },
  { value: "#1d4ed8", label: "Blue" },
  { value: "#a16207", label: "Amber" },
  { value: "#7c3aed", label: "Violet" },
];

const FILL_COLOR_PRESETS = [
  { value: "#ffffff", label: "None" },
  { value: "#fef3c7", label: "Yellow" },
  { value: "#dcfce7", label: "Green" },
  { value: "#dbeafe", label: "Blue" },
  { value: "#fee2e2", label: "Red" },
  { value: "#ede9fe", label: "Violet" },
];

const BORDER_OPTIONS: ReadonlyArray<{ value: SheetsBorderPreset; label: string }> = [
  { value: "all", label: "All borders" },
  { value: "outer", label: "Outer border" },
  { value: "inner", label: "Inner borders" },
  { value: "top", label: "Top border" },
  { value: "bottom", label: "Bottom border" },
  { value: "left", label: "Left border" },
  { value: "right", label: "Right border" },
  { value: "none", label: "Clear borders" },
];

export function buildSheetsRibbon(ctx: SheetsChromeContext): ReactNode {
  const formatDisabled = !ctx.hasSelection || ctx.selectionLocked;

  return (
    <EditorRibbon aria-label="Sheets ribbon">
      <RibbonGroup label="History">
        <RibbonButton
          icon={<Undo size={16} />}
          label="Undo"
          keybinding="Mod+Z"
          disabled={!ctx.canUndo}
          onClick={ctx.undo}
        />
        <RibbonButton
          icon={<Redo size={16} />}
          label="Redo"
          keybinding="Mod+Shift+Z"
          disabled={!ctx.canRedo}
          onClick={ctx.redo}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Font">
        <RibbonSelect<string>
          value={ctx.fontFamily}
          onChange={ctx.setFontFamily}
          options={FONT_FAMILY_OPTIONS}
          ariaLabel="Font family"
          width={104}
          disabled={formatDisabled}
        />
        <RibbonSelect<string>
          value={ctx.fontSize}
          onChange={ctx.setFontSize}
          options={FONT_SIZE_OPTIONS}
          ariaLabel="Font size"
          width={72}
          disabled={formatDisabled}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Text">
        <RibbonToggle
          icon={<Bold size={16} />}
          label="Bold"
          keybinding="Mod+B"
          pressed={ctx.bold}
          disabled={formatDisabled}
          onClick={() => ctx.setBold(!ctx.bold)}
        />
        <RibbonToggle
          icon={<Italic size={16} />}
          label="Italic"
          keybinding="Mod+I"
          pressed={ctx.italic}
          disabled={formatDisabled}
          onClick={() => ctx.setItalic(!ctx.italic)}
        />
        <RibbonToggle
          icon={<Underline size={16} />}
          label="Underline"
          pressed={ctx.underline}
          disabled={formatDisabled}
          onClick={() => ctx.setUnderline(!ctx.underline)}
        />
        <RibbonToggle
          icon={<Strikethrough size={16} />}
          label="Strikethrough"
          pressed={ctx.strikethrough}
          disabled={formatDisabled}
          onClick={() => ctx.setStrikethrough(!ctx.strikethrough)}
        />
        <RibbonColorPicker
          icon={<Type size={16} />}
          ariaLabel="Text color"
          value={ctx.textColor || "#1f2937"}
          onChange={ctx.setTextColor}
          presets={TEXT_COLOR_PRESETS}
        />
        <RibbonColorPicker
          icon={<PaintBucket size={16} />}
          ariaLabel="Fill color"
          value={ctx.fillColor || "#ffffff"}
          onChange={ctx.setFillColor}
          presets={FILL_COLOR_PRESETS}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Number">
        <RibbonSelect<SheetsNumberFormat>
          value={ctx.numberFormat}
          onChange={ctx.setNumberFormat}
          options={NUMBER_FORMAT_OPTIONS}
          ariaLabel="Number format"
          width={120}
          disabled={formatDisabled}
        />
        <RibbonButton
          icon={<Minus size={16} />}
          label="Decrease decimals"
          disabled={formatDisabled}
          onClick={ctx.decreaseDecimals}
        />
        <RibbonButton
          icon={<Plus size={16} />}
          label="Increase decimals"
          disabled={formatDisabled}
          onClick={ctx.increaseDecimals}
        />
        <RibbonButton
          icon={<span className="text-sm font-semibold">%</span>}
          label="Format as percent"
          disabled={formatDisabled}
          onClick={ctx.setPercent}
        />
        <RibbonButton
          icon={<span className="text-sm font-semibold">$</span>}
          label="Format as currency"
          disabled={formatDisabled}
          onClick={ctx.setCurrency}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Align">
        <RibbonToggle
          icon={<AlignLeft size={16} />}
          label="Align left"
          pressed={ctx.horizontalAlign === "left"}
          disabled={formatDisabled}
          onClick={() => ctx.setHorizontalAlign("left")}
        />
        <RibbonToggle
          icon={<AlignCenter size={16} />}
          label="Align center"
          pressed={ctx.horizontalAlign === "center"}
          disabled={formatDisabled}
          onClick={() => ctx.setHorizontalAlign("center")}
        />
        <RibbonToggle
          icon={<AlignRight size={16} />}
          label="Align right"
          pressed={ctx.horizontalAlign === "right"}
          disabled={formatDisabled}
          onClick={() => ctx.setHorizontalAlign("right")}
        />
        <RibbonSelect<SheetsVerticalAlign>
          value={ctx.verticalAlign}
          onChange={ctx.setVerticalAlign}
          options={VALIGN_OPTIONS}
          ariaLabel="Vertical align"
          width={104}
          disabled={formatDisabled}
        />
        <RibbonToggle
          icon={<WrapText size={16} />}
          label="Wrap text"
          pressed={ctx.wrapText}
          disabled={formatDisabled}
          onClick={() => ctx.setWrapText(!ctx.wrapText)}
        />
        <RibbonButton
          icon={<Grid2x2 size={16} />}
          label="Merge cells"
          disabled={!ctx.mergeCellsEnabled}
          onClick={ctx.mergeSelectedCells}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Borders">
        <RibbonSelect<SheetsBorderPreset>
          value="all"
          onChange={ctx.applyBorderPreset}
          options={BORDER_OPTIONS}
          ariaLabel="Borders"
          width={140}
          disabled={formatDisabled}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Data">
        <RibbonButton
          icon={<ArrowUpAZ size={16} />}
          label="Sort range A to Z"
          onClick={ctx.sortRangeAsc}
          disabled={!ctx.hasSelection || ctx.selectionLocked}
        />
        <RibbonButton
          icon={<ArrowDownAZ size={16} />}
          label="Sort range Z to A"
          onClick={ctx.sortRangeDesc}
          disabled={!ctx.hasSelection || ctx.selectionLocked}
        />
        <RibbonToggle
          icon={<FilterIcon size={16} />}
          label="Toggle filter"
          pressed={ctx.filterActive}
          onClick={ctx.toggleFilter}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Insert">
        <RibbonButton
          icon={<BarChart3 size={16} />}
          label="Insert chart"
          onClick={ctx.insertChart}
        />
        <RibbonButton
          icon={<Table2 size={16} />}
          label="Insert pivot table"
          onClick={ctx.insertPivotTable}
        />
        <RibbonButton
          icon={<ImageIcon size={16} />}
          label="Insert image"
          onClick={ctx.insertImage}
        />
        <RibbonSelect<string>
          value=""
          onChange={ctx.insertFunction}
          options={[{ value: "", label: "Function" }, ...ctx.availableFunctions]}
          ariaLabel="Insert function"
          width={140}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Cell">
        <RibbonButton
          icon={<Plus size={16} />}
          label="Insert row above"
          disabled={!ctx.rowColOpsEnabled}
          onClick={ctx.insertRowAbove}
        />
        <RibbonButton
          icon={<Plus size={16} style={{ transform: "rotate(180deg)" }} />}
          label="Insert row below"
          disabled={!ctx.rowColOpsEnabled}
          onClick={ctx.insertRowBelow}
        />
        <RibbonButton
          icon={<Plus size={16} style={{ transform: "rotate(-90deg)" }} />}
          label="Insert column left"
          disabled={!ctx.rowColOpsEnabled}
          onClick={ctx.insertColumnLeft}
        />
        <RibbonButton
          icon={<Plus size={16} style={{ transform: "rotate(90deg)" }} />}
          label="Insert column right"
          disabled={!ctx.rowColOpsEnabled}
          onClick={ctx.insertColumnRight}
        />
        <RibbonButton
          icon={<Minus size={16} />}
          label="Delete row"
          disabled={!ctx.rowColOpsEnabled}
          onClick={ctx.deleteRow}
        />
        <RibbonButton
          icon={<Minus size={16} style={{ transform: "rotate(90deg)" }} />}
          label="Delete column"
          disabled={!ctx.rowColOpsEnabled}
          onClick={ctx.deleteColumn}
        />
      </RibbonGroup>
    </EditorRibbon>
  );
}

/* ── Side panel tabs ────────────────────────────────────────────────────── */

export const SHEETS_SIDE_PANEL_TAB_IDS = [
  "comments",
  "charts",
  "pivots",
  "ai",
  "cells",
  "filters",
  "names",
  "versions",
  "permissions",
] as const;
export type SheetsSidePanelTabId = (typeof SHEETS_SIDE_PANEL_TAB_IDS)[number];

export interface SheetsSidePanelTabContent {
  readonly comments: ReactNode;
  readonly charts: ReactNode;
  readonly pivots: ReactNode;
  readonly ai: ReactNode;
  readonly cells: ReactNode;
  readonly filters: ReactNode;
  readonly names: ReactNode;
  readonly versions: ReactNode;
  readonly permissions: ReactNode;
}

export function buildSheetsSidePanelTabs(
  content: SheetsSidePanelTabContent,
  options?: { readonly commentsBadge?: number },
): SidePanelTab[] {
  return [
    {
      id: "comments",
      label: "Comments",
      icon: <MessageSquare size={16} />,
      badge: options?.commentsBadge,
      content: content.comments,
    },
    { id: "charts", label: "Charts", icon: <BarChart3 size={16} />, content: content.charts },
    { id: "pivots", label: "Pivots", icon: <Table2 size={16} />, content: content.pivots },
    { id: "ai", label: "AI", icon: <Sparkles size={16} />, content: content.ai },
    { id: "cells", label: "Cells", icon: <Grid2x2 size={16} />, content: content.cells },
    { id: "filters", label: "Filters", icon: <FilterIcon size={16} />, content: content.filters },
    { id: "names", label: "Names", icon: <Tag size={16} />, content: content.names },
    { id: "versions", label: "Versions", icon: <History size={16} />, content: content.versions },
    {
      id: "permissions",
      label: "Permissions",
      icon: <Lock size={16} />,
      content: content.permissions,
    },
  ];
}

/* ── Re-exports for convenience ─────────────────────────────────────────── */

export { ChartArea as SheetsChartIcon, Sigma as SheetsFunctionIcon, Square as SheetsCellIcon };
