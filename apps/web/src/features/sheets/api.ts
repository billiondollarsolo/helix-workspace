/* Sheets API client — wraps the backend Sheets tools (`POST /api/tools/<id>`).

   Every call rides the Better-Auth session cookie via `authenticatedFetch`.
   The `fetchImpl` parameter is injected only by tests. */

import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type SheetsApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

/** Paginated result envelope from `sheets.list`. */
export interface SheetsListResult {
  readonly sheets: readonly SheetsApiSheet[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
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
  input: { readonly tabId: string },
  fetchImpl: SheetsApiFetch = authenticatedFetch,
): Promise<SheetsApiTabWithCells> {
  return callSheetsTool<SheetsApiTabWithCells>(
    "sheets.tab.get",
    { tabId: input.tabId },
    fetchImpl,
  );
}

/** Apply a batch of cell edits to a tab. Empty values clear cells. */
export async function updateSheetCells(
  input: { readonly tabId: string; readonly edits: readonly SheetsCellEdit[] },
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
    },
    fetchImpl,
  );
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
