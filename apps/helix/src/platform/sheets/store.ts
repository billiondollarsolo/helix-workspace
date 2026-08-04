import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { insertNotification } from "../notifications/index.js";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import { cellReference, evaluateSheetFormulas, type SheetFormulaNamedRange } from "./formula.js";
import { activityChainHash } from "../activity/hash-chain.js";
import type {
  SheetCellEdit,
  SheetCellRecord,
  SheetCommentListItem,
  SheetCommentRecord,
  SheetRecord,
  SheetTabRecord,
  SheetTabWithCells,
  SheetWithTabs,
} from "./types.js";

/** Raised when a sheet/tab is missing or not visible to the actor. */
export class SheetsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsNotFoundError";
  }
}

/** Raised when a mutation would violate a domain invariant. */
export class SheetsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetsValidationError";
  }
}

export interface CreateSheetInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly title: string;
  readonly metadata?: JsonObject | undefined;
  readonly folderId?: string | null | undefined;
  /**
   * Names for the initial tabs. When omitted a single "Sheet1" tab is created
   * so a new spreadsheet is always immediately editable.
   */
  readonly tabNames?: readonly string[] | undefined;
}

export interface CopySheetInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly title?: string | undefined;
  readonly folderId?: string | null | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface ListSheetsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly query?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface SheetsPage {
  readonly sheets: readonly SheetRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface UpdateSheetInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly title?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface SheetRef {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
}

export interface CreateTabInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly name: string;
  readonly position?: number | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface UpdateTabInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly tabId: string;
  readonly name?: string | undefined;
  readonly position?: number | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface TabRef {
  readonly orgId: string;
  readonly actorId: string;
  readonly tabId: string;
}

export interface SheetCellWindow {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

export interface GetTabCellsInput extends TabRef {
  readonly window?: SheetCellWindow | undefined;
}

export interface UpdateCellsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly tabId: string;
  readonly edits: readonly SheetCellEdit[];
  readonly window?: SheetCellWindow | undefined;
}

export interface SortRangeInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly tabId: string;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
  readonly direction: "asc" | "desc";
  readonly window?: SheetCellWindow | undefined;
}

export interface CreateSheetCommentInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly parentCommentId?: string | undefined;
  readonly body: string;
  readonly anchor?: JsonObject | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface ListSheetCommentsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly status?: string | undefined;
}

export interface ResolveSheetCommentInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly commentId: string;
}

export interface UpdateSheetCommentInput extends ResolveSheetCommentInput {
  readonly body: string;
}

export type DeleteSheetCommentInput = ResolveSheetCommentInput;

export interface SheetOperationLogRecord {
  readonly orgId: string;
  readonly sheetId: string;
  readonly tabId: string;
  readonly actorId: string | null;
  readonly operationId: string;
  readonly revision: number;
  readonly baseRevision: number;
  readonly operation: SheetOperation;
  readonly createdAt: Date;
}

export interface AppendSheetOperationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly tabId: string;
  readonly operationId: string;
  readonly baseRevision: number;
  readonly operation: SheetOperation;
}

export interface CompactSheetOperationsInput extends SheetRef {
  readonly retainRevisions: number;
}

export interface CompactSheetOperationsResult {
  readonly latestRevision: number;
  readonly compactedThroughRevision: number;
  readonly deletedCount: number;
}

export interface SheetVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly sheetId: string;
  readonly versionNumber: number;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly createdByActorId: string | null;
  readonly createdAt: Date;
}

export interface ListSheetVersionsInput extends SheetRef {
  readonly limit: number;
}

export interface RestoreSheetVersionInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly versionId: string;
}

export type SheetCellOperation =
  | {
      readonly kind: "set-cell";
      readonly row: number;
      readonly col: number;
      readonly value: string;
    }
  | {
      readonly kind: "clear-cell";
      readonly row: number;
      readonly col: number;
    }
  | {
      readonly kind: "insert-rows";
      readonly index: number;
      readonly count: number;
    }
  | {
      readonly kind: "delete-rows";
      readonly index: number;
      readonly count: number;
    }
  | {
      readonly kind: "insert-columns";
      readonly index: number;
      readonly count: number;
    }
  | {
      readonly kind: "delete-columns";
      readonly index: number;
      readonly count: number;
    };

export interface SheetOperation {
  readonly id: string;
  readonly baseRevision: number;
  readonly changes: readonly SheetCellOperation[];
}

export interface SheetSnapshotStorageClient {
  put(object: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
  }): Promise<void>;
  get?(key: string): Promise<{
    readonly key: string;
    readonly body: Uint8Array | AsyncIterable<Uint8Array>;
    readonly contentType?: string | undefined;
  } | null>;
}

export type SheetSnapshotStorageResolver = (input: {
  readonly orgId: string;
}) =>
  | Promise<{ readonly client: SheetSnapshotStorageClient } | undefined>
  | { readonly client: SheetSnapshotStorageClient }
  | undefined;

export interface ApplySheetOperationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly sheetId: string;
  readonly tabId: string;
  readonly operation: SheetOperation;
}

export type ApplySheetOperationResult =
  | {
      readonly status: "applied";
      readonly revision: number;
      readonly operation: SheetOperation;
      readonly tab: SheetTabWithCells;
    }
  | {
      readonly status: "dropped";
      readonly operationId: string;
      readonly revision: number;
    }
  | {
      readonly status: "duplicate";
      readonly operationId: string;
      readonly revision: number;
    }
  | {
      readonly status: "ahead";
      readonly operationId: string;
      readonly revision: number;
    }
  | {
      readonly status: "compacted";
      readonly operationId: string;
      readonly revision: number;
      readonly compactedThroughRevision: number;
    };

/**
 * Persistence contract for the Sheets domain. Implemented by both
 * {@link PostgresSheetsStore} and {@link InMemorySheetsStore} so tools can be
 * exercised without a database.
 */
export interface SheetsStore {
  createSheet(input: CreateSheetInput): Promise<SheetWithTabs>;
  copySheet(input: CopySheetInput): Promise<SheetWithTabs | null>;
  listSheets(input: ListSheetsInput): Promise<SheetsPage>;
  getSheet(input: SheetRef): Promise<SheetWithTabs | null>;
  updateSheet(input: UpdateSheetInput): Promise<SheetWithTabs | null>;
  deleteSheet(input: SheetRef): Promise<SheetRecord | null>;
  createTab(input: CreateTabInput): Promise<SheetTabRecord>;
  updateTab(input: UpdateTabInput): Promise<SheetTabRecord | null>;
  deleteTab(input: TabRef): Promise<SheetTabRecord | null>;
  getTabCells(input: GetTabCellsInput): Promise<SheetTabWithCells | null>;
  updateCells(input: UpdateCellsInput): Promise<SheetTabWithCells>;
  sortRange(input: SortRangeInput): Promise<SheetTabWithCells>;
  createComment(input: CreateSheetCommentInput): Promise<SheetCommentRecord>;
  listComments(input: ListSheetCommentsInput): Promise<readonly SheetCommentListItem[]>;
  resolveComment(input: ResolveSheetCommentInput): Promise<SheetCommentRecord | null>;
  reopenComment(input: ResolveSheetCommentInput): Promise<SheetCommentRecord | null>;
  updateComment(input: UpdateSheetCommentInput): Promise<SheetCommentRecord | null>;
  deleteComment(input: DeleteSheetCommentInput): Promise<SheetCommentRecord | null>;
  listOperations(
    input: SheetRef & { readonly afterRevision?: number | undefined },
  ): Promise<readonly SheetOperationLogRecord[]>;
  appendOperation(input: AppendSheetOperationInput): Promise<SheetOperationLogRecord>;
  applyOperation(input: ApplySheetOperationInput): Promise<ApplySheetOperationResult>;
  compactOperations(input: CompactSheetOperationsInput): Promise<CompactSheetOperationsResult>;
  listVersions(input: ListSheetVersionsInput): Promise<readonly SheetVersionRecord[]>;
  restoreVersion(input: RestoreSheetVersionInput): Promise<SheetWithTabs | null>;
}

const MAX_TITLE = 255;
const MAX_TAB_NAME = 120;
const MAX_CELL_VALUE = 32_768;
const DEFAULT_TAB_NAME = "Sheet1";

function assertTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new SheetsValidationError("Sheet title must not be empty.");
  }
  if (trimmed.length > MAX_TITLE) {
    throw new SheetsValidationError(`Sheet title must be at most ${String(MAX_TITLE)} characters.`);
  }
  return trimmed;
}

function assertTabName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new SheetsValidationError("Tab name must not be empty.");
  }
  if (trimmed.length > MAX_TAB_NAME) {
    throw new SheetsValidationError(`Tab name must be at most ${String(MAX_TAB_NAME)} characters.`);
  }
  return trimmed;
}

function assertCellEdit(edit: SheetCellEdit): void {
  if (!Number.isInteger(edit.row) || edit.row < 0) {
    throw new SheetsValidationError("Cell row must be a non-negative integer.");
  }
  if (!Number.isInteger(edit.col) || edit.col < 0) {
    throw new SheetsValidationError("Cell column must be a non-negative integer.");
  }
  if (edit.value.length > MAX_CELL_VALUE) {
    throw new SheetsValidationError(
      `Cell value must be at most ${String(MAX_CELL_VALUE)} characters.`,
    );
  }
}

function normalizeSheetRange(range: SortRangeInput["range"]): {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
} {
  for (const [name, value] of Object.entries(range)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new SheetsValidationError(`${name} must be a non-negative integer.`);
    }
  }
  return {
    top: Math.min(range.startRow, range.endRow),
    left: Math.min(range.startCol, range.endCol),
    bottom: Math.max(range.startRow, range.endRow),
    right: Math.max(range.startCol, range.endCol),
  };
}

function filterCellsInWindow(
  cells: readonly SheetCellRecord[],
  window: SheetCellWindow | undefined,
): readonly SheetCellRecord[] {
  if (window === undefined) {
    return cells;
  }
  const normalized = normalizeSheetRange(window);
  return cells.filter(
    (cell) =>
      cell.row >= normalized.top &&
      cell.row <= normalized.bottom &&
      cell.col >= normalized.left &&
      cell.col <= normalized.right,
  );
}

/** True when an edit clears the cell (empty value, no format). */
function isClearingEdit(edit: SheetCellEdit): boolean {
  return edit.value.length === 0 && (edit.format === undefined || isEmptyObject(edit.format));
}

function isEmptyObject(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}

function assertRetainedOperationRevisions(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new SheetsValidationError("Retained operation revisions must be a positive integer.");
  }
  return value;
}

function latestSheetOperationRevision(
  operations: readonly SheetOperationLogRecord[],
  compactedThroughRevision: number,
): number {
  return operations.reduce(
    (latest, operation) => Math.max(latest, operation.revision),
    compactedThroughRevision,
  );
}

function compactedThroughRevisionFromMetadata(metadata: JsonObject): number {
  const sync = metadata["sheetsSync"];
  if (typeof sync !== "object" || sync === null || Array.isArray(sync)) {
    return 0;
  }
  const value = (sync as Record<string, unknown>)["compactedThroughRevision"];
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : 0;
}

function withSheetSyncMetadata(metadata: JsonObject, compactedThroughRevision: number): JsonObject {
  const sync = metadata["sheetsSync"];
  const existing =
    typeof sync === "object" && sync !== null && !Array.isArray(sync) ? (sync as JsonObject) : {};
  return {
    ...metadata,
    sheetsSync: {
      ...existing,
      compactedThroughRevision,
    },
  };
}

interface SheetProtectedRange {
  readonly id?: string | undefined;
  readonly tabId: string;
  readonly label: string;
  readonly mode?: "block" | "warn";
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

interface SheetNamedRange {
  readonly id?: string;
  readonly tabId: string;
  readonly name: string;
  readonly range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  };
}

interface SheetMergedCellRange {
  readonly id?: string;
  readonly tabId: string;
  readonly label?: string;
  readonly range: SheetNamedRange["range"];
}

interface SheetChartMetadata {
  readonly id: string;
  readonly tabId: string;
  readonly type: string;
  readonly title: string;
  readonly range: SheetNamedRange["range"];
  readonly labelCol?: number;
  readonly valueCol?: number;
  readonly placement?: {
    readonly anchorRow: number;
    readonly anchorCol: number;
    readonly rowSpan: number;
    readonly colSpan: number;
  };
}

interface SheetFilterPredicateMetadata {
  readonly column: number;
  readonly operator: string;
  readonly value: string;
}

interface SheetFilterViewMetadata {
  readonly id: string;
  readonly tabId: string;
  readonly name: string;
  readonly sortDirection: string;
  readonly sortColumn?: number;
  readonly sortKeys?: readonly number[];
  readonly predicate?: SheetFilterPredicateMetadata;
  readonly predicates?: readonly SheetFilterPredicateMetadata[];
  readonly range: SheetNamedRange["range"];
}

interface SheetPivotSlicerMetadata {
  readonly column: number;
  readonly operator: string;
  readonly value: string;
}

interface SheetPivotTableMetadata {
  readonly id: string;
  readonly tabId: string;
  readonly title: string;
  readonly rowFieldCol: number;
  readonly valueFieldCol: number;
  readonly aggregation: string;
  readonly slicer?: SheetPivotSlicerMetadata;
  readonly range: SheetNamedRange["range"];
}

interface SheetFrozenPanesMetadata {
  readonly tabId: string;
  readonly frozenRows: number;
  readonly frozenCols: number;
}

interface SheetRangeCommentAnchor {
  readonly type: "sheet-range";
  readonly tabId?: string;
  readonly label?: string;
  readonly range?: SheetNamedRange["range"];
  readonly deleted?: boolean;
}

type SheetGridRange = SheetNamedRange["range"];
type SheetMetadataRangeEntry = {
  readonly tabId: string;
  readonly range: SheetGridRange;
};

interface SheetValidationContext {
  readonly namedRanges: readonly SheetNamedRange[];
  readonly values: ReadonlyMap<string, string>;
}

function assertNoProtectedRangeEdits(
  edits: readonly SheetCellEdit[],
  tab: Pick<SheetTabRecord, "id" | "sheetId">,
  sheet: Pick<SheetRecord, "metadata">,
): void {
  const protectedRanges = protectedRangesFromMetadata(sheet.metadata).filter(
    (range) => range.tabId === tab.id && protectedRangeBlocksEdits(range),
  );
  const blocked = edits.find((edit) =>
    protectedRanges.some((protectedRange) =>
      cellEditIntersectsProtectedRange(edit, protectedRange),
    ),
  );
  if (blocked === undefined) {
    return;
  }
  const range = protectedRanges.find((protectedRange) =>
    cellEditIntersectsProtectedRange(blocked, protectedRange),
  );
  throw new SheetsValidationError(
    `Cell ${cellReference(blocked.row, blocked.col)} is inside protected range ${
      range?.label ?? "Protected range"
    }.`,
  );
}

function assertNoHardValidationFailures(
  edits: readonly SheetCellEdit[],
  currentCells: readonly SheetCellRecord[],
  tab: Pick<SheetTabRecord, "id">,
  sheet: Pick<SheetRecord, "metadata">,
): void {
  const currentByCoordinate = new Map(
    currentCells.map((cell) => [cellValidationKey(cell.row, cell.col), cell] as const),
  );
  const validationContext = validationContextForSheet(currentCells, edits, tab.id, sheet.metadata);
  for (const edit of edits) {
    const existing = currentByCoordinate.get(cellValidationKey(edit.row, edit.col));
    const format =
      edit.format === undefined
        ? (existing?.format ?? {})
        : mergeSheetCellFormat(existing?.format ?? {}, edit.format);
    const validation = format["dataValidation"];
    if (
      sheetDataValidationMode(validation) === "reject" &&
      sheetValidationMessageForValue(edit.value, validation, validationContext) !== null
    ) {
      throw new SheetsValidationError(
        `Cell ${cellReference(edit.row, edit.col)} violates reject-mode data validation.`,
      );
    }
  }
}

function mergeSheetCellFormat(existing: JsonObject, patch: JsonObject): JsonObject {
  const clearedKeys = new Set(
    Object.entries(patch)
      .filter(([, value]) => value === false || value === null || value === "")
      .map(([key]) => key),
  );
  const entries = Object.entries(existing).filter(([key]) => !clearedKeys.has(key));
  for (const [key, value] of Object.entries(patch)) {
    if (!clearedKeys.has(key)) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

function cellValidationKey(row: number, col: number): string {
  return `${String(row)}:${String(col)}`;
}

function sheetDataValidationMode(value: unknown): "warn" | "reject" {
  return isPlainRecord(value) && value["mode"] === "reject" ? "reject" : "warn";
}

function sheetDataValidationKind(
  value: unknown,
): "none" | "number" | "email" | "url" | "date" | "list" | "customFormula" {
  if (!isPlainRecord(value)) {
    return "none";
  }
  const type = value["type"];
  return type === "number" ||
    type === "email" ||
    type === "url" ||
    type === "date" ||
    type === "list" ||
    type === "customFormula"
    ? type
    : "none";
}

function sheetDataValidationDateLocale(value: unknown): "iso" | "en-US" | "en-GB" | "de-DE" {
  if (!isPlainRecord(value)) {
    return "iso";
  }
  const locale = value["locale"];
  return locale === "en-US" || locale === "en-GB" || locale === "de-DE" ? locale : "iso";
}

function validationContextForSheet(
  currentCells: readonly SheetCellRecord[],
  edits: readonly SheetCellEdit[],
  tabId: string,
  metadata: JsonObject,
): SheetValidationContext {
  const values = new Map(
    currentCells.map((cell) => [cellValidationKey(cell.row, cell.col), cell.value]),
  );
  for (const edit of edits) {
    values.set(cellValidationKey(edit.row, edit.col), edit.value);
  }
  return {
    namedRanges: namedRangesFromMetadata(metadata).filter((range) => range.tabId === tabId),
    values,
  };
}

function sheetValidationMessageForValue(
  value: string,
  validation: unknown,
  context: SheetValidationContext,
): string | null {
  const kind = sheetDataValidationKind(validation);
  if (kind === "none" || value.trim().length === 0 || value.trimStart().startsWith("=")) {
    return null;
  }
  if (kind === "number" && !Number.isFinite(Number(value.replace(/,/g, "")))) {
    return "Expected a number.";
  }
  if (kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim())) {
    return "Expected an email address.";
  }
  if (kind === "url" && !isValidSheetHttpUrl(value.trim())) {
    return "Expected a URL.";
  }
  if (kind === "date") {
    const locale = sheetDataValidationDateLocale(validation);
    if (!isValidSheetDateForLocale(value.trim(), locale)) {
      return `Expected a date in ${sheetDateLocaleFormatLabel(locale)} format.`;
    }
  }
  if (kind === "list") {
    const choices = sheetDataValidationChoices(validation, context);
    if (choices.length > 0 && !choices.includes(value.trim())) {
      return "Expected a listed value.";
    }
  }
  if (
    kind === "customFormula" &&
    !sheetValidationFormulaMatches(
      sheetDataValidationFormulaText(validation) || '=VALUE<>""',
      value,
      context,
    )
  ) {
    return "Expected a value matching the validation formula.";
  }
  return null;
}

function sheetDataValidationChoices(
  value: unknown,
  context?: SheetValidationContext,
): readonly string[] {
  if (!isPlainRecord(value) || !Array.isArray(value["choices"])) {
    const namedRangeId = isPlainRecord(value) ? value["namedRangeId"] : undefined;
    return typeof namedRangeId === "string" && context !== undefined
      ? sheetDataValidationNamedRangeChoices(namedRangeId, context)
      : [];
  }
  return value["choices"]
    .filter((choice): choice is string => typeof choice === "string")
    .map((choice) => choice.trim())
    .filter((choice) => choice.length > 0);
}

function sheetDataValidationNamedRangeChoices(
  namedRangeId: string,
  context: SheetValidationContext,
): readonly string[] {
  const namedRange = context.namedRanges.find((range) => range.id === namedRangeId);
  if (namedRange === undefined) {
    return [];
  }
  const top = Math.min(namedRange.range.startRow, namedRange.range.endRow);
  const bottom = Math.max(namedRange.range.startRow, namedRange.range.endRow);
  const left = Math.min(namedRange.range.startCol, namedRange.range.endCol);
  const right = Math.max(namedRange.range.startCol, namedRange.range.endCol);
  const choices: string[] = [];
  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      const choice = context.values.get(cellValidationKey(row, col))?.trim() ?? "";
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

function sheetDataValidationFormulaText(validation: unknown): string {
  if (!isPlainRecord(validation)) {
    return "";
  }
  const formula = validation["formula"];
  return typeof formula === "string" ? formula : "";
}

function isValidSheetHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidSheetDateForLocale(
  value: string,
  locale: "iso" | "en-US" | "en-GB" | "de-DE",
): boolean {
  if (isValidSheetIsoDate(value)) {
    return true;
  }
  if (locale === "en-US") {
    return isValidSheetDateParts(sheetSeparatedDateParts(value, "/", "month-day"));
  }
  if (locale === "en-GB") {
    return isValidSheetDateParts(sheetSeparatedDateParts(value, "/", "day-month"));
  }
  if (locale === "de-DE") {
    return isValidSheetDateParts(sheetSeparatedDateParts(value, ".", "day-month"));
  }
  return false;
}

function isValidSheetIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return false;
  }
  return isValidSheetDateParts({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  });
}

