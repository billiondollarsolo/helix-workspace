import type {
  AICapability,
  EventBus,
  JsonObject,
  MeteringClient,
  ToolDefinition,
  TraceContext,
} from "@helix/sdk-types";
import { z } from "zod3";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import { HELIX_NATIVE_DOCUMENT_ENGINE } from "./native-state.js";
import { exportDocsDocumentWithProviders, type PdfExportRenderer } from "./export/index.js";
import {
  emitTenantQuotaExceededEvent,
  type TenantHourlyQuotaExceeded,
  type TenantHourlyQuotaLimiter,
} from "../limits/index.js";
import {
  docsExportFormats,
  docsEditorEngines,
  docsSuggestionStatuses,
  type DocsAskHistoryRecord,
  type DocsCommentListItem,
  type DocsCommentRecord,
  type DocsDocumentRecord,
  type DocsExportDocument,
  type DocsExportStore,
  type DocsSuggestionRecord,
  type DocsUpdateRecord,
  type DocsVersionPreviewRecord,
  type DocsVersionRestoreRecord,
} from "./types.js";
import { createDocsSuggestionSlotProviders, docsSuggestionSlotIds } from "./ai/suggestions.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.string(), z.unknown()).default({});
const anchorSchema = z.record(z.string(), z.unknown()).default({});

const createSchema = z.object({
  title: z.string().min(1).max(255),
  initialMarkdown: z.string().max(1_000_000).optional(),
  editorEngine: z.enum(docsEditorEngines).optional(),
  formatVersion: z.number().int().positive().max(100).optional(),
  folderId: uuidSchema.nullable().optional(),
  metadata: metadataSchema,
});

const copySchema = z.object({
  docId: uuidSchema,
  title: z.string().min(1).max(255).optional(),
  folderId: uuidSchema.nullable().optional(),
  metadata: metadataSchema,
});

const updateTitleSchema = z.object({
  docId: uuidSchema,
  title: z.string().min(1).max(255),
});

const nativeDocumentSectionSettingsSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_-]+$/u),
  title: z.string().trim().min(1).max(120).optional(),
  layoutMode: z.enum(["page", "pageless"]).optional(),
  columnCount: z.union([z.literal(1), z.literal(2)]).optional(),
  pageSize: z.enum(["letter", "a4"]).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
});

const updateLayoutSchema = z.object({
  docId: uuidSchema,
  layoutSettings: z.object({
    layoutMode: z.enum(["page", "pageless"]),
    columnCount: z.union([z.literal(1), z.literal(2)]),
    sections: z
      .array(nativeDocumentSectionSettingsSchema)
      .max(24)
      .refine(
        (sections) => new Set(sections.map((section) => section.id)).size === sections.length,
        "Section ids must be unique.",
      )
      .optional(),
  }),
});

const saveNativeStateSchema = z.object({
  docId: uuidSchema,
  stateBase64: z.string().min(1),
  stateVectorBase64: z.string().min(1).optional(),
  metadata: metadataSchema,
});

