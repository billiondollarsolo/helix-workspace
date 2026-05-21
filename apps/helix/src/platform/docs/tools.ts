import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import { exportDocsDocument } from "./export/index.js";
import {
  docsExportFormats,
  docsSuggestionStatuses,
  type DocsCommentRecord,
  type DocsDocumentRecord,
  type DocsExportStore,
  type DocsSuggestionRecord,
} from "./types.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});
const anchorSchema = z.record(z.unknown()).default({});

const createSchema = z.object({
  title: z.string().min(1).max(255),
  initialMarkdown: z.string().max(1_000_000).optional(),
  folderId: uuidSchema.nullable().optional(),
  metadata: metadataSchema,
});

const updateTitleSchema = z.object({
  docId: uuidSchema,
  title: z.string().min(1).max(255),
});

const getSchema = z.object({
  docId: uuidSchema,
});

const listSchema = z.object({
  query: z.string().max(512).optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const exportSchema = z.object({
  docId: uuidSchema,
  format: z.enum(docsExportFormats).default("markdown"),
  includeComments: z.boolean().default(false),
  filename: z.string().min(1).max(255).optional(),
});

const createCommentSchema = z.object({
  docId: uuidSchema,
  body: z.string().min(1).max(50_000),
  anchor: anchorSchema,
  metadata: metadataSchema,
});

const createSuggestionSchema = z.object({
  docId: uuidSchema,
  beforeText: z.string().min(1).max(50_000),
  afterText: z.string().max(50_000),
  reason: z.string().max(2_000).optional(),
  anchor: anchorSchema,
  metadata: metadataSchema,
});

const listSuggestionsSchema = z.object({
  docId: uuidSchema,
  status: z.enum(docsSuggestionStatuses).optional(),
});

const resolveSuggestionSchema = z.object({
  suggestionId: uuidSchema,
  status: z.enum(["accepted", "rejected"]),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateDocsToolDefinitionsOptions {
  readonly store: DocsToolStore;
  /**
   * Auto-classifies newly created documents (PRD §8.4). When provided, the
   * `docs.create` handler classifies the new document from its title and
   * initial content. Best-effort: classification never fails the create.
   */
  readonly classifyResource?: ResourceClassifier;
}

type DocsToolStore = DocsExportStore & {
  readonly create?: unknown;
  readonly listDocumentsForActor?: unknown;
  readonly updateTitle?: unknown;
  readonly getDocumentForActor?: unknown;
  readonly createComment?: unknown;
  readonly createSuggestion?: unknown;
  readonly listSuggestions?: unknown;
  readonly resolveSuggestion?: unknown;
};

export function createDocsToolDefinitions(
  options: CreateDocsToolDefinitionsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof createSchema>, unknown>({
      id: "docs.create",
      description: "Create a Docs document.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const document = (await requireStoreMethod(
          options.store,
          "create",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title: input.title,
          ...(input.initialMarkdown === undefined
            ? {}
            : { initialMarkdown: input.initialMarkdown }),
          folderId: input.folderId ?? null,
          metadata: toJsonObject(input.metadata),
        })) as DocsDocumentRecord;
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "docs.document",
          resourceId: document.id,
          derivation: {
            content: `${input.title}\n${input.initialMarkdown ?? ""}`,
            scanContent: true,
          },
        });
        return serializeDocument(document);
      },
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "docs.list",
      description: "List Docs documents visible to the current actor.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        documents: (
          (await requireStoreMethod(
            options.store,
            "listDocumentsForActor",
          )({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.query === undefined ? {} : { query: input.query }),
            limit: input.limit,
          })) as readonly DocsDocumentRecord[]
        ).map(serializeDocument),
      }),
    }),
    defineTool<z.output<typeof updateTitleSchema>, unknown>({
      id: "docs.update-title",
      description: "Update a Docs document title.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateTitleSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const document = (await requireStoreMethod(
          options.store,
          "updateTitle",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
          title: input.title,
        })) as DocsDocumentRecord | null;
        if (document === null) {
          throw new Error(`Unknown Docs document: ${input.docId}`);
        }
        return serializeDocument(document);
      },
    }),
    defineTool<z.output<typeof getSchema>, unknown>({
      id: "docs.get",
      description: "Get a Docs document the actor can read.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(getSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const document = (await requireStoreMethod(
          options.store,
          "getDocumentForActor",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
        })) as DocsDocumentRecord | null;
        if (document === null) {
          throw new Error(`Unknown Docs document: ${input.docId}`);
        }
        return serializeDocument(document);
      },
    }),
    defineTool<z.output<typeof exportSchema>, unknown>({
      id: "docs.export",
      description: "Export a Docs document as Markdown, PDF, or DOCX.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(exportSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.getDocsExportDocument === undefined) {
          throw new Error("Docs store does not implement getDocsExportDocument.");
        }
        const document = await options.store.getDocsExportDocument({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          docId: input.docId,
        });
        if (document === null) {
          throw new Error(`Unknown Docs document: ${input.docId}`);
        }
        return exportDocsDocument({
          document,
          format: input.format,
          includeComments: input.includeComments,
          ...(input.filename === undefined ? {} : { filename: input.filename }),
        });
      },
    }),
    defineTool<z.output<typeof createCommentSchema>, unknown>({
      id: "docs.comment.create",
      description: "Create a Docs document comment.",
      permission: "docs.comment",
      sideEffects: "write",
      inputSchema: zodToolSchema(createCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeComment(
          (await requireStoreMethod(
            options.store,
            "createComment",
          )({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            documentId: input.docId,
            body: input.body,
            anchor: toJsonObject(input.anchor),
            metadata: toJsonObject(input.metadata),
          })) as DocsCommentRecord,
        ),
    }),
    defineTool<z.output<typeof createSuggestionSchema>, unknown>({
      id: "docs.suggestion.create",
      description: "Propose a tracked-change edit (suggestion) on a Docs document.",
      permission: "docs.comment",
      sideEffects: "write",
      inputSchema: zodToolSchema(createSuggestionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeSuggestion(
          (await requireStoreMethod(
            options.store,
            "createSuggestion",
          )({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            documentId: input.docId,
            beforeText: input.beforeText,
            afterText: input.afterText,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            anchor: toJsonObject(input.anchor),
            metadata: toJsonObject(input.metadata),
          })) as DocsSuggestionRecord,
        ),
    }),
    defineTool<z.output<typeof listSuggestionsSchema>, unknown>({
      id: "docs.suggestion.list",
      description: "List proposed edits (suggestions) on a Docs document.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSuggestionsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        suggestions: (
          (await requireStoreMethod(
            options.store,
            "listSuggestions",
          )({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            documentId: input.docId,
            ...(input.status === undefined ? {} : { status: input.status }),
          })) as readonly DocsSuggestionRecord[]
        ).map(serializeSuggestion),
      }),
    }),
    defineTool<z.output<typeof resolveSuggestionSchema>, unknown>({
      id: "docs.suggestion.resolve",
      description: "Accept or reject a Docs suggestion. Accepting applies the proposed edit.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveSuggestionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const suggestion = (await requireStoreMethod(
          options.store,
          "resolveSuggestion",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          suggestionId: input.suggestionId,
          status: input.status,
        })) as DocsSuggestionRecord | null;
        if (suggestion === null) {
          throw new Error(`Unknown Docs suggestion: ${input.suggestionId}`);
        }
        return serializeSuggestion(suggestion);
      },
    }),
  ];
}