interface SheetDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Splits `d<sep>d<sep>yyyy`, reading the two leading fields in `order`. */
function sheetSeparatedDateParts(
  value: string,
  separator: "/" | ".",
  order: "month-day" | "day-month",
): SheetDateParts | null {
  const escapedSeparator = separator === "." ? "\\." : separator;
  const match = new RegExp(
    `^(\\d{1,2})${escapedSeparator}(\\d{1,2})${escapedSeparator}(\\d{4})$`,
    "u",
  ).exec(value);
  if (match === null) {
    return null;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  return {
    month: order === "month-day" ? first : second,
    day: order === "month-day" ? second : first,
    year: Number(match[3]),
  };
}

function isValidSheetDateParts(parts: SheetDateParts | null): boolean {
  if (parts === null) {
    return false;
  }
  const { year, month, day } = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function sheetDateLocaleFormatLabel(locale: "iso" | "en-US" | "en-GB" | "de-DE"): string {
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

function sheetValidationFormulaMatches(
  formula: string,
  value: string,
  context: SheetValidationContext,
): boolean {
  const expression = formula.trim().replace(/^=/u, "").trim();
  if (expression.length === 0) {
    return false;
  }
  const comparison = expression.match(/^(.+?)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/u);
  if (comparison === null) {
    return sheetFormulaTermTruthy(sheetValidationFormulaTermValue(expression, value, context));
  }
  const left = sheetValidationFormulaTermValue(comparison[1]?.trim() ?? "", value, context);
  const operator = comparison[2] ?? "";
  const right = sheetValidationFormulaTermValue(comparison[3]?.trim() ?? "", value, context);
  return compareSheetFormulaTerms(left, operator, right);
}

function sheetValidationFormulaTermValue(
  term: string,
  value: string,
  context: SheetValidationContext,
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
    if (referencedCol !== null && Number.isInteger(referencedRow) && referencedRow >= 0) {
      return context.values.get(cellValidationKey(referencedRow, referencedCol))?.trim() ?? "";
    }
  }
  return normalized;
}

function sheetFormulaTermTruthy(value: string | number | boolean): boolean {
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

function compareSheetFormulaTerms(
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is a grid range object with integer corner coordinates. */
function isSheetGridRange(value: unknown): value is SheetGridRange {
  return (
    isPlainRecord(value) &&
    Number.isInteger(value["startRow"]) &&
    Number.isInteger(value["startCol"]) &&
    Number.isInteger(value["endRow"]) &&
    Number.isInteger(value["endCol"])
  );
}

function protectedRangesFromMetadata(metadata: JsonObject): readonly SheetProtectedRange[] {
  const ranges = metadata["protectedRanges"];
  if (!Array.isArray(ranges)) {
    return [];
  }
  return ranges.filter(isSheetProtectedRange);
}

function protectedRangeAuditDelta(
  beforeMetadata: JsonObject,
  afterMetadata: JsonObject,
): JsonObject | null {
  const before = protectedRangesFromMetadata(beforeMetadata).map(protectedRangeAuditEntry);
  const after = protectedRangesFromMetadata(afterMetadata).map(protectedRangeAuditEntry);
  const beforeByKey = new Map(before.map((range) => [protectedRangeAuditKey(range), range]));
  const afterByKey = new Map(after.map((range) => [protectedRangeAuditKey(range), range]));
  const added = after.filter((range) => !beforeByKey.has(protectedRangeAuditKey(range)));
  const removed = before.filter((range) => !afterByKey.has(protectedRangeAuditKey(range)));
  const changed = after.flatMap((range): JsonObject[] => {
    const beforeRange = beforeByKey.get(protectedRangeAuditKey(range));
    if (beforeRange === undefined || protectedRangeAuditEqual(beforeRange, range)) {
      return [];
    }
    return [{ before: beforeRange, after: range }];
  });
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }
  return { added, removed, changed };
}

function protectedRangeAuditEntry(range: SheetProtectedRange): JsonObject {
  return {
    ...(range.id === undefined ? {} : { id: range.id }),
    tabId: range.tabId,
    label: range.label,
    mode: range.mode ?? "block",
    range: {
      startRow: range.range.startRow,
      startCol: range.range.startCol,
      endRow: range.range.endRow,
      endCol: range.range.endCol,
    },
  };
}

function protectedRangeAuditKey(range: JsonObject): string {
  const id = range["id"];
  if (typeof id === "string" && id.length > 0) {
    return `id:${id}`;
  }
  const rangeValue = range["range"];
  if (typeof rangeValue !== "object" || rangeValue === null || Array.isArray(rangeValue)) {
    return JSON.stringify(range);
  }
  const gridRange = rangeValue as Record<string, unknown>;
  return [
    "range",
    range["tabId"],
    range["label"],
    gridRange["startRow"],
    gridRange["startCol"],
    gridRange["endRow"],
    gridRange["endCol"],
  ].join(":");
}

function protectedRangeAuditEqual(before: JsonObject, after: JsonObject): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function namedFormulaRangesFromMetadata(metadata: JsonObject): readonly SheetFormulaNamedRange[] {
  return namedRangesFromMetadata(metadata).map(({ name, tabId, range }) => ({
    name,
    tabId,
    range,
  }));
}

function namedRangesFromMetadata(metadata: JsonObject): readonly SheetNamedRange[] {
  const ranges = metadata["namedRanges"];
  if (!Array.isArray(ranges)) {
    return [];
  }
  return ranges.filter(isSheetNamedRange);
}

function isSheetNamedRange(value: unknown): value is SheetNamedRange {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    (value["id"] === undefined || typeof value["id"] === "string") &&
    typeof value["tabId"] === "string" &&
    typeof value["name"] === "string" &&
    isSheetGridRange(value["range"])
  );
}

function isSheetMergedCellRange(value: unknown): value is SheetMergedCellRange {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    (value["id"] === undefined || typeof value["id"] === "string") &&
    typeof value["tabId"] === "string" &&
    (value["label"] === undefined || typeof value["label"] === "string") &&
    isSheetGridRange(value["range"])
  );
}

function isSheetProtectedRange(value: unknown): value is SheetProtectedRange {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    (value["id"] === undefined || typeof value["id"] === "string") &&
    typeof value["tabId"] === "string" &&
    typeof value["label"] === "string" &&
    (value["mode"] === undefined || isSheetProtectedRangeMode(value["mode"])) &&
    isSheetGridRange(value["range"])
  );
}

function isSheetChartMetadata(value: unknown): value is SheetChartMetadata {
  if (!isPlainRecord(value)) {
    return false;
  }
  const placement = value["placement"];
  return (
    typeof value["id"] === "string" &&
    typeof value["tabId"] === "string" &&
    typeof value["type"] === "string" &&
    typeof value["title"] === "string" &&
    isSheetGridRange(value["range"]) &&
    isOptionalNonnegativeInteger(value["labelCol"]) &&
    isOptionalNonnegativeInteger(value["valueCol"]) &&
    (placement === undefined || isSheetChartPlacementMetadata(placement))
  );
}

function isSheetChartPlacementMetadata(
  value: unknown,
): value is NonNullable<SheetChartMetadata["placement"]> {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    Number.isInteger(value["anchorRow"]) &&
    Number.isInteger(value["anchorCol"]) &&
    Number.isInteger(value["rowSpan"]) &&
    Number.isInteger(value["colSpan"])
  );
}

function isOptionalNonnegativeInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (Number.isInteger(value) && typeof value === "number" && value >= 0)
  );
}

function isSheetFilterViewMetadata(value: unknown): value is SheetFilterViewMetadata {
  if (!isPlainRecord(value)) {
    return false;
  }
  const sortColumn = value["sortColumn"];
  const sortKeys = value["sortKeys"];
  const predicate = value["predicate"];
  const predicates = value["predicates"];
  return (
    typeof value["id"] === "string" &&
    typeof value["tabId"] === "string" &&
    typeof value["name"] === "string" &&
    typeof value["sortDirection"] === "string" &&
    (sortColumn === undefined || Number.isInteger(sortColumn)) &&
    (sortKeys === undefined ||
      (Array.isArray(sortKeys) && sortKeys.every((key) => Number.isInteger(key)))) &&
    (predicate === undefined || isSheetFilterPredicateMetadata(predicate)) &&
    (predicates === undefined ||
      (Array.isArray(predicates) && predicates.every(isSheetFilterPredicateMetadata))) &&
    isSheetGridRange(value["range"])
  );
}

function isSheetFilterPredicateMetadata(value: unknown): value is SheetFilterPredicateMetadata {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    Number.isInteger(value["column"]) &&
    typeof value["operator"] === "string" &&
    typeof value["value"] === "string"
  );
}

function isSheetPivotTableMetadata(value: unknown): value is SheetPivotTableMetadata {
  if (!isPlainRecord(value)) {
    return false;
  }
  const slicer = value["slicer"];
  return (
    typeof value["id"] === "string" &&
    typeof value["tabId"] === "string" &&
    typeof value["title"] === "string" &&
    Number.isInteger(value["rowFieldCol"]) &&
    Number.isInteger(value["valueFieldCol"]) &&
    typeof value["aggregation"] === "string" &&
    (slicer === undefined || isSheetPivotSlicerMetadata(slicer)) &&
    isSheetGridRange(value["range"])
  );
}

function isSheetPivotSlicerMetadata(value: unknown): value is SheetPivotSlicerMetadata {
  // Slicers carry the same column/operator/value shape as filter predicates.
  return isSheetFilterPredicateMetadata(value);
}

function isSheetFrozenPanesMetadata(value: unknown): value is SheetFrozenPanesMetadata {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    typeof value["tabId"] === "string" &&
    Number.isInteger(value["frozenRows"]) &&
    Number.isInteger(value["frozenCols"]) &&
    (value["frozenRows"] as number) >= 0 &&
    (value["frozenCols"] as number) >= 0
  );
}

function isSheetRangeCommentAnchor(value: unknown): value is SheetRangeCommentAnchor {
  if (!isPlainRecord(value)) {
    return false;
  }
  const range = value["range"];
  return (
    value["type"] === "sheet-range" &&
    (value["tabId"] === undefined || typeof value["tabId"] === "string") &&
    (value["label"] === undefined || typeof value["label"] === "string") &&
    (value["deleted"] === undefined || typeof value["deleted"] === "boolean") &&
    (range === undefined || isSheetGridRange(range))
  );
}

function isSheetProtectedRangeMode(value: unknown): value is "block" | "warn" {
  return value === "block" || value === "warn";
}

function protectedRangeBlocksEdits(range: SheetProtectedRange): boolean {
  return range.mode !== "warn";
}

function cellEditIntersectsProtectedRange(
  edit: SheetCellEdit,
  protectedRange: SheetProtectedRange,
): boolean {
  const range = protectedRange.range;
  const top = Math.min(range.startRow, range.endRow);
  const bottom = Math.max(range.startRow, range.endRow);
  const left = Math.min(range.startCol, range.endCol);
  const right = Math.max(range.startCol, range.endCol);
  return edit.row >= top && edit.row <= bottom && edit.col >= left && edit.col <= right;
}

// ---------------------------------------------------------------------------
// In-memory store (tests / offline).
// ---------------------------------------------------------------------------

/**
 * An in-memory {@link SheetsStore}. Mirrors the Postgres store's visibility and
 * validation semantics so tool tests can run without a database.
 */
export class InMemorySheetsStore implements SheetsStore {
  readonly #sheets = new Map<string, SheetRecord>();
  readonly #tabs = new Map<string, SheetTabRecord>();
  readonly #cells = new Map<string, SheetCellRecord>();
  readonly #comments = new Map<string, SheetCommentRecord>();
  readonly #operations = new Map<string, SheetOperationLogRecord[]>();
  readonly #compactedRevisions = new Map<string, number>();