const migrateNativeSchema = z.object({
  docId: uuidSchema,
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

const importDocxSchema = z.object({
  filename: z.string().min(1).max(255).optional(),
  title: z.string().min(1).max(255).optional(),
  contentBase64: z.string().min(1).max(25_000_000),
  folderId: uuidSchema.nullable().optional(),
  metadata: metadataSchema,
});

const createCommentSchema = z.object({
  docId: uuidSchema,
  parentCommentId: uuidSchema.optional(),
  body: z.string().min(1).max(50_000),
  anchor: anchorSchema,
  metadata: metadataSchema,
});

const listCommentsSchema = z.object({
  docId: uuidSchema,
  status: z.enum(["open", "resolved", "all"]).optional(),
});

const resolveCommentSchema = z.object({
  commentId: uuidSchema,
});

const updateCommentSchema = z.object({
  commentId: uuidSchema,
  body: z.string().min(1).max(50_000),
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

const generateSuggestionSchema = z.object({
  docId: uuidSchema,
  slotId: z.enum(docsSuggestionSlotIds).default("docs.smart-write"),
  selection: z.string().min(1).max(50_000),
  body: z.string().max(50_000).optional(),
  prompt: z.string().max(2_000).optional(),
  targetLanguage: z.string().max(120).optional(),
  classification: z.enum(["public", "standard", "confidential", "restricted"]).optional(),
});

const answerQuestionSchema = z.object({
  docId: uuidSchema,
  question: z.string().trim().min(1).max(2_000),
  selection: z.string().min(1).max(50_000),
  body: z.string().max(50_000).optional(),
  sourceScope: z.enum(["document", "selection"]).default("document"),
  citations: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(160),
        excerpt: z.string().trim().min(1).max(500),
        sourceScope: z.enum(["document", "selection"]),
        selection: z
          .object({
            from: z.number().int().nonnegative(),
            to: z.number().int().positive(),
            text: z.string().trim().min(1).max(50_000),
          })
          .optional(),
      }),
    )
    .max(5)
    .optional(),
});

const listAskHistorySchema = z.object({
  docId: uuidSchema,
  limit: z.number().int().positive().max(50).default(10),
});

const clearAskHistorySchema = z.object({
  docId: uuidSchema,
});

const listVersionsSchema = z.object({
  docId: uuidSchema,
  limit: z.number().int().positive().max(100).default(25),
  beforeSeq: z.number().int().positive().optional(),
});

const nameVersionSchema = z.object({
  versionId: uuidSchema,
  name: z.string().trim().min(1).max(120),
});

const previewVersionSchema = z.object({
  versionId: uuidSchema,
});

const restoreVersionSchema = z.object({
  versionId: uuidSchema,
  expectedCurrentUpdateSeq: z.number().int().nonnegative().optional(),
});

const resolveSuggestionSchema = z.object({
  suggestionId: uuidSchema,
  status: z.enum(["accepted", "rejected"]),
});

const resolveSuggestionsSchema = z.object({
  docId: uuidSchema,
  suggestionIds: z
    .array(uuidSchema)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "suggestionIds must be unique",
    }),
  status: z.enum(["accepted", "rejected"]),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateDocsToolDefinitionsOptions {
  readonly store: DocsToolStore;
  readonly ai?: AICapability | undefined;
  readonly docxToMarkdown?: DocxToMarkdownConverter | undefined;
  readonly pdfRenderer?: PdfExportRenderer | undefined;
  readonly onPdfRendererError?: ((error: unknown) => void) | undefined;
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: ((error: unknown) => void) | undefined;
  readonly exportJobLimiter?: TenantHourlyQuotaLimiter | undefined;
  readonly exportJobLimit?: (input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly docId: string;
    readonly format: string;
  }) => number | null | undefined | Promise<number | null | undefined>;
  readonly quotaEvents?: Pick<EventBus, "publish"> | undefined;
  readonly onQuotaEventError?: ((error: unknown) => void) | undefined;
  /**
   * Auto-classifies newly created documents (PRD §8.4). When provided, the
   * `docs.create` handler classifies the new document from its title and
   * initial content. Best-effort: classification never fails the create.
   */
  readonly classifyResource?: ResourceClassifier;
}

type DocsToolStore = DocsExportStore & {
  readonly create?: unknown;
  readonly copy?: unknown;
  readonly listDocumentsForActor?: unknown;
  readonly updateTitle?: unknown;
  readonly updateLayout?: unknown;
  readonly appendUpdate?: unknown;
  readonly compactDocument?: unknown;
  readonly migrateToNativeDocument?: unknown;
  readonly getDocumentForActor?: unknown;
  readonly createComment?: unknown;
  readonly listComments?: unknown;
  readonly resolveComment?: unknown;
  readonly reopenComment?: unknown;
  readonly updateComment?: unknown;
  readonly deleteComment?: unknown;
  readonly createSuggestion?: unknown;
  readonly listSuggestions?: unknown;
  readonly listVersions?: unknown;
  readonly nameVersion?: unknown;
  readonly previewVersion?: unknown;
  readonly restoreVersion?: unknown;
  readonly resolveSuggestion?: unknown;
  readonly resolveSuggestions?: unknown;
  readonly createAskHistoryItem?: unknown;
  readonly listAskHistory?: unknown;
  readonly clearAskHistory?: unknown;
};