export function registerDocsTools(
  registry: RuntimeToolRegistry,
  options: CreateDocsToolDefinitionsOptions,
): void {
  for (const tool of createDocsToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function serializeDocument(document: DocsDocumentRecord) {
  return {
    ...document,
    ydocState: document.ydocState?.toString("base64") ?? null,
    ydocStateVector: document.ydocStateVector?.toString("base64") ?? null,
    deletedAt: document.deletedAt?.toISOString() ?? null,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function serializeComment(comment: DocsCommentRecord) {
  return {
    ...comment,
    resolvedAt: dateToIso(comment.resolvedAt) ?? null,
    createdAt: dateToIso(comment.createdAt) ?? new Date().toISOString(),
    updatedAt: dateToIso(comment.updatedAt) ?? null,
  };
}

function serializeSuggestion(suggestion: DocsSuggestionRecord) {
  return {
    ...suggestion,
    resolvedAt: dateToIso(suggestion.resolvedAt) ?? null,
    createdAt: dateToIso(suggestion.createdAt) ?? new Date().toISOString(),
    updatedAt: dateToIso(suggestion.updatedAt) ?? null,
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function requireStoreMethod(
  store: DocsToolStore,
  name: keyof DocsToolStore,
): (input: unknown) => Promise<unknown> {
  const method = store[name];
  if (typeof method !== "function") {
    throw new Error(`Docs store does not implement ${name}.`);
  }
  return async (input: unknown) => method.call(store, input) as Promise<unknown>;
}

function dateToIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}