  async createSheet(input: CreateSheetInput): Promise<SheetWithTabs> {
    const title = assertTitle(input.title);
    const now = new Date();
    const sheet: SheetRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      title,
      metadata: {
        ...(input.metadata ?? {}),
        app: "sheets",
        folderId: input.folderId ?? null,
      },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#sheets.set(sheet.id, sheet);
    const tabNames =
      input.tabNames !== undefined && input.tabNames.length > 0
        ? input.tabNames
        : [DEFAULT_TAB_NAME];
    const tabs: SheetTabRecord[] = [];
    tabNames.forEach((name, index) => {
      tabs.push(this.#insertTab(sheet, assertTabName(name), index, now));
    });
    return { ...sheet, tabs };
  }

  async copySheet(input: CopySheetInput): Promise<SheetWithTabs | null> {
    const source = this.#requireVisible(input);
    if (source === null) {
      return null;
    }
    const now = new Date();
    const title = assertTitle(input.title ?? `${source.title} (Copy)`);
    const sourceTabs = this.#tabsForSheet(source.id);
    const tabIdMap = new Map<string, string>();
    const sheet: SheetRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      title,
      metadata: {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#sheets.set(sheet.id, sheet);
    const copiedTabs: SheetTabRecord[] = [];
    for (const tab of sourceTabs) {
      const nextTab: SheetTabRecord = {
        ...tab,
        id: randomUUID(),
        sheetId: sheet.id,
        createdAt: now,
        updatedAt: now,
      };
      tabIdMap.set(tab.id, nextTab.id);
      this.#tabs.set(nextTab.id, nextTab);
      copiedTabs.push(nextTab);
    }
    for (const cell of [...this.#cells.values()]) {
      const nextTabId = tabIdMap.get(cell.sheetTabId);
      if (nextTabId === undefined) {
        continue;
      }
      const nextCell: SheetCellRecord = {
        ...cell,
        id: randomUUID(),
        sheetTabId: nextTabId,
        createdAt: now,
        updatedAt: now,
      };
      this.#cells.set(cellKey(nextCell.sheetTabId, nextCell.row, nextCell.col), nextCell);
    }
    const metadata = {
      ...replaceStringsInJsonObject(source.metadata, (value) => tabIdMap.get(value) ?? value),
      createdFrom: "sheets.copy",
      copiedFromSheetId: source.id,
      ...(input.metadata ?? {}),
      app: "sheets",
      folderId: input.folderId ?? jsonStringOrNull(source.metadata.folderId),
    };
    const copiedSheet = { ...sheet, metadata };
    this.#sheets.set(copiedSheet.id, copiedSheet);
    return { ...copiedSheet, tabs: copiedTabs };
  }

  async listSheets(input: ListSheetsInput): Promise<SheetsPage> {
    const query = input.query?.trim().toLowerCase();
    const visible = [...this.#sheets.values()]
      .filter(
        (sheet) =>
          sheet.orgId === input.orgId &&
          sheet.deletedAt === null &&
          this.#canAccess(sheet, input.actorId) &&
          (query === undefined || query.length === 0 || sheet.title.toLowerCase().includes(query)),
      )
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    return {
      sheets: visible.slice(input.offset, input.offset + input.limit),
      total: visible.length,
      limit: input.limit,
      offset: input.offset,
    };
  }

  async getSheet(input: SheetRef): Promise<SheetWithTabs | null> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return null;
    }
    return { ...sheet, tabs: this.#tabsForSheet(sheet.id) };
  }

  async updateSheet(input: UpdateSheetInput): Promise<SheetWithTabs | null> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return null;
    }
    const updated: SheetRecord = {
      ...sheet,
      ...(input.title === undefined ? {} : { title: assertTitle(input.title) }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      updatedAt: new Date(),
    };
    this.#sheets.set(updated.id, updated);
    return { ...updated, tabs: this.#tabsForSheet(updated.id) };
  }

  async deleteSheet(input: SheetRef): Promise<SheetRecord | null> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return null;
    }
    const deleted: SheetRecord = { ...sheet, deletedAt: new Date(), updatedAt: new Date() };
    this.#sheets.set(deleted.id, deleted);
    return deleted;
  }

  async createTab(input: CreateTabInput): Promise<SheetTabRecord> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${input.sheetId}`);
    }
    const existing = this.#tabsForSheet(sheet.id);
    const position = input.position ?? existing.length;
    return this.#insertTab(sheet, assertTabName(input.name), position, new Date(), input.metadata);
  }

  async updateTab(input: UpdateTabInput): Promise<SheetTabRecord | null> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      return null;
    }
    const updated: SheetTabRecord = {
      ...tab,
      ...(input.name === undefined ? {} : { name: assertTabName(input.name) }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      updatedAt: new Date(),
    };
    this.#tabs.set(updated.id, updated);
    this.#touchSheet(updated.sheetId);
    return updated;
  }

  async deleteTab(input: TabRef): Promise<SheetTabRecord | null> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      return null;
    }
    const remaining = this.#tabsForSheet(tab.sheetId).filter(
      (candidate) => candidate.id !== tab.id,
    );
    if (remaining.length === 0) {
      throw new SheetsValidationError("A spreadsheet must keep at least one tab.");
    }
    const deleted: SheetTabRecord = { ...tab, deletedAt: new Date(), updatedAt: new Date() };
    this.#tabs.set(deleted.id, deleted);
    for (const cell of [...this.#cells.values()]) {
      if (cell.sheetTabId === tab.id) {
        this.#cells.delete(cellKey(cell.sheetTabId, cell.row, cell.col));
      }
    }
    this.#touchSheet(tab.sheetId);
    return deleted;
  }

  async getTabCells(input: GetTabCellsInput): Promise<SheetTabWithCells | null> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      return null;
    }
    return { ...tab, cells: filterCellsInWindow(this.#cellsForTab(tab.id), input.window) };
  }

  async updateCells(input: UpdateCellsInput): Promise<SheetTabWithCells> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
    }
    const sheet = this.#sheets.get(tab.sheetId);
    if (sheet === undefined) {
      throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${tab.sheetId}`);
    }
    const now = new Date();
    for (const edit of input.edits) {
      assertCellEdit(edit);
    }
    assertNoProtectedRangeEdits(input.edits, tab, sheet);
    assertNoHardValidationFailures(input.edits, this.#cellsForTab(tab.id), tab, sheet);
    for (const edit of input.edits) {
      const key = cellKey(tab.id, edit.row, edit.col);
      if (isClearingEdit(edit)) {
        this.#cells.delete(key);
        continue;
      }
      const existing = this.#cells.get(key);
      this.#cells.set(key, {
        id: existing?.id ?? randomUUID(),
        orgId: tab.orgId,
        sheetTabId: tab.id,
        row: edit.row,
        col: edit.col,
        value: edit.value,
        formula: existing?.formula ?? null,
        calcValue: existing?.calcValue ?? edit.value,
        dependencies: existing?.dependencies ?? [],
        formulaError: existing?.formulaError ?? null,
        format: edit.format ?? existing?.format ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    this.#refreshFormulaMetadata(tab.id);
    this.#touchSheet(tab.sheetId);
    return { ...tab, cells: filterCellsInWindow(this.#cellsForTab(tab.id), input.window) };
  }

  async sortRange(input: SortRangeInput): Promise<SheetTabWithCells> {
    const tab = this.#requireTab(input);
    if (tab === null) {
      throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
    }
    const sheet = this.#sheets.get(tab.sheetId);
    if (sheet === undefined) {
      throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${tab.sheetId}`);
    }
    const range = normalizeSheetRange(input.range);
    if (range.top === range.bottom) {
      return { ...tab, cells: filterCellsInWindow(this.#cellsForTab(tab.id), input.window) };
    }
    const cells = this.#cellsForTab(tab.id);
    const edits = sortSheetRangeEdits(cells, range, input.direction);
    assertNoProtectedRangeEdits(edits, tab, sheet);
    assertNoHardValidationFailures(edits, cells, tab, sheet);
    return this.updateCells({ ...input, edits });
  }

  async createComment(input: CreateSheetCommentInput): Promise<SheetCommentRecord> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${input.sheetId}`);
    }
    if (input.parentCommentId !== undefined) {
      const parent = this.#comments.get(input.parentCommentId);
      if (
        parent === undefined ||
        parent.orgId !== input.orgId ||
        parent.sheetId !== input.sheetId
      ) {
        throw new SheetsValidationError("Comment parent must belong to the same spreadsheet.");
      }
    }
    const anchor = validatedSheetCommentAnchor(input.anchor, sheet, this.#tabsForSheet(sheet.id));
    const now = new Date();
    const comment: SheetCommentRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      sheetId: sheet.id,
      parentCommentId: input.parentCommentId ?? null,
      actorId: input.actorId,
      anchor,
      body: input.body,
      status: "open",
      metadata: input.metadata ?? {},
      resolvedAt: null,
      createdAt: now,
      updatedAt: null,
    };
    this.#comments.set(comment.id, comment);
    return comment;
  }

  async listComments(input: ListSheetCommentsInput): Promise<readonly SheetCommentListItem[]> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return [];
    }
    return [...this.#comments.values()]
      .filter(
        (comment) =>
          comment.orgId === input.orgId &&
          comment.sheetId === sheet.id &&
          (input.status === undefined || input.status === "all" || comment.status === input.status),
      )
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((comment) => ({
        ...comment,
        ...(comment.actorId === null ? {} : { author: { id: comment.actorId } }),
      }));
  }

  async resolveComment(input: ResolveSheetCommentInput): Promise<SheetCommentRecord | null> {
    const existing = this.#requireVisibleComment(input);
    if (existing === null) {
      return null;
    }
    if (existing.status === "resolved") {
      return existing;
    }
    const resolved: SheetCommentRecord = {
      ...existing,
      status: "resolved",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    };
    this.#comments.set(resolved.id, resolved);
    return resolved;
  }

  async reopenComment(input: ResolveSheetCommentInput): Promise<SheetCommentRecord | null> {
    const existing = this.#requireVisibleComment(input);
    if (existing === null) {
      return null;
    }
    if (existing.status === "open") {
      return existing;
    }
    const reopened: SheetCommentRecord = {
      ...existing,
      status: "open",
      resolvedAt: null,
      updatedAt: new Date(),
    };
    this.#comments.set(reopened.id, reopened);
    return reopened;
  }

  async updateComment(input: UpdateSheetCommentInput): Promise<SheetCommentRecord | null> {
    const existing = this.#requireVisibleComment(input);
    if (existing === null) {
      return null;
    }
    const updated: SheetCommentRecord = {
      ...existing,
      body: input.body,
      updatedAt: new Date(),
    };
    this.#comments.set(updated.id, updated);
    return updated;
  }

  async deleteComment(input: DeleteSheetCommentInput): Promise<SheetCommentRecord | null> {
    const existing = this.#requireVisibleComment(input);
    if (existing === null) {
      return null;
    }
    this.#comments.delete(existing.id);
    for (const comment of [...this.#comments.values()]) {
      if (comment.parentCommentId === existing.id) {
        this.#comments.delete(comment.id);
      }
    }
    return existing;
  }

  async listOperations(
    input: SheetRef & { readonly afterRevision?: number | undefined },
  ): Promise<readonly SheetOperationLogRecord[]> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return [];
    }
    return [...(this.#operations.get(sheet.id) ?? [])]
      .sort((left, right) => left.revision - right.revision)
      .filter((operation) => operation.revision > (input.afterRevision ?? 0));
  }

  async appendOperation(input: AppendSheetOperationInput): Promise<SheetOperationLogRecord> {
    const tab = this.#requireTab(input);
    if (tab === null || tab.sheetId !== input.sheetId) {
      throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
    }
    const operations = this.#operations.get(input.sheetId) ?? [];
    const existing = operations.find((operation) => operation.operationId === input.operationId);
    if (existing !== undefined) {
      return existing;
    }
    const latestRevision = latestSheetOperationRevision(
      operations,
      this.#compactedRevisions.get(input.sheetId) ?? 0,
    );
    const operation: SheetOperationLogRecord = {
      orgId: input.orgId,
      sheetId: input.sheetId,
      tabId: input.tabId,
      actorId: input.actorId,
      operationId: input.operationId,
      revision: latestRevision + 1,
      baseRevision: input.baseRevision,
      operation: input.operation,
      createdAt: new Date(),
    };
    this.#operations.set(input.sheetId, [...operations, operation]);
    return operation;
  }

  async applyOperation(input: ApplySheetOperationInput): Promise<ApplySheetOperationResult> {
    const tab = this.#requireTab(input);
    if (tab === null || tab.sheetId !== input.sheetId) {
      throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
    }
    const operations = this.#operations.get(input.sheetId) ?? [];
    const existing = operations.find((operation) => operation.operationId === input.operation.id);
    if (existing !== undefined) {
      return {
        status: "duplicate",
        operationId: input.operation.id,
        revision: existing.revision,
      };
    }
    const compactedThroughRevision = this.#compactedRevisions.get(input.sheetId) ?? 0;
    const latestRevision = latestSheetOperationRevision(operations, compactedThroughRevision);
    if (input.operation.baseRevision < compactedThroughRevision) {
      return {
        status: "compacted",
        operationId: input.operation.id,
        revision: latestRevision,
        compactedThroughRevision,
      };
    }
    if (input.operation.baseRevision > latestRevision) {
      return { status: "ahead", operationId: input.operation.id, revision: latestRevision };
    }
    const committedSameTab = operations
      .filter((operation) => operation.revision > input.operation.baseRevision)
      .filter((operation) => operation.tabId === input.tabId);
    const transformed = transformSheetOperation(
      input.operation,
      committedSameTab.map((operation) => operation.operation),
      latestRevision,
    );
    if (transformed === null) {
      return { status: "dropped", operationId: input.operation.id, revision: latestRevision };
    }
    const updatedTab = this.#applySheetOperation(tab, transformed);
    const record = await this.appendOperation({
      orgId: input.orgId,
      actorId: input.actorId,
      sheetId: input.sheetId,
      tabId: input.tabId,
      operationId: transformed.id,
      baseRevision: transformed.baseRevision,
      operation: transformed,
    });
    return {
      status: "applied",
      revision: record.revision,
      operation: transformed,
      tab: updatedTab,
    };
  }

  async compactOperations(
    input: CompactSheetOperationsInput,
  ): Promise<CompactSheetOperationsResult> {
    const sheet = this.#requireVisible(input);
    if (sheet === null) {
      return { latestRevision: 0, compactedThroughRevision: 0, deletedCount: 0 };
    }
    const retainRevisions = assertRetainedOperationRevisions(input.retainRevisions);
    const operations = this.#operations.get(sheet.id) ?? [];
    const previousCompactedRevision = this.#compactedRevisions.get(sheet.id) ?? 0;
    const latestRevision = latestSheetOperationRevision(operations, previousCompactedRevision);
    const compactedThroughRevision = Math.max(
      previousCompactedRevision,
      Math.max(0, latestRevision - retainRevisions),
    );
    if (compactedThroughRevision <= previousCompactedRevision) {
      return {
        latestRevision,
        compactedThroughRevision: previousCompactedRevision,
        deletedCount: 0,
      };
    }
    const retained = operations.filter(
      (operation) => operation.revision > compactedThroughRevision,
    );
    this.#operations.set(sheet.id, retained);
    this.#compactedRevisions.set(sheet.id, compactedThroughRevision);
    this.#sheets.set(sheet.id, {
      ...sheet,
      metadata: withSheetSyncMetadata(sheet.metadata, compactedThroughRevision),
      updatedAt: new Date(),
    });
    return {
      latestRevision,
      compactedThroughRevision,
      deletedCount: operations.length - retained.length,
    };
  }

  async listVersions(_input: ListSheetVersionsInput): Promise<readonly SheetVersionRecord[]> {
    return [];
  }

  async restoreVersion(_input: RestoreSheetVersionInput): Promise<SheetWithTabs | null> {
    return null;
  }

  #applySheetOperation(tab: SheetTabRecord, operation: SheetOperation): SheetTabWithCells {
    const sheet = this.#sheets.get(tab.sheetId);
    if (sheet === undefined) {
      throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${tab.sheetId}`);
    }
    assertNoProtectedRangeEdits(cellEditsFromSheetOperation(operation), tab, sheet);
    const existingCells = this.#cellsForTab(tab.id);
    const now = new Date();
    const metadataRebase = rebaseSheetMetadataRangesForOperation(sheet.metadata, tab.id, operation);
    if (metadataRebase.changed) {
      this.#sheets.set(sheet.id, {
        ...sheet,
        metadata: metadataRebase.metadata,
        updatedAt: now,
      });
    }
    this.#rebaseCommentAnchorsForOperation(sheet.id, tab.id, operation, now);
    for (const cell of [...this.#cells.values()]) {
      if (cell.sheetTabId === tab.id) {
        this.#cells.delete(cellKey(cell.sheetTabId, cell.row, cell.col));
      }
    }
    for (const cell of applySheetOperationToCells({
      orgId: tab.orgId,
      tabId: tab.id,
      cells: existingCells,
      operation,
      now,
      createId: randomUUID,
    })) {
      this.#cells.set(cellKey(tab.id, cell.row, cell.col), cell);
    }
    this.#refreshFormulaMetadata(tab.id);
    this.#touchSheet(tab.sheetId);
    return { ...tab, cells: this.#cellsForTab(tab.id) };
  }

  #rebaseCommentAnchorsForOperation(
    sheetId: string,
    tabId: string,
    operation: SheetOperation,
    now: Date,
  ): void {
    for (const comment of [...this.#comments.values()]) {
      if (comment.sheetId !== sheetId) {
        continue;
      }
      const rebased = rebaseSheetCommentAnchorForOperation(comment.anchor, tabId, operation);
      if (!rebased.changed) {
        continue;
      }
      this.#comments.set(comment.id, {
        ...comment,
        anchor: rebased.anchor,
        updatedAt: now,
      });
    }
  }

  #refreshFormulaMetadata(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    const sheet = tab === undefined ? undefined : this.#sheets.get(tab.sheetId);
    if (tab === undefined || sheet === undefined) {
      return;
    }
    const tabs = [...this.#tabs.values()]
      .filter((candidate) => candidate.sheetId === sheet.id && candidate.deletedAt === null)
      .sort(
        (left, right) =>
          left.position - right.position || left.createdAt.getTime() - right.createdAt.getTime(),
      );
    const tabIds = new Set(tabs.map((candidate) => candidate.id));
    const cells = [...this.#cells.values()].filter((cell) => tabIds.has(cell.sheetTabId));
    const evaluations = evaluateSheetFormulas(cells, {
      currentTabId: tab.id,
      tabs,
      namedRanges: namedFormulaRangesFromMetadata(sheet.metadata),
    });
    for (const cell of cells) {
      const evaluation = evaluations.get(formulaCellKey(cell.sheetTabId, cell.row, cell.col));
      this.#cells.set(cellKey(cell.sheetTabId, cell.row, cell.col), {
        ...cell,
        formula: evaluation?.formula ?? null,
        calcValue: evaluation?.calcValue ?? cell.value,
        dependencies: evaluation?.dependencies ?? [],
        formulaError: evaluation?.error ?? null,
      });
    }
  }

  #insertTab(
    sheet: SheetRecord,
    name: string,
    position: number,
    now: Date,
    metadata?: JsonObject,
  ): SheetTabRecord {
    const tab: SheetTabRecord = {
      id: randomUUID(),
      orgId: sheet.orgId,
      sheetId: sheet.id,
      name,
      position,
      metadata: metadata ?? {},
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#tabs.set(tab.id, tab);
    this.#touchSheet(sheet.id);
    return tab;
  }

  #tabsForSheet(sheetId: string): SheetTabRecord[] {
    return [...this.#tabs.values()]
      .filter((tab) => tab.sheetId === sheetId && tab.deletedAt === null)
      .sort(
        (left, right) =>
          left.position - right.position || left.createdAt.getTime() - right.createdAt.getTime(),
      );
  }

  #cellsForTab(tabId: string): SheetCellRecord[] {
    return [...this.#cells.values()]
      .filter((cell) => cell.sheetTabId === tabId)
      .sort((left, right) => left.row - right.row || left.col - right.col);
  }

  #canAccess(sheet: SheetRecord, actorId: string): boolean {
    return sheet.ownerActorId === actorId || sheet.createdByActorId === actorId;
  }

  #requireVisible(input: SheetRef | UpdateSheetInput): SheetRecord | null {
    const sheet = this.#sheets.get(input.sheetId);
    if (
      sheet === undefined ||
      sheet.orgId !== input.orgId ||
      sheet.deletedAt !== null ||
      !this.#canAccess(sheet, input.actorId)
    ) {
      return null;
    }
    return sheet;
  }

  /** A comment is reachable only when its spreadsheet is visible to the actor. */
  #requireVisibleComment(input: ResolveSheetCommentInput): SheetCommentRecord | null {
    const comment = this.#comments.get(input.commentId);
    if (comment === undefined || comment.orgId !== input.orgId) {
      return null;
    }
    const sheet = this.#requireVisible({
      orgId: input.orgId,
      actorId: input.actorId,
      sheetId: comment.sheetId,
    });
    return sheet === null ? null : comment;
  }

  #requireTab(input: { orgId: string; actorId: string; tabId: string }): SheetTabRecord | null {
    const tab = this.#tabs.get(input.tabId);
    if (tab === undefined || tab.orgId !== input.orgId || tab.deletedAt !== null) {
      return null;
    }
    const sheet = this.#requireVisible({
      orgId: input.orgId,
      actorId: input.actorId,
      sheetId: tab.sheetId,
    });
    return sheet === null ? null : tab;
  }

  #touchSheet(sheetId: string): void {
    const sheet = this.#sheets.get(sheetId);
    if (sheet !== undefined) {
      this.#sheets.set(sheetId, { ...sheet, updatedAt: new Date() });
    }
  }
}

function cellKey(tabId: string, row: number, col: number): string {
  return `${tabId}:${String(row)}:${String(col)}`;
}

function cellEditsFromSheetOperation(operation: SheetOperation): readonly SheetCellEdit[] {
  return operation.changes.flatMap((change) => {
    if (change.kind === "set-cell") {
      return [{ row: change.row, col: change.col, value: change.value }];
    }
    if (change.kind === "clear-cell") {
      return [{ row: change.row, col: change.col, value: "" }];
    }
    return [];
  });
}

function transformSheetOperation(
  operation: SheetOperation,
  committed: readonly SheetOperation[],
  acceptedBaseRevision = operation.baseRevision + committed.length,
): SheetOperation | null {
  let changes = [...operation.changes];
  for (const committedOperation of committed) {
    for (const committedChange of committedOperation.changes) {
      changes = changes.flatMap((change) =>
        transformSheetCellOperation(change, operation.id, committedChange, committedOperation.id),
      );
    }
    if (changes.length === 0) {
      return null;
    }
  }
  return {
    ...operation,
    baseRevision: acceptedBaseRevision,
    changes,
  };
}

function transformSheetCellOperation(
  change: SheetCellOperation,
  operationId: string,
  committed: SheetCellOperation,
  committedId: string,
): readonly SheetCellOperation[] {
  if (isSheetCellWrite(change)) {
    return transformSheetCellWrite(change, operationId, committed, committedId);
  }
  if (change.kind === "insert-rows") {
    return transformSheetInsertAxis(change, operationId, committed, committedId, "row");
  }
  if (change.kind === "insert-columns") {
    return transformSheetInsertAxis(change, operationId, committed, committedId, "column");
  }
  if (change.kind === "delete-rows") {
    return transformSheetDeleteAxis(change, committed, "row");
  }
  return transformSheetDeleteAxis(change, committed, "column");
}

function transformSheetCellWrite(
  change: Extract<SheetCellOperation, { readonly kind: "set-cell" | "clear-cell" }>,
  operationId: string,
  committed: SheetCellOperation,
  committedId: string,
): readonly SheetCellOperation[] {
  if (
    isSheetCellWrite(committed) &&
    change.row === committed.row &&
    change.col === committed.col &&
    operationId < committedId
  ) {
    return [];
  }
  const row = transformSheetPoint(change.row, committed, "row");
  const col = transformSheetPoint(change.col, committed, "column");
  if (row === null || col === null) {
    return [];
  }
  return [{ ...change, row, col }];
}

function transformSheetInsertAxis(
  change: Extract<SheetCellOperation, { readonly kind: "insert-rows" | "insert-columns" }>,
  operationId: string,
  committed: SheetCellOperation,
  committedId: string,
  axis: "row" | "column",
): readonly SheetCellOperation[] {
  if (!sheetOperationAffectsAxis(committed, axis)) {
    return [change];
  }
  if (isSheetInsertForAxis(committed, axis)) {
    const shouldMoveAfterCommitted =
      change.index > committed.index ||
      (change.index === committed.index && operationId > committedId);
    return [
      {
        ...change,
        index: shouldMoveAfterCommitted ? change.index + committed.count : change.index,
      },
    ];
  }
  if (isSheetDeleteForAxis(committed, axis)) {
    return [
      {
        ...change,
        index: transformSheetInsertionIndexAgainstDelete(change.index, committed),
      },
    ];
  }
  return [change];
}

function transformSheetDeleteAxis(
  change: Extract<SheetCellOperation, { readonly kind: "delete-rows" | "delete-columns" }>,
  committed: SheetCellOperation,
  axis: "row" | "column",
): readonly SheetCellOperation[] {
  if (!sheetOperationAffectsAxis(committed, axis)) {
    return [change];
  }
  if (isSheetInsertForAxis(committed, axis)) {
    return [
      {
        ...change,
        index: change.index >= committed.index ? change.index + committed.count : change.index,
      },
    ];
  }
  if (isSheetDeleteForAxis(committed, axis)) {
    const transformed = transformSheetDeletionAgainstDeletion(
      change.index,
      change.count,
      committed,
    );
    return transformed === null ? [] : [{ ...change, ...transformed }];
  }
  return [change];
}

function transformSheetPoint(
  point: number,
  committed: SheetCellOperation,
  axis: "row" | "column",
): number | null {
  if (!sheetOperationAffectsAxis(committed, axis)) {
    return point;
  }
  if (isSheetInsertForAxis(committed, axis)) {
    return point >= committed.index ? point + committed.count : point;
  }
  if (isSheetDeleteForAxis(committed, axis)) {
    const deleteEnd = committed.index + committed.count;
    if (point >= committed.index && point < deleteEnd) {
      return null;
    }
    return point >= deleteEnd ? point - committed.count : point;
  }
  return point;
}

function transformSheetInsertionIndexAgainstDelete(
  index: number,
  committed: Extract<SheetCellOperation, { readonly kind: "delete-rows" | "delete-columns" }>,
): number {
  const deleteEnd = committed.index + committed.count;
  if (index >= deleteEnd) {
    return index - committed.count;
  }
  return index > committed.index ? committed.index : index;
}

function transformSheetDeletionAgainstDeletion(
  index: number,
  count: number,
  committed: Extract<SheetCellOperation, { readonly kind: "delete-rows" | "delete-columns" }>,
): { readonly index: number; readonly count: number } | null {
  const end = index + count;
  const committedEnd = committed.index + committed.count;
  if (end <= committed.index) {
    return { index, count };
  }
  if (index >= committedEnd) {
    return { index: index - committed.count, count };
  }
  const overlapStart = Math.max(index, committed.index);
  const overlapEnd = Math.min(end, committedEnd);
  const nextCount = count - (overlapEnd - overlapStart);
  if (nextCount <= 0) {
    return null;
  }
  return {
    index: index >= committed.index ? committed.index : index,
    count: nextCount,
  };
}

function applySheetOperationToCells(input: {
  readonly orgId: string;
  readonly tabId: string;
  readonly cells: readonly SheetCellRecord[];
  readonly operation: SheetOperation;
  readonly now: Date;
  readonly createId: () => string;
}): readonly SheetCellRecord[] {
  let cells = new Map(input.cells.map((cell) => [cellCoordinateKey(cell.row, cell.col), cell]));
  for (const change of input.operation.changes) {
    cells = applySheetOperationChangeToCells(cells, change, input);
  }
  return [...cells.values()].sort((left, right) => left.row - right.row || left.col - right.col);
}

function applySheetOperationChangeToCells(
  cells: ReadonlyMap<string, SheetCellRecord>,
  change: SheetCellOperation,
  input: {
    readonly orgId: string;
    readonly tabId: string;
    readonly now: Date;
    readonly createId: () => string;
  },
): Map<string, SheetCellRecord> {
  if (change.kind === "set-cell") {
    const next = new Map(cells);
    const key = cellCoordinateKey(change.row, change.col);
    const existing = next.get(key);
    next.set(key, {
      id: existing?.id ?? input.createId(),
      orgId: input.orgId,
      sheetTabId: input.tabId,
      row: change.row,
      col: change.col,
      value: change.value,
      formula: existing?.formula ?? null,
      calcValue: existing?.calcValue ?? change.value,
      dependencies: existing?.dependencies ?? [],
      formulaError: existing?.formulaError ?? null,
      format: existing?.format ?? {},
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    });
    return next;
  }
  if (change.kind === "clear-cell") {
    const next = new Map(cells);
    next.delete(cellCoordinateKey(change.row, change.col));
    return next;
  }
  return mapSheetCells(cells, (cell) => shiftedCellForStructuralChange(cell, change, input.now));
}

function shiftedCellForStructuralChange(
  cell: SheetCellRecord,
  change: SheetCellOperation,
  now: Date,
): SheetCellRecord | null {
  if (change.kind === "insert-rows") {
    const moved = cell.row >= change.index;
    return rebaseSheetCellForStructuralChange(
      moved ? { ...cell, row: cell.row + change.count } : cell,
      change,
      now,
      moved,
    );
  }
  if (change.kind === "insert-columns") {
    const moved = cell.col >= change.index;
    return rebaseSheetCellForStructuralChange(
      moved ? { ...cell, col: cell.col + change.count } : cell,
      change,
      now,
      moved,
    );
  }
  if (change.kind === "delete-rows") {
    if (cell.row >= change.index && cell.row < change.index + change.count) {
      return null;
    }
    const moved = cell.row >= change.index + change.count;
    return rebaseSheetCellForStructuralChange(
      moved ? { ...cell, row: cell.row - change.count } : cell,
      change,
      now,
      moved,
    );
  }
  if (change.kind === "delete-columns") {
    if (cell.col >= change.index && cell.col < change.index + change.count) {
      return null;
    }
    const moved = cell.col >= change.index + change.count;
    return rebaseSheetCellForStructuralChange(
      moved ? { ...cell, col: cell.col - change.count } : cell,
      change,
      now,
      moved,
    );
  }
  return cell;
}

function rebaseSheetCellForStructuralChange(
  cell: SheetCellRecord,
  change: SheetCellOperation,
  now: Date,
  moved: boolean,
): SheetCellRecord {
  const value = rebaseSheetFormulaForStructuralChange(cell.value, change);
  const formula =
    cell.formula === null
      ? null
      : rebaseSheetFormulaForStructuralChange(`=${cell.formula}`, change).slice(1);
  return {
    ...cell,
    value,
    formula,
    updatedAt: moved || value !== cell.value || formula !== cell.formula ? now : cell.updatedAt,
  };
}

function rebaseSheetFormulaForStructuralChange(value: string, change: SheetCellOperation): string {
  if (!value.trimStart().startsWith("=") || isSheetCellWrite(change)) {
    return value;
  }
  return value.replace(
    /(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)/g,
    (
      match,
      colAbsolute: string,
      colLabel: string,
      rowAbsolute: string,
      rowLabel: string,
      offset: number,
      source: string,
    ) => {
      if (isScopedToExplicitSheet(source, offset)) {
        return match;
      }
      const col = columnIndexFromLabel(colLabel);
      const row = Number.parseInt(rowLabel, 10) - 1;
      if (col === null || !Number.isFinite(row)) {
        return match;
      }
      const nextRow = rebaseStructuralReferenceIndex(row, change, "row");
      const nextCol = rebaseStructuralReferenceIndex(col, change, "column");
      if (nextRow === null || nextCol === null) {
        return "#REF!";
      }
      return `${colAbsolute}${columnLetter(nextCol)}${rowAbsolute}${String(nextRow + 1)}`;
    },
  );
}

function isScopedToExplicitSheet(source: string, referenceOffset: number): boolean {
  const lastBang = source.lastIndexOf("!", referenceOffset);
  if (lastBang === -1) {
    return false;
  }
  const lastBoundary = Math.max(
    source.lastIndexOf(" ", referenceOffset),
    source.lastIndexOf("\t", referenceOffset),
    source.lastIndexOf("\n", referenceOffset),
    source.lastIndexOf("\r", referenceOffset),
    source.lastIndexOf("+", referenceOffset),
    source.lastIndexOf("-", referenceOffset),
    source.lastIndexOf("*", referenceOffset),
    source.lastIndexOf("/", referenceOffset),
    source.lastIndexOf("(", referenceOffset),
    source.lastIndexOf(")", referenceOffset),
    source.lastIndexOf(",", referenceOffset),
  );
  return lastBang > lastBoundary;
}

function sortSheetRangeEdits(
  cells: readonly SheetCellRecord[],
  range: ReturnType<typeof normalizeSheetRange>,
  direction: "asc" | "desc",
): readonly SheetCellEdit[] {
  const cellsByCoordinate = new Map(
    cells.map((cell) => [cellCoordinateKey(cell.row, cell.col), cell] as const),
  );
  const rows = Array.from({ length: range.bottom - range.top + 1 }, (_, rowOffset) => {
    const row = range.top + rowOffset;
    return {
      row,
      rowOffset,
      cells: Array.from({ length: range.right - range.left + 1 }, (_, colOffset) => {
        const col = range.left + colOffset;
        const cell = cellsByCoordinate.get(cellCoordinateKey(row, col));
        return {
          value: cell?.value ?? "",
          format: cell?.format ?? {},
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

  const edits: SheetCellEdit[] = [];
  rows.forEach((sourceRow, rowOffset) => {
    const row = range.top + rowOffset;
    sourceRow.cells.forEach((cell, colOffset) => {
      const col = range.left + colOffset;
      edits.push({
        row,
        col,
        value: shiftSheetFormulaReferences(cell.value, row - sourceRow.row, 0),
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

function shiftSheetFormulaReferences(value: string, rowDelta: number, colDelta: number): string {
  if (!value.trimStart().startsWith("=") || (rowDelta === 0 && colDelta === 0)) {
    return value;
  }
  return value.replace(
    /\b(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)\b/gu,
    (match, colAbsolute: string, colLabel: string, rowAbsolute: string, rowLabel: string) => {
      const col = columnIndexFromLabel(colLabel);
      const row = Number.parseInt(rowLabel, 10) - 1;
      if (col === null || !Number.isFinite(row)) {
        return match;
      }
      const nextCol = colAbsolute === "$" ? col : Math.max(0, col + colDelta);
      const nextRow = rowAbsolute === "$" ? row : Math.max(0, row + rowDelta);
      return `${colAbsolute}${columnLetter(nextCol)}${rowAbsolute}${String(nextRow + 1)}`;
    },
  );
}

function rebaseStructuralReferenceIndex(
  index: number,
  change: SheetCellOperation,
  axis: "row" | "column",
): number | null {
  if (isSheetInsertForAxis(change, axis)) {
    return index >= change.index ? index + change.count : index;
  }
  if (isSheetDeleteForAxis(change, axis)) {
    if (index >= change.index && index < change.index + change.count) {
      return null;
    }
    return index >= change.index + change.count ? index - change.count : index;
  }
  return index;
}

function rebaseSheetMetadataRangesForOperation(
  metadata: JsonObject,
  tabId: string,
  operation: SheetOperation,
): { readonly metadata: JsonObject; readonly changed: boolean } {
  const namedRanges = rebaseSheetMetadataRangeCollection(
    metadata["namedRanges"],
    tabId,
    operation,
    isSheetNamedRange,
  );
  const mergedCells = rebaseSheetMetadataRangeCollection(
    metadata["mergedCells"],
    tabId,
    operation,
    isSheetMergedCellRange,
  );
  const protectedRanges = rebaseSheetMetadataRangeCollection(
    metadata["protectedRanges"],
    tabId,
    operation,
    isSheetProtectedRange,
  );
  const charts = rebaseSheetMetadataEntriesForOperation(
    metadata["charts"],
    tabId,
    operation,
    isSheetChartMetadata,
    rebaseSheetChartForStructuralChange,
  );
  const filterViews = rebaseSheetMetadataEntriesForOperation(
    metadata["filterViews"],
    tabId,
    operation,
    isSheetFilterViewMetadata,
    rebaseSheetFilterViewForStructuralChange,
  );
  const pivotTables = rebaseSheetMetadataEntriesForOperation(
    metadata["pivotTables"],
    tabId,
    operation,
    isSheetPivotTableMetadata,
    rebaseSheetPivotTableForStructuralChange,
  );
  const frozenPanes = rebaseSheetFrozenPanesForOperation(metadata["frozenPanes"], tabId, operation);
  if (
    !namedRanges.changed &&
    !mergedCells.changed &&
    !protectedRanges.changed &&
    !charts.changed &&
    !filterViews.changed &&
    !pivotTables.changed &&
    !frozenPanes.changed
  ) {
    return { metadata, changed: false };
  }
  const nextMetadata: Record<string, unknown> = { ...metadata };
  if (namedRanges.changed) {
    nextMetadata["namedRanges"] = namedRanges.ranges;
  }
  if (mergedCells.changed) {
    nextMetadata["mergedCells"] = mergedCells.ranges;
  }
  if (protectedRanges.changed) {
    nextMetadata["protectedRanges"] = protectedRanges.ranges;
  }
  if (charts.changed) {
    nextMetadata["charts"] = charts.entries;
  }
  if (filterViews.changed) {
    nextMetadata["filterViews"] = filterViews.entries;
  }
  if (pivotTables.changed) {
    nextMetadata["pivotTables"] = pivotTables.entries;
  }
  if (frozenPanes.changed) {
    nextMetadata["frozenPanes"] = frozenPanes.panes;
  }
  return { metadata: nextMetadata as JsonObject, changed: true };
}

function rebaseSheetMetadataRangeCollection(
  ranges: unknown,
  tabId: string,
  operation: SheetOperation,
  isRangeEntry: (value: unknown) => value is SheetMetadataRangeEntry,
): { readonly ranges: readonly unknown[]; readonly changed: boolean } {
  if (!Array.isArray(ranges)) {
    return { ranges: [], changed: false };
  }
  let changed = false;
  const nextRanges: unknown[] = [];
  for (const range of ranges) {
    if (!isRangeEntry(range) || range.tabId !== tabId) {
      nextRanges.push(range);
      continue;
    }
    let nextRange: SheetGridRange | null = range.range;
    for (const change of operation.changes) {
      if (isSheetCellWrite(change)) {
        continue;
      }
      nextRange = rebaseSheetRangeForStructuralChange(nextRange, change);
      if (nextRange === null) {
        break;
      }
    }
    if (nextRange === null) {
      changed = true;
      continue;
    }
    if (
      nextRange.startRow !== range.range.startRow ||
      nextRange.startCol !== range.range.startCol ||
      nextRange.endRow !== range.range.endRow ||
      nextRange.endCol !== range.range.endCol
    ) {
      changed = true;
      nextRanges.push({ ...range, range: nextRange });
      continue;
    }
    nextRanges.push(range);
  }
  return { ranges: nextRanges, changed };
}

function rebaseSheetCommentAnchorForOperation(
  anchor: JsonObject,
  tabId: string,
  operation: SheetOperation,
): { readonly anchor: JsonObject; readonly changed: boolean } {
  if (!isSheetRangeCommentAnchor(anchor)) {
    return { anchor, changed: false };
  }
  if (typeof anchor.tabId === "string" && anchor.tabId !== tabId) {
    return { anchor, changed: false };
  }
  if (anchor.range === undefined) {
    return { anchor, changed: false };
  }
  let range: SheetGridRange | null = anchor.range;
  for (const change of operation.changes) {
    if (isSheetCellWrite(change)) {
      continue;
    }
    range = rebaseSheetRangeForStructuralChange(range, change);
    if (range === null) {
      break;
    }
  }
  if (range === null) {
    const nextAnchor = {
      ...anchor,
      label: "Deleted range",
      deleted: true,
    };
    delete nextAnchor.range;
    return { anchor: nextAnchor, changed: true };
  }
  if (
    range.startRow === anchor.range.startRow &&
    range.startCol === anchor.range.startCol &&
    range.endRow === anchor.range.endRow &&
    range.endCol === anchor.range.endCol &&
    anchor.deleted !== true
  ) {
    return { anchor, changed: false };
  }
  return {
    anchor: {
      ...anchor,
      range,
      label: sheetRangeLabel(range),
      deleted: false,
    },
    changed: true,
  };
}

function sheetRangeLabel(range: SheetGridRange): string {
  const start = cellReference(range.startRow, range.startCol);
  const end = cellReference(range.endRow, range.endCol);
  return start === end ? start : `${start}:${end}`;
}

/**
 * Rebases every tab-scoped metadata entry through each change in the
 * operation, dropping entries whose anchor range was deleted outright.
 */
function rebaseSheetMetadataEntriesForOperation<T extends { readonly tabId: string }>(
  entries: unknown,
  tabId: string,
  operation: SheetOperation,
  isEntry: (value: unknown) => value is T,
  rebaseEntry: (entry: T, change: SheetCellOperation) => T | null,
): { readonly entries: readonly unknown[]; readonly changed: boolean } {
  if (!Array.isArray(entries)) {
    return { entries: [], changed: false };
  }
  let changed = false;
  const nextEntries: unknown[] = [];
  for (const entry of entries) {
    if (!isEntry(entry) || entry.tabId !== tabId) {
      nextEntries.push(entry);
      continue;
    }
    let nextEntry: T | null = entry;
    for (const change of operation.changes) {
      nextEntry = rebaseEntry(nextEntry, change);
      if (nextEntry === null) {
        break;
      }
    }
    if (nextEntry === null) {
      changed = true;
      continue;
    }
    if (JSON.stringify(nextEntry) !== JSON.stringify(entry)) {
      changed = true;
    }
    nextEntries.push(nextEntry);
  }
  return { entries: nextEntries, changed };
}

function rebaseSheetChartForStructuralChange(
  chart: SheetChartMetadata,
  change: SheetCellOperation,
): SheetChartMetadata | null {
  if (isSheetCellWrite(change)) {
    return chart;
  }
  const range = rebaseSheetRangeForStructuralChange(chart.range, change);
  if (range === null) {
    return null;
  }
  if (change.kind === "insert-columns" || change.kind === "delete-columns") {
    const labelCol =
      chart.labelCol === undefined
        ? undefined
        : rebaseStructuralReferenceIndex(chart.labelCol, change, "column");
    const valueCol =
      chart.valueCol === undefined
        ? undefined
        : rebaseStructuralReferenceIndex(chart.valueCol, change, "column");
    const placement =
      chart.placement === undefined
        ? undefined
        : rebaseSheetChartPlacementForStructuralChange(chart.placement, change);
    const nextChart: Record<string, unknown> = { ...chart, range };
    if (labelCol === null || labelCol === undefined) {
      delete nextChart["labelCol"];
    } else {
      nextChart["labelCol"] = labelCol;
    }
    if (valueCol === null || valueCol === undefined) {
      delete nextChart["valueCol"];
    } else {
      nextChart["valueCol"] = valueCol;
    }
    if (placement === undefined) {
      delete nextChart["placement"];
    } else {
      nextChart["placement"] = placement;
    }
    return nextChart as unknown as SheetChartMetadata;
  }
  const placement =
    chart.placement === undefined
      ? undefined
      : rebaseSheetChartPlacementForStructuralChange(chart.placement, change);
  const nextChart: Record<string, unknown> = { ...chart, range };
  if (placement === undefined) {
    delete nextChart["placement"];
  } else {
    nextChart["placement"] = placement;
  }
  return nextChart as unknown as SheetChartMetadata;
}

function rebaseSheetChartPlacementForStructuralChange(
  placement: NonNullable<SheetChartMetadata["placement"]>,
  change: SheetCellOperation,
): NonNullable<SheetChartMetadata["placement"]> | undefined {
  if (change.kind === "insert-rows" || change.kind === "delete-rows") {
    const anchorRow = rebaseStructuralReferenceIndex(placement.anchorRow, change, "row");
    if (anchorRow === null) {
      return undefined;
    }
    return { ...placement, anchorRow };
  }
  if (change.kind === "insert-columns" || change.kind === "delete-columns") {
    const anchorCol = rebaseStructuralReferenceIndex(placement.anchorCol, change, "column");
    if (anchorCol === null) {
      return undefined;
    }
    return { ...placement, anchorCol };
  }
  return placement;
}

function rebaseSheetFilterViewForStructuralChange(
  view: SheetFilterViewMetadata,
  change: SheetCellOperation,
): SheetFilterViewMetadata | null {
  if (isSheetCellWrite(change)) {
    return view;
  }
  const range = rebaseSheetRangeForStructuralChange(view.range, change);
  if (range === null) {
    return null;
  }
  if (change.kind !== "insert-columns" && change.kind !== "delete-columns") {
    return range === view.range ? view : { ...view, range };
  }
  const sortColumn =
    view.sortColumn === undefined
      ? undefined
      : rebaseStructuralReferenceIndex(view.sortColumn, change, "column");
  const sortKeys =
    view.sortKeys === undefined
      ? undefined
      : view.sortKeys
          .map((key) => rebaseStructuralReferenceIndex(key, change, "column"))
          .filter((key): key is number => key !== null);
  const predicates = filterViewPredicatesFromMetadata(view)
    .map((predicate) => rebaseSheetFilterPredicateForStructuralChange(predicate, change))
    .filter((predicate): predicate is SheetFilterPredicateMetadata => predicate !== null);
  const nextView: Record<string, unknown> = { ...view, range, predicates };
  if (sortColumn === null || sortColumn === undefined) {
    delete nextView["sortColumn"];
  } else {
    nextView["sortColumn"] = sortColumn;
  }
  if (sortKeys !== undefined) {
    nextView["sortKeys"] = sortKeys;
  }
  if (predicates[0] === undefined) {
    delete nextView["predicate"];
  } else {
    nextView["predicate"] = predicates[0];
  }
  return nextView as unknown as SheetFilterViewMetadata;
}

function filterViewPredicatesFromMetadata(
  view: SheetFilterViewMetadata,
): readonly SheetFilterPredicateMetadata[] {
  if (view.predicates !== undefined) {
    return view.predicates;
  }
  return view.predicate === undefined ? [] : [view.predicate];
}

function rebaseSheetFilterPredicateForStructuralChange(
  predicate: SheetFilterPredicateMetadata,
  change: SheetCellOperation,
): SheetFilterPredicateMetadata | null {
  const column = rebaseStructuralReferenceIndex(predicate.column, change, "column");
  return column === null ? null : { ...predicate, column };
}

function rebaseSheetPivotTableForStructuralChange(
  pivot: SheetPivotTableMetadata,
  change: SheetCellOperation,
): SheetPivotTableMetadata | null {
  if (isSheetCellWrite(change)) {
    return pivot;
  }
  const range = rebaseSheetRangeForStructuralChange(pivot.range, change);
  if (range === null) {
    return null;
  }
  if (change.kind !== "insert-columns" && change.kind !== "delete-columns") {
    return range === pivot.range ? pivot : { ...pivot, range };
  }
  const rowFieldCol = rebaseStructuralReferenceIndex(pivot.rowFieldCol, change, "column");
  const valueFieldCol = rebaseStructuralReferenceIndex(pivot.valueFieldCol, change, "column");
  if (rowFieldCol === null || valueFieldCol === null) {
    return null;
  }
  const slicerColumn =
    pivot.slicer === undefined
      ? undefined
      : rebaseStructuralReferenceIndex(pivot.slicer.column, change, "column");
  const nextPivot: Record<string, unknown> = { ...pivot, range, rowFieldCol, valueFieldCol };
  if (pivot.slicer === undefined || slicerColumn === null || slicerColumn === undefined) {
    delete nextPivot["slicer"];
  } else {
    nextPivot["slicer"] = { ...pivot.slicer, column: slicerColumn };
  }
  return nextPivot as unknown as SheetPivotTableMetadata;
}

function rebaseSheetFrozenPanesForOperation(
  panes: unknown,
  tabId: string,
  operation: SheetOperation,
): { readonly panes: readonly unknown[]; readonly changed: boolean } {
  if (!Array.isArray(panes)) {
    return { panes: [], changed: false };
  }
  let changed = false;
  const nextPanes: unknown[] = [];
  for (const pane of panes) {
    if (!isSheetFrozenPanesMetadata(pane) || pane.tabId !== tabId) {
      nextPanes.push(pane);
      continue;
    }
    let frozenRows = pane.frozenRows;
    let frozenCols = pane.frozenCols;
    for (const change of operation.changes) {
      frozenRows = rebaseSheetFrozenPaneCountForStructuralChange(frozenRows, change, "row");
      frozenCols = rebaseSheetFrozenPaneCountForStructuralChange(frozenCols, change, "column");
    }
    if (frozenRows !== pane.frozenRows || frozenCols !== pane.frozenCols) {
      changed = true;
      nextPanes.push({ ...pane, frozenRows, frozenCols });
      continue;
    }
    nextPanes.push(pane);
  }
  return { panes: nextPanes, changed };
}

function rebaseSheetFrozenPaneCountForStructuralChange(
  count: number,
  change: SheetCellOperation,
  axis: "row" | "column",
): number {
  if (isSheetCellWrite(change) || !sheetOperationAffectsAxis(change, axis)) {
    return count;
  }
  if (isSheetInsertForAxis(change, axis)) {
    return change.index < count ? count + change.count : count;
  }
  if (!isSheetDeleteForAxis(change, axis) || change.index >= count) {
    return count;
  }
  const deletedFromFrozenBand = Math.min(count, change.index + change.count) - change.index;
  return Math.max(0, count - Math.max(0, deletedFromFrozenBand));
}

function rebaseSheetRangeForStructuralChange(
  range: SheetGridRange,
  change: SheetCellOperation,
): SheetGridRange | null {
  if (change.kind === "insert-rows" || change.kind === "delete-rows") {
    const rebased = rebaseSheetRangeAxis(range.startRow, range.endRow, change);
    if (rebased === null) {
      return null;
    }
    return { ...range, startRow: rebased.start, endRow: rebased.end };
  }
  if (change.kind === "insert-columns" || change.kind === "delete-columns") {
    const rebased = rebaseSheetRangeAxis(range.startCol, range.endCol, change);
    if (rebased === null) {
      return null;
    }
    return { ...range, startCol: rebased.start, endCol: rebased.end };
  }
  return range;
}

function rebaseSheetRangeAxis(
  start: number,
  end: number,
  change: SheetCellOperation,
): { readonly start: number; readonly end: number } | null {
  const reversed = start > end;
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  if (change.kind === "insert-rows" || change.kind === "insert-columns") {
    if (high < change.index) {
      return { start, end };
    }
    if (low >= change.index) {
      const nextLow = low + change.count;
      const nextHigh = high + change.count;
      return reversed ? { start: nextHigh, end: nextLow } : { start: nextLow, end: nextHigh };
    }
    const nextLow = low;
    const nextHigh = high + change.count;
    return reversed ? { start: nextHigh, end: nextLow } : { start: nextLow, end: nextHigh };
  }
  if (change.kind !== "delete-rows" && change.kind !== "delete-columns") {
    return { start, end };
  }
  const deleteLow = change.index;
  const deleteHigh = change.index + change.count - 1;
  if (high < deleteLow) {
    return { start, end };
  }
  if (low > deleteHigh) {
    const nextLow = low - change.count;
    const nextHigh = high - change.count;
    return reversed ? { start: nextHigh, end: nextLow } : { start: nextLow, end: nextHigh };
  }
  const overlapLow = Math.max(low, deleteLow);
  const overlapHigh = Math.min(high, deleteHigh);
  const overlapCount = overlapHigh - overlapLow + 1;
  const remainingCount = high - low + 1 - overlapCount;
  if (remainingCount <= 0) {
    return null;
  }
  const nextLow = low < deleteLow ? low : deleteLow;
  const nextHigh = nextLow + remainingCount - 1;
  return reversed ? { start: nextHigh, end: nextLow } : { start: nextLow, end: nextHigh };
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

function mapSheetCells(
  cells: ReadonlyMap<string, SheetCellRecord>,
  project: (cell: SheetCellRecord) => SheetCellRecord | null,
): Map<string, SheetCellRecord> {
  const next = new Map<string, SheetCellRecord>();
  for (const cell of cells.values()) {
    const projected = project(cell);
    if (projected !== null) {
      next.set(cellCoordinateKey(projected.row, projected.col), projected);
    }
  }
  return next;
}

function cellCoordinateKey(row: number, col: number): string {
  return `${String(row)}:${String(col)}`;
}

function isSheetCellWrite(
  change: SheetCellOperation,
): change is Extract<SheetCellOperation, { readonly kind: "set-cell" | "clear-cell" }> {
  return change.kind === "set-cell" || change.kind === "clear-cell";
}

function sheetOperationAffectsAxis(change: SheetCellOperation, axis: "row" | "column"): boolean {
  return axis === "row"
    ? change.kind === "insert-rows" || change.kind === "delete-rows"
    : change.kind === "insert-columns" || change.kind === "delete-columns";
}

function isSheetInsertForAxis(
  change: SheetCellOperation,
  axis: "row" | "column",
): change is Extract<SheetCellOperation, { readonly kind: "insert-rows" | "insert-columns" }> {
  return axis === "row" ? change.kind === "insert-rows" : change.kind === "insert-columns";
}

function isSheetDeleteForAxis(
  change: SheetCellOperation,
  axis: "row" | "column",
): change is Extract<SheetCellOperation, { readonly kind: "delete-rows" | "delete-columns" }> {
  return axis === "row" ? change.kind === "delete-rows" : change.kind === "delete-columns";
}

function parseSheetOperation(value: unknown): SheetOperation {
  if (!isPlainRecord(value)) {
    throw new Error("Expected sheet operation object.");
  }
  const id = value["id"];
  const baseRevision = value["baseRevision"];
  const changes = value["changes"];
  if (
    typeof id !== "string" ||
    !Number.isInteger(baseRevision) ||
    typeof baseRevision !== "number" ||
    baseRevision < 0 ||
    !Array.isArray(changes)
  ) {
    throw new Error("Invalid sheet operation.");
  }
  return {
    id,
    baseRevision,
    changes: changes.map(parseSheetCellOperation),
  };
}

function parseSheetCellOperation(value: unknown): SheetCellOperation {
  if (!isPlainRecord(value)) {
    throw new Error("Expected sheet cell operation object.");
  }
  const kind = value["kind"];
  if (
    kind === "insert-rows" ||
    kind === "delete-rows" ||
    kind === "insert-columns" ||
    kind === "delete-columns"
  ) {
    const index = value["index"];
    const count = value["count"];
    if (
      !Number.isInteger(index) ||
      typeof index !== "number" ||
      index < 0 ||
      !Number.isInteger(count) ||
      typeof count !== "number" ||
      count <= 0
    ) {
      throw new Error("Invalid sheet structural operation.");
    }
    return { kind, index, count };
  }
  const row = value["row"];
  const col = value["col"];
  if (
    (kind !== "set-cell" && kind !== "clear-cell") ||
    !Number.isInteger(row) ||
    typeof row !== "number" ||
    row < 0 ||
    !Number.isInteger(col) ||
    typeof col !== "number" ||
    col < 0
  ) {
    throw new Error("Invalid sheet cell operation.");
  }
  if (kind === "clear-cell") {
    return { kind, row, col };
  }
  const valueText = value["value"];
  if (typeof valueText !== "string") {
    throw new Error("Invalid sheet set-cell operation.");
  }
  return { kind, row, col, value: valueText };
}

// ---------------------------------------------------------------------------
// Postgres store.
// ---------------------------------------------------------------------------

type SqlLike = postgres.Sql | postgres.TransactionSql;

interface SheetRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly created_by_actor_id: string | null;
  readonly title: string;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SheetTabRow {
  readonly id: string;
  readonly org_id: string;
  readonly sheet_id: string;
  readonly name: string;
  readonly position: number;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SheetCellRow {
  readonly id: string;
  readonly org_id: string;
  readonly sheet_tab_id: string;
  readonly row: number;
  readonly col: number;
  readonly value: string;
  readonly formula: string | null;
  readonly calc_value: string | null;
  readonly dependencies: readonly string[];
  readonly formula_error: string | null;
  readonly format: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SheetCommentRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly parent_comment_id: string | null;
  readonly actor_id: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}

interface SheetCommentProjectionRow extends SheetCommentRow {
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

interface SheetOperationLogRow {
  readonly org_id: string;
  readonly sheet_id: string;
  readonly sheet_tab_id: string;
  readonly actor_id: string | null;
  readonly operation_id: string;
  readonly revision: number;
  readonly base_revision: number;
  readonly operation: JsonObject;
  readonly created_at: Date;
}

interface SheetVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_number: number;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
}

/** Postgres-backed {@link SheetsStore}. */
export class PostgresSheetsStore implements SheetsStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: {
      readonly storageResolver?: SheetSnapshotStorageResolver | undefined;
    } = {},
  ) {}

  async createSheet(input: CreateSheetInput): Promise<SheetWithTabs> {
    const title = assertTitle(input.title);
    const tabNames = (
      input.tabNames !== undefined && input.tabNames.length > 0
        ? input.tabNames
        : [DEFAULT_TAB_NAME]
    ).map(assertTabName);
    return this.sql.begin(async (tx) => {
      const sheetRows = (await tx`
        insert into sheets (org_id, owner_actor_id, created_by_actor_id, title, metadata)
        values (
          ${input.orgId}, ${input.actorId}, ${input.actorId}, ${title},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly SheetRow[];
      const sheet = mapSheet(sheetRows[0]);
      const tabs: SheetTabRecord[] = [];
      for (let index = 0; index < tabNames.length; index += 1) {
        const tabRows = (await tx`
          insert into sheet_tabs (org_id, sheet_id, name, position)
          values (${input.orgId}, ${sheet.id}, ${tabNames[index] ?? DEFAULT_TAB_NAME}, ${index})
          returning *
        `) as unknown as readonly SheetTabRow[];
        tabs.push(mapTab(tabRows[0]));
      }
      const storageKey = `sheets/${input.orgId}/${sheet.id}`;
      const storedSnapshot = await writeSheetStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: storageKey,
        sheet,
        tabs,
      });
      const versionSnapshot = await writeSheetStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: sheetSnapshotVersionStorageKey(input.orgId, sheet.id, 1),
        sheet,
        tabs,
      });
      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${sheet.id}, ${input.orgId}, ${input.actorId}, 'file',
          ${storageKey},
          'application/vnd.helix.spreadsheet', ${storedSnapshot.byteSize}, ${storedSnapshot.sha256},
          ${tx.json(
            toSqlJson({
              ...(input.metadata ?? {}),
              app: "sheets",
              sheetId: sheet.id,
              name: title,
              title,
              folderId: input.folderId ?? null,
              preview: nativeSheetPreviewMetadata(sheet, tabs, []),
            }),
          )}
        )
        on conflict (id) do update set
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          metadata = excluded.metadata,
          updated_at = now()
      `;
      await insertSheetSnapshotVersion(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        sheetId: sheet.id,
        versionNumber: 1,
        storageKey: sheetSnapshotVersionStorageKey(input.orgId, sheet.id, 1),
        byteSize: versionSnapshot.byteSize,
        sha256: versionSnapshot.sha256,
        metadata: { app: "sheets", title, tabCount: tabs.length },
      });
      await grantObjectAccess(tx, {
        orgId: input.orgId,
        objectId: sheet.id,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.sheet.created",
        objectId: sheet.id,
        payload: { title, tabCount: tabs.length },
      });
      return { ...sheet, tabs };
    });
  }

  async copySheet(input: CopySheetInput): Promise<SheetWithTabs | null> {
    return this.sql.begin(async (tx) => {
      const source = await selectVisibleSheet(tx, input);
      if (source === null) {
        return null;
      }
      const sourceTabs = await selectTabs(tx, input.orgId, source.id);
      const sourceCells = await selectCellsForSheet(tx, input.orgId, source.id);
      const sourceObjectRows = (await tx`
        select metadata
        from objects
        where id = ${input.sheetId}
          and org_id = ${input.orgId}
          and metadata->>'app' = 'sheets'
        limit 1
      `) as unknown as readonly { readonly metadata: JsonObject }[];
      const sourceFolderId = jsonStringOrNull(sourceObjectRows[0]?.metadata.folderId);
      const folderId = input.folderId === undefined ? sourceFolderId : input.folderId;
      const title = assertTitle(input.title ?? `${source.title} (Copy)`);
      const sheetRows = (await tx`
        insert into sheets (org_id, owner_actor_id, created_by_actor_id, title, metadata)
        values (
          ${input.orgId}, ${input.actorId}, ${input.actorId}, ${title},
          ${tx.json(toSqlJson({}))}
        )
        returning *
      `) as unknown as readonly SheetRow[];
      const insertedSheet = mapSheet(sheetRows[0]);
      const tabIdMap = new Map<string, string>();
      const tabs: SheetTabRecord[] = [];
      const now = new Date();
      for (const tab of sourceTabs) {
        const tabRows = (await tx`
          insert into sheet_tabs (org_id, sheet_id, name, position, metadata, created_at, updated_at)
          values (
            ${input.orgId},
            ${insertedSheet.id},
            ${tab.name},
            ${tab.position},
            ${tx.json(toSqlJson(tab.metadata))},
            ${now},
            ${now}
          )
          returning *
        `) as unknown as readonly SheetTabRow[];
        const copiedTab = mapTab(tabRows[0]);
        tabIdMap.set(tab.id, copiedTab.id);
        tabs.push(copiedTab);
      }
      const metadata = {
        ...replaceStringsInJsonObject(source.metadata, (value) => tabIdMap.get(value) ?? value),
        createdFrom: "sheets.copy",
        copiedFromSheetId: source.id,
        ...(input.metadata ?? {}),
      };
      const sheetRowsAfterMetadata = (await tx`
        update sheets
        set metadata = ${tx.json(toSqlJson(metadata))}
        where id = ${insertedSheet.id} and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly SheetRow[];
      const sheet = mapSheet(sheetRowsAfterMetadata[0]);
      const cells: SheetCellRecord[] = [];
      for (const cell of sourceCells) {
        const nextTabId = tabIdMap.get(cell.sheetTabId);
        if (nextTabId === undefined) {
          continue;
        }
        const cellRows = (await tx`
          insert into sheet_cells (
            org_id, sheet_tab_id, row, col, value, formula, calc_value, dependencies, formula_error, format, created_at, updated_at
          )
          values (
            ${input.orgId},
            ${nextTabId},
            ${cell.row},
            ${cell.col},
            ${cell.value},
            ${cell.formula},
            ${cell.calcValue},
            ${tx.json(toSqlJson(cell.dependencies))},
            ${cell.formulaError},
            ${tx.json(toSqlJson(cell.format))},
            ${now},
            ${now}
          )
          returning *
        `) as unknown as readonly SheetCellRow[];
        cells.push(mapCell(cellRows[0]));
      }
      const storageKey = `sheets/${input.orgId}/${sheet.id}`;
      const storedSnapshot = await writeSheetStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: storageKey,
        sheet,
        tabs,
        cells,
      });
      const versionSnapshot = await writeSheetStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: sheetSnapshotVersionStorageKey(input.orgId, sheet.id, 1),
        sheet,
        tabs,
        cells,
      });
      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${sheet.id}, ${input.orgId}, ${input.actorId}, 'file',
          ${storageKey},
          'application/vnd.helix.spreadsheet', ${storedSnapshot.byteSize}, ${storedSnapshot.sha256},
          ${tx.json(
            toSqlJson({
              ...metadata,
              app: "sheets",
              sheetId: sheet.id,
              name: title,
              title,
              folderId: folderId ?? null,
              preview: nativeSheetPreviewMetadata(sheet, tabs, cells),
            }),
          )}
        )
        on conflict (id) do update set
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          metadata = excluded.metadata,
          updated_at = now()
      `;
      await insertSheetSnapshotVersion(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        sheetId: sheet.id,
        versionNumber: 1,
        storageKey: sheetSnapshotVersionStorageKey(input.orgId, sheet.id, 1),
        byteSize: versionSnapshot.byteSize,
        sha256: versionSnapshot.sha256,
        metadata: {
          app: "sheets",
          title,
          tabCount: tabs.length,
          cellCount: cells.length,
          copiedFromSheetId: source.id,
        },
      });
      await grantObjectAccess(tx, {
        orgId: input.orgId,
        objectId: sheet.id,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.sheet.copied",
        objectId: sheet.id,
        payload: { title, copiedFromSheetId: source.id, tabCount: tabs.length },
      });
      return { ...sheet, tabs };
    });
  }

  async listSheets(input: ListSheetsInput): Promise<SheetsPage> {
    const query = input.query?.trim();
    const titleQuery = query === undefined || query.length === 0 ? null : `%${query}%`;
    const rows = (await this.sql`
      select *, count(*) over () as total_count
      from sheets
      where org_id = ${input.orgId}
        and deleted_at is null
        and (owner_actor_id = ${input.actorId} or created_by_actor_id = ${input.actorId})
        and (${titleQuery}::text is null or title ilike ${titleQuery})
      order by updated_at desc
      limit ${input.limit}
      offset ${input.offset}
    `) as unknown as readonly (SheetRow & { readonly total_count: string })[];
    return {
      sheets: rows.map(mapSheet),
      total: rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0,
      limit: input.limit,
      offset: input.offset,
    };
  }

  async getSheet(input: SheetRef): Promise<SheetWithTabs | null> {
    const sheet = await selectVisibleSheet(this.sql, input);
    if (sheet === null) {
      return null;
    }
    return { ...sheet, tabs: await selectTabs(this.sql, input.orgId, sheet.id) };
  }

  async updateSheet(input: UpdateSheetInput): Promise<SheetWithTabs | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectVisibleSheet(tx, input);
      if (existing === null) {
        return null;
      }
      const title = input.title === undefined ? existing.title : assertTitle(input.title);
      const metadata = input.metadata ?? existing.metadata;
      const protectedRangesDelta =
        input.metadata === undefined ? null : protectedRangeAuditDelta(existing.metadata, metadata);
      const rows = (await tx`
        update sheets
        set title = ${title}, metadata = ${tx.json(toSqlJson(metadata))}, updated_at = now()
        where id = ${input.sheetId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetRow[];
      if (rows[0] === undefined) {
        return null;
      }
      const sheet = mapSheet(rows[0]);
      const tabs = await selectTabs(tx, input.orgId, sheet.id);
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, sheet.id);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.sheet.updated",
        objectId: sheet.id,
        payload: { title },
      });
      if (protectedRangesDelta !== null) {
        await appendSheetsActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "sheets.protected_ranges.updated",
          objectId: sheet.id,
          payload: { sheetId: sheet.id, title, protectedRanges: protectedRangesDelta },
        });
      }
      return { ...sheet, tabs };
    });
  }

  async deleteSheet(input: SheetRef): Promise<SheetRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectVisibleSheet(tx, input);
      if (existing === null) {
        return null;
      }
      const rows = (await tx`
        update sheets set deleted_at = now(), updated_at = now()
        where id = ${input.sheetId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetRow[];
      if (rows[0] === undefined) {
        return null;
      }
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.sheet.deleted",
        objectId: input.sheetId,
        payload: {},
      });
      return mapSheet(rows[0]);
    });
  }

  async createTab(input: CreateTabInput): Promise<SheetTabRecord> {
    const name = assertTabName(input.name);
    return this.sql.begin(async (tx) => {
      const sheet = await selectVisibleSheet(tx, input);
      if (sheet === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${input.sheetId}`);
      }
      const positionRows = (await tx`
        select coalesce(max(position) + 1, 0) as next_position
        from sheet_tabs
        where sheet_id = ${input.sheetId} and deleted_at is null
      `) as unknown as readonly { readonly next_position: number }[];
      const position = input.position ?? positionRows[0]?.next_position ?? 0;
      const rows = (await tx`
        insert into sheet_tabs (org_id, sheet_id, name, position, metadata)
        values (
          ${input.orgId}, ${input.sheetId}, ${name}, ${position},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly SheetTabRow[];
      await touchSheet(tx, input.orgId, input.sheetId);
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.tab.created",
        objectId: input.sheetId,
        payload: { tabId: rows[0]?.id ?? null, name },
      });
      return mapTab(rows[0]);
    });
  }

  async updateTab(input: UpdateTabInput): Promise<SheetTabRecord | null> {
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null) {
        return null;
      }
      const name = input.name === undefined ? tab.name : assertTabName(input.name);
      const position = input.position ?? tab.position;
      const metadata = input.metadata ?? tab.metadata;
      const rows = (await tx`
        update sheet_tabs
        set name = ${name}, position = ${position},
            metadata = ${tx.json(toSqlJson(metadata))}, updated_at = now()
        where id = ${input.tabId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetTabRow[];
      if (rows[0] === undefined) {
        return null;
      }
      await touchSheet(tx, input.orgId, tab.sheetId);
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, tab.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.tab.updated",
        objectId: tab.sheetId,
        payload: { tabId: input.tabId, name },
      });
      return mapTab(rows[0]);
    });
  }

  async deleteTab(input: TabRef): Promise<SheetTabRecord | null> {
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null) {
        return null;
      }
      const remainingRows = (await tx`
        select count(*)::int as remaining
        from sheet_tabs
        where sheet_id = ${tab.sheetId} and deleted_at is null and id <> ${input.tabId}
      `) as unknown as readonly { readonly remaining: number }[];
      if ((remainingRows[0]?.remaining ?? 0) === 0) {
        throw new SheetsValidationError("A spreadsheet must keep at least one tab.");
      }
      const rows = (await tx`
        update sheet_tabs set deleted_at = now(), updated_at = now()
        where id = ${input.tabId} and org_id = ${input.orgId} and deleted_at is null
        returning *
      `) as unknown as readonly SheetTabRow[];
      if (rows[0] === undefined) {
        return null;
      }
      await tx`delete from sheet_cells where sheet_tab_id = ${input.tabId}`;
      await touchSheet(tx, input.orgId, tab.sheetId);
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, tab.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.tab.deleted",
        objectId: tab.sheetId,
        payload: { tabId: input.tabId },
      });
      return mapTab(rows[0]);
    });
  }

  async getTabCells(input: GetTabCellsInput): Promise<SheetTabWithCells | null> {
    const tab = await selectVisibleTab(this.sql, input);
    if (tab === null) {
      return null;
    }
    return { ...tab, cells: await selectCells(this.sql, input.tabId, input.window) };
  }

  async updateCells(input: UpdateCellsInput): Promise<SheetTabWithCells> {
    for (const edit of input.edits) {
      assertCellEdit(edit);
    }
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
      }
      const sheet = await selectSheetById(tx, input.orgId, tab.sheetId);
      if (sheet === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${tab.sheetId}`);
      }
      assertNoProtectedRangeEdits(input.edits, tab, sheet);
      assertNoHardValidationFailures(input.edits, await selectCells(tx, input.tabId), tab, sheet);
      await writeSheetCellEdits(tx, input.orgId, input.tabId, input.edits);
      const cellsWithMetadata = await refreshFormulaMetadata(
        tx,
        input.orgId,
        tab.sheetId,
        input.tabId,
        sheet.metadata,
      );
      await touchSheet(tx, input.orgId, tab.sheetId);
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, tab.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.cells.updated",
        objectId: tab.sheetId,
        payload: { tabId: input.tabId, editCount: input.edits.length },
      });
      return { ...tab, cells: filterCellsInWindow(cellsWithMetadata, input.window) };
    });
  }

  async sortRange(input: SortRangeInput): Promise<SheetTabWithCells> {
    const range = normalizeSheetRange(input.range);
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
      }
      const sheet = await selectSheetById(tx, input.orgId, tab.sheetId);
      if (sheet === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${tab.sheetId}`);
      }
      const currentCells = await selectCells(tx, input.tabId);
      if (range.top === range.bottom) {
        return { ...tab, cells: filterCellsInWindow(currentCells, input.window) };
      }
      const edits = sortSheetRangeEdits(currentCells, range, input.direction);
      assertNoProtectedRangeEdits(edits, tab, sheet);
      assertNoHardValidationFailures(edits, currentCells, tab, sheet);
      await writeSheetCellEdits(tx, input.orgId, input.tabId, edits);
      const cellsWithMetadata = await refreshFormulaMetadata(
        tx,
        input.orgId,
        tab.sheetId,
        input.tabId,
        sheet.metadata,
      );
      await touchSheet(tx, input.orgId, tab.sheetId);
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, tab.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.range.sorted",
        objectId: tab.sheetId,
        payload: {
          tabId: input.tabId,
          direction: input.direction,
          range: input.range,
          editCount: edits.length,
        },
      });
      return { ...tab, cells: filterCellsInWindow(cellsWithMetadata, input.window) };
    });
  }

  async createComment(input: CreateSheetCommentInput): Promise<SheetCommentRecord> {
    return this.sql.begin(async (tx) => {
      const sheet = await selectVisibleSheet(tx, input);
      if (sheet === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${input.sheetId}`);
      }
      if (input.parentCommentId !== undefined) {
        await requireSheetCommentParent(tx, {
          orgId: input.orgId,
          sheetId: input.sheetId,
          parentCommentId: input.parentCommentId,
        });
      }
      const tabs = await selectTabs(tx, input.orgId, sheet.id);
      const anchor = validatedSheetCommentAnchor(input.anchor, sheet, tabs);
      const rows = (await tx`
        insert into drive_comments
          (org_id, object_id, parent_comment_id, actor_id, anchor, body, metadata)
        values (
          ${input.orgId},
          ${input.sheetId},
          ${input.parentCommentId ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(anchor))},
          ${input.body},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly SheetCommentRow[];
      const comment = mapSheetComment(rows[0]);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.comment.created",
        objectId: sheet.id,
        payload: { commentId: comment.id, parentCommentId: comment.parentCommentId },
      });
      await notifySheetCommentMentions(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        sheet,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        anchor: comment.anchor,
        body: input.body,
        metadata: input.metadata ?? {},
      });
      return comment;
    });
  }

  async listComments(input: ListSheetCommentsInput): Promise<readonly SheetCommentListItem[]> {
    const sheet = await selectVisibleSheet(this.sql, input);
    if (sheet === null) {
      return [];
    }
    const rows = (await this.sql`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from drive_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${input.orgId}
        and c.object_id = ${sheet.id}
        ${
          input.status === undefined || input.status === "all"
            ? this.sql``
            : this.sql`and c.status = ${input.status}`
        }
      order by c.created_at asc, c.id asc
    `) as unknown as readonly SheetCommentProjectionRow[];
    return rows.map(mapSheetCommentListItem);
  }

  async resolveComment(input: ResolveSheetCommentInput): Promise<SheetCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const loaded = await selectVisibleSheetComment(tx, input);
      if (loaded === null) {
        return null;
      }
      const { comment: existing, sheet } = loaded;
      if (existing.status === "resolved") {
        return mapSheetComment(existing);
      }
      const rows = (await tx`
        update drive_comments
        set status = 'resolved', resolved_at = now(), updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly SheetCommentRow[];
      const comment = mapSheetComment(rows[0]);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.comment.resolved",
        objectId: sheet.id,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async reopenComment(input: ResolveSheetCommentInput): Promise<SheetCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const loaded = await selectVisibleSheetComment(tx, input);
      if (loaded === null) {
        return null;
      }
      const { comment: existing, sheet } = loaded;
      if (existing.status === "open") {
        return mapSheetComment(existing);
      }
      const rows = (await tx`
        update drive_comments
        set status = 'open', resolved_at = null, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly SheetCommentRow[];
      const comment = mapSheetComment(rows[0]);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.comment.reopened",
        objectId: sheet.id,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async updateComment(input: UpdateSheetCommentInput): Promise<SheetCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const loaded = await selectVisibleSheetComment(tx, input);
      if (loaded === null) {
        return null;
      }
      const { sheet } = loaded;
      const rows = (await tx`
        update drive_comments
        set body = ${input.body}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly SheetCommentRow[];
      const comment = mapSheetComment(rows[0]);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.comment.updated",
        objectId: sheet.id,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async deleteComment(input: DeleteSheetCommentInput): Promise<SheetCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const loaded = await selectVisibleSheetComment(tx, input);
      if (loaded === null) {
        return null;
      }
      const { sheet } = loaded;
      const rows = (await tx`
        delete from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly SheetCommentRow[];
      const comment = mapSheetComment(rows[0]);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.comment.deleted",
        objectId: sheet.id,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async listOperations(
    input: SheetRef & { readonly afterRevision?: number | undefined },
  ): Promise<readonly SheetOperationLogRecord[]> {
    const sheet = await selectVisibleSheet(this.sql, input);
    if (sheet === null) {
      return [];
    }
    const rows = (await this.sql`
      select *
      from sheet_op_log
      where org_id = ${input.orgId}
        and sheet_id = ${sheet.id}
        and revision > ${input.afterRevision ?? 0}
      order by revision asc
    `) as unknown as readonly SheetOperationLogRow[];
    return rows.map(mapSheetOperationLog);
  }

  async appendOperation(input: AppendSheetOperationInput): Promise<SheetOperationLogRecord> {
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null || tab.sheetId !== input.sheetId) {
        throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
      }
      const existingRows = (await tx`
        select *
        from sheet_op_log
        where org_id = ${input.orgId}
          and sheet_id = ${input.sheetId}
          and operation_id = ${input.operationId}
        limit 1
      `) as unknown as readonly SheetOperationLogRow[];
      if (existingRows[0] !== undefined) {
        return mapSheetOperationLog(existingRows[0]);
      }
      const rows = (await tx`
        insert into sheet_op_log (
          org_id, sheet_id, sheet_tab_id, actor_id, operation_id, revision, base_revision, operation
        )
        values (
          ${input.orgId},
          ${input.sheetId},
          ${input.tabId},
          ${input.actorId},
          ${input.operationId},
          (
            select coalesce(max(revision) + 1, 1)::int
            from sheet_op_log
            where org_id = ${input.orgId} and sheet_id = ${input.sheetId}
          ),
          ${input.baseRevision},
          ${tx.json(toSqlJson(input.operation))}
        )
        returning *
      `) as unknown as readonly SheetOperationLogRow[];
      return mapSheetOperationLog(rows[0]);
    });
  }

  async applyOperation(input: ApplySheetOperationInput): Promise<ApplySheetOperationResult> {
    return this.sql.begin(async (tx) => {
      const tab = await selectVisibleTab(tx, input);
      if (tab === null || tab.sheetId !== input.sheetId) {
        throw new SheetsNotFoundError(`Unknown or inaccessible tab: ${input.tabId}`);
      }
      const sheet = await selectVisibleSheetForUpdate(tx, input);
      if (sheet === null) {
        throw new SheetsNotFoundError(`Unknown or inaccessible sheet: ${input.sheetId}`);
      }
      const existingRows = (await tx`
        select *
        from sheet_op_log
        where org_id = ${input.orgId}
          and sheet_id = ${input.sheetId}
          and operation_id = ${input.operation.id}
        limit 1
      `) as unknown as readonly SheetOperationLogRow[];
      if (existingRows[0] !== undefined) {
        return {
          status: "duplicate",
          operationId: input.operation.id,
          revision: existingRows[0].revision,
        };
      }
      const latestRows = (await tx`
        select coalesce(max(revision), 0)::int as revision
        from sheet_op_log
        where org_id = ${input.orgId} and sheet_id = ${input.sheetId}
      `) as unknown as readonly { readonly revision: number }[];
      const compactedThroughRevision = compactedThroughRevisionFromMetadata(sheet.metadata);
      const latestRevision = Math.max(latestRows[0]?.revision ?? 0, compactedThroughRevision);
      if (input.operation.baseRevision < compactedThroughRevision) {
        return {
          status: "compacted",
          operationId: input.operation.id,
          revision: latestRevision,
          compactedThroughRevision,
        };
      }
      if (input.operation.baseRevision > latestRevision) {
        return { status: "ahead", operationId: input.operation.id, revision: latestRevision };
      }
      const committedRows = (await tx`
        select *
        from sheet_op_log
        where org_id = ${input.orgId}
          and sheet_id = ${input.sheetId}
          and revision > ${input.operation.baseRevision}
        order by revision asc
      `) as unknown as readonly SheetOperationLogRow[];
      const transformed = transformSheetOperation(
        input.operation,
        committedRows
          .map((row) => mapSheetOperationLog(row))
          .filter((operation) => operation.tabId === input.tabId)
          .map((operation) => operation.operation),
        latestRevision,
      );
      if (transformed === null) {
        return { status: "dropped", operationId: input.operation.id, revision: latestRevision };
      }
      const edits = cellEditsFromSheetOperation(transformed);
      for (const edit of edits) {
        assertCellEdit(edit);
      }
      assertNoProtectedRangeEdits(edits, tab, sheet);
      const currentCells = await selectCells(tx, input.tabId);
      assertNoHardValidationFailures(edits, currentCells, tab, sheet);
      const now = new Date();
      const metadataRebase = rebaseSheetMetadataRangesForOperation(
        sheet.metadata,
        input.tabId,
        transformed,
      );
      const sheetMetadata = metadataRebase.metadata;
      if (metadataRebase.changed) {
        await tx`
          update sheets
          set metadata = ${tx.json(toSqlJson(sheetMetadata))}, updated_at = ${now}
          where id = ${input.sheetId} and org_id = ${input.orgId} and deleted_at is null
        `;
      }
      await rebaseSheetCommentAnchorsForOperation(tx, {
        orgId: input.orgId,
        sheetId: input.sheetId,
        tabId: input.tabId,
        operation: transformed,
        now,
      });
      const nextCells = applySheetOperationToCells({
        orgId: input.orgId,
        tabId: input.tabId,
        cells: currentCells,
        operation: transformed,
        now,
        createId: randomUUID,
      });
      await tx`delete from sheet_cells where sheet_tab_id = ${input.tabId}`;
      for (const cell of nextCells) {
        await tx`
          insert into sheet_cells (
            id,
            org_id,
            sheet_tab_id,
            row,
            col,
            value,
            formula,
            calc_value,
            dependencies,
            formula_error,
            format,
            created_at,
            updated_at
          )
          values (
            ${cell.id},
            ${input.orgId},
            ${input.tabId},
            ${cell.row},
            ${cell.col},
            ${cell.value},
            ${cell.formula},
            ${cell.calcValue},
            ${tx.json(toSqlJson(cell.dependencies))},
            ${cell.formulaError},
            ${tx.json(toSqlJson(cell.format))},
            ${cell.createdAt},
            ${cell.updatedAt}
          )
        `;
      }
      const cellsWithMetadata = await refreshFormulaMetadata(
        tx,
        input.orgId,
        input.sheetId,
        input.tabId,
        sheetMetadata,
      );
      await touchSheet(tx, input.orgId, input.sheetId);
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.cells.updated",
        objectId: input.sheetId,
        payload: {
          tabId: input.tabId,
          editCount: edits.length,
          operationChangeCount: transformed.changes.length,
          source: "sheets.sync",
        },
      });
      const rows = (await tx`
        insert into sheet_op_log (
          org_id, sheet_id, sheet_tab_id, actor_id, operation_id, revision, base_revision, operation
        )
        values (
          ${input.orgId},
          ${input.sheetId},
          ${input.tabId},
          ${input.actorId},
          ${transformed.id},
          ${latestRevision + 1},
          ${transformed.baseRevision},
          ${tx.json(toSqlJson(transformed))}
        )
        returning *
      `) as unknown as readonly SheetOperationLogRow[];
      const record = mapSheetOperationLog(rows[0]);
      return {
        status: "applied",
        revision: record.revision,
        operation: record.operation,
        tab: { ...tab, cells: cellsWithMetadata },
      };
    });
  }

  async compactOperations(
    input: CompactSheetOperationsInput,
  ): Promise<CompactSheetOperationsResult> {
    return this.sql.begin(async (tx) => {
      const sheet = await selectVisibleSheetForUpdate(tx, input);
      if (sheet === null) {
        return { latestRevision: 0, compactedThroughRevision: 0, deletedCount: 0 };
      }
      const retainRevisions = assertRetainedOperationRevisions(input.retainRevisions);
      const latestRows = (await tx`
        select coalesce(max(revision), 0)::int as revision
        from sheet_op_log
        where org_id = ${input.orgId} and sheet_id = ${input.sheetId}
      `) as unknown as readonly { readonly revision: number }[];
      const previousCompactedRevision = compactedThroughRevisionFromMetadata(sheet.metadata);
      const latestRevision = Math.max(latestRows[0]?.revision ?? 0, previousCompactedRevision);
      const compactedThroughRevision = Math.max(
        previousCompactedRevision,
        Math.max(0, latestRevision - retainRevisions),
      );
      if (compactedThroughRevision <= previousCompactedRevision) {
        return {
          latestRevision,
          compactedThroughRevision: previousCompactedRevision,
          deletedCount: 0,
        };
      }
      const deletedRows = (await tx`
        delete from sheet_op_log
        where org_id = ${input.orgId}
          and sheet_id = ${input.sheetId}
          and revision <= ${compactedThroughRevision}
        returning revision
      `) as unknown as readonly { readonly revision: number }[];
      await tx`
        update sheets
        set metadata = ${tx.json(
          toSqlJson(withSheetSyncMetadata(sheet.metadata, compactedThroughRevision)),
        )}, updated_at = ${new Date()}
        where org_id = ${input.orgId}
          and id = ${input.sheetId}
          and deleted_at is null
      `;
      return {
        latestRevision,
        compactedThroughRevision,
        deletedCount: deletedRows.length,
      };
    });
  }

  async listVersions(input: ListSheetVersionsInput): Promise<readonly SheetVersionRecord[]> {
    const sheet = await selectVisibleSheet(this.sql, input);
    if (sheet === null) {
      return [];
    }
    const rows = (await this.sql`
      select *
      from drive_versions
      where org_id = ${input.orgId}
        and object_id = ${input.sheetId}
        and mime_type = 'application/vnd.helix.spreadsheet+json'
      order by version_number desc
      limit ${input.limit}
    `) as unknown as readonly SheetVersionRow[];
    return rows.map(mapSheetVersion);
  }

  async restoreVersion(input: RestoreSheetVersionInput): Promise<SheetWithTabs | null> {
    return this.sql.begin(async (tx) => {
      const sheet = await selectVisibleSheetForUpdate(tx, input);
      if (sheet === null) {
        return null;
      }
      const versionRows = (await tx`
        select *
        from drive_versions
        where id = ${input.versionId}
          and org_id = ${input.orgId}
          and object_id = ${input.sheetId}
          and mime_type = 'application/vnd.helix.spreadsheet+json'
        limit 1
      `) as unknown as readonly SheetVersionRow[];
      if (versionRows[0] === undefined) {
        return null;
      }
      const version = mapSheetVersion(versionRows[0]);
      const snapshot = await readSheetSnapshotVersion(this.options.storageResolver, {
        orgId: input.orgId,
        storageKey: version.storageKey,
        sheetId: input.sheetId,
      });
      const now = new Date();
      await tx`
        update sheets
        set title = ${snapshot.sheet.title},
            metadata = ${tx.json(toSqlJson(snapshot.sheet.metadata))},
            updated_at = ${now}
        where id = ${input.sheetId}
          and org_id = ${input.orgId}
      `;
      await tx`
        delete from sheet_tabs
        where org_id = ${input.orgId}
          and sheet_id = ${input.sheetId}
      `;
      for (const tab of snapshot.tabs) {
        await tx`
          insert into sheet_tabs (id, org_id, sheet_id, name, position, metadata, created_at, updated_at)
          values (
            ${tab.id},
            ${input.orgId},
            ${input.sheetId},
            ${tab.name},
            ${tab.position},
            ${tx.json(toSqlJson(tab.metadata))},
            ${now},
            ${now}
          )
        `;
      }
      for (const cell of snapshot.cells) {
        await tx`
          insert into sheet_cells (
            org_id, sheet_tab_id, row, col, value, formula, calc_value, dependencies, formula_error, format, created_at, updated_at
          )
          values (
            ${input.orgId},
            ${cell.tabId},
            ${cell.row},
            ${cell.col},
            ${cell.value},
            ${cell.formula},
            ${cell.calcValue},
            ${tx.json(toSqlJson(cell.dependencies))},
            ${cell.formulaError},
            ${tx.json(toSqlJson(cell.format))},
            ${now},
            ${now}
          )
        `;
      }
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.sheetId);
      await appendSheetsActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "sheets.version.restored",
        objectId: input.sheetId,
        payload: {
          restoredVersionId: version.id,
          restoredVersionNumber: version.versionNumber,
        },
      });
      const restored = await selectVisibleSheet(tx, input);
      if (restored === null) {
        return null;
      }
      return { ...restored, tabs: await selectTabs(tx, input.orgId, input.sheetId) };
    });
  }

  async #refreshStorageSnapshot(
    sql: SqlLike,
    orgId: string,
    actorId: string,
    sheetId: string,
  ): Promise<void> {
    if (this.options.storageResolver === undefined) {
      return;
    }
    const sheet = await selectSheetById(sql, orgId, sheetId);
    if (sheet === null) {
      return;
    }
    const tabs = await selectTabs(sql, orgId, sheetId);
    const cells = await selectCellsForSheet(sql, orgId, sheetId);
    const storageKey = `sheets/${orgId}/${sheetId}`;
    const versionNumber = await nextDriveVersionNumber(sql, sheetId);
    const versionStorageKey = sheetSnapshotVersionStorageKey(orgId, sheetId, versionNumber);
    const storedSnapshot = await writeSheetStorageSnapshot({
      resolver: this.options.storageResolver,
      orgId,
      key: storageKey,
      sheet,
      tabs,
      cells,
    });
    const versionSnapshot = await writeSheetStorageSnapshot({
      resolver: this.options.storageResolver,
      orgId,
      key: versionStorageKey,
      sheet,
      tabs,
      cells,
    });
    await insertSheetSnapshotVersion(sql, {
      orgId,
      actorId,
      sheetId,
      versionNumber,
      storageKey: versionStorageKey,
      byteSize: versionSnapshot.byteSize,
      sha256: versionSnapshot.sha256,
      metadata: {
        app: "sheets",
        title: sheet.title,
        tabCount: tabs.length,
        cellCount: cells.length,
      },
    });
    await sql`
      update objects
      set byte_size = ${storedSnapshot.byteSize},
          sha256 = ${storedSnapshot.sha256},
          metadata = objects.metadata || ${sql.json(
            toSqlJson({
              app: "sheets",
              sheetId,
              name: sheet.title,
              title: sheet.title,
              preview: nativeSheetPreviewMetadata(sheet, tabs, cells),
            }),
          )},
          updated_at = now()
      where id = ${sheetId} and org_id = ${orgId}
    `;
  }
}