export interface DocxToMarkdownResult {
  readonly markdown: string;
  readonly messages: readonly JsonObject[];
}

export type DocxToMarkdownConverter = (input: {
  readonly buffer: Buffer;
}) => Promise<DocxToMarkdownResult>;

export function createDocsToolDefinitions(
  options: CreateDocsToolDefinitionsOptions,
): readonly ToolDefinition[] {
  const ai = options.ai;
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
          ...(input.editorEngine === undefined ? {} : { editorEngine: input.editorEngine }),
          ...(input.formatVersion === undefined ? {} : { formatVersion: input.formatVersion }),
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
    defineTool<z.output<typeof copySchema>, unknown>({
      id: "docs.copy",
      description: "Copy a Docs document without losing native editor state.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(copySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const document = (await requireStoreMethod(
          options.store,
          "copy",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.folderId === undefined ? {} : { folderId: input.folderId }),
          metadata: toJsonObject(input.metadata),
        })) as DocsDocumentRecord | null;
        if (document === null) {
          throw new Error(`Unknown Docs document: ${input.docId}`);
        }
        return serializeDocument(document);
      },
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
    defineTool<z.output<typeof updateLayoutSchema>, unknown>({
      id: "docs.update-layout",
      description: "Update native Docs layout settings.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateLayoutSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const document = (await requireStoreMethod(
          options.store,
          "updateLayout",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
          layoutSettings: input.layoutSettings,
        })) as DocsDocumentRecord | null;
        if (document === null) {
          throw new Error(`Unknown Docs document: ${input.docId}`);
        }
        return serializeDocument(document);
      },
    }),
    defineTool<z.output<typeof saveNativeStateSchema>, unknown>({
      id: "docs.save-native-state",
      description: "Persist the current native Docs Yjs state and append a version update.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(saveNativeStateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const state = Buffer.from(input.stateBase64, "base64");
        const stateVector =
          input.stateVectorBase64 === undefined
            ? null
            : Buffer.from(input.stateVectorBase64, "base64");
        await requireStoreMethod(
          options.store,
          "appendUpdate",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
          update: state,
          metadata: {
            ...input.metadata,
            stateBase64: input.stateBase64,
          },
        });
        const document = (await requireStoreMethod(
          options.store,
          "compactDocument",
        )({
          orgId: ctx.actor.orgId,
          documentId: input.docId,
          state,
          stateVector,
        })) as DocsDocumentRecord | null;
        if (document === null) {
          throw new Error(`Unknown Docs document: ${input.docId}`);
        }
        return serializeDocument(document);
      },
    }),
    defineTool<z.output<typeof migrateNativeSchema>, unknown>({
      id: "docs.migrate-native",
      description: "Migrate a legacy Docs document into the native document editor format.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(migrateNativeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const document = (await requireStoreMethod(
          options.store,
          "migrateToNativeDocument",
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
      description: "Export a Docs document as Markdown, PDF, DOCX, or EPUB.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(exportSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        await consumeExportJobQuota({
          limiter: options.exportJobLimiter,
          limit: options.exportJobLimit,
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          docId: input.docId,
          format: input.format,
          events: options.quotaEvents,
          onEventError: options.onQuotaEventError,
          trace: traceFromToolRequest(ctx.request),
        });
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
        const exported = await exportDocsDocumentWithProviders(
          {
            document,
            format: input.format,
            includeComments: input.includeComments,
            ...(input.filename === undefined ? {} : { filename: input.filename }),
          },
          {
            ...(options.pdfRenderer === undefined ? {} : { pdfRenderer: options.pdfRenderer }),
            ...(options.onPdfRendererError === undefined
              ? {}
              : { onPdfRendererError: options.onPdfRendererError }),
          },
        );
        emitDocsExportMetering({
          metering: options.metering,
          onMeteringError: options.onMeteringError,
          orgId: ctx.actor.orgId,
          format: exported.format,
          byteSize: exported.byteSize,
          trace: traceFromToolRequest(ctx.request),
        });
        return exported;
      },
    }),
    defineTool<z.output<typeof importDocxSchema>, unknown>({
      id: "docs.import-docx",
      description: "Import a DOCX file into a native Docs document.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(importDocxSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const converter = options.docxToMarkdown ?? convertDocxToMarkdown;
        const bytes = Buffer.from(input.contentBase64, "base64");
        if (bytes.length === 0) {
          throw new Error("DOCX import content is empty.");
        }
        const imported = await converter({ buffer: bytes });
        // Mammoth inlines embedded images as `![alt](data:image/...;base64,…)`.
        // EMF/WMF blobs can be 50KB+ as a single unbroken token, which the
        // markdown→native renderer then emits as a horizontal wall of text.
        // Replace the data: URI portion with a clean placeholder so the doc
        // body stays readable. A follow-up will upload the bytes as real
        // image attachments and link them by drive-object ref.
        const sanitizedMarkdown = stripInlineDataUriImages(imported.markdown);
        const sourceFormat = docsImportSourceFormat(input.filename);
        const title =
          input.title?.trim() || titleFromFilename(input.filename) || "Imported document";
        const metadata = toJsonObject({
          ...input.metadata,
          importedFrom: sourceFormat,
          ...(input.filename === undefined
            ? {}
            : { filename: input.filename, sourceFilename: input.filename }),
          importMessages: imported.messages,
        });
        const document = (await requireStoreMethod(
          options.store,
          "create",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          title,
          initialMarkdown: sanitizedMarkdown,
          editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
          formatVersion: 1,
          folderId: input.folderId ?? null,
          metadata,
        })) as DocsDocumentRecord;
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "docs.document",
          resourceId: document.id,
          derivation: {
            content: `${title}\n${imported.markdown}`,
            scanContent: true,
          },
        });
        return serializeDocument(document);
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
            ...(input.parentCommentId === undefined
              ? {}
              : { parentCommentId: input.parentCommentId }),
            body: input.body,
            anchor: toJsonObject(input.anchor),
            metadata: toJsonObject(input.metadata),
          })) as DocsCommentRecord,
        ),
    }),
    defineTool<z.output<typeof listCommentsSchema>, unknown>({
      id: "docs.comment.list",
      description: "List Docs document comments.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listCommentsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        comments: (
          (await requireStoreMethod(
            options.store,
            "listComments",
          )({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            documentId: input.docId,
            status: input.status ?? "open",
          })) as readonly DocsCommentListItem[]
        ).map(serializeComment),
      }),
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "docs.comment.resolve",
      description: "Resolve a Docs document comment.",
      permission: "docs.comment",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = (await requireStoreMethod(
          options.store,
          "resolveComment",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        })) as DocsCommentRecord | null;
        return comment === null ? { ok: false } : serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "docs.comment.reopen",
      description: "Reopen a resolved Docs document comment.",
      permission: "docs.comment",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = (await requireStoreMethod(
          options.store,
          "reopenComment",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        })) as DocsCommentRecord | null;
        return comment === null ? { ok: false } : serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof updateCommentSchema>, unknown>({
      id: "docs.comment.update",
      description: "Update a Docs document comment body.",
      permission: "docs.comment",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = (await requireStoreMethod(
          options.store,
          "updateComment",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
          body: input.body,
        })) as DocsCommentRecord | null;
        return comment === null ? { ok: false } : serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "docs.comment.delete",
      description: "Delete a Docs document comment.",
      permission: "docs.comment",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const comment = (await requireStoreMethod(
          options.store,
          "deleteComment",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        })) as DocsCommentRecord | null;
        return comment === null ? { ok: false } : serializeComment(comment);
      },
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
    ...(ai === undefined
      ? []
      : [
          defineTool<z.output<typeof generateSuggestionSchema>, unknown>({
            id: "docs.suggestion.generate",
            description:
              "Generate AI-assisted replacement text for a Docs tracked-change suggestion.",
            permission: "docs.comment",
            sideEffects: "read",
            inputSchema: zodToolSchema(generateSuggestionSchema, genericObjectJsonSchema),
            outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
            handler: async (input, ctx) => {
              const document = (await requireStoreMethod(
                options.store,
                "getDocsExportDocument",
              )({
                orgId: ctx.actor.orgId,
                actorId: ctx.actor.id,
                docId: input.docId,
              })) as DocsExportDocument | null;
              if (document === null) {
                throw new Error(`Unknown Docs document: ${input.docId}`);
              }
              const provider = createDocsSuggestionSlotProviders({ ai }).find(
                (candidate) => candidate.slotId === input.slotId,
              );
              if (provider === undefined) {
                throw new Error(`Unknown Docs suggestion slot: ${input.slotId}`);
              }
              const providerInput = toJsonObject({
                title: document.title,
                outline: document.outline ?? [],
                selection: input.selection,
                ...(input.body === undefined
                  ? (document.markdown ?? document.plainText) === undefined
                    ? {}
                    : { body: document.markdown ?? document.plainText }
                  : { body: input.body }),
                ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
                ...(input.targetLanguage === undefined
                  ? {}
                  : { targetLanguage: input.targetLanguage }),
                ...(input.classification === undefined
                  ? {}
                  : { classification: input.classification }),
              });
              const context = {
                actor: ctx.actor,
                feature: input.slotId,
                resource: { type: "docs.document", id: input.docId, orgId: ctx.actor.orgId },
                input: providerInput,
              };
              if (!(await provider.available(context))) {
                throw new Error(`Docs suggestion slot is unavailable: ${input.slotId}`);
              }
              const generated = await collectSuggestionChunks(provider.generate(context));
              return {
                slotId: input.slotId,
                text: generated.text,
                metadata: generated.metadata,
              };
            },
          }),
          defineTool<z.output<typeof answerQuestionSchema>, unknown>({
            id: "docs.ask.answer",
            description: "Answer a question about a Docs document and save it to ask history.",
            permission: "docs.comment",
            sideEffects: "write",
            inputSchema: zodToolSchema(answerQuestionSchema, genericObjectJsonSchema),
            outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
            handler: async (input, ctx) => {
              const document = (await requireStoreMethod(
                options.store,
                "getDocsExportDocument",
              )({
                orgId: ctx.actor.orgId,
                actorId: ctx.actor.id,
                docId: input.docId,
              })) as DocsExportDocument | null;
              if (document === null) {
                throw new Error(`Unknown Docs document: ${input.docId}`);
              }
              const provider = createDocsSuggestionSlotProviders({ ai }).find(
                (candidate) => candidate.slotId === "docs.ask-document",
              );
              if (provider === undefined) {
                throw new Error("Unknown Docs suggestion slot: docs.ask-document");
              }
              const providerInput = toJsonObject({
                title: document.title,
                outline: document.outline ?? [],
                selection: input.selection,
                ...(input.body === undefined
                  ? (document.markdown ?? document.plainText) === undefined
                    ? {}
                    : { body: document.markdown ?? document.plainText }
                  : { body: input.body }),
                prompt: input.question,
              });
              const context = {
                actor: ctx.actor,
                feature: "docs.ask-document",
                resource: { type: "docs.document", id: input.docId, orgId: ctx.actor.orgId },
                input: providerInput,
              };
              if (!(await provider.available(context))) {
                throw new Error("Docs suggestion slot is unavailable: docs.ask-document");
              }
              const generated = await collectSuggestionChunks(provider.generate(context));
              const historyItem = (await requireStoreMethod(
                options.store,
                "createAskHistoryItem",
              )({
                orgId: ctx.actor.orgId,
                actorId: ctx.actor.id,
                documentId: input.docId,
                question: input.question,
                answer: generated.text,
                sourceScope: input.sourceScope,
                sourceExcerpt: sourceExcerpt(input.selection),
                metadata: toJsonObject({
                  providerId: generated.metadata.providerId,
                  model: generated.metadata.model,
                  finishReason: generated.metadata.finishReason,
                  ...(input.citations === undefined ? {} : { citations: input.citations }),
                }),
              })) as DocsAskHistoryRecord;
              return serializeAskHistory(historyItem);
            },
          }),
        ]),
    defineTool<z.output<typeof listAskHistorySchema>, unknown>({
      id: "docs.ask.history.list",
      description: "List saved Ask-this-document answers for the current actor.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listAskHistorySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        history: (
          (await requireStoreMethod(
            options.store,
            "listAskHistory",
          )({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            documentId: input.docId,
            limit: input.limit,
          })) as readonly DocsAskHistoryRecord[]
        ).map(serializeAskHistory),
      }),
    }),
    defineTool<z.output<typeof clearAskHistorySchema>, unknown>({
      id: "docs.ask.history.clear",
      description: "Clear saved Ask-this-document answers for the current actor.",
      permission: "docs.read",
      sideEffects: "write",
      inputSchema: zodToolSchema(clearAskHistorySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        deleted: (await requireStoreMethod(
          options.store,
          "clearAskHistory",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
        })) as number,
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
    defineTool<z.output<typeof resolveSuggestionsSchema>, unknown>({
      id: "docs.suggestion.resolve-batch",
      description:
        "Accept or reject multiple Docs suggestions in one atomic batch. Accepting applies proposed edits.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveSuggestionsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const suggestions = (await requireStoreMethod(
          options.store,
          "resolveSuggestions",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
          suggestionIds: input.suggestionIds,
          status: input.status,
        })) as readonly DocsSuggestionRecord[] | null;
        if (suggestions === null) {
          throw new Error(`Unknown Docs suggestions for document: ${input.docId}`);
        }
        return {
          suggestions: suggestions.map(serializeSuggestion),
          count: suggestions.length,
        };
      },
    }),
    defineTool<z.output<typeof listVersionsSchema>, unknown>({
      id: "docs.version.list",
      description: "List saved update versions for a Docs document.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listVersionsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const rows = (await requireStoreMethod(
          options.store,
          "listVersions",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          documentId: input.docId,
          limit: input.limit + 1,
          beforeSeq: input.beforeSeq,
        })) as readonly DocsUpdateRecord[];
        const versions = rows.slice(0, input.limit);
        const nextBeforeSeq = rows.length > input.limit ? (versions.at(-1)?.seq ?? null) : null;
        return {
          versions: versions.map(serializeVersion),
          nextBeforeSeq,
        };
      },
    }),
    defineTool<z.output<typeof nameVersionSchema>, unknown>({
      id: "docs.version.rename",
      description: "Name a saved Docs update so users can recognize important revisions.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(nameVersionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const version = (await requireStoreMethod(
          options.store,
          "nameVersion",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          versionId: input.versionId,
          name: input.name,
        })) as DocsUpdateRecord | null;
        if (version === null) {
          throw new Error(`Unknown Docs version: ${input.versionId}`);
        }
        return serializeVersion(version);
      },
    }),
    defineTool<z.output<typeof previewVersionSchema>, unknown>({
      id: "docs.version.preview",
      description: "Preview a saved Docs update against the current document text.",
      permission: "docs.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(previewVersionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const preview = (await requireStoreMethod(
          options.store,
          "previewVersion",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          versionId: input.versionId,
        })) as DocsVersionPreviewRecord | null;
        if (preview === null) {
          throw new Error(`Unknown Docs version: ${input.versionId}`);
        }
        return serializeVersionPreview(preview);
      },
    }),
    defineTool<z.output<typeof restoreVersionSchema>, unknown>({
      id: "docs.version.restore",
      description: "Restore a Docs document to a complete saved version preview.",
      permission: "docs.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(restoreVersionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const restored = (await requireStoreMethod(
          options.store,
          "restoreVersion",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          versionId: input.versionId,
          expectedCurrentUpdateSeq: input.expectedCurrentUpdateSeq,
        })) as DocsVersionRestoreRecord | null;
        if (restored === null) {
          throw new Error(`Unknown Docs version: ${input.versionId}`);
        }
        return serializeVersionRestore(restored);
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

