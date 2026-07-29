// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHEETS_MENU_IDS,
  SHEETS_SIDE_PANEL_TAB_IDS,
  buildSheetsMenus,
  buildSheetsRibbon,
  buildSheetsSidePanelTabs,
  type SheetsChromeContext,
} from "./native-spreadsheet-chrome";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function makeContext(overrides: Partial<SheetsChromeContext> = {}): SheetsChromeContext {
  return {
    hasSelection: true,
    selectionLocked: false,
    fontFamily: "default",
    fontSize: "11",
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    textColor: "",
    fillColor: "",
    numberFormat: "plain",
    horizontalAlign: "left",
    verticalAlign: "top",
    wrapText: false,
    mergeCellsEnabled: true,
    setFontFamily: vi.fn(),
    setFontSize: vi.fn(),
    setBold: vi.fn(),
    setItalic: vi.fn(),
    setUnderline: vi.fn(),
    setStrikethrough: vi.fn(),
    setTextColor: vi.fn(),
    setFillColor: vi.fn(),
    setNumberFormat: vi.fn(),
    increaseDecimals: vi.fn(),
    decreaseDecimals: vi.fn(),
    setPercent: vi.fn(),
    setCurrency: vi.fn(),
    setHorizontalAlign: vi.fn(),
    setVerticalAlign: vi.fn(),
    setWrapText: vi.fn(),
    applyBorderPreset: vi.fn(),
    mergeSelectedCells: vi.fn(),
    canUndo: true,
    canRedo: true,
    undo: vi.fn(),
    redo: vi.fn(),
    canCutCopyCells: true,
    canPasteCells: true,
    cutCells: vi.fn(),
    copyCells: vi.fn(),
    pasteCells: vi.fn(),
    sortRangeAsc: vi.fn(),
    sortRangeDesc: vi.fn(),
    toggleFilter: vi.fn(),
    filterActive: false,
    insertChart: vi.fn(),
    insertPivotTable: vi.fn(),
    insertImage: vi.fn(),
    insertFunction: vi.fn(),
    availableFunctions: [{ value: "sum", label: "Sum" }],
    insertRowAbove: vi.fn(),
    insertRowBelow: vi.fn(),
    insertColumnLeft: vi.fn(),
    insertColumnRight: vi.fn(),
    deleteRow: vi.fn(),
    deleteColumn: vi.fn(),
    rowColOpsEnabled: true,
    onShare: vi.fn(),
    onNewSpreadsheet: vi.fn(),
    onOpenSpreadsheet: vi.fn(),
    onMakeCopy: vi.fn(),
    onMoveToTrash: vi.fn(),
    onExportCsv: vi.fn(),
    onExportTsv: vi.fn(),
    onExportXlsx: vi.fn(),
    onExportOds: vi.fn(),
    onAnalyzeRange: vi.fn(),
    onCopyLink: vi.fn(),
    onOpenKeyboardShortcuts: vi.fn(),
    openSidePanelTab: vi.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("buildSheetsMenus", () => {
  it("includes the ten Google-Sheets-style menu ids", () => {
    const ctx = makeContext();
    const menus = buildSheetsMenus(ctx);
    const ids = menus.map((menu) => menu.id);
    expect(ids).toEqual([
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
    ]);
    // Same set as the exported constant.
    expect(new Set(ids)).toEqual(new Set(SHEETS_MENU_IDS));
  });

  it("wires File → Download submenu items to the export callbacks", () => {
    const ctx = makeContext();
    const menus = buildSheetsMenus(ctx);
    const fileMenu = menus.find((menu) => menu.id === "file");
    expect(fileMenu).toBeDefined();
    const download = fileMenu?.items.find(
      (item) => "kind" in item && item.kind === "submenu" && item.id === "file-export",
    );
    expect(download).toBeDefined();
    const submenu = download as { items: ReadonlyArray<{ id?: string; onSelect?: () => void }> };
    const xlsx = submenu.items.find((item) => item.id === "file-export-xlsx");
    xlsx?.onSelect?.();
    expect(ctx.onExportXlsx).toHaveBeenCalled();
  });

  it("wires File lifecycle commands to their callbacks", () => {
    const ctx = makeContext();
    const fileMenu = buildSheetsMenus(ctx).find((menu) => menu.id === "file");
    for (const id of ["file-new", "file-open", "file-make-copy", "file-move-trash"]) {
      const item = fileMenu?.items.find((candidate) => "id" in candidate && candidate.id === id);
      if (item === undefined || !("onSelect" in item)) {
        throw new Error(`missing ${id}`);
      }
      item.onSelect();
    }
    expect(ctx.onNewSpreadsheet).toHaveBeenCalledTimes(1);
    expect(ctx.onOpenSpreadsheet).toHaveBeenCalledTimes(1);
    expect(ctx.onMakeCopy).toHaveBeenCalledTimes(1);
    expect(ctx.onMoveToTrash).toHaveBeenCalledTimes(1);
  });

  it("dispatches Share menu commands to share and copy-link callbacks", () => {
    const ctx = makeContext();
    const shareMenu = buildSheetsMenus(ctx).find((menu) => menu.id === "share");
    const share = shareMenu?.items.find(
      (candidate) => "id" in candidate && candidate.id === "share-open",
    );
    const copyLink = shareMenu?.items.find(
      (candidate) => "id" in candidate && candidate.id === "share-copy-link",
    );
    if (share === undefined || !("onSelect" in share)) {
      throw new Error("missing Share with people command");
    }
    if (copyLink === undefined || !("onSelect" in copyLink)) {
      throw new Error("missing Copy link command");
    }
    share.onSelect();
    copyLink.onSelect();
    expect(ctx.onShare).toHaveBeenCalledTimes(1);
    expect(ctx.onCopyLink).toHaveBeenCalledTimes(1);
  });

  it("disables Undo when canUndo is false", () => {
    const ctx = makeContext({ canUndo: false });
    const menus = buildSheetsMenus(ctx);
    const edit = menus.find((menu) => menu.id === "edit");
    const undoItem = edit?.items.find((item) => (item as { id?: string }).id === "edit-undo") as
      { disabled?: boolean } | undefined;
    expect(undoItem?.disabled).toBe(true);
  });

  it("wires Undo and Redo menu commands to history callbacks", () => {
    const ctx = makeContext({ canUndo: true, canRedo: true });
    const menus = buildSheetsMenus(ctx);
    const edit = menus.find((menu) => menu.id === "edit");
    const undoItem = edit?.items.find((item) => (item as { id?: string }).id === "edit-undo") as
      { onSelect?: () => void } | undefined;
    const redoItem = edit?.items.find((item) => (item as { id?: string }).id === "edit-redo") as
      { onSelect?: () => void } | undefined;

    undoItem?.onSelect?.();
    redoItem?.onSelect?.();

    expect(ctx.undo).toHaveBeenCalledTimes(1);
    expect(ctx.redo).toHaveBeenCalledTimes(1);
  });

  it("wires Cut, Copy, and Paste menu commands to cell clipboard callbacks", () => {
    const ctx = makeContext({ canCutCopyCells: true, canPasteCells: true });
    const menus = buildSheetsMenus(ctx);
    const edit = menus.find((menu) => menu.id === "edit");
    const item = (id: string): { readonly onSelect: () => void } => {
      const found = edit?.items.find((candidate) => (candidate as { id?: string }).id === id) as
        { onSelect?: () => void } | undefined;
      if (found === undefined || found.onSelect === undefined) {
        throw new Error(`Missing ${id}`);
      }
      return { onSelect: found.onSelect };
    };

    item("edit-cut").onSelect();
    item("edit-copy").onSelect();
    item("edit-paste").onSelect();

    expect(ctx.cutCells).toHaveBeenCalledTimes(1);
    expect(ctx.copyCells).toHaveBeenCalledTimes(1);
    expect(ctx.pasteCells).toHaveBeenCalledTimes(1);
  });

  it("disables cell clipboard menu commands without selection or clipboard data", () => {
    const menus = buildSheetsMenus(makeContext({ canCutCopyCells: false, canPasteCells: false }));
    const edit = menus.find((menu) => menu.id === "edit");
    const item = (id: string) =>
      edit?.items.find((candidate) => (candidate as { id?: string }).id === id) as
        { disabled?: boolean } | undefined;

    expect(item("edit-cut")?.disabled).toBe(true);
    expect(item("edit-copy")?.disabled).toBe(true);
    expect(item("edit-paste")?.disabled).toBe(true);
  });
});

describe("buildSheetsRibbon", () => {
  it("renders the expected working ribbon controls without Coming soon placeholders", () => {
    const ctx = makeContext();
    act(() => {
      root.render(buildSheetsRibbon(ctx));
    });
    const ribbon = container.querySelector('[role="toolbar"]');
    expect(ribbon).not.toBeNull();

    // Expected toggles for the cell formatting toggles supported by the model.
    expect(container.querySelector('button[aria-label="Font family"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Font size"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Bold"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Italic"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Underline"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Strikethrough"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Align left"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Align center"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Align right"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Vertical align"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Wrap text"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Merge cells"]')).not.toBeNull();

    // Color pickers.
    expect(container.querySelector('button[aria-label="Text color"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Fill color"]')).not.toBeNull();

    // Borders / number / function selects.
    expect(container.querySelector('button[aria-label="Borders"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Number format"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Insert function"]')).not.toBeNull();

    // Sort + filter ribbon controls (renamed to avoid colliding with legacy toolbar).
    expect(container.querySelector('button[aria-label="Sort range A to Z"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Sort range Z to A"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Toggle filter"]')).not.toBeNull();

    // Insert ribbon.
    expect(container.querySelector('button[aria-label="Insert chart"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Insert pivot table"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Insert image"]')).not.toBeNull();

    // Cell ribbon.
    expect(container.querySelector('button[aria-label="Insert row above"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Delete row"]')).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("Coming soon");
  });

  it("reflects pressed state for the Bold toggle when the context says bold is true", () => {
    const ctx = makeContext({ bold: true });
    act(() => {
      root.render(buildSheetsRibbon(ctx));
    });
    const boldToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Bold"]');
    expect(boldToggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("dispatches Undo and Redo from the ribbon when history is available", () => {
    const ctx = makeContext({ canUndo: true, canRedo: true });
    act(() => {
      root.render(buildSheetsRibbon(ctx));
    });

    container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.click();

    expect(ctx.undo).toHaveBeenCalledTimes(1);
    expect(ctx.redo).toHaveBeenCalledTimes(1);
  });

  it("wires the formerly placeholder formatting controls to their context callbacks", () => {
    const ctx = makeContext({ underline: false, strikethrough: false, wrapText: false });
    act(() => {
      root.render(buildSheetsRibbon(ctx));
    });

    container.querySelector<HTMLButtonElement>('button[aria-label="Underline"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Strikethrough"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Wrap text"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Merge cells"]')?.click();

    expect(ctx.setUnderline).toHaveBeenCalledWith(true);
    expect(ctx.setStrikethrough).toHaveBeenCalledWith(true);
    expect(ctx.setWrapText).toHaveBeenCalledWith(true);
    expect(ctx.mergeSelectedCells).toHaveBeenCalled();
  });
});

describe("buildSheetsSidePanelTabs", () => {
  it("returns the expected side-panel tabs in order", () => {
    const tabs = buildSheetsSidePanelTabs(
      {
        comments: "comments-content",
        charts: "charts-content",
        pivots: "pivots-content",
        ai: "ai-content",
        cells: "cells-content",
        filters: "filters-content",
        names: "names-content",
        versions: "versions-content",
        permissions: "permissions-content",
      },
      { commentsBadge: 3 },
    );
    expect(tabs.map((tab) => tab.id)).toEqual([
      "comments",
      "charts",
      "pivots",
      "ai",
      "cells",
      "filters",
      "names",
      "versions",
      "permissions",
    ]);
    expect(new Set(tabs.map((tab) => tab.id))).toEqual(new Set(SHEETS_SIDE_PANEL_TAB_IDS));
    expect(tabs[0]?.badge).toBe(3);
    expect(tabs[0]?.content).toBe("comments-content");
  });
});