async function nextDriveVersionNumber(sql: SqlLike, objectId: string): Promise<number> {
  const rows = (await sql`
    select coalesce(max(version_number) + 1, 1)::int as version_number
    from drive_versions
    where object_id = ${objectId}
  `) as unknown as readonly { readonly version_number: number }[];
  return rows[0]?.version_number ?? 1;
}

async function insertSheetSnapshotVersion(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly sheetId: string;
    readonly versionNumber: number;
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string | null;
    readonly metadata: JsonObject;
  },
): Promise<void> {
  if (input.sha256 === null) {
    return;
  }
  await sql`
    insert into drive_versions (
      org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id
    )
    values (
      ${input.orgId},
      ${input.sheetId},
      ${input.versionNumber},
      ${input.storageKey},
      'application/vnd.helix.spreadsheet+json',
      ${input.byteSize},
      ${input.sha256},
      ${sql.json(toSqlJson(input.metadata))},
      ${input.actorId}
    )
  `;
}

function sheetSnapshotVersionStorageKey(
  orgId: string,
  sheetId: string,
  versionNumber: number,
): string {
  return `sheets/${orgId}/${sheetId}/versions/${String(versionNumber)}`;
}

async function selectSheetById(
  sql: SqlLike,
  orgId: string,
  sheetId: string,
): Promise<SheetRecord | null> {
  const rows = (await sql`
    select *
    from sheets
    where id = ${sheetId}
      and org_id = ${orgId}
      and deleted_at is null
    limit 1
  `) as unknown as readonly SheetRow[];
  return rows[0] === undefined ? null : mapSheet(rows[0]);
}

