import type { SlidesCommentStatus } from "./api";

/** Dependency-free query keys shared by routes and cross-feature invalidation. */
export const slidesQueryKeys = {
  all: ["slides"] as const,
  deckLists: ["slides", "decks"] as const,
  deckDetails: ["slides", "deck"] as const,
  deckDetail: (deckId: string) => ["slides", "deck", deckId] as const,
  deckVersions: (deckId: string) => ["slides", "deck", deckId, "versions"] as const,
  deckComments: (deckId: string) => ["slides", "deck", deckId, "comments"] as const,
  deckCommentsByStatus: (deckId: string, status: SlidesCommentStatus) =>
    ["slides", "deck", deckId, "comments", status] as const,
  mentionPeople: ["slides", "mention-people"] as const,
};
