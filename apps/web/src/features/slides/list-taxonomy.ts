/* Slides list view — static folder taxonomy. */

import type { IconComponent } from "@/components/icons";
import { Icons } from "@/components/icons";

export type SlidesFolderId = "all" | "recent" | "mine" | "shared" | "starred" | "trash";

export interface SlidesFolder {
  readonly id: SlidesFolderId;
  readonly label: string;
  readonly icon: IconComponent;
}

/** The Helix icon set doesn't ship a dedicated "presentation" glyph yet, so
 *  reuse the Image icon — it matches the deck glyph already used in the
 *  Slides list rows. */
export const SLIDES_FOLDERS: readonly SlidesFolder[] = [
  { id: "all", label: "All presentations", icon: Icons.Image },
  { id: "recent", label: "Recent", icon: Icons.History },
  { id: "mine", label: "Owned by me", icon: Icons.Users },
  { id: "shared", label: "Shared with me", icon: Icons.Users },
  { id: "starred", label: "Starred", icon: Icons.Star },
  { id: "trash", label: "Trash", icon: Icons.Trash },
];

/** Heading shown above the main pane for each folder. */
export function headingForSlidesFolder(folder: SlidesFolderId): string {
  if (folder === "all") {
    return "Presentations";
  }
  return SLIDES_FOLDERS.find((entry) => entry.id === folder)?.label ?? "Presentations";
}
