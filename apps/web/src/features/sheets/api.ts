/* Sheets API client — wraps the backend Sheets tools (`POST /api/tools/<id>`).

   Every call rides the Better-Auth session cookie via `authenticatedFetch`.
   The `fetchImpl` parameter is injected only by tests. */

import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type SheetsApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type SheetsCommentStatus = "open" | "resolved" | "all";

export interface SheetsCellWindow {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

/** A spreadsheet row as returned by `sheets.list` / `sheets.get`. */
export interface SheetsApiSheet {
  readonly id: string;
  readonly orgId?: string;
  readonly ownerActorId: string | null;
  readonly createdByActorId: string | null;
  readonly title: string;
  readonly metadata: Record<string, unknown>;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A named tab inside a spreadsheet. */
export interface SheetsApiTab {
  readonly id: string;
  readonly orgId?: string;
  readonly sheetId: string;
  readonly name: string;
  readonly position: number;
  readonly metadata: Record<string, unknown>;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A single sparsely-stored cell, addressed by zero-based row/col. */
export interface SheetsApiCell {
  readonly id: string;
  readonly orgId?: string;
  readonly sheetTabId: string;
  readonly row: number;
  readonly col: number;
  readonly value: string;
  readonly formula?: string | null;
  readonly calcValue?: string | null;
  readonly dependencies?: readonly string[];
  readonly formulaError?: string | null;
  readonly format: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A spreadsheet plus its tabs (`sheets.get`, `sheets.create`, `sheets.update`). */
export interface SheetsApiSheetWithTabs extends SheetsApiSheet {
  readonly tabs: readonly SheetsApiTab[];
}

/** A tab plus its populated cells (`sheets.tab.get`, `sheets.cells.update`). */
export interface SheetsApiTabWithCells extends SheetsApiTab {
  readonly cells: readonly SheetsApiCell[];
}

export interface SheetsDriveComment {
  readonly id: string;
  readonly sheetId: string;
  readonly objectId?: string;
  readonly parentCommentId?: string | null;
  readonly actorId: string | null;
  readonly anchor: Record<string, unknown>;
  readonly body: string;
  readonly status: SheetsCommentStatus;
  readonly metadata: Record<string, unknown>;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly author?: {
    readonly id: string;
    readonly displayName?: string;
    readonly email?: string;
  };
}

/** Paginated result envelope from `sheets.list`. */
export interface SheetsListResult {
  readonly sheets: readonly SheetsApiSheet[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface SheetsImportCsvResult extends SheetsApiSheetWithTabs {
  readonly import: {
    readonly format: "csv";
    readonly filename: string;
    readonly rowCount: number;
    readonly columnCount: number;
    readonly populatedCellCount: number;
  };
}

export interface SheetsImportTsvResult extends SheetsApiSheetWithTabs {
  readonly import: {
    readonly format: "tsv";
    readonly filename: string;
    readonly rowCount: number;
    readonly columnCount: number;
    readonly populatedCellCount: number;
  };
}

export interface SheetsImportXlsxResult extends SheetsApiSheetWithTabs {
  readonly import: {
    readonly format: "xlsx";
    readonly filename: string;
    readonly sheetCount: number;
    readonly rowCount: number;
    readonly columnCount: number;
    readonly populatedCellCount: number;
  };
}

export interface SheetsImportOdsResult extends SheetsApiSheetWithTabs {
  readonly import: {
    readonly format: "ods";
    readonly filename: string;
    readonly sheetCount: number;
    readonly rowCount: number;
    readonly columnCount: number;
    readonly populatedCellCount: number;
  };
}

export interface SheetsExportResult {
  readonly sheetId: string;
  readonly format: "csv" | "tsv" | "xlsx" | "ods";
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentBase64: string;
  readonly metadata: Record<string, unknown>;
}

export interface SheetsVersion {
  readonly id: string;
  readonly orgId?: string;
  readonly sheetId: string;
  readonly versionNumber: number;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId: string | null;
  readonly createdAt: string;
}

/** A single cell mutation in a `sheets.cells.update` batch. */
export interface SheetsCellEdit {
  readonly row: number;
  readonly col: number;
  /** Empty string clears the cell (kept sparse). */
  readonly value: string;
  readonly format?: Record<string, unknown>;
}

export interface SheetsListInput {
  readonly query?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** List spreadsheets visible to the current actor (paginated). */
export async function listSheets(
  input: SheetsListInput = {},
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsListResult> {
  const output = await callSheetsTool<Partial<SheetsListResult>>(
    "sheets.list",
    {
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    },
    fetchImpl,
  );
  return {
    sheets: output.sheets ?? [],
    total: output.total ?? output.sheets?.length ?? 0,
    limit: output.limit ?? input.limit ?? 50,
    offset: output.offset ?? input.offset ?? 0,
  };
}

/** Get a spreadsheet and its tabs. */
export async function getSheet(
  input: { readonly sheetId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiSheetWithTabs> {
  return callSheetsTool<SheetsApiSheetWithTabs>(
    "sheets.get",
    { sheetId: input.sheetId },
    fetchImpl,
  );
}

/** Create a spreadsheet with one or more tabs. */
export async function createSheet(
  input: {
    readonly title: string;
    readonly tabNames?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiSheetWithTabs> {
  return callSheetsTool<SheetsApiSheetWithTabs>(
    "sheets.create",
    {
      title: input.title,
      ...(input.tabNames === undefined ? {} : { tabNames: input.tabNames }),
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** Copy a native spreadsheet without losing tabs, cells, or formatting. */
export async function copySheet(
  input: {
    readonly sheetId: string;
    readonly title?: string;
    readonly folderId?: string | null;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiSheetWithTabs> {
  return callSheetsTool<SheetsApiSheetWithTabs>(
    "sheets.copy",
    {
      sheetId: input.sheetId,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** Import CSV text into a native spreadsheet. */
export async function importCsvSheet(
  input: {
    readonly filename: string;
    readonly title?: string;
    readonly folderId?: string | null;
    readonly csvText: string;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsImportCsvResult> {
  return callSheetsTool<SheetsImportCsvResult>(
    "sheets.import-csv",
    {
      filename: input.filename,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      csvText: input.csvText,
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** Import TSV text into a native spreadsheet. */
export async function importTsvSheet(
  input: {
    readonly filename: string;
    readonly title?: string;
    readonly folderId?: string | null;
    readonly tsvText: string;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsImportTsvResult> {
  return callSheetsTool<SheetsImportTsvResult>(
    "sheets.import-tsv",
    {
      filename: input.filename,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      tsvText: input.tsvText,
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** Import XLSX bytes into a native spreadsheet. */
export async function importXlsxSheet(
  input: {
    readonly filename: string;
    readonly title?: string;
    readonly folderId?: string | null;
    readonly contentBase64: string;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsImportXlsxResult> {
  return callSheetsTool<SheetsImportXlsxResult>(
    "sheets.import-xlsx",
    {
      filename: input.filename,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      contentBase64: input.contentBase64,
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** Import ODS bytes into a native spreadsheet. */
export async function importOdsSheet(
  input: {
    readonly filename: string;
    readonly title?: string;
    readonly folderId?: string | null;
    readonly contentBase64: string;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsImportOdsResult> {
  return callSheetsTool<SheetsImportOdsResult>(
    "sheets.import-ods",
    {
      filename: input.filename,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      contentBase64: input.contentBase64,
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** Export a native spreadsheet as CSV, TSV, XLSX, or ODS bytes. */
export async function exportSheet(
  input: {
    readonly sheetId: string;
    readonly format: "csv" | "tsv" | "xlsx" | "ods";
    readonly tabId?: string;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsExportResult> {
  return callSheetsTool<SheetsExportResult>(
    "sheets.export",
    {
      sheetId: input.sheetId,
      format: input.format,
      ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
    },
    fetchImpl,
  );
}

/** List saved snapshot versions for a native spreadsheet. */
export async function listSheetVersions(
  input: { readonly sheetId: string; readonly limit?: number },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<readonly SheetsVersion[]> {
  const output = await callSheetsTool<{ readonly versions?: readonly SheetsVersion[] }>(
    "sheets.version.list",
    {
      sheetId: input.sheetId,
      limit: input.limit ?? 25,
    },
    fetchImpl,
  );
  return output.versions ?? [];
}

/** Restore a native spreadsheet from a saved snapshot version. */
export async function restoreSheetVersion(
  input: { readonly sheetId: string; readonly versionId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiSheetWithTabs> {
  return callSheetsTool<SheetsApiSheetWithTabs>(
    "sheets.version.restore",
    {
      sheetId: input.sheetId,
      versionId: input.versionId,
    },
    fetchImpl,
  );
}

/** Update a spreadsheet's title or metadata. */
export async function updateSheet(
  input: {
    readonly sheetId: string;
    readonly title?: string;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiSheetWithTabs> {
  return callSheetsTool<SheetsApiSheetWithTabs>(
    "sheets.update",
    {
      sheetId: input.sheetId,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
    fetchImpl,
  );
}

/** Soft-delete a spreadsheet. */
export async function deleteSheet(
  input: { readonly sheetId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<{ readonly sheetId: string; readonly deletedAt: string | null }> {
  return callSheetsTool<{ sheetId: string; deletedAt: string | null }>(
    "sheets.delete",
    { sheetId: input.sheetId },
    fetchImpl,
  );
}

/** Create a tab in a spreadsheet. */
export async function createSheetTab(
  input: {
    readonly sheetId: string;
    readonly name: string;
    readonly position?: number;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiTab> {
  return callSheetsTool<SheetsApiTab>(
    "sheets.tab.create",
    {
      sheetId: input.sheetId,
      name: input.name,
      ...(input.position === undefined ? {} : { position: input.position }),
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** Rename, reorder, or re-tag a tab. */
export async function updateSheetTab(
  input: {
    readonly tabId: string;
    readonly name?: string;
    readonly position?: number;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiTab> {
  return callSheetsTool<SheetsApiTab>(
    "sheets.tab.update",
    {
      tabId: input.tabId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
    fetchImpl,
  );
}

/** Delete a tab and its cells. */
export async function deleteSheetTab(
  input: { readonly tabId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<{ readonly tabId: string; readonly deletedAt: string | null }> {
  return callSheetsTool<{ tabId: string; deletedAt: string | null }>(
    "sheets.tab.delete",
    { tabId: input.tabId },
    fetchImpl,
  );
}

/** Get a tab and its populated cells. */
export async function getSheetTab(
  input: { readonly tabId: string; readonly window?: SheetsCellWindow },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiTabWithCells> {
  return callSheetsTool<SheetsApiTabWithCells>(
    "sheets.tab.get",
    {
      tabId: input.tabId,
      ...(input.window === undefined ? {} : { window: input.window }),
    },
    fetchImpl,
  );
}

/** Apply a batch of cell edits to a tab. Empty values clear cells. */
export async function updateSheetCells(
  input: {
    readonly tabId: string;
    readonly edits: readonly SheetsCellEdit[];
    readonly window?: SheetsCellWindow;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiTabWithCells> {
  return callSheetsTool<SheetsApiTabWithCells>(
    "sheets.cells.update",
    {
      tabId: input.tabId,
      edits: input.edits.map((edit) => ({
        row: edit.row,
        col: edit.col,
        value: edit.value,
        ...(edit.format === undefined ? {} : { format: edit.format }),
      })),
      ...(input.window === undefined ? {} : { window: input.window }),
    },
    fetchImpl,
  );
}

/** Sort a rectangular range by its first column. */
export async function sortSheetRange(
  input: {
    readonly tabId: string;
    readonly range: {
      readonly startRow: number;
      readonly startCol: number;
      readonly endRow: number;
      readonly endCol: number;
    };
    readonly direction: "asc" | "desc";
    readonly window?: SheetsCellWindow;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiTabWithCells> {
  return callSheetsTool<SheetsApiTabWithCells>("sheets.range.sort", input, fetchImpl);
}

export async function listSheetComments(
  input: { readonly sheetId: string; readonly status?: SheetsCommentStatus },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<readonly SheetsDriveComment[]> {
  const output = await callSheetsTool<{ readonly comments?: readonly SheetsDriveComment[] }>(
    "sheets.comment.list",
    {
      sheetId: input.sheetId,
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    fetchImpl,
  );
  return output.comments ?? [];
}

export async function createSheetComment(
  input: {
    readonly sheetId: string;
    readonly body: string;
    readonly anchor: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
    readonly parentCommentId?: string;
  },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsDriveComment> {
  return callSheetsTool<SheetsDriveComment>(
    "sheets.comment.create",
    {
      sheetId: input.sheetId,
      body: input.body,
      anchor: input.anchor,
      metadata: input.metadata ?? {},
      ...(input.parentCommentId === undefined ? {} : { parentCommentId: input.parentCommentId }),
    },
    fetchImpl,
  );
}

export async function resolveSheetComment(
  input: { readonly commentId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsDriveComment> {
  return callSheetsTool<SheetsDriveComment>("sheets.comment.resolve", input, fetchImpl);
}

export async function reopenSheetComment(
  input: { readonly commentId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsDriveComment> {
  return callSheetsTool<SheetsDriveComment>("sheets.comment.reopen", input, fetchImpl);
}

export async function updateSheetComment(
  input: { readonly commentId: string; readonly body: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsDriveComment> {
  return callSheetsTool<SheetsDriveComment>("sheets.comment.update", input, fetchImpl);
}

export async function deleteSheetComment(
  input: { readonly commentId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsDriveComment> {
  return callSheetsTool<SheetsDriveComment>("sheets.comment.delete", input, fetchImpl);
}

async function callSheetsTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: SheetsApiFetch,
): Promise<Output> {
  // Auto-approves pending_confirmation (e.g. sheets.delete) via the shared
  // helper so user-initiated destructive actions execute on first click.
  return callTool<Output>(toolId, input, { fetchImpl });
}

/** True when `value` is a UUID — i.e. a real backend sheet/tab id, not seed. */
export function isBackendSheetsId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
