export interface SpreadsheetAssistRange {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface SpreadsheetFormulaAssist {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly formula: string;
  readonly target: {
    readonly row: number;
    readonly col: number;
  };
}

export interface SpreadsheetRangeAssist {
  readonly summary: string;
  readonly findings: readonly string[];
  readonly formulas: readonly SpreadsheetFormulaAssist[];
}

const MAX_SUGGESTED_FORMULAS = 3;

export function analyzeSpreadsheetRange(
  grid: readonly (readonly string[])[],
  range: SpreadsheetAssistRange,
): SpreadsheetRangeAssist {
  const rows = rowsInRange(grid, range);
  const rowCount = range.bottom - range.top + 1;
  const colCount = range.right - range.left + 1;
  const cells = rows.flat();
  const nonEmptyCells = cells.filter((value) => value.trim().length > 0);
  const emptyCells = cells.length - nonEmptyCells.length;
  const numericColumns = numericColumnProfiles(grid, range);
  const duplicateLabels = duplicateFirstColumnLabels(grid, range);
  const findings: string[] = [];

  if (numericColumns.length > 0) {
    findings.push(
      `${String(numericColumns.length)} numeric column${numericColumns.length === 1 ? "" : "s"} detected`,
    );
  } else {
    findings.push("No reliable numeric columns detected");
  }

  if (emptyCells > 0) {
    findings.push(`${String(emptyCells)} blank cell${emptyCells === 1 ? "" : "s"} in selection`);
  }

  if (duplicateLabels.length > 0) {
    findings.push(`Duplicate labels: ${duplicateLabels.slice(0, 3).join(", ")}`);
  }

  const formulas = numericColumns
    .slice(0, MAX_SUGGESTED_FORMULAS)
    .map((column) => formulaAssistForColumn(range, column))
    .filter((assist): assist is SpreadsheetFormulaAssist => assist !== null)
    .slice(0, MAX_SUGGESTED_FORMULAS);

  return {
    summary: `${String(rowCount)} x ${String(colCount)} range, ${String(nonEmptyCells.length)} populated cell${nonEmptyCells.length === 1 ? "" : "s"}`,
    findings,
    formulas,
  };
}

function rowsInRange(
  grid: readonly (readonly string[])[],
  range: SpreadsheetAssistRange,
): readonly string[][] {
  const rows: string[][] = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    const values: string[] = [];
    for (let col = range.left; col <= range.right; col += 1) {
      values.push(grid[row]?.[col] ?? "");
    }
    rows.push(values);
  }
  return rows;
}

function numericColumnProfiles(
  grid: readonly (readonly string[])[],
  range: SpreadsheetAssistRange,
) {
  const profiles: Array<{
    readonly col: number;
    readonly label: string;
    readonly firstDataRow: number;
    readonly lastDataRow: number;
  }> = [];
  const firstDataRow = range.top + 1 <= range.bottom ? range.top + 1 : range.top;

  for (let col = range.left; col <= range.right; col += 1) {
    let numericCount = 0;
    let nonEmptyCount = 0;
    let lastDataRow = firstDataRow;

    for (let row = firstDataRow; row <= range.bottom; row += 1) {
      const value = grid[row]?.[col]?.trim() ?? "";
      if (value.length === 0) {
        continue;
      }
      nonEmptyCount += 1;
      if (isNumericCell(value)) {
        numericCount += 1;
        lastDataRow = row;
      }
    }

    if (numericCount > 0 && numericCount === nonEmptyCount) {
      profiles.push({
        col,
        label: columnLabel(grid[range.top]?.[col], col),
        firstDataRow,
        lastDataRow,
      });
    }
  }

  return profiles;
}

function formulaAssistForColumn(
  range: SpreadsheetAssistRange,
  column: {
    readonly col: number;
    readonly label: string;
    readonly firstDataRow: number;
    readonly lastDataRow: number;
  },
): SpreadsheetFormulaAssist | null {
  const targetRow = range.bottom + 1;
  if (targetRow >= 10_000) {
    return null;
  }
  const address = `${cellLabel(column.firstDataRow, column.col)}:${cellLabel(column.lastDataRow, column.col)}`;
  return {
    id: `sum-${String(column.col)}`,
    label: `Insert SUM for ${column.label}`,
    detail: `${cellLabel(targetRow, column.col)} = SUM(${address})`,
    formula: `=SUM(${address})`,
    target: { row: targetRow, col: column.col },
  };
}

function duplicateFirstColumnLabels(
  grid: readonly (readonly string[])[],
  range: SpreadsheetAssistRange,
): readonly string[] {
  const counts = new Map<string, number>();
  for (let row = range.top + 1; row <= range.bottom; row += 1) {
    const label = grid[row]?.[range.left]?.trim();
    if (label !== undefined && label.length > 0) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([label]) => label);
}

function isNumericCell(value: string): boolean {
  const normalized = value.replace(/[$,%\s]/gu, "");
  return normalized.length > 0 && Number.isFinite(Number(normalized));
}

function columnLabel(value: string | undefined, col: number): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? columnLetter(col) : trimmed;
}

function cellLabel(row: number, col: number): string {
  return `${columnLetter(col)}${String(row + 1)}`;
}

function columnLetter(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}