async function consumeExportJobQuota(input: {
  readonly limiter?: TenantHourlyQuotaLimiter | undefined;
  readonly limit?: CreateDocsToolDefinitionsOptions["exportJobLimit"];
  readonly orgId: string;
  readonly actorId: string;
  readonly docId: string;
  readonly format: string;
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onEventError?: ((error: unknown) => void) | undefined;
  readonly trace?: TraceContext | undefined;
}): Promise<void> {
  if (input.limiter === undefined || input.limit === undefined) {
    return;
  }
  const limit = await input.limit({
    orgId: input.orgId,
    actorId: input.actorId,
    docId: input.docId,
    format: input.format,
  });
  const decision = await input.limiter.consume({
    orgId: input.orgId,
    quota: "export_jobs_per_hour",
    limit: limit ?? null,
  });
  if (!decision.allowed) {
    emitTenantQuotaExceededEvent({
      events: input.events,
      onError: input.onEventError,
      subject: "quota.export_jobs.exceeded",
      orgId: input.orgId,
      surface: "docs.export",
      decision,
      trace: input.trace,
      metadata: {
        format: input.format,
      },
    });
    throw new DocsExportQuotaExceededError(decision);
  }
}

class DocsExportQuotaExceededError extends Error {
  readonly statusCode = 429;
  readonly retryAfterSeconds: number;
  readonly quotaLimit: {
    readonly quota: string;
    readonly limit: number;
    readonly used: number;
    readonly remaining: 0;
    readonly retryAfterSeconds: number;
    readonly resetsAt: string;
  };

