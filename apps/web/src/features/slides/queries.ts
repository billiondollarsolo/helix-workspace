/* Helix Slides — TanStack Query options and keys.

   `slidesListFromDriveQueryOptions` powers the presentations list view;
   `slidesDeckDetailQueryOptions` powers the editor. Mutations live in the
   components and invalidate against `slidesQueryKeys`. */

import { queryOptions } from "@tanstack/react-query";
import { listDrive } from "@/features/drive/api";
import { getSlidesDeck } from "./api";
import { formatModified } from "./mapping";
import type { SlideDeck } from "./seed";

/** Query-key factory for every Slides query. */
export const slidesQueryKeys = {
  all: ["slides"] as const,
  deckLists: ["slides", "decks"] as const,
  deckDetails: ["slides", "deck"] as const,
  deckDetail: (deckId: string) => ["slides", "deck", deckId] as const,
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
 * List-page query sourced from `drive.list` filtered by `app:"slides"`.
 * Returns Drive entries mapped to `SlideDeck` view-model rows.
 * The editor (`slides.deck.get`) is unaffected — this replaces only the list query.
 */
export function slidesListFromDriveQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["slides", "list-from-drive", input.limit ?? 100] as const,
    queryFn: async (): Promise<readonly SlideDeck[]> => {
      const entries = await listDrive({
        folderId: null,
        app: "slides",
        limit: input.limit ?? 100,
      });
      return entries
        .filter(
          (entry) => entry.type === "file" && entry.app === "slides" && entry.deletedAt === null,
        )
        .map(
          (entry): SlideDeck => ({
            id: entry.id,
            title:
              (entry.metadata?.title as string | undefined)?.trim() ||
              entry.name.replace(/\.slide$/u, "").trim() ||
              "Untitled deck",
            owner: (entry.metadata?.ownerName as string | undefined) ?? "You",
            modified: formatModified(entry.updatedAt),
            slides: (entry.metadata?.slideCount as number | undefined) ?? 0,
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 0,
            source: "backend",
          }),
        );
    },
    throwOnError: false,
  });
}
