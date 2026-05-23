/* Helix Slides — backend API client.

   Thin typed wrappers over the Slides tool surface (`POST /api/tools/<id>`).
   Mirrors the `slides.deck.*` / `slides.slide.*` tools registered by
   `platform/slides`. Every call rides the Better-Auth session cookie via
   `authenticatedFetch`; a custom `fetchImpl` is accepted for tests. */

import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";
import type { SlideContent, SlideLayout } from "./seed";

export type SlidesApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A deck summary row returned by `slides.deck.list` / `slides.deck.create`. */
export interface SlidesApiDeck {
  readonly id: string;
  readonly orgId?: string;
  readonly title: string;
  readonly ownerActorId: string | null;
  readonly createdByActorId: string | null;
  readonly slideCount: number;
  readonly metadata: Record<string, unknown>;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A single ordered slide returned by the slide tools. */
export interface SlidesApiSlide {
  readonly id: string;
  readonly orgId?: string;
  readonly deckId: string;
  readonly position: number;
  readonly layout: SlideLayout;
  readonly content: SlideContent;
  readonly speakerNotes: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A deck plus its ordered slides, returned by `slides.deck.get`. */
export interface SlidesApiDeckDetail {
  readonly deck: SlidesApiDeck;
  readonly slides: readonly SlidesApiSlide[];
}

export interface SlidesListDecksInput {
  readonly query?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SlidesListDecksResult {
  readonly decks: readonly SlidesApiDeck[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** `slides.deck.list` — presentations list view. */
export async function listSlidesDecks(
  input: SlidesListDecksInput = {},
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesListDecksResult> {
  const output = await callSlidesTool<Partial<SlidesListDecksResult>>(
    "slides.deck.list",
    {
      ...(input.query === undefined ? {} : { query: input.query }),
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    },
    fetchImpl,
  );
  return {
    decks: output.decks ?? [],
    total: output.total ?? output.decks?.length ?? 0,
    limit: output.limit ?? input.limit ?? 50,
    offset: output.offset ?? input.offset ?? 0,
  };
}

/** `slides.deck.get` — open a deck with its ordered slides. */
export async function getSlidesDeck(
  input: { readonly deckId: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesApiDeckDetail> {
  return callSlidesTool<SlidesApiDeckDetail>("slides.deck.get", { deckId: input.deckId }, fetchImpl);
}

/** `slides.deck.create` — the New deck button. */
export async function createSlidesDeck(
  input: { readonly title: string; readonly metadata?: Record<string, unknown> },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesApiDeck> {
  return callSlidesTool<SlidesApiDeck>(
    "slides.deck.create",
    { title: input.title, metadata: input.metadata ?? {} },
    fetchImpl,
  );
}

/** `slides.deck.update` — rename / metadata. */
export async function updateSlidesDeck(
  input: {
    readonly deckId: string;
    readonly title?: string;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesApiDeck> {
  return callSlidesTool<SlidesApiDeck>(
    "slides.deck.update",
    {
      deckId: input.deckId,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
    fetchImpl,
  );
}

/** `slides.deck.delete` — delete a deck and all of its slides. */
export async function deleteSlidesDeck(
  input: { readonly deckId: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<{ readonly deckId: string; readonly deleted: boolean }> {
  return callSlidesTool<{ readonly deckId: string; readonly deleted: boolean }>(
    "slides.deck.delete",
    { deckId: input.deckId },
    fetchImpl,
  );
}

/** `slides.slide.create` — add a typed-layout slide to a deck. */
export async function createSlidesSlide(
  input: {
    readonly deckId: string;
    readonly content: SlideContent;
    readonly speakerNotes?: string;
    readonly position?: number;
  },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesApiSlide> {
  return callSlidesTool<SlidesApiSlide>(
    "slides.slide.create",
    {
      deckId: input.deckId,
      content: input.content,
      ...(input.speakerNotes === undefined ? {} : { speakerNotes: input.speakerNotes }),
      ...(input.position === undefined ? {} : { position: input.position }),
    },
    fetchImpl,
  );
}

/** `slides.slide.update` — update a slide's layout body or speaker notes. */
export async function updateSlidesSlide(
  input: {
    readonly slideId: string;
    readonly content?: SlideContent;
    readonly speakerNotes?: string;
  },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesApiSlide> {
  return callSlidesTool<SlidesApiSlide>(
    "slides.slide.update",
    {
      slideId: input.slideId,
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.speakerNotes === undefined ? {} : { speakerNotes: input.speakerNotes }),
    },
    fetchImpl,
  );
}

/** `slides.slide.delete` — delete a slide from its deck. */
export async function deleteSlidesSlide(
  input: { readonly slideId: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<{ readonly slideId: string; readonly deleted: boolean }> {
  return callSlidesTool<{ readonly slideId: string; readonly deleted: boolean }>(
    "slides.slide.delete",
    { slideId: input.slideId },
    fetchImpl,
  );
}

/** `slides.slide.reorder` — reorder every slide in a deck (a full permutation). */
export async function reorderSlidesSlides(
  input: { readonly deckId: string; readonly slideIds: readonly string[] },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<{ readonly deckId: string; readonly slides: readonly SlidesApiSlide[] }> {
  return callSlidesTool<{ readonly deckId: string; readonly slides: readonly SlidesApiSlide[] }>(
    "slides.slide.reorder",
    { deckId: input.deckId, slideIds: [...input.slideIds] },
    fetchImpl,
  );
}

async function callSlidesTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: SlidesApiFetch,
): Promise<Output> {
  // Auto-approves pending_confirmation (e.g. slides.deck.delete,
  // slides.slide.delete) via the shared callTool helper.
  return callTool<Output>(toolId, input, { fetchImpl });
}
