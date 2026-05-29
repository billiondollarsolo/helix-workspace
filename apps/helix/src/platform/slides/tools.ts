import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { importPptxDeck } from "./import-pptx.js";
import { slideContentSchema } from "./content.js";
import {
  exportSlidesDeckToImageSeries,
  exportSlidesDeckToPdf,
  type SlidesImageSeriesExportResult,
  type SlidesPdfExportResult,
} from "./export-assets.js";
import { exportSlidesDeckToPptx, type SlidesPptxExportResult } from "./export-pptx.js";
import type { DriveStore } from "../drive/store.js";
import type { DriveCommentListItem } from "../drive/types.js";
import type { SlideDeckVersionRecord, SlidesStore } from "./store.js";
import type { SlideContent, SlideDeckSummaryRecord, SlideRecord } from "./types.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});

const listDecksSchema = z.object({
  query: z.string().max(512).optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().max(100_000).default(0),
});

const getDeckSchema = z.object({
  deckId: uuidSchema,
});

const listDeckVersionsSchema = z.object({
  deckId: uuidSchema,
  limit: z.number().int().positive().max(100).default(50),
});

const restoreDeckVersionSchema = z.object({
  deckId: uuidSchema,
  versionId: uuidSchema,
});

const exportDeckSchema = z.object({
  deckId: uuidSchema,
  format: z.enum(["pptx", "pdf", "svg-series"]).default("pptx"),
});

const importPptxSchema = z.object({
  filename: z.string().min(1).max(255),
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  contentBase64: z.string().min(1),
  metadata: metadataSchema,
});

const createDeckSchema = z.object({
  title: z.string().min(1).max(255),
  metadata: metadataSchema,
});

const copyDeckSchema = z.object({
  deckId: uuidSchema,
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  metadata: metadataSchema,
});

const updateDeckSchema = z
  .object({
    deckId: uuidSchema,
    title: z.string().min(1).max(255).optional(),
    metadata: metadataSchema.optional(),
  })
  .refine((value) => value.title !== undefined || value.metadata !== undefined, {
    message: "Provide at least one of title or metadata to update.",
  });

const deleteDeckSchema = z.object({
  deckId: uuidSchema,
});

const speakerNotesSchema = z.string().max(20_000);

const createSlideSchema = z.object({
  deckId: uuidSchema,
  content: slideContentSchema,
  speakerNotes: speakerNotesSchema.optional(),
  position: z.number().int().nonnegative().max(10_000).optional(),
});

const updateSlideSchema = z
  .object({
    slideId: uuidSchema,
    content: slideContentSchema.optional(),
    speakerNotes: speakerNotesSchema.optional(),
  })
  .refine((value) => value.content !== undefined || value.speakerNotes !== undefined, {
    message: "Provide at least one of content or speakerNotes to update.",
  });

const deleteSlideSchema = z.object({
  slideId: uuidSchema,
});

