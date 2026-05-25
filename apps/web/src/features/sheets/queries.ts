/* Sheets TanStack Query options + keys.

   Read queries hydrate the list view, the open spreadsheet, and a tab's
   cells. All queries set `throwOnError: false` so the surface can fall back
   to seed data when the backend is unavailable. */

import { queryOptions } from "@tanstack/react-query";
import { listDrive } from "@/features/drive/api";
import { getSheet, getSheetTab, type SheetsCellWindow, type SheetsListInput } from "./api";
import { formatModified, type SheetListRow } from "./model";

export const sheetsQueryKeys = {
  all: ["sheets"] as const,
  list: (input: SheetsListInput = {}) =>
    ["sheets", "list", input.query?.trim() ?? "", input.limit ?? 50, input.offset ?? 0] as const,
  sheet: (sheetId: string) => ["sheets", "sheet", sheetId] as const,
  tab: (tabId: string) => ["sheets", "tab", tabId] as const,
  tabWindow: (tabId: string, window: SheetsCellWindow | null = null) =>
    [
      "sheets",
      "tab",
      tabId,
      window?.startRow ?? "all",
      window?.startCol ?? "all",
      window?.endRow ?? "all",
      window?.endCol ?? "all",
    ] as const,
};

/** A single spreadsheet with its tabs (`sheets.get`). */
export function sheetQueryOptions(sheetId: string, enabled = true) {
  return queryOptions({
    queryKey: sheetsQueryKeys.sheet(sheetId),
    queryFn: () => getSheet({ sheetId }),
    enabled,
    throwOnError: false,
  });
}

/** A tab with its populated cells (`sheets.tab.get`). */
export function sheetTabQueryOptions(tabId: string | null, window: SheetsCellWindow | null = null) {
  return queryOptions({
    queryKey: sheetsQueryKeys.tabWindow(tabId ?? "none", window),
    queryFn: () =>
      getSheetTab({
        tabId: tabId ?? "",
        ...(window === null ? {} : { window }),
      }),
    enabled: tabId !== null,
    throwOnError: false,
  });
}

/**
 * List-page query sourced from `drive.list`.
 *
 * Returns rows for anything spreadsheet-shaped the user can see:
 *  - native Helix sheets (drive entries with `app="sheets"`)
 *  - uploaded XLSX files (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
 *  - uploaded CSV files
 *
 * The editor (`sheets.get`) is unaffected — this only powers the list page.
 */
export function sheetsListFromDriveQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["sheets", "list-from-drive", input.limit ?? 100] as const,
    queryFn: async (): Promise<readonly SheetListRow[]> => {
      const entries = await listDrive({ folderId: null, limit: input.limit ?? 100 });
      return entries
        .filter(
          (entry) => entry.type === "file" && entry.deletedAt === null && isSpreadsheetLike(entry),
        )
        .map(
          (entry): SheetListRow => ({
            id: entry.id,
            title:
              (entry.metadata?.title as string | undefined)?.trim() ||
              entry.name.replace(/\.(sheet|xlsx|csv)$/iu, "").trim() ||
              "Untitled spreadsheet",
            owner: (entry.metadata?.ownerName as string | undefined) ?? "You",
            modified: formatModified(entry.updatedAt),
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 1,
            source: "backend",
            openMode: entry.app === "sheets" ? "native" : "office",
          }),
        );
    },
    throwOnError: false,
  });
}

/** True when a drive entry should appear in the Sheets list — a native
 *  Helix sheet OR a raw spreadsheet upload (XLSX, CSV). */
function isSpreadsheetLike(entry: {
  readonly app?: string | null;
  readonly mimeType?: string;
  readonly name: string;
}): boolean {
  if (entry.app === "sheets") return true;
  const mime = entry.mimeType ?? "";
  if (mime.includes("spreadsheetml") || mime.startsWith("text/csv")) return true;
  const name = entry.name.toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv");
}