async function selectVisibleSheet(
  sql: SqlLike,
  input: SheetRef | UpdateSheetInput,
): Promise<SheetRecord | null> {
  const rows = (await sql`
    select *
    from sheets
    where id = ${input.sheetId}
      and org_id = ${input.orgId}
      and deleted_at is null
      and (owner_actor_id = ${input.actorId} or created_by_actor_id = ${input.actorId})
    limit 1
  `) as unknown as readonly SheetRow[];
  return rows[0] === undefined ? null : mapSheet(rows[0]);
}

async function selectVisibleSheetForUpdate(
  sql: SqlLike,
  input: SheetRef,
): Promise<SheetRecord | null> {
  const rows = (await sql`
    select *
    from sheets
    where id = ${input.sheetId}
      and org_id = ${input.orgId}
      and deleted_at is null
      and (owner_actor_id = ${input.actorId} or created_by_actor_id = ${input.actorId})
    for update
  `) as unknown as readonly SheetRow[];
  return rows[0] === undefined ? null : mapSheet(rows[0]);
}

async function selectVisibleTab(
  sql: SqlLike,
  input: { orgId: string; actorId: string; tabId: string },
): Promise<SheetTabRecord | null> {
  const rows = (await sql`
    select t.*
    from sheet_tabs t
    join sheets s on s.id = t.sheet_id and s.org_id = t.org_id
    where t.id = ${input.tabId}
      and t.org_id = ${input.orgId}
      and t.deleted_at is null
      and s.deleted_at is null
      and (s.owner_actor_id = ${input.actorId} or s.created_by_actor_id = ${input.actorId})
    limit 1
  `) as unknown as readonly SheetTabRow[];
  return rows[0] === undefined ? null : mapTab(rows[0]);
}

