import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWebPlatformHost } from "@helix/sdk-web";
import {
  EditorAppBar,
  EditorSidePanel,
  EditorWorkspace,
  type EditorAppBarStatus,
} from "@helix/editors-ui";
import { Icons } from "@/components/icons";
import { trashDriveObject, uploadDriveFile } from "@/features/drive/api";
import { DriveShareDialog } from "@/features/drive/drive-share-dialog";
import { driveQueryKeys } from "@/features/drive/queries";
import {
  OfficeVersionHistoryPanel,
  type OfficeVersionRecord,
} from "@/features/_open/ui/OfficeVersionHistoryPanel";
import {
  buildSheetsMenus,
  buildSheetsRibbon,
  buildSheetsSidePanelTabs,
  type SheetsBorderPreset,
  type SheetsChromeContext,
  type SheetsSidePanelTabId,
  type SheetsVerticalAlign,
} from "./native-spreadsheet-chrome";
import {
  createSheetTab,
  copySheet,
  createSheet,
  deleteSheetTab,
  createSheetComment,
  deleteSheetComment,
  listSheetComments,
  reopenSheetComment,
  resolveSheetComment,
  restoreSheetVersion,
  exportSheet,
  sortSheetRange,
  updateSheetComment,
  updateSheetTab,
  updateSheet,
  updateSheetCells,
  type SheetsApiCell,
  type SheetsApiTab,
  type SheetsApiSheetWithTabs,
  type SheetsApiTabWithCells,
  type SheetsCellWindow,
  type SheetsCellEdit,
  type SheetsCommentStatus,
  type SheetsDriveComment,
} from "./api";
import {
  diffCellEdit,
  displayGridFromCells,
  gridFromCells,
  padGrid,
  type EditableGrid,
} from "./model";
import {
  NativeSpreadsheetSyncProvider,
  applySpreadsheetOperationToTab,
  rebaseSpreadsheetFormulaForStructuralChange,
  type NativeSpreadsheetOperationChange,
  type NativeSpreadsheetSyncStatus,
} from "./native-spreadsheet-sync-provider";
import {
  sheetQueryOptions,
  sheetTabQueryOptions,
  sheetVersionsQueryOptions,
  sheetsQueryKeys,
} from "./queries";
import { columnLetter } from "./seed";
import {
  analyzeSpreadsheetRange,
  type SpreadsheetFormulaAssist,
  type SpreadsheetRangeAssist,
} from "./spreadsheet-ai";

const VISIBLE_ROWS = 24;
const VISIBLE_COLS = 12;
const SHEET_WINDOW_ROW_MARGIN = 24;
const SHEET_WINDOW_COL_MARGIN = 12;
const SHEET_MAX_ROWS = 10_000;
const SHEET_MAX_COLS = 50;
const SHEET_ROW_HEADER_WIDTH = 48;
const SHEET_CELL_WIDTH = 96;
const SHEET_CELL_HEIGHT = 32;
const MS_PER_DAY = 86_400_000;
const SHEETS_CLIPBOARD_MIME = "application/x-helix-sheets-cells+json";
const SHEETS_GRID_RECOVERY_PREFIX = "helix.sheets.unsavedGrid.v1";
const SERIES_MONTH_NAMES = [
  { short: "jan", long: "january" },
  { short: "feb", long: "february" },
  { short: "mar", long: "march" },
  { short: "apr", long: "april" },
  { short: "may", long: "may" },
  { short: "jun", long: "june" },
  { short: "jul", long: "july" },
  { short: "aug", long: "august" },
  { short: "sep", long: "september" },
  { short: "oct", long: "october" },
  { short: "nov", long: "november" },
  { short: "dec", long: "december" },
] as const;
const FILL_COLORS = [
  { label: "Yellow", value: "#fef3c7" },
  { label: "Green", value: "#dcfce7" },
  { label: "Blue", value: "#dbeafe" },
] as const;
const TEXT_COLORS = [
  { label: "Default", value: "" },
  { label: "Red", value: "#b91c1c" },
  { label: "Green", value: "#047857" },
  { label: "Blue", value: "#1d4ed8" },
] as const;
const CUSTOM_NUMBER_FORMATS = [
  "#,##0",
  "#,##0.00",
  "0",
  "0.00",
  "$#,##0.00",
  "0%",
  "0.00%",
  "#,##0.00;[Red](#,##0.00);-;@",
  "$#,##0.00;[Red]($#,##0.00);$0.00;@",
  "0.00%;[Red](0.00%);0%;@",
  "m/d/yyyy",
  "mm/dd/yyyy",
  "mmm d, yyyy",
] as const;
const FORMULA_HELPERS: readonly { readonly value: FormulaHelperKind; readonly label: string }[] = [
  { value: "sum", label: "SUM selected range" },
  { value: "average", label: "AVERAGE selected range" },
  { value: "count", label: "COUNT numeric values" },
  { value: "counta", label: "COUNTA non-empty values" },
  { value: "min", label: "MIN selected range" },
  { value: "max", label: "MAX selected range" },
  { value: "sumif-equals", label: "SUMIF matching first value" },
  { value: "countif-equals", label: "COUNTIF matching first value" },
  { value: "averageif-equals", label: "AVERAGEIF matching first value" },
  { value: "query-sum", label: "QUERY sum selected range" },
  { value: "query-count", label: "QUERY count rows" },
  { value: "query-top", label: "QUERY top value" },
  { value: "helix-classify", label: "HELIX classify cell" },
];
const CHART_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"] as const;
const EMPTY_SHEET_CELLS: readonly SheetsApiCell[] = [];

interface CellAddress {
  readonly row: number;
  readonly col: number;
}

interface CellRange {
  readonly start: CellAddress;
  readonly end: CellAddress;
}

interface NormalizedCellRange {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

type CellFormat = Record<string, unknown>;
type HorizontalAlign = "left" | "center" | "right";
type NumberFormat = "plain" | "number" | "currency" | "percent" | "date" | "custom";
type BorderPreset = "all" | "outer" | "none";
type SortDirection = "asc" | "desc";
interface SheetCellHistoryEntry {
  readonly tabId: string;
  readonly undoEdits: readonly SheetsCellEdit[];
  readonly redoEdits: readonly SheetsCellEdit[];
}

interface SheetsInternalClipboard {
  readonly text: string;
  readonly formattedCells: string;
}

type DataValidationKind = "none" | "number" | "email" | "url" | "date" | "list" | "customFormula";
type DataValidationMode = "warn" | "reject";
type DataValidationDateLocale = "iso" | "en-US" | "en-GB" | "de-DE";
type ConditionalFormatKind =
  | "none"
  | "greaterThan100"
  | "lessThanZero"
  | "textContains"
  | "customFormula";
type FormulaHelperKind =
  | "sum"
  | "average"
  | "count"
  | "counta"
  | "min"
  | "max"
  | "sumif-equals"
  | "countif-equals"
  | "averageif-equals"
  | "query-sum"
  | "query-count"
  | "query-top"
  | "helix-classify";
type SheetChartType = "bar" | "line" | "pie" | "scatter" | "combo" | "sparkline";
type SpreadsheetNavigationKey =
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "ArrowLeft"
  | "Tab"
  | "Enter"
  | "PageUp"
  | "PageDown"
  | "Home"
  | "End";

interface SheetChartSpec {
  readonly id: string;
  readonly type: SheetChartType;
  readonly title: string;
  readonly tabId: string;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
  readonly labelCol?: number;
  readonly valueCol?: number;
  readonly placement?: SheetChartPlacement;
}

interface SheetChartPlacement {
  readonly anchorRow: number;
  readonly anchorCol: number;
  readonly rowSpan: number;
  readonly colSpan: number;
}

type SheetChartsUpdater = (charts: readonly SheetChartSpec[]) => readonly SheetChartSpec[];

interface SheetImageSpec {
  readonly id: string;
  readonly tabId: string;
  readonly driveObjectId: string;
  readonly src: string;
  readonly alt: string;
  readonly title: string;
  readonly mimeType: string;
  readonly placement: SheetImagePlacement;
}

interface SheetImagePlacement {
  readonly anchorRow: number;
  readonly anchorCol: number;
  readonly rowSpan: number;
  readonly colSpan: number;
}

type SheetImagesUpdater = (images: readonly SheetImageSpec[]) => readonly SheetImageSpec[];

interface SheetImageDragState {
  readonly imageId: string;
  readonly mode: "move" | "resize";
  readonly startX: number;
  readonly startY: number;
  readonly originalPlacement: SheetImagePlacement;
}

type SheetPivotAggregation = "sum" | "count";

interface SheetPivotSlicerSpec {
  readonly column: number;
  readonly operator: "contains";
  readonly value: string;
}

interface SheetPivotTableSpec {
  readonly id: string;
  readonly tabId: string;
  readonly title: string;
  readonly rowFieldCol: number;
  readonly valueFieldCol: number;
  readonly aggregation: SheetPivotAggregation;
  readonly slicer?: SheetPivotSlicerSpec;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

type SheetPivotTablesUpdater = (
  pivots: readonly SheetPivotTableSpec[],
) => readonly SheetPivotTableSpec[];

interface SheetNamedRangeSpec {
  readonly id: string;
  readonly tabId: string;
  readonly name: string;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

interface SheetMergedRangeSpec {
  readonly id: string;
  readonly tabId: string;
  readonly label: string;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

interface SelectedRangeSummary {
  readonly cellCount: number;
  readonly populatedCount: number;
  readonly numberCount: number;
  readonly sum: number | null;
  readonly average: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

interface SheetFrozenPaneSpec {
  readonly tabId: string;
  readonly frozenRows: number;
  readonly frozenCols: number;
}

interface DataValidationChoiceContext {
  readonly namedRanges: readonly SheetNamedRangeSpec[];
  readonly grid: EditableGrid;
}

type SheetNamedRangesUpdater = (
  ranges: readonly SheetNamedRangeSpec[],
) => readonly SheetNamedRangeSpec[];

type SheetMergedRangesUpdater = (
  ranges: readonly SheetMergedRangeSpec[],
) => readonly SheetMergedRangeSpec[];

type SheetFrozenPanesUpdater = (
  panes: readonly SheetFrozenPaneSpec[],
) => readonly SheetFrozenPaneSpec[];

type SheetFilterPredicateOperator = "contains" | "equals" | "greaterThan" | "notEmpty";

interface SheetFilterPredicateSpec {
  readonly column: number;
  readonly operator: SheetFilterPredicateOperator;
  readonly value: string;
}

interface SheetFilterViewSpec {
  readonly id: string;
  readonly tabId: string;
  readonly name: string;
  readonly sortDirection: SortDirection;
  readonly sortColumn?: number;
  readonly sortKeys?: readonly number[];
  readonly predicate?: SheetFilterPredicateSpec;
  readonly predicates?: readonly SheetFilterPredicateSpec[];
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

type SheetFilterViewsUpdater = (
  views: readonly SheetFilterViewSpec[],
) => readonly SheetFilterViewSpec[];

type SheetProtectedRangeMode = "block" | "warn";

interface SheetProtectedRangeSpec {
  readonly id: string;
  readonly tabId: string;
  readonly label: string;
  readonly mode?: SheetProtectedRangeMode;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

type SheetProtectedRangesUpdater = (
  ranges: readonly SheetProtectedRangeSpec[],
) => readonly SheetProtectedRangeSpec[];

interface SheetDataValidationRule {
  readonly id: string;
  readonly validation: unknown;
  readonly cells: readonly CellAddress[];
  readonly label: string;
}

interface SheetConditionalFormatRule {
  readonly id: string;
  readonly conditionalFormat: unknown;
  readonly cells: readonly CellAddress[];
  readonly label: string;
}

interface FormattedClipboardCell {
  readonly value: string;
  readonly format: CellFormat;
}

type SeriesDateFormat =
  | { readonly kind: "iso" }
  | { readonly kind: "slash"; readonly monthWidth: number; readonly dayWidth: number }
  | { readonly kind: "monthName"; readonly style: "short" | "long" };

interface SeriesDateValue {
  readonly time: number;
  readonly format: SeriesDateFormat;
}

export interface NativeSpreadsheetEditorProps {
  readonly sheetId: string;
  readonly onBack: () => void;
  readonly onOpenSheet?: ((sheetId: string) => void) | undefined;
}

interface NativeSpreadsheetCommandHandlers {
  readonly back: () => void;
  readonly exportCsv: () => void;
  readonly exportOds: () => void;
  readonly exportTsv: () => void;
  readonly exportXlsx: () => void;
  readonly createTab: () => void;
  readonly insertSum: () => void;
  readonly insertQueryCount: () => void;
  readonly insertHelixClassify: () => void;
  readonly sortAsc: () => void;
  readonly sortDesc: () => void;
  readonly analyze: () => void;
  readonly focusComments: () => void;
}

export function NativeSpreadsheetEditor({
  sheetId,
  onBack,
  onOpenSheet,
}: NativeSpreadsheetEditorProps) {
  const queryClient = useQueryClient();
  const platformHost = useWebPlatformHost();
  const commandHandlersRef = useRef<NativeSpreadsheetCommandHandlers>({
    back: () => undefined,
    exportCsv: () => undefined,
    exportOds: () => undefined,
    exportTsv: () => undefined,
    exportXlsx: () => undefined,
    createTab: () => undefined,
    insertSum: () => undefined,
    insertQueryCount: () => undefined,
    insertHelixClassify: () => undefined,
    sortAsc: () => undefined,
    sortDesc: () => undefined,
    analyze: () => undefined,
    focusComments: () => undefined,
  });
  const sheetQuery = useQuery(sheetQueryOptions(sheetId));
  const versionsQuery = useQuery(sheetVersionsQueryOptions(sheetId));
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabNameDraft, setTabNameDraft] = useState("");
  const visibleTabs = useMemo(
    () =>
      [...(sheetQuery.data?.tabs ?? [])]
        .filter((tab) => tab.deletedAt === null)
        .sort((left, right) => left.position - right.position),
    [sheetQuery.data?.tabs],
  );
  const activeTab = visibleTabs.find((tab) => tab.id === activeTabId) ?? visibleTabs[0] ?? null;
  const activeTabIndex =
    activeTab === null ? -1 : visibleTabs.findIndex((tab) => tab.id === activeTab.id);

  useEffect(() => {
    const firstTabId = visibleTabs[0]?.id ?? null;
    setActiveTabId((current) =>
      current !== null && visibleTabs.some((tab) => tab.id === current) ? current : firstTabId,
    );
  }, [visibleTabs]);

  useEffect(() => {
    setTabNameDraft(activeTab?.name ?? "");
  }, [activeTab?.id, activeTab?.name]);

  const [viewport, setViewport] = useState<CellAddress>({ row: 0, col: 0 });
  const frozenPanes = useMemo(
    () => sheetFrozenPanesFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const activeFrozenPane = useMemo(
    () => frozenPaneForTab(frozenPanes, activeTab?.id ?? null),
    [activeTab?.id, frozenPanes],
  );
  const tabWindow = useMemo(
    () => sheetTabWindowForViewport(viewport, activeFrozenPane),
    [activeFrozenPane, viewport],
  );
  const tabQuery = useQuery(sheetTabQueryOptions(activeTabId, tabWindow));
  const [cellCacheByTab, setCellCacheByTab] = useState<Record<string, readonly SheetsApiCell[]>>(
    {},
  );
  useEffect(() => {
    if (activeTabId === null || tabQuery.data === undefined) {
      return;
    }
    setCellCacheByTab((current) => ({
      ...current,
      [activeTabId]: mergeWindowCells(current[activeTabId] ?? [], tabQuery.data.cells, tabWindow),
    }));
  }, [activeTabId, tabQuery.data, tabWindow]);
  const tabCells =
    activeTabId === null ? EMPTY_SHEET_CELLS : (cellCacheByTab[activeTabId] ?? EMPTY_SHEET_CELLS);
  const baseGrid = useMemo(
    () => padGrid(gridFromCells(tabCells), tabWindow.endRow + 1, tabWindow.endCol + 1),
    [tabCells, tabWindow],
  );
  const baseDisplayGrid = useMemo(
    () => padGrid(displayGridFromCells(tabCells), tabWindow.endRow + 1, tabWindow.endCol + 1),
    [tabCells, tabWindow],
  );
  const formatMap = useMemo(() => cellFormatMap(tabCells), [tabCells]);
  const [grid, setGrid] = useState<EditableGrid>(() => baseGrid);
  const [cellHistory, setCellHistory] = useState<{
    readonly past: readonly SheetCellHistoryEntry[];
    readonly future: readonly SheetCellHistoryEntry[];
  }>({ past: [], future: [] });
  const [hasRecoveredGridDraft, setHasRecoveredGridDraft] = useState(false);
  const displayGrid = useMemo(
    () => displayGridWithLocalSheetEdits(baseGrid, baseDisplayGrid, grid),
    [baseDisplayGrid, baseGrid, grid],
  );
  const [selectedCell, setSelectedCell] = useState<CellAddress | null>(null);
  const [selectedRange, setSelectedRange] = useState<CellRange | null>(null);
  const [cellClipboard, setCellClipboard] = useState<SheetsInternalClipboard | null>(null);
  const [fillPreviewRange, setFillPreviewRange] = useState<CellRange | null>(null);
  const [editingCell, setEditingCell] = useState<CellAddress | null>(null);
  const [comments, setComments] = useState<readonly SheetsDriveComment[]>([]);
  const [commentsStatus, setCommentsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [commentStatusFilter, setCommentStatusFilter] = useState<SheetsCommentStatus>("open");
  const [commentDraft, setCommentDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [commentEditDrafts, setCommentEditDrafts] = useState<Record<string, string>>({});
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [chartType, setChartType] = useState<SheetChartType>("bar");
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [imageDragPreview, setImageDragPreview] = useState<{
    readonly imageId: string;
    readonly placement: SheetImagePlacement;
  } | null>(null);
  const [rangeAssist, setRangeAssist] = useState<SpreadsheetRangeAssist | null>(null);
  const [syncStatus, setSyncStatus] = useState<NativeSpreadsheetSyncStatus>("offline");
  const [activeFilterViewId, setActiveFilterViewId] = useState<string | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [sidePanelTabId, setSidePanelTabId] = useState<SheetsSidePanelTabId>("comments");
  const skipNextProgrammaticFocus = useRef(false);
  const skipNextGridBlurCommit = useRef<CellAddress | null>(null);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const imageDragRef = useRef<SheetImageDragState | null>(null);
  const rangeDragAnchorRef = useRef<CellAddress | null>(null);
  const viewportRef = useRef<CellAddress>(viewport);
  const activeTabIdRef = useRef<string | null>(null);
  const syncProviderRef = useRef<NativeSpreadsheetSyncProvider | null>(null);
  const applyingRecoveredGridRef = useRef(false);
  const suppressGridRecoveryRef = useRef(false);
  const releaseGridRecoverySuppression = useDebouncedCallback(
    () => {
      suppressGridRecoveryRef.current = false;
    },
    { wait: 0 },
  );

  useEffect(() => {
    if (activeTabId === null) {
      setGrid(baseGrid);
      setHasRecoveredGridDraft(false);
      return;
    }
    if (tabQuery.data === undefined) {
      setGrid(baseGrid);
      setHasRecoveredGridDraft(false);
      return;
    }
    const recovered = gridWithRecoveredSheetEdits(baseGrid, sheetId, activeTabId);
    applyingRecoveredGridRef.current = recovered.recovered;
    setGrid(recovered.grid);
    setHasRecoveredGridDraft(recovered.recovered);
  }, [activeTabId, baseGrid, sheetId, tabQuery.data]);

  useEffect(() => {
    if (activeTabId === null || tabQuery.data === undefined || suppressGridRecoveryRef.current) {
      return;
    }
    const dirtyEdits = diffSheetGrid(baseGrid, grid);
    if (dirtyEdits.length === 0) {
      if (applyingRecoveredGridRef.current) {
        return;
      }
      removeRecoveredSheetGrid(sheetId, activeTabId);
      setHasRecoveredGridDraft(false);
      return;
    }
    applyingRecoveredGridRef.current = false;
    writeRecoveredSheetGrid(sheetId, activeTabId, dirtyEdits);
    setHasRecoveredGridDraft(true);
  }, [activeTabId, baseGrid, grid, sheetId, tabQuery.data]);

  useEffect(() => {
    setViewport({ row: 0, col: 0 });
    viewportRef.current = { row: 0, col: 0 };
  }, [activeTabId]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    setActiveFilterViewId(null);
    setSelectedImageId(null);
    setImageDragPreview(null);
    imageDragRef.current = null;
  }, [activeTabId]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    const provider = new NativeSpreadsheetSyncProvider({
      sheetId,
      onStatusChange: setSyncStatus,
      onOperation: (frame) => {
        queryClient.setQueryData<SheetsApiTabWithCells>(
          sheetsQueryKeys.tab(frame.tabId),
          (current) =>
            current === undefined
              ? current
              : applySpreadsheetOperationToTab(current, frame.operation),
        );
        if (activeTabIdRef.current === frame.tabId) {
          setGrid((current) => applySyncedOperationToGrid(current, frame.operation.changes));
        }
        void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
        void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.tab(frame.tabId) });
      },
    });
    syncProviderRef.current = provider;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        provider.connect();
      }
    });
    return () => {
      cancelled = true;
      provider.disconnect({ notify: false });
      if (syncProviderRef.current === provider) {
        syncProviderRef.current = null;
      }
    };
  }, [queryClient, sheetId]);

  const formulaBarValue =
    selectedCell === null ? "" : (grid[selectedCell.row]?.[selectedCell.col] ?? "");
  const activeSheetComments = useMemo(
    () => comments.filter((comment) => isSheetRangeCommentForTab(comment, activeTabId)),
    [activeTabId, comments],
  );
  const activeSheetCommentThreads = useMemo(
    () => sheetCommentThreads(activeSheetComments),
    [activeSheetComments],
  );
  const sheetCharts = useMemo(
    () => sheetChartsFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const sheetImages = useMemo(
    () => sheetImagesFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const pivotTables = useMemo(
    () => sheetPivotTablesFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const namedRanges = useMemo(
    () => sheetNamedRangesFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const mergedRanges = useMemo(
    () => sheetMergedRangesFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const filterViews = useMemo(
    () => sheetFilterViewsFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const protectedRanges = useMemo(
    () => sheetProtectedRangesFromMetadata(sheetQuery.data?.metadata),
    [sheetQuery.data?.metadata],
  );
  const activeSheetCharts = sheetCharts.filter(
    (chart) => activeTabId === null || chart.tabId === activeTabId,
  );
  const activeSheetImages = sheetImages.filter(
    (image) => activeTabId === null || image.tabId === activeTabId,
  );
  const activePivotTables = pivotTables.filter(
    (pivot) => activeTabId === null || pivot.tabId === activeTabId,
  );
  const activeNamedRanges = namedRanges.filter(
    (range) => activeTabId === null || range.tabId === activeTabId,
  );
  const activeMergedRanges = mergedRanges.filter(
    (range) => activeTabId === null || range.tabId === activeTabId,
  );
  const activeFilterViews = filterViews.filter(
    (view) => activeTabId === null || view.tabId === activeTabId,
  );
  const activeDisplayFilterView =
    activeFilterViews.find((view) => view.id === activeFilterViewId) ?? null;
  const activeProtectedRanges = protectedRanges.filter(
    (range) => activeTabId === null || range.tabId === activeTabId,
  );
  const validationChoiceContext = useMemo(
    () => ({ namedRanges: activeNamedRanges, grid }),
    [activeNamedRanges, grid],
  );
  const validationRules = useMemo(
    () => sheetDataValidationRulesFromCells(tabQuery.data?.cells ?? [], validationChoiceContext),
    [tabQuery.data?.cells, validationChoiceContext],
  );
  const conditionalFormatRules = useMemo(
    () => sheetConditionalFormatRulesFromCells(tabQuery.data?.cells ?? []),
    [tabQuery.data?.cells],
  );
  const tabNameById = useMemo(
    () => new Map(visibleTabs.map((tab) => [tab.id, tab.name])),
    [visibleTabs],
  );
  const visibleRows = useMemo(
    () =>
      filteredVisibleRows({
        grid,
        displayGrid,
        viewportRow: viewport.row,
        frozenRows: activeFrozenPane.frozenRows,
        filterView: activeDisplayFilterView,
      }),
    [activeDisplayFilterView, activeFrozenPane.frozenRows, displayGrid, grid, viewport.row],
  );
  const visibleCols = useMemo(
    () => visibleColumnIndexes(viewport.col, activeFrozenPane.frozenCols),
    [activeFrozenPane.frozenCols, viewport.col],
  );
  const openSheetComments = activeSheetComments.filter((comment) => comment.status === "open");
  const selectedCommentTarget =
    selectedRange ??
    (selectedCell === null ? null : singleCellRange(selectedCell.row, selectedCell.col));
  const selectedRangeSummary = useMemo(
    () =>
      selectedCommentTarget === null
        ? null
        : summarizeSelectedRange(selectedCommentTarget, grid, displayGrid),
    [displayGrid, grid, selectedCommentTarget],
  );
  const selectedCommentLabel =
    selectedCommentTarget === null ? "Select a cell or range" : rangeLabel(selectedCommentTarget);
  const selectedRangeProtected =
    selectedCommentTarget !== null &&
    rangeIntersectsProtectedRanges(selectedCommentTarget, protectedRanges, activeTabId);
  const selectedRangeBlocked =
    selectedCommentTarget !== null &&
    rangeIntersectsBlockingProtectedRanges(selectedCommentTarget, protectedRanges, activeTabId);
  const selectedRangeMerged =
    selectedCommentTarget !== null &&
    activeMergedRanges.some((range) =>
      rangesEqual(mergedRangeToCellRange(range), selectedCommentTarget),
    );
  const selectedFillRange =
    selectedRange ??
    (selectedCell === null ? null : singleCellRange(selectedCell.row, selectedCell.col));
  const fillHandlePlacement =
    selectedFillRange === null
      ? null
      : fillHandlePlacementForRange(selectedFillRange, visibleRows, visibleCols);
  const selectedFormat =
    selectedCell === null
      ? {}
      : (formatMap.get(cellCoordinateKey(selectedCell.row, selectedCell.col)) ?? {});

  useEffect(() => {
    let cancelled = false;
    setCommentsStatus("loading");
    listSheetComments({ sheetId, status: commentStatusFilter })
      .then((nextComments) => {
        if (!cancelled) {
          setComments(nextComments);
          setCommentsStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommentsStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [commentStatusFilter, sheetId]);

  const updateMutation = useMutation({
    mutationFn: (input: { readonly tabId: string; readonly edits: readonly SheetsCellEdit[] }) => {
      return updateSheetCells({
        tabId: input.tabId,
        edits: input.edits,
      });
    },
    onMutate: () => undefined,
    onSuccess: async (tab) => {
      queryClient.setQueryData<SheetsApiTabWithCells>(
        sheetsQueryKeys.tabWindow(tab.id, tabWindow),
        tab,
      );
      setCellCacheByTab((current) => ({
        ...current,
        [tab.id]: mergeWindowCells(current[tab.id] ?? [], tab.cells, tabWindow),
      }));
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.tab(tab.id) });
    },
    onError: () => undefined,
  });

  const sortMutation = useMutation({
    mutationFn: (input: {
      readonly tabId: string;
      readonly range: SheetChartSpec["range"];
      readonly direction: SortDirection;
    }) => sortSheetRange(input),
    onMutate: () => undefined,
    onSuccess: async (tab) => {
      queryClient.setQueryData<SheetsApiTabWithCells>(
        sheetsQueryKeys.tabWindow(tab.id, tabWindow),
        tab,
      );
      setCellCacheByTab((current) => ({
        ...current,
        [tab.id]: mergeWindowCells(current[tab.id] ?? [], tab.cells, tabWindow),
      }));
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.tab(tab.id) });
    },
    onError: () => undefined,
  });

  const exportMutation = useMutation({
    mutationFn: (format: "csv" | "tsv" | "xlsx" | "ods") =>
      exportSheet({
        sheetId,
        format,
        ...(format === "xlsx" || format === "ods" || activeTab === null
          ? {}
          : { tabId: activeTab.id }),
      }),
    onMutate: () => undefined,
    onSuccess: (exported) => {
      downloadSheetExport(exported);
    },
    onError: () => undefined,
  });

  const createSheetMutation = useMutation({
    mutationFn: () =>
      createSheet({
        title: "Untitled spreadsheet",
        tabNames: ["Sheet 1"],
        metadata: { createdFrom: "web.native-spreadsheet-editor" },
      }),
    onMutate: () => undefined,
    onSuccess: async (sheet) => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      onOpenSheet?.(sheet.id);
    },
    onError: () => undefined,
  });

  const copySheetMutation = useMutation({
    mutationFn: () => {
      const title = sheetQuery.data?.title ?? "Spreadsheet";
      return copySheet({
        sheetId,
        title: `${title} (Copy)`,
        metadata: { createdFrom: "web.native-spreadsheet-editor.make-copy" },
      });
    },
    onMutate: () => undefined,
    onSuccess: async (sheet) => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      onOpenSheet?.(sheet.id);
    },
    onError: () => undefined,
  });

  const trashSheetMutation = useMutation({
    mutationFn: () => trashDriveObject(sheetId),
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
      onBack();
    },
    onError: () => undefined,
  });

  const restoreVersionMutation = useMutation({
    mutationFn: (versionId: string) => restoreSheetVersion({ sheetId, versionId }),
    onMutate: () => undefined,
    onSuccess: async (sheet) => {
      const visibleRestoredTabs = sheet.tabs.filter((tab) => tab.deletedAt === null);
      setCellHistory({ past: [], future: [] });
      suppressGridRecoveryRef.current = true;
      for (const tab of visibleRestoredTabs) {
        removeRecoveredSheetGrid(sheetId, tab.id);
      }
      setHasRecoveredGridDraft(false);
      setCellCacheByTab({});
      setActiveTabId(visibleRestoredTabs[0]?.id ?? null);
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.versions(sheetId) });
      await Promise.all(
        visibleRestoredTabs.map((tab) =>
          queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.tab(tab.id) }),
        ),
      );
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      releaseGridRecoverySuppression();
    },
    onError: () => undefined,
  });

  const chartsMutation = useMutation({
    mutationFn: (updater: SheetChartsUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextCharts = updater(sheetChartsFromMetadata(latestMetadata));
      return updateSheet({
        sheetId,
        metadata: metadataWithCharts(latestMetadata, nextCharts),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    },
    onError: () => undefined,
  });

  const imagesMutation = useMutation({
    mutationFn: async (input: { readonly file: File; readonly placement: SheetImagePlacement }) => {
      if (activeTabId === null) {
        throw new Error("No active spreadsheet tab.");
      }
      const uploaded = await uploadDriveFile({ file: input.file, folderId: null });
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextImage = createSheetImageSpec({
        tabId: activeTabId,
        file: input.file,
        driveObjectId: uploaded.objectId,
        placement: input.placement,
      });
      return updateSheet({
        sheetId,
        metadata: metadataWithImages(latestMetadata, [
          ...sheetImagesFromMetadata(latestMetadata),
          nextImage,
        ]),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.versions(sheetId) });
    },
    onError: () => undefined,
  });

  const imageMetadataMutation = useMutation({
    mutationFn: (updater: SheetImagesUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      return updateSheet({
        sheetId,
        metadata: metadataWithImages(
          latestMetadata,
          updater(sheetImagesFromMetadata(latestMetadata)),
        ),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.versions(sheetId) });
    },
    onError: () => undefined,
  });

  const pivotTablesMutation = useMutation({
    mutationFn: (updater: SheetPivotTablesUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextPivots = updater(sheetPivotTablesFromMetadata(latestMetadata));
      return updateSheet({
        sheetId,
        metadata: metadataWithPivotTables(latestMetadata, nextPivots),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    },
    onError: () => undefined,
  });

  const namedRangesMutation = useMutation({
    mutationFn: (updater: SheetNamedRangesUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextRanges = updater(sheetNamedRangesFromMetadata(latestMetadata));
      return updateSheet({
        sheetId,
        metadata: metadataWithNamedRanges(latestMetadata, nextRanges),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    },
    onError: () => undefined,
  });

  const mergedRangesMutation = useMutation({
    mutationFn: (updater: SheetMergedRangesUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextRanges = updater(sheetMergedRangesFromMetadata(latestMetadata));
      return updateSheet({
        sheetId,
        metadata: metadataWithMergedCells(latestMetadata, nextRanges),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    },
    onError: () => undefined,
  });

  const frozenPanesMutation = useMutation({
    mutationFn: (updater: SheetFrozenPanesUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextPanes = updater(sheetFrozenPanesFromMetadata(latestMetadata));
      return updateSheet({
        sheetId,
        metadata: metadataWithFrozenPanes(latestMetadata, nextPanes),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    },
    onError: () => undefined,
  });

  const filterViewsMutation = useMutation({
    mutationFn: (updater: SheetFilterViewsUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextViews = updater(sheetFilterViewsFromMetadata(latestMetadata));
      return updateSheet({
        sheetId,
        metadata: metadataWithFilterViews(latestMetadata, nextViews),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    },
    onError: () => undefined,
  });

  const protectedRangesMutation = useMutation({
    mutationFn: (updater: SheetProtectedRangesUpdater) => {
      const latestSheet = queryClient.getQueryData<SheetsApiSheetWithTabs>(
        sheetsQueryKeys.sheet(sheetId),
      );
      const latestMetadata = latestSheet?.metadata ?? sheetQuery.data?.metadata ?? {};
      const nextRanges = updater(sheetProtectedRangesFromMetadata(latestMetadata));
      return updateSheet({
        sheetId,
        metadata: metadataWithProtectedRanges(latestMetadata, nextRanges),
      });
    },
    onMutate: () => undefined,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    },
    onError: () => undefined,
  });

  const createTabMutation = useMutation({
    mutationFn: () =>
      createSheetTab({
        sheetId,
        name: nextSheetTabName(visibleTabs),
        position: visibleTabs.length,
      }),
    onMutate: () => undefined,
    onSuccess: async (tab) => {
      setActiveTabId(tab.id);
      await invalidateSheetTabs(tab.id);
    },
    onError: () => undefined,
  });

  const renameTabMutation = useMutation({
    mutationFn: (input: { readonly tabId: string; readonly name: string }) => updateSheetTab(input),
    onMutate: () => undefined,
    onSuccess: async (tab) => {
      setActiveTabId(tab.id);
      await invalidateSheetTabs(tab.id);
    },
    onError: () => undefined,
  });

  const moveTabMutation = useMutation({
    mutationFn: async (input: { readonly tab: SheetsApiTab; readonly target: SheetsApiTab }) => {
      await updateSheetTab({ tabId: input.target.id, position: input.tab.position });
      return updateSheetTab({ tabId: input.tab.id, position: input.target.position });
    },
    onMutate: () => undefined,
    onSuccess: async (tab) => {
      setActiveTabId(tab.id);
      await invalidateSheetTabs(tab.id);
    },
    onError: () => undefined,
  });

  const deleteTabMutation = useMutation({
    mutationFn: (tab: SheetsApiTab) => deleteSheetTab({ tabId: tab.id }),
    onMutate: () => undefined,
    onSuccess: async (_result, deletedTab) => {
      const remaining = visibleTabs.filter((tab) => tab.id !== deletedTab.id);
      const fallback =
        remaining[Math.min(activeTabIndex < 0 ? 0 : activeTabIndex, remaining.length - 1)] ?? null;
      setActiveTabId(fallback?.id ?? null);
      await invalidateSheetTabs(fallback?.id ?? null);
      queryClient.removeQueries({ queryKey: sheetsQueryKeys.tab(deletedTab.id) });
    },
    onError: () => undefined,
  });

  const tabMutationPending =
    createTabMutation.isPending ||
    renameTabMutation.isPending ||
    moveTabMutation.isPending ||
    deleteTabMutation.isPending;

  async function invalidateSheetTabs(tabId: string | null) {
    await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
    await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all });
    if (tabId !== null) {
      await queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.tab(tabId) });
    }
  }

  function renameActiveTab() {
    if (activeTab === null) {
      return;
    }
    const name = tabNameDraft.trim();
    if (name.length === 0 || name === activeTab.name || renameTabMutation.isPending) {
      return;
    }
    renameTabMutation.mutate({ tabId: activeTab.id, name });
  }

  function moveActiveTab(direction: -1 | 1) {
    if (activeTab === null || moveTabMutation.isPending) {
      return;
    }
    const target = visibleTabs[activeTabIndex + direction];
    if (target === undefined) {
      return;
    }
    moveTabMutation.mutate({ tab: activeTab, target });
  }

  function deleteActiveTab() {
    if (activeTab === null || visibleTabs.length <= 1 || deleteTabMutation.isPending) {
      return;
    }
    deleteTabMutation.mutate(activeTab);
  }

  function updateLocalCell(row: number, col: number, value: string) {
    if (cellBlockingProtectedRange(row, col, protectedRanges, activeTabId) !== null) {
      return;
    }
    if (cellRejectsValue(row, col, value, formatMap, validationChoiceContext)) {
      return;
    }
    updateLocalCells([{ row, col, value }]);
  }

  function updateLocalCells(edits: readonly SheetsCellEdit[]) {
    const editableEdits = edits.filter(
      (edit) =>
        cellBlockingProtectedRange(edit.row, edit.col, protectedRanges, activeTabId) === null &&
        !cellIsCoveredByMergedRange(edit.row, edit.col, activeMergedRanges, activeTabId) &&
        !cellEditRejectedByValidation(edit, formatMap, validationChoiceContext),
    );
    applyLocalCellValues(editableEdits);
  }

  function applyLocalCellValues(edits: readonly SheetsCellEdit[]) {
    setGrid((current) => {
      const next = [...current];
      for (const edit of edits) {
        const row = [
          ...(next[edit.row] ??
            Array.from({ length: Math.max(SHEET_MAX_COLS, edit.col + 1) }, () => "")),
        ];
        row[edit.col] = edit.value;
        next[edit.row] = row;
      }
      return next;
    });
  }

  function commitCell(row: number, col: number, value = grid[row]?.[col] ?? "") {
    if (cellBlockingProtectedRange(row, col, protectedRanges, activeTabId) !== null) {
      return;
    }
    if (cellRejectsValue(row, col, value, formatMap, validationChoiceContext)) {
      return;
    }
    const edit = cellEditWithAutoLink(baseGrid, formatMap, row, col, value);
    commitCells(edit === null ? [] : [edit]);
  }

  function commitGridCellFromBlur(row: number, col: number, value?: string) {
    const skipped = skipNextGridBlurCommit.current;
    if (skipped !== null && skipped.row === row && skipped.col === col) {
      skipNextGridBlurCommit.current = null;
      return;
    }
    commitCell(row, col, value);
  }

  function commitCells(
    edits: readonly SheetsCellEdit[],
    options: { readonly recordHistory?: boolean } = {},
  ) {
    const targetTabId = activeTabId;
    if (targetTabId === null) {
      return;
    }
    const editableEdits = edits.filter(
      (edit) =>
        cellBlockingProtectedRange(edit.row, edit.col, protectedRanges, activeTabId) === null &&
        !cellIsCoveredByMergedRange(edit.row, edit.col, activeMergedRanges, activeTabId) &&
        !cellEditRejectedByValidation(edit, formatMap, validationChoiceContext),
    );
    const meaningfulEdits = meaningfulSheetCellEdits(editableEdits, baseGrid, formatMap);
    if (meaningfulEdits.length > 0 && !updateMutation.isPending) {
      if (options.recordHistory !== false) {
        recordSheetCellHistory(targetTabId, meaningfulEdits);
      }
      if (syncProviderRef.current?.sendCellEdits(targetTabId, meaningfulEdits) === true) {
        return;
      }
      updateMutation.mutate({ tabId: targetTabId, edits: meaningfulEdits });
    }
  }

  function recordSheetCellHistory(tabId: string, redoEdits: readonly SheetsCellEdit[]) {
    const entry = sheetCellHistoryEntry(tabId, redoEdits, baseGrid, formatMap);
    if (entry === null) {
      return;
    }
    setCellHistory((history) => ({
      past: [...history.past, entry].slice(-50),
      future: [],
    }));
  }

  function undoSheetCellHistory() {
    const entry = cellHistory.past.at(-1);
    if (entry === undefined || entry.tabId !== activeTabId || updateMutation.isPending) {
      return;
    }
    applyLocalCellValues(entry.undoEdits);
    commitCells(entry.undoEdits, { recordHistory: false });
    setCellHistory((history) => ({
      past: history.past.slice(0, -1),
      future: [entry, ...history.future].slice(0, 50),
    }));
  }

  function redoSheetCellHistory() {
    const entry = cellHistory.future[0];
    if (entry === undefined || entry.tabId !== activeTabId || updateMutation.isPending) {
      return;
    }
    applyLocalCellValues(entry.redoEdits);
    commitCells(entry.redoEdits, { recordHistory: false });
    setCellHistory((history) => ({
      past: [...history.past, entry].slice(-50),
      future: history.future.slice(1),
    }));
  }

  function beginFillDrag(event: ReactMouseEvent<HTMLButtonElement>, sourceRange: CellRange) {
    if (updateMutation.isPending) {
      return;
    }
    const gridRect = gridWrapRef.current?.getBoundingClientRect();
    if (gridRect === undefined || gridRect.width <= 0 || gridRect.height <= 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const normalizedSource = normalizeRange(sourceRange);
    let latestPreview: CellRange | null = null;

    const previewForPoint = (clientX: number, clientY: number): CellRange | null => {
      const currentViewport = autoscrollFillViewportForPoint(clientX, clientY, gridRect);
      const target = fillDragTargetFromGridPoint(
        clientX,
        clientY,
        gridRect,
        visibleRowIndexes(currentViewport.row, activeFrozenPane.frozenRows),
        visibleColumnIndexes(currentViewport.col, activeFrozenPane.frozenCols),
      );
      if (target === null) {
        return null;
      }
      const rowDelta = Math.max(target.row - normalizedSource.bottom, 0);
      const colDelta = Math.max(target.col - normalizedSource.right, 0);
      if (rowDelta === 0 && colDelta === 0) {
        return null;
      }
      if (rowDelta >= colDelta) {
        return {
          start: { row: normalizedSource.top, col: normalizedSource.left },
          end: { row: target.row, col: normalizedSource.right },
        };
      }
      return {
        start: { row: normalizedSource.top, col: normalizedSource.left },
        end: { row: normalizedSource.bottom, col: target.col },
      };
    };

    const onMove = (moveEvent: MouseEvent) => {
      latestPreview = previewForPoint(moveEvent.clientX, moveEvent.clientY);
      setFillPreviewRange(latestPreview);
    };
    const onUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const finalRange = latestPreview ?? previewForPoint(upEvent.clientX, upEvent.clientY);
      setFillPreviewRange(null);
      if (finalRange === null) {
        return;
      }
      const edits = copyFillEdits(sourceRange, finalRange, grid, formatMap);
      if (edits.length === 0) {
        return;
      }
      updateLocalCells(edits);
      commitCells(edits);
      const normalizedFinal = normalizeRange(finalRange);
      const end = { row: normalizedFinal.bottom, col: normalizedFinal.right };
      setSelectedCell(end);
      setSelectedRange(finalRange);
      setEditingCell(null);
      revealCell(end);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function autoscrollFillViewportForPoint(
    clientX: number,
    clientY: number,
    rect: DOMRect,
  ): CellAddress {
    const current = viewportRef.current;
    const gridRight = rect.left + SHEET_ROW_HEADER_WIDTH + VISIBLE_COLS * SHEET_CELL_WIDTH;
    const gridBottom = rect.top + SHEET_CELL_HEIGHT + VISIBLE_ROWS * SHEET_CELL_HEIGHT;
    const colDelta =
      clientX >= gridRight
        ? Math.max(1, Math.ceil((clientX - gridRight + 1) / SHEET_CELL_WIDTH))
        : 0;
    const rowDelta =
      clientY >= gridBottom
        ? Math.max(1, Math.ceil((clientY - gridBottom + 1) / SHEET_CELL_HEIGHT))
        : 0;
    if (rowDelta === 0 && colDelta === 0) {
      return current;
    }
    const next = clampViewport({
      row: current.row + rowDelta,
      col: current.col + colDelta,
    });
    if (next.row !== current.row || next.col !== current.col) {
      viewportRef.current = next;
      setViewport(next);
    }
    return next;
  }

  function handlePaste(
    row: number,
    col: number,
    text: string,
    formattedCells: string,
    droppedLinkUrl?: string,
  ) {
    const edits = (
      editsFromFormattedClipboard(formattedCells, row, col) ??
      editsFromClipboardText(text, row, col, baseGrid, formatMap, droppedLinkUrl)
    ).filter(
      (edit) =>
        cellBlockingProtectedRange(edit.row, edit.col, protectedRanges, activeTabId) === null &&
        !cellEditRejectedByValidation(edit, formatMap, validationChoiceContext),
    );
    if (edits.length === 0) {
      return;
    }
    updateLocalCells(edits);
    commitCells(edits);
    const end = edits[edits.length - 1];
    if (end !== undefined) {
      setSelectedCell({ row: end.row, col: end.col });
      setSelectedRange({
        start: { row, col },
        end: { row: end.row, col: end.col },
      });
      revealCell({ row: end.row, col: end.col });
    }
  }

  function copySelectedCellsToInternalClipboard(): SheetsInternalClipboard | null {
    if (selectedCommentTarget === null) {
      return null;
    }
    const clipboard: SheetsInternalClipboard = {
      text: clipboardTextForRange(grid, selectedCommentTarget),
      formattedCells: formattedClipboardTextForRange(grid, selectedCommentTarget, formatMap),
    };
    setCellClipboard(clipboard);
    void writePlainClipboardText(clipboard.text).catch(() => undefined);
    return clipboard;
  }

  function cutSelectedCellsToInternalClipboard() {
    const copied = copySelectedCellsToInternalClipboard();
    if (copied === null || selectedCommentTarget === null) {
      return;
    }
    const edits = clearedCellEditsForRange(selectedCommentTarget);
    if (edits.length === 0) {
      return;
    }
    updateLocalCells(edits);
    commitCells(edits);
  }

  function pasteInternalClipboardToSelection() {
    const target = selectedCell ?? selectedCommentTarget?.start ?? null;
    if (target === null) {
      return;
    }
    if (cellClipboard !== null) {
      handlePaste(target.row, target.col, cellClipboard.text, cellClipboard.formattedCells);
      return;
    }
    void readPlainClipboardText()
      .then((text) => {
        if (text.length > 0) {
          handlePaste(target.row, target.col, text, "");
        }
      })
      .catch(() => undefined);
  }

  function applyFormatPatch(patch: CellFormat) {
    const range =
      selectedRange ??
      (selectedCell === null ? null : singleCellRange(selectedCell.row, selectedCell.col));
    if (range === null) {
      return;
    }
    if (rangeIntersectsBlockingProtectedRanges(range, protectedRanges, activeTabId)) {
      return;
    }
    const edits = formatEditsForRange(range, grid, formatMap, patch);
    commitCells(edits);
  }

  function selectDataValidationRule(rule: SheetDataValidationRule) {
    const range = boundingRangeForCells(rule.cells);
    if (range === null) {
      return;
    }
    setSelectedCell(range.start);
    setSelectedRange(range);
    setEditingCell(null);
    revealCell(range.start);
  }

  function updateDataValidationRuleMode(rule: SheetDataValidationRule, mode: DataValidationMode) {
    if (updateMutation.isPending) {
      return;
    }
    const validation = dataValidationWithMode(rule.validation, mode);
    commitCells(
      rule.cells.map((cell) => ({
        row: cell.row,
        col: cell.col,
        value: grid[cell.row]?.[cell.col] ?? "",
        format: mergeCellFormat(formatMap.get(cellCoordinateKey(cell.row, cell.col)) ?? {}, {
          dataValidation: validation,
        }),
      })),
    );
  }

  function clearDataValidationRule(rule: SheetDataValidationRule) {
    if (updateMutation.isPending) {
      return;
    }
    commitCells(
      rule.cells.map((cell) => ({
        row: cell.row,
        col: cell.col,
        value: grid[cell.row]?.[cell.col] ?? "",
        format: mergeCellFormat(formatMap.get(cellCoordinateKey(cell.row, cell.col)) ?? {}, {
          dataValidation: "",
        }),
      })),
    );
  }

  function selectConditionalFormatRule(rule: SheetConditionalFormatRule) {
    const range = boundingRangeForCells(rule.cells);
    if (range === null) {
      return;
    }
    setSelectedCell(range.start);
    setSelectedRange(range);
    setEditingCell(null);
    revealCell(range.start);
  }

  function clearConditionalFormatRule(rule: SheetConditionalFormatRule) {
    if (updateMutation.isPending) {
      return;
    }
    commitCells(
      rule.cells.map((cell) => ({
        row: cell.row,
        col: cell.col,
        value: grid[cell.row]?.[cell.col] ?? "",
        format: mergeCellFormat(formatMap.get(cellCoordinateKey(cell.row, cell.col)) ?? {}, {
          conditionalFormat: "",
        }),
      })),
    );
  }

  function applyBorderPreset(preset: BorderPreset) {
    const range =
      selectedRange ??
      (selectedCell === null ? null : singleCellRange(selectedCell.row, selectedCell.col));
    if (range === null) {
      return;
    }
    if (rangeIntersectsBlockingProtectedRanges(range, protectedRanges, activeTabId)) {
      return;
    }
    commitCells(borderEditsForRange(range, grid, formatMap, preset));
  }

  function sortSelectedRange(direction: SortDirection) {
    if (
      selectedRange === null ||
      activeTabId === null ||
      updateMutation.isPending ||
      sortMutation.isPending
    ) {
      return;
    }
    sortRange(selectedRange, direction);
  }

  function sortRange(range: CellRange, direction: SortDirection) {
    if (activeTabId === null || updateMutation.isPending || sortMutation.isPending) {
      return;
    }
    const normalized = normalizeRange(range);
    if (
      normalized.top === normalized.bottom ||
      rangeIntersectsBlockingProtectedRanges(range, protectedRanges, activeTabId)
    ) {
      return;
    }
    const edits = sortEditsForRange(range, grid, formatMap, direction);
    updateLocalCells(edits);
    sortMutation.mutate({
      tabId: activeTabId,
      direction,
      range: {
        startRow: normalized.top,
        startCol: normalized.left,
        endRow: normalized.bottom,
        endCol: normalized.right,
      },
    });
    const start = { row: normalized.top, col: normalized.left };
    setSelectedCell(start);
    setSelectedRange({
      start,
      end: { row: normalized.bottom, col: normalized.right },
    });
    setEditingCell(null);
    revealCell(start);
  }

  function sendStructuralOperation(change: NativeSpreadsheetOperationChange) {
    if (activeTabId === null || !syncProviderRef.current?.canSendOperation()) {
      return;
    }
    syncProviderRef.current.sendOperation(activeTabId, [change]);
    updateSelectionAfterStructuralOperation(change);
  }

  function updateSelectionAfterStructuralOperation(change: NativeSpreadsheetOperationChange) {
    if (change.kind !== "delete-rows" && change.kind !== "delete-columns") {
      setEditingCell(null);
      return;
    }
    const selected = selectedCell;
    if (selected === null) {
      setEditingCell(null);
      return;
    }
    const next =
      change.kind === "delete-rows"
        ? {
            row: selectedIndexAfterDelete(selected.row, change.index, change.count, SHEET_MAX_ROWS),
            col: selected.col,
          }
        : {
            row: selected.row,
            col: selectedIndexAfterDelete(selected.col, change.index, change.count, SHEET_MAX_COLS),
          };
    setSelectedCell(next);
    setSelectedRange(singleCellRange(next.row, next.col));
    setEditingCell(null);
    revealCell(next);
  }

  function addProtectedRange() {
    if (
      activeTabId === null ||
      selectedCommentTarget === null ||
      protectedRangesMutation.isPending
    ) {
      return;
    }
    protectedRangesMutation.mutate((currentRanges) => [
      ...currentRanges,
      createProtectedRangeSpec(activeTabId, selectedCommentTarget),
    ]);
  }

  function deleteProtectedRange(rangeId: string) {
    if (protectedRangesMutation.isPending) {
      return;
    }
    protectedRangesMutation.mutate((currentRanges) =>
      currentRanges.filter((range) => range.id !== rangeId),
    );
  }

  function updateProtectedRangeMode(rangeId: string, mode: SheetProtectedRangeMode) {
    if (protectedRangesMutation.isPending) {
      return;
    }
    protectedRangesMutation.mutate((currentRanges) =>
      currentRanges.map((range) => (range.id === rangeId ? { ...range, mode } : range)),
    );
  }

  function selectProtectedRange(range: SheetProtectedRangeSpec) {
    const targetRange = protectedRangeToCellRange(range);
    const normalized = normalizeRange(targetRange);
    const start = { row: normalized.top, col: normalized.left };
    if (activeTabId !== range.tabId) {
      setActiveTabId(range.tabId);
    }
    setSelectedCell(start);
    setSelectedRange({
      start,
      end: { row: normalized.bottom, col: normalized.right },
    });
    setEditingCell(null);
    revealCell(start);
  }

  function insertFormulaHelper(kind: FormulaHelperKind) {
    const sourceRange =
      selectedRange ??
      (selectedCell === null ? null : singleCellRange(selectedCell.row, selectedCell.col));
    if (sourceRange === null || activeTabId === null || updateMutation.isPending) {
      return;
    }
    const normalized = normalizeRange(sourceRange);
    const target = formulaHelperTarget(normalized);
    if (
      target === null ||
      cellBlockingProtectedRange(target.row, target.col, protectedRanges, activeTabId) !== null
    ) {
      return;
    }
    const edit = {
      row: target.row,
      col: target.col,
      value: formulaHelperValue(kind, rangeLabel(sourceRange), normalized.left),
    };
    updateLocalCells([edit]);
    commitCells([edit]);
    setSelectedCell(target);
    setSelectedRange(null);
    setEditingCell(null);
    revealCell(target);
  }

  function addChart() {
    const targetRange = selectedRange ?? selectedCommentTarget;
    if (activeTabId === null || targetRange === null || chartsMutation.isPending) {
      return;
    }
    chartsMutation.mutate((currentCharts) => [
      ...currentCharts,
      createSheetChartSpec(activeTabId, targetRange, chartType),
    ]);
  }

  function insertImageFromPicker() {
    if (activeTabId === null || imagesMutation.isPending || imageMetadataMutation.isPending) {
      return;
    }
    imageFileInputRef.current?.click();
  }

  function handleImageInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = Array.from(event.currentTarget.files ?? []).find(isDroppedSheetImageFile);
    event.currentTarget.value = "";
    if (
      file === undefined ||
      activeTabId === null ||
      imagesMutation.isPending ||
      imageMetadataMutation.isPending
    ) {
      return;
    }
    const anchor =
      selectedCell ??
      (selectedCommentTarget === null
        ? { row: viewport.row, col: viewport.col }
        : selectedCommentTarget.start);
    imagesMutation.mutate({
      file,
      placement: defaultSheetImagePlacementForAnchor(anchor.row, anchor.col),
    });
  }

  function handleSheetDragOver(event: DragEvent<HTMLDivElement>) {
    if (
      activeTabId === null ||
      (droppedSheetImageFile(event.dataTransfer) === undefined &&
        !hasDroppedSheetText(event.dataTransfer))
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleSheetDrop(event: DragEvent<HTMLDivElement>) {
    if (activeTabId === null || imagesMutation.isPending || imageMetadataMutation.isPending) {
      return;
    }
    const file = droppedSheetImageFile(event.dataTransfer);
    if (file !== undefined) {
      const placement = sheetImagePlacementFromDrop(event, visibleRows, visibleCols);
      if (placement === null) {
        return;
      }
      event.preventDefault();
      imagesMutation.mutate({ file, placement });
      return;
    }
    const text = droppedSheetText(event.dataTransfer);
    const targetCell = sheetCellFromDrop(event, visibleRows, visibleCols);
    if (text.length === 0 || targetCell === null) {
      return;
    }
    event.preventDefault();
    handlePaste(targetCell.row, targetCell.col, text, "", droppedSheetLinkUrl(event.dataTransfer));
  }

  function deleteSheetImage(imageId: string) {
    if (imageMetadataMutation.isPending) {
      return;
    }
    setSelectedImageId(null);
    setImageDragPreview(null);
    imageDragRef.current = null;
    imageMetadataMutation.mutate((currentImages) =>
      currentImages.filter((image) => image.id !== imageId),
    );
  }

  function beginSheetImageDrag(event: ReactMouseEvent<HTMLElement>, image: SheetImageSpec) {
    if (event.button !== 0 || imageMetadataMutation.isPending) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    setSelectedImageId(image.id);
    const dragState: SheetImageDragState = {
      imageId: image.id,
      mode: "move",
      startX: event.clientX,
      startY: event.clientY,
      originalPlacement: image.placement,
    };
    imageDragRef.current = dragState;
    setImageDragPreview({ imageId: image.id, placement: image.placement });

    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const currentDrag = imageDragRef.current;
      if (currentDrag === null) {
        return;
      }
      const deltaCol = Math.round((moveEvent.clientX - currentDrag.startX) / SHEET_CELL_WIDTH);
      const deltaRow = Math.round((moveEvent.clientY - currentDrag.startY) / SHEET_CELL_HEIGHT);
      setImageDragPreview({
        imageId: currentDrag.imageId,
        placement: sheetImagePlacementForDrag(currentDrag, deltaRow, deltaCol),
      });
    };

    const handleUp = (upEvent: globalThis.MouseEvent) => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      const currentDrag = imageDragRef.current;
      imageDragRef.current = null;
      if (currentDrag === null) {
        setImageDragPreview(null);
        return;
      }
      const deltaCol = Math.round((upEvent.clientX - currentDrag.startX) / SHEET_CELL_WIDTH);
      const deltaRow = Math.round((upEvent.clientY - currentDrag.startY) / SHEET_CELL_HEIGHT);
      const nextPlacement = sheetImagePlacementForDrag(currentDrag, deltaRow, deltaCol);
      setImageDragPreview(null);
      if (sheetImagePlacementEqual(nextPlacement, currentDrag.originalPlacement)) {
        return;
      }
      imageMetadataMutation.mutate((currentImages) =>
        currentImages.map((currentImage) =>
          currentImage.id === currentDrag.imageId
            ? { ...currentImage, placement: nextPlacement }
            : currentImage,
        ),
      );
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  function beginSheetImageResize(event: ReactMouseEvent<HTMLElement>, image: SheetImageSpec) {
    if (event.button !== 0 || imageMetadataMutation.isPending) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setSelectedImageId(image.id);
    const dragState: SheetImageDragState = {
      imageId: image.id,
      mode: "resize",
      startX: event.clientX,
      startY: event.clientY,
      originalPlacement: image.placement,
    };
    imageDragRef.current = dragState;
    setImageDragPreview({ imageId: image.id, placement: image.placement });

    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const currentDrag = imageDragRef.current;
      if (currentDrag === null) {
        return;
      }
      const deltaCol = Math.round((moveEvent.clientX - currentDrag.startX) / SHEET_CELL_WIDTH);
      const deltaRow = Math.round((moveEvent.clientY - currentDrag.startY) / SHEET_CELL_HEIGHT);
      setImageDragPreview({
        imageId: currentDrag.imageId,
        placement: sheetImagePlacementForDrag(currentDrag, deltaRow, deltaCol),
      });
    };

    const handleUp = (upEvent: globalThis.MouseEvent) => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      const currentDrag = imageDragRef.current;
      imageDragRef.current = null;
      if (currentDrag === null) {
        setImageDragPreview(null);
        return;
      }
      const deltaCol = Math.round((upEvent.clientX - currentDrag.startX) / SHEET_CELL_WIDTH);
      const deltaRow = Math.round((upEvent.clientY - currentDrag.startY) / SHEET_CELL_HEIGHT);
      const nextPlacement = sheetImagePlacementForDrag(currentDrag, deltaRow, deltaCol);
      setImageDragPreview(null);
      if (sheetImagePlacementEqual(nextPlacement, currentDrag.originalPlacement)) {
        return;
      }
      imageMetadataMutation.mutate((currentImages) =>
        currentImages.map((currentImage) =>
          currentImage.id === currentDrag.imageId
            ? { ...currentImage, placement: nextPlacement }
            : currentImage,
        ),
      );
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }

  function addPivotTable() {
    const targetRange = selectedRange ?? selectedCommentTarget;
    if (
      activeTabId === null ||
      targetRange === null ||
      !canCreatePivotTableFromRange(targetRange) ||
      pivotTablesMutation.isPending
    ) {
      return;
    }
    pivotTablesMutation.mutate((currentPivots) => [
      ...currentPivots,
      createSheetPivotTableSpec(activeTabId, targetRange, currentPivots),
    ]);
  }

  function addNamedRange() {
    const targetRange = selectedRange ?? selectedCommentTarget;
    if (activeTabId === null || targetRange === null || namedRangesMutation.isPending) {
      return;
    }
    namedRangesMutation.mutate((currentRanges) => [
      ...currentRanges,
      createNamedRangeSpec(activeTabId, targetRange, currentRanges),
    ]);
  }

  function mergeSelectedRange() {
    const targetRange = selectedRange ?? selectedCommentTarget;
    if (
      activeTabId === null ||
      targetRange === null ||
      mergedRangesMutation.isPending ||
      !canMergeRange(targetRange) ||
      rangeIntersectsMergedRanges(targetRange, activeMergedRanges, activeTabId)
    ) {
      return;
    }
    mergedRangesMutation.mutate((currentRanges) => [
      ...currentRanges,
      createMergedRangeSpec(activeTabId, targetRange),
    ]);
  }

  function unmergeRange(rangeId: string) {
    if (mergedRangesMutation.isPending) {
      return;
    }
    mergedRangesMutation.mutate((currentRanges) =>
      currentRanges.filter((range) => range.id !== rangeId),
    );
  }

  function freezeRowsToSelection() {
    if (activeTabId === null || selectedCommentTarget === null || frozenPanesMutation.isPending) {
      return;
    }
    const normalized = normalizeRange(selectedCommentTarget);
    const frozenRows = clampNumber(normalized.bottom + 1, 0, SHEET_MAX_ROWS);
    frozenPanesMutation.mutate((currentPanes) =>
      upsertFrozenPane(currentPanes, activeTabId, {
        frozenRows,
        frozenCols: activeFrozenPane.frozenCols,
      }),
    );
  }

  function freezeColumnsToSelection() {
    if (activeTabId === null || selectedCommentTarget === null || frozenPanesMutation.isPending) {
      return;
    }
    const normalized = normalizeRange(selectedCommentTarget);
    const frozenCols = clampNumber(normalized.right + 1, 0, SHEET_MAX_COLS);
    frozenPanesMutation.mutate((currentPanes) =>
      upsertFrozenPane(currentPanes, activeTabId, {
        frozenRows: activeFrozenPane.frozenRows,
        frozenCols,
      }),
    );
  }

  function clearFrozenPanes() {
    if (activeTabId === null || frozenPanesMutation.isPending) {
      return;
    }
    frozenPanesMutation.mutate((currentPanes) =>
      currentPanes.filter((pane) => pane.tabId !== activeTabId),
    );
  }

  function selectMergedRange(range: SheetMergedRangeSpec) {
    const targetRange = mergedRangeToCellRange(range);
    const normalized = normalizeRange(targetRange);
    const start = { row: normalized.top, col: normalized.left };
    if (activeTabId !== range.tabId) {
      setActiveTabId(range.tabId);
    }
    setSelectedCell(start);
    setSelectedRange({
      start,
      end: { row: normalized.bottom, col: normalized.right },
    });
    setEditingCell(null);
    revealCell(start);
  }

  function addFilterView(sortDirection: SortDirection) {
    const targetRange = selectedRange ?? selectedCommentTarget;
    if (activeTabId === null || targetRange === null || filterViewsMutation.isPending) {
      return;
    }
    const view = createFilterViewSpec(activeTabId, targetRange, sortDirection, filterViews);
    setActiveFilterViewId(view.id);
    filterViewsMutation.mutate((currentViews) => [...currentViews, view]);
  }

  function toggleActiveFilterView() {
    if (activeFilterViewId !== null) {
      setActiveFilterViewId(null);
      return;
    }
    const savedView = activeFilterViews[0];
    if (savedView !== undefined) {
      setActiveFilterViewId(savedView.id);
      return;
    }
    addFilterView("asc");
  }

  function analyzeSelectedRange() {
    const targetRange = selectedRange ?? selectedCommentTarget;
    if (targetRange === null) {
      return;
    }
    setRangeAssist(analyzeSpreadsheetRange(grid, normalizeRange(targetRange)));
  }

  function applyFormulaAssist(assist: SpreadsheetFormulaAssist) {
    if (
      activeTabId === null ||
      updateMutation.isPending ||
      cellBlockingProtectedRange(
        assist.target.row,
        assist.target.col,
        protectedRanges,
        activeTabId,
      ) !== null
    ) {
      return;
    }
    const edit = {
      row: assist.target.row,
      col: assist.target.col,
      value: assist.formula,
    };
    updateLocalCells([edit]);
    commitCells([edit]);
    setSelectedCell(assist.target);
    setSelectedRange(null);
    setEditingCell(null);
    revealCell(assist.target);
  }

  function updateChart(
    chartId: string,
    patch: Partial<Pick<SheetChartSpec, "title" | "type" | "placement" | "labelCol" | "valueCol">>,
  ) {
    if (chartsMutation.isPending) {
      return;
    }
    chartsMutation.mutate((currentCharts) =>
      currentCharts.map((chart) => (chart.id === chartId ? { ...chart, ...patch } : chart)),
    );
  }

  function updateChartRange(chartId: string, range: CellRange) {
    if (chartsMutation.isPending) {
      return;
    }
    const normalized = normalizeRange(range);
    chartsMutation.mutate((currentCharts) =>
      currentCharts.map((chart) =>
        chart.id === chartId
          ? {
              ...chart,
              range: {
                startRow: normalized.top,
                startCol: normalized.left,
                endRow: normalized.bottom,
                endCol: normalized.right,
              },
              labelCol: normalized.left,
              valueCol: Math.min(normalized.left + 1, normalized.right),
            }
          : chart,
      ),
    );
  }

  function updateChartPlacement(chartId: string, range: CellRange) {
    const normalized = normalizeRange(range);
    updateChart(chartId, {
      placement: defaultChartPlacementForAnchor(normalized.top, normalized.left),
    });
  }

  function deleteChart(chartId: string) {
    if (chartsMutation.isPending) {
      return;
    }
    chartsMutation.mutate((currentCharts) => currentCharts.filter((chart) => chart.id !== chartId));
  }

  function updatePivotTable(
    pivotId: string,
    patch: Partial<
      Pick<
        SheetPivotTableSpec,
        "title" | "aggregation" | "range" | "rowFieldCol" | "valueFieldCol" | "slicer"
      >
    >,
  ) {
    if (pivotTablesMutation.isPending) {
      return;
    }
    pivotTablesMutation.mutate((currentPivots) =>
      currentPivots.map((pivot) => (pivot.id === pivotId ? { ...pivot, ...patch } : pivot)),
    );
  }

  function updatePivotTableRange(pivotId: string, range: CellRange) {
    if (!canCreatePivotTableFromRange(range)) {
      return;
    }
    const normalized = normalizeRange(range);
    const pivot = activePivotTables.find((candidate) => candidate.id === pivotId);
    const slicer = pivot?.slicer;
    updatePivotTable(pivotId, {
      rowFieldCol: normalized.left,
      valueFieldCol: Math.min(normalized.left + 1, normalized.right),
      ...(slicer === undefined
        ? {}
        : {
            slicer: {
              ...slicer,
              column: filterPredicateColumn(slicer.column, normalized),
            },
          }),
      range: {
        startRow: normalized.top,
        startCol: normalized.left,
        endRow: normalized.bottom,
        endCol: normalized.right,
      },
    });
  }

  function deletePivotTable(pivotId: string) {
    if (pivotTablesMutation.isPending) {
      return;
    }
    pivotTablesMutation.mutate((currentPivots) =>
      currentPivots.filter((pivot) => pivot.id !== pivotId),
    );
  }

  function updateNamedRange(
    rangeId: string,
    patch: Partial<Pick<SheetNamedRangeSpec, "name" | "range">>,
  ) {
    if (namedRangesMutation.isPending) {
      return;
    }
    namedRangesMutation.mutate((currentRanges) =>
      currentRanges.map((range) => (range.id === rangeId ? { ...range, ...patch } : range)),
    );
  }

  function updateNamedRangeSelection(rangeId: string, range: CellRange) {
    const normalized = normalizeRange(range);
    updateNamedRange(rangeId, {
      range: {
        startRow: normalized.top,
        startCol: normalized.left,
        endRow: normalized.bottom,
        endCol: normalized.right,
      },
    });
  }

  function deleteNamedRange(rangeId: string) {
    if (namedRangesMutation.isPending) {
      return;
    }
    namedRangesMutation.mutate((currentRanges) =>
      currentRanges.filter((range) => range.id !== rangeId),
    );
  }

  function updateFilterView(
    viewId: string,
    patch: Partial<
      Pick<
        SheetFilterViewSpec,
        "name" | "range" | "sortDirection" | "sortColumn" | "sortKeys" | "predicate" | "predicates"
      >
    >,
  ) {
    if (filterViewsMutation.isPending) {
      return;
    }
    filterViewsMutation.mutate((currentViews) =>
      currentViews.map((view) => (view.id === viewId ? { ...view, ...patch } : view)),
    );
  }

  function updateFilterViewSelection(viewId: string, range: CellRange) {
    const normalized = normalizeRange(range);
    const view = activeFilterViews.find((filterView) => filterView.id === viewId) ?? null;
    const nextPredicates =
      view === null
        ? []
        : filterViewPredicates(view).map((predicate) => ({
            ...predicate,
            column: clampNumber(predicate.column, normalized.left, normalized.right),
          }));
    updateFilterView(viewId, {
      range: {
        startRow: normalized.top,
        startCol: normalized.left,
        endRow: normalized.bottom,
        endCol: normalized.right,
      },
      sortColumn:
        view?.sortColumn === undefined
          ? undefined
          : filterPredicateColumn(view.sortColumn, normalized),
      sortKeys:
        view?.sortKeys === undefined ? undefined : normalizedFilterViewSortKeys(view, normalized),
      predicate: nextPredicates[0],
      predicates: nextPredicates,
    });
  }

  function updateFilterViewPrimarySortColumn(view: SheetFilterViewSpec, column: number) {
    const range = normalizeRange(filterViewRange(view));
    const currentPrimary = filterViewSortColumn(view);
    const primary = filterPredicateColumn(column, range);
    const secondary =
      filterViewSecondarySortColumn(view) ?? (currentPrimary === primary ? null : currentPrimary);
    updateFilterView(view.id, {
      sortColumn: primary,
      sortKeys:
        secondary === null || secondary === primary
          ? [primary]
          : [primary, filterPredicateColumn(secondary, range)],
    });
  }

  function updateFilterViewSecondarySortColumn(view: SheetFilterViewSpec, value: string) {
    const primary = filterViewSortColumn(view);
    const range = normalizeRange(filterViewRange(view));
    if (value.length === 0) {
      updateFilterView(view.id, { sortKeys: [primary] });
      return;
    }
    const secondary = filterPredicateColumn(Number(value), range);
    updateFilterView(view.id, {
      sortKeys: secondary === primary ? [primary] : [primary, secondary],
    });
  }

  function applyFilterView(view: SheetFilterViewSpec) {
    if (activeTabId !== view.tabId) {
      return;
    }
    setActiveFilterViewId(view.id);
  }

  function updateFilterViewPredicateAt(
    view: SheetFilterViewSpec,
    predicateIndex: number,
    patch: Partial<SheetFilterPredicateSpec>,
  ) {
    mutateFilterViewPredicates(view.id, (currentView, currentPredicates) => {
      const range = filterViewRange(currentView);
      const currentPredicate = currentPredicates[predicateIndex] ?? defaultFilterPredicate(range);
      const column = filterPredicateColumn(patch.column ?? currentPredicate.column, range);
      return currentPredicates.map((predicate, index) =>
        index === predicateIndex
          ? {
              ...currentPredicate,
              ...patch,
              column,
              value: patch.value ?? currentPredicate.value,
            }
          : predicate,
      );
    });
  }

  function addFilterViewPredicate(view: SheetFilterViewSpec) {
    mutateFilterViewPredicates(view.id, (currentView, currentPredicates) => [
      ...currentPredicates,
      defaultFilterPredicate(currentView),
    ]);
  }

  function deleteFilterViewPredicate(view: SheetFilterViewSpec, predicateIndex: number) {
    mutateFilterViewPredicates(view.id, (_currentView, currentPredicates) =>
      currentPredicates.filter((_predicate, index) => index !== predicateIndex),
    );
  }

  function mutateFilterViewPredicates(
    viewId: string,
    updater: (
      view: SheetFilterViewSpec,
      predicates: readonly SheetFilterPredicateSpec[],
    ) => readonly SheetFilterPredicateSpec[],
  ) {
    if (filterViewsMutation.isPending) {
      return;
    }
    filterViewsMutation.mutate((currentViews) =>
      currentViews.map((view) => {
        if (view.id !== viewId) {
          return view;
        }
        const predicates = updater(view, filterViewEditablePredicates(view));
        return { ...view, predicate: predicates[0], predicates };
      }),
    );
  }

  function toggleDisplayFilterView(view: SheetFilterViewSpec) {
    setActiveFilterViewId((current) => (current === view.id ? null : view.id));
  }

  function deleteFilterView(viewId: string) {
    if (filterViewsMutation.isPending) {
      return;
    }
    setActiveFilterViewId((current) => (current === viewId ? null : current));
    filterViewsMutation.mutate((currentViews) => currentViews.filter((view) => view.id !== viewId));
  }

  async function addComment() {
    const body = commentDraft.trim();
    if (body.length === 0 || activeTabId === null || selectedCommentTarget === null) {
      return;
    }
    const anchor = sheetCommentAnchor({
      sheetId,
      tabId: activeTabId,
      range: selectedCommentTarget,
    });
    const comment = await createSheetComment({
      sheetId,
      body,
      anchor,
      metadata: { source: "web.native-spreadsheet-editor.comments" },
    });
    setComments((current) => [...current, comment]);
    setCommentDraft("");
  }

  async function resolveComment(commentId: string) {
    const comment = await resolveSheetComment({ commentId });
    setComments((current) => {
      if (commentStatusFilter === "open") {
        return current.filter((candidate) => candidate.id !== comment.id);
      }
      return current.map((candidate) => (candidate.id === comment.id ? comment : candidate));
    });
  }

  async function reopenComment(commentId: string) {
    const comment = await reopenSheetComment({ commentId });
    setComments((current) => {
      if (commentStatusFilter === "resolved") {
        return current.filter((candidate) => candidate.id !== comment.id);
      }
      if (current.some((candidate) => candidate.id === comment.id)) {
        return current.map((candidate) => (candidate.id === comment.id ? comment : candidate));
      }
      return [...current, comment];
    });
  }

  function beginCommentEdit(comment: SheetsDriveComment) {
    setCommentEditDrafts((current) => ({ ...current, [comment.id]: comment.body }));
  }

  function cancelCommentEdit(commentId: string) {
    setCommentEditDrafts((current) => {
      const next = { ...current };
      delete next[commentId];
      return next;
    });
  }

  async function saveCommentEdit(commentId: string) {
    const body = (commentEditDrafts[commentId] ?? "").trim();
    if (body.length === 0) {
      return;
    }
    const comment = await updateSheetComment({ commentId, body });
    setComments((current) =>
      current.map((candidate) => (candidate.id === comment.id ? comment : candidate)),
    );
    cancelCommentEdit(comment.id);
  }

  async function removeComment(commentId: string) {
    const comment = await deleteSheetComment({ commentId });
    setComments((current) =>
      current.filter(
        (candidate) => candidate.id !== comment.id && candidate.parentCommentId !== comment.id,
      ),
    );
    setReplyDrafts((current) => {
      const next = { ...current };
      delete next[comment.id];
      return next;
    });
    setCommentEditDrafts((current) => {
      const next = { ...current };
      delete next[comment.id];
      return next;
    });
  }

  async function addReply(parent: SheetsDriveComment) {
    const body = (replyDrafts[parent.id] ?? "").trim();
    if (body.length === 0) {
      return;
    }
    const comment = await createSheetComment({
      sheetId,
      body,
      anchor: parent.anchor,
      parentCommentId: parent.id,
      metadata: { source: "web.native-spreadsheet-editor.comments.reply" },
    });
    setComments((current) =>
      commentStatusFilter === "resolved" ? current : [...current, comment],
    );
    setReplyDrafts((current) => {
      const next = { ...current };
      delete next[parent.id];
      return next;
    });
  }

  commandHandlersRef.current = {
    back: onBack,
    exportCsv: () => exportMutation.mutate("csv"),
    exportOds: () => exportMutation.mutate("ods"),
    exportTsv: () => exportMutation.mutate("tsv"),
    exportXlsx: () => exportMutation.mutate("xlsx"),
    createTab: () => createTabMutation.mutate(),
    insertSum: () => insertFormulaHelper("sum"),
    insertQueryCount: () => insertFormulaHelper("query-count"),
    insertHelixClassify: () => insertFormulaHelper("helix-classify"),
    sortAsc: () => sortSelectedRange("asc"),
    sortDesc: () => sortSelectedRange("desc"),
    analyze: analyzeSelectedRange,
    focusComments: () => focusSpreadsheetControl("native-spreadsheet-comments-panel"),
  };

  useEffect(() => {
    const sheetTitle = sheetQuery.data?.title;
    if (sheetTitle === undefined) {
      return undefined;
    }
    const run = (command: keyof NativeSpreadsheetCommandHandlers) => () => {
      commandHandlersRef.current[command]();
    };
    return platformHost.registerCommandPaletteItems([
      {
        id: `sheets:${sheetId}:back`,
        pluginId: "com.helix.sheets",
        label: "Back to Sheets list",
        group: "Spreadsheet",
        keywords: ["back", "list", sheetTitle],
        order: 110,
        run: run("back"),
      },
      {
        id: `sheets:${sheetId}:export:xlsx`,
        pluginId: "com.helix.sheets",
        label: "Export spreadsheet as XLSX",
        group: "Spreadsheet",
        keywords: ["download", "export", "workbook", "xlsx", sheetTitle],
        order: 120,
        run: run("exportXlsx"),
      },
      {
        id: `sheets:${sheetId}:export:ods`,
        pluginId: "com.helix.sheets",
        label: "Export spreadsheet as ODS",
        group: "Spreadsheet",
        keywords: ["download", "export", "workbook", "ods", "opendocument", sheetTitle],
        order: 121,
        run: run("exportOds"),
      },
      {
        id: `sheets:${sheetId}:export:csv`,
        pluginId: "com.helix.sheets",
        label: "Export active sheet as CSV",
        group: "Spreadsheet",
        keywords: ["download", "export", "csv", activeTab?.name ?? ""],
        order: 122,
        run: run("exportCsv"),
      },
      {
        id: `sheets:${sheetId}:export:tsv`,
        pluginId: "com.helix.sheets",
        label: "Export active sheet as TSV",
        group: "Spreadsheet",
        keywords: ["download", "export", "tsv", activeTab?.name ?? ""],
        order: 123,
        run: run("exportTsv"),
      },
      {
        id: `sheets:${sheetId}:tab:create`,
        pluginId: "com.helix.sheets",
        label: "Create sheet tab",
        group: "Spreadsheet",
        keywords: ["tab", "sheet", "create", "add"],
        order: 130,
        run: run("createTab"),
      },
      {
        id: `sheets:${sheetId}:formula:sum`,
        pluginId: "com.helix.sheets",
        label: "Insert SUM for selected range",
        group: "Spreadsheet",
        keywords: ["formula", "sum", "selected range"],
        order: 140,
        run: run("insertSum"),
      },
      {
        id: `sheets:${sheetId}:formula:query-count`,
        pluginId: "com.helix.sheets",
        label: "Insert QUERY count for selected range",
        group: "Spreadsheet",
        keywords: ["formula", "query", "count", "selected range"],
        order: 141,
        run: run("insertQueryCount"),
      },
      {
        id: `sheets:${sheetId}:formula:classify`,
        pluginId: "com.helix.sheets",
        label: "Insert HELIX classify formula",
        group: "Spreadsheet",
        keywords: ["formula", "ai", "classify", "helix"],
        order: 142,
        run: run("insertHelixClassify"),
      },
      {
        id: `sheets:${sheetId}:sort:asc`,
        pluginId: "com.helix.sheets",
        label: "Sort range A to Z",
        group: "Spreadsheet",
        keywords: ["sort", "ascending", "a-z", activeTab?.name ?? ""],
        order: 150,
        run: run("sortAsc"),
      },
      {
        id: `sheets:${sheetId}:sort:desc`,
        pluginId: "com.helix.sheets",
        label: "Sort range Z to A",
        group: "Spreadsheet",
        keywords: ["sort", "descending", "z-a", activeTab?.name ?? ""],
        order: 151,
        run: run("sortDesc"),
      },
      {
        id: `sheets:${sheetId}:analyze`,
        pluginId: "com.helix.sheets",
        label: "Analyze selected range",
        group: "Spreadsheet",
        keywords: ["analyze", "assist", "summary", "selected range"],
        order: 160,
        run: run("analyze"),
      },
      {
        id: `sheets:${sheetId}:comments`,
        pluginId: "com.helix.sheets",
        label: "Jump to spreadsheet comments",
        group: "Spreadsheet",
        keywords: ["comments", "review", activeTab?.name ?? ""],
        order: 170,
        run: run("focusComments"),
      },
    ]);
  }, [activeTab?.name, platformHost, sheetId, sheetQuery.data?.title]);

  function navigateCell(
    row: number,
    col: number,
    key: SpreadsheetNavigationKey,
    shiftKey: boolean,
    edgeKey: boolean,
    value: string,
  ) {
    const next = nextCellAddress(row, col, key, shiftKey, edgeKey);
    if (next.row === row && next.col === col && !shiftKey) {
      commitCell(row, col, value);
      const current = { row, col };
      setSelectedCell(current);
      setSelectedRange(singleCellRange(row, col));
      setEditingCell(current);
      skipNextProgrammaticFocus.current = true;
      focusGridCell(current, setViewport);
      return;
    }

    commitCell(row, col, value);
    skipNextGridBlurCommit.current = { row, col };
    if (shiftKey) {
      const anchor = selectedRange?.start ?? selectedCell ?? { row, col };
      setSelectedCell(next);
      setSelectedRange({ start: anchor, end: next });
      setEditingCell(null);
    } else {
      setSelectedCell(next);
      setSelectedRange(singleCellRange(next.row, next.col));
      setEditingCell(next);
    }
    skipNextProgrammaticFocus.current = true;
    focusGridCell(next, setViewport);
  }

  function revealCell(cell: CellAddress) {
    setViewport((current) => viewportForCell(cell, current));
  }

  function beginRangeDragSelection(
    event: ReactMouseEvent<HTMLInputElement>,
    anchorRow: number,
    anchorCol: number,
  ) {
    if (event.button !== 0) {
      return;
    }
    const anchor = { row: anchorRow, col: anchorCol };
    rangeDragAnchorRef.current = anchor;
    setSelectedCell(anchor);
    setSelectedRange(singleCellRange(anchorRow, anchorCol));
    setEditingCell(anchor);

    const onMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      rangeDragAnchorRef.current = null;
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function extendRangeDragSelection(row: number, col: number) {
    const anchor = rangeDragAnchorRef.current;
    if (anchor === null) {
      return;
    }
    const target = { row, col };
    setSelectedCell(target);
    setSelectedRange({ start: anchor, end: target });
    if (target.row !== anchor.row || target.col !== anchor.col) {
      setEditingCell(null);
    }
  }

  if (sheetQuery.isLoading) {
    return <EditorNotice icon={<Icons.Sheet />} text="Loading spreadsheet..." />;
  }

  if (sheetQuery.isError || sheetQuery.data === undefined) {
    return <EditorNotice icon={<Icons.Globe />} text="Spreadsheet unavailable." />;
  }

  /* ── Unified editor chrome (menus + ribbon + side panel) ──
     The detailed formatting toolbar, viewport navigation, and right rail
     below are preserved temporarily for backward-compatibility with the
     extensive existing test suite. Future cleanup: remove the legacy
     toolbar/aside once tests are migrated to the chrome surfaces. */
  const chromeStatus: EditorAppBarStatus =
    updateMutation.isPending ||
    chartsMutation.isPending ||
    imagesMutation.isPending ||
    imageMetadataMutation.isPending ||
    pivotTablesMutation.isPending ||
    namedRangesMutation.isPending ||
    filterViewsMutation.isPending ||
    protectedRangesMutation.isPending ||
    restoreVersionMutation.isPending ||
    tabMutationPending
      ? { kind: "saving" }
      : hasRecoveredGridDraft
        ? { kind: "offline", label: "Recovered" }
        : syncStatus === "connected"
          ? { kind: "live" }
          : syncStatus === "offline"
            ? { kind: "offline" }
            : { kind: "saved" };

  const chromeContext: SheetsChromeContext = {
    hasSelection: selectedCell !== null,
    selectionLocked: selectedRangeBlocked,
    fontFamily:
      typeof selectedFormat.fontFamily === "string" ? selectedFormat.fontFamily : "default",
    fontSize: typeof selectedFormat.fontSize === "string" ? selectedFormat.fontSize : "11",
    bold: formatBoolean(selectedFormat.bold),
    italic: formatBoolean(selectedFormat.italic),
    underline: formatBoolean(selectedFormat.underline),
    strikethrough: formatBoolean(selectedFormat.strikethrough),
    textColor: typeof selectedFormat.textColor === "string" ? selectedFormat.textColor : "",
    fillColor: typeof selectedFormat.fillColor === "string" ? selectedFormat.fillColor : "",
    numberFormat: formatNumberFormat(
      selectedFormat.numberFormat,
      selectedFormat.customNumberFormat,
    ),
    horizontalAlign: formatAlign(selectedFormat.align),
    verticalAlign: formatVerticalAlign(selectedFormat.verticalAlign),
    wrapText: formatBoolean(selectedFormat.wrapText),
    mergeCellsEnabled:
      activeTabId !== null &&
      selectedCommentTarget !== null &&
      canMergeRange(selectedCommentTarget) &&
      !selectedRangeMerged &&
      !rangeIntersectsMergedRanges(selectedCommentTarget, activeMergedRanges, activeTabId) &&
      !mergedRangesMutation.isPending &&
      !selectedRangeBlocked,
    setFontFamily: (next) =>
      applyFormatPatch({
        fontFamily: next === "default" ? "" : next,
      }),
    setFontSize: (next) =>
      applyFormatPatch({
        fontSize: next === "11" ? "" : next,
      }),
    setBold: (next) => applyFormatPatch({ bold: next }),
    setItalic: (next) => applyFormatPatch({ italic: next }),
    setUnderline: (next) => applyFormatPatch({ underline: next }),
    setStrikethrough: (next) => applyFormatPatch({ strikethrough: next }),
    setTextColor: (color) => applyFormatPatch({ textColor: color }),
    setFillColor: (color) => applyFormatPatch({ fillColor: color }),
    setNumberFormat: (next) =>
      applyFormatPatch(numberFormatPatch(next, selectedFormat.customNumberFormat)),
    increaseDecimals: () => applyFormatPatch(adjustSheetDecimalFormat(selectedFormat, 1)),
    decreaseDecimals: () => applyFormatPatch(adjustSheetDecimalFormat(selectedFormat, -1)),
    setPercent: () =>
      applyFormatPatch(numberFormatPatch("percent", selectedFormat.customNumberFormat)),
    setCurrency: () =>
      applyFormatPatch(numberFormatPatch("currency", selectedFormat.customNumberFormat)),
    setHorizontalAlign: (next) => applyFormatPatch({ align: next }),
    setVerticalAlign: (next) =>
      applyFormatPatch({
        verticalAlign: next === "top" ? "" : next,
      }),
    setWrapText: (next) => applyFormatPatch({ wrapText: next }),
    applyBorderPreset: (preset: SheetsBorderPreset) => {
      // The legacy applyBorderPreset only supports a subset (all / outer / none).
      // Map richer preset values into the legacy set where possible.
      const legacy = preset === "all" || preset === "outer" || preset === "none" ? preset : "outer";
      applyBorderPreset(legacy);
    },
    mergeSelectedCells: mergeSelectedRange,
    canUndo: !updateMutation.isPending && cellHistory.past.at(-1)?.tabId === activeTabId,
    canRedo: !updateMutation.isPending && cellHistory.future[0]?.tabId === activeTabId,
    undo: undoSheetCellHistory,
    redo: redoSheetCellHistory,
    canCutCopyCells: selectedCommentTarget !== null && !selectedRangeBlocked,
    canPasteCells:
      selectedCell !== null &&
      !selectedRangeBlocked &&
      (cellClipboard !== null ||
        (typeof navigator !== "undefined" &&
          navigator.clipboard !== undefined &&
          typeof navigator.clipboard.readText === "function")),
    cutCells: cutSelectedCellsToInternalClipboard,
    copyCells: copySelectedCellsToInternalClipboard,
    pasteCells: pasteInternalClipboardToSelection,
    sortRangeAsc: () => sortSelectedRange("asc"),
    sortRangeDesc: () => sortSelectedRange("desc"),
    toggleFilter: toggleActiveFilterView,
    filterActive: activeFilterViewId !== null,
    insertChart: addChart,
    insertPivotTable: addPivotTable,
    insertImage: insertImageFromPicker,
    insertFunction: (kind) => {
      if (isFormulaHelperKind(kind)) {
        insertFormulaHelper(kind);
      }
    },
    availableFunctions: FORMULA_HELPERS.map((helper) => ({
      value: helper.value,
      label: helper.label,
    })),
    insertRowAbove: () => {
      if (selectedCell !== null) {
        sendStructuralOperation({ kind: "insert-rows", index: selectedCell.row, count: 1 });
      }
    },
    insertRowBelow: () => {
      if (selectedCell !== null) {
        sendStructuralOperation({ kind: "insert-rows", index: selectedCell.row + 1, count: 1 });
      }
    },
    insertColumnLeft: () => {
      if (selectedCell !== null) {
        sendStructuralOperation({ kind: "insert-columns", index: selectedCell.col, count: 1 });
      }
    },
    insertColumnRight: () => {
      if (selectedCell !== null) {
        sendStructuralOperation({ kind: "insert-columns", index: selectedCell.col + 1, count: 1 });
      }
    },
    deleteRow: () => {
      if (selectedCell !== null) {
        sendStructuralOperation({ kind: "delete-rows", index: selectedCell.row, count: 1 });
      }
    },
    deleteColumn: () => {
      if (selectedCell !== null) {
        sendStructuralOperation({ kind: "delete-columns", index: selectedCell.col, count: 1 });
      }
    },
    rowColOpsEnabled: activeTabId !== null && selectedCell !== null && syncStatus === "connected",
    onShare: () => setShareDialogOpen(true),
    onNewSpreadsheet: () => createSheetMutation.mutate(),
    onOpenSpreadsheet: onBack,
    onMakeCopy: () => copySheetMutation.mutate(),
    onMoveToTrash: () => trashSheetMutation.mutate(),
    onExportCsv: () => exportMutation.mutate("csv"),
    onExportTsv: () => exportMutation.mutate("tsv"),
    onExportXlsx: () => exportMutation.mutate("xlsx"),
    onExportOds: () => exportMutation.mutate("ods"),
    onAnalyzeRange: analyzeSelectedRange,
    onCopyLink: () => {
      void copyCurrentSpreadsheetLink(sheetId).catch(() => undefined);
    },
    onOpenKeyboardShortcuts: () => setKeyboardShortcutsOpen(true),
    openSidePanelTab: (tabId) => {
      setSidePanelTabId(tabId);
      setSidePanelOpen(true);
    },
  };

  const chromeMenus = buildSheetsMenus(chromeContext);
  const chromeRibbon = buildSheetsRibbon(chromeContext);

  /* ── Side-panel section JSX (formerly the right-rail <aside>) ────────────
     Each section's JSX is constructed here and slotted into the new
     EditorSidePanel tab content map below. The legacy <aside> wrapper is
     removed; the tab label takes the place of the section heading. */
  const sidePanelAiContent = (
    <div style={SIDE_PANEL_TAB_CONTENT_STYLE}>
      <section aria-label="Range analysis" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Sparkles size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Range analysis</strong>
        </div>
        <button
          type="button"
          className="btn sm"
          aria-label="Analyze selected range"
          disabled={selectedCommentTarget === null}
          onClick={analyzeSelectedRange}
        >
          <Icons.Sparkles size={14} />
          Analyze
        </button>
        <select
          aria-label="Formula helper"
          disabled={
            activeTabId === null || selectedCommentTarget === null || updateMutation.isPending
          }
          value=""
          onChange={(event) => {
            const helper = event.currentTarget.value;
            if (isFormulaHelperKind(helper)) {
              insertFormulaHelper(helper);
            }
          }}
          style={SIDE_PANEL_SELECT_STYLE}
        >
          <option value="">Formula</option>
          {FORMULA_HELPERS.map((helper) => (
            <option key={helper.value} value={helper.value}>
              {helper.label}
            </option>
          ))}
        </select>
      </section>
      {rangeAssist === null ? (
        <div style={COMMENTS_EMPTY_STYLE} aria-label="Sheet assists">
          Select a range and analyze it.
        </div>
      ) : (
        <div style={ASSIST_PANEL_STYLE} aria-label="Sheet assists">
          <strong>{rangeAssist.summary}</strong>
          <ul style={ASSIST_LIST_STYLE}>
            {rangeAssist.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
          {rangeAssist.formulas.length === 0 ? (
            <div style={COMMENTS_EMPTY_STYLE}>No formula suggestions for this range.</div>
          ) : (
            <div style={ASSIST_ACTIONS_STYLE}>
              {rangeAssist.formulas.map((assist) => (
                <button
                  key={assist.id}
                  type="button"
                  className="btn sm"
                  aria-label={assist.label}
                  disabled={updateMutation.isPending}
                  onClick={() => applyFormulaAssist(assist)}
                >
                  {assist.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const sidePanelChartsContent = (
    <div style={SIDE_PANEL_TAB_CONTENT_STYLE} aria-label="Sheet charts">
      <section aria-label="Insert chart" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Sheet size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Insert chart</strong>
        </div>
        <select
          aria-label="Chart type"
          disabled={selectedCell === null}
          value={chartType}
          onChange={(event) => setChartType(event.currentTarget.value as SheetChartType)}
          style={SIDE_PANEL_SELECT_STYLE}
        >
          <option value="bar">Bar chart</option>
          <option value="line">Line chart</option>
          <option value="pie">Pie chart</option>
          <option value="scatter">Scatter chart</option>
          <option value="combo">Combo chart</option>
          <option value="sparkline">Sparkline</option>
        </select>
        <button
          type="button"
          className="btn sm"
          aria-label="Add chart"
          disabled={
            activeTabId === null || selectedCommentTarget === null || chartsMutation.isPending
          }
          onClick={addChart}
        >
          <Icons.Sheet size={14} />
          Add chart
        </button>
      </section>
      {activeSheetCharts.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>No charts yet.</div>
      ) : (
        <ol aria-label="Sheet chart list" style={COMMENT_LIST_STYLE}>
          {activeSheetCharts.map((chart) => (
            <li key={chart.id} style={COMMENT_ITEM_STYLE}>
              <div style={CHART_EDIT_ROW_STYLE}>
                <input
                  aria-label={`Chart title ${chart.type} ${chart.title}`}
                  defaultValue={chart.title}
                  disabled={chartsMutation.isPending}
                  onBlur={(event) => {
                    const title = event.currentTarget.value.trim();
                    if (title.length > 0 && title !== chart.title) {
                      updateChart(chart.id, { title });
                    }
                  }}
                  style={CHART_TITLE_INPUT_STYLE}
                />
                <select
                  aria-label={`Chart type ${chart.type} ${chart.title}`}
                  value={chart.type}
                  disabled={chartsMutation.isPending}
                  onChange={(event) =>
                    updateChart(chart.id, {
                      type: event.currentTarget.value as SheetChartType,
                    })
                  }
                  style={SIDE_PANEL_SELECT_STYLE}
                >
                  <option value="bar">Bar</option>
                  <option value="line">Line</option>
                  <option value="pie">Pie</option>
                  <option value="scatter">Scatter</option>
                  <option value="combo">Combo</option>
                  <option value="sparkline">Sparkline</option>
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Use selected range for ${chart.type} chart ${chart.title}`}
                  disabled={
                    chartsMutation.isPending ||
                    selectedCommentTarget === null ||
                    activeTabId !== chart.tabId
                  }
                  onClick={() => {
                    if (selectedCommentTarget !== null) {
                      updateChartRange(chart.id, selectedCommentTarget);
                    }
                  }}
                >
                  <Icons.Grid size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Place ${chart.type} chart ${chart.title} at selected cell`}
                  disabled={
                    chartsMutation.isPending ||
                    selectedCommentTarget === null ||
                    activeTabId !== chart.tabId
                  }
                  onClick={() => {
                    if (selectedCommentTarget !== null) {
                      updateChartPlacement(chart.id, selectedCommentTarget);
                    }
                  }}
                >
                  <Icons.Pin size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete ${chart.type} chart ${chart.title}`}
                  disabled={chartsMutation.isPending}
                  onClick={() => deleteChart(chart.id)}
                >
                  <Icons.Trash size={14} />
                </button>
              </div>
              <div style={CHART_EDIT_ROW_STYLE}>
                <select
                  aria-label={`Chart label column ${chart.type} ${chart.title}`}
                  value={String(chartLabelColumn(chart))}
                  disabled={chartsMutation.isPending}
                  onChange={(event) =>
                    updateChart(chart.id, {
                      labelCol: Number(event.currentTarget.value),
                    })
                  }
                  style={SIDE_PANEL_SELECT_STYLE}
                >
                  {chartRangeColumns(chart).map((column) => (
                    <option key={column} value={column}>
                      Label {columnLetter(column)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Chart value column ${chart.type} ${chart.title}`}
                  value={String(chartValueColumn(chart))}
                  disabled={chartsMutation.isPending}
                  onChange={(event) =>
                    updateChart(chart.id, {
                      valueCol: Number(event.currentTarget.value),
                    })
                  }
                  style={SIDE_PANEL_SELECT_STYLE}
                >
                  {chartRangeColumns(chart).map((column) => (
                    <option key={column} value={column}>
                      Value {columnLetter(column)}
                    </option>
                  ))}
                </select>
              </div>
              <SheetChartPreview
                chart={chart}
                grid={grid}
                displayGrid={displayGrid}
                showDataTable
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  const sidePanelPivotsContent = (
    <div style={SIDE_PANEL_TAB_CONTENT_STYLE} aria-label="Pivot tables">
      <div style={COMMENTS_EMPTY_STYLE}>
        {selectedCommentTarget === null
          ? "Select at least two columns"
          : `Selected ${rangeLabel(selectedCommentTarget)}`}
      </div>
      <button
        type="button"
        className="btn sm"
        aria-label="Create pivot table"
        disabled={
          activeTabId === null ||
          selectedCommentTarget === null ||
          !canCreatePivotTableFromRange(selectedCommentTarget) ||
          pivotTablesMutation.isPending
        }
        onClick={addPivotTable}
      >
        <Icons.Grid size={14} />
        Pivot
      </button>
      {activePivotTables.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>No pivot tables.</div>
      ) : (
        <ol aria-label="Pivot table list" style={COMMENT_LIST_STYLE}>
          {activePivotTables.map((pivot) => (
            <li key={pivot.id} style={COMMENT_ITEM_STYLE}>
              {(() => {
                const slicer = pivotSlicer(pivot);
                return (
                  <>
                    <div style={CHART_EDIT_ROW_STYLE}>
                      <input
                        aria-label={`Pivot title ${pivot.title}`}
                        defaultValue={pivot.title}
                        disabled={pivotTablesMutation.isPending}
                        onBlur={(event) => {
                          const title = event.currentTarget.value.trim();
                          if (title.length > 0 && title !== pivot.title) {
                            updatePivotTable(pivot.id, { title });
                          }
                        }}
                        style={CHART_TITLE_INPUT_STYLE}
                      />
                      <select
                        aria-label={`Pivot aggregation ${pivot.title}`}
                        value={pivot.aggregation}
                        disabled={pivotTablesMutation.isPending}
                        onChange={(event) =>
                          updatePivotTable(pivot.id, {
                            aggregation: event.currentTarget.value as SheetPivotAggregation,
                          })
                        }
                        style={SIDE_PANEL_SELECT_STYLE}
                      >
                        <option value="sum">Sum</option>
                        <option value="count">Count</option>
                      </select>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Use selected range for pivot table ${pivot.title}`}
                        disabled={
                          pivotTablesMutation.isPending ||
                          selectedCommentTarget === null ||
                          !canCreatePivotTableFromRange(selectedCommentTarget) ||
                          activeTabId !== pivot.tabId
                        }
                        onClick={() => {
                          if (selectedCommentTarget !== null) {
                            updatePivotTableRange(pivot.id, selectedCommentTarget);
                          }
                        }}
                      >
                        <Icons.Grid size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Delete pivot table ${pivot.title}`}
                        disabled={pivotTablesMutation.isPending}
                        onClick={() => deletePivotTable(pivot.id)}
                      >
                        <Icons.Trash size={14} />
                      </button>
                    </div>
                    <div style={CHART_EDIT_ROW_STYLE}>
                      <select
                        aria-label={`Pivot slicer column ${pivot.title}`}
                        value={String(slicer.column)}
                        disabled={pivotTablesMutation.isPending}
                        onChange={(event) =>
                          updatePivotTable(pivot.id, {
                            slicer: {
                              ...slicer,
                              column: Number(event.currentTarget.value),
                            },
                          })
                        }
                        style={SIDE_PANEL_SELECT_STYLE}
                      >
                        {pivotColumns(pivot).map((column) => (
                          <option key={column} value={column}>
                            {columnLetter(column)}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`Pivot slicer value ${pivot.title}`}
                        defaultValue={slicer.value}
                        disabled={pivotTablesMutation.isPending}
                        onBlur={(event) => {
                          const value = event.currentTarget.value.trim();
                          if (value !== slicer.value) {
                            updatePivotTable(pivot.id, {
                              slicer: { ...slicer, value },
                            });
                          }
                        }}
                        placeholder="Filter contains"
                        style={CHART_TITLE_INPUT_STYLE}
                      />
                    </div>
                    <SheetPivotTablePreview pivot={pivot} grid={displayGrid} />
                  </>
                );
              })()}
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  const sidePanelNamesContent = (
    <div style={SIDE_PANEL_TAB_CONTENT_STYLE} aria-label="Named ranges">
      <div style={COMMENTS_EMPTY_STYLE}>
        {selectedCommentTarget === null
          ? "Select a cell or range"
          : `Selected ${rangeLabel(selectedCommentTarget)}`}
      </div>
      <button
        type="button"
        className="btn sm"
        aria-label="Name selected range"
        disabled={
          activeTabId === null || selectedCommentTarget === null || namedRangesMutation.isPending
        }
        onClick={addNamedRange}
      >
        <Icons.Hash size={14} />
        Name range
      </button>
      {activeNamedRanges.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>No named ranges.</div>
      ) : (
        <ol aria-label="Named range list" style={COMMENT_LIST_STYLE}>
          {activeNamedRanges.map((range) => (
            <li key={range.id} style={COMMENT_ITEM_STYLE}>
              <div style={CHART_EDIT_ROW_STYLE}>
                <input
                  aria-label={`Named range ${range.name}`}
                  defaultValue={range.name}
                  disabled={namedRangesMutation.isPending}
                  onBlur={(event) => {
                    const name = event.currentTarget.value.trim();
                    if (name.length > 0 && name !== range.name) {
                      updateNamedRange(range.id, { name });
                    }
                  }}
                  style={CHART_TITLE_INPUT_STYLE}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Use selected range for named range ${range.name}`}
                  disabled={
                    namedRangesMutation.isPending ||
                    selectedCommentTarget === null ||
                    activeTabId !== range.tabId
                  }
                  onClick={() => {
                    if (selectedCommentTarget !== null) {
                      updateNamedRangeSelection(range.id, selectedCommentTarget);
                    }
                  }}
                >
                  <Icons.Grid size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete named range ${range.name}`}
                  disabled={namedRangesMutation.isPending}
                  onClick={() => deleteNamedRange(range.id)}
                >
                  <Icons.Trash size={14} />
                </button>
              </div>
              <div style={COMMENT_META_STYLE}>{namedRangeLabel(range)}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  const sidePanelCellsContent = (
    <div style={SIDE_PANEL_TAB_CONTENT_STYLE}>
      <section aria-label="Quick formatting" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Sheet size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Quick formatting</strong>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {FILL_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              className="btn sm"
              aria-label={`Fill ${color.label.toLowerCase()}`}
              aria-pressed={selectedFormat.fillColor === color.value}
              disabled={selectedCell === null || selectedRangeBlocked}
              onClick={() =>
                applyFormatPatch({
                  fillColor: selectedFormat.fillColor === color.value ? "" : color.value,
                })
              }
              style={{ background: color.value, minWidth: 28, height: 28 }}
            >
              {color.label[0] ?? ""}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {TEXT_COLORS.map((color) => (
            <button
              key={color.label}
              type="button"
              className="btn sm"
              aria-label={`Text ${color.label.toLowerCase()}`}
              aria-pressed={
                color.value === ""
                  ? selectedFormat.textColor === undefined
                  : selectedFormat.textColor === color.value
              }
              disabled={selectedCell === null || selectedRangeBlocked}
              onClick={() =>
                applyFormatPatch({
                  textColor: color.value,
                })
              }
              style={{ color: color.value || "var(--text)", minWidth: 28, height: 28 }}
            >
              A
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {[
            { label: "Border all", preset: "all" as BorderPreset },
            { label: "Border outer", preset: "outer" as BorderPreset },
            { label: "Border none", preset: "none" as BorderPreset },
          ].map((item) => (
            <button
              key={item.preset}
              type="button"
              className="btn sm"
              aria-label={item.label}
              disabled={selectedCell === null || selectedRangeBlocked}
              onClick={() => applyBorderPreset(item.preset)}
            >
              {item.label.replace("Border ", "")}
            </button>
          ))}
        </div>
      </section>
      <section aria-label="Cell link" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Link size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Link</strong>
        </div>
        <input
          aria-label="Cell link"
          inputMode="url"
          disabled={selectedCell === null || selectedRangeBlocked}
          placeholder="https://example.com"
          value={formatCellLinkUrl(selectedFormat.linkUrl)}
          onChange={(event) =>
            applyFormatPatch({
              linkUrl: event.currentTarget.value,
            })
          }
          style={SIDE_PANEL_SELECT_STYLE}
        />
      </section>
      <section aria-label="Number format" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Sheet size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Number format</strong>
        </div>
        <select
          aria-label="Number format"
          disabled={selectedCell === null || selectedRangeBlocked}
          value={formatNumberFormat(selectedFormat.numberFormat, selectedFormat.customNumberFormat)}
          onChange={(event) =>
            applyFormatPatch({
              ...numberFormatPatch(
                event.currentTarget.value as NumberFormat,
                selectedFormat.customNumberFormat,
              ),
            })
          }
          style={SIDE_PANEL_SELECT_STYLE}
        >
          <option value="plain">Plain</option>
          <option value="number">Number</option>
          <option value="currency">Currency</option>
          <option value="percent">Percent</option>
          <option value="date">Date</option>
          <option value="custom">Custom</option>
        </select>
        {formatNumberFormat(selectedFormat.numberFormat, selectedFormat.customNumberFormat) ===
        "custom" ? (
          <input
            aria-label="Custom number format"
            list="sheet-custom-number-formats"
            disabled={selectedCell === null || selectedRangeBlocked}
            value={formatCustomNumberFormat(selectedFormat.customNumberFormat)}
            onChange={(event) =>
              applyFormatPatch({
                numberFormat: "custom",
                customNumberFormat: event.currentTarget.value,
              })
            }
            style={SIDE_PANEL_SELECT_STYLE}
          />
        ) : null}
        <datalist id="sheet-custom-number-formats">
          {CUSTOM_NUMBER_FORMATS.map((format) => (
            <option key={format} value={format} />
          ))}
        </datalist>
      </section>
      <section aria-label="Data validation" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Check size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Data validation</strong>
        </div>
        <select
          aria-label="Data validation"
          disabled={selectedCell === null || selectedRangeBlocked}
          value={formatDataValidationKind(selectedFormat.dataValidation)}
          onChange={(event) =>
            applyFormatPatch({
              dataValidation: dataValidationPatch(
                event.currentTarget.value as DataValidationKind,
                selectedFormat.dataValidation,
              ),
            })
          }
          style={SIDE_PANEL_SELECT_STYLE}
        >
          <option value="none">No validation</option>
          <option value="number">Number only</option>
          <option value="email">Email only</option>
          <option value="url">URL only</option>
          <option value="date">Date</option>
          <option value="list">Dropdown list</option>
          <option value="customFormula">Custom formula</option>
        </select>
        {formatDataValidationKind(selectedFormat.dataValidation) === "date" ? (
          <select
            aria-label="Validation date format"
            disabled={selectedCell === null || selectedRangeBlocked}
            value={dataValidationDateLocale(selectedFormat.dataValidation)}
            onChange={(event) =>
              applyFormatPatch({
                dataValidation: dataValidationWithDateLocale(
                  selectedFormat.dataValidation,
                  event.currentTarget.value as DataValidationDateLocale,
                ),
              })
            }
            style={SIDE_PANEL_SELECT_STYLE}
          >
            <option value="iso">yyyy-mm-dd</option>
            <option value="en-US">m/d/yyyy</option>
            <option value="en-GB">d/m/yyyy</option>
            <option value="de-DE">d.m.yyyy</option>
          </select>
        ) : null}
        {formatDataValidationKind(selectedFormat.dataValidation) === "list" ? (
          <>
            {activeNamedRanges.length === 0 ? null : (
              <select
                aria-label="Validation list source"
                disabled={selectedCell === null || selectedRangeBlocked}
                value={dataValidationListSource(selectedFormat.dataValidation)}
                onChange={(event) =>
                  applyFormatPatch({
                    dataValidation: dataValidationListSourcePatch(
                      event.currentTarget.value,
                      selectedFormat.dataValidation,
                    ),
                  })
                }
                style={SIDE_PANEL_SELECT_STYLE}
              >
                <option value="manual">Manual choices</option>
                {activeNamedRanges.map((range) => (
                  <option key={range.id} value={range.id}>
                    {range.name}
                  </option>
                ))}
              </select>
            )}
            {dataValidationNamedRangeId(selectedFormat.dataValidation) === null ? (
              <input
                aria-label="Validation choices"
                disabled={selectedCell === null || selectedRangeBlocked}
                value={dataValidationChoicesText(selectedFormat.dataValidation)}
                onChange={(event) =>
                  applyFormatPatch({
                    dataValidation: {
                      type: "list",
                      choices: parseDataValidationChoices(event.currentTarget.value),
                      ...dataValidationModePatch(
                        formatDataValidationMode(selectedFormat.dataValidation),
                      ),
                    },
                  })
                }
                style={SIDE_PANEL_SELECT_STYLE}
              />
            ) : null}
          </>
        ) : null}
        {formatDataValidationKind(selectedFormat.dataValidation) === "customFormula" ? (
          <input
            aria-label="Validation formula"
            disabled={selectedCell === null || selectedRangeBlocked}
            value={dataValidationFormulaText(selectedFormat.dataValidation)}
            onChange={(event) =>
              applyFormatPatch({
                dataValidation: dataValidationWithFormula(
                  selectedFormat.dataValidation,
                  event.currentTarget.value,
                ),
              })
            }
            style={SIDE_PANEL_SELECT_STYLE}
          />
        ) : null}
        {formatDataValidationKind(selectedFormat.dataValidation) === "none" ? null : (
          <select
            aria-label="Validation mode"
            disabled={selectedCell === null || selectedRangeBlocked}
            value={formatDataValidationMode(selectedFormat.dataValidation)}
            onChange={(event) =>
              applyFormatPatch({
                dataValidation: dataValidationWithMode(
                  selectedFormat.dataValidation,
                  event.currentTarget.value as DataValidationMode,
                ),
              })
            }
            style={SIDE_PANEL_SELECT_STYLE}
          >
            <option value="warn">Warn only</option>
            <option value="reject">Reject invalid</option>
          </select>
        )}
      </section>
      <section aria-label="Conditional formatting" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Sparkles size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Conditional formatting</strong>
        </div>
        <select
          aria-label="Conditional format"
          disabled={selectedCell === null || selectedRangeBlocked}
          value={formatConditionalFormatKind(selectedFormat.conditionalFormat)}
          onChange={(event) =>
            applyFormatPatch({
              conditionalFormat: conditionalFormatForKind(
                event.currentTarget.value as ConditionalFormatKind,
              ),
            })
          }
          style={SIDE_PANEL_SELECT_STYLE}
        >
          <option value="none">No conditional</option>
          <option value="greaterThan100">&gt; 100 green</option>
          <option value="lessThanZero">&lt; 0 red</option>
          <option value="textContains">Text contains</option>
          <option value="customFormula">Custom formula</option>
        </select>
        {formatConditionalFormatKind(selectedFormat.conditionalFormat) === "greaterThan100" ||
        formatConditionalFormatKind(selectedFormat.conditionalFormat) === "lessThanZero" ? (
          <input
            aria-label="Conditional threshold"
            disabled={selectedCell === null || selectedRangeBlocked}
            type="number"
            value={conditionalFormatThresholdValue(selectedFormat.conditionalFormat)}
            onChange={(event) =>
              applyFormatPatch({
                conditionalFormat: conditionalFormatWithThreshold(
                  selectedFormat.conditionalFormat,
                  event.currentTarget.value,
                ),
              })
            }
            style={SIDE_PANEL_SELECT_STYLE}
          />
        ) : null}
        {formatConditionalFormatKind(selectedFormat.conditionalFormat) === "textContains" ? (
          <input
            aria-label="Conditional text contains"
            disabled={selectedCell === null || selectedRangeBlocked}
            value={conditionalFormatTextContainsText(selectedFormat.conditionalFormat)}
            onChange={(event) =>
              applyFormatPatch({
                conditionalFormat: conditionalFormatWithTextContains(
                  selectedFormat.conditionalFormat,
                  event.currentTarget.value,
                ),
              })
            }
            style={SIDE_PANEL_SELECT_STYLE}
          />
        ) : null}
        {formatConditionalFormatKind(selectedFormat.conditionalFormat) === "customFormula" ? (
          <input
            aria-label="Conditional formula"
            disabled={selectedCell === null || selectedRangeBlocked}
            value={conditionalFormatFormulaText(selectedFormat.conditionalFormat)}
            onChange={(event) =>
              applyFormatPatch({
                conditionalFormat: conditionalFormatWithFormula(
                  selectedFormat.conditionalFormat,
                  event.currentTarget.value,
                ),
              })
            }
            style={SIDE_PANEL_SELECT_STYLE}
          />
        ) : null}
      </section>
      <section aria-label="Merged cells" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Grid size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Merged cells</strong>
        </div>
        <div style={COMMENTS_EMPTY_STYLE}>
          {selectedCommentTarget === null
            ? "Select a range"
            : `Selected ${rangeLabel(selectedCommentTarget)}`}
        </div>
        <button
          type="button"
          className="btn sm"
          aria-label="Merge selected cells"
          disabled={
            activeTabId === null ||
            selectedCommentTarget === null ||
            !canMergeRange(selectedCommentTarget) ||
            selectedRangeMerged ||
            rangeIntersectsMergedRanges(selectedCommentTarget, activeMergedRanges, activeTabId) ||
            mergedRangesMutation.isPending
          }
          onClick={mergeSelectedRange}
        >
          <Icons.Grid size={14} />
          Merge cells
        </button>
        {activeMergedRanges.length === 0 ? (
          <div style={COMMENTS_EMPTY_STYLE}>No merged cells.</div>
        ) : (
          <ol aria-label="Merged cell list" style={COMMENT_LIST_STYLE}>
            {activeMergedRanges.map((range) => (
              <li key={range.id} style={COMMENT_ITEM_STYLE}>
                <div style={CHART_EDIT_ROW_STYLE}>
                  <strong>{range.label}</strong>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Select merged range ${range.label}`}
                    disabled={mergedRangesMutation.isPending}
                    onClick={() => selectMergedRange(range)}
                  >
                    <Icons.Grid size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Unmerge range ${range.label}`}
                    disabled={mergedRangesMutation.isPending}
                    onClick={() => unmergeRange(range.id)}
                  >
                    <Icons.Trash size={14} />
                  </button>
                </div>
                <div style={COMMENT_META_STYLE}>{mergedRangeLabel(range)}</div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Frozen panes" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Pin size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Frozen panes</strong>
        </div>
        <div style={COMMENTS_EMPTY_STYLE}>
          Rows {activeFrozenPane.frozenRows} · Columns {activeFrozenPane.frozenCols}
        </div>
        <div style={SIDE_TABLE_ACTIONS_STYLE}>
          <button
            type="button"
            className="btn sm"
            aria-label="Freeze rows to selection"
            disabled={
              activeTabId === null ||
              selectedCommentTarget === null ||
              frozenPanesMutation.isPending
            }
            onClick={freezeRowsToSelection}
          >
            <Icons.Pin size={14} />
            Freeze rows
          </button>
          <button
            type="button"
            className="btn sm"
            aria-label="Freeze columns to selection"
            disabled={
              activeTabId === null ||
              selectedCommentTarget === null ||
              frozenPanesMutation.isPending
            }
            onClick={freezeColumnsToSelection}
          >
            <Icons.Pin size={14} />
            Freeze columns
          </button>
          <button
            type="button"
            className="btn sm"
            aria-label="Clear frozen panes"
            disabled={
              activeTabId === null ||
              (activeFrozenPane.frozenRows === 0 && activeFrozenPane.frozenCols === 0) ||
              frozenPanesMutation.isPending
            }
            onClick={clearFrozenPanes}
          >
            <Icons.Trash size={14} />
          </button>
        </div>
      </section>
      <section aria-label="Data validation rules" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Check size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Validation rules</strong>
        </div>
        {validationRules.length === 0 ? (
          <div style={COMMENTS_EMPTY_STYLE}>No validation rules.</div>
        ) : (
          <table aria-label="Data validation rule table" style={SIDE_TABLE_STYLE}>
            <thead>
              <tr>
                <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                  Range
                </th>
                <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                  Rule
                </th>
                <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                  Mode
                </th>
                <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {validationRules.map((rule) => (
                <tr key={rule.id}>
                  <td style={SIDE_TABLE_CELL_STYLE}>{rule.label}</td>
                  <td style={SIDE_TABLE_CELL_STYLE}>
                    {dataValidationRuleLabel(rule.validation, validationChoiceContext)}
                  </td>
                  <td style={SIDE_TABLE_CELL_STYLE}>
                    <select
                      aria-label={`Validation rule mode ${rule.label}`}
                      disabled={updateMutation.isPending}
                      value={formatDataValidationMode(rule.validation)}
                      onChange={(event) =>
                        updateDataValidationRuleMode(
                          rule,
                          event.currentTarget.value as DataValidationMode,
                        )
                      }
                      style={SIDE_TABLE_SELECT_STYLE}
                    >
                      <option value="warn">Warn only</option>
                      <option value="reject">Reject invalid</option>
                    </select>
                  </td>
                  <td style={SIDE_TABLE_CELL_STYLE}>
                    <div style={SIDE_TABLE_ACTIONS_STYLE}>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Select validation rule ${rule.label}`}
                        onClick={() => selectDataValidationRule(rule)}
                      >
                        Select
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Clear validation rule ${rule.label}`}
                        disabled={updateMutation.isPending}
                        onClick={() => clearDataValidationRule(rule)}
                      >
                        <Icons.Trash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Conditional formatting rules" style={SIDE_SECTION_STYLE}>
        <div style={SIDE_SECTION_HEADER_STYLE}>
          <Icons.Sparkles size={16} />
          <strong style={{ fontSize: "var(--text-sm)" }}>Conditional rules</strong>
        </div>
        {conditionalFormatRules.length === 0 ? (
          <div style={COMMENTS_EMPTY_STYLE}>No conditional rules.</div>
        ) : (
          <table aria-label="Conditional formatting rule table" style={SIDE_TABLE_STYLE}>
            <thead>
              <tr>
                <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                  Range
                </th>
                <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                  Rule
                </th>
                <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {conditionalFormatRules.map((rule) => (
                <tr key={rule.id}>
                  <td style={SIDE_TABLE_CELL_STYLE}>{rule.label}</td>
                  <td style={SIDE_TABLE_CELL_STYLE}>
                    {conditionalFormatRuleLabel(rule.conditionalFormat)}
                  </td>
                  <td style={SIDE_TABLE_CELL_STYLE}>
                    <div style={SIDE_TABLE_ACTIONS_STYLE}>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Select conditional rule ${rule.label}`}
                        onClick={() => selectConditionalFormatRule(rule)}
                      >
                        Select
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label={`Clear conditional rule ${rule.label}`}
                        disabled={updateMutation.isPending}
                        onClick={() => clearConditionalFormatRule(rule)}
                      >
                        <Icons.Trash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );

  const sidePanelFiltersContent = (
    <div style={SIDE_PANEL_TAB_CONTENT_STYLE} aria-label="Saved filter views">
      <div style={COMMENTS_EMPTY_STYLE}>
        {selectedCommentTarget === null
          ? "Select a cell or range"
          : `Selected ${rangeLabel(selectedCommentTarget)}`}
      </div>
      {activeDisplayFilterView === null ? null : (
        <button
          type="button"
          className="btn sm"
          aria-label="Clear filter preview"
          onClick={() => setActiveFilterViewId(null)}
        >
          Clear preview
        </button>
      )}
      <div style={ASSIST_ACTIONS_STYLE}>
        <button
          type="button"
          className="btn sm"
          aria-label="Save A-Z filter view"
          disabled={
            activeTabId === null || selectedCommentTarget === null || filterViewsMutation.isPending
          }
          onClick={() => addFilterView("asc")}
        >
          A-Z
        </button>
        <button
          type="button"
          className="btn sm"
          aria-label="Save Z-A filter view"
          disabled={
            activeTabId === null || selectedCommentTarget === null || filterViewsMutation.isPending
          }
          onClick={() => addFilterView("desc")}
        >
          Z-A
        </button>
      </div>
      {activeFilterViews.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>No filter views.</div>
      ) : (
        <ol aria-label="Saved filter view list" style={COMMENT_LIST_STYLE}>
          {activeFilterViews.map((view) => (
            <li key={view.id} style={COMMENT_ITEM_STYLE}>
              <div style={FILTER_VIEW_ACTION_ROW_STYLE}>
                <input
                  aria-label={`Filter view ${view.name}`}
                  defaultValue={view.name}
                  disabled={filterViewsMutation.isPending}
                  onBlur={(event) => {
                    const name = event.currentTarget.value.trim();
                    if (name.length > 0 && name !== view.name) {
                      updateFilterView(view.id, { name });
                    }
                  }}
                  style={CHART_TITLE_INPUT_STYLE}
                />
                <select
                  aria-label={`Filter view sort ${view.name}`}
                  value={view.sortDirection}
                  disabled={filterViewsMutation.isPending}
                  onChange={(event) =>
                    updateFilterView(view.id, {
                      sortDirection: event.currentTarget.value as SortDirection,
                    })
                  }
                  style={SIDE_PANEL_SELECT_STYLE}
                >
                  <option value="asc">A-Z</option>
                  <option value="desc">Z-A</option>
                </select>
                <select
                  aria-label={`Filter view sort column ${view.name}`}
                  value={String(filterViewSortColumn(view))}
                  disabled={filterViewsMutation.isPending}
                  onChange={(event) =>
                    updateFilterViewPrimarySortColumn(view, Number(event.currentTarget.value))
                  }
                  style={SIDE_PANEL_SELECT_STYLE}
                >
                  {filterViewColumns(view).map((column) => (
                    <option key={column} value={column}>
                      {columnLetter(column)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Filter view secondary sort column ${view.name}`}
                  value={String(filterViewSecondarySortColumn(view) ?? "")}
                  disabled={filterViewsMutation.isPending}
                  onChange={(event) =>
                    updateFilterViewSecondarySortColumn(view, event.currentTarget.value)
                  }
                  style={SIDE_PANEL_SELECT_STYLE}
                >
                  <option value="">Then none</option>
                  {filterViewColumns(view).map((column) => (
                    <option key={column} value={column}>
                      Then {columnLetter(column)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  aria-pressed={activeDisplayFilterView?.id === view.id}
                  aria-label={`Preview filter view ${view.name}`}
                  disabled={filterViewsMutation.isPending}
                  onClick={() => toggleDisplayFilterView(view)}
                >
                  <Icons.Eye size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Apply filter view ${view.name}`}
                  disabled={filterViewsMutation.isPending || updateMutation.isPending}
                  onClick={() => applyFilterView(view)}
                >
                  <Icons.Check size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Use selected range for filter view ${view.name}`}
                  disabled={
                    filterViewsMutation.isPending ||
                    selectedCommentTarget === null ||
                    activeTabId !== view.tabId
                  }
                  onClick={() => {
                    if (selectedCommentTarget !== null) {
                      updateFilterViewSelection(view.id, selectedCommentTarget);
                    }
                  }}
                >
                  <Icons.Grid size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete filter view ${view.name}`}
                  disabled={filterViewsMutation.isPending}
                  onClick={() => deleteFilterView(view.id)}
                >
                  <Icons.Trash size={14} />
                </button>
              </div>
              <div style={FILTER_PREDICATE_LIST_STYLE}>
                {filterViewEditablePredicates(view).map((predicate, predicateIndex) => (
                  <div
                    key={`${view.id}-${String(predicateIndex)}`}
                    style={FILTER_PREDICATE_ROW_STYLE}
                  >
                    <label style={FILTER_PREDICATE_LABEL_STYLE}>
                      Column
                      <select
                        aria-label={`Filter view predicate ${String(
                          predicateIndex + 1,
                        )} column ${view.name}`}
                        value={String(predicate.column)}
                        disabled={filterViewsMutation.isPending}
                        onChange={(event) =>
                          updateFilterViewPredicateAt(view, predicateIndex, {
                            column: Number(event.currentTarget.value),
                          })
                        }
                        style={SIDE_PANEL_SELECT_STYLE}
                      >
                        {filterViewColumns(view).map((column) => (
                          <option key={column} value={column}>
                            {columnLetter(column)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={FILTER_PREDICATE_LABEL_STYLE}>
                      Operator
                      <select
                        aria-label={`Filter view predicate ${String(
                          predicateIndex + 1,
                        )} operator ${view.name}`}
                        value={predicate.operator}
                        disabled={filterViewsMutation.isPending}
                        onChange={(event) =>
                          updateFilterViewPredicateAt(view, predicateIndex, {
                            operator: event.currentTarget.value as SheetFilterPredicateOperator,
                          })
                        }
                        style={SIDE_PANEL_SELECT_STYLE}
                      >
                        <option value="contains">Contains</option>
                        <option value="equals">Equals</option>
                        <option value="greaterThan">Greater than</option>
                        <option value="notEmpty">Not empty</option>
                      </select>
                    </label>
                    <label style={FILTER_PREDICATE_LABEL_STYLE}>
                      Value
                      <input
                        key={`${view.id}-${String(predicateIndex)}-${predicate.operator}`}
                        aria-label={`Filter view predicate ${String(
                          predicateIndex + 1,
                        )} ${filterPredicateOperatorLabel(predicate.operator)} ${view.name}`}
                        defaultValue={predicate.value}
                        disabled={
                          filterViewsMutation.isPending ||
                          !filterPredicateNeedsValue(predicate.operator)
                        }
                        onBlur={(event) =>
                          updateFilterViewPredicateAt(view, predicateIndex, {
                            value: event.currentTarget.value,
                          })
                        }
                        style={CHART_TITLE_INPUT_STYLE}
                      />
                    </label>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove filter view predicate ${String(
                        predicateIndex + 1,
                      )} ${view.name}`}
                      disabled={
                        filterViewsMutation.isPending ||
                        filterViewEditablePredicates(view).length <= 1
                      }
                      onClick={() => deleteFilterViewPredicate(view, predicateIndex)}
                    >
                      <Icons.Trash size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Add filter view predicate ${view.name}`}
                  disabled={filterViewsMutation.isPending}
                  onClick={() => addFilterViewPredicate(view)}
                >
                  <Icons.Filter size={14} />
                  Add criterion
                </button>
              </div>
              <div style={COMMENT_META_STYLE}>
                {filterViewLabel(view)} · Sort {filterViewSortLabel(view)}
                {filterViewPredicateSummary(view)}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  const sidePanelPermissionsContent = (
    <div style={SIDE_PANEL_TAB_CONTENT_STYLE} aria-label="Protected ranges">
      <div style={COMMENTS_EMPTY_STYLE}>
        {selectedCommentTarget === null
          ? "Select a cell or range"
          : `Selected ${rangeLabel(selectedCommentTarget)}`}
      </div>
      <button
        type="button"
        className="btn sm"
        aria-label="Protect selected range"
        disabled={
          activeTabId === null ||
          selectedCommentTarget === null ||
          selectedRangeProtected ||
          protectedRangesMutation.isPending
        }
        onClick={addProtectedRange}
      >
        <Icons.Lock size={14} />
        Protect range
      </button>
      {activeProtectedRanges.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>No protected ranges.</div>
      ) : (
        <table aria-label="Protected range table" style={SIDE_TABLE_STYLE}>
          <thead>
            <tr>
              <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                Range
              </th>
              <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                Tab
              </th>
              <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                Cells
              </th>
              <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                Mode
              </th>
              <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {activeProtectedRanges.map((range) => (
              <tr key={range.id}>
                <td style={SIDE_TABLE_CELL_STYLE}>{range.label}</td>
                <td style={SIDE_TABLE_CELL_STYLE}>
                  {tabNameById.get(range.tabId) ?? "Unknown tab"}
                </td>
                <td style={SIDE_TABLE_CELL_STYLE}>{protectedRangeCellCount(range)}</td>
                <td style={SIDE_TABLE_CELL_STYLE}>
                  <select
                    aria-label={`Protected range mode ${range.label}`}
                    disabled={protectedRangesMutation.isPending}
                    value={protectedRangeMode(range)}
                    onChange={(event) =>
                      updateProtectedRangeMode(
                        range.id,
                        event.currentTarget.value as SheetProtectedRangeMode,
                      )
                    }
                    style={SIDE_TABLE_SELECT_STYLE}
                  >
                    <option value="block">Block edits</option>
                    <option value="warn">Warn only</option>
                  </select>
                </td>
                <td style={SIDE_TABLE_CELL_STYLE}>
                  <div style={SIDE_TABLE_ACTIONS_STYLE}>
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Select protected range ${range.label}`}
                      onClick={() => selectProtectedRange(range)}
                    >
                      Select
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Remove protected range ${range.label}`}
                      disabled={protectedRangesMutation.isPending}
                      onClick={() => deleteProtectedRange(range.id)}
                    >
                      <Icons.Trash size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  const sidePanelVersionsContent = (
    <OfficeVersionHistoryPanel
      ariaLabel="Spreadsheet version history"
      versions={versionsQuery.data ?? []}
      loading={versionsQuery.isLoading}
      loadError={versionsQuery.isError}
      restoreError={restoreVersionMutation.isError}
      restoringVersionId={
        restoreVersionMutation.isPending ? (restoreVersionMutation.variables ?? null) : null
      }
      emptyLabel="No saved spreadsheet snapshots"
      detailLabel={sheetVersionDetailLabel}
      onRestore={(version) => restoreVersionMutation.mutate(version.id)}
    />
  );

  const sidePanelCommentsContent = (
    <div
      id="native-spreadsheet-comments-panel"
      aria-label="Sheet comments"
      tabIndex={-1}
      style={SIDE_PANEL_TAB_CONTENT_STYLE}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <Icons.Comment size={16} />
        <strong style={{ fontSize: "var(--text-sm)" }}>Comments</strong>
        <select
          aria-label="Sheet comment status"
          value={commentStatusFilter}
          onChange={(event) =>
            setCommentStatusFilter(event.currentTarget.value as SheetsCommentStatus)
          }
          style={{ ...SIDE_PANEL_SELECT_STYLE, marginLeft: "auto" }}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </div>
      <div style={{ color: "var(--text-3)", fontSize: "var(--text-caption)", marginBottom: 6 }}>
        {selectedCommentLabel}
      </div>
      <textarea
        aria-label="Sheet comment"
        disabled={selectedCommentTarget === null || activeTabId === null}
        value={commentDraft}
        onChange={(event) => setCommentDraft(event.currentTarget.value)}
        rows={3}
        style={{
          width: "100%",
          resize: "vertical",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          font: "inherit",
          padding: 8,
        }}
      />
      <button
        type="button"
        className="btn sm primary"
        aria-label="Add comment"
        disabled={commentDraft.trim().length === 0 || selectedCommentTarget === null}
        onClick={() => void addComment()}
        style={{ marginTop: 8 }}
      >
        <Icons.Comment size={14} />
        Add comment
      </button>
      {commentsStatus === "loading" ? (
        <div style={COMMENTS_EMPTY_STYLE}>Loading comments...</div>
      ) : commentsStatus === "error" ? (
        <div style={COMMENTS_EMPTY_STYLE}>Could not load comments.</div>
      ) : activeSheetCommentThreads.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>{emptyCommentsLabel(commentStatusFilter)}</div>
      ) : (
        <ol aria-label="Sheet comment list" style={COMMENT_LIST_STYLE}>
          {activeSheetCommentThreads.map(({ comment, replies }) => (
            <li key={comment.id} style={COMMENT_ITEM_STYLE}>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  const range = rangeFromSheetComment(comment);
                  if (range === null) {
                    return;
                  }
                  setSelectedCell({
                    row: normalizeRange(range).top,
                    col: normalizeRange(range).left,
                  });
                  setSelectedRange(range);
                  revealCell({
                    row: normalizeRange(range).top,
                    col: normalizeRange(range).left,
                  });
                }}
              >
                {sheetCommentLabel(comment)}
              </button>
              <div style={COMMENT_META_STYLE}>{commentAuthorLabel(comment)}</div>
              {commentEditDrafts[comment.id] === undefined ? (
                <p style={{ margin: "6px 0 0" }}>{comment.body}</p>
              ) : (
                <div style={COMMENT_ACTIONS_STYLE}>
                  <textarea
                    aria-label={`Edit comment ${comment.body}`}
                    value={commentEditDrafts[comment.id] ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setCommentEditDrafts((current) => ({
                        ...current,
                        [comment.id]: value,
                      }));
                    }}
                    rows={2}
                    style={COMMENT_REPLY_STYLE}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Save comment ${comment.body}`}
                    disabled={(commentEditDrafts[comment.id] ?? "").trim().length === 0}
                    onClick={() => void saveCommentEdit(comment.id)}
                  >
                    <Icons.Check size={14} />
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Cancel edit ${comment.body}`}
                    onClick={() => cancelCommentEdit(comment.id)}
                  >
                    <Icons.X size={14} />
                    Cancel
                  </button>
                </div>
              )}
              {replies.length > 0 ? (
                <ol aria-label={`Replies to ${comment.body}`} style={REPLY_LIST_STYLE}>
                  {replies.map((reply) => (
                    <li key={reply.id} style={REPLY_ITEM_STYLE}>
                      <div style={COMMENT_META_STYLE}>{commentAuthorLabel(reply)}</div>
                      {commentEditDrafts[reply.id] === undefined ? (
                        <p style={{ margin: "4px 0 0" }}>{reply.body}</p>
                      ) : (
                        <div style={COMMENT_ACTIONS_STYLE}>
                          <textarea
                            aria-label={`Edit comment ${reply.body}`}
                            value={commentEditDrafts[reply.id] ?? ""}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setCommentEditDrafts((current) => ({
                                ...current,
                                [reply.id]: value,
                              }));
                            }}
                            rows={2}
                            style={COMMENT_REPLY_STYLE}
                          />
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={`Save comment ${reply.body}`}
                            disabled={(commentEditDrafts[reply.id] ?? "").trim().length === 0}
                            onClick={() => void saveCommentEdit(reply.id)}
                          >
                            <Icons.Check size={14} />
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={`Cancel edit ${reply.body}`}
                            onClick={() => cancelCommentEdit(reply.id)}
                          >
                            <Icons.X size={14} />
                            Cancel
                          </button>
                        </div>
                      )}
                      <div style={COMMENT_ACTIONS_STYLE}>
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`Edit ${reply.body}`}
                          onClick={() => beginCommentEdit(reply)}
                        >
                          <Icons.EditPen size={14} />
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn sm danger"
                          aria-label={`Delete ${reply.body}`}
                          onClick={() => void removeComment(reply.id)}
                        >
                          <Icons.Trash size={14} />
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}
              <div style={COMMENT_ACTIONS_STYLE}>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Edit ${comment.body}`}
                  onClick={() => beginCommentEdit(comment)}
                >
                  <Icons.EditPen size={14} />
                  Edit
                </button>
                <button
                  type="button"
                  className="btn sm danger"
                  aria-label={`Delete ${comment.body}`}
                  onClick={() => void removeComment(comment.id)}
                >
                  <Icons.Trash size={14} />
                  Delete
                </button>
                {comment.status === "resolved" ? (
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Reopen ${comment.body}`}
                    onClick={() => void reopenComment(comment.id)}
                  >
                    <Icons.Refresh size={14} />
                    Reopen
                  </button>
                ) : null}
              </div>
              {comment.status === "open" ? (
                <div style={COMMENT_ACTIONS_STYLE}>
                  <textarea
                    aria-label={`Reply to ${comment.body}`}
                    value={replyDrafts[comment.id] ?? ""}
                    onChange={(event) =>
                      setReplyDrafts((current) => ({
                        ...current,
                        [comment.id]: event.target.value,
                      }))
                    }
                    rows={2}
                    style={COMMENT_REPLY_STYLE}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Add reply to ${comment.body}`}
                    disabled={(replyDrafts[comment.id] ?? "").trim().length === 0}
                    onClick={() => void addReply(comment)}
                  >
                    Reply
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    aria-label={`Resolve ${comment.body}`}
                    onClick={() => void resolveComment(comment.id)}
                  >
                    <Icons.Check size={14} />
                    Resolve
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  const chromeSidePanelTabs = buildSheetsSidePanelTabs(
    {
      comments: sidePanelCommentsContent,
      charts: sidePanelChartsContent,
      pivots: sidePanelPivotsContent,
      ai: sidePanelAiContent,
      cells: sidePanelCellsContent,
      filters: sidePanelFiltersContent,
      names: sidePanelNamesContent,
      versions: sidePanelVersionsContent,
      permissions: sidePanelPermissionsContent,
    },
    { commentsBadge: openSheetComments.length || undefined },
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <EditorAppBar
        title={sheetQuery.data.title}
        onBack={onBack}
        status={chromeStatus}
        menus={chromeMenus}
        sidePanelOpen={sidePanelOpen}
        onSidePanelToggle={() => setSidePanelOpen((open) => !open)}
        onShare={() => setShareDialogOpen(true)}
      />
      {chromeRibbon}
      <div className="flex h-8 items-center gap-2 px-2 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <span className="text-xs font-semibold text-[var(--text-2)] tracking-wider">fx</span>
        <input
          aria-label="Name box"
          type="text"
          className="h-6 w-20 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-sm"
          readOnly
          value={
            selectedRange === null
              ? selectedCell === null
                ? ""
                : cellLabel(selectedCell)
              : rangeLabel(selectedRange)
          }
        />
        <div className="w-px h-5 bg-[var(--border)]" />
        <input
          aria-label="Formula bar"
          type="text"
          disabled={selectedCell === null || selectedRangeBlocked}
          className="flex-1 h-6 px-2 rounded border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
          value={formulaBarValue}
          onChange={(event) => {
            if (selectedCell !== null) {
              updateLocalCell(selectedCell.row, selectedCell.col, event.currentTarget.value);
            }
          }}
          onBlur={(event) => {
            if (selectedCell !== null) {
              commitCell(selectedCell.row, selectedCell.col, event.currentTarget.value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        <div
          aria-label="Selected cell"
          className="text-xs text-[var(--text-3)] font-semibold tabular-nums px-2"
        >
          {selectedRange === null
            ? selectedCell === null
              ? ""
              : cellLabel(selectedCell)
            : rangeLabel(selectedRange)}
        </div>
      </div>
      <EditorWorkspace
        sidePanel={
          <EditorSidePanel
            open={sidePanelOpen}
            onOpenChange={setSidePanelOpen}
            tabs={chromeSidePanelTabs}
            activeTabId={sidePanelTabId}
            onActiveTabChange={(id: string) => setSidePanelTabId(id as SheetsSidePanelTabId)}
          />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
          <div style={{ overflow: "auto", flex: 1, background: "var(--bg)", padding: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "stretch",
                gap: 16,
                minWidth: 0,
              }}
            >
              <div style={{ minWidth: 0, flex: 1, overflow: "auto" }}>
                {selectedRangeSummary === null ? null : (
                  <div
                    role="status"
                    aria-label="Selected range summary"
                    style={SELECTED_RANGE_SUMMARY_STYLE}
                  >
                    {selectedRangeSummaryText(selectedRangeSummary)}
                  </div>
                )}
                <div ref={gridWrapRef} style={SHEET_GRID_WRAP_STYLE}>
                  <input
                    ref={imageFileInputRef}
                    type="file"
                    accept="image/*,.avif,.bmp,.gif,.heic,.heif,.j2k,.jfif,.jpeg,.jpg,.jpe,.jp2,.jpf,.jpm,.jpx,.jxl,.png,.svg,.tif,.tiff,.webp"
                    hidden
                    aria-label="Choose spreadsheet image"
                    onChange={handleImageInputChange}
                  />
                  <div
                    role="grid"
                    aria-label={`${sheetQuery.data.title} spreadsheet grid`}
                    onDragOver={handleSheetDragOver}
                    onDrop={handleSheetDrop}
                    style={{
                      display: "grid",
                      gridTemplateColumns: `${String(SHEET_ROW_HEADER_WIDTH)}px repeat(${String(
                        VISIBLE_COLS,
                      )}, ${String(SHEET_CELL_WIDTH)}px)`,
                      minWidth: SHEET_ROW_HEADER_WIDTH + VISIBLE_COLS * SHEET_CELL_WIDTH,
                      borderTop: "1px solid var(--border)",
                      borderLeft: "1px solid var(--border)",
                      background: "var(--surface)",
                    }}
                  >
                    <GridHeaderCell />
                    {visibleCols.map((col) => (
                      <GridHeaderCell key={col}>{columnLetter(col)}</GridHeaderCell>
                    ))}
                    {visibleRows.map(({ row, displayRow, rowIndex }) => (
                      <GridRow
                        key={rowIndex}
                        row={row}
                        grid={grid}
                        displayRow={displayRow}
                        formatMap={formatMap}
                        validationChoiceContext={validationChoiceContext}
                        openComments={openSheetComments}
                        activeTabId={activeTabId}
                        mergedRanges={activeMergedRanges}
                        protectedRanges={protectedRanges}
                        rowIndex={rowIndex}
                        visibleCols={visibleCols}
                        editingCell={editingCell}
                        selectedRange={selectedRange}
                        fillPreviewRange={fillPreviewRange}
                        onChange={updateLocalCell}
                        onCommit={commitGridCellFromBlur}
                        onCopyCells={(event, row, col) => {
                          const range = selectedRange ?? singleCellRange(row, col);
                          event.clipboardData.setData(
                            "text/plain",
                            clipboardTextForRange(grid, range),
                          );
                          event.clipboardData.setData(
                            SHEETS_CLIPBOARD_MIME,
                            formattedClipboardTextForRange(grid, range, formatMap),
                          );
                          event.preventDefault();
                        }}
                        onPasteCells={(event, row, col) => {
                          const text = event.clipboardData.getData("text/plain");
                          const formattedCells = event.clipboardData.getData(SHEETS_CLIPBOARD_MIME);
                          if (text.length === 0 && formattedCells.length === 0) {
                            return;
                          }
                          event.preventDefault();
                          handlePaste(row, col, text, formattedCells);
                        }}
                        onNavigateCell={navigateCell}
                        onFocusCell={(row, col) => {
                          if (skipNextProgrammaticFocus.current) {
                            skipNextProgrammaticFocus.current = false;
                            return;
                          }
                          setSelectedImageId(null);
                          const cell = { row, col };
                          setSelectedCell(cell);
                          setSelectedRange(singleCellRange(row, col));
                          setEditingCell(cell);
                        }}
                        onExtendSelection={(row, col) => {
                          const anchor = selectedCell ?? { row, col };
                          setSelectedCell({ row, col });
                          setSelectedRange({ start: anchor, end: { row, col } });
                          setEditingCell(null);
                        }}
                        onBeginRangeSelection={beginRangeDragSelection}
                        onDragSelectCell={extendRangeDragSelection}
                        onBlurCell={() => setEditingCell(null)}
                      />
                    ))}
                  </div>
                  {visibleCommentRangeOverlays(openSheetComments, visibleRows, visibleCols).map(
                    (overlay) => (
                      <div
                        key={overlay.key}
                        aria-label={`Comment range ${overlay.label}`}
                        title={`Comment range ${overlay.label}`}
                        style={overlay.style}
                      />
                    ),
                  )}
                  {visibleMergedRangeOverlays(activeMergedRanges, visibleRows, visibleCols).map(
                    (overlay) => (
                      <div
                        key={overlay.key}
                        aria-label={`Merged range ${overlay.label}`}
                        title={`Merged range ${overlay.label}`}
                        style={overlay.style}
                      />
                    ),
                  )}
                  {fillPreviewRange === null
                    ? null
                    : (() => {
                        const style = fillPreviewStyle(fillPreviewRange, visibleRows, visibleCols);
                        return style === null ? null : (
                          <div aria-label="Fill preview range" style={style} />
                        );
                      })()}
                  {selectedFillRange === null || fillHandlePlacement === null ? null : (
                    <button
                      type="button"
                      aria-label="Spreadsheet fill handle"
                      style={fillHandleStyle(fillHandlePlacement)}
                      onMouseDown={(event) => beginFillDrag(event, selectedFillRange)}
                    />
                  )}
                  {activeSheetCharts.map((chart) => (
                    <EmbeddedSheetChart
                      key={chart.id}
                      chart={chart}
                      grid={grid}
                      displayGrid={displayGrid}
                      visibleRows={visibleRows}
                      visibleCols={visibleCols}
                    />
                  ))}
                  {activeSheetImages.map((image) => (
                    <EmbeddedSheetImage
                      key={image.id}
                      image={image}
                      placement={
                        imageDragPreview?.imageId === image.id
                          ? imageDragPreview.placement
                          : image.placement
                      }
                      selected={selectedImageId === image.id}
                      visibleRows={visibleRows}
                      visibleCols={visibleCols}
                      onSelect={setSelectedImageId}
                      onDelete={deleteSheetImage}
                      onDragStart={beginSheetImageDrag}
                      onResizeStart={beginSheetImageResize}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
          {/* Bottom tab strip — sheet tabs + tab management + exports. */}
          <div
            aria-label="Sheet tabs"
            style={{
              minHeight: 32,
              borderTop: "1px solid var(--border)",
              background: "var(--surface-2)",
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "0 8px",
              flexShrink: 0,
              overflowX: "auto",
              flexWrap: "wrap",
            }}
          >
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`btn sm ${tab.id === activeTabId ? "primary" : ""}`}
                aria-label={`Open tab ${tab.name}`}
                onClick={() => setActiveTabId(tab.id)}
                style={{ whiteSpace: "nowrap" }}
              >
                {tab.name}
              </button>
            ))}
            <button
              type="button"
              className="icon-btn"
              aria-label="Add sheet tab"
              disabled={tabMutationPending}
              onClick={() => createTabMutation.mutate()}
            >
              <Icons.Plus size={14} />
            </button>
            <input
              aria-label="Active tab name"
              value={tabNameDraft}
              disabled={activeTab === null || tabMutationPending}
              onChange={(event) => setTabNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  renameActiveTab();
                }
              }}
              style={TAB_NAME_INPUT_STYLE}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Rename active tab"
              disabled={
                activeTab === null ||
                tabNameDraft.trim().length === 0 ||
                tabNameDraft.trim() === activeTab.name ||
                tabMutationPending
              }
              onClick={renameActiveTab}
            >
              <Icons.Check size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Move active tab left"
              disabled={activeTab === null || activeTabIndex <= 0 || tabMutationPending}
              onClick={() => moveActiveTab(-1)}
            >
              <Icons.ChevronDown size={14} style={{ transform: "rotate(90deg)" }} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Move active tab right"
              disabled={
                activeTab === null ||
                activeTabIndex < 0 ||
                activeTabIndex >= visibleTabs.length - 1 ||
                tabMutationPending
              }
              onClick={() => moveActiveTab(1)}
            >
              <Icons.ChevronDown size={14} style={{ transform: "rotate(-90deg)" }} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Delete active tab"
              disabled={activeTab === null || visibleTabs.length <= 1 || tabMutationPending}
              onClick={deleteActiveTab}
            >
              <Icons.Trash size={14} />
            </button>
            <div style={{ marginLeft: "auto" }} aria-label="Sheet export" className="row gap-2">
              <button
                type="button"
                className="icon-btn"
                aria-label="Export workbook as XLSX"
                disabled={exportMutation.isPending || visibleTabs.length === 0}
                onClick={() => exportMutation.mutate("xlsx")}
              >
                <Icons.Download size={14} />
              </button>
              <button
                type="button"
                className="btn sm"
                aria-label="Export workbook as ODS"
                disabled={exportMutation.isPending || visibleTabs.length === 0}
                onClick={() => exportMutation.mutate("ods")}
              >
                ODS
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={exportMutation.isPending || activeTab === null}
                onClick={() => exportMutation.mutate("csv")}
              >
                CSV
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={exportMutation.isPending || activeTab === null}
                onClick={() => exportMutation.mutate("tsv")}
              >
                TSV
              </button>
            </div>
          </div>
        </div>
      </EditorWorkspace>
      <DriveShareDialog
        objectId={sheetId}
        objectName={sheetQuery.data.title}
        ownerActorId={sheetQuery.data.ownerActorId}
        open={shareDialogOpen}
        shareUrl={shareDialogOpen ? buildCurrentSpreadsheetLink(sheetId) : undefined}
        onOpenChange={setShareDialogOpen}
      />
      {keyboardShortcutsOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Spreadsheet keyboard shortcuts"
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        >
          <section className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl">
            <h2 className="m-0 text-lg font-semibold">Keyboard shortcuts</h2>
            <dl className="mt-4 grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
              <dt>Undo</dt>
              <dd>
                <kbd>Ctrl/⌘ Z</kbd>
              </dd>
              <dt>Redo</dt>
              <dd>
                <kbd>Ctrl/⌘ Shift Z</kbd>
              </dd>
              <dt>Copy</dt>
              <dd>
                <kbd>Ctrl/⌘ C</kbd>
              </dd>
              <dt>Paste</dt>
              <dd>
                <kbd>Ctrl/⌘ V</kbd>
              </dd>
              <dt>Edit cell</dt>
              <dd>
                <kbd>Enter</kbd>
              </dd>
            </dl>
            <button
              type="button"
              className="btn sm mt-5"
              onClick={() => setKeyboardShortcutsOpen(false)}
            >
              Close
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function GridRow({
  row,
  grid,
  displayRow,
  formatMap,
  validationChoiceContext,
  openComments,
  activeTabId,
  mergedRanges,
  protectedRanges,
  rowIndex,
  visibleCols,
  editingCell,
  selectedRange,
  fillPreviewRange,
  onChange,
  onCommit,
  onCopyCells,
  onPasteCells,
  onNavigateCell,
  onFocusCell,
  onExtendSelection,
  onBeginRangeSelection,
  onDragSelectCell,
  onBlurCell,
}: {
  readonly row: readonly string[];
  readonly grid: EditableGrid;
  readonly displayRow: readonly string[];
  readonly formatMap: ReadonlyMap<string, CellFormat>;
  readonly validationChoiceContext: DataValidationChoiceContext;
  readonly openComments: readonly SheetsDriveComment[];
  readonly activeTabId: string | null;
  readonly mergedRanges: readonly SheetMergedRangeSpec[];
  readonly protectedRanges: readonly SheetProtectedRangeSpec[];
  readonly rowIndex: number;
  readonly visibleCols: readonly number[];
  readonly editingCell: CellAddress | null;
  readonly selectedRange: CellRange | null;
  readonly fillPreviewRange: CellRange | null;
  readonly onChange: (row: number, col: number, value: string) => void;
  readonly onCommit: (row: number, col: number, value?: string) => void;
  readonly onCopyCells: (event: ClipboardEvent<HTMLInputElement>, row: number, col: number) => void;
  readonly onPasteCells: (
    event: ClipboardEvent<HTMLInputElement>,
    row: number,
    col: number,
  ) => void;
  readonly onNavigateCell: (
    row: number,
    col: number,
    key: SpreadsheetNavigationKey,
    shiftKey: boolean,
    edgeKey: boolean,
    value: string,
  ) => void;
  readonly onFocusCell: (row: number, col: number) => void;
  readonly onExtendSelection: (row: number, col: number) => void;
  readonly onBeginRangeSelection: (
    event: ReactMouseEvent<HTMLInputElement>,
    row: number,
    col: number,
  ) => void;
  readonly onDragSelectCell: (row: number, col: number) => void;
  readonly onBlurCell: () => void;
}) {
  return (
    <>
      <GridHeaderCell>{rowIndex + 1}</GridHeaderCell>
      {visibleCols.map((absoluteColIndex) => {
        const focused = isSameCell(editingCell, rowIndex, absoluteColIndex);
        const selected =
          selectedRange !== null && isCellInRange(rowIndex, absoluteColIndex, selectedRange);
        const fillPreviewed =
          fillPreviewRange !== null && isCellInRange(rowIndex, absoluteColIndex, fillPreviewRange);
        const rawValue = row[absoluteColIndex] ?? "";
        const displayValue = displayRow[absoluteColIndex] ?? rawValue;
        const format = formatMap.get(cellCoordinateKey(rowIndex, absoluteColIndex)) ?? {};
        const formulaPreview = rawValue.trimStart().startsWith("=") && !focused;
        const linkUrl = formatCellLinkUrl(format.linkUrl);
        const linkPreview = linkUrl.length > 0 && !focused;
        const renderedValue = focused ? rawValue : formatDisplayValue(displayValue, format);
        const cellBorders = cellBorderShadow(format.borders);
        const validationMessage = validationMessageForCell(
          rawValue,
          format.dataValidation,
          validationChoiceContext,
          rowIndex,
          absoluteColIndex,
        );
        const validationChoices = dataValidationChoices(
          format.dataValidation,
          validationChoiceContext,
        );
        const validationListId =
          validationChoices.length > 0
            ? dataValidationListId(rowIndex, absoluteColIndex)
            : undefined;
        const conditionalStyle = conditionalFormatStyle(displayValue, format.conditionalFormat, {
          row: rowIndex,
          col: absoluteColIndex,
          grid,
        });
        const hasComment = openComments.some((comment) =>
          sheetCommentContainsCell(comment, activeTabId, rowIndex, absoluteColIndex),
        );
        const mergedRange = cellMergedRange(rowIndex, absoluteColIndex, mergedRanges, activeTabId);
        const coveredByMerge =
          mergedRange !== null && !isMergedRangeAnchor(rowIndex, absoluteColIndex, mergedRange);
        const focusCell = mergedRange === null ? null : mergedRangeAnchorCell(mergedRange);
        const protectedRange = cellProtectedRange(
          rowIndex,
          absoluteColIndex,
          protectedRanges,
          activeTabId,
        );
        const protectedRangeBlocked =
          protectedRange !== null && protectedRangeBlocksEdits(protectedRange);
        const boxShadow = [
          cellBorders,
          validationMessage === null ? undefined : INVALID_CELL_SHADOW,
          hasComment ? COMMENT_CELL_SHADOW : undefined,
          protectedRange === null
            ? undefined
            : protectedRangeBlocked
              ? PROTECTED_CELL_SHADOW
              : WARNING_PROTECTED_CELL_SHADOW,
        ]
          .filter((shadow): shadow is string => shadow !== undefined)
          .join(", ");
        const cellBackground = selected
          ? "var(--accent-soft)"
          : fillPreviewed
            ? "rgba(37, 99, 235, .08)"
            : protectedRangeBlocked
              ? "var(--surface-2)"
              : formulaPreview
                ? "var(--surface-2)"
                : (conditionalStyle.background ?? formatColor(format.fillColor) ?? "transparent");
        const cellColor =
          conditionalStyle.color ??
          formatColor(format.textColor) ??
          (linkPreview ? "var(--accent)" : "var(--text)");
        const cellFontFamily = formatFontFamily(format.fontFamily);
        const cellFontSize = formatFontSize(format.fontSize);
        const cellFontWeight = formatBoolean(format.bold) ? 700 : undefined;
        const cellFontStyle = formatBoolean(format.italic) ? "italic" : undefined;
        const cellTextDecoration = formatTextDecoration(format, linkPreview);
        const cellTextAlign = formatAlign(format.align);
        const cellVerticalAlign = formatVerticalAlign(format.verticalAlign);
        const wrapText = formatBoolean(format.wrapText);
        const visualOverflow = cellVisualOverflowPlacement({
          displayRow,
          focused,
          coveredByMerge,
          col: absoluteColIndex,
          renderedValue,
          textAlign: cellTextAlign,
          visibleCols,
          wrapText,
        });
        const visualOverflows = visualOverflow.span > 1;
        return (
          <Fragment key={absoluteColIndex}>
            <div
              data-testid={`sheet-cell-shell-${columnLetter(absoluteColIndex)}${String(
                rowIndex + 1,
              )}`}
              style={{
                position: "relative",
                height: 32,
                minWidth: 0,
                border: 0,
                borderRight: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                font: "inherit",
                background: cellBackground,
                color: cellColor,
                opacity: coveredByMerge ? 0 : undefined,
                boxShadow: boxShadow.length > 0 ? boxShadow : undefined,
                outline: focused ? "2px solid var(--accent)" : undefined,
                outlineOffset: -2,
                overflow: visualOverflows ? "visible" : "hidden",
                zIndex: visualOverflows ? 2 : undefined,
              }}
            >
              <div
                aria-hidden="true"
                data-testid={`sheet-cell-visual-${columnLetter(absoluteColIndex)}${String(
                  rowIndex + 1,
                )}`}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: visualOverflow.offsetPx,
                  right: visualOverflows ? undefined : 0,
                  width: visualOverflows ? visualOverflow.span * SHEET_CELL_WIDTH : undefined,
                  display: focused ? "none" : "flex",
                  alignItems: cellVisualAlignItems(cellVerticalAlign),
                  padding: "0 8px",
                  pointerEvents: "none",
                  overflow: visualOverflows ? "visible" : "hidden",
                  fontFamily: cellFontFamily,
                  fontSize: cellFontSize,
                  fontWeight: cellFontWeight,
                  fontStyle: cellFontStyle,
                  textDecoration: cellTextDecoration,
                  textAlign: cellTextAlign,
                  color: cellColor,
                  whiteSpace: wrapText ? "pre-wrap" : "nowrap",
                  overflowWrap: wrapText ? "anywhere" : undefined,
                  wordBreak: wrapText ? "break-word" : undefined,
                  textOverflow: wrapText || visualOverflows ? undefined : "ellipsis",
                }}
              >
                <span style={{ width: "100%" }}>{renderedValue}</span>
              </div>
              <input
                aria-label={`${columnLetter(absoluteColIndex)}${String(rowIndex + 1)}`}
                list={validationListId}
                readOnly={protectedRangeBlocked || coveredByMerge}
                aria-readonly={coveredByMerge || protectedRangeBlocked}
                title={
                  coveredByMerge && mergedRange !== null
                    ? `Merged into ${mergedRange.label}`
                    : protectedRange !== null
                      ? `${protectedRangeBlocked ? "Protected" : "Warning"} range: ${
                          protectedRange.label
                        }`
                      : (validationMessage ?? (formulaPreview ? rawValue : undefined))
                }
                value={renderedValue}
                onMouseDown={(event) => {
                  if (event.shiftKey) {
                    event.preventDefault();
                    onExtendSelection(rowIndex, absoluteColIndex);
                    return;
                  }
                  onBeginRangeSelection(
                    event,
                    focusCell?.row ?? rowIndex,
                    focusCell?.col ?? absoluteColIndex,
                  );
                  onFocusCell(focusCell?.row ?? rowIndex, focusCell?.col ?? absoluteColIndex);
                }}
                onMouseOver={() => onDragSelectCell(rowIndex, absoluteColIndex)}
                onFocus={() =>
                  onFocusCell(focusCell?.row ?? rowIndex, focusCell?.col ?? absoluteColIndex)
                }
                onChange={(event) => {
                  if (!protectedRangeBlocked && !coveredByMerge) {
                    onChange(rowIndex, absoluteColIndex, event.currentTarget.value);
                  }
                }}
                onCopy={(event) => onCopyCells(event, rowIndex, absoluteColIndex)}
                onPaste={(event) => onPasteCells(event, rowIndex, absoluteColIndex)}
                onBlur={(event) => {
                  onBlurCell();
                  onCommit(
                    rowIndex,
                    absoluteColIndex,
                    formulaPreview ? rawValue : event.currentTarget.value,
                  );
                }}
                onKeyDown={(event) => {
                  if (isSpreadsheetNavigationKey(event.key)) {
                    event.preventDefault();
                    onNavigateCell(
                      rowIndex,
                      absoluteColIndex,
                      event.key,
                      event.shiftKey,
                      event.ctrlKey || event.metaKey,
                      event.currentTarget.value,
                    );
                  }
                }}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  minWidth: 0,
                  border: 0,
                  padding: "0 8px",
                  font: "inherit",
                  fontFamily: cellFontFamily,
                  fontSize: cellFontSize,
                  fontWeight: cellFontWeight,
                  fontStyle: cellFontStyle,
                  textDecoration: cellTextDecoration,
                  textAlign: cellTextAlign,
                  background: "transparent",
                  color: cellColor,
                  opacity: focused ? 1 : 0,
                  whiteSpace: "nowrap",
                  outline: 0,
                }}
              />
            </div>
            {validationListId === undefined ? null : (
              <datalist id={validationListId}>
                {validationChoices.map((choice) => (
                  <option key={choice} value={choice} />
                ))}
              </datalist>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

interface VisibleSheetRow {
  readonly rowIndex: number;
  readonly row: readonly string[];
  readonly displayRow: readonly string[];
}

function filteredVisibleRows({
  grid,
  displayGrid,
  viewportRow,
  frozenRows,
  filterView,
}: {
  readonly grid: EditableGrid;
  readonly displayGrid: EditableGrid;
  readonly viewportRow: number;
  readonly frozenRows: number;
  readonly filterView: SheetFilterViewSpec | null;
}): readonly VisibleSheetRow[] {
  const frozenRowIndexes = Array.from(
    { length: Math.min(frozenRows, VISIBLE_ROWS, SHEET_MAX_ROWS) },
    (_, rowIndex) => rowIndex,
  );
  const predicates =
    filterView === null ? [] : filterViewPredicates(filterView).filter(filterPredicateIsActive);
  if (filterView === null) {
    return visibleRowIndexes(viewportRow, frozenRows).map((rowIndex) => ({
      rowIndex,
      row: grid[rowIndex] ?? [],
      displayRow: displayGrid[rowIndex] ?? [],
    }));
  }

  const range = normalizeRange(filterViewRange(filterView));
  const sortedRangeRows = sortedFilterViewRangeRows({
    grid,
    displayGrid,
    range,
    predicates,
    sortKeys: filterViewSortKeys(filterView),
    sortDirection: filterView.sortDirection,
  });
  const rows: VisibleSheetRow[] = [];
  const seen = new Set<number>();
  for (const rowIndex of frozenRowIndexes) {
    rows.push({
      rowIndex,
      row: grid[rowIndex] ?? [],
      displayRow: displayGrid[rowIndex] ?? [],
    });
    seen.add(rowIndex);
  }
  for (const rowIndex of filterViewRowSequence(range, sortedRangeRows, viewportRow)) {
    if (seen.has(rowIndex)) {
      continue;
    }
    rows.push({
      rowIndex,
      row: grid[rowIndex] ?? [],
      displayRow: displayGrid[rowIndex] ?? [],
    });
    if (rows.length >= VISIBLE_ROWS) {
      break;
    }
  }
  return rows;
}

function visibleRowIndexes(viewportRow: number, frozenRows: number): readonly number[] {
  const rows: number[] = [];
  const seen = new Set<number>();
  const frozenCount = Math.min(frozenRows, VISIBLE_ROWS, SHEET_MAX_ROWS);
  for (let rowIndex = 0; rowIndex < frozenCount; rowIndex += 1) {
    rows.push(rowIndex);
    seen.add(rowIndex);
  }
  for (
    let rowIndex = viewportRow;
    rowIndex < SHEET_MAX_ROWS && rows.length < VISIBLE_ROWS;
    rowIndex += 1
  ) {
    if (!seen.has(rowIndex)) {
      rows.push(rowIndex);
    }
  }
  return rows;
}

function visibleColumnIndexes(viewportCol: number, frozenCols: number): readonly number[] {
  const cols: number[] = [];
  const seen = new Set<number>();
  const frozenCount = Math.min(frozenCols, VISIBLE_COLS, SHEET_MAX_COLS);
  for (let colIndex = 0; colIndex < frozenCount; colIndex += 1) {
    cols.push(colIndex);
    seen.add(colIndex);
  }
  for (
    let colIndex = viewportCol;
    colIndex < SHEET_MAX_COLS && cols.length < VISIBLE_COLS;
    colIndex += 1
  ) {
    if (!seen.has(colIndex)) {
      cols.push(colIndex);
    }
  }
  return cols;
}

function sortedFilterViewRangeRows({
  grid,
  displayGrid,
  range,
  predicates,
  sortKeys,
  sortDirection,
}: {
  readonly grid: EditableGrid;
  readonly displayGrid: EditableGrid;
  readonly range: NormalizedCellRange;
  readonly predicates: readonly SheetFilterPredicateSpec[];
  readonly sortKeys: readonly number[];
  readonly sortDirection: SortDirection;
}): readonly number[] {
  return Array.from({ length: range.bottom - range.top + 1 }, (_, index) => range.top + index)
    .filter((rowIndex) =>
      predicates.every((predicate) =>
        rowMatchesFilterPredicate(rowIndex, grid, displayGrid, range, predicate),
      ),
    )
    .sort((left, right) => {
      for (const sortColumn of sortKeys) {
        const compared = compareSheetSortValues(
          displayGrid[left]?.[sortColumn] ?? grid[left]?.[sortColumn] ?? "",
          displayGrid[right]?.[sortColumn] ?? grid[right]?.[sortColumn] ?? "",
        );
        if (compared !== 0) {
          return sortDirection === "asc" ? compared : -compared;
        }
      }
      return left - right;
    });
}

function filterViewRowSequence(
  range: NormalizedCellRange,
  sortedRangeRows: readonly number[],
  viewportRow: number,
): readonly number[] {
  const sequence: number[] = [];
  for (
    let rowIndex = 0;
    rowIndex < SHEET_MAX_ROWS && sequence.length < viewportRow + VISIBLE_ROWS;
    rowIndex += 1
  ) {
    if (rowIndex === range.top) {
      sequence.push(...sortedRangeRows);
      rowIndex = range.bottom;
      continue;
    }
    sequence.push(rowIndex);
  }
  return sequence.slice(viewportRow, viewportRow + VISIBLE_ROWS);
}

function rowMatchesFilterPredicate(
  rowIndex: number,
  grid: EditableGrid,
  displayGrid: EditableGrid,
  range: NormalizedCellRange,
  predicate: SheetFilterPredicateSpec,
): boolean {
  if (rowIndex < range.top || rowIndex > range.bottom) {
    return true;
  }
  const expected = predicate.value.trim().toLowerCase();
  if (filterPredicateNeedsValue(predicate.operator) && expected.length === 0) {
    return true;
  }
  const rawValue = grid[rowIndex]?.[predicate.column] ?? "";
  const displayValue = displayGrid[rowIndex]?.[predicate.column] ?? rawValue;
  const normalizedDisplayValue = displayValue.trim().toLowerCase();
  if (predicate.operator === "equals") {
    return normalizedDisplayValue === expected;
  }
  if (predicate.operator === "greaterThan") {
    const actual = parseChartNumber(displayValue);
    const threshold = parseChartNumber(predicate.value);
    return actual !== null && threshold !== null && actual > threshold;
  }
  if (predicate.operator === "notEmpty") {
    return displayValue.trim().length > 0;
  }
  return normalizedDisplayValue.includes(expected);
}

function applySyncedOperationToGrid(
  grid: EditableGrid,
  changes: readonly NativeSpreadsheetOperationChange[],
): EditableGrid {
  const next = [...grid];
  for (const change of changes) {
    if (change.kind === "insert-rows") {
      next.splice(change.index, 0, ...emptyRows(change.count));
      next.length = SHEET_MAX_ROWS;
      rebaseSyncedGridFormulas(next, change);
      continue;
    }
    if (change.kind === "delete-rows") {
      next.splice(change.index, change.count);
      next.push(...emptyRows(change.count));
      next.length = SHEET_MAX_ROWS;
      rebaseSyncedGridFormulas(next, change);
      continue;
    }
    if (change.kind === "insert-columns") {
      for (let rowIndex = 0; rowIndex < next.length; rowIndex += 1) {
        const row = [...(next[rowIndex] ?? [])];
        row.splice(change.index, 0, ...Array.from({ length: change.count }, () => ""));
        row.length = SHEET_MAX_COLS;
        next[rowIndex] = row;
      }
      rebaseSyncedGridFormulas(next, change);
      continue;
    }
    if (change.kind === "delete-columns") {
      for (let rowIndex = 0; rowIndex < next.length; rowIndex += 1) {
        const row = [...(next[rowIndex] ?? [])];
        row.splice(change.index, change.count);
        row.push(...Array.from({ length: change.count }, () => ""));
        row.length = SHEET_MAX_COLS;
        next[rowIndex] = row;
      }
      rebaseSyncedGridFormulas(next, change);
      continue;
    }
    const row = [
      ...(next[change.row] ??
        Array.from({ length: Math.max(SHEET_MAX_COLS, change.col + 1) }, () => "")),
    ];
    row[change.col] = change.kind === "set-cell" ? change.value : "";
    next[change.row] = row;
  }
  return next;
}

function rebaseSyncedGridFormulas(
  grid: EditableGrid,
  change: NativeSpreadsheetOperationChange,
): void {
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    const row = grid[rowIndex];
    if (row === undefined) {
      continue;
    }
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      row[colIndex] = rebaseSpreadsheetFormulaForStructuralChange(row[colIndex] ?? "", change);
    }
  }
}

function emptyRows(count: number): string[][] {
  return Array.from({ length: count }, () => Array.from({ length: SHEET_MAX_COLS }, () => ""));
}

function isSameCell(cell: CellAddress | null, row: number, col: number): boolean {
  return cell?.row === row && cell.col === col;
}

function isSpreadsheetNavigationKey(value: string): value is SpreadsheetNavigationKey {
  return (
    value === "ArrowUp" ||
    value === "ArrowRight" ||
    value === "ArrowDown" ||
    value === "ArrowLeft" ||
    value === "Tab" ||
    value === "Enter" ||
    value === "PageUp" ||
    value === "PageDown" ||
    value === "Home" ||
    value === "End"
  );
}

function nextCellAddress(
  row: number,
  col: number,
  key: SpreadsheetNavigationKey,
  shiftKey: boolean,
  edgeKey: boolean,
): CellAddress {
  if (key === "ArrowUp") return { row: clampGridRow(row - 1), col };
  if (key === "ArrowRight") return { row, col: clampGridCol(col + 1) };
  if (key === "ArrowDown") return { row: clampGridRow(row + 1), col };
  if (key === "ArrowLeft") return { row, col: clampGridCol(col - 1) };
  if (key === "Enter") return { row: clampGridRow(row + (shiftKey ? -1 : 1)), col };
  if (key === "PageUp") return { row: clampGridRow(row - VISIBLE_ROWS), col };
  if (key === "PageDown") return { row: clampGridRow(row + VISIBLE_ROWS), col };
  if (key === "Home") return edgeKey ? { row: 0, col: 0 } : { row, col: 0 };
  if (key === "End") {
    return edgeKey
      ? { row: SHEET_MAX_ROWS - 1, col: SHEET_MAX_COLS - 1 }
      : { row, col: SHEET_MAX_COLS - 1 };
  }

  const direction = shiftKey ? -1 : 1;
  const linear = row * SHEET_MAX_COLS + col + direction;
  const clamped = Math.min(Math.max(linear, 0), SHEET_MAX_ROWS * SHEET_MAX_COLS - 1);
  return {
    row: Math.floor(clamped / SHEET_MAX_COLS),
    col: clamped % SHEET_MAX_COLS,
  };
}

function clampGridRow(row: number): number {
  return Math.min(Math.max(row, 0), SHEET_MAX_ROWS - 1);
}

function clampGridCol(col: number): number {
  return Math.min(Math.max(col, 0), SHEET_MAX_COLS - 1);
}

function selectedIndexAfterDelete(
  selectedIndex: number,
  deleteIndex: number,
  count: number,
  max: number,
): number {
  if (selectedIndex < deleteIndex) {
    return selectedIndex;
  }
  if (selectedIndex >= deleteIndex + count) {
    return Math.max(0, selectedIndex - count);
  }
  return Math.min(deleteIndex, max - 1);
}

function focusGridCell(
  cell: CellAddress,
  setViewport: (updater: (current: CellAddress) => CellAddress) => void,
) {
  const selector = `input[aria-label="${cellLabel(cell)}"]`;
  setViewport((current) => viewportForCell(cell, current));
  globalThis.queueMicrotask(() => {
    globalThis.document.querySelector<HTMLInputElement>(selector)?.focus();
  });
}

function viewportForCell(cell: CellAddress, viewport: CellAddress): CellAddress {
  let nextRow = viewport.row;
  let nextCol = viewport.col;
  if (cell.row < viewport.row) {
    nextRow = cell.row;
  } else if (cell.row >= viewport.row + VISIBLE_ROWS) {
    nextRow = cell.row - VISIBLE_ROWS + 1;
  }
  if (cell.col < viewport.col) {
    nextCol = cell.col;
  } else if (cell.col >= viewport.col + VISIBLE_COLS) {
    nextCol = cell.col - VISIBLE_COLS + 1;
  }
  return clampViewport({ row: nextRow, col: nextCol });
}

function clampViewport(viewport: CellAddress): CellAddress {
  return {
    row: Math.min(Math.max(viewport.row, 0), SHEET_MAX_ROWS - VISIBLE_ROWS),
    col: Math.min(Math.max(viewport.col, 0), SHEET_MAX_COLS - VISIBLE_COLS),
  };
}

function cellCoordinateKey(row: number, col: number): string {
  return `${String(row)}:${String(col)}`;
}

function dataValidationListId(row: number, col: number): string {
  return `sheet-validation-${String(row)}-${String(col)}`;
}

function nextSheetTabName(tabs: readonly { readonly name: string }[]): string {
  const names = new Set(tabs.map((tab) => tab.name.trim().toLowerCase()));
  for (let index = tabs.length + 1; index < tabs.length + 100; index += 1) {
    const candidate = `Sheet ${String(index)}`;
    if (!names.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `Sheet ${String(Date.now())}`;
}

function cellFormatMap(
  cells: readonly { readonly row: number; readonly col: number; readonly format: CellFormat }[],
) {
  const map = new Map<string, CellFormat>();
  for (const cell of cells) {
    map.set(cellCoordinateKey(cell.row, cell.col), cell.format);
  }
  return map;
}

function meaningfulSheetCellEdits(
  edits: readonly SheetsCellEdit[],
  baseGrid: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
): readonly SheetsCellEdit[] {
  return edits.filter((edit) => {
    const previousValue = baseGrid[edit.row]?.[edit.col] ?? "";
    if (previousValue !== edit.value) {
      return true;
    }
    if (edit.format === undefined) {
      return false;
    }
    const previousFormat = formatMap.get(cellCoordinateKey(edit.row, edit.col)) ?? {};
    return !cellFormatsEqual(previousFormat, edit.format);
  });
}

function sheetCellHistoryEntry(
  tabId: string,
  redoEdits: readonly SheetsCellEdit[],
  baseGrid: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
): SheetCellHistoryEntry | null {
  const meaningfulRedoEdits = meaningfulSheetCellEdits(redoEdits, baseGrid, formatMap);
  if (meaningfulRedoEdits.length === 0) {
    return null;
  }
  return {
    tabId,
    redoEdits: meaningfulRedoEdits.map(cloneSheetCellEdit),
    undoEdits: meaningfulRedoEdits.map((edit) => {
      const previousFormat = formatMap.get(cellCoordinateKey(edit.row, edit.col)) ?? {};
      return {
        row: edit.row,
        col: edit.col,
        value: baseGrid[edit.row]?.[edit.col] ?? "",
        ...(edit.format === undefined ? {} : { format: { ...previousFormat } }),
      };
    }),
  };
}

function cloneSheetCellEdit(edit: SheetsCellEdit): SheetsCellEdit {
  return {
    row: edit.row,
    col: edit.col,
    value: edit.value,
    ...(edit.format === undefined ? {} : { format: { ...edit.format } }),
  };
}

function cellFormatsEqual(left: CellFormat, right: CellFormat): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCellInRange(row: number, col: number, range: CellRange): boolean {
  const normalized = normalizeRange(range);
  return (
    row >= normalized.top &&
    row <= normalized.bottom &&
    col >= normalized.left &&
    col <= normalized.right
  );
}

function rangesEqual(left: CellRange, right: CellRange): boolean {
  const normalizedLeft = normalizeRange(left);
  const normalizedRight = normalizeRange(right);
  return (
    normalizedLeft.top === normalizedRight.top &&
    normalizedLeft.left === normalizedRight.left &&
    normalizedLeft.bottom === normalizedRight.bottom &&
    normalizedLeft.right === normalizedRight.right
  );
}

function canMergeRange(range: CellRange): boolean {
  const normalized = normalizeRange(range);
  return normalized.top !== normalized.bottom || normalized.left !== normalized.right;
}

function singleCellRange(row: number, col: number): CellRange {
  return {
    start: { row, col },
    end: { row, col },
  };
}

function normalizeRange(range: CellRange): NormalizedCellRange {
  return {
    top: Math.min(range.start.row, range.end.row),
    right: Math.max(range.start.col, range.end.col),
    bottom: Math.max(range.start.row, range.end.row),
    left: Math.min(range.start.col, range.end.col),
  };
}

function cellLabel(cell: CellAddress): string {
  return `${columnLetter(cell.col)}${String(cell.row + 1)}`;
}

function rangeLabel(range: CellRange): string {
  const normalized = normalizeRange(range);
  const start = cellLabel({ row: normalized.top, col: normalized.left });
  const end = cellLabel({ row: normalized.bottom, col: normalized.right });
  return start === end ? start : `${start}:${end}`;
}

function boundingRangeForCells(cells: readonly CellAddress[]): CellRange | null {
  if (cells.length === 0) {
    return null;
  }
  const rows = cells.map((cell) => cell.row);
  const cols = cells.map((cell) => cell.col);
  return {
    start: {
      row: Math.min(...rows),
      col: Math.min(...cols),
    },
    end: {
      row: Math.max(...rows),
      col: Math.max(...cols),
    },
  };
}

function protectedRangeToCellRange(range: SheetProtectedRangeSpec): CellRange {
  return {
    start: { row: range.range.startRow, col: range.range.startCol },
    end: { row: range.range.endRow, col: range.range.endCol },
  };
}

function protectedRangeCellCount(range: SheetProtectedRangeSpec): number {
  const normalized = normalizeRange(protectedRangeToCellRange(range));
  return (normalized.bottom - normalized.top + 1) * (normalized.right - normalized.left + 1);
}

function formulaHelperTarget(range: ReturnType<typeof normalizeRange>): CellAddress | null {
  if (range.right + 1 < SHEET_MAX_COLS) {
    return { row: range.top, col: range.right + 1 };
  }
  if (range.bottom + 1 < SHEET_MAX_ROWS) {
    return { row: range.bottom + 1, col: range.left };
  }
  return null;
}

function formulaHelperValue(
  helper: FormulaHelperKind,
  sourceRange: string,
  sourceLeftCol: number,
): string {
  const sourceCell = sourceRange.includes(":") ? sourceRange.split(":")[0] : sourceRange;
  if (helper === "helix-classify") {
    return `=HELIX.AI.CLASSIFY(${sourceCell ?? sourceRange}, "Risk, Expansion, Renewal")`;
  }
  if (helper === "average") {
    return `=AVERAGE(${sourceRange})`;
  }
  if (helper === "count") {
    return `=COUNT(${sourceRange})`;
  }
  if (helper === "counta") {
    return `=COUNTA(${sourceRange})`;
  }
  if (helper === "min") {
    return `=MIN(${sourceRange})`;
  }
  if (helper === "max") {
    return `=MAX(${sourceRange})`;
  }
  if (helper === "sumif-equals") {
    return `=SUMIF(${sourceRange}, ${sourceCell ?? sourceRange})`;
  }
  if (helper === "countif-equals") {
    return `=COUNTIF(${sourceRange}, ${sourceCell ?? sourceRange})`;
  }
  if (helper === "averageif-equals") {
    return `=AVERAGEIF(${sourceRange}, ${sourceCell ?? sourceRange})`;
  }
  if (helper === "query-sum") {
    return `=QUERY(${sourceRange}, "select sum(${columnLetter(sourceLeftCol)})", 0)`;
  }
  if (helper === "query-count") {
    return `=QUERY(${sourceRange}, "select count(*)", 0)`;
  }
  if (helper === "query-top") {
    return `=QUERY(${sourceRange}, "select ${columnLetter(sourceLeftCol)} order by ${columnLetter(
      sourceLeftCol,
    )} desc limit 1", 0)`;
  }
  return `=SUM(${sourceRange})`;
}

function isFormulaHelperKind(value: string): value is FormulaHelperKind {
  return FORMULA_HELPERS.some((helper) => helper.value === value);
}

function sheetChartsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetChartSpec[] {
  const charts = metadata?.charts;
  if (!Array.isArray(charts)) {
    return [];
  }
  return charts.filter(isSheetChartSpec);
}

function metadataWithCharts(
  metadata: Record<string, unknown>,
  charts: readonly SheetChartSpec[],
): Record<string, unknown> {
  return { ...metadata, charts };
}

function sheetImagesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetImageSpec[] {
  const images = metadata?.images;
  if (!Array.isArray(images)) {
    return [];
  }
  return images.filter(isSheetImageSpec);
}

interface StoredSheetGridRecovery {
  readonly sheetId: string;
  readonly tabId: string;
  readonly edits: readonly SheetsCellEdit[];
  readonly savedAt: string;
}

function gridWithRecoveredSheetEdits(
  baseGrid: EditableGrid,
  sheetId: string,
  tabId: string,
): { readonly grid: EditableGrid; readonly recovered: boolean } {
  const recovery = readRecoveredSheetGrid(sheetId, tabId);
  if (recovery === null) {
    return { grid: baseGrid, recovered: false };
  }
  const pendingEdits = recovery.edits.filter(
    (edit) => (baseGrid[edit.row]?.[edit.col] ?? "") !== edit.value,
  );
  if (pendingEdits.length === 0) {
    removeRecoveredSheetGrid(sheetId, tabId);
    return { grid: baseGrid, recovered: false };
  }
  return { grid: applySheetCellEditsToGrid(baseGrid, pendingEdits), recovered: true };
}

function diffSheetGrid(
  baseGrid: EditableGrid,
  currentGrid: EditableGrid,
): readonly SheetsCellEdit[] {
  const edits: SheetsCellEdit[] = [];
  const rowCount = Math.max(baseGrid.length, currentGrid.length);
  for (let row = 0; row < rowCount; row += 1) {
    const baseRow = baseGrid[row] ?? [];
    const currentRow = currentGrid[row] ?? [];
    const colCount = Math.max(baseRow.length, currentRow.length);
    for (let col = 0; col < colCount; col += 1) {
      const value = currentRow[col] ?? "";
      if ((baseRow[col] ?? "") !== value) {
        edits.push({ row, col, value });
      }
    }
  }
  return edits;
}

function applySheetCellEditsToGrid(
  grid: EditableGrid,
  edits: readonly SheetsCellEdit[],
): EditableGrid {
  const next = grid.map((row) => [...row]);
  for (const edit of edits) {
    const existingRow = next[edit.row] ?? [];
    const width = Math.max(existingRow.length, edit.col + 1);
    const row = Array.from({ length: width }, (_, col) => existingRow[col] ?? "");
    row[edit.col] = edit.value;
    next[edit.row] = row;
  }
  return next;
}

function displayGridWithLocalSheetEdits(
  baseGrid: EditableGrid,
  baseDisplayGrid: EditableGrid,
  currentGrid: EditableGrid,
): EditableGrid {
  return applySheetCellEditsToGrid(baseDisplayGrid, diffSheetGrid(baseGrid, currentGrid));
}

function readRecoveredSheetGrid(sheetId: string, tabId: string): StoredSheetGridRecovery | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(recoveredSheetGridKey(sheetId, tabId));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !isStoredSheetGridRecovery(parsed) ||
      parsed.sheetId !== sheetId ||
      parsed.tabId !== tabId
    ) {
      removeRecoveredSheetGrid(sheetId, tabId);
      return null;
    }
    return parsed;
  } catch {
    removeRecoveredSheetGrid(sheetId, tabId);
    return null;
  }
}

function writeRecoveredSheetGrid(
  sheetId: string,
  tabId: string,
  edits: readonly SheetsCellEdit[],
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      recoveredSheetGridKey(sheetId, tabId),
      JSON.stringify({
        sheetId,
        tabId,
        edits,
        savedAt: new Date().toISOString(),
      } satisfies StoredSheetGridRecovery),
    );
  } catch {
    // Local recovery is best-effort; normal realtime/REST saves remain authoritative.
  }
}

function removeRecoveredSheetGrid(sheetId: string, tabId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(recoveredSheetGridKey(sheetId, tabId));
  } catch {
    // Ignore storage failures; a stale draft should never block editor rendering.
  }
}

function recoveredSheetGridKey(sheetId: string, tabId: string): string {
  return `${SHEETS_GRID_RECOVERY_PREFIX}.${sheetId}.${tabId}`;
}

function isStoredSheetGridRecovery(value: unknown): value is StoredSheetGridRecovery {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<StoredSheetGridRecovery>;
  return (
    typeof record.sheetId === "string" &&
    typeof record.tabId === "string" &&
    typeof record.savedAt === "string" &&
    Array.isArray(record.edits) &&
    record.edits.every(isSheetCellEdit)
  );
}

function isSheetCellEdit(value: unknown): value is SheetsCellEdit {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<SheetsCellEdit>;
  return (
    typeof record.row === "number" &&
    Number.isInteger(record.row) &&
    record.row >= 0 &&
    typeof record.col === "number" &&
    Number.isInteger(record.col) &&
    record.col >= 0 &&
    typeof record.value === "string"
  );
}

function metadataWithImages(
  metadata: Record<string, unknown>,
  images: readonly SheetImageSpec[],
): Record<string, unknown> {
  return { ...metadata, images };
}

function sheetPivotTablesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetPivotTableSpec[] {
  const pivotTables = metadata?.pivotTables;
  if (!Array.isArray(pivotTables)) {
    return [];
  }
  return pivotTables.filter(isSheetPivotTableSpec);
}

function metadataWithPivotTables(
  metadata: Record<string, unknown>,
  pivotTables: readonly SheetPivotTableSpec[],
): Record<string, unknown> {
  return { ...metadata, pivotTables };
}

function sheetNamedRangesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetNamedRangeSpec[] {
  const ranges = metadata?.namedRanges;
  if (!Array.isArray(ranges)) {
    return [];
  }
  return ranges.filter(isSheetNamedRangeSpec);
}

function metadataWithNamedRanges(
  metadata: Record<string, unknown>,
  namedRanges: readonly SheetNamedRangeSpec[],
): Record<string, unknown> {
  return { ...metadata, namedRanges };
}

function sheetMergedRangesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetMergedRangeSpec[] {
  const ranges = metadata?.mergedCells;
  if (!Array.isArray(ranges)) {
    return [];
  }
  return ranges.filter(isSheetMergedRangeSpec);
}

function metadataWithMergedCells(
  metadata: Record<string, unknown>,
  mergedCells: readonly SheetMergedRangeSpec[],
): Record<string, unknown> {
  return { ...metadata, mergedCells };
}

function sheetFrozenPanesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetFrozenPaneSpec[] {
  const panes = metadata?.frozenPanes;
  if (!Array.isArray(panes)) {
    return [];
  }
  return panes.filter(isSheetFrozenPaneSpec);
}

function metadataWithFrozenPanes(
  metadata: Record<string, unknown>,
  frozenPanes: readonly SheetFrozenPaneSpec[],
): Record<string, unknown> {
  return { ...metadata, frozenPanes };
}

function sheetFilterViewsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetFilterViewSpec[] {
  const views = metadata?.filterViews;
  if (!Array.isArray(views)) {
    return [];
  }
  return views.filter(isSheetFilterViewSpec);
}

function metadataWithFilterViews(
  metadata: Record<string, unknown>,
  filterViews: readonly SheetFilterViewSpec[],
): Record<string, unknown> {
  return { ...metadata, filterViews };
}

function sheetProtectedRangesFromMetadata(
  metadata: Record<string, unknown> | undefined,
): readonly SheetProtectedRangeSpec[] {
  const ranges = metadata?.protectedRanges;
  if (!Array.isArray(ranges)) {
    return [];
  }
  return ranges.filter(isSheetProtectedRangeSpec);
}

function metadataWithProtectedRanges(
  metadata: Record<string, unknown>,
  protectedRanges: readonly SheetProtectedRangeSpec[],
): Record<string, unknown> {
  return { ...metadata, protectedRanges };
}

function isSheetNamedRangeSpec(value: unknown): value is SheetNamedRangeSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const rangeSpec = value as Record<string, unknown>;
  const range = rangeSpec.range;
  return (
    typeof rangeSpec.id === "string" &&
    typeof rangeSpec.tabId === "string" &&
    typeof rangeSpec.name === "string" &&
    typeof range === "object" &&
    range !== null &&
    !Array.isArray(range) &&
    numberAnchorValue((range as Record<string, unknown>).startRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).startCol) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endCol) !== null
  );
}

function isSheetMergedRangeSpec(value: unknown): value is SheetMergedRangeSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const rangeSpec = value as Record<string, unknown>;
  const range = rangeSpec.range;
  return (
    typeof rangeSpec.id === "string" &&
    typeof rangeSpec.tabId === "string" &&
    typeof rangeSpec.label === "string" &&
    typeof range === "object" &&
    range !== null &&
    !Array.isArray(range) &&
    numberAnchorValue((range as Record<string, unknown>).startRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).startCol) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endCol) !== null
  );
}

function isSheetFrozenPaneSpec(value: unknown): value is SheetFrozenPaneSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const pane = value as Record<string, unknown>;
  return (
    typeof pane.tabId === "string" &&
    numberAnchorValue(pane.frozenRows) !== null &&
    numberAnchorValue(pane.frozenCols) !== null
  );
}

function isSheetFilterViewSpec(value: unknown): value is SheetFilterViewSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const viewSpec = value as Record<string, unknown>;
  const range = viewSpec.range;
  const predicate = viewSpec.predicate;
  const predicates = viewSpec.predicates;
  const sortColumn = viewSpec.sortColumn;
  const sortKeys = viewSpec.sortKeys;
  return (
    typeof viewSpec.id === "string" &&
    typeof viewSpec.tabId === "string" &&
    typeof viewSpec.name === "string" &&
    (viewSpec.sortDirection === "asc" || viewSpec.sortDirection === "desc") &&
    (sortColumn === undefined || numberAnchorValue(sortColumn) !== null) &&
    (sortKeys === undefined ||
      (Array.isArray(sortKeys) && sortKeys.every((key) => numberAnchorValue(key) !== null))) &&
    (predicate === undefined || isSheetFilterPredicateSpec(predicate)) &&
    (predicates === undefined ||
      (Array.isArray(predicates) && predicates.every(isSheetFilterPredicateSpec))) &&
    typeof range === "object" &&
    range !== null &&
    !Array.isArray(range) &&
    numberAnchorValue((range as Record<string, unknown>).startRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).startCol) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endCol) !== null
  );
}

function isSheetFilterPredicateSpec(value: unknown): value is SheetFilterPredicateSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const predicate = value as Record<string, unknown>;
  return (
    numberAnchorValue(predicate.column) !== null &&
    isSheetFilterPredicateOperator(predicate.operator) &&
    typeof predicate.value === "string"
  );
}

function isSheetFilterPredicateOperator(value: unknown): value is SheetFilterPredicateOperator {
  return (
    value === "contains" || value === "equals" || value === "greaterThan" || value === "notEmpty"
  );
}

function isSheetProtectedRangeSpec(value: unknown): value is SheetProtectedRangeSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const rangeSpec = value as Record<string, unknown>;
  const range = rangeSpec.range;
  return (
    typeof rangeSpec.id === "string" &&
    typeof rangeSpec.tabId === "string" &&
    typeof rangeSpec.label === "string" &&
    (rangeSpec.mode === undefined || isSheetProtectedRangeMode(rangeSpec.mode)) &&
    typeof range === "object" &&
    range !== null &&
    !Array.isArray(range) &&
    numberAnchorValue((range as Record<string, unknown>).startRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).startCol) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endCol) !== null
  );
}

function createProtectedRangeSpec(tabId: string, range: CellRange): SheetProtectedRangeSpec {
  const normalized = normalizeRange(range);
  const label = rangeLabel(range);
  return {
    id: newClientId("protected"),
    tabId,
    label,
    mode: "block",
    range: {
      startRow: normalized.top,
      startCol: normalized.left,
      endRow: normalized.bottom,
      endCol: normalized.right,
    },
  };
}

function isSheetProtectedRangeMode(value: unknown): value is SheetProtectedRangeMode {
  return value === "block" || value === "warn";
}

function protectedRangeMode(range: SheetProtectedRangeSpec): SheetProtectedRangeMode {
  return range.mode === "warn" ? "warn" : "block";
}

function protectedRangeBlocksEdits(range: SheetProtectedRangeSpec): boolean {
  return protectedRangeMode(range) === "block";
}

function createNamedRangeSpec(
  tabId: string,
  range: CellRange,
  existingRanges: readonly SheetNamedRangeSpec[],
): SheetNamedRangeSpec {
  const normalized = normalizeRange(range);
  return {
    id: newClientId("named"),
    tabId,
    name: uniqueNamedRangeName(
      `Range_${sanitizeNamedRangeName(rangeLabel(range))}`,
      existingRanges,
    ),
    range: {
      startRow: normalized.top,
      startCol: normalized.left,
      endRow: normalized.bottom,
      endCol: normalized.right,
    },
  };
}

function createMergedRangeSpec(tabId: string, range: CellRange): SheetMergedRangeSpec {
  const normalized = normalizeRange(range);
  const label = rangeLabel(range);
  return {
    id: newClientId("merge"),
    tabId,
    label,
    range: {
      startRow: normalized.top,
      startCol: normalized.left,
      endRow: normalized.bottom,
      endCol: normalized.right,
    },
  };
}

function createFilterViewSpec(
  tabId: string,
  range: CellRange,
  sortDirection: SortDirection,
  existingViews: readonly SheetFilterViewSpec[],
): SheetFilterViewSpec {
  const normalized = normalizeRange(range);
  const suffix = sortDirection === "asc" ? "A_Z" : "Z_A";
  return {
    id: newClientId("filter"),
    tabId,
    name: uniqueFilterViewName(
      `Filter_${sanitizeNamedRangeName(rangeLabel(range))}_${suffix}`,
      existingViews,
    ),
    sortDirection,
    sortColumn: normalized.left,
    sortKeys: [normalized.left],
    range: {
      startRow: normalized.top,
      startCol: normalized.left,
      endRow: normalized.bottom,
      endCol: normalized.right,
    },
  };
}

function namedRangeLabel(range: SheetNamedRangeSpec): string {
  return rangeLabel({
    start: { row: range.range.startRow, col: range.range.startCol },
    end: { row: range.range.endRow, col: range.range.endCol },
  });
}

function mergedRangeLabel(range: SheetMergedRangeSpec): string {
  return rangeLabel(mergedRangeToCellRange(range));
}

function mergedRangeToCellRange(range: SheetMergedRangeSpec): CellRange {
  return {
    start: { row: range.range.startRow, col: range.range.startCol },
    end: { row: range.range.endRow, col: range.range.endCol },
  };
}

function filterViewRange(view: SheetFilterViewSpec): CellRange {
  return {
    start: {
      row: numberAnchorValue(view.range.startRow) ?? 0,
      col: numberAnchorValue(view.range.startCol) ?? 0,
    },
    end: {
      row: numberAnchorValue(view.range.endRow) ?? numberAnchorValue(view.range.startRow) ?? 0,
      col: numberAnchorValue(view.range.endCol) ?? numberAnchorValue(view.range.startCol) ?? 0,
    },
  };
}

function filterViewEditablePredicates(
  view: SheetFilterViewSpec,
): readonly SheetFilterPredicateSpec[] {
  const predicates = filterViewPredicates(view);
  return predicates.length === 0 ? [defaultFilterPredicate(view)] : predicates;
}

function filterViewPredicates(view: SheetFilterViewSpec): readonly SheetFilterPredicateSpec[] {
  const range = normalizeRange(filterViewRange(view));
  const predicates =
    view.predicates !== undefined && view.predicates.length > 0
      ? view.predicates
      : isSheetFilterPredicateSpec(view.predicate)
        ? [view.predicate]
        : [];
  return predicates.map((predicate) => normalizeFilterPredicate(predicate, range));
}

function defaultFilterPredicate(
  viewOrRange: SheetFilterViewSpec | CellRange,
): SheetFilterPredicateSpec {
  const range =
    "range" in viewOrRange
      ? normalizeRange(filterViewRange(viewOrRange))
      : normalizeRange(viewOrRange);
  return {
    column: range.left,
    operator: "contains",
    value: "",
  };
}

function filterViewColumns(view: SheetFilterViewSpec): readonly number[] {
  const range = normalizeRange(filterViewRange(view));
  return Array.from({ length: range.right - range.left + 1 }, (_, index) => range.left + index);
}

function filterViewSortColumn(view: SheetFilterViewSpec): number {
  return filterPredicateColumn(view.sortColumn, normalizeRange(filterViewRange(view)));
}

function filterViewSortKeys(view: SheetFilterViewSpec): readonly number[] {
  return normalizedFilterViewSortKeys(view, normalizeRange(filterViewRange(view)));
}

function normalizedFilterViewSortKeys(
  view: SheetFilterViewSpec,
  range: NormalizedCellRange,
): readonly number[] {
  const rawKeys =
    view.sortKeys !== undefined && view.sortKeys.length > 0
      ? view.sortKeys
      : [view.sortColumn ?? range.left];
  const keys: number[] = [];
  for (const rawKey of rawKeys) {
    const key = filterPredicateColumn(rawKey, range);
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys.length === 0 ? [range.left] : keys;
}

function filterViewSecondarySortColumn(view: SheetFilterViewSpec): number | null {
  return filterViewSortKeys(view)[1] ?? null;
}

function normalizeFilterPredicate(
  predicate: SheetFilterPredicateSpec,
  range: NormalizedCellRange,
): SheetFilterPredicateSpec {
  return {
    column: filterPredicateColumn(predicate.column, range),
    operator: isSheetFilterPredicateOperator(predicate.operator) ? predicate.operator : "contains",
    value: predicate.value,
  };
}

function filterViewPredicateSummary(view: SheetFilterViewSpec): string {
  const activePredicates = filterViewPredicates(view).filter(filterPredicateIsActive);
  if (activePredicates.length === 0) {
    return "";
  }
  return activePredicates.map((predicate) => filterPredicateSummary(predicate)).join("");
}

function filterPredicateIsActive(predicate: SheetFilterPredicateSpec): boolean {
  return filterPredicateNeedsValue(predicate.operator) ? predicate.value.trim().length > 0 : true;
}

function filterPredicateSummary(predicate: SheetFilterPredicateSpec): string {
  const column = columnLetter(predicate.column);
  if (predicate.operator === "equals") {
    return ` · ${column} equals "${predicate.value.trim()}"`;
  }
  if (predicate.operator === "greaterThan") {
    return ` · ${column} > ${predicate.value.trim()}`;
  }
  if (predicate.operator === "notEmpty") {
    return ` · ${column} not empty`;
  }
  return ` · ${column} contains "${predicate.value.trim()}"`;
}

function filterPredicateNeedsValue(operator: SheetFilterPredicateOperator): boolean {
  return operator !== "notEmpty";
}

function filterPredicateOperatorLabel(operator: SheetFilterPredicateOperator): string {
  if (operator === "equals") return "equals";
  if (operator === "greaterThan") return "greater than";
  if (operator === "notEmpty") return "not empty";
  return "contains";
}

function filterViewSortLabel(view: SheetFilterViewSpec): string {
  const columns = filterViewSortKeys(view).map(columnLetter).join(", ");
  return `${columns} ${view.sortDirection === "asc" ? "A-Z" : "Z-A"}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function filterPredicateColumn(
  value: number | undefined,
  range: NormalizedCellRange | CellRange,
): number {
  const normalized = "left" in range ? range : normalizeRange(range);
  const left = Number.isFinite(normalized.left) ? normalized.left : 0;
  const right = Number.isFinite(normalized.right) ? normalized.right : left;
  return clampNumber(
    typeof value === "number" && Number.isFinite(value) ? value : left,
    left,
    right,
  );
}

function filterViewLabel(view: SheetFilterViewSpec): string {
  return rangeLabel(filterViewRange(view));
}

function sanitizeNamedRangeName(label: string): string {
  return label.replace(/[^A-Za-z0-9_]/g, "_");
}

function uniqueNamedRangeName(
  baseName: string,
  existingRanges: readonly SheetNamedRangeSpec[],
): string {
  const existingNames = new Set(existingRanges.map((range) => range.name));
  if (!existingNames.has(baseName)) {
    return baseName;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${baseName}_${String(index)}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  return `${baseName}_${String(Date.now())}`;
}

function uniqueFilterViewName(
  baseName: string,
  existingViews: readonly SheetFilterViewSpec[],
): string {
  const existingNames = new Set(existingViews.map((view) => view.name));
  if (!existingNames.has(baseName)) {
    return baseName;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${baseName}_${String(index)}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
  return `${baseName}_${String(Date.now())}`;
}

function cellProtectedRange(
  row: number,
  col: number,
  protectedRanges: readonly SheetProtectedRangeSpec[],
  activeTabId: string | null,
  predicate: (range: SheetProtectedRangeSpec) => boolean = () => true,
): SheetProtectedRangeSpec | null {
  return (
    protectedRanges.find(
      (range) =>
        predicate(range) &&
        (activeTabId === null || range.tabId === activeTabId) &&
        row >= Math.min(range.range.startRow, range.range.endRow) &&
        row <= Math.max(range.range.startRow, range.range.endRow) &&
        col >= Math.min(range.range.startCol, range.range.endCol) &&
        col <= Math.max(range.range.startCol, range.range.endCol),
    ) ?? null
  );
}

function cellBlockingProtectedRange(
  row: number,
  col: number,
  protectedRanges: readonly SheetProtectedRangeSpec[],
  activeTabId: string | null,
): SheetProtectedRangeSpec | null {
  return cellProtectedRange(row, col, protectedRanges, activeTabId, protectedRangeBlocksEdits);
}

function cellMergedRange(
  row: number,
  col: number,
  mergedRanges: readonly SheetMergedRangeSpec[],
  activeTabId: string | null,
): SheetMergedRangeSpec | null {
  return (
    mergedRanges.find(
      (range) =>
        (activeTabId === null || range.tabId === activeTabId) &&
        isCellInRange(row, col, mergedRangeToCellRange(range)),
    ) ?? null
  );
}

function cellIsCoveredByMergedRange(
  row: number,
  col: number,
  mergedRanges: readonly SheetMergedRangeSpec[],
  activeTabId: string | null,
): boolean {
  const mergedRange = cellMergedRange(row, col, mergedRanges, activeTabId);
  return mergedRange !== null && !isMergedRangeAnchor(row, col, mergedRange);
}

function isMergedRangeAnchor(row: number, col: number, range: SheetMergedRangeSpec): boolean {
  const anchor = mergedRangeAnchorCell(range);
  return row === anchor.row && col === anchor.col;
}

function mergedRangeAnchorCell(range: SheetMergedRangeSpec): CellAddress {
  const normalized = normalizeRange(mergedRangeToCellRange(range));
  return { row: normalized.top, col: normalized.left };
}

function rangeIntersectsMergedRanges(
  range: CellRange,
  mergedRanges: readonly SheetMergedRangeSpec[],
  activeTabId: string | null,
): boolean {
  const normalized = normalizeRange(range);
  return mergedRanges.some((mergedRange) => {
    if (activeTabId !== null && mergedRange.tabId !== activeTabId) {
      return false;
    }
    const merged = normalizeRange(mergedRangeToCellRange(mergedRange));
    return (
      normalized.left <= merged.right &&
      normalized.right >= merged.left &&
      normalized.top <= merged.bottom &&
      normalized.bottom >= merged.top
    );
  });
}

function rangeIntersectsProtectedRanges(
  range: CellRange,
  protectedRanges: readonly SheetProtectedRangeSpec[],
  activeTabId: string | null,
): boolean {
  return rangeIntersectsProtectedRangesMatching(range, protectedRanges, activeTabId, () => true);
}

function rangeIntersectsBlockingProtectedRanges(
  range: CellRange,
  protectedRanges: readonly SheetProtectedRangeSpec[],
  activeTabId: string | null,
): boolean {
  return rangeIntersectsProtectedRangesMatching(
    range,
    protectedRanges,
    activeTabId,
    protectedRangeBlocksEdits,
  );
}

function rangeIntersectsProtectedRangesMatching(
  range: CellRange,
  protectedRanges: readonly SheetProtectedRangeSpec[],
  activeTabId: string | null,
  predicate: (range: SheetProtectedRangeSpec) => boolean,
): boolean {
  const normalized = normalizeRange(range);
  return protectedRanges.some((protectedRange) => {
    if (!predicate(protectedRange)) {
      return false;
    }
    if (activeTabId !== null && protectedRange.tabId !== activeTabId) {
      return false;
    }
    const protectedTop = Math.min(protectedRange.range.startRow, protectedRange.range.endRow);
    const protectedBottom = Math.max(protectedRange.range.startRow, protectedRange.range.endRow);
    const protectedLeft = Math.min(protectedRange.range.startCol, protectedRange.range.endCol);
    const protectedRight = Math.max(protectedRange.range.startCol, protectedRange.range.endCol);
    return (
      normalized.left <= protectedRight &&
      normalized.right >= protectedLeft &&
      normalized.top <= protectedBottom &&
      normalized.bottom >= protectedTop
    );
  });
}

function isSheetChartSpec(value: unknown): value is SheetChartSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const chart = value as Record<string, unknown>;
  const range = chart.range;
  const placement = chart.placement;
  return (
    typeof chart.id === "string" &&
    isSheetChartType(chart.type) &&
    typeof chart.title === "string" &&
    typeof chart.tabId === "string" &&
    typeof range === "object" &&
    range !== null &&
    !Array.isArray(range) &&
    numberAnchorValue((range as Record<string, unknown>).startRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).startCol) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endCol) !== null &&
    (chart.labelCol === undefined || numberAnchorValue(chart.labelCol) !== null) &&
    (chart.valueCol === undefined || numberAnchorValue(chart.valueCol) !== null) &&
    (placement === undefined || isSheetChartPlacement(placement))
  );
}

function isSheetChartPlacement(value: unknown): value is SheetChartPlacement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const placement = value as Record<string, unknown>;
  return (
    numberAnchorValue(placement.anchorRow) !== null &&
    numberAnchorValue(placement.anchorCol) !== null &&
    numberAnchorValue(placement.rowSpan) !== null &&
    numberAnchorValue(placement.colSpan) !== null
  );
}

function isSheetChartType(value: unknown): value is SheetChartType {
  return (
    value === "bar" ||
    value === "line" ||
    value === "pie" ||
    value === "scatter" ||
    value === "combo" ||
    value === "sparkline"
  );
}

function isSheetImageSpec(value: unknown): value is SheetImageSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const image = value as Record<string, unknown>;
  return (
    typeof image.id === "string" &&
    typeof image.tabId === "string" &&
    typeof image.driveObjectId === "string" &&
    typeof image.src === "string" &&
    typeof image.alt === "string" &&
    typeof image.title === "string" &&
    typeof image.mimeType === "string" &&
    isSheetImagePlacement(image.placement)
  );
}

function isSheetImagePlacement(value: unknown): value is SheetImagePlacement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const placement = value as Record<string, unknown>;
  return (
    numberAnchorValue(placement.anchorRow) !== null &&
    numberAnchorValue(placement.anchorCol) !== null &&
    numberAnchorValue(placement.rowSpan) !== null &&
    numberAnchorValue(placement.colSpan) !== null
  );
}

function isSheetPivotTableSpec(value: unknown): value is SheetPivotTableSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const pivot = value as Record<string, unknown>;
  const range = pivot.range;
  const slicer = pivot.slicer;
  return (
    typeof pivot.id === "string" &&
    typeof pivot.tabId === "string" &&
    typeof pivot.title === "string" &&
    typeof pivot.rowFieldCol === "number" &&
    Number.isInteger(pivot.rowFieldCol) &&
    pivot.rowFieldCol >= 0 &&
    typeof pivot.valueFieldCol === "number" &&
    Number.isInteger(pivot.valueFieldCol) &&
    pivot.valueFieldCol >= 0 &&
    isSheetPivotAggregation(pivot.aggregation) &&
    (slicer === undefined || isSheetPivotSlicerSpec(slicer)) &&
    typeof range === "object" &&
    range !== null &&
    !Array.isArray(range) &&
    numberAnchorValue((range as Record<string, unknown>).startRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).startCol) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endRow) !== null &&
    numberAnchorValue((range as Record<string, unknown>).endCol) !== null
  );
}

function isSheetPivotSlicerSpec(value: unknown): value is SheetPivotSlicerSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const slicer = value as Record<string, unknown>;
  return (
    numberAnchorValue(slicer.column) !== null &&
    slicer.operator === "contains" &&
    typeof slicer.value === "string"
  );
}

function isSheetPivotAggregation(value: unknown): value is SheetPivotAggregation {
  return value === "sum" || value === "count";
}

function createSheetChartSpec(
  tabId: string,
  range: CellRange,
  chartType: SheetChartType,
): SheetChartSpec {
  const normalized = normalizeRange(range);
  return {
    id: newClientId("chart"),
    type: chartType,
    title: `Chart ${rangeLabel(range)}`,
    tabId,
    range: {
      startRow: normalized.top,
      startCol: normalized.left,
      endRow: normalized.bottom,
      endCol: normalized.right,
    },
    labelCol: normalized.left,
    valueCol: Math.min(normalized.left + 1, normalized.right),
    placement: defaultChartPlacementForRange(normalized),
  };
}

function createSheetImageSpec(input: {
  readonly tabId: string;
  readonly file: File;
  readonly driveObjectId: string;
  readonly placement: SheetImagePlacement;
}): SheetImageSpec {
  return {
    id: newClientId("image"),
    tabId: input.tabId,
    driveObjectId: input.driveObjectId,
    src: `/api/drive/objects/${encodeURIComponent(input.driveObjectId)}/content`,
    alt: sheetImageAltFromFilename(input.file.name),
    title: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
    placement: input.placement,
  };
}

function defaultSheetImagePlacementForAnchor(row: number, col: number): SheetImagePlacement {
  const rowSpan = 8;
  const colSpan = 4;
  return {
    anchorRow: clampNumber(row, 0, SHEET_MAX_ROWS - rowSpan),
    anchorCol: clampNumber(col, 0, SHEET_MAX_COLS - colSpan),
    rowSpan,
    colSpan,
  };
}

function movedSheetImagePlacement(
  placement: SheetImagePlacement,
  deltaRow: number,
  deltaCol: number,
): SheetImagePlacement {
  return {
    ...placement,
    anchorRow: clampNumber(placement.anchorRow + deltaRow, 0, SHEET_MAX_ROWS - placement.rowSpan),
    anchorCol: clampNumber(placement.anchorCol + deltaCol, 0, SHEET_MAX_COLS - placement.colSpan),
  };
}

function resizedSheetImagePlacement(
  placement: SheetImagePlacement,
  deltaRow: number,
  deltaCol: number,
): SheetImagePlacement {
  const maxRowSpan = SHEET_MAX_ROWS - placement.anchorRow;
  const maxColSpan = SHEET_MAX_COLS - placement.anchorCol;
  return {
    ...placement,
    rowSpan: clampNumber(placement.rowSpan + deltaRow, 1, maxRowSpan),
    colSpan: clampNumber(placement.colSpan + deltaCol, 1, maxColSpan),
  };
}

function sheetImagePlacementForDrag(
  drag: SheetImageDragState,
  deltaRow: number,
  deltaCol: number,
): SheetImagePlacement {
  return drag.mode === "resize"
    ? resizedSheetImagePlacement(drag.originalPlacement, deltaRow, deltaCol)
    : movedSheetImagePlacement(drag.originalPlacement, deltaRow, deltaCol);
}

function sheetImagePlacementEqual(left: SheetImagePlacement, right: SheetImagePlacement): boolean {
  return (
    left.anchorRow === right.anchorRow &&
    left.anchorCol === right.anchorCol &&
    left.rowSpan === right.rowSpan &&
    left.colSpan === right.colSpan
  );
}

function defaultChartPlacementForRange(range: NormalizedCellRange): SheetChartPlacement {
  const colSpan = 4;
  const targetCol = range.right + 1 <= SHEET_MAX_COLS - colSpan ? range.right + 1 : range.left;
  return defaultChartPlacementForAnchor(range.top, targetCol);
}

function defaultChartPlacementForAnchor(row: number, col: number): SheetChartPlacement {
  const rowSpan = 8;
  const colSpan = 4;
  return {
    anchorRow: clampNumber(row, 0, SHEET_MAX_ROWS - rowSpan),
    anchorCol: clampNumber(col, 0, SHEET_MAX_COLS - colSpan),
    rowSpan,
    colSpan,
  };
}

function createSheetPivotTableSpec(
  tabId: string,
  range: CellRange,
  existingPivots: readonly SheetPivotTableSpec[],
): SheetPivotTableSpec {
  const normalized = normalizeRange(range);
  return {
    id: newClientId("pivot"),
    tabId,
    title: uniquePivotTableTitle(`Pivot ${rangeLabel(range)}`, existingPivots),
    rowFieldCol: normalized.left,
    valueFieldCol: Math.min(normalized.left + 1, normalized.right),
    aggregation: "sum",
    range: {
      startRow: normalized.top,
      startCol: normalized.left,
      endRow: normalized.bottom,
      endCol: normalized.right,
    },
  };
}

function uniquePivotTableTitle(
  baseTitle: string,
  existingPivots: readonly SheetPivotTableSpec[],
): string {
  const existingTitles = new Set(existingPivots.map((pivot) => pivot.title));
  if (!existingTitles.has(baseTitle)) {
    return baseTitle;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseTitle} ${String(index)}`;
    if (!existingTitles.has(candidate)) {
      return candidate;
    }
  }
  return `${baseTitle} ${String(Date.now())}`;
}

function canCreatePivotTableFromRange(range: CellRange): boolean {
  const normalized = normalizeRange(range);
  return normalized.right > normalized.left && normalized.bottom > normalized.top;
}

function pivotRange(pivot: SheetPivotTableSpec): CellRange {
  return {
    start: {
      row: numberAnchorValue(pivot.range.startRow) ?? 0,
      col: numberAnchorValue(pivot.range.startCol) ?? 0,
    },
    end: {
      row: numberAnchorValue(pivot.range.endRow) ?? numberAnchorValue(pivot.range.startRow) ?? 0,
      col: numberAnchorValue(pivot.range.endCol) ?? numberAnchorValue(pivot.range.startCol) ?? 0,
    },
  };
}

function pivotColumns(pivot: SheetPivotTableSpec): readonly number[] {
  const range = normalizeRange(pivotRange(pivot));
  return Array.from({ length: range.right - range.left + 1 }, (_, index) => range.left + index);
}

function pivotSlicer(pivot: SheetPivotTableSpec): SheetPivotSlicerSpec {
  const range = normalizeRange(pivotRange(pivot));
  const slicer = isSheetPivotSlicerSpec(pivot.slicer) ? pivot.slicer : null;
  return {
    column: filterPredicateColumn(slicer?.column, range),
    operator: "contains",
    value: slicer?.value ?? "",
  };
}

function newClientId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? String(Date.now())}`;
}

const SHEET_DROPPED_IMAGE_EXTENSION =
  /\.(?:avif|bmp|gif|heic|heif|j2k|jfif|jpeg|jpg|jpe|jp2|jpf|jpm|jpx|jxl|png|svg|tif|tiff|webp)$/iu;

function droppedSheetImageFile(dataTransfer: DataTransfer): File | undefined {
  for (let index = 0; index < dataTransfer.items.length; index += 1) {
    const item = dataTransfer.items[index];
    if (item?.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file !== null && isDroppedSheetImageFile(file)) {
      return file;
    }
  }
  for (let index = 0; index < dataTransfer.files.length; index += 1) {
    const file = dataTransfer.files.item(index);
    if (file !== null && isDroppedSheetImageFile(file)) {
      return file;
    }
  }
  return undefined;
}

function isDroppedSheetImageFile(file: File): boolean {
  const mimeType = file.type.trim().toLowerCase();
  return mimeType.startsWith("image/") || SHEET_DROPPED_IMAGE_EXTENSION.test(file.name);
}

function hasDroppedSheetText(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).some(
    (type) => type === "text/plain" || type === "text/uri-list" || type === "text/html",
  );
}

function droppedSheetText(dataTransfer: DataTransfer): string {
  const plainText = safeDataTransferText(dataTransfer, "text/plain");
  if (plainText.trim().length > 0) {
    return plainText;
  }
  const uriList = firstDroppedUri(safeDataTransferText(dataTransfer, "text/uri-list"));
  if (uriList.length > 0) {
    return uriList;
  }
  const html = safeDataTransferText(dataTransfer, "text/html");
  return html.trim().length > 0 ? textFromDroppedHtml(html) : "";
}

function droppedSheetLinkUrl(dataTransfer: DataTransfer): string | undefined {
  const uriListUrl = normalizedSafeSheetLinkUrl(
    firstDroppedUri(safeDataTransferText(dataTransfer, "text/uri-list")),
  );
  if (uriListUrl !== undefined) {
    return uriListUrl;
  }
  const htmlUrl = linkUrlFromDroppedHtml(safeDataTransferText(dataTransfer, "text/html"));
  if (htmlUrl !== undefined) {
    return htmlUrl;
  }
  return normalizedSafeSheetLinkUrl(safeDataTransferText(dataTransfer, "text/plain"));
}

function safeDataTransferText(dataTransfer: DataTransfer, type: string): string {
  try {
    return dataTransfer.getData(type);
  } catch {
    return "";
  }
}

function firstDroppedUri(uriList: string): string {
  return (
    uriList
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? ""
  );
}

function textFromDroppedHtml(html: string): string {
  try {
    return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
  } catch {
    return html.replace(/<[^>]*>/gu, " ");
  }
}

function linkUrlFromDroppedHtml(html: string): string | undefined {
  if (html.trim().length === 0) {
    return undefined;
  }
  try {
    const href = new DOMParser()
      .parseFromString(html, "text/html")
      .querySelector<HTMLAnchorElement>("a[href]")
      ?.getAttribute("href");
    return normalizedSafeSheetLinkUrl(href ?? "");
  } catch {
    return undefined;
  }
}

function normalizedSafeSheetLinkUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function sheetImagePlacementFromDrop(
  event: DragEvent<HTMLElement>,
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
): SheetImagePlacement | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || visibleRows.length === 0 || visibleCols.length === 0) {
    return null;
  }
  const rowOffset = clampNumber(
    Math.floor((event.clientY - rect.top - SHEET_CELL_HEIGHT) / SHEET_CELL_HEIGHT),
    0,
    visibleRows.length - 1,
  );
  const colOffset = clampNumber(
    Math.floor((event.clientX - rect.left - SHEET_ROW_HEADER_WIDTH) / SHEET_CELL_WIDTH),
    0,
    visibleCols.length - 1,
  );
  const row = visibleRows[rowOffset]?.rowIndex ?? 0;
  const col = visibleCols[colOffset] ?? 0;
  return defaultSheetImagePlacementForAnchor(row, col);
}

function sheetCellFromDrop(
  event: DragEvent<HTMLElement>,
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
): CellAddress | null {
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || visibleRows.length === 0 || visibleCols.length === 0) {
    return null;
  }
  const rowOffset = Math.floor((event.clientY - rect.top - SHEET_CELL_HEIGHT) / SHEET_CELL_HEIGHT);
  const colOffset = Math.floor(
    (event.clientX - rect.left - SHEET_ROW_HEADER_WIDTH) / SHEET_CELL_WIDTH,
  );
  if (rowOffset < 0 || colOffset < 0) {
    return null;
  }
  const row = visibleRows[rowOffset]?.rowIndex;
  const col = visibleCols[colOffset];
  return row === undefined || col === undefined ? null : { row, col };
}

function sheetImageAltFromFilename(filename: string): string {
  const name = filename
    .trim()
    .replace(/\.[^.]+$/u, "")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return name.length > 0 ? name : "Spreadsheet image";
}

function chartDataFromGrid(chart: SheetChartSpec, grid: EditableGrid, displayGrid: EditableGrid) {
  const rows: Array<{ readonly label: string; readonly value: number }> = [];
  const range = chart.range;
  const labelCol = chartLabelColumn(chart);
  const valueCol = chartValueColumn(chart);
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const rawLabel = displayGrid[row]?.[labelCol]?.trim() ?? grid[row]?.[labelCol]?.trim();
    const rawValue = displayGrid[row]?.[valueCol]?.trim() ?? grid[row]?.[valueCol]?.trim() ?? "";
    const value = parseChartNumber(rawValue);
    if (rawLabel !== undefined && rawLabel.length > 0 && value !== null) {
      rows.push({ label: rawLabel, value });
    }
  }
  return rows;
}

function parseChartNumber(value: string): number | null {
  const parsed = Number(value.replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatChartValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function summarizeSelectedRange(
  range: CellRange,
  grid: EditableGrid,
  displayGrid: EditableGrid,
): SelectedRangeSummary {
  const normalized = normalizeRange(range);
  const numbers: number[] = [];
  let populatedCount = 0;
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      const value = selectedRangeDisplayValue(row, col, grid, displayGrid);
      if (value.trim().length === 0) {
        continue;
      }
      populatedCount += 1;
      const numericValue = parseSummaryNumber(value);
      if (numericValue !== null) {
        numbers.push(numericValue);
      }
    }
  }
  const cellCount =
    (normalized.bottom - normalized.top + 1) * (normalized.right - normalized.left + 1);
  if (numbers.length === 0) {
    return {
      cellCount,
      populatedCount,
      numberCount: 0,
      sum: null,
      average: null,
      min: null,
      max: null,
    };
  }
  const sum = numbers.reduce((total, value) => total + value, 0);
  return {
    cellCount,
    populatedCount,
    numberCount: numbers.length,
    sum,
    average: sum / numbers.length,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
  };
}

function selectedRangeDisplayValue(
  row: number,
  col: number,
  grid: EditableGrid,
  displayGrid: EditableGrid,
): string {
  return displayGrid[row]?.[col] ?? grid[row]?.[col] ?? "";
}

function parseSummaryNumber(value: string): number | null {
  return value.trim().length === 0 ? null : parseChartNumber(value);
}

function selectedRangeSummaryText(summary: SelectedRangeSummary): string {
  const parts = [
    `${String(summary.cellCount)} ${summary.cellCount === 1 ? "cell" : "cells"}`,
    `${String(summary.populatedCount)} populated`,
    `${String(summary.numberCount)} ${summary.numberCount === 1 ? "number" : "numbers"}`,
  ];
  if (
    summary.sum !== null &&
    summary.average !== null &&
    summary.min !== null &&
    summary.max !== null
  ) {
    parts.push(
      `Sum ${formatChartValue(summary.sum)}`,
      `Avg ${formatChartValue(summary.average)}`,
      `Min ${formatChartValue(summary.min)}`,
      `Max ${formatChartValue(summary.max)}`,
    );
  }
  return parts.join(" | ");
}

function chartRangeColumns(chart: SheetChartSpec): readonly number[] {
  const left = Math.min(chart.range.startCol, chart.range.endCol);
  const right = Math.max(chart.range.startCol, chart.range.endCol);
  return Array.from({ length: right - left + 1 }, (_, index) => left + index);
}

function chartLabelColumn(chart: SheetChartSpec): number {
  const columns = chartRangeColumns(chart);
  return columns.includes(chart.labelCol ?? -1)
    ? (chart.labelCol ?? columns[0] ?? 0)
    : (columns[0] ?? 0);
}

function chartValueColumn(chart: SheetChartSpec): number {
  const columns = chartRangeColumns(chart);
  const fallback = columns[1] ?? columns[0] ?? 0;
  return columns.includes(chart.valueCol ?? -1) ? (chart.valueCol ?? fallback) : fallback;
}

function SheetChartPreview({
  chart,
  grid,
  displayGrid,
  showDataTable = false,
}: {
  readonly chart: SheetChartSpec;
  readonly grid: EditableGrid;
  readonly displayGrid: EditableGrid;
  readonly showDataTable?: boolean;
}) {
  const rows = chartDataFromGrid(chart, grid, displayGrid);
  const maxValue = Math.max(1, ...rows.map((row) => Math.abs(row.value)));
  return (
    <div>
      <strong>{chart.title}</strong>
      <div style={COMMENT_META_STYLE}>
        {chart.type} · {chartRangeLabel(chart)}
      </div>
      {rows.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>Select labels and numeric values.</div>
      ) : chart.type === "line" ? (
        <SheetLineChart rows={rows} maxValue={maxValue} />
      ) : chart.type === "pie" ? (
        <SheetPieChart rows={rows} />
      ) : chart.type === "scatter" ? (
        <SheetScatterChart rows={rows} maxValue={maxValue} />
      ) : chart.type === "combo" ? (
        <SheetComboChart rows={rows} maxValue={maxValue} />
      ) : chart.type === "sparkline" ? (
        <SheetSparklineChart rows={rows} maxValue={maxValue} />
      ) : (
        <div style={CHART_BARS_STYLE}>
          {rows.map((row) => (
            <div key={row.label} style={CHART_BAR_ROW_STYLE}>
              <span className="truncate" style={CHART_LABEL_STYLE}>
                {row.label}
              </span>
              <span
                aria-label={`${row.label} ${String(row.value)}`}
                style={{
                  ...CHART_BAR_STYLE,
                  width: `${String(Math.max(6, (Math.abs(row.value) / maxValue) * 100))}%`,
                }}
              />
              <span style={CHART_VALUE_STYLE}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
      {showDataTable ? <SheetChartDataTable chart={chart} rows={rows} /> : null}
    </div>
  );
}

function SheetChartDataTable({
  chart,
  rows,
}: {
  readonly chart: SheetChartSpec;
  readonly rows: readonly { readonly label: string; readonly value: number }[];
}) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <table aria-label={`Chart data ${chart.title}`} style={SIDE_TABLE_STYLE}>
      <thead>
        <tr>
          <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
            Label
          </th>
          <th style={SIDE_TABLE_HEADER_STYLE} scope="col">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td style={SIDE_TABLE_CELL_STYLE}>{row.label}</td>
            <td style={SIDE_TABLE_CELL_STYLE}>{formatChartValue(row.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmbeddedSheetChart({
  chart,
  grid,
  displayGrid,
  visibleRows,
  visibleCols,
}: {
  readonly chart: SheetChartSpec;
  readonly grid: EditableGrid;
  readonly displayGrid: EditableGrid;
  readonly visibleRows: readonly VisibleSheetRow[];
  readonly visibleCols: readonly number[];
}) {
  if (chart.placement === undefined) {
    return null;
  }
  const style = embeddedChartStyle(chart.placement, visibleRows, visibleCols);
  if (style === null) {
    return null;
  }
  return (
    <div aria-label={`Embedded chart ${chart.title}`} style={style}>
      <SheetChartPreview chart={chart} grid={grid} displayGrid={displayGrid} />
    </div>
  );
}

function EmbeddedSheetImage({
  image,
  placement,
  selected,
  visibleRows,
  visibleCols,
  onSelect,
  onDelete,
  onDragStart,
  onResizeStart,
}: {
  readonly image: SheetImageSpec;
  readonly placement: SheetImagePlacement;
  readonly selected: boolean;
  readonly visibleRows: readonly VisibleSheetRow[];
  readonly visibleCols: readonly number[];
  readonly onSelect: (imageId: string) => void;
  readonly onDelete: (imageId: string) => void;
  readonly onDragStart: (event: ReactMouseEvent<HTMLElement>, image: SheetImageSpec) => void;
  readonly onResizeStart: (event: ReactMouseEvent<HTMLElement>, image: SheetImageSpec) => void;
}) {
  const style = embeddedImageStyle(placement, visibleRows, visibleCols, selected);
  if (style === null) {
    return null;
  }
  return (
    <figure
      aria-label={`Embedded image ${image.alt}`}
      aria-selected={selected}
      role="button"
      tabIndex={0}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(image.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Delete" && event.key !== "Backspace") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onDelete(image.id);
      }}
      onMouseDown={(event) => onDragStart(event, image)}
    >
      <img src={image.src} alt={image.alt} title={image.title} style={EMBEDDED_IMAGE_IMG_STYLE} />
      {selected ? (
        <button
          type="button"
          aria-label={`Resize embedded image ${image.alt}`}
          title="Resize"
          style={EMBEDDED_IMAGE_RESIZE_HANDLE_STYLE}
          onMouseDown={(event) => onResizeStart(event, image)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      ) : null}
    </figure>
  );
}

function embeddedImageStyle(
  placement: SheetImagePlacement,
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
  selected: boolean,
): CSSProperties | null {
  const rowOffset = visibleRowOffset(placement.anchorRow, visibleRows);
  const colOffset = visibleColOffset(placement.anchorCol, visibleCols);
  if (rowOffset === null || colOffset === null) {
    return null;
  }
  return {
    ...EMBEDDED_IMAGE_STYLE,
    borderColor: selected ? "var(--accent)" : "var(--border)",
    boxShadow: selected
      ? "0 0 0 2px rgba(124, 58, 237, 0.22), 0 8px 20px rgba(15, 23, 42, 0.14)"
      : EMBEDDED_IMAGE_STYLE.boxShadow,
    left: SHEET_ROW_HEADER_WIDTH + colOffset * SHEET_CELL_WIDTH,
    top: SHEET_CELL_HEIGHT + rowOffset * SHEET_CELL_HEIGHT,
    width: placement.colSpan * SHEET_CELL_WIDTH,
    height: placement.rowSpan * SHEET_CELL_HEIGHT,
  };
}

function embeddedChartStyle(
  placement: SheetChartPlacement,
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
): CSSProperties | null {
  const rowOffset = visibleRowOffset(placement.anchorRow, visibleRows);
  const colOffset = visibleColOffset(placement.anchorCol, visibleCols);
  if (rowOffset === null || colOffset === null) {
    return null;
  }
  return {
    ...EMBEDDED_CHART_STYLE,
    left: SHEET_ROW_HEADER_WIDTH + colOffset * SHEET_CELL_WIDTH,
    top: SHEET_CELL_HEIGHT + rowOffset * SHEET_CELL_HEIGHT,
    width: placement.colSpan * SHEET_CELL_WIDTH,
    height: placement.rowSpan * SHEET_CELL_HEIGHT,
  };
}

function fillHandlePlacementForRange(
  range: CellRange,
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
): { readonly left: number; readonly top: number } | null {
  const normalized = normalizeRange(range);
  const rowOffset = visibleRowOffset(normalized.bottom, visibleRows);
  const colOffset = visibleColOffset(normalized.right, visibleCols);
  if (rowOffset === null || colOffset === null) {
    return null;
  }
  return {
    left: SHEET_ROW_HEADER_WIDTH + (colOffset + 1) * SHEET_CELL_WIDTH,
    top: SHEET_CELL_HEIGHT + (rowOffset + 1) * SHEET_CELL_HEIGHT,
  };
}

function fillHandleStyle(placement: {
  readonly left: number;
  readonly top: number;
}): CSSProperties {
  return {
    ...FILL_HANDLE_STYLE,
    left: placement.left - 5,
    top: placement.top - 5,
  };
}

function fillPreviewStyle(
  range: CellRange,
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
): CSSProperties | null {
  const normalized = normalizeRange(range);
  const rowOffsets = visibleRowOffsetsForRange(normalized, visibleRows);
  const colOffsets = visibleColOffsetsForRange(normalized, visibleCols);
  if (rowOffsets.length === 0 || colOffsets.length === 0) {
    return null;
  }
  const rowTop = Math.min(...rowOffsets);
  const rowBottom = Math.max(...rowOffsets);
  const colLeft = Math.min(...colOffsets);
  const colRight = Math.max(...colOffsets);
  return {
    ...FILL_PREVIEW_STYLE,
    left: SHEET_ROW_HEADER_WIDTH + colLeft * SHEET_CELL_WIDTH,
    top: SHEET_CELL_HEIGHT + rowTop * SHEET_CELL_HEIGHT,
    width: (colRight - colLeft + 1) * SHEET_CELL_WIDTH,
    height: (rowBottom - rowTop + 1) * SHEET_CELL_HEIGHT,
  };
}

function cellAddressFromGridPoint(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  visibleRows: readonly number[],
  visibleCols: readonly number[],
): CellAddress | null {
  const colOffset = Math.floor((clientX - rect.left - SHEET_ROW_HEADER_WIDTH) / SHEET_CELL_WIDTH);
  const rowOffset = Math.floor((clientY - rect.top - SHEET_CELL_HEIGHT) / SHEET_CELL_HEIGHT);
  if (colOffset < 0 || rowOffset < 0) {
    return null;
  }
  const row = visibleRows[rowOffset];
  const col = visibleCols[colOffset];
  if (row === undefined || col === undefined) {
    return null;
  }
  return {
    row,
    col,
  };
}

function fillDragTargetFromGridPoint(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  visibleRows: readonly number[],
  visibleCols: readonly number[],
): CellAddress | null {
  const gridLeft = rect.left + SHEET_ROW_HEADER_WIDTH;
  const gridTop = rect.top + SHEET_CELL_HEIGHT;
  const gridRight = gridLeft + VISIBLE_COLS * SHEET_CELL_WIDTH;
  const gridBottom = gridTop + VISIBLE_ROWS * SHEET_CELL_HEIGHT;
  const x = Math.min(Math.max(clientX, gridLeft), gridRight - 1);
  const y = Math.min(Math.max(clientY, gridTop), gridBottom - 1);
  return cellAddressFromGridPoint(x, y, rect, visibleRows, visibleCols);
}

function pivotDataFromGrid(pivot: SheetPivotTableSpec, grid: EditableGrid) {
  const top = Math.min(pivot.range.startRow, pivot.range.endRow);
  const bottom = Math.max(pivot.range.startRow, pivot.range.endRow);
  const left = Math.min(pivot.range.startCol, pivot.range.endCol);
  const right = Math.max(pivot.range.startCol, pivot.range.endCol);
  const rowFieldCol = Math.min(Math.max(pivot.rowFieldCol, left), right);
  const valueFieldCol = Math.min(Math.max(pivot.valueFieldCol, left), right);
  const slicer = pivotSlicer(pivot);
  const slicerValue = slicer.value.trim().toLowerCase();
  const slicerCol = Math.min(Math.max(slicer.column, left), right);
  const firstDataRow = top < bottom ? top + 1 : top;
  const groups = new Map<string, { value: number; count: number }>();
  for (let row = firstDataRow; row <= bottom; row += 1) {
    if (slicerValue.length > 0) {
      const rawSlicerValue = grid[row]?.[slicerCol]?.trim().toLowerCase() ?? "";
      if (!rawSlicerValue.includes(slicerValue)) {
        continue;
      }
    }
    const rawLabel = grid[row]?.[rowFieldCol]?.trim() ?? "";
    const rawValue = grid[row]?.[valueFieldCol]?.trim() ?? "";
    if (rawLabel.length === 0 && rawValue.length === 0) {
      continue;
    }
    const label = rawLabel.length > 0 ? rawLabel : "(blank)";
    const current = groups.get(label) ?? { value: 0, count: 0 };
    const numericValue = Number(rawValue.replace(/[$,%\s,]/g, ""));
    groups.set(label, {
      value:
        pivot.aggregation === "sum" && Number.isFinite(numericValue)
          ? current.value + numericValue
          : current.value,
      count: current.count + 1,
    });
  }
  return Array.from(groups, ([label, group]) => ({
    label,
    value: pivot.aggregation === "count" ? group.count : group.value,
  }));
}

function SheetPivotTablePreview({
  pivot,
  grid,
}: {
  readonly pivot: SheetPivotTableSpec;
  readonly grid: EditableGrid;
}) {
  const rows = pivotDataFromGrid(pivot, grid);
  const maxValue = Math.max(1, ...rows.map((row) => Math.abs(row.value)));
  return (
    <div>
      <strong>{pivot.title}</strong>
      <div style={COMMENT_META_STYLE}>
        {pivot.aggregation} · {pivotRangeLabel(pivot)}
      </div>
      {rows.length === 0 ? (
        <div style={COMMENTS_EMPTY_STYLE}>Select row labels and numeric values.</div>
      ) : (
        <div style={CHART_BARS_STYLE}>
          {rows.map((row) => (
            <div key={row.label} style={CHART_BAR_ROW_STYLE}>
              <span className="truncate" style={CHART_LABEL_STYLE}>
                {row.label}
              </span>
              <span
                aria-label={`${row.label} pivot ${String(row.value)}`}
                style={{
                  ...CHART_BAR_STYLE,
                  width: `${String(Math.max(6, (Math.abs(row.value) / maxValue) * 100))}%`,
                }}
              />
              <span style={CHART_VALUE_STYLE}>{formatPivotValue(row.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SheetScatterChart({
  rows,
  maxValue,
}: {
  readonly rows: readonly { readonly label: string; readonly value: number }[];
  readonly maxValue: number;
}) {
  const width = 180;
  const height = 88;
  const padding = 10;
  const points = rows.map((row, index) => {
    const x =
      rows.length === 1 ? width / 2 : padding + (index / (rows.length - 1)) * (width - padding * 2);
    const y = height - padding - (Math.abs(row.value) / maxValue) * (height - padding * 2);
    return { ...row, x, y };
  });

  return (
    <svg
      aria-label="Scatter chart preview"
      role="img"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      style={CHART_LINE_SVG_STYLE}
    >
      <line
        x1={padding}
        x2={width - padding}
        y1={height - padding}
        y2={height - padding}
        stroke="var(--border)"
      />
      <line x1={padding} x2={padding} y1={padding} y2={height - padding} stroke="var(--border)" />
      {points.map((point, index) => (
        <circle
          key={point.label}
          aria-label={`Scatter point ${point.label} ${String(point.value)}`}
          cx={point.x}
          cy={point.y}
          r="4"
          fill={CHART_COLORS[index % CHART_COLORS.length]}
        />
      ))}
    </svg>
  );
}

function SheetComboChart({
  rows,
  maxValue,
}: {
  readonly rows: readonly { readonly label: string; readonly value: number }[];
  readonly maxValue: number;
}) {
  const width = 180;
  const height = 88;
  const padding = 10;
  const slotWidth = (width - padding * 2) / Math.max(1, rows.length);
  const points = rows.map((row, index) => {
    const x = padding + slotWidth * index + slotWidth / 2;
    const y = height - padding - (Math.abs(row.value) / maxValue) * (height - padding * 2);
    return { ...row, x, y };
  });
  const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <svg
      aria-label="Combo chart preview"
      role="img"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      style={CHART_LINE_SVG_STYLE}
    >
      {points.map((point, index) => {
        const barHeight = Math.max(4, height - padding - point.y);
        return (
          <rect
            key={point.label}
            aria-label={`Combo bar ${point.label} ${String(point.value)}`}
            x={point.x - Math.max(4, slotWidth * 0.24)}
            y={height - padding - barHeight}
            width={Math.max(8, slotWidth * 0.48)}
            height={barHeight}
            rx="2"
            fill={CHART_COLORS[index % CHART_COLORS.length]}
            opacity="0.45"
          />
        );
      })}
      <polyline points={pointString} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {points.map((point) => (
        <circle
          key={`${point.label}-line`}
          aria-label={`Combo point ${point.label} ${String(point.value)}`}
          cx={point.x}
          cy={point.y}
          r="3"
          fill="var(--accent)"
        />
      ))}
    </svg>
  );
}

function SheetSparklineChart({
  rows,
  maxValue,
}: {
  readonly rows: readonly { readonly label: string; readonly value: number }[];
  readonly maxValue: number;
}) {
  const width = 180;
  const height = 36;
  const padding = 4;
  const points = rows.map((row, index) => {
    const x =
      rows.length === 1 ? width / 2 : padding + (index / (rows.length - 1)) * (width - padding * 2);
    const y = height - padding - (Math.abs(row.value) / maxValue) * (height - padding * 2);
    return { ...row, x, y };
  });
  const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <svg
      aria-label="Sparkline chart preview"
      role="img"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      style={CHART_SPARKLINE_SVG_STYLE}
    >
      <polyline points={pointString} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {points.map((point) => (
        <circle
          key={point.label}
          aria-label={`Sparkline point ${point.label} ${String(point.value)}`}
          cx={point.x}
          cy={point.y}
          r="2.5"
          fill="var(--accent)"
        />
      ))}
    </svg>
  );
}

function SheetLineChart({
  rows,
  maxValue,
}: {
  readonly rows: readonly { readonly label: string; readonly value: number }[];
  readonly maxValue: number;
}) {
  const width = 180;
  const height = 72;
  const padding = 8;
  const points = rows.map((row, index) => {
    const x =
      rows.length === 1 ? width / 2 : padding + (index / (rows.length - 1)) * (width - padding * 2);
    const y = height - padding - (Math.abs(row.value) / maxValue) * (height - padding * 2);
    return { ...row, x, y };
  });
  const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <div style={CHART_LINE_WRAP_STYLE}>
      <svg
        aria-label="Line chart preview"
        role="img"
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        style={CHART_LINE_SVG_STYLE}
      >
        <polyline points={pointString} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {points.map((point) => (
          <circle
            key={point.label}
            aria-label={`Line point ${point.label} ${String(point.value)}`}
            cx={point.x}
            cy={point.y}
            r="3.5"
            fill="var(--accent)"
          />
        ))}
      </svg>
      <div style={CHART_LINE_LABELS_STYLE}>
        {points.map((point) => (
          <span key={point.label} className="truncate">
            {point.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function SheetPieChart({
  rows,
}: {
  readonly rows: readonly { readonly label: string; readonly value: number }[];
}) {
  const slices = rows.filter((row) => row.value > 0);
  const total = slices.reduce((sum, row) => sum + row.value, 0);
  if (total <= 0) {
    return <div style={COMMENTS_EMPTY_STYLE}>Pie charts require positive values.</div>;
  }

  let cursor = 0;
  const gradientStops = slices
    .map((row, index) => {
      const start = cursor;
      cursor += (row.value / total) * 100;
      const color = CHART_COLORS[index % CHART_COLORS.length];
      return `${color} ${String(start)}% ${String(cursor)}%`;
    })
    .join(", ");

  return (
    <div style={CHART_PIE_WRAP_STYLE}>
      <div
        aria-label="Pie chart preview"
        role="img"
        style={{
          ...CHART_PIE_STYLE,
          background: `conic-gradient(${gradientStops})`,
        }}
      />
      <div style={CHART_PIE_LEGEND_STYLE}>
        {slices.map((row, index) => {
          const percent = Math.round((row.value / total) * 100);
          const color = CHART_COLORS[index % CHART_COLORS.length];
          return (
            <div
              key={row.label}
              aria-label={`Pie slice ${row.label} ${String(row.value)}`}
              style={CHART_PIE_LEGEND_ROW_STYLE}
            >
              <span style={{ ...CHART_PIE_SWATCH_STYLE, background: color }} />
              <span className="truncate">{row.label}</span>
              <span>{percent}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function chartRangeLabel(chart: SheetChartSpec): string {
  return rangeLabel({
    start: { row: chart.range.startRow, col: chart.range.startCol },
    end: { row: chart.range.endRow, col: chart.range.endCol },
  });
}

function pivotRangeLabel(pivot: SheetPivotTableSpec): string {
  return rangeLabel({
    start: { row: pivot.range.startRow, col: pivot.range.startCol },
    end: { row: pivot.range.endRow, col: pivot.range.endCol },
  });
}

function formatPivotValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function sheetCommentAnchor({
  sheetId,
  tabId,
  range,
}: {
  readonly sheetId: string;
  readonly tabId: string;
  readonly range: CellRange;
}): Record<string, unknown> {
  const normalized = normalizeRange(range);
  return {
    type: "sheet-range",
    sheetId,
    tabId,
    label: rangeLabel(range),
    range: {
      startRow: normalized.top,
      startCol: normalized.left,
      endRow: normalized.bottom,
      endCol: normalized.right,
    },
  };
}

function isSheetRangeCommentForTab(comment: SheetsDriveComment, tabId: string | null): boolean {
  return (
    comment.anchor.type === "sheet-range" &&
    (tabId === null || typeof comment.anchor.tabId !== "string" || comment.anchor.tabId === tabId)
  );
}

function sheetCommentContainsCell(
  comment: SheetsDriveComment,
  tabId: string | null,
  row: number,
  col: number,
): boolean {
  if (!isSheetRangeCommentForTab(comment, tabId)) {
    return false;
  }
  const range = rangeFromSheetComment(comment);
  return range !== null && isCellInRange(row, col, range);
}

function rangeFromSheetComment(comment: SheetsDriveComment): CellRange | null {
  const range = comment.anchor.range;
  if (typeof range !== "object" || range === null || Array.isArray(range)) {
    return null;
  }
  const value = range as Record<string, unknown>;
  const startRow = numberAnchorValue(value.startRow);
  const startCol = numberAnchorValue(value.startCol);
  const endRow = numberAnchorValue(value.endRow);
  const endCol = numberAnchorValue(value.endCol);
  if (startRow === null || startCol === null || endRow === null || endCol === null) {
    return null;
  }
  return {
    start: { row: startRow, col: startCol },
    end: { row: endRow, col: endCol },
  };
}

function visibleCommentRangeOverlays(
  comments: readonly SheetsDriveComment[],
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
): readonly {
  readonly key: string;
  readonly label: string;
  readonly style: CSSProperties;
}[] {
  const overlays = new Map<
    string,
    { readonly key: string; readonly label: string; readonly style: CSSProperties }
  >();
  for (const comment of comments) {
    if (comment.parentCommentId !== null && comment.parentCommentId !== undefined) {
      continue;
    }
    const range = rangeFromSheetComment(comment);
    if (range === null) {
      continue;
    }
    const normalized = normalizeRange(range);
    const visibleRowOffsets = visibleRowOffsetsForRange(normalized, visibleRows);
    const visibleColOffsets = visibleColOffsetsForRange(normalized, visibleCols);
    for (const rowSegment of contiguousNumberSegments(visibleRowOffsets)) {
      for (const colSegment of contiguousNumberSegments(visibleColOffsets)) {
        const key = `${String(normalized.top)}:${String(normalized.left)}:${String(
          normalized.bottom,
        )}:${String(normalized.right)}:${String(rowSegment.start)}:${String(
          rowSegment.end,
        )}:${String(colSegment.start)}:${String(colSegment.end)}`;
        if (overlays.has(key)) {
          continue;
        }
        overlays.set(key, {
          key,
          label: sheetCommentLabel(comment),
          style: rangeOverlayStyle({
            startColOffset: colSegment.start,
            endColOffset: colSegment.end,
            startRowOffset: rowSegment.start,
            endRowOffset: rowSegment.end,
            base: COMMENT_RANGE_OVERLAY_STYLE,
          }),
        });
      }
    }
  }
  return [...overlays.values()];
}

function visibleMergedRangeOverlays(
  ranges: readonly SheetMergedRangeSpec[],
  visibleRows: readonly VisibleSheetRow[],
  visibleCols: readonly number[],
): readonly {
  readonly key: string;
  readonly label: string;
  readonly style: CSSProperties;
}[] {
  const overlays: {
    readonly key: string;
    readonly label: string;
    readonly style: CSSProperties;
  }[] = [];
  for (const range of ranges) {
    const normalized = normalizeRange(mergedRangeToCellRange(range));
    const visibleRowOffsets = visibleRowOffsetsForRange(normalized, visibleRows);
    const visibleColOffsets = visibleColOffsetsForRange(normalized, visibleCols);
    for (const rowSegment of contiguousNumberSegments(visibleRowOffsets)) {
      for (const colSegment of contiguousNumberSegments(visibleColOffsets)) {
        overlays.push({
          key: `${range.id}:${String(rowSegment.start)}:${String(rowSegment.end)}:${String(
            colSegment.start,
          )}:${String(colSegment.end)}`,
          label: range.label,
          style: rangeOverlayStyle({
            startColOffset: colSegment.start,
            endColOffset: colSegment.end,
            startRowOffset: rowSegment.start,
            endRowOffset: rowSegment.end,
            base: MERGED_RANGE_OVERLAY_STYLE,
          }),
        });
      }
    }
  }
  return overlays;
}

function contiguousNumberSegments(
  values: readonly number[],
): readonly { readonly start: number; readonly end: number }[] {
  if (values.length === 0) {
    return [];
  }
  const sorted = [...values].sort((left, right) => left - right);
  const segments: { start: number; end: number }[] = [];
  let start = sorted[0] ?? 0;
  let end = start;
  for (const value of sorted.slice(1)) {
    if (value === end + 1) {
      end = value;
      continue;
    }
    segments.push({ start, end });
    start = value;
    end = value;
  }
  segments.push({ start, end });
  return segments;
}

function visibleRowOffset(
  rowIndex: number,
  visibleRows: readonly VisibleSheetRow[],
): number | null {
  const offset = visibleRows.findIndex((row) => row.rowIndex === rowIndex);
  return offset < 0 ? null : offset;
}

function visibleColOffset(colIndex: number, visibleCols: readonly number[]): number | null {
  const offset = visibleCols.indexOf(colIndex);
  return offset < 0 ? null : offset;
}

function visibleRowOffsetsForRange(
  range: NormalizedCellRange,
  visibleRows: readonly VisibleSheetRow[],
): readonly number[] {
  return visibleRows
    .map((row, offset) => ({ rowIndex: row.rowIndex, offset }))
    .filter(({ rowIndex }) => rowIndex >= range.top && rowIndex <= range.bottom)
    .map(({ offset }) => offset);
}

function visibleColOffsetsForRange(
  range: NormalizedCellRange,
  visibleCols: readonly number[],
): readonly number[] {
  return visibleCols
    .map((colIndex, offset) => ({ colIndex, offset }))
    .filter(({ colIndex }) => colIndex >= range.left && colIndex <= range.right)
    .map(({ offset }) => offset);
}

function rangeOverlayStyle({
  startColOffset,
  endColOffset,
  startRowOffset,
  endRowOffset,
  base,
}: {
  readonly startColOffset: number;
  readonly endColOffset: number;
  readonly startRowOffset: number;
  readonly endRowOffset: number;
  readonly base: CSSProperties;
}): CSSProperties {
  return {
    ...base,
    left: SHEET_ROW_HEADER_WIDTH + startColOffset * SHEET_CELL_WIDTH,
    top: SHEET_CELL_HEIGHT + startRowOffset * SHEET_CELL_HEIGHT,
    width: (endColOffset - startColOffset + 1) * SHEET_CELL_WIDTH,
    height: (endRowOffset - startRowOffset + 1) * SHEET_CELL_HEIGHT,
  };
}

function frozenPaneForTab(
  panes: readonly SheetFrozenPaneSpec[],
  tabId: string | null,
): SheetFrozenPaneSpec {
  const pane = tabId === null ? undefined : panes.find((candidate) => candidate.tabId === tabId);
  return {
    tabId: tabId ?? "",
    frozenRows: Math.min(pane?.frozenRows ?? 0, VISIBLE_ROWS - 1, SHEET_MAX_ROWS),
    frozenCols: Math.min(pane?.frozenCols ?? 0, VISIBLE_COLS - 1, SHEET_MAX_COLS),
  };
}

function upsertFrozenPane(
  panes: readonly SheetFrozenPaneSpec[],
  tabId: string,
  next: { readonly frozenRows: number; readonly frozenCols: number },
): readonly SheetFrozenPaneSpec[] {
  const pane: SheetFrozenPaneSpec = {
    tabId,
    frozenRows: Math.min(next.frozenRows, VISIBLE_ROWS - 1, SHEET_MAX_ROWS),
    frozenCols: Math.min(next.frozenCols, VISIBLE_COLS - 1, SHEET_MAX_COLS),
  };
  const withoutTab = panes.filter((candidate) => candidate.tabId !== tabId);
  if (pane.frozenRows === 0 && pane.frozenCols === 0) {
    return withoutTab;
  }
  return [...withoutTab, pane];
}

function sheetTabWindowForViewport(
  viewport: CellAddress,
  frozenPane: SheetFrozenPaneSpec,
): SheetsCellWindow {
  return {
    startRow:
      frozenPane.frozenRows > 0
        ? 0
        : clampNumber(viewport.row - SHEET_WINDOW_ROW_MARGIN, 0, SHEET_MAX_ROWS - 1),
    startCol:
      frozenPane.frozenCols > 0
        ? 0
        : clampNumber(viewport.col - SHEET_WINDOW_COL_MARGIN, 0, SHEET_MAX_COLS - 1),
    endRow: clampNumber(
      viewport.row + VISIBLE_ROWS + SHEET_WINDOW_ROW_MARGIN - 1,
      0,
      SHEET_MAX_ROWS - 1,
    ),
    endCol: clampNumber(
      viewport.col + VISIBLE_COLS + SHEET_WINDOW_COL_MARGIN - 1,
      0,
      SHEET_MAX_COLS - 1,
    ),
  };
}

function mergeWindowCells(
  currentCells: readonly SheetsApiCell[],
  windowCells: readonly SheetsApiCell[],
  window: SheetsCellWindow,
): readonly SheetsApiCell[] {
  const normalized = normalizeCellWindow(window);
  const next = new Map(currentCells.map((cell) => [cellCoordinateKey(cell.row, cell.col), cell]));
  for (const cell of currentCells) {
    if (
      cell.row >= normalized.top &&
      cell.row <= normalized.bottom &&
      cell.col >= normalized.left &&
      cell.col <= normalized.right
    ) {
      next.delete(cellCoordinateKey(cell.row, cell.col));
    }
  }
  for (const cell of windowCells) {
    next.set(cellCoordinateKey(cell.row, cell.col), cell);
  }
  return [...next.values()].sort((left, right) =>
    left.row === right.row ? left.col - right.col : left.row - right.row,
  );
}

function normalizeCellWindow(window: SheetsCellWindow): NormalizedCellRange {
  return {
    top: Math.min(window.startRow, window.endRow),
    left: Math.min(window.startCol, window.endCol),
    bottom: Math.max(window.startRow, window.endRow),
    right: Math.max(window.startCol, window.endCol),
  };
}

function numberAnchorValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function sheetCommentLabel(comment: SheetsDriveComment): string {
  return typeof comment.anchor.label === "string" ? comment.anchor.label : "Sheet range";
}

function commentAuthorLabel(comment: SheetsDriveComment): string {
  return comment.author?.displayName ?? comment.author?.email ?? comment.actorId ?? "Unknown";
}

function emptyCommentsLabel(status: SheetsCommentStatus): string {
  if (status === "open") return "No open comments.";
  if (status === "resolved") return "No resolved comments.";
  return "No comments.";
}

function sheetCommentThreads(comments: readonly SheetsDriveComment[]): readonly {
  readonly comment: SheetsDriveComment;
  readonly replies: readonly SheetsDriveComment[];
}[] {
  const commentIds = new Set(comments.map((comment) => comment.id));
  const roots: SheetsDriveComment[] = [];
  const repliesByParent = new Map<string, SheetsDriveComment[]>();

  for (const comment of comments) {
    if (
      comment.parentCommentId === null ||
      comment.parentCommentId === undefined ||
      !commentIds.has(comment.parentCommentId)
    ) {
      roots.push(comment);
    } else {
      const replies = repliesByParent.get(comment.parentCommentId) ?? [];
      replies.push(comment);
      repliesByParent.set(comment.parentCommentId, replies);
    }
  }

  return roots.map((comment) => ({
    comment,
    replies: repliesByParent.get(comment.id) ?? [],
  }));
}

function clipboardTextForRange(grid: EditableGrid, range: CellRange): string {
  const normalized = normalizeRange(range);
  const rows: string[] = [];
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    const values: string[] = [];
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      values.push(grid[row]?.[col] ?? "");
    }
    rows.push(values.join("\t"));
  }
  return rows.join("\n");
}

function formattedClipboardTextForRange(
  grid: EditableGrid,
  range: CellRange,
  formatMap: ReadonlyMap<string, CellFormat>,
): string {
  const normalized = normalizeRange(range);
  const rows: FormattedClipboardCell[][] = [];
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    const cells: FormattedClipboardCell[] = [];
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      cells.push({
        value: grid[row]?.[col] ?? "",
        format: { ...(formatMap.get(cellCoordinateKey(row, col)) ?? {}) },
      });
    }
    rows.push(cells);
  }
  return JSON.stringify({ version: 1, rows });
}

function clearedCellEditsForRange(range: CellRange): SheetsCellEdit[] {
  const normalized = normalizeRange(range);
  const edits: SheetsCellEdit[] = [];
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      edits.push({ row, col, value: "", format: {} });
    }
  }
  return edits;
}

function editsFromFormattedClipboard(
  formattedCells: string,
  startRow: number,
  startCol: number,
): SheetsCellEdit[] | null {
  const rows = parseFormattedClipboardRows(formattedCells);
  if (rows === null) {
    return null;
  }
  const edits: SheetsCellEdit[] = [];
  rows.forEach((row, rowOffset) => {
    row.forEach((cell, colOffset) => {
      edits.push({
        row: startRow + rowOffset,
        col: startCol + colOffset,
        value: cell.value,
        format: { ...cell.format },
      });
    });
  });
  return edits;
}

function parseFormattedClipboardRows(value: string): FormattedClipboardCell[][] | null {
  if (value.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const rows = (parsed as { readonly rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    return null;
  }
  const formattedRows: FormattedClipboardCell[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      return null;
    }
    const formattedRow: FormattedClipboardCell[] = [];
    for (const cell of row) {
      if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
        return null;
      }
      const value = (cell as { readonly value?: unknown }).value;
      const format = (cell as { readonly format?: unknown }).format;
      if (typeof value !== "string" || !isCellFormatObject(format)) {
        return null;
      }
      formattedRow.push({ value, format: { ...format } });
    }
    formattedRows.push(formattedRow);
  }
  return formattedRows;
}

function isCellFormatObject(value: unknown): value is CellFormat {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editsFromClipboardText(
  text: string,
  startRow: number,
  startCol: number,
  previous: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
  droppedLinkUrl?: string,
): SheetsCellEdit[] {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.endsWith("\n")
    ? normalizedText.slice(0, -1).split("\n")
    : normalizedText.split("\n");
  const singleCellDrop = lines.length === 1 && !lines[0]?.includes("\t");
  const edits: SheetsCellEdit[] = [];
  lines.forEach((line, rowOffset) => {
    line.split("\t").forEach((value, colOffset) => {
      const row = startRow + rowOffset;
      const col = startCol + colOffset;
      const edit = cellEditWithAutoLink(
        previous,
        formatMap,
        row,
        col,
        value,
        singleCellDrop && rowOffset === 0 && colOffset === 0 ? droppedLinkUrl : undefined,
      );
      if (edit !== null) {
        edits.push(edit);
      }
    });
  });
  return edits;
}

function cellEditWithAutoLink(
  previous: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
  row: number,
  col: number,
  value: string,
  explicitLinkUrl?: string,
): SheetsCellEdit | null {
  const valueEdit = diffCellEdit(previous, row, col, value);
  const existingFormat = formatMap.get(cellCoordinateKey(row, col)) ?? {};
  const nextFormat = autoLinkedCellFormat(existingFormat, value, explicitLinkUrl);
  const formatChanged =
    nextFormat !== null && JSON.stringify(nextFormat) !== JSON.stringify(existingFormat);
  if (valueEdit === null && !formatChanged) {
    return null;
  }
  return {
    row,
    col,
    value,
    ...(formatChanged && nextFormat !== null ? { format: nextFormat } : {}),
  };
}

function autoLinkedCellFormat(
  existing: CellFormat,
  value: string,
  explicitLinkUrl?: string,
): CellFormat | null {
  const linkUrl = normalizedSafeSheetLinkUrl(explicitLinkUrl ?? value);
  const currentLinkUrl = formatCellLinkUrl(existing.linkUrl);
  if (linkUrl !== undefined) {
    return mergeCellFormat(existing, { linkUrl });
  }
  if (currentLinkUrl.length > 0) {
    return mergeCellFormat(existing, { linkUrl: null });
  }
  return null;
}

function copyFillEdits(
  sourceRange: CellRange,
  fillRange: CellRange,
  grid: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
): SheetsCellEdit[] {
  const source = normalizeRange(sourceRange);
  const fill = normalizeRange(fillRange);
  const rowCount = source.bottom - source.top + 1;
  const colCount = source.right - source.left + 1;
  const edits: SheetsCellEdit[] = [];
  const fillsDown = fill.bottom > source.bottom && fill.right === source.right;
  const fillsRight = fill.right > source.right && fill.bottom === source.bottom;
  const pushEdit = (row: number, col: number) => {
    const sourceRow = source.top + ((row - source.top) % rowCount);
    const sourceCol = source.left + ((col - source.left) % colCount);
    const sourceFormat = formatMap.get(cellCoordinateKey(sourceRow, sourceCol));
    const sourceValue = grid[sourceRow]?.[sourceCol] ?? "";
    const seriesValue = fillsDown
      ? verticalSeriesFillValue(source, col, row, grid)
      : fillsRight
        ? horizontalSeriesFillValue(source, row, col, grid)
        : null;
    const edit: SheetsCellEdit = {
      row,
      col,
      value:
        seriesValue ?? shiftFormulaReferencesForFill(sourceValue, row - sourceRow, col - sourceCol),
      ...(sourceFormat === undefined ? {} : { format: sourceFormat }),
    };
    edits.push(edit);
  };
  if (fillsDown) {
    for (let row = source.bottom + 1; row <= fill.bottom; row += 1) {
      for (let col = source.left; col <= source.right; col += 1) {
        pushEdit(row, col);
      }
    }
  }
  if (fillsRight) {
    for (let row = source.top; row <= source.bottom; row += 1) {
      for (let col = source.right + 1; col <= fill.right; col += 1) {
        pushEdit(row, col);
      }
    }
  }
  return edits;
}

function verticalSeriesFillValue(
  source: NormalizedCellRange,
  col: number,
  targetRow: number,
  grid: EditableGrid,
): string | null {
  const values: string[] = [];
  for (let row = source.top; row <= source.bottom; row += 1) {
    values.push(grid[row]?.[col] ?? "");
  }
  return fillSeriesValue(values, targetRow - source.bottom);
}

function horizontalSeriesFillValue(
  source: NormalizedCellRange,
  row: number,
  targetCol: number,
  grid: EditableGrid,
): string | null {
  const values: string[] = [];
  for (let col = source.left; col <= source.right; col += 1) {
    values.push(grid[row]?.[col] ?? "");
  }
  return fillSeriesValue(values, targetCol - source.right);
}

function fillSeriesValue(values: readonly string[], offset: number): string | null {
  if (
    values.length < 2 ||
    offset <= 0 ||
    values.some((value) => value.trimStart().startsWith("="))
  ) {
    return null;
  }
  const numbers = values.map(parseSeriesNumber);
  if (numbers.every((value): value is number => value !== null)) {
    const last = numbers.at(-1);
    const previous = numbers.at(-2);
    if (last === undefined || previous === undefined) {
      return null;
    }
    const step = last - previous;
    const next = last + step * offset;
    return formatSeriesNumber(next, values);
  }
  const dates = values.map(parseSeriesDate);
  if (dates.every((value): value is SeriesDateValue => value !== null)) {
    const last = dates.at(-1);
    const previous = dates.at(-2);
    if (last === undefined || previous === undefined || !seriesDatesShareFormat(dates)) {
      return null;
    }
    const step = last.time - previous.time;
    if (step % MS_PER_DAY !== 0) {
      return null;
    }
    return formatSeriesDate(last.time + step * offset, last.format);
  }
  return null;
}

function shiftFormulaReferencesForFill(value: string, rowDelta: number, colDelta: number): string {
  if (!value.trimStart().startsWith("=") || (rowDelta === 0 && colDelta === 0)) {
    return value;
  }
  return value.replace(
    /\b(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)\b/g,
    (match, colAbsolute: string, colLabel: string, rowAbsolute: string, rowLabel: string) => {
      const col = columnIndexFromLabel(colLabel);
      const row = Number.parseInt(rowLabel, 10) - 1;
      if (col === null || !Number.isFinite(row)) {
        return match;
      }
      const nextCol = colAbsolute === "$" ? col : clampGridCol(col + colDelta);
      const nextRow = rowAbsolute === "$" ? row : clampGridRow(row + rowDelta);
      return `${colAbsolute}${columnLetter(nextCol)}${rowAbsolute}${String(nextRow + 1)}`;
    },
  );
}

function parseSeriesNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSeriesNumber(value: number, sourceValues: readonly string[]): string {
  const decimals = Math.max(...sourceValues.map((sourceValue) => decimalPlaces(sourceValue)));
  return decimals === 0 ? String(value) : value.toFixed(decimals);
}

function decimalPlaces(value: string): number {
  const decimal = value.trim().split(".")[1];
  return decimal?.length ?? 0;
}

function parseSeriesDate(value: string): SeriesDateValue | null {
  const trimmed = value.trim();
  const iso = parseIsoSeriesDate(trimmed);
  if (iso !== null) {
    return { time: iso, format: { kind: "iso" } };
  }
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slash !== null) {
    const monthLabel = slash[1] ?? "";
    const dayLabel = slash[2] ?? "";
    const date = parseUtcDateParts(slash[3] ?? "", monthLabel, dayLabel);
    if (date !== null) {
      return {
        time: date,
        format: { kind: "slash", monthWidth: monthLabel.length, dayWidth: dayLabel.length },
      };
    }
  }
  const monthName = /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/.exec(trimmed);
  if (monthName !== null) {
    const month = monthIndexFromName(monthName[1] ?? "");
    const year = monthName[3] ?? "";
    const day = monthName[2] ?? "";
    const date = month === null ? null : parseUtcDateParts(year, String(month + 1), day);
    if (date !== null) {
      return {
        time: date,
        format: {
          kind: "monthName",
          style: (monthName[1] ?? "").length <= 3 ? "short" : "long",
        },
      };
    }
  }
  return null;
}

function parseIsoSeriesDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  return parseUtcDateParts(match[1] ?? "", match[2] ?? "", match[3] ?? "");
}

function parseUtcDateParts(yearLabel: string, monthLabel: string, dayLabel: string): number | null {
  const year = Number.parseInt(yearLabel, 10);
  const month = Number.parseInt(monthLabel, 10);
  const day = Number.parseInt(dayLabel, 10);
  const date = Date.UTC(year, month - 1, day);
  const parsed = new Date(date);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function seriesDatesShareFormat(values: readonly SeriesDateValue[]): boolean {
  const first = values[0];
  if (first === undefined) {
    return false;
  }
  return values.every((value) => seriesDateFormatsMatch(first.format, value.format));
}

function seriesDateFormatsMatch(left: SeriesDateFormat, right: SeriesDateFormat): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "slash" && right.kind === "slash") {
    return left.monthWidth === right.monthWidth && left.dayWidth === right.dayWidth;
  }
  if (left.kind === "monthName" && right.kind === "monthName") {
    return left.style === right.style;
  }
  return true;
}

function formatSeriesDate(value: number, format: SeriesDateFormat): string {
  const date = new Date(value);
  if (format.kind === "iso") {
    return date.toISOString().slice(0, 10);
  }
  if (format.kind === "slash") {
    return [
      String(date.getUTCMonth() + 1).padStart(format.monthWidth, "0"),
      String(date.getUTCDate()).padStart(format.dayWidth, "0"),
      String(date.getUTCFullYear()),
    ].join("/");
  }
  return new Intl.DateTimeFormat("en-US", {
    month: format.style,
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function monthIndexFromName(value: string): number | null {
  const normalized = value.toLowerCase();
  const index = SERIES_MONTH_NAMES.findIndex(
    (month) => month.short === normalized || month.long === normalized,
  );
  return index < 0 ? null : index;
}

function columnIndexFromLabel(label: string): number | null {
  let index = 0;
  for (const char of label) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) {
      return null;
    }
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function formatEditsForRange(
  range: CellRange,
  grid: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
  patch: CellFormat,
): SheetsCellEdit[] {
  const normalized = normalizeRange(range);
  const edits: SheetsCellEdit[] = [];
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      const existing = formatMap.get(cellCoordinateKey(row, col)) ?? {};
      edits.push({
        row,
        col,
        value: grid[row]?.[col] ?? "",
        format: mergeCellFormat(existing, patch),
      });
    }
  }
  return edits;
}

function sortEditsForRange(
  range: CellRange,
  grid: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
  direction: SortDirection,
): SheetsCellEdit[] {
  const normalized = normalizeRange(range);
  const rows = Array.from({ length: normalized.bottom - normalized.top + 1 }, (_, rowOffset) => {
    const row = normalized.top + rowOffset;
    return {
      row,
      rowOffset,
      cells: Array.from({ length: normalized.right - normalized.left + 1 }, (_, colOffset) => {
        const col = normalized.left + colOffset;
        return {
          value: grid[row]?.[col] ?? "",
          format: formatMap.get(cellCoordinateKey(row, col)) ?? {},
        };
      }),
    };
  }).sort((left, right) => {
    const compared = compareSheetSortValues(
      left.cells[0]?.value ?? "",
      right.cells[0]?.value ?? "",
    );
    return compared === 0
      ? left.rowOffset - right.rowOffset
      : direction === "asc"
        ? compared
        : -compared;
  });

  const edits: SheetsCellEdit[] = [];
  rows.forEach((sourceRow, rowOffset) => {
    const row = normalized.top + rowOffset;
    sourceRow.cells.forEach((cell, colOffset) => {
      const col = normalized.left + colOffset;
      edits.push({
        row,
        col,
        value: shiftFormulaReferencesForFill(cell.value, row - sourceRow.row, 0),
        format: { ...cell.format },
      });
    });
  });
  return edits;
}

function compareSheetSortValues(left: string, right: string): number {
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (leftTrimmed.length === 0 || rightTrimmed.length === 0) {
    if (leftTrimmed.length === rightTrimmed.length) {
      return 0;
    }
    return leftTrimmed.length === 0 ? 1 : -1;
  }
  const leftNumber = Number(leftTrimmed.replace(/[$,\s]/gu, ""));
  const rightNumber = Number(rightTrimmed.replace(/[$,\s]/gu, ""));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return leftTrimmed.localeCompare(rightTrimmed, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function borderEditsForRange(
  range: CellRange,
  grid: EditableGrid,
  formatMap: ReadonlyMap<string, CellFormat>,
  preset: BorderPreset,
): SheetsCellEdit[] {
  const normalized = normalizeRange(range);
  const edits: SheetsCellEdit[] = [];
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      const existing = formatMap.get(cellCoordinateKey(row, col)) ?? {};
      edits.push({
        row,
        col,
        value: grid[row]?.[col] ?? "",
        format: mergeCellFormat(existing, {
          borders:
            preset === "none"
              ? ""
              : borderFormatForCell({
                  preset,
                  row,
                  col,
                  range: normalized,
                }),
        }),
      });
    }
  }
  return edits;
}

function borderFormatForCell({
  preset,
  row,
  col,
  range,
}: {
  readonly preset: Exclude<BorderPreset, "none">;
  readonly row: number;
  readonly col: number;
  readonly range: ReturnType<typeof normalizeRange>;
}): Record<string, boolean> {
  if (preset === "all") {
    return { top: true, right: true, bottom: true, left: true };
  }

  const borders: Record<string, boolean> = {};
  if (row === range.top) borders.top = true;
  if (col === range.right) borders.right = true;
  if (row === range.bottom) borders.bottom = true;
  if (col === range.left) borders.left = true;
  return borders;
}

function mergeCellFormat(existing: CellFormat, patch: CellFormat): CellFormat {
  const next: CellFormat = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === false || value === null || value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

function formatBoolean(value: unknown): boolean {
  return value === true;
}

function formatAlign(value: unknown): HorizontalAlign {
  return value === "center" || value === "right" ? value : "left";
}

function formatVerticalAlign(value: unknown): SheetsVerticalAlign {
  return value === "middle" || value === "bottom" ? value : "top";
}

function cellVisualAlignItems(value: SheetsVerticalAlign): "flex-start" | "center" | "flex-end" {
  if (value === "middle") {
    return "center";
  }
  if (value === "bottom") {
    return "flex-end";
  }
  return "flex-start";
}

function cellVisualOverflowPlacement({
  displayRow,
  focused,
  coveredByMerge,
  col,
  renderedValue,
  textAlign,
  visibleCols,
  wrapText,
}: {
  readonly displayRow: readonly string[];
  readonly focused: boolean;
  readonly coveredByMerge: boolean;
  readonly col: number;
  readonly renderedValue: string;
  readonly textAlign: HorizontalAlign;
  readonly visibleCols: readonly number[];
  readonly wrapText: boolean;
}): { readonly span: number; readonly offsetPx: number } {
  if (focused || coveredByMerge || wrapText || renderedValue.trim().length === 0) {
    return { span: 1, offsetPx: 0 };
  }

  const visibleIndex = visibleCols.indexOf(col);
  if (visibleIndex < 0) {
    return { span: 1, offsetPx: 0 };
  }

  let span = 1;
  if (textAlign === "center") {
    let leftSpan = 0;
    let previousLeftCol = col;
    for (let index = visibleIndex - 1; index >= 0; index -= 1) {
      const nextCol = visibleCols[index];
      if (nextCol !== previousLeftCol - 1) {
        break;
      }
      const nextValue = displayRow[nextCol] ?? "";
      if (nextValue.trim().length > 0) {
        break;
      }
      leftSpan += 1;
      previousLeftCol = nextCol;
    }

    let rightSpan = 0;
    let previousRightCol = col;
    for (let index = visibleIndex + 1; index < visibleCols.length; index += 1) {
      const nextCol = visibleCols[index];
      if (nextCol !== previousRightCol + 1) {
        break;
      }
      const nextValue = displayRow[nextCol] ?? "";
      if (nextValue.trim().length > 0) {
        break;
      }
      rightSpan += 1;
      previousRightCol = nextCol;
    }

    return {
      span: leftSpan + 1 + rightSpan,
      offsetPx: -leftSpan * SHEET_CELL_WIDTH,
    };
  }

  if (textAlign === "right") {
    let previousCol = col;
    for (let index = visibleIndex - 1; index >= 0; index -= 1) {
      const nextCol = visibleCols[index];
      if (nextCol !== previousCol - 1) {
        break;
      }
      const nextValue = displayRow[nextCol] ?? "";
      if (nextValue.trim().length > 0) {
        break;
      }
      span += 1;
      previousCol = nextCol;
    }
    return { span, offsetPx: -(span - 1) * SHEET_CELL_WIDTH };
  }

  let previousCol = col;
  for (let index = visibleIndex + 1; index < visibleCols.length; index += 1) {
    const nextCol = visibleCols[index];
    if (nextCol !== previousCol + 1) {
      break;
    }
    const nextValue = displayRow[nextCol] ?? "";
    if (nextValue.trim().length > 0) {
      break;
    }
    span += 1;
    previousCol = nextCol;
  }
  return { span, offsetPx: 0 };
}

function formatFontFamily(value: unknown): string | undefined {
  switch (value) {
    case "sans":
      return "Arial, Helvetica, sans-serif";
    case "serif":
      return "Georgia, 'Times New Roman', serif";
    case "mono":
      return "'SFMono-Regular', Consolas, 'Liberation Mono', monospace";
    default:
      return undefined;
  }
}

function formatFontSize(value: unknown): string | undefined {
  return typeof value === "string" && /^(10|11|12|14|18)$/u.test(value) ? `${value}px` : undefined;
}

function formatTextDecoration(format: CellFormat, linkPreview: boolean): string | undefined {
  const decorations = [
    linkPreview || formatBoolean(format.underline) ? "underline" : undefined,
    formatBoolean(format.strikethrough) ? "line-through" : undefined,
  ].filter((value): value is string => value !== undefined);
  return decorations.length === 0 ? undefined : decorations.join(" ");
}

function formatCellLinkUrl(value: unknown): string {
  return typeof value === "string" && normalizedSafeSheetLinkUrl(value) !== undefined ? value : "";
}

function formatNumberFormat(value: unknown, customNumberFormat?: unknown): NumberFormat {
  if (
    value === "custom" ||
    (typeof customNumberFormat === "string" && customNumberFormat.trim().length > 0)
  ) {
    return "custom";
  }
  return value === "number" || value === "currency" || value === "percent" || value === "date"
    ? value
    : "plain";
}

function numberFormatPatch(format: NumberFormat, currentCustomNumberFormat: unknown): CellFormat {
  if (format === "plain") {
    return { numberFormat: "", customNumberFormat: "" };
  }
  if (format === "custom") {
    return {
      numberFormat: "custom",
      customNumberFormat: formatCustomNumberFormat(currentCustomNumberFormat),
    };
  }
  return { numberFormat: format, customNumberFormat: "" };
}

export function adjustSheetDecimalFormat(format: CellFormat, delta: -1 | 1): CellFormat {
  const numberFormat = formatNumberFormat(format.numberFormat, format.customNumberFormat);
  const currentCustom =
    typeof format.customNumberFormat === "string" ? format.customNumberFormat.trim() : "";
  const currentDecimals =
    currentCustom.match(/\.(0+)/u)?.[1]?.length ??
    (numberFormat === "currency" || numberFormat === "custom" ? 2 : 0);
  const nextDecimals = clampNumber(currentDecimals + delta, 0, 10);
  const decimalSuffix = nextDecimals === 0 ? "" : `.${"0".repeat(nextDecimals)}`;
  const basePattern =
    currentCustom.length > 0
      ? currentCustom
          .split(";")
          .map((section) => section.replace(/\.(0+)/gu, "").replace(/(?=%|$)/u, decimalSuffix))
          .join(";")
      : numberFormat === "currency"
        ? `$#,##0${decimalSuffix}`
        : numberFormat === "percent"
          ? `0${decimalSuffix}%`
          : `#,##0${decimalSuffix}`;
  return {
    numberFormat: "custom",
    customNumberFormat: basePattern,
  };
}

function formatCustomNumberFormat(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "#,##0.00";
}

function formatDataValidationKind(value: unknown): DataValidationKind {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "none";
  }
  const type = (value as Record<string, unknown>).type;
  return type === "number" ||
    type === "email" ||
    type === "url" ||
    type === "date" ||
    type === "list" ||
    type === "customFormula"
    ? type
    : "none";
}

function formatDataValidationMode(value: unknown): DataValidationMode {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "warn";
  }
  return (value as Record<string, unknown>).mode === "reject" ? "reject" : "warn";
}

function dataValidationPatch(
  kind: DataValidationKind,
  currentValidation: unknown,
): CellFormat | string {
  if (kind === "none") {
    return "";
  }
  const mode = formatDataValidationMode(currentValidation);
  if (kind === "list") {
    const namedRangeId = dataValidationNamedRangeId(currentValidation);
    if (namedRangeId !== null) {
      return {
        type: "list",
        namedRangeId,
        ...dataValidationModePatch(mode),
      };
    }
    const choices = parseDataValidationChoices(dataValidationChoicesText(currentValidation));
    return {
      type: "list",
      ...dataValidationModePatch(mode),
      choices: choices.length > 0 ? choices : ["Approved", "Pending", "Blocked"],
    };
  }
  if (kind === "customFormula") {
    return {
      type: "customFormula",
      formula: dataValidationFormulaText(currentValidation) || '=VALUE<>""',
      ...dataValidationModePatch(mode),
    };
  }
  if (kind === "date") {
    return {
      type: "date",
      ...dataValidationDateLocalePatch(dataValidationDateLocale(currentValidation)),
      ...dataValidationModePatch(mode),
    };
  }
  return { type: kind, ...dataValidationModePatch(mode) };
}

function dataValidationWithMode(value: unknown, mode: DataValidationMode): CellFormat | string {
  const kind = formatDataValidationKind(value);
  if (kind === "none") {
    return "";
  }
  if (kind === "list") {
    const namedRangeId = dataValidationNamedRangeId(value);
    if (namedRangeId !== null) {
      return {
        type: "list",
        namedRangeId,
        ...dataValidationModePatch(mode),
      };
    }
    return {
      type: "list",
      ...dataValidationModePatch(mode),
      choices:
        dataValidationChoices(value).length > 0
          ? dataValidationChoices(value)
          : ["Approved", "Pending", "Blocked"],
    };
  }
  if (kind === "customFormula") {
    return {
      type: "customFormula",
      formula: dataValidationFormulaText(value) || '=VALUE<>""',
      ...dataValidationModePatch(mode),
    };
  }
  if (kind === "date") {
    return {
      type: "date",
      ...dataValidationDateLocalePatch(dataValidationDateLocale(value)),
      ...dataValidationModePatch(mode),
    };
  }
  return { type: kind, ...dataValidationModePatch(mode) };
}

function dataValidationModePatch(mode: DataValidationMode): CellFormat {
  return mode === "reject" ? { mode } : {};
}

function dataValidationDateLocale(value: unknown): DataValidationDateLocale {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "iso";
  }
  const locale = (value as Record<string, unknown>).locale;
  return locale === "en-US" || locale === "en-GB" || locale === "de-DE" ? locale : "iso";
}

function dataValidationDateLocalePatch(locale: DataValidationDateLocale): CellFormat {
  return locale === "iso" ? {} : { locale };
}

function dataValidationWithDateLocale(
  value: unknown,
  locale: DataValidationDateLocale,
): CellFormat {
  return {
    type: "date",
    ...dataValidationDateLocalePatch(locale),
    ...dataValidationModePatch(formatDataValidationMode(value)),
  };
}

function dataValidationListSource(value: unknown): string {
  return dataValidationNamedRangeId(value) ?? "manual";
}

function dataValidationListSourcePatch(
  source: string,
  currentValidation: unknown,
): CellFormat | string {
  const mode = formatDataValidationMode(currentValidation);
  if (source !== "manual") {
    return {
      type: "list",
      namedRangeId: source,
      ...dataValidationModePatch(mode),
    };
  }
  const choices = dataValidationChoices(currentValidation);
  return {
    type: "list",
    choices: choices.length > 0 ? choices : ["Approved", "Pending", "Blocked"],
    ...dataValidationModePatch(mode),
  };
}

function dataValidationChoicesText(value: unknown): string {
  return dataValidationChoices(value).join(", ");
}

function dataValidationChoices(
  value: unknown,
  context?: DataValidationChoiceContext,
): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const namedRangeId = dataValidationNamedRangeId(value);
  if (namedRangeId !== null && context !== undefined) {
    return choicesFromNamedRange(namedRangeId, context);
  }
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) {
    return [];
  }
  return choices
    .filter((choice): choice is string => typeof choice === "string")
    .map((choice) => choice.trim())
    .filter((choice) => choice.length > 0)
    .slice(0, 100);
}

function dataValidationNamedRangeId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const namedRangeId = (value as Record<string, unknown>).namedRangeId;
  return typeof namedRangeId === "string" && namedRangeId.trim().length > 0
    ? namedRangeId.trim()
    : null;
}

function dataValidationFormulaText(validation: unknown): string {
  if (typeof validation !== "object" || validation === null || Array.isArray(validation)) {
    return "";
  }
  const formula = (validation as Record<string, unknown>).formula;
  return typeof formula === "string" ? formula : "";
}

function dataValidationWithFormula(validation: unknown, formula: string): CellFormat {
  return {
    type: "customFormula",
    formula,
    ...dataValidationModePatch(formatDataValidationMode(validation)),
  };
}

function choicesFromNamedRange(
  namedRangeId: string,
  context: DataValidationChoiceContext,
): readonly string[] {
  const namedRange = context.namedRanges.find((range) => range.id === namedRangeId);
  if (namedRange === undefined) {
    return [];
  }
  const normalized = normalizeRange({
    start: { row: namedRange.range.startRow, col: namedRange.range.startCol },
    end: { row: namedRange.range.endRow, col: namedRange.range.endCol },
  });
  const choices: string[] = [];
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      const choice = context.grid[row]?.[col]?.trim() ?? "";
      if (choice.length > 0 && !choices.includes(choice)) {
        choices.push(choice);
      }
      if (choices.length >= 100) {
        return choices;
      }
    }
  }
  return choices;
}

function sheetDataValidationRulesFromCells(
  cells: readonly { readonly row: number; readonly col: number; readonly format: CellFormat }[],
  context: DataValidationChoiceContext,
): readonly SheetDataValidationRule[] {
  const grouped = new Map<
    string,
    { readonly validation: unknown; readonly cells: CellAddress[] }
  >();

  for (const cell of cells) {
    const validation = cell.format.dataValidation;
    if (formatDataValidationKind(validation) === "none") {
      continue;
    }
    const key = dataValidationRuleKey(validation, context);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        validation,
        cells: [{ row: cell.row, col: cell.col }],
      });
    } else {
      existing.cells.push({ row: cell.row, col: cell.col });
    }
  }

  return Array.from(grouped.entries())
    .map(([key, rule]) => ({
      id: key,
      validation: rule.validation,
      cells: [...rule.cells].sort(compareCellAddresses),
      label: dataValidationRuleRangeLabel(rule.cells),
    }))
    .sort((left, right) => compareCellAddresses(left.cells[0], right.cells[0]));
}

function dataValidationRuleKey(validation: unknown, context: DataValidationChoiceContext): string {
  return JSON.stringify({
    type: formatDataValidationKind(validation),
    mode: formatDataValidationMode(validation),
    dateLocale: dataValidationDateLocale(validation),
    namedRangeId: dataValidationNamedRangeId(validation),
    choices: dataValidationChoices(validation, context),
    formula: dataValidationFormulaText(validation),
  });
}

function dataValidationRuleRangeLabel(cells: readonly CellAddress[]): string {
  const sorted = [...cells].sort(compareCellAddresses);
  const range = boundingRangeForCells(sorted);
  if (range !== null && cellsFillRange(sorted, range)) {
    return rangeLabel(range);
  }
  const labels = sorted.slice(0, 3).map(cellLabel);
  return sorted.length <= 3
    ? labels.join(", ")
    : `${labels.join(", ")} +${String(sorted.length - 3)}`;
}

function cellsFillRange(cells: readonly CellAddress[], range: CellRange): boolean {
  const normalized = normalizeRange(range);
  const area = (normalized.bottom - normalized.top + 1) * (normalized.right - normalized.left + 1);
  if (cells.length !== area) {
    return false;
  }
  const keys = new Set(cells.map((cell) => cellCoordinateKey(cell.row, cell.col)));
  for (let row = normalized.top; row <= normalized.bottom; row += 1) {
    for (let col = normalized.left; col <= normalized.right; col += 1) {
      if (!keys.has(cellCoordinateKey(row, col))) {
        return false;
      }
    }
  }
  return true;
}

function dataValidationRuleLabel(
  validation: unknown,
  context: DataValidationChoiceContext,
): string {
  const kind = formatDataValidationKind(validation);
  if (kind === "number") {
    return "Number only";
  }
  if (kind === "email") {
    return "Email only";
  }
  if (kind === "url") {
    return "URL only";
  }
  if (kind === "date") {
    return `Date: ${dateLocaleFormatLabel(dataValidationDateLocale(validation))}`;
  }
  if (kind === "customFormula") {
    return `Formula ${dataValidationFormulaText(validation) || '=VALUE<>""'}`;
  }
  const namedRangeId = dataValidationNamedRangeId(validation);
  if (namedRangeId !== null) {
    const namedRange = context.namedRanges.find((range) => range.id === namedRangeId);
    return namedRange === undefined ? "List from named range" : `List from ${namedRange.name}`;
  }
  const choices = dataValidationChoices(validation, context);
  return choices.length === 0 ? "Dropdown list" : `List: ${choices.join(", ")}`;
}

function compareCellAddresses(left: CellAddress | undefined, right: CellAddress | undefined) {
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? 1 : -1;
  }
  return left.row === right.row ? left.col - right.col : left.row - right.row;
}

function parseDataValidationChoices(value: string): readonly string[] {
  return value
    .split(",")
    .map((choice) => choice.trim())
    .filter((choice, index, choices) => choice.length > 0 && choices.indexOf(choice) === index)
    .slice(0, 100);
}

function formatConditionalFormatKind(value: unknown): ConditionalFormatKind {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "none";
  }
  const type = (value as Record<string, unknown>).type;
  return type === "greaterThan100" ||
    type === "lessThanZero" ||
    type === "textContains" ||
    type === "customFormula"
    ? type
    : "none";
}

function sheetConditionalFormatRulesFromCells(
  cells: readonly { readonly row: number; readonly col: number; readonly format: CellFormat }[],
): readonly SheetConditionalFormatRule[] {
  const grouped = new Map<
    string,
    { readonly conditionalFormat: unknown; readonly cells: CellAddress[] }
  >();

  for (const cell of cells) {
    const conditionalFormat = cell.format.conditionalFormat;
    if (formatConditionalFormatKind(conditionalFormat) === "none") {
      continue;
    }
    const key = conditionalFormatRuleKey(conditionalFormat);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        conditionalFormat,
        cells: [{ row: cell.row, col: cell.col }],
      });
    } else {
      existing.cells.push({ row: cell.row, col: cell.col });
    }
  }

  return Array.from(grouped.entries())
    .map(([key, rule]) => ({
      id: key,
      conditionalFormat: rule.conditionalFormat,
      cells: [...rule.cells].sort(compareCellAddresses),
      label: dataValidationRuleRangeLabel(rule.cells),
    }))
    .sort((left, right) => compareCellAddresses(left.cells[0], right.cells[0]));
}

function conditionalFormatRuleKey(conditionalFormat: unknown): string {
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return "none";
  }
  const rule = conditionalFormat as Record<string, unknown>;
  return JSON.stringify({
    type: formatConditionalFormatKind(conditionalFormat),
    operator: typeof rule.operator === "string" ? rule.operator : "",
    value: typeof rule.value === "number" ? rule.value : null,
    formula: typeof rule.formula === "string" ? rule.formula : "",
    text: typeof rule.text === "string" ? rule.text : "",
    fillColor: typeof rule.fillColor === "string" ? rule.fillColor : "",
    textColor: typeof rule.textColor === "string" ? rule.textColor : "",
  });
}

function conditionalFormatRuleLabel(conditionalFormat: unknown): string {
  const kind = formatConditionalFormatKind(conditionalFormat);
  if (kind === "greaterThan100") {
    return `Greater than ${conditionalFormatThresholdValue(conditionalFormat)}`;
  }
  if (kind === "lessThanZero") {
    return `Less than ${conditionalFormatThresholdValue(conditionalFormat)}`;
  }
  if (kind === "textContains") {
    const text = conditionalFormatTextContainsText(conditionalFormat);
    return text.length === 0 ? "Text contains" : `Text contains "${text}"`;
  }
  if (kind === "customFormula") {
    return `Formula ${conditionalFormatFormulaText(conditionalFormat)}`;
  }
  return "Conditional rule";
}

function conditionalFormatForKind(kind: ConditionalFormatKind): CellFormat | string {
  if (kind === "greaterThan100") {
    return {
      type: "greaterThan100",
      operator: "greaterThan",
      value: 100,
      fillColor: "#dcfce7",
      textColor: "#166534",
    };
  }
  if (kind === "lessThanZero") {
    return {
      type: "lessThanZero",
      operator: "lessThan",
      value: 0,
      fillColor: "#fee2e2",
      textColor: "#991b1b",
    };
  }
  if (kind === "textContains") {
    return {
      type: "textContains",
      operator: "containsText",
      text: "Review",
      fillColor: "#fef3c7",
      textColor: "#92400e",
    };
  }
  if (kind === "customFormula") {
    return {
      type: "customFormula",
      formula: "=VALUE>0",
      fillColor: "#dbeafe",
      textColor: "#1d4ed8",
    };
  }
  return "";
}

function conditionalFormatStyle(
  value: string,
  conditionalFormat: unknown,
  context: {
    readonly row: number;
    readonly col: number;
    readonly grid: EditableGrid;
  },
): { readonly background?: string; readonly color?: string } {
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return {};
  }

  const rule = conditionalFormat as Record<string, unknown>;
  const type = formatConditionalFormatKind(rule);
  if (type === "none") {
    return {};
  }
  if (type === "customFormula") {
    if (!conditionalFormulaMatches(conditionalFormatFormulaText(rule), value, context)) {
      return {};
    }
    return {
      background: formatColor(rule.fillColor),
      color: formatColor(rule.textColor),
    };
  }
  if (type === "textContains") {
    const text = conditionalFormatTextContainsText(rule);
    if (text.length === 0 || !value.toLocaleLowerCase().includes(text.toLocaleLowerCase())) {
      return {};
    }
    return {
      background: formatColor(rule.fillColor),
      color: formatColor(rule.textColor),
    };
  }
  const numericValue = Number(value.trim().replace(/,/g, ""));
  if (!Number.isFinite(numericValue)) {
    return {};
  }
  const threshold = typeof rule.value === "number" ? rule.value : type === "lessThanZero" ? 0 : 100;
  const matches = type === "greaterThan100" ? numericValue > threshold : numericValue < threshold;
  if (!matches) {
    return {};
  }
  return {
    background: formatColor(rule.fillColor),
    color: formatColor(rule.textColor),
  };
}

function conditionalFormatTextContainsText(conditionalFormat: unknown): string {
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return "";
  }
  const text = (conditionalFormat as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

function conditionalFormatThresholdValue(conditionalFormat: unknown): string {
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return "0";
  }
  const rule = conditionalFormat as Record<string, unknown>;
  const threshold = rule.value;
  if (typeof threshold === "number" && Number.isFinite(threshold)) {
    return String(threshold);
  }
  return formatConditionalFormatKind(rule) === "lessThanZero" ? "0" : "100";
}

function conditionalFormatWithThreshold(conditionalFormat: unknown, threshold: string): CellFormat {
  const rule: Record<string, unknown> =
    typeof conditionalFormat === "object" &&
    conditionalFormat !== null &&
    !Array.isArray(conditionalFormat)
      ? (conditionalFormat as Record<string, unknown>)
      : {};
  const kind = formatConditionalFormatKind(rule);
  const type = kind === "lessThanZero" ? "lessThanZero" : "greaterThan100";
  const fallback = type === "lessThanZero" ? 0 : 100;
  const value = Number(threshold);
  return {
    type,
    operator: type === "lessThanZero" ? "lessThan" : "greaterThan",
    value: Number.isFinite(value) ? value : fallback,
    fillColor:
      typeof rule.fillColor === "string"
        ? rule.fillColor
        : type === "lessThanZero"
          ? "#fee2e2"
          : "#dcfce7",
    textColor:
      typeof rule.textColor === "string"
        ? rule.textColor
        : type === "lessThanZero"
          ? "#991b1b"
          : "#166534",
  };
}

function conditionalFormatWithTextContains(conditionalFormat: unknown, text: string): CellFormat {
  const rule: Record<string, unknown> =
    typeof conditionalFormat === "object" &&
    conditionalFormat !== null &&
    !Array.isArray(conditionalFormat)
      ? (conditionalFormat as Record<string, unknown>)
      : {};
  return {
    type: "textContains",
    operator: "containsText",
    text,
    fillColor: typeof rule.fillColor === "string" ? rule.fillColor : "#fef3c7",
    textColor: typeof rule.textColor === "string" ? rule.textColor : "#92400e",
  };
}

function conditionalFormatFormulaText(conditionalFormat: unknown): string {
  if (
    typeof conditionalFormat !== "object" ||
    conditionalFormat === null ||
    Array.isArray(conditionalFormat)
  ) {
    return "";
  }
  const formula = (conditionalFormat as Record<string, unknown>).formula;
  return typeof formula === "string" ? formula : "";
}

function conditionalFormatWithFormula(conditionalFormat: unknown, formula: string): CellFormat {
  const rule: Record<string, unknown> =
    typeof conditionalFormat === "object" &&
    conditionalFormat !== null &&
    !Array.isArray(conditionalFormat)
      ? (conditionalFormat as Record<string, unknown>)
      : {};
  return {
    type: "customFormula",
    formula,
    fillColor: typeof rule.fillColor === "string" ? rule.fillColor : "#dbeafe",
    textColor: typeof rule.textColor === "string" ? rule.textColor : "#1d4ed8",
  };
}

function conditionalFormulaMatches(
  formula: string,
  value: string,
  context: {
    readonly row: number;
    readonly col: number;
    readonly grid: EditableGrid;
  },
): boolean {
  const expression = formula.trim().replace(/^=/u, "").trim();
  if (expression.length === 0) {
    return false;
  }

  const comparison = expression.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/u);
  if (comparison === null) {
    const result = conditionalFormulaTermValue(expression, value, context);
    return formulaTermTruthy(result);
  }

  const left = conditionalFormulaTermValue(comparison[1]?.trim() ?? "", value, context);
  const operator = comparison[2] ?? "";
  const right = conditionalFormulaTermValue(comparison[3]?.trim() ?? "", value, context);
  return compareFormulaTerms(left, operator, right);
}

function conditionalFormulaTermValue(
  term: string,
  value: string,
  context: {
    readonly row: number;
    readonly col: number;
    readonly grid: EditableGrid;
  },
): string | number | boolean {
  const normalized = term.trim();
  if (/^VALUE$/iu.test(normalized)) {
    return value.trim();
  }
  if (/^TRUE$/iu.test(normalized)) {
    return true;
  }
  if (/^FALSE$/iu.test(normalized)) {
    return false;
  }
  const quoted = normalized.match(/^"([^"]*)"$/u);
  if (quoted !== null) {
    return quoted[1] ?? "";
  }
  const numeric = Number(normalized.replace(/,/g, ""));
  if (Number.isFinite(numeric) && normalized.length > 0) {
    return numeric;
  }
  const reference = normalized.match(/^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/u);
  if (reference !== null) {
    const referencedCol = columnIndexFromLabel((reference[1] ?? "").toUpperCase());
    const referencedRow = Number(reference[2]) - 1;
    if (
      referencedCol !== null &&
      Number.isInteger(referencedRow) &&
      referencedRow >= 0 &&
      referencedRow < SHEET_MAX_ROWS
    ) {
      return context.grid[referencedRow]?.[referencedCol]?.trim() ?? "";
    }
  }
  return normalized;
}

function formulaTermTruthy(value: string | number | boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const numeric = Number(value.replace(/,/g, ""));
  if (Number.isFinite(numeric) && value.trim().length > 0) {
    return numeric !== 0;
  }
  return value.trim().length > 0;
}

function compareFormulaTerms(
  left: string | number | boolean,
  operator: string,
  right: string | number | boolean,
): boolean {
  const leftNumeric = typeof left === "number" ? left : Number(String(left).replace(/,/g, ""));
  const rightNumeric = typeof right === "number" ? right : Number(String(right).replace(/,/g, ""));
  const numericComparison =
    Number.isFinite(leftNumeric) &&
    Number.isFinite(rightNumeric) &&
    String(left).trim().length > 0 &&
    String(right).trim().length > 0;
  const leftValue = numericComparison ? leftNumeric : String(left).toLowerCase();
  const rightValue = numericComparison ? rightNumeric : String(right).toLowerCase();

  if (operator === ">") return leftValue > rightValue;
  if (operator === "<") return leftValue < rightValue;
  if (operator === ">=") return leftValue >= rightValue;
  if (operator === "<=") return leftValue <= rightValue;
  if (operator === "!=" || operator === "<>") return leftValue !== rightValue;
  return leftValue === rightValue;
}

function validationMessageForCell(
  value: string,
  validation: unknown,
  context: DataValidationChoiceContext,
  row: number,
  col: number,
): string | null {
  const kind = formatDataValidationKind(validation);
  if (kind === "none" || value.trim().length === 0 || value.trimStart().startsWith("=")) {
    return null;
  }
  if (kind === "number" && !Number.isFinite(Number(value.replace(/,/g, "")))) {
    return "Expected a number.";
  }
  if (kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim())) {
    return "Expected an email address.";
  }
  if (kind === "url" && !isValidHttpUrl(value.trim())) {
    return "Expected a URL.";
  }
  if (kind === "date") {
    const locale = dataValidationDateLocale(validation);
    if (!isValidDateForLocale(value.trim(), locale)) {
      return `Expected a date in ${dateLocaleFormatLabel(locale)} format.`;
    }
  }
  if (kind === "list") {
    const choices = dataValidationChoices(validation, context);
    if (choices.length > 0 && !choices.includes(value.trim())) {
      return `Expected one of: ${choices.slice(0, 5).join(", ")}.`;
    }
  }
  if (
    kind === "customFormula" &&
    !conditionalFormulaMatches(dataValidationFormulaText(validation) || '=VALUE<>""', value, {
      row,
      col,
      grid: context.grid,
    })
  ) {
    return "Expected a value matching the validation formula.";
  }
  return null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidDateForLocale(value: string, locale: DataValidationDateLocale): boolean {
  if (isValidIsoDate(value)) {
    return true;
  }
  if (locale === "en-US") {
    return isValidDateParts(monthDayYearDateParts(value, "/"));
  }
  if (locale === "en-GB") {
    return isValidDateParts(dayMonthYearDateParts(value, "/"));
  }
  if (locale === "de-DE") {
    return isValidDateParts(dayMonthYearDateParts(value, "."));
  }
  return false;
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return false;
  }
  const [, yearText, monthText, dayText] = match;
  return isValidDateParts({
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
  });
}

function monthDayYearDateParts(
  value: string,
  separator: "/" | ".",
): { readonly year: number; readonly month: number; readonly day: number } | null {
  const escapedSeparator = separator === "." ? "\\." : separator;
  const match = new RegExp(
    `^(\\d{1,2})${escapedSeparator}(\\d{1,2})${escapedSeparator}(\\d{4})$`,
    "u",
  ).exec(value);
  if (match === null) {
    return null;
  }
  return {
    month: Number(match[1]),
    day: Number(match[2]),
    year: Number(match[3]),
  };
}

function dayMonthYearDateParts(
  value: string,
  separator: "/" | ".",
): { readonly year: number; readonly month: number; readonly day: number } | null {
  const escapedSeparator = separator === "." ? "\\." : separator;
  const match = new RegExp(
    `^(\\d{1,2})${escapedSeparator}(\\d{1,2})${escapedSeparator}(\\d{4})$`,
    "u",
  ).exec(value);
  if (match === null) {
    return null;
  }
  return {
    day: Number(match[1]),
    month: Number(match[2]),
    year: Number(match[3]),
  };
}

function isValidDateParts(
  parts: { readonly year: number; readonly month: number; readonly day: number } | null,
): boolean {
  if (parts === null) {
    return false;
  }
  const { year, month, day } = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function dateLocaleFormatLabel(locale: DataValidationDateLocale): string {
  if (locale === "en-US") {
    return "m/d/yyyy";
  }
  if (locale === "en-GB") {
    return "d/m/yyyy";
  }
  if (locale === "de-DE") {
    return "d.m.yyyy";
  }
  return "yyyy-mm-dd";
}

function cellRejectsValue(
  row: number,
  col: number,
  value: string,
  formatMap: ReadonlyMap<string, CellFormat>,
  context: DataValidationChoiceContext,
): boolean {
  const format = formatMap.get(cellCoordinateKey(row, col)) ?? {};
  return (
    formatDataValidationMode(format.dataValidation) === "reject" &&
    validationMessageForCell(value, format.dataValidation, context, row, col) !== null
  );
}

function cellEditRejectedByValidation(
  edit: SheetsCellEdit,
  formatMap: ReadonlyMap<string, CellFormat>,
  context: DataValidationChoiceContext,
): boolean {
  const existingFormat = formatMap.get(cellCoordinateKey(edit.row, edit.col)) ?? {};
  const nextFormat =
    edit.format === undefined ? existingFormat : mergeCellFormat(existingFormat, edit.format);
  return (
    formatDataValidationMode(nextFormat.dataValidation) === "reject" &&
    validationMessageForCell(edit.value, nextFormat.dataValidation, context, edit.row, edit.col) !==
      null
  );
}

function formatDisplayValue(value: string, format: CellFormat): string {
  const numberFormat = formatNumberFormat(format.numberFormat, format.customNumberFormat);
  if (numberFormat === "plain") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  if (numberFormat === "custom") {
    return formatCustomDisplayValue(trimmed, format.customNumberFormat) ?? value;
  }

  if (numberFormat === "date") {
    return formatDateDisplayValue(trimmed) ?? value;
  }

  const numericValue = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(numericValue)) {
    return value;
  }

  if (numberFormat === "currency") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(numericValue);
  }

  if (numberFormat === "percent") {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(numericValue);
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(numericValue);
}

function formatCustomDisplayValue(value: string, pattern: unknown): string | null {
  const customFormat = typeof pattern === "string" ? pattern.trim() : "";
  if (!isSupportedCustomNumberFormat(customFormat)) {
    return null;
  }
  if (isCustomDateFormat(customFormat)) {
    return formatCustomDateDisplayValue(value, customFormat);
  }
  const numericValue = Number(value.replace(/[$,\s]/gu, ""));
  const sections = customNumberFormatSections(customFormat);
  if (sections !== null) {
    if (!Number.isFinite(numericValue)) {
      return sections.text === undefined ? null : formatCustomTextSection(value, sections.text);
    }
    if (numericValue === 0 && sections.zero !== undefined) {
      return formatCustomNumberSection(0, sections.zero);
    }
    if (numericValue < 0 && sections.negative !== undefined) {
      return formatCustomNumberSection(Math.abs(numericValue), sections.negative);
    }
    return formatCustomNumberSection(numericValue, sections.positive);
  }
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  if (customFormat === "$#,##0.00") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numericValue);
  }
  if (customFormat === "0%" || customFormat === "0.00%") {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      minimumFractionDigits: customFormat === "0.00%" ? 2 : 0,
      maximumFractionDigits: customFormat === "0.00%" ? 2 : 0,
    }).format(numericValue);
  }
  const decimalPlaces = customFormat.endsWith(".00") ? 2 : 0;
  return new Intl.NumberFormat("en-US", {
    useGrouping: customFormat.startsWith("#,##"),
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(numericValue);
}

function isSupportedCustomNumberFormat(format: string): boolean {
  return CUSTOM_NUMBER_FORMATS.some((candidate) => candidate === format);
}

function customNumberFormatSections(format: string): {
  readonly positive: string;
  readonly negative?: string;
  readonly zero?: string;
  readonly text?: string;
} | null {
  if (!format.includes(";")) {
    return null;
  }

  const sections = format.split(";");
  if (sections.length < 2 || sections.length > 4 || sections.some((section) => section === "")) {
    return null;
  }
  const [positive, negative, zero, text] = sections;
  if (positive === undefined) {
    return null;
  }
  return { positive, negative, zero, text };
}

function formatCustomNumberSection(value: number, section: string): string {
  const normalizedSection = section.replace(/\[[^\]]+\]/gu, "");
  if (normalizedSection === "-") {
    return "-";
  }

  const percent = normalizedSection.includes("%");
  const currency = normalizedSection.includes("$");
  const decimalPlaces = /\.00/u.test(normalizedSection) ? 2 : 0;
  const useGrouping = normalizedSection.includes("#,##") || normalizedSection.includes("$#,##");
  const formattedNumber = new Intl.NumberFormat("en-US", {
    useGrouping,
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(percent ? value * 100 : value);
  const numberText = `${currency ? "$" : ""}${formattedNumber}${percent ? "%" : ""}`;
  const placeholder = /[$#0,]+(?:\.00)?%?/u.exec(normalizedSection);
  return placeholder === null ? numberText : normalizedSection.replace(placeholder[0], numberText);
}

function formatCustomTextSection(value: string, section: string): string {
  const normalizedSection = section.replace(/\[[^\]]+\]/gu, "");
  return normalizedSection.includes("@") ? normalizedSection.replace(/@/gu, value) : value;
}

function isCustomDateFormat(format: string): boolean {
  return format === "m/d/yyyy" || format === "mm/dd/yyyy" || format === "mmm d, yyyy";
}

function formatCustomDateDisplayValue(value: string, format: string): string | null {
  const date = parseSheetDate(value);
  if (date === null) {
    return null;
  }
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  if (format === "m/d/yyyy") {
    return `${String(month)}/${String(day)}/${String(year)}`;
  }
  if (format === "mm/dd/yyyy") {
    return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(year)}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatDateDisplayValue(value: string): string | null {
  const date = parseSheetDate(value);
  if (date !== null) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

function parseSheetDate(value: string): Date | null {
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (isoDate !== null) {
    const [, year, month, day] = isoDate;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() === Number(month) - 1 &&
      date.getUTCDate() === Number(day)
    ) {
      return date;
    }
  }
  return null;
}

function formatColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value) ? value : undefined;
}

function cellBorderShadow(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const borders = value as Record<string, unknown>;
  const shadows: string[] = [];
  if (borders.top === true) shadows.push("inset 0 2px 0 #111827");
  if (borders.right === true) shadows.push("inset -2px 0 0 #111827");
  if (borders.bottom === true) shadows.push("inset 0 -2px 0 #111827");
  if (borders.left === true) shadows.push("inset 2px 0 0 #111827");
  return shadows.length > 0 ? shadows.join(", ") : undefined;
}

const INVALID_CELL_SHADOW = "inset 0 0 0 2px #dc2626";
const COMMENT_CELL_SHADOW = "inset 0 0 0 2px #f59e0b";
const PROTECTED_CELL_SHADOW = "inset 0 0 0 2px #64748b";
const WARNING_PROTECTED_CELL_SHADOW = "inset 0 0 0 2px #f59e0b";

const COMMENTS_EMPTY_STYLE = {
  marginTop: 12,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const COMMENT_LIST_STYLE = {
  listStyle: "none",
  margin: "12px 0 0",
  padding: 0,
  display: "grid",
  gap: 8,
} satisfies CSSProperties;

const COMMENT_ITEM_STYLE = {
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  padding: 8,
} satisfies CSSProperties;

const REPLY_LIST_STYLE = {
  listStyle: "none",
  margin: "8px 0 0",
  padding: "0 0 0 10px",
  borderLeft: "2px solid var(--border)",
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const REPLY_ITEM_STYLE = {
  padding: "2px 0",
} satisfies CSSProperties;

const COMMENT_META_STYLE = {
  marginTop: 6,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const SIDE_SECTION_STYLE = {
  display: "grid",
  gap: 8,
  paddingBottom: 12,
  marginBottom: 12,
  borderBottom: "1px solid var(--border)",
} satisfies CSSProperties;

const SIDE_SECTION_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
} satisfies CSSProperties;

const SIDE_TABLE_STYLE = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const SIDE_TABLE_HEADER_STYLE = {
  padding: "6px 4px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-3)",
  fontWeight: 700,
  textAlign: "left",
} satisfies CSSProperties;

const SIDE_TABLE_CELL_STYLE = {
  padding: "6px 4px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-2)",
  verticalAlign: "top",
} satisfies CSSProperties;

const SIDE_TABLE_ACTIONS_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
} satisfies CSSProperties;

const SIDE_TABLE_SELECT_STYLE = {
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  padding: "0 8px",
  width: "100%",
  minWidth: 112,
  height: 28,
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const ASSIST_PANEL_STYLE = {
  display: "grid",
  gap: 8,
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const ASSIST_LIST_STYLE = {
  margin: 0,
  paddingLeft: 18,
  color: "var(--text-3)",
} satisfies CSSProperties;

const ASSIST_ACTIONS_STYLE = {
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const CHART_BARS_STYLE = {
  display: "grid",
  gap: 6,
  marginTop: 8,
} satisfies CSSProperties;

const EMBEDDED_CHART_STYLE = {
  position: "absolute",
  zIndex: 2,
  overflow: "hidden",
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.14)",
} satisfies CSSProperties;

const EMBEDDED_IMAGE_STYLE = {
  position: "absolute",
  zIndex: 2,
  overflow: "hidden",
  margin: 0,
  padding: 6,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.14)",
  cursor: "move",
  pointerEvents: "auto",
  userSelect: "none",
} satisfies CSSProperties;

const EMBEDDED_IMAGE_IMG_STYLE = {
  display: "block",
  width: "100%",
  height: "100%",
  objectFit: "contain",
} satisfies CSSProperties;

const EMBEDDED_IMAGE_RESIZE_HANDLE_STYLE = {
  position: "absolute",
  right: -5,
  bottom: -5,
  width: 12,
  height: 12,
  padding: 0,
  border: "2px solid var(--surface)",
  borderRadius: 3,
  background: "var(--accent)",
  boxShadow: "0 1px 4px rgba(15, 23, 42, 0.24)",
  cursor: "nwse-resize",
} satisfies CSSProperties;

const CHART_BAR_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "72px minmax(0, 1fr) 44px",
  gap: 6,
  alignItems: "center",
} satisfies CSSProperties;

const CHART_LABEL_STYLE = {
  minWidth: 0,
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const CHART_BAR_STYLE = {
  display: "block",
  height: 10,
  borderRadius: 2,
  background: "var(--accent)",
} satisfies CSSProperties;

const CHART_VALUE_STYLE = {
  textAlign: "right",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const CHART_EDIT_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto auto",
  gap: 6,
  alignItems: "center",
} satisfies CSSProperties;

const FILTER_VIEW_ACTION_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto auto auto auto auto",
  gap: 6,
  alignItems: "center",
} satisfies CSSProperties;

const FILTER_PREDICATE_LIST_STYLE = {
  display: "grid",
  gap: 6,
} satisfies CSSProperties;

const FILTER_PREDICATE_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "minmax(72px, auto) minmax(96px, auto) minmax(0, 1fr) auto",
  gap: 6,
  alignItems: "end",
} satisfies CSSProperties;

const FILTER_PREDICATE_LABEL_STYLE = {
  display: "grid",
  gap: 4,
  minWidth: 0,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const CHART_TITLE_INPUT_STYLE = {
  minWidth: 0,
  height: 30,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0 8px",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const CHART_LINE_WRAP_STYLE = {
  display: "grid",
  gap: 4,
  marginTop: 8,
} satisfies CSSProperties;

const CHART_LINE_SVG_STYLE = {
  width: "100%",
  height: 88,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
} satisfies CSSProperties;

const CHART_LINE_LABELS_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(48px, 1fr))",
  gap: 4,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const CHART_SPARKLINE_SVG_STYLE = {
  width: "100%",
  height: 44,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
  marginTop: 8,
} satisfies CSSProperties;

const CHART_PIE_WRAP_STYLE = {
  display: "grid",
  gridTemplateColumns: "84px minmax(0, 1fr)",
  gap: 10,
  alignItems: "center",
  marginTop: 8,
} satisfies CSSProperties;

const CHART_PIE_STYLE = {
  width: 84,
  height: 84,
  border: "1px solid var(--border)",
  borderRadius: 999,
  boxShadow: "inset 0 0 0 12px var(--surface)",
} satisfies CSSProperties;

const CHART_PIE_LEGEND_STYLE = {
  display: "grid",
  gap: 5,
  minWidth: 0,
} satisfies CSSProperties;

const CHART_PIE_LEGEND_ROW_STYLE = {
  display: "grid",
  gridTemplateColumns: "10px minmax(0, 1fr) auto",
  gap: 6,
  alignItems: "center",
  minWidth: 0,
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const CHART_PIE_SWATCH_STYLE = {
  width: 10,
  height: 10,
  borderRadius: 2,
} satisfies CSSProperties;

const COMMENT_ACTIONS_STYLE = {
  display: "grid",
  gap: 6,
  marginTop: 8,
} satisfies CSSProperties;

const COMMENT_REPLY_STYLE = {
  width: "100%",
  resize: "vertical",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  padding: 8,
} satisfies CSSProperties;

const SIDE_PANEL_SELECT_STYLE = {
  height: 28,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  padding: "0 8px",
} satisfies CSSProperties;

const SIDE_PANEL_TAB_CONTENT_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 12,
  minWidth: 0,
} satisfies CSSProperties;

const TAB_NAME_INPUT_STYLE = {
  height: 32,
  width: 132,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  font: "inherit",
  padding: "0 8px",
} satisfies CSSProperties;

const SELECTED_RANGE_SUMMARY_STYLE = {
  marginBottom: 8,
  padding: "6px 8px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const SHEET_GRID_WRAP_STYLE = {
  position: "relative",
  minWidth: SHEET_ROW_HEADER_WIDTH + VISIBLE_COLS * SHEET_CELL_WIDTH,
} satisfies CSSProperties;

const FILL_HANDLE_STYLE = {
  position: "absolute",
  zIndex: 4,
  width: 10,
  height: 10,
  border: "2px solid var(--surface)",
  borderRadius: 999,
  background: "var(--accent)",
  boxShadow: "0 0 0 1px var(--accent)",
  cursor: "crosshair",
  padding: 0,
} satisfies CSSProperties;

const FILL_PREVIEW_STYLE = {
  position: "absolute",
  zIndex: 3,
  pointerEvents: "none",
  border: "2px dashed var(--accent)",
  background: "rgba(37, 99, 235, .08)",
} satisfies CSSProperties;

const COMMENT_RANGE_OVERLAY_STYLE = {
  position: "absolute",
  zIndex: 3,
  pointerEvents: "none",
  boxSizing: "border-box",
  border: "2px solid #f59e0b",
  background: "rgba(245, 158, 11, .10)",
  boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, .65)",
} satisfies CSSProperties;

const MERGED_RANGE_OVERLAY_STYLE = {
  position: "absolute",
  zIndex: 2,
  pointerEvents: "none",
  boxSizing: "border-box",
  border: "2px solid #2563eb",
  background: "rgba(37, 99, 235, .08)",
  boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, .72)",
} satisfies CSSProperties;

function sheetVersionDetailLabel(version: OfficeVersionRecord): string {
  const tabCount = numberMetadata(version.metadata.tabCount);
  const cellCount = numberMetadata(version.metadata.cellCount);
  if (cellCount !== null) {
    return `${String(tabCount ?? 0)} tab${tabCount === 1 ? "" : "s"}, ${String(cellCount)} cell${
      cellCount === 1 ? "" : "s"
    }`;
  }
  if (tabCount !== null) {
    return `${String(tabCount)} tab${tabCount === 1 ? "" : "s"}`;
  }
  return "Spreadsheet snapshot";
}

function numberMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function GridHeaderCell({ children }: { readonly children?: ReactNode }) {
  return (
    <div
      role="columnheader"
      style={{
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRight: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface-2)",
        color: "var(--text-3)",
        fontSize: "var(--text-caption)",
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function EditorNotice({ icon, text }: { readonly icon: ReactNode; readonly text: string }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        flex: 1,
        color: "var(--text-3)",
      }}
    >
      {icon}
      {text}
    </div>
  );
}

function downloadSheetExport(exported: {
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

function focusSpreadsheetControl(id: string): void {
  const element = document.getElementById(id);
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "nearest" });
    element.focus();
  }
}

async function copyCurrentSpreadsheetLink(sheetId: string): Promise<void> {
  await writePlainClipboardText(buildCurrentSpreadsheetLink(sheetId));
}

async function writePlainClipboardText(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    return;
  }
  await navigator.clipboard.writeText(text);
}

async function readPlainClipboardText(): Promise<string> {
  if (
    typeof navigator === "undefined" ||
    navigator.clipboard === undefined ||
    typeof navigator.clipboard.readText !== "function"
  ) {
    return "";
  }
  return navigator.clipboard.readText();
}

function buildCurrentSpreadsheetLink(sheetId: string): string {
  const nextUrl =
    typeof window === "undefined"
      ? new URL("http://localhost/sheets")
      : new URL(window.location.href);
  nextUrl.pathname = "/sheets";
  nextUrl.search = "";
  nextUrl.searchParams.set("sheet", sheetId);
  return nextUrl.href;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
