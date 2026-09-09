/* Sheets list view — static folder taxonomy. */

import type { IconComponent } from "@/components/icons";
import { Icons } from "@/components/icons";

export type SheetsFolderId = "all" | "recent" | "mine" | "shared" | "starred" | "trash";

export interface SheetsFolder {
  readonly id: SheetsFolderId;
  readonly label: string;
  readonly icon: IconComponent;
}

export const SHEETS_FOLDERS: readonly SheetsFolder[] = [
  { id: "all", label: "All sheets", icon: Icons.Sheet },
  { id: "recent", label: "Recent", icon: Icons.History },
  { id: "mine", label: "Owned by me", icon: Icons.Users },
  { id: "shared", label: "Shared with me", icon: Icons.Users },
  { id: "starred", label: "Starred", icon: Icons.Star },
  { id: "trash", label: "Trash", icon: Icons.Trash },
];

/** Heading shown above the main pane for each folder. */
export function headingForSheetsFolder(folder: SheetsFolderId): string {
  if (folder === "all") {
    return "Spreadsheets";
  }
  return SHEETS_FOLDERS.find((entry) => entry.id === folder)?.label ?? "Spreadsheets";
}