async function selectTabs(
  sql: SqlLike,
  orgId: string,
  sheetId: string,
): Promise<readonly SheetTabRecord[]> {
  const rows = (await sql`
    select *
    from sheet_tabs
    where org_id = ${orgId} and sheet_id = ${sheetId} and deleted_at is null
    order by position asc, created_at asc
  `) as unknown as readonly SheetTabRow[];
  return rows.map(mapTab);
}

async function selectCells(
  sql: SqlLike,
  tabId: string,
  window?: SheetCellWindow,
): Promise<readonly SheetCellRecord[]> {
  if (window !== undefined) {
    const normalized = normalizeSheetRange(window);
    const rows = (await sql`
      select *
      from sheet_cells
      where sheet_tab_id = ${tabId}
        and row >= ${normalized.top}
        and row <= ${normalized.bottom}
        and col >= ${normalized.left}
        and col <= ${normalized.right}
      order by row asc, col asc
    `) as unknown as readonly SheetCellRow[];
    return rows.map(mapCell);
  }
  const rows = (await sql`
    select *
    from sheet_cells
    where sheet_tab_id = ${tabId}
    order by row asc, col asc
  `) as unknown as readonly SheetCellRow[];
  return rows.map(mapCell);
}

async function selectCellsForSheet(
  sql: SqlLike,
  orgId: string,
  sheetId: string,
): Promise<readonly SheetCellRecord[]> {
  const rows = (await sql`
    select c.*
    from sheet_cells c
    join sheet_tabs t on t.id = c.sheet_tab_id and t.org_id = c.org_id
    where t.org_id = ${orgId}
      and t.sheet_id = ${sheetId}
      and t.deleted_at is null
    order by t.position asc, c.row asc, c.col asc
  `) as unknown as readonly SheetCellRow[];
  return rows.map(mapCell);
}