  constructor(decision: TenantHourlyQuotaExceeded) {
    super("Tenant export job quota exceeded.");
    this.name = "DocsExportQuotaExceededError";
    this.retryAfterSeconds = decision.retryAfterSeconds;
    this.quotaLimit = {
      quota: decision.quota,
      limit: decision.limit,
      used: decision.used,
      remaining: decision.remaining,
      retryAfterSeconds: decision.retryAfterSeconds,
      resetsAt: decision.resetsAt,
    };
  }
}

function emitDocsExportMetering(input: {
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: ((error: unknown) => void) | undefined;
  readonly orgId: string;
  readonly format: string;
  readonly byteSize: number;
  readonly trace?: TraceContext | undefined;
}): void {
  void input.metering
    ?.emit(
      input.orgId,
      {
        type: "export.completed",
        quantity: 1,
        metadata: {
          format: input.format,
          byte_size: input.byteSize,
        },
      },
      input.trace,
    )
    .catch((error: unknown) => {
      input.onMeteringError?.(error);
    });
}

function traceFromToolRequest(
  request: { readonly traceId?: string; readonly spanId?: string } | undefined,
): TraceContext | undefined {
  if (request?.traceId === undefined && request?.spanId === undefined) {
    return undefined;
  }
  return {
    ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
    ...(request.spanId === undefined ? {} : { spanId: request.spanId }),
  };
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

async function convertDocxToMarkdown(input: {
  readonly buffer: Buffer;
}): Promise<DocxToMarkdownResult> {
  const mammothModule = (await import("mammoth")) as unknown as {
    readonly default?: {
      readonly convertToMarkdown: MammothConvertToMarkdown;
    };
    readonly convertToMarkdown: MammothConvertToMarkdown;
  };
  const mammoth = mammothModule.default ?? mammothModule;
  const result = await mammoth.convertToMarkdown({ buffer: input.buffer });
  return {
    markdown: result.value.trim(),
    messages: result.messages.map((message) =>
      toJsonObject({
        type: message.type,
        message: message.message,
      }),
    ),
  };
}

type MammothConvertToMarkdown = (input: { readonly buffer: Buffer }) => Promise<{
  readonly value: string;
  readonly messages: readonly {
    readonly type?: string | undefined;
    readonly message?: string | undefined;
  }[];
}>;

function titleFromFilename(filename: string | undefined): string | undefined {
  const trimmed = filename?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed.replace(/\.(docx?|docm|dotx|dotm|rtf|odt)$/iu, "").trim() || undefined;
}

function docsImportSourceFormat(filename: string | undefined): string {
  const extension = /\.([^.\\/]+)$/u.exec(filename?.trim() ?? "")?.[1]?.toLowerCase();
  switch (extension) {
    case "docx":
    case "docm":
    case "dotx":
    case "dotm":
    case "rtf":
    case "odt":
      return extension;
    default:
      return "docx";
  }
}

/** Replace `![alt](data:image/...;base64,…)` in markdown with a clean
 *  placeholder. Mammoth emits one of these per embedded DOCX image; EMF/WMF
 *  blobs can be 50KB+ unbroken which renders as a horizontal text wall. We
 *  drop the data URI entirely and keep the alt text so the doc reads cleanly.
 *  Real image preservation lands when the importer uploads each blob as a
 *  drive object and rewrites the markdown to reference its object id. */
export function stripInlineDataUriImages(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(data:[^)]+\)/gu, (_, altRaw: string) => {
    const alt = altRaw.trim();
    return alt.length > 0 ? `_[Image: ${alt}]_` : "_[Embedded image]_";
  });
}

