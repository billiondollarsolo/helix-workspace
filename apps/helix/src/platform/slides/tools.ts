import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { slideContentSchema } from "./content.js";
import type { SlidesStore } from "./store.js";
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

const createDeckSchema = z.object({
  title: z.string().min(1).max(255),
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
}

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

function serializeSlide(slide: SlideRecord) {
  return {
    id: slide.id,
    orgId: slide.orgId,
    deckId: slide.deckId,
    position: slide.position,
    layout: slide.layout,
    content: slide.content,
    speakerNotes: slide.speakerNotes,
    createdAt: slide.createdAt.toISOString(),
    updatedAt: slide.updatedAt.toISOString(),
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
