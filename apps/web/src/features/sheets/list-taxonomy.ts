/* Sheets list view — static folder + template taxonomy.
 *
 * Mirrors `apps/web/src/features/docs/data.ts` (DOC_FOLDERS / DOC_TEMPLATES)
 * so the Sheets list-page sidebar (SheetsSidebar) has the same shape as the
 * Docs sidebar. Kept as a separate file so the visual taxonomy doesn't get
 * tangled with the grid/cell helpers in `./seed`. */

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

export const SHEETS_TEMPLATES: readonly string[] = [
  "Budget tracker",
  "Project tracker",
  "OKR planner",
  "Roadmap",
  "Inventory",
  "Pivot starter",
];

/** Heading shown above the main pane for each folder. */
export function headingForSheetsFolder(folder: SheetsFolderId): string {
  if (folder === "all") {
    return "Spreadsheets";
  }
  return SHEETS_FOLDERS.find((entry) => entry.id === folder)?.label ?? "Spreadsheets";
}