function serializeVersion(update: DocsUpdateRecord) {
  return {
    id: update.id,
    orgId: update.orgId,
    documentId: update.documentId,
    actorId: update.actorId ?? null,
    seq: update.seq,
    byteSize: update.update.byteLength,
    metadata: update.metadata,
    createdAt: update.createdAt.toISOString(),
  };
}

function serializeVersionPreview(preview: DocsVersionPreviewRecord) {
  return {
    version: serializeVersion(preview.version),
    documentId: preview.documentId,
    currentUpdateSeq: preview.currentUpdateSeq,
    currentText: preview.currentText,
    versionText: preview.versionText,
    completeness: preview.completeness,
    complete: preview.complete,
    appliedCount: preview.appliedCount,
    skippedCount: preview.skippedCount,
    diff: preview.diff,
    warnings: preview.warnings,
  };
}

function serializeVersionRestore(restored: DocsVersionRestoreRecord) {
  return {
    document: serializeDocument(restored.document),
    restoredVersion: serializeVersion(restored.restoredVersion),
    restoreVersion: serializeVersion(restored.restoreVersion),
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

function serializeAskHistory(item: DocsAskHistoryRecord) {
  return {
    ...item,
    createdAt: dateToIso(item.createdAt) ?? new Date().toISOString(),
    updatedAt: dateToIso(item.updatedAt) ?? null,
  };
}

function sourceExcerpt(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

async function collectSuggestionChunks(
  chunks: AsyncIterable<{ readonly text: string; readonly metadata?: JsonObject | undefined }>,
): Promise<{ readonly text: string; readonly metadata: JsonObject }> {
  const text: string[] = [];
  let metadata: JsonObject = {};
  for await (const chunk of chunks) {
    text.push(chunk.text);
    if (chunk.metadata !== undefined) {
      metadata = { ...metadata, ...chunk.metadata };
    }
  }
  return { text: text.join(""), metadata };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function requireStoreMethod(
  store: DocsToolStore,
  name: keyof DocsToolStore,
): (input: unknown) => Promise<unknown> {
  const method: unknown = Reflect.get(store, name);
  if (typeof method !== "function") {
    throw new Error(`Docs store does not implement ${name}.`);
  }
  return async (input: unknown) => Reflect.apply(method, store, [input]) as Promise<unknown>;
}

function dateToIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}
