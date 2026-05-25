import type { SheetCellRecord } from "./types.js";

export interface SheetFormulaEvaluation {
  readonly formula: string | null;
  readonly calcValue: string | null;
  readonly dependencies: readonly string[];
  readonly error: string | null;
}

export type SheetFormulaEvaluationMap = ReadonlyMap<string, SheetFormulaEvaluation>;

export interface SheetFormulaNamedRange {
  readonly name: string;
  readonly tabId?: string | undefined;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

export interface SheetFormulaDriveEntry {
  readonly name: string;
  readonly path?: string;
  readonly mimeType?: string;
  readonly summary?: string;
}

export interface SheetFormulaEvaluationOptions {
  readonly namedRanges?: readonly SheetFormulaNamedRange[];
  readonly driveEntries?: readonly SheetFormulaDriveEntry[];
  readonly tabs?: readonly SheetFormulaTab[];
  readonly currentTabId?: string | undefined;
}

export interface SheetFormulaTab {
  readonly id: string;
  readonly name: string;
}

type FormulaValue = number | string;
type FormulaCellInput = Pick<SheetCellRecord, "row" | "col" | "value"> &
  Partial<Pick<SheetCellRecord, "sheetTabId">>;

interface FormulaCellReference {
  readonly tabId: string;
  readonly row: number;
  readonly col: number;
  readonly explicitTab: boolean;
}

interface FormulaRange {
  readonly tabId: string;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface FormulaContext {
  readonly namedRanges: ReadonlyMap<string, SheetFormulaNamedRange>;
  readonly driveEntries: readonly SheetFormulaDriveEntry[];
  readonly currentTabId: string;
  readonly tabIdByName: ReadonlyMap<string, string>;
  readonly tabNameById: ReadonlyMap<string, string>;
  readonly hasTabContext: boolean;
}

interface FormulaExpressionResult {
  readonly value: FormulaValue;
  readonly dependencies: ReadonlySet<string>;
  readonly error: string | null;
  readonly errorValue: string;
}

export function evaluateSheetFormulas(
  cells: readonly FormulaCellInput[],
  options: SheetFormulaEvaluationOptions = {},
): SheetFormulaEvaluationMap {
  const values = new Map<string, string>();
  const formulas = new Map<string, string>();
  const context: FormulaContext = {
    namedRanges: namedRangeMap(options.namedRanges ?? []),
    driveEntries: options.driveEntries ?? [],
    currentTabId: options.currentTabId ?? "",
    tabIdByName: tabIdByNameMap(options.tabs ?? []),
    tabNameById: tabNameByIdMap(options.tabs ?? []),
    hasTabContext:
      options.currentTabId !== undefined ||
      (options.tabs?.length ?? 0) > 0 ||
      cells.some((cell) => cell.sheetTabId !== undefined),
  };
  for (const cell of cells) {
    const key = formulaCellKey(formulaCellTabId(cell, context), cell.row, cell.col);
    values.set(key, cell.value);
    if (cell.value.trimStart().startsWith("=")) {
      formulas.set(key, cell.value.trimStart().slice(1));
    }
  }

  const cache = new Map<string, SheetFormulaEvaluation>();
  const evaluateCell = (key: string, visiting: ReadonlySet<string>): SheetFormulaEvaluation => {
    const formula = formulas.get(key);
    if (formula === undefined) {
      const value = values.get(key) ?? "";
      return {
        formula: null,
        calcValue: value,
        dependencies: [],
        error: null,
      };
    }
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(key)) {
      return {
        formula,
        calcValue: "#CIRC",
        dependencies: [],
        error: "Circular reference",
      };
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(key);
    const parsed = evaluateExpression(
      formula,
      formulaSourceTabId(key, context),
      values,
      evaluateCell,
      nextVisiting,
      context,
    );
    const evaluation: SheetFormulaEvaluation = {
      formula,
      calcValue: parsed.error === null ? formatFormulaResult(parsed.value) : parsed.errorValue,
      dependencies: [...parsed.dependencies].sort(),
      error: parsed.error,
    };
    cache.set(key, evaluation);
    return evaluation;
  };

  const result = new Map<string, SheetFormulaEvaluation>();
  for (const cell of cells) {
    const key = formulaCellKey(formulaCellTabId(cell, context), cell.row, cell.col);
    const evaluation = formulas.has(key)
      ? evaluateCell(key, new Set())
      : {
          formula: null,
          calcValue: cell.value,
          dependencies: [],
          error: null,
        };
    result.set(resultCellKey(cell, context), evaluation);
  }
  return result;
}

export function cellReference(row: number, col: number): string {
  let index = col;
  let label = "";
  do {
    label = String.fromCharCode(65 + (index % 26)) + label;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return `${label}${String(row + 1)}`;
}

function evaluateExpression(
  expression: string,
  sourceTabId: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  context: FormulaContext,
): FormulaExpressionResult {
  const dependencies = new Set<string>();
  const referenceFailure: { error: string | null; value: string } = {
    error: null,
    value: "#VALUE!",
  };
  const queryResult = evaluateQueryExpression(
    expression,
    sourceTabId,
    values,
    evaluateCell,
    visiting,
    context,
    dependencies,
    (error, value) => {
      referenceFailure.error = error;
      referenceFailure.value = value;
    },
  );
  if (queryResult !== null) {
    return referenceFailure.error === null
      ? queryResult
      : {
          value: 0,
          dependencies: queryResult.dependencies,
          error: referenceFailure.error,
          errorValue: referenceFailure.value,
        };
  }

  const helixResult = evaluateHelixFunctionExpression(
    expression,
    sourceTabId,
    values,
    evaluateCell,
    visiting,
    context,
    dependencies,
    (error, value) => {
      referenceFailure.error = error;
      referenceFailure.value = value;
    },
  );
  if (helixResult !== null) {
    return referenceFailure.error === null
      ? helixResult
      : {
          value: 0,
          dependencies: helixResult.dependencies,
          error: referenceFailure.error,
          errorValue: referenceFailure.value,
        };
  }

  const conditionalAggregateResult = evaluateConditionalAggregateExpression(
    expression,
    sourceTabId,
    values,
    evaluateCell,
    visiting,
    context,
    dependencies,
    (error, value) => {
      referenceFailure.error = error;
      referenceFailure.value = value;
    },
  );
  if (conditionalAggregateResult !== null) {
    return referenceFailure.error === null
      ? conditionalAggregateResult
      : {
          value: 0,
          dependencies: conditionalAggregateResult.dependencies,
          error: referenceFailure.error,
          errorValue: referenceFailure.value,
        };
  }

  const normalized = expression
    .replace(
      /\b(SUM|AVERAGE|COUNT|COUNTA|MIN|MAX)\(([^()]*)\)/giu,
      (_match, fn: string, args: string) =>
        String(
          aggregateArguments(
            fn.toLowerCase() as SheetFormulaAggregateFunction,
            args,
            sourceTabId,
            values,
            evaluateCell,
            visiting,
            dependencies,
            (error, value) => {
              referenceFailure.error = error;
              referenceFailure.value = value;
            },
            context,
          ),
        ),
    )
    .replace(formulaCellReferencePattern, (_match, reference: string) => {
      const parsed = parseReference(reference, context, sourceTabId);
      if (parsed === null) {
        return "0";
      }
      const key = keyFromReference(parsed);
      dependencies.add(referenceLabel(parsed, context, sourceTabId));
      const value = valueForReference(key, values, evaluateCell, visiting, (error, errorValue) => {
        referenceFailure.error = error;
        referenceFailure.value = errorValue;
      });
      return String(value);
    });

  if (referenceFailure.error !== null) {
    return {
      value: 0,
      dependencies,
      error: referenceFailure.error,
      errorValue: referenceFailure.value,
    };
  }

  if (!/^[\d+\-*/().,\s]+$/u.test(normalized)) {
    return { value: 0, dependencies, error: "Unsupported formula", errorValue: "#VALUE!" };
  }

  try {
    const value = evaluateArithmetic(normalized);
    return Number.isFinite(value)
      ? { value, dependencies, error: null, errorValue: "" }
      : { value: 0, dependencies, error: "Formula result is not finite", errorValue: "#DIV/0!" };
  } catch {
    return { value: 0, dependencies, error: "Invalid formula", errorValue: "#VALUE!" };
  }
}

function evaluateQueryExpression(
  expression: string,
  sourceTabId: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  context: FormulaContext,
  dependencies: Set<string>,
  onReferenceError: (error: string, value: string) => void,
): FormulaExpressionResult | null {
  const call = parseQueryCall(expression);
  if (call === null) {
    return /^\s*QUERY\s*\(/iu.test(expression)
      ? { value: 0, dependencies, error: "Unsupported QUERY formula", errorValue: "#VALUE!" }
      : null;
  }
  if (call.headers !== undefined && call.headers !== 0 && call.headers !== 1) {
    return { value: 0, dependencies, error: "Unsupported QUERY formula", errorValue: "#VALUE!" };
  }
  const range = parseRangeOrNamedRange(call.range, context, sourceTabId);
  const query = parseQueryString(call.query);
  if (range === null || query === null) {
    if (isIdentifier(call.range)) {
      return { value: 0, dependencies, error: "Unknown named range", errorValue: "#NAME?" };
    }
    return { value: 0, dependencies, error: "Unsupported QUERY formula", errorValue: "#VALUE!" };
  }
  if ((range.bottom - range.top + 1) * (range.right - range.left + 1) > 5_000) {
    return {
      value: 0,
      dependencies,
      error: "QUERY source range is too large",
      errorValue: "#VALUE!",
    };
  }

  const selectColumn =
    query.select.kind === "column" ? queryColumnIndex(query.select.column, range) : null;
  const aggregateColumn =
    query.select.kind === "aggregate" && query.select.column !== "*"
      ? queryColumnIndex(query.select.column, range)
      : null;
  const whereColumn = query.where === null ? null : queryColumnIndex(query.where.column, range);
  const orderColumn = query.orderBy === null ? null : queryColumnIndex(query.orderBy.column, range);
  if (
    (selectColumn === null && query.select.kind === "column") ||
    (aggregateColumn === null &&
      query.select.kind === "aggregate" &&
      query.select.column !== "*") ||
    (whereColumn === null && query.where !== null) ||
    (orderColumn === null && query.orderBy !== null)
  ) {
    return {
      value: 0,
      dependencies,
      error: "QUERY column is outside the source range",
      errorValue: "#VALUE!",
    };
  }

  const rows = queryRows(
    range,
    sourceTabId,
    values,
    evaluateCell,
    visiting,
    context,
    dependencies,
    onReferenceError,
  ).slice(call.headers ?? 0);
  const filteredRows = rows.filter((row) =>
    query.where === null || whereColumn === null
      ? true
      : queryPredicateMatches(row[whereColumn] ?? "", query.where),
  );
  const orderedRows =
    query.orderBy === null || orderColumn === null
      ? filteredRows
      : [...filteredRows].sort((left, right) =>
          compareQueryRowValues(
            left[orderColumn] ?? "",
            right[orderColumn] ?? "",
            query.orderBy?.direction ?? "asc",
          ),
        );
  const limitedRows =
    query.limit === null ? orderedRows : orderedRows.slice(0, Math.max(0, query.limit));

  if (query.select.kind === "column") {
    return {
      value: limitedRows[0]?.[selectColumn ?? 0] ?? "",
      dependencies,
      error: null,
      errorValue: "",
    };
  }

  if (query.select.fn === "count" && query.select.column === "*") {
    return {
      value: limitedRows.filter((row) => row.some((value) => value.trim() !== "")).length,
      dependencies,
      error: null,
      errorValue: "",
    };
  }

  const selectedValues = limitedRows.map((row) => row[aggregateColumn ?? 0] ?? "");
  if (query.select.fn === "count") {
    return {
      value: selectedValues.filter((value) => value.trim() !== "").length,
      dependencies,
      error: null,
      errorValue: "",
    };
  }
  const numbers = selectedValues
    .map((value) => numericValue(value))
    .filter((value): value is number => value !== null);
  if (numbers.length === 0) {
    return { value: 0, dependencies, error: null, errorValue: "" };
  }
  if (query.select.fn === "avg") {
    return {
      value: numbers.reduce((total, value) => total + value, 0) / numbers.length,
      dependencies,
      error: null,
      errorValue: "",
    };
  }
  if (query.select.fn === "min") {
    return { value: Math.min(...numbers), dependencies, error: null, errorValue: "" };
  }
  if (query.select.fn === "max") {
    return { value: Math.max(...numbers), dependencies, error: null, errorValue: "" };
  }
  return {
    value: numbers.reduce((total, value) => total + value, 0),
    dependencies,
    error: null,
    errorValue: "",
  };
}

function evaluateHelixFunctionExpression(
  expression: string,
  sourceTabId: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  context: FormulaContext,
  dependencies: Set<string>,
  onReferenceError: (error: string, value: string) => void,
): FormulaExpressionResult | null {
  const call = parseFunctionCall(expression);
  if (call === null) {
    return /^\s*HELIX\./iu.test(expression)
      ? { value: 0, dependencies, error: "Unsupported HELIX formula", errorValue: "#VALUE!" }
      : null;
  }
  if (call.name === "HELIX.QUERY") {
    return evaluateQueryExpression(
      `QUERY(${call.args.join(",")})`,
      sourceTabId,
      values,
      evaluateCell,
      visiting,
      context,
      dependencies,
      onReferenceError,
    );
  }
  if (call.name === "HELIX.AI.CLASSIFY") {
    if (call.args.length !== 2) {
      return { value: 0, dependencies, error: "Unsupported HELIX formula", errorValue: "#VALUE!" };
    }
    const text = stringArgumentValue(
      call.args[0] ?? "",
      sourceTabId,
      values,
      evaluateCell,
      visiting,
      context,
      dependencies,
      onReferenceError,
    );
    const labels = labelsFromArgument(
      stringArgumentValue(
        call.args[1] ?? "",
        sourceTabId,
        values,
        evaluateCell,
        visiting,
        context,
        dependencies,
        onReferenceError,
      ),
    );
    if (labels.length === 0) {
      return { value: 0, dependencies, error: "Unsupported HELIX formula", errorValue: "#VALUE!" };
    }
    return {
      value: classifyText(text, labels),
      dependencies,
      error: null,
      errorValue: "",
    };
  }
  if (call.name === "HELIX.DRIVE.LIST") {
    if (call.args.length > 1) {
      return { value: 0, dependencies, error: "Unsupported HELIX formula", errorValue: "#VALUE!" };
    }
    const query =
      call.args.length === 0
        ? ""
        : stringArgumentValue(
            call.args[0] ?? "",
            sourceTabId,
            values,
            evaluateCell,
            visiting,
            context,
            dependencies,
            onReferenceError,
          );
    return {
      value: driveListValue(context.driveEntries, query),
      dependencies,
      error: null,
      errorValue: "",
    };
  }
  return { value: 0, dependencies, error: "Unsupported HELIX formula", errorValue: "#VALUE!" };
}

type SheetFormulaAggregateFunction = "sum" | "average" | "count" | "counta" | "min" | "max";
type SheetFormulaConditionalAggregateFunction = "sumif" | "countif" | "averageif";

function aggregateArguments(
  fn: SheetFormulaAggregateFunction,
  args: string,
  sourceTabId: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  dependencies: Set<string>,
  onReferenceError: (error: string, value: string) => void,
  context: FormulaContext,
): number {
  const valuesToAggregate = args
    .split(",")
    .flatMap((part) => expandArgument(part.trim(), context, sourceTabId))
    .map((referenceOrNumber) => {
      const reference = parseReference(referenceOrNumber, context, sourceTabId);
      if (reference === null) {
        if (isIdentifier(referenceOrNumber) && numericValue(referenceOrNumber) === null) {
          onReferenceError("Unknown named range", "#NAME?");
        }
        return referenceOrNumber;
      }
      const key = keyFromReference(reference);
      dependencies.add(referenceLabel(reference, context, sourceTabId));
      return stringForReference(key, values, evaluateCell, visiting, onReferenceError);
    });
  if (fn === "count") {
    return valuesToAggregate.filter((value) => numericValue(value) !== null).length;
  }
  if (fn === "counta") {
    return valuesToAggregate.filter((value) => value.trim() !== "").length;
  }
  const numbers = valuesToAggregate
    .map((value) => numericValue(value))
    .filter((value): value is number => value !== null);
  if (numbers.length === 0) {
    return 0;
  }
  if (fn === "average") {
    return numbers.reduce((total, value) => total + value, 0) / numbers.length;
  }
  if (fn === "min") {
    return Math.min(...numbers);
  }
  if (fn === "max") {
    return Math.max(...numbers);
  }
  return numbers.reduce((total, value) => total + value, 0);
}

function evaluateConditionalAggregateExpression(
  expression: string,
  sourceTabId: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  context: FormulaContext,
  dependencies: Set<string>,
  onReferenceError: (error: string, value: string) => void,
): FormulaExpressionResult | null {
  const call = parseConditionalAggregateCall(expression);
  if (call === null) {
    return /^\s*(SUMIF|COUNTIF|AVERAGEIF)\s*\(/iu.test(expression)
      ? { value: 0, dependencies, error: "Unsupported formula", errorValue: "#VALUE!" }
      : null;
  }
  const criteriaRange = parseFormulaRange(call.criteriaRange, context, sourceTabId);
  const aggregateRange =
    call.aggregateRange === null
      ? criteriaRange
      : parseFormulaRange(call.aggregateRange, context, sourceTabId);
  if (criteriaRange === null || aggregateRange === null) {
    if (
      isIdentifier(call.criteriaRange) ||
      (call.aggregateRange !== null && isIdentifier(call.aggregateRange))
    ) {
      return { value: 0, dependencies, error: "Unknown named range", errorValue: "#NAME?" };
    }
    return { value: 0, dependencies, error: "Unsupported formula", errorValue: "#VALUE!" };
  }
  if (
    rangeHeight(criteriaRange) !== rangeHeight(aggregateRange) ||
    rangeWidth(criteriaRange) !== rangeWidth(aggregateRange)
  ) {
    return {
      value: 0,
      dependencies,
      error: "Formula ranges must have matching shapes",
      errorValue: "#VALUE!",
    };
  }
  const criteriaValue = stringArgumentValue(
    call.criteria,
    sourceTabId,
    values,
    evaluateCell,
    visiting,
    context,
    dependencies,
    onReferenceError,
  );
  const criteria = parseConditionalCriteria(criteriaValue);
  const matchingValues: string[] = [];
  for (let rowOffset = 0; rowOffset < rangeHeight(criteriaRange); rowOffset += 1) {
    for (let colOffset = 0; colOffset < rangeWidth(criteriaRange); colOffset += 1) {
      const criteriaRow = criteriaRange.top + rowOffset;
      const criteriaCol = criteriaRange.left + colOffset;
      const aggregateRow = aggregateRange.top + rowOffset;
      const aggregateCol = aggregateRange.left + colOffset;
      dependencies.add(
        referenceLabel(
          { tabId: criteriaRange.tabId, row: criteriaRow, col: criteriaCol, explicitTab: false },
          context,
          sourceTabId,
        ),
      );
      dependencies.add(
        referenceLabel(
          {
            tabId: aggregateRange.tabId,
            row: aggregateRow,
            col: aggregateCol,
            explicitTab: false,
          },
          context,
          sourceTabId,
        ),
      );
      const candidate = stringForReference(
        formulaCellKey(criteriaRange.tabId, criteriaRow, criteriaCol),
        values,
        evaluateCell,
        visiting,
        onReferenceError,
      );
      if (!conditionalCriteriaMatches(candidate, criteria)) {
        continue;
      }
      matchingValues.push(
        stringForReference(
          formulaCellKey(aggregateRange.tabId, aggregateRow, aggregateCol),
          values,
          evaluateCell,
          visiting,
          onReferenceError,
        ),
      );
    }
  }
  if (call.fn === "countif") {
    return { value: matchingValues.length, dependencies, error: null, errorValue: "" };
  }
  const numbers = matchingValues
    .map((value) => numericValue(value))
    .filter((value): value is number => value !== null);
  if (numbers.length === 0) {
    return { value: 0, dependencies, error: null, errorValue: "" };
  }
  if (call.fn === "averageif") {
    return {
      value: numbers.reduce((total, value) => total + value, 0) / numbers.length,
      dependencies,
      error: null,
      errorValue: "",
    };
  }
  return {
    value: numbers.reduce((total, value) => total + value, 0),
    dependencies,
    error: null,
    errorValue: "",
  };
}

function parseConditionalAggregateCall(expression: string): {
  readonly fn: SheetFormulaConditionalAggregateFunction;
  readonly criteriaRange: string;
  readonly criteria: string;
  readonly aggregateRange: string | null;
} | null {
  const trimmed = expression.trim();
  const openIndex = trimmed.indexOf("(");
  if (openIndex <= 0 || !trimmed.endsWith(")")) {
    return null;
  }
  const name = trimmed.slice(0, openIndex).trim().toLowerCase();
  if (name !== "sumif" && name !== "countif" && name !== "averageif") {
    return null;
  }
  const args = splitFunctionArguments(trimmed.slice(openIndex + 1, -1));
  if (args === null) {
    return null;
  }
  if (name === "countif") {
    return args.length === 2
      ? { fn: name, criteriaRange: args[0] ?? "", criteria: args[1] ?? "", aggregateRange: null }
      : null;
  }
  if (args.length < 2 || args.length > 3) {
    return null;
  }
  return {
    fn: name,
    criteriaRange: args[0] ?? "",
    criteria: args[1] ?? "",
    aggregateRange: args[2] ?? null,
  };
}

function parseConditionalCriteria(value: string): ParsedConditionalCriteria {
  const match = /^(>=|<=|<>|!=|>|<|=)?\s*(.*?)\s*$/u.exec(value.trim());
  const operator = (match?.[1] ?? "=") as ParsedConditionalCriteria["operator"];
  const rawValue = match?.[2] ?? value;
  const numeric = numericValue(rawValue);
  return {
    operator,
    value: numeric ?? rawValue,
  };
}

interface ParsedConditionalCriteria {
  readonly operator: "=" | "!=" | "<>" | ">" | ">=" | "<" | "<=";
  readonly value: string | number;
}

function conditionalCriteriaMatches(value: string, criteria: ParsedConditionalCriteria): boolean {
  if (typeof criteria.value === "number") {
    const numeric = numericValue(value);
    if (numeric === null) {
      return criteria.operator === "!=" || criteria.operator === "<>";
    }
    if (criteria.operator === "=") {
      return numeric === criteria.value;
    }
    if (criteria.operator === "!=" || criteria.operator === "<>") {
      return numeric !== criteria.value;
    }
    if (criteria.operator === ">") {
      return numeric > criteria.value;
    }
    if (criteria.operator === ">=") {
      return numeric >= criteria.value;
    }
    if (criteria.operator === "<") {
      return numeric < criteria.value;
    }
    return numeric <= criteria.value;
  }
  if (criteria.operator !== "=" && criteria.operator !== "!=" && criteria.operator !== "<>") {
    return false;
  }
  const matches =
    criteria.value.includes("*") || criteria.value.includes("?")
      ? wildcardCriteriaMatches(value, criteria.value)
      : value.localeCompare(criteria.value, undefined, { sensitivity: "accent" }) === 0;
  return criteria.operator === "=" ? matches : !matches;
}

function wildcardCriteriaMatches(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const source = `^${escaped.replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`;
  return new RegExp(source, "iu").test(value);
}

function expandArgument(
  value: string,
  context: FormulaContext,
  sourceTabId: string,
): readonly string[] {
  const range = parseFormulaRange(value, context, sourceTabId);
  if (range === null) {
    return [value];
  }
  const references: string[] = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    for (let col = range.left; col <= range.right; col += 1) {
      references.push(
        referenceLabel({ tabId: range.tabId, row, col, explicitTab: false }, context, sourceTabId),
      );
    }
  }
  return references;
}

function parseFormulaRange(
  reference: string,
  context: FormulaContext,
  sourceTabId: string,
): FormulaRange | null {
  const range = parseRangeOrNamedRange(reference, context, sourceTabId);
  if (range !== null) {
    return range;
  }
  const cell = parseReference(reference, context, sourceTabId);
  if (cell === null) {
    return null;
  }
  return {
    tabId: cell.tabId,
    top: cell.row,
    bottom: cell.row,
    left: cell.col,
    right: cell.col,
  };
}

function rangeHeight(range: { readonly top: number; readonly bottom: number }): number {
  return range.bottom - range.top + 1;
}

function rangeWidth(range: { readonly left: number; readonly right: number }): number {
  return range.right - range.left + 1;
}

type QueryColumn = "*" | { readonly token: string };

interface ParsedQuery {
  readonly select:
    | { readonly kind: "column"; readonly column: QueryColumn }
    | {
        readonly kind: "aggregate";
        readonly fn: "sum" | "count" | "avg" | "min" | "max";
        readonly column: QueryColumn;
      };
  readonly where: ParsedQueryPredicate | null;
  readonly orderBy: ParsedQueryOrder | null;
  readonly limit: number | null;
}

interface ParsedQueryPredicate {
  readonly column: QueryColumn;
  readonly operator: "=" | "!=" | "<>" | ">" | ">=" | "<" | "<=" | "contains";
  readonly value: string | number;
}

interface ParsedQueryOrder {
  readonly column: QueryColumn;
  readonly direction: "asc" | "desc";
}

function parseQueryCall(
  expression: string,
): { readonly range: string; readonly query: string; readonly headers: number | undefined } | null {
  const trimmed = expression.trim();
  const openIndex = trimmed.indexOf("(");
  if (openIndex <= 0 || !trimmed.endsWith(")")) {
    return null;
  }
  const name = trimmed.slice(0, openIndex).trim().toUpperCase();
  if (name !== "QUERY" && name !== "HELIX.QUERY") {
    return null;
  }
  const args = splitFunctionArguments(trimmed.slice(openIndex + 1, -1));
  if (args === null || args.length < 2 || args.length > 3) {
    return null;
  }
  const query = quotedStringValue(args[1] ?? "");
  if (query === null) {
    return null;
  }
  const headers = args[2] === undefined ? undefined : Number(args[2]);
  if (headers !== undefined && (!Number.isInteger(headers) || headers < 0)) {
    return null;
  }
  return {
    range: args[0] ?? "",
    query,
    headers,
  };
}

function parseFunctionCall(
  expression: string,
): { readonly name: string; readonly args: readonly string[] } | null {
  const trimmed = expression.trim();
  const openIndex = trimmed.indexOf("(");
  if (openIndex <= 0 || !trimmed.endsWith(")")) {
    return null;
  }
  const name = trimmed.slice(0, openIndex).trim().toUpperCase();
  if (name !== "HELIX.QUERY" && name !== "HELIX.AI.CLASSIFY" && name !== "HELIX.DRIVE.LIST") {
    return null;
  }
  const rawArgs = trimmed.slice(openIndex + 1, -1);
  const args = splitFunctionArguments(rawArgs);
  return args === null ? null : { name, args };
}

function splitFunctionArguments(rawArgs: string): readonly string[] | null {
  const args: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const char = rawArgs[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return null;
      }
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(rawArgs.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote !== null || depth !== 0) {
    return null;
  }
  const lastArg = rawArgs.slice(start).trim();
  if (lastArg.length > 0 || rawArgs.trim().length > 0) {
    args.push(lastArg);
  }
  return args;
}

function parseQueryString(query: string): ParsedQuery | null {
  const match =
    /^select\s+(.+?)(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+([A-Z]+|COL[1-9][0-9]*)(?:\s+(asc|desc))?)?(?:\s+limit\s+([1-9][0-9]*))?\s*$/iu.exec(
      query.trim(),
    );
  if (match === null) {
    return null;
  }
  const select = parseQuerySelect(match[1] ?? "");
  if (select === null) {
    return null;
  }
  const where = match[2] === undefined ? null : parseQueryPredicate(match[2]);
  if (match[2] !== undefined && where === null) {
    return null;
  }
  const orderColumn = match[3] === undefined ? null : queryColumn(match[3]);
  if (orderColumn === "*") {
    return null;
  }
  const orderBy =
    orderColumn === null
      ? null
      : ({
          column: orderColumn,
          direction: (match[4] ?? "asc").toLowerCase() === "desc" ? "desc" : "asc",
        } satisfies ParsedQueryOrder);
  if (match[3] !== undefined && orderBy === null) {
    return null;
  }
  return {
    select,
    where,
    orderBy,
    limit: match[5] === undefined ? null : Number(match[5]),
  };
}

function parseQuerySelect(query: string): ParsedQuery["select"] | null {
  const aggregate = /^(sum|count|avg|min|max)\s*\(\s*(\*|[A-Z]+|COL[1-9][0-9]*)\s*\)$/iu.exec(
    query.trim(),
  );
  if (aggregate !== null) {
    const fn = (aggregate[1] ?? "").toLowerCase() as "sum" | "count" | "avg" | "min" | "max";
    const column = queryColumn(aggregate[2] ?? "");
    return column === null || (column === "*" && fn !== "count")
      ? null
      : { kind: "aggregate", fn, column };
  }
  const column = queryColumn(query.trim());
  return column === null || column === "*" ? null : { kind: "column", column };
}

function parseQueryPredicate(query: string): ParsedQueryPredicate | null {
  const match =
    /^([A-Z]+|COL[1-9][0-9]*)\s*(contains|=|!=|<>|>=|<=|>|<)\s*(?:"([^"]*)"|'([^']*)'|(-?[0-9]+(?:\.[0-9]+)?))\s*$/iu.exec(
      query.trim(),
    );
  if (match === null) {
    return null;
  }
  const column = queryColumn(match[1] ?? "");
  if (column === null || column === "*") {
    return null;
  }
  const operator = (match[2] ?? "=").toLowerCase() as ParsedQueryPredicate["operator"];
  return {
    column,
    operator,
    value: match[5] === undefined ? (match[3] ?? match[4] ?? "") : Number(match[5]),
  };
}

function queryColumn(token: string): QueryColumn | null {
  const normalized = token.toUpperCase();
  return normalized === "*" || /^[A-Z]+$/u.test(normalized) || /^COL[1-9][0-9]*$/u.test(normalized)
    ? normalized === "*"
      ? "*"
      : { token: normalized }
    : null;
}

function queryColumnIndex(
  column: QueryColumn,
  range: { readonly left: number; readonly right: number },
): number | null {
  if (column === "*") {
    return null;
  }
  const absoluteIndex = column.token.startsWith("COL")
    ? range.left + Number(column.token.slice(3)) - 1
    : columnIndex(column.token);
  return absoluteIndex < range.left || absoluteIndex > range.right
    ? null
    : absoluteIndex - range.left;
}

function queryRows(
  range: FormulaRange,
  sourceTabId: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  context: FormulaContext,
  dependencies: Set<string>,
  onReferenceError: (error: string, value: string) => void,
): string[][] {
  const rows: string[][] = [];
  for (let row = range.top; row <= range.bottom; row += 1) {
    const rowValues: string[] = [];
    for (let col = range.left; col <= range.right; col += 1) {
      dependencies.add(
        referenceLabel({ tabId: range.tabId, row, col, explicitTab: false }, context, sourceTabId),
      );
      rowValues.push(
        stringForReference(
          formulaCellKey(range.tabId, row, col),
          values,
          evaluateCell,
          visiting,
          onReferenceError,
        ),
      );
    }
    rows.push(rowValues);
  }
  return rows;
}

function queryPredicateMatches(value: string, predicate: ParsedQueryPredicate): boolean {
  if (predicate.operator === "contains") {
    return value.toLowerCase().includes(String(predicate.value).toLowerCase());
  }
  if (typeof predicate.value === "number") {
    const numeric = numericValue(value);
    if (numeric === null) {
      return false;
    }
    if (predicate.operator === "=") {
      return numeric === predicate.value;
    }
    if (predicate.operator === "!=" || predicate.operator === "<>") {
      return numeric !== predicate.value;
    }
    if (predicate.operator === ">") {
      return numeric > predicate.value;
    }
    if (predicate.operator === ">=") {
      return numeric >= predicate.value;
    }
    if (predicate.operator === "<") {
      return numeric < predicate.value;
    }
    return numeric <= predicate.value;
  }
  if (predicate.operator === "=") {
    return value === predicate.value;
  }
  if (predicate.operator === "!=" || predicate.operator === "<>") {
    return value !== predicate.value;
  }
  return false;
}

function compareQueryRowValues(left: string, right: string, direction: "asc" | "desc"): number {
  const leftNumber = numericValue(left);
  const rightNumber = numericValue(right);
  const result =
    leftNumber !== null && rightNumber !== null
      ? leftNumber - rightNumber
      : left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  return direction === "desc" ? -result : result;
}

function valueForReference(
  key: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  onReferenceError: (error: string, value: string) => void,
): number {
  const evaluation = evaluateCell(key, visiting);
  if (evaluation.error !== null) {
    onReferenceError(evaluation.error, evaluation.calcValue ?? "#VALUE!");
    return 0;
  }
  return numberFromValue(evaluation.calcValue ?? values.get(key) ?? "");
}

function stringForReference(
  key: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  onReferenceError: (error: string, value: string) => void,
): string {
  const evaluation = evaluateCell(key, visiting);
  if (evaluation.error !== null) {
    onReferenceError(evaluation.error, evaluation.calcValue ?? "#VALUE!");
    return "";
  }
  return evaluation.calcValue ?? values.get(key) ?? "";
}

function stringArgumentValue(
  rawArgument: string,
  sourceTabId: string,
  values: ReadonlyMap<string, string>,
  evaluateCell: (key: string, visiting: ReadonlySet<string>) => SheetFormulaEvaluation,
  visiting: ReadonlySet<string>,
  context: FormulaContext,
  dependencies: Set<string>,
  onReferenceError: (error: string, value: string) => void,
): string {
  const argument = rawArgument.trim();
  const quoted = quotedStringValue(argument);
  if (quoted !== null) {
    return quoted;
  }
  const reference = parseReference(argument, context, sourceTabId);
  if (reference !== null) {
    const key = keyFromReference(reference);
    dependencies.add(referenceLabel(reference, context, sourceTabId));
    return stringForReference(key, values, evaluateCell, visiting, onReferenceError);
  }
  return argument;
}

function quotedStringValue(value: string): string | null {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) {
    return null;
  }
  return value.slice(1, -1);
}

function labelsFromArgument(value: string): readonly string[] {
  return value
    .split(/[|,]/u)
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function classifyText(text: string, labels: readonly string[]): string {
  const normalizedText = text.toLowerCase();
  const textTokens = new Set(textTokensFromValue(normalizedText));
  let bestLabel = labels[0] ?? "Unclassified";
  let bestScore = -1;
  for (const label of labels) {
    const normalizedLabel = label.toLowerCase();
    const labelTokens = textTokensFromValue(normalizedLabel);
    const score =
      (normalizedText.includes(normalizedLabel) ? 3 : 0) +
      labelTokens.filter((token) => textTokens.has(token)).length;
    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }
  return bestLabel;
}

function driveListValue(entries: readonly SheetFormulaDriveEntry[], query: string): string {
  const normalizedQuery = query.trim().toLowerCase();
  return entries
    .filter((entry) => {
      if (normalizedQuery.length === 0) {
        return true;
      }
      return [entry.name, entry.path, entry.mimeType, entry.summary].some((value) =>
        (value ?? "").toLowerCase().includes(normalizedQuery),
      );
    })
    .slice(0, 10)
    .map((entry) => entry.name)
    .join(", ");
}

function textTokensFromValue(value: string): string[] {
  return value.split(/[^a-z0-9]+/u).filter((token) => token.length > 1);
}

function numberFromValue(value: string): number {
  return numericValue(value) ?? 0;
}

function numericValue(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const numeric = Number(value.replace(/[$,\s]/gu, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function evaluateArithmetic(expression: string): number {
  const parser = new ArithmeticParser(expression);
  const value = parser.parseExpression();
  parser.assertComplete();
  return value;
}

class ArithmeticParser {
  #index = 0;

  constructor(private readonly input: string) {}

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      this.skipWhitespace();
      if (this.peek() === "+") {
        this.#index += 1;
        value += this.parseTerm();
      } else if (this.peek() === "-") {
        this.#index += 1;
        value -= this.parseTerm();
      } else {
        return value;
      }
    }
  }

  assertComplete(): void {
    this.skipWhitespace();
    if (this.#index !== this.input.length) {
      throw new Error("Unexpected formula token.");
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    for (;;) {
      this.skipWhitespace();
      if (this.peek() === "*") {
        this.#index += 1;
        value *= this.parseFactor();
      } else if (this.peek() === "/") {
        this.#index += 1;
        value /= this.parseFactor();
      } else {
        return value;
      }
    }
  }

  private parseFactor(): number {
    this.skipWhitespace();
    const char = this.peek();
    if (char === "-") {
      this.#index += 1;
      return -this.parseFactor();
    }
    if (char === "(") {
      this.#index += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ")") {
        throw new Error("Missing formula parenthesis.");
      }
      this.#index += 1;
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const start = this.#index;
    while (/[0-9.]/u.test(this.peek() ?? "")) {
      this.#index += 1;
    }
    if (start === this.#index) {
      throw new Error("Expected formula number.");
    }
    return Number(this.input.slice(start, this.#index));
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.peek() ?? "")) {
      this.#index += 1;
    }
  }

  private peek(): string | undefined {
    return this.input[this.#index];
  }
}

const formulaCellReferencePattern =
  /((?:'(?:''|[^'])+'|[A-Z_][A-Z0-9_.-]*)!\$?[A-Z]+\$?[1-9][0-9]*|\$?[A-Z]+\$?[1-9][0-9]*)/giu;

function keyFromReference(reference: FormulaCellReference): string {
  return formulaCellKey(reference.tabId, reference.row, reference.col);
}

function parseRangeReference(
  reference: string,
  context: FormulaContext,
  sourceTabId: string,
): FormulaRange | null {
  const scoped = splitTabScope(reference, context, sourceTabId);
  if (scoped === null) {
    return null;
  }
  const rangeMatch = /^(\$?[A-Z]+\$?[1-9][0-9]*):(\$?[A-Z]+\$?[1-9][0-9]*)$/iu.exec(
    scoped.reference,
  );
  if (rangeMatch === null) {
    return null;
  }
  const start = parseReference(rangeMatch[1] ?? "", context, scoped.tabId);
  const end = parseReference(rangeMatch[2] ?? "", context, scoped.tabId);
  if (start === null || end === null) {
    return null;
  }
  return {
    tabId: scoped.tabId,
    top: Math.min(start.row, end.row),
    bottom: Math.max(start.row, end.row),
    left: Math.min(start.col, end.col),
    right: Math.max(start.col, end.col),
  };
}

function parseRangeOrNamedRange(
  reference: string,
  context: FormulaContext,
  sourceTabId: string,
): FormulaRange | null {
  const range = parseRangeReference(reference, context, sourceTabId);
  if (range !== null) {
    return range;
  }
  const namedRange = context.namedRanges.get(namedRangeKey(reference));
  if (namedRange === undefined) {
    return null;
  }
  const tabId = namedRange.tabId ?? sourceTabId;
  return {
    tabId,
    top: Math.min(namedRange.range.startRow, namedRange.range.endRow),
    bottom: Math.max(namedRange.range.startRow, namedRange.range.endRow),
    left: Math.min(namedRange.range.startCol, namedRange.range.endCol),
    right: Math.max(namedRange.range.startCol, namedRange.range.endCol),
  };
}

function parseReference(
  reference: string,
  context: FormulaContext,
  sourceTabId: string,
): FormulaCellReference | null {
  const scoped = splitTabScope(reference, context, sourceTabId);
  if (scoped === null) {
    return null;
  }
  const match = /^\$?([A-Z]+)\$?([1-9][0-9]*)$/iu.exec(scoped.reference.trim());
  if (match === null) {
    return null;
  }
  const col = columnIndex(match[1] ?? "") + 1;
  return {
    tabId: scoped.tabId,
    row: Number(match[2]) - 1,
    col: col - 1,
    explicitTab: scoped.explicitTab,
  };
}

function splitTabScope(
  reference: string,
  context: FormulaContext,
  sourceTabId: string,
): { readonly tabId: string; readonly reference: string; readonly explicitTab: boolean } | null {
  const trimmed = reference.trim();
  const quoted = /^'((?:''|[^'])+)'!(.+)$/u.exec(trimmed);
  if (quoted !== null) {
    const tabName = (quoted[1] ?? "").replace(/''/gu, "'");
    const tabId = context.tabIdByName.get(tabNameKey(tabName));
    return tabId === undefined ? null : { tabId, reference: quoted[2] ?? "", explicitTab: true };
  }
  const unquoted = /^([A-Z_][A-Z0-9_.-]*)!(.+)$/iu.exec(trimmed);
  if (unquoted !== null) {
    const tabId = context.tabIdByName.get(tabNameKey(unquoted[1] ?? ""));
    return tabId === undefined ? null : { tabId, reference: unquoted[2] ?? "", explicitTab: true };
  }
  return { tabId: sourceTabId, reference: trimmed, explicitTab: false };
}

function namedRangeMap(
  ranges: readonly SheetFormulaNamedRange[],
): ReadonlyMap<string, SheetFormulaNamedRange> {
  const map = new Map<string, SheetFormulaNamedRange>();
  for (const range of ranges) {
    if (isIdentifier(range.name)) {
      map.set(namedRangeKey(range.name), range);
    }
  }
  return map;
}

function namedRangeKey(name: string): string {
  return name.trim().toUpperCase();
}

function tabNameKey(name: string): string {
  return name.trim().toUpperCase();
}

function isIdentifier(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/iu.test(value.trim());
}

function columnIndex(label: string): number {
  let total = 0;
  for (const char of label.toUpperCase()) {
    total = total * 26 + (char.charCodeAt(0) - 64);
  }
  return total - 1;
}

function referenceLabel(
  reference: FormulaCellReference,
  context: FormulaContext,
  sourceTabId: string,
): string {
  const label = cellReference(reference.row, reference.col);
  if (!reference.explicitTab && reference.tabId === sourceTabId) {
    return label;
  }
  const tabName = context.tabNameById.get(reference.tabId) ?? reference.tabId;
  return `${formatTabLabel(tabName)}!${label}`;
}

function formatTabLabel(tabName: string): string {
  return /^[A-Z_][A-Z0-9_.-]*$/iu.test(tabName) ? tabName : `'${tabName.replace(/'/gu, "''")}'`;
}

function formulaCellTabId(cell: FormulaCellInput, context: FormulaContext): string {
  return cell.sheetTabId ?? context.currentTabId;
}

function formulaSourceTabId(key: string, context: FormulaContext): string {
  if (!context.hasTabContext) {
    return context.currentTabId;
  }
  return key.slice(0, key.indexOf(":"));
}

function resultCellKey(cell: FormulaCellInput, context: FormulaContext): string {
  return context.hasTabContext
    ? formulaCellKey(formulaCellTabId(cell, context), cell.row, cell.col)
    : cellKey(cell.row, cell.col);
}

function formulaCellKey(tabId: string, row: number, col: number): string {
  return `${tabId}:${String(row)}:${String(col)}`;
}

function cellKey(row: number, col: number): string {
  return `${String(row)}:${String(col)}`;
}

function tabIdByNameMap(tabs: readonly SheetFormulaTab[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const tab of tabs) {
    map.set(tabNameKey(tab.name), tab.id);
  }
  return map;
}

function tabNameByIdMap(tabs: readonly SheetFormulaTab[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const tab of tabs) {
    map.set(tab.id, tab.name);
  }
  return map;
}

function formatFormulaResult(value: FormulaValue): string {
  return typeof value === "number" ? formatFormulaNumber(value) : value;
}

function formatFormulaNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
}
