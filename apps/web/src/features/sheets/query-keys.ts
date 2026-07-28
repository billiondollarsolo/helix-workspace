import type { SheetsCellWindow, SheetsListInput } from "./api";

/** Dependency-free query keys shared by routes and cross-feature invalidation. */
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
