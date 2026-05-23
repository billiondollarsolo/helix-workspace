/* Sheets — shared types + pure grid helpers.
 *
 * The seed `SHEETS_LIST` / `SHEET_TABS` / `SHEET_DATA` arrays that lived here
 * have been removed. Spreadsheet rows, tabs, and cells now come exclusively
 * from the live Sheets tools (`sheets.list`, `sheets.get`, `sheets.tab.get`,
 * `sheets.cells.update`). What remains is the shared row/grid type aliases
 * and a handful of pure helpers (currency parsing, ARR sum, column letter,
 * cell reference) that operate on whatever rows the backend returns. */

/** A spreadsheet row in the list view view-model. */
export interface SheetFile {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly modified: string;
  readonly shared: number;
}

/** Health values that render a colored conditional dot. */
export type SheetHealth = "Green" | "Yellow" | "Red";

/** A single named tab inside a spreadsheet. */
export interface SheetTab {
  readonly id: string;
  readonly name: string;
}

/** A 2D grid of cell strings. Row 0 is the header row. */
export type SheetGrid = ReadonlyArray<ReadonlyArray<string>>;

/** Per-column pixel widths for the default grid layout. */
export const COL_WIDTHS: ReadonlyArray<number> = [180, 110, 130, 110, 140, 90, 260];

/** Zero-based index of the Health column (drives the conditional dots). */
export const HEALTH_COLUMN = 5;

/** Zero-based index of the ARR column (drives the totals-row aggregation). */
export const ARR_COLUMN = 1;

/** Parse a currency-style cell string into a number (0 when unparseable). */
export function parseCurrency(value: string): number {
  const n = Number.parseInt(value.replace(/[$,]/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Sum the ARR column of a grid, skipping the header row. */
export function sumArr(grid: SheetGrid): number {
  return grid
    .slice(1)
    .reduce((total, row) => total + parseCurrency(row[ARR_COLUMN] ?? ""), 0);
}

/** Convert a zero-based column index into a spreadsheet letter (0 → A). */
export function columnLetter(index: number): string {
  let i = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return label;
}

/** Format a cell coordinate into an A1-style reference (row/col zero-based). */
export function cellReference(row: number, col: number): string {
  return `${columnLetter(col)}${row + 1}`;
}
