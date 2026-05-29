/* Sheets view-model helpers.

   The backend stores cells sparsely (one record per populated coordinate);
   the editor renders a dense 2D string grid. These helpers convert between
   the two representations and diff edits for `sheets.cells.update`. */

import type { SheetsApiCell, SheetsApiSheet, SheetsCellEdit } from "./api";
import type { DriveApiPreview } from "@/features/drive/api";
import type { SheetFile, SheetGrid } from "./seed";

/** Minimum dense grid shape so a fresh tab still renders a usable surface. */
export const MIN_GRID_ROWS = 1;
export const MIN_GRID_COLS = 7;

/** A mutable dense grid of string cells. */
export type EditableGrid = string[][];

/** Build a dense grid from sparse backend cells, padded to a minimum shape. */
export function gridFromCells(cells: readonly SheetsApiCell[]): EditableGrid {
  let maxRow = MIN_GRID_ROWS - 1;
  let maxCol = MIN_GRID_COLS - 1;
  for (const cell of cells) {
    if (cell.row > maxRow) maxRow = cell.row;
    if (cell.col > maxCol) maxCol = cell.col;
  }
  const grid: EditableGrid = Array.from({ length: maxRow + 1 }, () =>
    Array.from({ length: maxCol + 1 }, () => ""),
  );
  for (const cell of cells) {
    const row = grid[cell.row];
    if (row !== undefined) {
      row[cell.col] = cell.value;
    }
  }
  return grid;
}

/** Build the user-facing grid, showing formula results while preserving raw values elsewhere. */
export function displayGridFromCells(cells: readonly SheetsApiCell[]): EditableGrid {
  return gridFromCells(
    cells.map((cell) => ({
      ...cell,
      value: displayValueForCell(cell),
    })),
  );
}

export function displayValueForCell(cell: SheetsApiCell): string {
  if (cell.formula === null || cell.formula === undefined) {
    return cell.value;
  }
  return cell.calcValue ?? cell.value;
}

/** Pad a dense grid to a stable editing viewport without mutating the input. */
export function padGrid(
  grid: SheetGrid | EditableGrid,
  minRows: number,
  minCols: number,
): EditableGrid {
  const rowCount = Math.max(grid.length, minRows);
  const colCount = Math.max(...grid.map((row) => row.length), minCols);
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const row = grid[rowIndex] ?? [];
    return Array.from({ length: colCount }, (_, colIndex) => row[colIndex] ?? "");
  });
}

/** Deep-clone a (possibly readonly) grid into a mutable one. */
export function cloneGrid(grid: SheetGrid | EditableGrid): EditableGrid {
  return grid.map((row) => [...row]);
}

/**
 * Diff a single committed cell against the last-known grid, producing the
 * `sheets.cells.update` edit batch (one entry). Returns `null` when the
 * value is unchanged so we avoid no-op mutations.
 */
export function diffCellEdit(
  previous: SheetGrid | EditableGrid,
  row: number,
  col: number,
  value: string,
): SheetsCellEdit | null {
  const current = previous[row]?.[col] ?? "";
  if (current === value) {
    return null;
  }
  return { row, col, value };
}

/** Serialize an entire grid to a sparse edit batch (only non-empty cells). */
export function gridToCellEdits(grid: SheetGrid | EditableGrid): SheetsCellEdit[] {
  const edits: SheetsCellEdit[] = [];
  grid.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== "") {
        edits.push({ row: r, col: c, value });
      }
    });
  });
  return edits;
}

/** A spreadsheet list row, agnostic of seed vs. backend origin. */
export interface SheetListRow extends SheetFile {
  /** `"backend"` rows are live and editable; `"seed"` rows are offline-only. */
  readonly source: "backend" | "seed";
  readonly mimeType?: string | undefined;
  /** Uppercase source format shown beside filenames, e.g. XLSX or ODS. */
  readonly formatLabel?: string;
  readonly preview?: DriveApiPreview | undefined;
  /** True when the signed-in user owns the spreadsheet. */
  readonly mine?: boolean;
  readonly starred?: boolean;
  /** Non-null when the Drive object is in trash. */
  readonly deletedAt?: string | null;
  /** Native Helix sheets open in-app. Raw XLS/XLSX/CSV uploads also open
   *  natively — the universal editor router imports them into a fresh
   *  helix-sheet on first open. The `"office"` mode is a vestigial enum
   *  value kept so seed rows that still carry it parse without errors. */
  readonly openMode?: "native" | "office";
}

/** Map a backend sheet record into a list-view row. */
export function listRowFromApi(sheet: SheetsApiSheet): SheetListRow {
  return {
    id: sheet.id,
    title: sheet.title.length > 0 ? sheet.title : "Untitled spreadsheet",
    owner: ownerLabel(sheet.metadata),
    modified: formatModified(sheet.updatedAt),
    shared: sharedCount(sheet.metadata),
    source: "backend",
    formatLabel: "SHEET",
    mine: true,
    starred: false,
    deletedAt: sheet.deletedAt,
  };
}

function ownerLabel(metadata: Record<string, unknown>): string {
  const owner = metadata.ownerName;
  return typeof owner === "string" && owner.length > 0 ? owner : "You";
}

function sharedCount(metadata: Record<string, unknown>): number {
  const shared = metadata.shared;
  return typeof shared === "number" && Number.isFinite(shared) ? shared : 1;
}

/** Human-friendly relative timestamp for a list row. */
export function formatModified(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Recently";
  }
  const ageMs = Date.now() - timestamp;
  if (ageMs >= 0 && ageMs < 60_000) {
    return "Just now";
  }
  if (ageMs >= 0 && ageMs < 3_600_000) {
    const mins = Math.max(1, Math.floor(ageMs / 60_000));
    return `${String(mins)} min ago`;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );
}