async function rebaseSheetCommentAnchorsForOperation(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly sheetId: string;
    readonly tabId: string;
    readonly operation: SheetOperation;
    readonly now: Date;
  },
): Promise<void> {
  const rows = (await sql`
    select *
    from drive_comments
    where org_id = ${input.orgId}
      and object_id = ${input.sheetId}
    for update
  `) as unknown as readonly SheetCommentRow[];
  for (const row of rows) {
    const rebased = rebaseSheetCommentAnchorForOperation(row.anchor, input.tabId, input.operation);
    if (!rebased.changed) {
      continue;
    }
    await sql`
      update drive_comments
      set anchor = ${sql.json(toSqlJson(rebased.anchor))}, updated_at = ${input.now}
      where id = ${row.id} and org_id = ${input.orgId}
    `;
  }
}

/** Loads a comment together with the spreadsheet it anchors to, both actor-visible. */
async function selectVisibleSheetComment(
  sql: SqlLike,
  input: ResolveSheetCommentInput,
): Promise<{ readonly comment: SheetCommentRow; readonly sheet: SheetRecord } | null> {
  const rows = (await sql`
    select *
    from drive_comments
    where id = ${input.commentId}
      and org_id = ${input.orgId}
    limit 1
  `) as unknown as readonly SheetCommentRow[];
  const comment = rows[0];
  if (comment === undefined) {
    return null;
  }
  const sheet = await selectVisibleSheet(sql, {
    orgId: input.orgId,
    actorId: input.actorId,
    sheetId: comment.object_id,
  });
  return sheet === null ? null : { comment, sheet };
}

