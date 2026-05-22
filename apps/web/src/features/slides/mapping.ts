/* Helix Slides — backend ⇄ UI mapping helpers.

   Pure functions that translate the Slides API shapes (`SlidesApiDeck`,
   `SlidesApiSlide`) into the handoff UI shapes (`SlideDeck`, `Slide`) and
   merge live backend rows over the typed seed fallback. Kept separate from the
   components so they can be unit-tested without a DOM. */

import type { SlidesApiDeck, SlidesApiSlide } from "./api";
import { contentToSlide, type Slide, type SlideDeck } from "./seed";

/** Format an ISO timestamp into the relative "modified" label used by the list. */
export function formatModified(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Recently";
  }
  const ageMs = Date.now() - timestamp;
  if (ageMs < 0) {
    return "Just now";
  }
  if (ageMs < 60_000) {
    return "Just now";
  }
  if (ageMs < 3_600_000) {
    const minutes = Math.floor(ageMs / 60_000);
    return `${String(minutes)} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (ageMs < 86_400_000) {
    const hours = Math.floor(ageMs / 3_600_000);
    return `${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (ageMs < 172_800_000) {
    return "Yesterday";
  }
  if (ageMs < 604_800_000) {
    const days = Math.floor(ageMs / 86_400_000);
    return `${String(days)} days ago`;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );
}

/** Map a backend deck row into the list-view `SlideDeck` shape. */
export function deckFromApi(deck: SlidesApiDeck): SlideDeck {
  return {
    id: deck.id,
    title: deck.title.length > 0 ? deck.title : "Untitled deck",
    owner: ownerLabelFromMetadata(deck.metadata),
    modified: formatModified(deck.updatedAt),
    slides: deck.slideCount,
    shared: sharedCountFromMetadata(deck.metadata),
    source: "backend",
  };
}

/** Map a backend slide row into a renderable `Slide` (content + id). */
export function slideFromApi(slide: SlidesApiSlide): Slide {
  return contentToSlide(slide.id, slide.content);
}

/**
 * Merge live backend decks over the seed list, de-duplicating by id. Backend
 * rows come first (newest-updated); seed rows are kept only as an offline
 * fallback and dropped once any backend row shares their id.
 */
export function mergeBackendDecks(
  seed: readonly SlideDeck[],
  backend: readonly SlidesApiDeck[] | undefined,
): readonly SlideDeck[] {
  if (backend === undefined) {
    return seed.map((deck) => ({ ...deck, source: "seed" as const }));
  }
  const backendRows = backend.map(deckFromApi);
  const backendIds = new Set(backendRows.map((row) => row.id));
  const seedRows = seed
    .filter((deck) => !backendIds.has(deck.id))
    .map((deck) => ({ ...deck, source: "seed" as const }));
  return [...backendRows, ...seedRows];
}

/**
 * Merge Drive-sourced `SlideDeck` rows over the seed list, de-duplicating by
 * id. Used by `SlidesList` when `slidesListFromDriveQueryOptions` succeeds.
 */
export function mergeDriveDecks(
  seed: readonly SlideDeck[],
  driveRows: readonly SlideDeck[] | undefined,
): readonly SlideDeck[] {
  const seedRows = seed.map((deck) => ({ ...deck, source: "seed" as const }));
  if (driveRows === undefined || driveRows.length === 0) {
    return seedRows;
  }
  const driveIds = new Set(driveRows.map((row) => row.id));
  return [...driveRows, ...seedRows.filter((deck) => !driveIds.has(deck.id))];
}

function ownerLabelFromMetadata(metadata: Record<string, unknown>): string {
  const owner = metadata["ownerName"];
  return typeof owner === "string" && owner.length > 0 ? owner : "You";
}

function sharedCountFromMetadata(metadata: Record<string, unknown>): number {
  const shared = metadata["sharedCount"];
  return typeof shared === "number" && Number.isFinite(shared) ? shared : 0;
}
