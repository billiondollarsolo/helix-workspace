/* Helix Slides — TanStack Query options and keys.

   `slidesListFromDriveQueryOptions` powers the presentations list view;
   `slidesDeckDetailQueryOptions` powers the editor. Mutations live in the
   components and invalidate against `slidesQueryKeys`. */

import { queryOptions } from "@tanstack/react-query";
import { listDrive, searchDrive, type DriveApiEntry } from "@/features/drive/api";
import { formatLabelFromEntry, previewFromEntry } from "@/features/drive/drive-data";
import { driveEntryBelongsToSurface } from "@/features/drive/format-surface";
import { entryFromSearchHit } from "@/features/drive/queries";
import { listPeopleDirectory, type PeopleDirectoryPerson } from "@/features/people/api";
import {
  getSlidesDeck,
  listSlidesComments,
  listSlidesVersions,
  type SlidesCommentStatus,
} from "./api";
import { formatModified } from "./mapping";
import type { SlideDeck } from "./seed";

/** Query-key factory for every Slides query. */
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

/** Editor query: a single deck with its ordered slides. */
export function slidesDeckDetailQueryOptions(
  deckId: string | undefined,
  options: { readonly enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  return queryOptions({
    queryKey: slidesQueryKeys.deckDetail(deckId ?? "none"),
    queryFn: () => {
      if (deckId === undefined) {
        throw new Error("A deck id is required to load a Slides deck.");
      }
      return getSlidesDeck({ deckId });
    },
    enabled: enabled && deckId !== undefined && isBackendSlidesDeckId(deckId),
    throwOnError: false,
  });
}

/** Saved deck snapshot versions (`slides.version.list`). */
export function slidesDeckVersionsQueryOptions(
  deckId: string | undefined,
  options: { readonly enabled?: boolean } = {},
) {
  const enabled = options.enabled ?? true;
  return queryOptions({
    queryKey: slidesQueryKeys.deckVersions(deckId ?? "none"),
    queryFn: () => {
      if (deckId === undefined) {
        throw new Error("A deck id is required to load Slides versions.");
      }
      return listSlidesVersions({ deckId, limit: 25 });
    },
    enabled: enabled && deckId !== undefined && isBackendSlidesDeckId(deckId),
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
 *  - uploaded PPT/PPTX/ODP files
 *
 * The editor (`slides.deck.get`) is unaffected — this only powers the list page.
 */
export function slidesListFromDriveQueryOptions(
  input: { readonly limit?: number; readonly query?: string } = {},
) {
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 100;
  const searchLimit = Math.min(limit, 100);
  return queryOptions({
    queryKey: ["slides", "list-from-drive", "app-slides", query, limit] as const,
    queryFn: async (): Promise<readonly SlideDeck[]> => {
      const entries =
        query.length > 0
          ? (await searchDrive({ query, folderId: null, limit: searchLimit })).map(
              entryFromSearchHit,
            )
          : await listDrive({
              folderId: null,
              includeTrashed: true,
              acrossFolders: true,
              app: "slides",
              limit,
            });
      return entries
        .filter((entry) => entry.type === "file" && isPresentationLike(entry))
        .map((entry): SlideDeck => {
          const preview = previewFromEntry(entry);
          const owner = ownerLabelFromEntry(entry);
          return {
            id: entry.id,
            title: titleForDeckEntry(entry),
            owner,
            modified: formatModified(entry.updatedAt),
            slides: (entry.metadata?.slideCount as number | undefined) ?? 0,
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 0,
            mine: mineFromEntry(entry, owner),
            starred: entry.metadata?.starred === true,
            deletedAt: entry.deletedAt,
            ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
            formatLabel: formatLabelFromEntry(entry),
            ...(preview === undefined ? {} : { preview }),
            // Native Helix decks should hit slides.deck.get. Raw Office/ODP
            // uploads should go straight to the universal copy/preview flow
            // so the expected miss is not surfaced as a failed native fetch.
            openMode: hasPresentationExtension(entry.name) ? "office" : "native",
            source: "backend",
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

function titleForDeckEntry(entry: {
  readonly app?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly name: string;
}): string {
  const metadataTitle =
    typeof entry.metadata?.title === "string" ? entry.metadata.title.trim() : "";
  if (hasPresentationExtension(entry.name)) {
    return entry.name.trim() || metadataTitle || "Untitled deck";
  }
  if (entry.app === "slides") {
    return (
      metadataTitle || entry.name.replace(/\.(slide|helixdeck)$/iu, "").trim() || "Untitled deck"
    );
  }
  return entry.name.trim() || metadataTitle || "Untitled deck";
}

function hasPresentationExtension(name: string): boolean {
  return driveEntryBelongsToSurface(
    { app: null, name: name.trim(), mimeType: undefined },
    "slides",
  );
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
 *  Helix deck OR an uploaded presentation file. */
function isPresentationLike(entry: {
  readonly app?: string | null;
  readonly mimeType?: string;
  readonly name: string;
}): boolean {
  return driveEntryBelongsToSurface(entry, "slides");
}