const reorderSlidesSchema = z.object({
  deckId: uuidSchema,
  slideIds: z.array(uuidSchema).min(1).max(1_000),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateSlidesToolDefinitionsOptions {
  readonly store: SlidesStore;
  readonly driveStore?: DriveCommentReader | undefined;
}

type DriveCommentReader = {
  readonly listComments: NonNullable<DriveStore["listComments"]>;
};

/**
 * The Slides tool surface: deck list/get/create/update/delete plus slide
 * create/update/delete/reorder. Reads require `slides.read`, mutations require
 * `slides.write`. Every handler is Zod-validated; the store enforces actor
 * authz and appends audit activity for mutations.
 */
export function createSlidesToolDefinitions(
  options: CreateSlidesToolDefinitionsOptions,
): readonly ToolDefinition[] {
  const { store } = options;
  return [
    defineTool<z.output<typeof listDecksSchema>, unknown>({
      id: "slides.deck.list",
      description: "List presentation decks owned by the current actor.",
      permission: "slides.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listDecksSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await store.listDecksForActor({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          ...(input.query === undefined ? {} : { query: input.query }),
          limit: input.limit,
          offset: input.offset,
        });
        await ctx.audit("slides.deck.list", { count: result.decks.length });
        return {
          decks: result.decks.map(serializeDeck),
          total: result.total,
          limit: input.limit,
          offset: input.offset,
        };
      },
    }),
    defineTool<z.output<typeof getDeckSchema>, unknown>({
      id: "slides.deck.get",
      description: "Get a presentation deck with its ordered slides.",
      permission: "slides.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(getDeckSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await store.getDeckForActor({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
        });
        if (result === null) {
          throw new Error(`Unknown Slides deck: ${input.deckId}`);
        }
        await ctx.audit("slides.deck.get", { deckId: input.deckId });
        return {
          deck: serializeDeck(result.deck),
          slides: result.slides.map(serializeSlide),
        };
      },
    }),
    defineTool<z.output<typeof listDeckVersionsSchema>, unknown>({
      id: "slides.version.list",
      description: "List saved snapshot versions for a presentation deck.",
      permission: "slides.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listDeckVersionsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const versions = await store.listVersions({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
          limit: input.limit,
        });
        await ctx.audit("slides.version.list", { deckId: input.deckId, count: versions.length });
        return { versions: versions.map(serializeVersion) };
      },
    }),
    defineTool<z.output<typeof restoreDeckVersionSchema>, unknown>({
      id: "slides.version.restore",
      description: "Restore a presentation deck from a saved snapshot version.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(restoreDeckVersionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const restored = await store.restoreVersion({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
          versionId: input.versionId,
        });
        if (restored === null) {
          throw new Error(`Unknown Slides version: ${input.versionId}`);
        }
        await ctx.audit("slides.version.restore", {
          deckId: input.deckId,
          versionId: input.versionId,
        });
        return {
          deck: serializeDeck(restored.deck),
          slides: restored.slides.map(serializeSlide),
        };
      },
    }),
    defineTool<z.output<typeof exportDeckSchema>, unknown>({
      id: "slides.export",
      description: "Export a native Helix Slides deck to PPTX, PDF, or an SVG image series.",
      permission: "slides.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(exportDeckSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await store.getDeckForActor({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
        });
        if (result === null) {
          throw new Error(`Unknown Slides deck: ${input.deckId}`);
        }
        const comments =
          options.driveStore === undefined
            ? []
            : await options.driveStore.listComments({
                orgId: ctx.actor.orgId,
                actorId: ctx.actor.id,
                objectId: input.deckId,
                status: "all",
              });
        const exported = await exportSlidesDeck(result.deck, result.slides, input.format, comments);
        await ctx.audit("slides.export", {
          deckId: input.deckId,
          format: input.format,
          byteSize: exported.byteSize,
          slideCount: result.slides.length,
          commentCount: comments.length,
        });
        return exported;
      },
    }),
    defineTool<z.output<typeof importPptxSchema>, unknown>({
      id: "slides.import-pptx",
      description: "Import a PPTX file into a native Helix Slides deck.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(importPptxSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const imported = await importPptxDeck({
          filename: input.filename,
          ...(input.title === undefined ? {} : { title: input.title }),
          content: Buffer.from(input.contentBase64, "base64"),
        });
        const deck = await store.createDeck({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title: imported.title,
          folderId: input.folderId ?? null,
          metadata: toJsonObject({
            ...input.metadata,
            originalFormat: imported.metadata.sourceFormat,
            import: imported.metadata,
          }),
        });
        const slides: SlideRecord[] = [];
        for (const [position, slide] of imported.slides.entries()) {
          slides.push(
            await store.createSlide({
              orgId: ctx.actor.orgId,
              actorId: ctx.actor.id,
              deckId: deck.id,
              content: slide.content,
              speakerNotes: slide.speakerNotes,
              position,
            }),
          );
        }
        await ctx.audit("slides.import-pptx", {
          deckId: deck.id,
          filename: input.filename,
          slideCount: slides.length,
        });
        return {
          ...serializeDeck({ ...deck, slideCount: slides.length }),
          slides: slides.map(serializeSlide),
          import: imported.metadata,
        };
      },
    }),
    defineTool<z.output<typeof createDeckSchema>, unknown>({
      id: "slides.deck.create",
      description: "Create a presentation deck.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createDeckSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const deck = await store.createDeck({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title: input.title,
          metadata: toJsonObject(input.metadata),
        });
        await ctx.audit("slides.deck.create", { deckId: deck.id, title: deck.title });
        return serializeDeck(deck);
      },
    }),
    defineTool<z.output<typeof copyDeckSchema>, unknown>({
      id: "slides.deck.copy",
      description: "Copy a native presentation deck with its slides.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(copyDeckSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await store.copyDeck({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          metadata: toJsonObject(input.metadata),
        });
        if (result === null) {
          throw new Error(`Unknown Slides deck: ${input.deckId}`);
        }
        await ctx.audit("slides.deck.copy", {
          deckId: result.deck.id,
          copiedFromDeckId: input.deckId,
        });
        return {
          deck: serializeDeck(result.deck),
          slides: result.slides.map(serializeSlide),
        };
      },
    }),
    defineTool<z.output<typeof updateDeckSchema>, unknown>({
      id: "slides.deck.update",
      description: "Update a presentation deck's title or metadata.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateDeckSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const deck = await store.updateDeck({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.metadata === undefined ? {} : { metadata: toJsonObject(input.metadata) }),
        });
        if (deck === null) {
          throw new Error(`Unknown Slides deck: ${input.deckId}`);
        }
        await ctx.audit("slides.deck.update", { deckId: deck.id });
        return serializeDeck(deck);
      },
    }),
    defineTool<z.output<typeof deleteDeckSchema>, unknown>({
      id: "slides.deck.delete",
      description: "Delete a presentation deck and all of its slides.",
      permission: "slides.write",
      sideEffects: "destructive",
      inputSchema: zodToolSchema(deleteDeckSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const deleted = await store.deleteDeck({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
        });
        if (!deleted) {
          throw new Error(`Unknown Slides deck: ${input.deckId}`);
        }
        await ctx.audit("slides.deck.delete", { deckId: input.deckId });
        return { deckId: input.deckId, deleted: true };
      },
    }),
    defineTool<z.output<typeof createSlideSchema>, unknown>({
      id: "slides.slide.create",
      description: "Add a slide to a deck with a typed layout body.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createSlideSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const slide = await store.createSlide({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
          content: input.content as SlideContent,
          ...(input.speakerNotes === undefined ? {} : { speakerNotes: input.speakerNotes }),
          ...(input.position === undefined ? {} : { position: input.position }),
        });
        await ctx.audit("slides.slide.create", { deckId: input.deckId, slideId: slide.id });
        return serializeSlide(slide);
      },
    }),
    defineTool<z.output<typeof updateSlideSchema>, unknown>({
      id: "slides.slide.update",
      description: "Update a slide's layout body or speaker notes.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateSlideSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const slide = await store.updateSlide({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          slideId: input.slideId,
          ...(input.content === undefined ? {} : { content: input.content as SlideContent }),
          ...(input.speakerNotes === undefined ? {} : { speakerNotes: input.speakerNotes }),
        });
        if (slide === null) {
          throw new Error(`Unknown Slides slide: ${input.slideId}`);
        }
        await ctx.audit("slides.slide.update", { slideId: slide.id });
        return serializeSlide(slide);
      },
    }),
    defineTool<z.output<typeof deleteSlideSchema>, unknown>({
      id: "slides.slide.delete",
      description: "Delete a slide from its deck.",
      permission: "slides.write",
      sideEffects: "destructive",
      inputSchema: zodToolSchema(deleteSlideSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const deleted = await store.deleteSlide({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          slideId: input.slideId,
        });
        if (!deleted) {
          throw new Error(`Unknown Slides slide: ${input.slideId}`);
        }
        await ctx.audit("slides.slide.delete", { slideId: input.slideId });
        return { slideId: input.slideId, deleted: true };
      },
    }),
    defineTool<z.output<typeof reorderSlidesSchema>, unknown>({
      id: "slides.slide.reorder",
      description: "Reorder every slide in a deck. The id list must be a complete permutation.",
      permission: "slides.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(reorderSlidesSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const slides = await store.reorderSlides({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          deckId: input.deckId,
          slideIds: input.slideIds,
        });
        await ctx.audit("slides.slide.reorder", {
          deckId: input.deckId,
          count: slides.length,
        });
        return { deckId: input.deckId, slides: slides.map(serializeSlide) };
      },
    }),
  ];
}

