/* Sheets TanStack Query options + keys.

   Read queries hydrate the list view, the open spreadsheet, and a tab's
   cells. All queries set `throwOnError: false` so the surface can fall back
   to seed data when the backend is unavailable. */

import { queryOptions } from "@tanstack/react-query";
import { listDrive, searchDrive, type DriveApiEntry } from "@/features/drive/api";
import { formatLabelFromEntry, previewFromEntry } from "@/features/drive/drive-data";
import { driveEntryBelongsToSurface } from "@/features/drive/format-surface";
import { entryFromSearchHit } from "@/features/drive/queries";
import {
  getSheet,
  getSheetTab,
  listSheetVersions,
  type SheetsCellWindow,
  type SheetsListInput,
} from "./api";
import { formatModified, type SheetListRow } from "./model";

export const sheetsQueryKeys = {
  all: ["sheets"] as const,
  list: (input: SheetsListInput = {}) =>
    ["sheets", "list", input.query?.trim() ?? "", input.limit ?? 50, input.offset ?? 0] as const,
  sheet: (sheetId: string) => ["sheets", "sheet", sheetId] as const,
  tab: (tabId: string) => ["sheets", "tab", tabId] as const,
  versions: (sheetId: string) => ["sheets", "sheet", sheetId, "versions"] as const,
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

/** Saved spreadsheet snapshot versions (`sheets.version.list`). */
export function sheetVersionsQueryOptions(sheetId: string, enabled = true) {
  return queryOptions({
    queryKey: sheetsQueryKeys.versions(sheetId),
    queryFn: () => listSheetVersions({ sheetId, limit: 25 }),
    enabled,
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
export function sheetsListFromDriveQueryOptions(
  input: { readonly limit?: number; readonly query?: string } = {},
) {
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 100;
  const searchLimit = Math.min(limit, 100);
  return queryOptions({
    queryKey: ["sheets", "list-from-drive", "app-sheets", query, limit] as const,
    queryFn: async (): Promise<readonly SheetListRow[]> => {
      const entries =
        query.length > 0
          ? (await searchDrive({ query, folderId: null, limit: searchLimit })).map(
              entryFromSearchHit,
            )
          : await listDrive({
              folderId: null,
              includeTrashed: true,
              acrossFolders: true,
              app: "sheets",
              limit,
            });
      return entries
        .filter((entry) => entry.type === "file" && isSpreadsheetLike(entry))
        .map((entry): SheetListRow => {
          const preview = previewFromEntry(entry);
          const owner = ownerLabelFromEntry(entry);
          return {
            id: entry.id,
            title: titleForSheetEntry(entry),
            owner,
            modified: formatModified(entry.updatedAt),
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 1,
            source: "backend",
            ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
            formatLabel: formatLabelFromEntry(entry),
            ...(preview === undefined ? {} : { preview }),
            mine: mineFromEntry(entry, owner),
            starred: entry.metadata?.starred === true,
            deletedAt: entry.deletedAt,
            // Native Helix sheets should hit sheets.get. Raw spreadsheet
            // uploads should go straight to the universal copy/preview flow.
            openMode: hasSpreadsheetExtension(entry.name) ? "office" : "native",
          };
        });
    },
    throwOnError: false,
  });
}

function ownerLabelFromEntry(entry: DriveApiEntry): string {
  const metadataOwner =
    typeof entry.metadata?.ownerName === "string" ? entry.metadata.ownerName : "";
  return entry.ownerDisplayName?.trim() || metadataOwner.trim() || "You";
}

function mineFromEntry(entry: DriveApiEntry, owner: string): boolean {
  if (typeof entry.metadata?.mine === "boolean") {
    return entry.metadata.mine;
  }
  return owner.trim().toLowerCase() === "you";
}

function titleForSheetEntry(entry: {
  readonly app?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
}): string {
  const metadataTitle =
    typeof entry.metadata?.title === "string" ? entry.metadata.title.trim() : "";
  if (hasSpreadsheetExtension(entry.name)) {
    return entry.name.trim() || metadataTitle || "Untitled spreadsheet";
  }
  if (entry.app === "sheets") {
    return (
      metadataTitle ||
      entry.name.replace(/\.(sheet|helixsheet)$/iu, "").trim() ||
      "Untitled spreadsheet"
    );
  }
  return entry.name.trim() || metadataTitle || "Untitled spreadsheet";
}

function hasSpreadsheetExtension(name: string): boolean {
  return driveEntryBelongsToSurface(
    { app: null, name: name.trim(), mimeType: undefined },
    "sheets",
  );
}

/** True when a drive entry should appear in the Sheets list — a native
 *  Helix sheet OR a raw spreadsheet upload (XLS/XLSX, CSV/TSV, ODS). */
function isSpreadsheetLike(entry: {
  readonly app?: string | null;
  readonly mimeType?: string;
  readonly name: string;
}): boolean {
  return driveEntryBelongsToSurface(entry, "sheets");
}
