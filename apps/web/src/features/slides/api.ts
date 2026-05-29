/* Helix Slides — backend API client.

   Thin typed wrappers over the Slides tool surface (`POST /api/tools/<id>`).
   Mirrors the `slides.deck.*` / `slides.slide.*` tools registered by
   `platform/slides`. Every call rides the Better-Auth session cookie via
   `authenticatedFetch`; a custom `fetchImpl` is accepted for tests. */

import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";
import type { SlideContent, SlideLayout } from "./seed";

export type SlidesApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type SlidesCommentStatus = "open" | "resolved" | "all";
type SlidesCommentRecordStatus = Exclude<SlidesCommentStatus, "all">;

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
  /** Per-slide CAS counter; clients send this back as `expectedRevision` on
   * `update-slide` / `delete-slide` so concurrent edits to the same slide
   * fail fast instead of silently last-write-winning. */
  readonly revision?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A deck plus its ordered slides, returned by `slides.deck.get`. */
export interface SlidesApiDeckDetail {
  readonly deck: SlidesApiDeck;
  readonly slides: readonly SlidesApiSlide[];
}

export interface SlidesExportResult {
  readonly deckId: string;
  readonly format: "pptx" | "pdf" | "svg-series";
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly contentBase64: string;
  readonly metadata: Record<string, unknown>;
}

export interface SlidesImportResult extends SlidesApiDeck {
  readonly slides: readonly SlidesApiSlide[];
  readonly import: {
    readonly sourceFormat: string;
    readonly slideCount: number;
    readonly fidelity: string;
  };
}

export interface SlidesVersion {
  readonly id: string;
  readonly orgId?: string;
  readonly deckId: string;
  readonly versionNumber: number;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId: string | null;
  readonly createdAt: string;
}

export interface SlidesDriveComment {
  readonly id: string;
  readonly objectId: string;
  readonly parentCommentId?: string | null;
  readonly actorId: string | null;
  readonly anchor: Record<string, unknown>;
  readonly body: string;
  readonly status: SlidesCommentRecordStatus;
  readonly metadata: Record<string, unknown>;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly author?: {
    readonly id: string;
    readonly displayName?: string;
    readonly email?: string;
  };
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
  return callSlidesTool<SlidesApiDeckDetail>(
    "slides.deck.get",
    { deckId: input.deckId },
    fetchImpl,
  );
}

/** `slides.export` — download a native deck as PPTX. */
export async function exportSlidesDeck(
  input: { readonly deckId: string; readonly format?: SlidesExportResult["format"] | undefined },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesExportResult> {
  return callSlidesTool<SlidesExportResult>(
    "slides.export",
    { deckId: input.deckId, format: input.format ?? "pptx" },
    fetchImpl,
  );
}

/** `slides.version.list` — list saved snapshot versions for a native deck. */
export async function listSlidesVersions(
  input: { readonly deckId: string; readonly limit?: number },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<readonly SlidesVersion[]> {
  const output = await callSlidesTool<{ readonly versions?: readonly SlidesVersion[] }>(
    "slides.version.list",
    {
      deckId: input.deckId,
      limit: input.limit ?? 25,
    },
    fetchImpl,
  );
  return output.versions ?? [];
}

/** `slides.version.restore` — restore a native deck from a saved snapshot version. */
export async function restoreSlidesVersion(
  input: { readonly deckId: string; readonly versionId: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesApiDeckDetail> {
  return callSlidesTool<SlidesApiDeckDetail>(
    "slides.version.restore",
    {
      deckId: input.deckId,
      versionId: input.versionId,
    },
    fetchImpl,
  );
}

/** `slides.import-pptx` — import an uploaded PPTX into a native deck. */
export async function importPptxDeck(
  input: {
    readonly filename: string;
    readonly title: string;
    readonly folderId?: string | null;
    readonly contentBase64: string;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesImportResult> {
  return callSlidesTool<SlidesImportResult>(
    "slides.import-pptx",
    {
      filename: input.filename,
      title: input.title,
      folderId: input.folderId ?? null,
      contentBase64: input.contentBase64,
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

/** `drive.comment.list` — review comments attached to a native Slides deck. */
export async function listSlidesComments(
  input: { readonly deckId: string; readonly status?: SlidesCommentStatus },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<readonly SlidesDriveComment[]> {
  const output = await callSlidesTool<{ readonly comments?: readonly SlidesDriveComment[] }>(
    "drive.comment.list",
    {
      objectId: input.deckId,
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    fetchImpl,
  );
  return output.comments ?? [];
}

/** `drive.comment.create` — add a deck, slide, or shape comment. */
export async function createSlidesComment(
  input: {
    readonly deckId: string;
    readonly body: string;
    readonly anchor: Record<string, unknown>;
    readonly metadata?: Record<string, unknown>;
    readonly parentCommentId?: string;
  },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesDriveComment> {
  return callSlidesTool<SlidesDriveComment>(
    "drive.comment.create",
    {
      objectId: input.deckId,
      body: input.body,
      anchor: input.anchor,
      metadata: input.metadata ?? {},
      ...(input.parentCommentId === undefined ? {} : { parentCommentId: input.parentCommentId }),
    },
    fetchImpl,
  );
}

export async function resolveSlidesComment(
  input: { readonly commentId: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesDriveComment> {
  return callSlidesTool<SlidesDriveComment>("drive.comment.resolve", input, fetchImpl);
}

export async function reopenSlidesComment(
  input: { readonly commentId: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesDriveComment> {
  return callSlidesTool<SlidesDriveComment>("drive.comment.reopen", input, fetchImpl);
}

export async function updateSlidesComment(
  input: { readonly commentId: string; readonly body: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesDriveComment> {
  return callSlidesTool<SlidesDriveComment>("drive.comment.update", input, fetchImpl);
}

export async function deleteSlidesComment(
  input: { readonly commentId: string },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesDriveComment> {
  return callSlidesTool<SlidesDriveComment>("drive.comment.delete", input, fetchImpl);
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

/** `slides.deck.copy` — copy a native deck with all slide content. */
export async function copySlidesDeck(
  input: {
    readonly deckId: string;
    readonly title?: string;
    readonly folderId?: string | null;
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: SlidesApiFetch = authenticatedFetch,
): Promise<SlidesApiDeckDetail> {
  return callSlidesTool<SlidesApiDeckDetail>(
    "slides.deck.copy",
    {
      deckId: input.deckId,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
      metadata: input.metadata ?? {},
    },
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
