/* Slides list view — static folder + template taxonomy.
 *
 * Mirrors `apps/web/src/features/docs/data.ts` (DOC_FOLDERS / DOC_TEMPLATES)
 * so the Slides list-page sidebar (SlidesSidebar) has the same shape as the
 * Docs sidebar. Kept as a separate file so the visual taxonomy doesn't get
 * tangled with the deck/layout types in `./seed`. */

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

export const SLIDES_TEMPLATES: readonly string[] = [
  "Pitch deck",
  "All-hands",
  "Quarterly review",
  "Onboarding",
  "Lookbook",
  "Tutorial",
];

/** Heading shown above the main pane for each folder. */
export function headingForSlidesFolder(folder: SlidesFolderId): string {
  if (folder === "all") {
    return "Presentations";
  }
  return SLIDES_FOLDERS.find((entry) => entry.id === folder)?.label ?? "Presentations";
}