async function exportSlidesDeck(
  deck: SlideDeckSummaryRecord,
  slides: readonly SlideRecord[],
  format: z.output<typeof exportDeckSchema>["format"],
  comments: readonly DriveCommentListItem[],
): Promise<SlidesPptxExportResult | SlidesPdfExportResult | SlidesImageSeriesExportResult> {
  switch (format) {
    case "pptx":
      return exportSlidesDeckToPptx(deck, slides, comments);
    case "pdf":
      return exportSlidesDeckToPdf(deck, slides, comments);
    case "svg-series":
      return exportSlidesDeckToImageSeries(deck, slides, comments);
  }
}

/**
 * Register the Slides tool surface on the runtime tool registry. Intended to be
 * called from `server.ts` alongside the other `register*` hooks.
 */
export function registerSlidesTools(
  registry: RuntimeToolRegistry,
  options: CreateSlidesToolDefinitionsOptions,
): void {
  for (const tool of createSlidesToolDefinitions(options)) {
    registry.register(tool);
  }
}

/** Alias matching the wiring plan's `registerSlides*` naming. */
export const registerSlides = registerSlidesTools;

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function serializeDeck(deck: SlideDeckSummaryRecord) {
  return {
    id: deck.id,
    orgId: deck.orgId,
    title: deck.title,
    ownerActorId: deck.ownerActorId,
    createdByActorId: deck.createdByActorId,
    slideCount: deck.slideCount,
    metadata: deck.metadata,
    deletedAt: deck.deletedAt?.toISOString() ?? null,
    createdAt: deck.createdAt.toISOString(),
    updatedAt: deck.updatedAt.toISOString(),
  };
}

function serializeVersion(version: SlideDeckVersionRecord) {
  return {
    id: version.id,
    orgId: version.orgId,
    deckId: version.deckId,
    versionNumber: version.versionNumber,
    mimeType: version.mimeType,
    byteSize: version.byteSize,
    sha256: version.sha256,
    metadata: version.metadata,
    createdByActorId: version.createdByActorId,
    createdAt: version.createdAt.toISOString(),
  };
}

function serializeSlide(slide: SlideRecord) {
  return {
    id: slide.id,
    orgId: slide.orgId,
    deckId: slide.deckId,
    position: slide.position,
    layout: slide.layout,
    content: slide.content,
    speakerNotes: slide.speakerNotes,
    revision: slide.revision,
    createdAt: slide.createdAt.toISOString(),
    updatedAt: slide.updatedAt.toISOString(),
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
