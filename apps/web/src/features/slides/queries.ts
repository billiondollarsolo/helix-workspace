/* Helix Slides — TanStack Query options and keys.

   `slidesListFromDriveQueryOptions` powers the presentations list view;
   `slidesDeckDetailQueryOptions` powers the editor. Mutations live in the
   components and invalidate against `slidesQueryKeys`. */

import { queryOptions } from "@tanstack/react-query";
import { listDrive, type DriveApiEntry } from "@/features/drive/api";
import { listPeopleDirectory, type PeopleDirectoryPerson } from "@/features/people/api";
import { getSlidesDeck, listSlidesComments, type SlidesCommentStatus } from "./api";
import { formatModified } from "./mapping";
import type { SlideDeck } from "./seed";

/** Query-key factory for every Slides query. */
export const slidesQueryKeys = {
  all: ["slides"] as const,
  deckLists: ["slides", "decks"] as const,
  deckDetails: ["slides", "deck"] as const,
  deckDetail: (deckId: string) => ["slides", "deck", deckId] as const,
  deckComments: (deckId: string) => ["slides", "deck", deckId, "comments"] as const,
  deckCommentsByStatus: (deckId: string, status: SlidesCommentStatus) =>
    ["slides", "deck", deckId, "comments", status] as const,
  mentionPeople: ["slides", "mention-people"] as const,
};

/** Editor query: a single deck with its ordered slides. */
export function slidesDeckDetailQueryOptions(deckId: string | undefined) {
  return queryOptions({
    queryKey: slidesQueryKeys.deckDetail(deckId ?? "none"),
    queryFn: () => {
      if (deckId === undefined) {
        throw new Error("A deck id is required to load a Slides deck.");
      }
      return getSlidesDeck({ deckId });
    },
    enabled: deckId !== undefined && isBackendSlidesDeckId(deckId),
    throwOnError: false,
  });
}

/** True when `value` is a backend UUID (vs. a handoff-seed id like `s1`). */
export function isBackendSlidesDeckId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

/**
 * List-page query sourced from `drive.list`.
 *
 * Returns rows for anything presentation-shaped the user can see:
 *  - native Helix slide decks (drive entries with `app="slides"`)
 *  - uploaded PPTX files (`application/vnd.openxmlformats-officedocument.presentationml.presentation`)
 *
 * The editor (`slides.deck.get`) is unaffected — this only powers the list page.
 */
export function slidesListFromDriveQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["slides", "list-from-drive", input.limit ?? 100] as const,
    queryFn: async (): Promise<readonly SlideDeck[]> => {
      const entries = await listDrive({ folderId: null, limit: input.limit ?? 100 });
      return entries
        .filter(
          (entry) => entry.type === "file" && entry.deletedAt === null && isPresentationLike(entry),
        )
        .map(
          (entry): SlideDeck => ({
            id: entry.id,
            title:
              (entry.metadata?.title as string | undefined)?.trim() ||
              entry.name.replace(/\.(slide|pptx)$/iu, "").trim() ||
              "Untitled deck",
            owner: (entry.metadata?.ownerName as string | undefined) ?? "You",
            modified: formatModified(entry.updatedAt),
            slides: (entry.metadata?.slideCount as number | undefined) ?? 0,
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 0,
            openMode: entry.app === "slides" ? "native" : "office",
            source: "backend",
          }),
        );
    },
    throwOnError: false,
  });
}

export function slidesDriveShapeAssetsQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["slides", "drive-shape-assets", input.limit ?? 100] as const,
    queryFn: (): Promise<readonly DriveApiEntry[]> =>
      listDrive({ folderId: null, acrossFolders: true, limit: input.limit ?? 100 }),
    staleTime: 60_000,
    throwOnError: false,
  });
}

/** People directory used by native Slides comment @mention pickers. */
export function slidesMentionPeopleQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: [...slidesQueryKeys.mentionPeople, input.limit ?? 25] as const,
    queryFn: (): Promise<readonly PeopleDirectoryPerson[]> =>
      listPeopleDirectory({ limit: input.limit ?? 25 }),
    staleTime: 60_000,
    throwOnError: false,
  });
}

/** Editor query: Drive-backed review comments attached to a native deck. */
export function slidesCommentsQueryOptions(
  deckId: string | undefined,
  status: SlidesCommentStatus = "open",
) {
  return queryOptions({
    queryKey: slidesQueryKeys.deckCommentsByStatus(deckId ?? "none", status),
    queryFn: () => {
      if (deckId === undefined) {
        throw new Error("A deck id is required to load Slides comments.");
      }
      return listSlidesComments({ deckId, status });
    },
    enabled: deckId !== undefined && isBackendSlidesDeckId(deckId),
    throwOnError: false,
  });
}

/** True when a drive entry should appear in the Slides list — a native
 *  Helix deck OR an uploaded PPTX. */
function isPresentationLike(entry: {
  readonly app?: string | null;
  readonly mimeType?: string;
  readonly name: string;
}): boolean {
  if (entry.app === "slides") return true;
  const mime = entry.mimeType ?? "";
  if (mime.includes("presentationml") || mime === "application/vnd.ms-powerpoint") return true;
  const name = entry.name.toLowerCase();
  return name.endsWith(".pptx") || name.endsWith(".ppt");
}