async function requireSheetCommentParent(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly sheetId: string;
    readonly parentCommentId: string;
  },
): Promise<void> {
  const rows = (await sql`
    select id
    from drive_comments
    where id = ${input.parentCommentId}
      and org_id = ${input.orgId}
      and object_id = ${input.sheetId}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
    throw new SheetsValidationError("Comment parent must belong to the same spreadsheet.");
  }
}

function validatedSheetCommentAnchor(
  anchor: JsonObject | undefined,
  sheet: SheetRecord,
  tabs: readonly SheetTabRecord[],
): JsonObject {
  const candidate = anchor ?? {};
  if (candidate["type"] !== "sheet-range") {
    return candidate;
  }
  const sheetId = candidate["sheetId"];
  if (sheetId !== undefined && sheetId !== sheet.id) {
    throw new SheetsValidationError("Sheet comment anchor must reference the target spreadsheet.");
  }
  const tabId = candidate["tabId"];
  if (typeof tabId !== "string" || !tabs.some((tab) => tab.id === tabId)) {
    throw new SheetsValidationError(
      "Sheet comment anchor must reference a tab in the spreadsheet.",
    );
  }
  const range = candidate["range"];
  if (typeof range !== "object" || range === null || Array.isArray(range)) {
    throw new SheetsValidationError("Sheet comment anchor range is required.");
  }
  const record = range as Record<string, unknown>;
  const startRow = validatedSheetCommentAnchorCoordinate(record["startRow"], "startRow");
  const startCol = validatedSheetCommentAnchorCoordinate(record["startCol"], "startCol");
  const endRow = validatedSheetCommentAnchorCoordinate(record["endRow"], "endRow");
  const endCol = validatedSheetCommentAnchorCoordinate(record["endCol"], "endCol");
  return {
    ...candidate,
    tabId,
    range: {
      startRow: Math.min(startRow, endRow),
      startCol: Math.min(startCol, endCol),
      endRow: Math.max(startRow, endRow),
      endCol: Math.max(startCol, endCol),
    },
  };
}

function validatedSheetCommentAnchorCoordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SheetsValidationError(`Sheet comment anchor ${name} must be a non-negative integer.`);
  }
  return value;
}

/** Upserts each edit into `sheet_cells`, deleting the row when it clears the cell. */
async function writeSheetCellEdits(
  sql: SqlLike,
  orgId: string,
  tabId: string,
  edits: readonly SheetCellEdit[],
): Promise<void> {
  for (const edit of edits) {
    if (isClearingEdit(edit)) {
      await sql`
        delete from sheet_cells
        where sheet_tab_id = ${tabId} and row = ${edit.row} and col = ${edit.col}
      `;
      continue;
    }
    await sql`
      insert into sheet_cells (org_id, sheet_tab_id, row, col, value, format)
      values (
        ${orgId}, ${tabId}, ${edit.row}, ${edit.col}, ${edit.value},
        ${sql.json(toSqlJson(edit.format ?? {}))}
      )
      on conflict (sheet_tab_id, row, col) do update set
        value = excluded.value,
        format = case
          when ${edit.format === undefined} then sheet_cells.format
          else excluded.format
        end,
        updated_at = now()
    `;
  }
}

async function touchSheet(sql: SqlLike, orgId: string, sheetId: string): Promise<void> {
  await sql`
    update sheets set updated_at = now()
    where id = ${sheetId} and org_id = ${orgId} and deleted_at is null
  `;
}

/**
 * Append a hash-chained {@link activity} row and an {@link outbox} event for a
 * Sheets mutation, matching the Docs domain's audit pattern.
 */
async function appendSheetsActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  const previousRows = (await sql`
    select this_hash from activity
    where org_id = ${input.orgId}
    order by created_at desc
    limit 1
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const thisHash = activityChainHash({
    prevHash,
    verb: input.verb,
    objectId: input.objectId,
    timestamp: Date.now(),
  });
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (
      ${input.orgId}, ${input.actorId}, ${input.verb}, 'sheet', ${input.objectId},
      ${sql.json(toSqlJson(input.payload))}, ${prevHash}, ${thisHash}
    )
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${input.verb}`}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId,
        sheetId: input.objectId,
        ...input.payload,
      }),
    )})
  `;
}

async function notifySheetCommentMentions(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly sheet: SheetRecord;
    readonly commentId: string;
    readonly parentCommentId: string | null;
    readonly anchor: JsonObject;
    readonly body: string;
    readonly metadata: JsonObject;
  },
): Promise<void> {
  const tokens = mentionTokensForComment(input.metadata, input.body);
  if (tokens.length === 0) {
    return;
  }
  const actorRows = (await sql`
    select id, display_name, email
    from actors
    where org_id = ${input.orgId}
      and disabled_at is null
      and type = 'user'
      and (
        id = ${input.sheet.ownerActorId}
        or id = ${input.sheet.createdByActorId}
        or exists (
          select 1 from permissions p
          where p.org_id = ${input.orgId}
            and p.actor_id = actors.id
            and p.resource_type = 'object'
            and p.resource_id = ${input.sheet.id}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
  `) as unknown as readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  const recipients = mentionedActorIds({
    actors: actorRows,
    authorActorId: input.actorId,
    tokens,
  });
  if (recipients.length === 0) {
    return;
  }
  const authorName =
    actorRows.find((actor) => actor.id === input.actorId)?.display_name ?? "Someone";
  for (const recipientId of recipients) {
    await insertNotification(sql, {
      orgId: input.orgId,
      actorId: recipientId,
      verb: "sheets.comment.mention",
      objectType: "sheet",
      objectId: input.sheet.id,
      summary: `${authorName} mentioned you in "${input.sheet.title}".`,
      body: input.body,
      payload: {
        sheetId: input.sheet.id,
        commentId: input.commentId,
        ...(input.parentCommentId === null ? {} : { parentCommentId: input.parentCommentId }),
        anchor: input.anchor,
        mentionedByActorId: input.actorId,
        mentionsText: tokens,
      },
    });
  }
}

function mentionTokensForComment(metadata: JsonObject, body: string): readonly string[] {
  const tokens = new Set<string>();
  for (const token of mentionTokensFromMetadata(metadata)) {
    tokens.add(token);
  }
  for (const token of mentionTokensFromText(body)) {
    tokens.add(token);
  }
  return [...tokens];
}

function mentionTokensFromMetadata(metadata: JsonObject): readonly string[] {
  const mentionsText = metadata.mentionsText;
  if (!Array.isArray(mentionsText)) {
    return [];
  }
  const tokens = new Set<string>();
  for (const value of mentionsText) {
    if (typeof value !== "string") {
      continue;
    }
    const token = normalizeMentionToken(value);
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function mentionTokensFromText(value: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/(^|\s)@([\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?)/gu)) {
    const token = normalizeMentionToken(match[2] ?? "");
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function mentionedActorIds(input: {
  readonly actors: readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  readonly authorActorId: string;
  readonly tokens: readonly string[];
}): readonly string[] {
  const tokenSet = new Set(input.tokens.map(normalizeMentionToken));
  const ids: string[] = [];
  for (const actor of input.actors) {
    if (actor.id === input.authorActorId) {
      continue;
    }
    const aliases = actorMentionAliases(actor);
    if ([...tokenSet].some((token) => aliases.has(token))) {
      ids.push(actor.id);
    }
  }
  return ids;
}

function actorMentionAliases(actor: {
  readonly display_name: string;
  readonly email: string | null;
}): ReadonlySet<string> {
  const aliases = new Set<string>();
  const email = actor.email?.trim().toLowerCase();
  if (email !== undefined && email.length > 0) {
    aliases.add(email);
    aliases.add(email.split("@")[0] ?? email);
  }
  const displayName = actor.display_name.trim().toLowerCase();
  if (displayName.length > 0) {
    aliases.add(displayName);
    aliases.add(displayName.replace(/[^a-z0-9]+/gu, ""));
    const firstName = displayName.split(/\s+/u)[0];
    if (firstName !== undefined) {
      aliases.add(firstName);
    }
  }
  return aliases;
}

function normalizeMentionToken(value: string): string {
  return value.trim().replace(/^@/u, "").toLowerCase();
}

async function writeSheetStorageSnapshot(input: {
  readonly resolver?: SheetSnapshotStorageResolver | undefined;
  readonly orgId: string;
  readonly key: string;
  readonly sheet: SheetRecord;
  readonly tabs: readonly SheetTabRecord[];
  readonly cells?: readonly SheetCellRecord[] | undefined;
}): Promise<{ readonly byteSize: number; readonly sha256: string | null }> {
  if (input.resolver === undefined) {
    return { byteSize: 0, sha256: null };
  }
  const body = encodeSnapshot({
    app: "sheets",
    version: 1,
    sheet: {
      id: input.sheet.id,
      orgId: input.sheet.orgId,
      title: input.sheet.title,
      metadata: input.sheet.metadata,
    },
    tabs: input.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      position: tab.position,
      metadata: tab.metadata,
    })),
    cells: (input.cells ?? []).map((cell) => ({
      tabId: cell.sheetTabId,
      row: cell.row,
      col: cell.col,
      value: cell.value,
      formula: cell.formula,
      calcValue: cell.calcValue,
      dependencies: cell.dependencies,
      formulaError: cell.formulaError,
      format: cell.format,
    })),
  });
  const storage = await input.resolver({ orgId: input.orgId });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for sheet snapshot.");
  }
  await storage.client.put({
    key: input.key,
    body,
    contentType: "application/vnd.helix.spreadsheet+json",
  });
  return { byteSize: body.byteLength, sha256: sha256Hex(body) };
}

function mapSheet(row: SheetRow | undefined): SheetRecord {
  if (row === undefined) {
    throw new Error("Expected sheet row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id,
    createdByActorId: row.created_by_actor_id,
    title: row.title,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTab(row: SheetTabRow | undefined): SheetTabRecord {
  if (row === undefined) {
    throw new Error("Expected sheet tab row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    sheetId: row.sheet_id,
    name: row.name,
    position: row.position,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCell(row: SheetCellRow | undefined): SheetCellRecord {
  if (row === undefined) {
    throw new Error("Expected sheet cell row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    sheetTabId: row.sheet_tab_id,
    row: row.row,
    col: row.col,
    value: row.value,
    formula: row.formula,
    calcValue: row.calc_value,
    dependencies: row.dependencies,
    formulaError: row.formula_error,
    format: row.format,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSheetVersion(row: SheetVersionRow | undefined): SheetVersionRecord {
  if (row === undefined) {
    throw new Error("Expected sheet version row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    sheetId: row.object_id,
    versionNumber: row.version_number,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
  };
}

function mapSheetComment(row: SheetCommentRow | undefined): SheetCommentRecord {
  if (row === undefined) {
    throw new Error("Expected sheet comment row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    sheetId: row.object_id,
    parentCommentId: row.parent_comment_id,
    actorId: row.actor_id,
    anchor: row.anchor,
    body: row.body,
    status: row.status,
    metadata: row.metadata,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSheetCommentListItem(row: SheetCommentProjectionRow): SheetCommentListItem {
  const comment = mapSheetComment(row);
  return {
    ...comment,
    ...(row.actor_id === null
      ? {}
      : {
          author: {
            id: row.actor_id,
            ...(row.actor_display_name === null ? {} : { displayName: row.actor_display_name }),
            ...(row.actor_email === null ? {} : { email: row.actor_email }),
          },
        }),
  };
}

function mapSheetOperationLog(row: SheetOperationLogRow | undefined): SheetOperationLogRecord {
  if (row === undefined) {
    throw new Error("Expected sheet operation log row.");
  }
  return {
    orgId: row.org_id,
    sheetId: row.sheet_id,
    tabId: row.sheet_tab_id,
    actorId: row.actor_id,
    operationId: row.operation_id,
    revision: row.revision,
    baseRevision: row.base_revision,
    operation: parseSheetOperation(row.operation),
    createdAt: row.created_at,
  };
}

async function refreshFormulaMetadata(
  sql: SqlLike,
  orgId: string,
  sheetId: string,
  tabId: string,
  sheetMetadata: JsonObject,
): Promise<SheetCellRecord[]> {
  const tabs = await selectTabs(sql, orgId, sheetId);
  const cells = await selectCellsForSheet(sql, orgId, sheetId);
  const evaluations = evaluateSheetFormulas(cells, {
    currentTabId: tabId,
    tabs,
    namedRanges: namedFormulaRangesFromMetadata(sheetMetadata),
  });
  const cellsWithMetadata = cells.map((cell) => {
    const evaluation = evaluations.get(formulaCellKey(cell.sheetTabId, cell.row, cell.col));
    return {
      ...cell,
      formula: evaluation?.formula ?? null,
      calcValue: evaluation?.calcValue ?? cell.value,
      dependencies: evaluation?.dependencies ?? [],
      formulaError: evaluation?.error ?? null,
    };
  });
  for (const cell of cellsWithMetadata) {
    await sql`
      update sheet_cells
      set
        formula = ${cell.formula},
        calc_value = ${cell.calcValue},
        dependencies = ${sql.json(toSqlJson(cell.dependencies))},
        formula_error = ${cell.formulaError}
      where id = ${cell.id}
    `;
  }
  return cellsWithMetadata.filter((cell) => cell.sheetTabId === tabId);
}

function formulaCellKey(tabId: string, row: number, col: number): string {
  return `${tabId}:${String(row)}:${String(col)}`;
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function jsonStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function replaceStringsInJsonObject(
  value: JsonObject,
  replace: (value: string) => string,
): JsonObject {
  return replaceStringsInJson(value, replace) as JsonObject;
}

function replaceStringsInJson(value: unknown, replace: (value: string) => string): unknown {
  if (typeof value === "string") {
    return replace(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringsInJson(item, replace));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceStringsInJson(item, replace)]),
    );
  }
  return value;
}

function encodeSnapshot(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

interface SheetSnapshotV1 {
  readonly app: "sheets";
  readonly version: 1;
  readonly sheet: {
    readonly id: string;
    readonly title: string;
    readonly metadata: JsonObject;
  };
  readonly tabs: readonly {
    readonly id: string;
    readonly name: string;
    readonly position: number;
    readonly metadata: JsonObject;
  }[];
  readonly cells: readonly {
    readonly tabId: string;
    readonly row: number;
    readonly col: number;
    readonly value: string;
    readonly formula: string | null;
    readonly calcValue: string | null;
    readonly dependencies: readonly string[];
    readonly formulaError: string | null;
    readonly format: JsonObject;
  }[];
}

async function readSheetSnapshotVersion(
  resolver: SheetSnapshotStorageResolver | undefined,
  input: { readonly orgId: string; readonly storageKey: string; readonly sheetId: string },
): Promise<SheetSnapshotV1> {
  const storage = await resolver?.({ orgId: input.orgId });
  if (storage?.client.get === undefined) {
    throw new Error("Sheet version restore requires readable tenant storage.");
  }
  const object = await storage.client.get(input.storageKey);
  if (object === null) {
    throw new Error(`Sheet version snapshot not found: ${input.storageKey}`);
  }
  const snapshot = parseSheetSnapshot(
    new TextDecoder().decode(await storageObjectBody(object.body)),
  );
  if (snapshot.sheet.id !== input.sheetId) {
    throw new Error("Sheet version snapshot does not belong to the requested spreadsheet.");
  }
  return snapshot;
}

function parseSheetSnapshot(body: string): SheetSnapshotV1 {
  const parsed: unknown = JSON.parse(body);
  if (!isPlainRecord(parsed) || parsed["app"] !== "sheets" || parsed["version"] !== 1) {
    throw new Error("Invalid sheet version snapshot.");
  }
  const sheet = parsed["sheet"];
  const tabs = parsed["tabs"];
  const cells = parsed["cells"];
  if (!isPlainRecord(sheet) || !Array.isArray(tabs) || !Array.isArray(cells)) {
    throw new Error("Invalid sheet version snapshot.");
  }
  const parsedTabs = tabs.map(parseSnapshotTab);
  const tabIds = new Set(parsedTabs.map((tab) => tab.id));
  const parsedCells = cells.map((cell) => parseSnapshotCell(cell, tabIds));
  return {
    app: "sheets",
    version: 1,
    sheet: {
      id: readSnapshotString(sheet["id"], "sheet.id"),
      title: assertTitle(readSnapshotString(sheet["title"], "sheet.title")),
      metadata: readSnapshotObject(sheet["metadata"]),
    },
    tabs: parsedTabs,
    cells: parsedCells,
  };
}

function parseSnapshotTab(value: unknown): SheetSnapshotV1["tabs"][number] {
  if (!isPlainRecord(value)) {
    throw new Error("Invalid sheet tab in version snapshot.");
  }
  return {
    id: readSnapshotString(value["id"], "tab.id"),
    name: assertTabName(readSnapshotString(value["name"], "tab.name")),
    position: readSnapshotInteger(value["position"], "tab.position"),
    metadata: readSnapshotObject(value["metadata"]),
  };
}

function parseSnapshotCell(
  value: unknown,
  tabIds: ReadonlySet<string>,
): SheetSnapshotV1["cells"][number] {
  if (!isPlainRecord(value)) {
    throw new Error("Invalid sheet cell in version snapshot.");
  }
  const tabId = readSnapshotString(value["tabId"], "cell.tabId");
  if (!tabIds.has(tabId)) {
    throw new Error("Sheet version snapshot cell references an unknown tab.");
  }
  const dependencies = value["dependencies"];
  return {
    tabId,
    row: readSnapshotInteger(value["row"], "cell.row"),
    col: readSnapshotInteger(value["col"], "cell.col"),
    value: readSnapshotString(value["value"], "cell.value"),
    formula: readSnapshotNullableString(value["formula"], "cell.formula"),
    calcValue: readSnapshotNullableString(value["calcValue"], "cell.calcValue"),
    dependencies: Array.isArray(dependencies)
      ? dependencies.map((entry) => readSnapshotString(entry, "cell.dependencies"))
      : [],
    formulaError: readSnapshotNullableString(value["formulaError"], "cell.formulaError"),
    format: readSnapshotObject(value["format"]),
  };
}

function readSnapshotString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid sheet version snapshot field: ${field}.`);
  }
  return value;
}

function readSnapshotNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readSnapshotString(value, field);
}

function readSnapshotInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid sheet version snapshot field: ${field}.`);
  }
  return value as number;
}

function readSnapshotObject(value: unknown): JsonObject {
  return isPlainRecord(value) ? (JSON.parse(JSON.stringify(value)) as JsonObject) : {};
}

async function storageObjectBody(
  body: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeSheetPreviewMetadata(
  sheet: SheetRecord,
  tabs: readonly SheetTabRecord[],
  cells: readonly SheetCellRecord[],
): JsonObject {
  return {
    kind: "text",
    status: "available",
    mimeType: "application/vnd.helix.spreadsheet",
    text: nativeSheetPreviewText(sheet, tabs, cells),
  };
}

function nativeSheetPreviewText(
  sheet: SheetRecord,
  tabs: readonly SheetTabRecord[],
  cells: readonly SheetCellRecord[],
): string {
  const firstTab = [...tabs].sort((left, right) => left.position - right.position)[0];
  if (firstTab === undefined) {
    return sheet.title;
  }
  const tabCells = cells
    .filter((cell) => cell.sheetTabId === firstTab.id)
    .sort((left, right) => left.row - right.row || left.col - right.col);
  if (tabCells.length === 0) {
    return `${sheet.title}\n${firstTab.name}`.slice(0, 2000);
  }
  const maxRow = Math.min(8, Math.max(...tabCells.map((cell) => cell.row)));
  const maxCol = Math.min(5, Math.max(...tabCells.map((cell) => cell.col)));
  const grid = Array.from({ length: maxRow + 1 }, () =>
    Array.from({ length: maxCol + 1 }, () => ""),
  );
  for (const cell of tabCells) {
    if (cell.row <= maxRow && cell.col <= maxCol) {
      const row = grid[cell.row];
      if (row !== undefined) {
        row[cell.col] = (cell.calcValue ?? cell.value).replace(/\s+/gu, " ").trim();
      }
    }
  }
  return grid
    .map((row) => row.join("\t").trimEnd())
    .join("\n")
    .slice(0, 2000);
}
