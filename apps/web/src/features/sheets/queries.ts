/* Sheets TanStack Query options + keys.

   Read queries hydrate the list view, the open spreadsheet, and a tab's
   cells. All queries set `throwOnError: false` so the surface can fall back
   to seed data when the backend is unavailable. */

import { queryOptions } from "@tanstack/react-query";
import { listDrive } from "@/features/drive/api";
import { getSheet, getSheetTab, type SheetsListInput } from "./api";
import { formatModified, type SheetListRow } from "./model";

export const sheetsQueryKeys = {
  all: ["sheets"] as const,
  list: (input: SheetsListInput = {}) =>
    ["sheets", "list", input.query?.trim() ?? "", input.limit ?? 50, input.offset ?? 0] as const,
  sheet: (sheetId: string) => ["sheets", "sheet", sheetId] as const,
  tab: (tabId: string) => ["sheets", "tab", tabId] as const,
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
export function sheetTabQueryOptions(tabId: string | null) {
  return queryOptions({
    queryKey: sheetsQueryKeys.tab(tabId ?? "none"),
    queryFn: () => getSheetTab({ tabId: tabId ?? "" }),
    enabled: tabId !== null,
    throwOnError: false,
  });
}

/**
 * List-page query sourced from `drive.list` filtered by `app:"sheets"`.
 * Returns Drive entries mapped to `SheetListRow` view-model rows.
 * The editor (`sheets.get`) is unaffected — this replaces only the list query.
 */
export function sheetsListFromDriveQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["sheets", "list-from-drive", input.limit ?? 100] as const,
    queryFn: async (): Promise<readonly SheetListRow[]> => {
      const entries = await listDrive({ folderId: null, app: "sheets", limit: input.limit ?? 100 });
      return entries
        .filter(
          (entry) => entry.type === "file" && entry.app === "sheets" && entry.deletedAt === null,
        )
        .map(
          (entry): SheetListRow => ({
            id: entry.id,
            title:
              (entry.metadata?.title as string | undefined)?.trim() ||
              entry.name.replace(/\.sheet$/u, "").trim() ||
              "Untitled spreadsheet",
            owner: (entry.metadata?.ownerName as string | undefined) ?? "You",
            modified: formatModified(entry.updatedAt),
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 1,
            source: "backend",
          }),
        );
    },
    throwOnError: false,
  });
}
