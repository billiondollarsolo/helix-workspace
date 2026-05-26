import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import type { DriveStore } from "./store.js";
import type {
  DriveCommentListItem,
  DriveCommentRecord,
  DriveEntryRecord,
  DrivePdfFormStateRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveVersionRecord,
} from "./types.js";
import type { DocsStore } from "../docs/store.js";
import type { SheetsStore } from "../sheets/store.js";
import type { SlidesStore } from "../slides/store.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});

const uploadSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: uuidSchema.nullable().optional(),
  mimeType: z.string().min(1).default("application/octet-stream"),
  byteSize: z.number().int().min(0).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  metadata: metadataSchema,
});

const finalizeSchema = z.object({
  objectId: uuidSchema,
  byteSize: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  mimeType: z.string().min(1).optional(),
  storageKey: z.string().min(1).optional(),
  contentBase64: z.string().min(1).optional(),
  metadata: metadataSchema,
});

const listSchema = z.object({
  folderId: uuidSchema.nullable().optional(),
  includeTrashed: z.boolean().default(false),
  limit: z.number().int().positive().max(250).default(100),
  app: z.string().optional(),
  /** Filter by object kind. Defaults to 'file'. Pass 'recording' for the
   *  Recordings drive scope (meeting recording artifacts). */
  kind: z.enum(["file", "recording"]).optional(),
  /** When true, return every visible file across all folders (folders
   *  themselves are suppressed). The /docs, /sheets, /slides surfaces
   *  use this to present a flat app-shaped list — file in a subfolder
   *  is still a doc/sheet/slide the user should see in those tabs. */
  acrossFolders: z.boolean().optional(),
});

const shareSchema = z
  .object({
    objectId: uuidSchema,
    actorIds: z.array(uuidSchema).default([]),
    actorRefs: z.array(z.string().trim().min(1)).default([]),
    role: z.enum(["reader", "commenter", "editor", "owner"]).default("reader"),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.actorIds.length === 0 && value.actorRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one actor id, email, or display name.",
        path: ["actorRefs"],
      });
    }
  });

const moveSchema = z.object({
  objectId: uuidSchema,
  folderId: uuidSchema.nullable().optional(),
});

const objectIdSchema = z.object({
  objectId: uuidSchema,
});

const createCommentSchema = z.object({
  objectId: uuidSchema,
  parentCommentId: uuidSchema.optional(),
  body: z.string().min(1).max(50_000),
  anchor: metadataSchema,
  metadata: metadataSchema,
});

const listCommentsSchema = z.object({
  objectId: uuidSchema,
  status: z.enum(["open", "resolved", "all"]).optional(),
});

const resolveCommentSchema = z.object({
  commentId: uuidSchema,
});

const updateCommentSchema = z.object({
  commentId: uuidSchema,
  body: z.string().min(1).max(50_000),
});

const pdfFormFieldValueSchema = z.object({
  name: z.string().min(1).max(512),
  type: z.enum(["text", "checkbox", "choice", "signature", "unsupported"]).optional(),
  value: z.union([z.string().max(50_000), z.boolean()]),
});

const savePdfFormStateSchema = z.object({
  objectId: uuidSchema,
  fields: z.array(pdfFormFieldValueSchema).max(2_000),
});

const restoreSchema = z.object({
  objectId: uuidSchema,
  folderId: uuidSchema.nullable().optional(),
});

const searchSchema = z.object({
  query: z.string().optional(),
  folderId: uuidSchema.nullable().optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const createSchema = z.object({
  kind: z.enum(["folder", "document", "spreadsheet", "presentation"]),
  folderId: uuidSchema.nullable().optional(),
  name: z.string().min(1).max(255),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateDriveToolDefinitionsOptions {
  readonly store: DriveStore;
  /**
   * Auto-classifies newly uploaded Drive files (PRD §8.4). When provided, the
   * `drive.upload` handler classifies the prepared file from its name (used as
   * the folder-derivation path). Best-effort: classification never fails the
   * upload.
   */
  readonly classifyResource?: ResourceClassifier;
  /**
   * Docs store — required to handle `drive.create` with `kind:"document"`.
   * When omitted, creating a document via `drive.create` throws.
   */
  readonly docsStore?: Pick<DocsStore, "create">;
  /**
   * Sheets store — required to handle `drive.create` with `kind:"spreadsheet"`.
   * When omitted, creating a spreadsheet via `drive.create` throws.
   */
  readonly sheetsStore?: Pick<SheetsStore, "createSheet">;
  /**
   * Slides store — required to handle `drive.create` with `kind:"presentation"`.
   * When omitted, creating a presentation via `drive.create` throws.
   */
  readonly slidesStore?: Pick<SlidesStore, "createDeck">;
  /**
   * Resolves a batch of actor ids to display names. When provided, the
   * `drive.list` handler stamps each entry with `ownerDisplayName` so the
   * UI can show "Avery Park" / "Leo Whitfield" instead of raw UUIDs in
   * the owner column of file rows. Optional — when omitted, entries
   * just carry `ownerActorId` and the UI falls back to displaying that.
   */
  readonly resolveActorNames?: (
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, { readonly displayName: string; readonly email?: string }>>;
  /** Resolve user-facing share targets such as `maya@helix.local` or
   *  `Maya Sharma` into tenant-scoped actor ids. */
  readonly resolveShareActorRefs?: (input: {
    readonly orgId: string;
    readonly refs: readonly string[];
  }) => Promise<{
    readonly actorIds: readonly string[];
    readonly unresolvedRefs: readonly string[];
  }>;
}

export function createDriveToolDefinitions(
  options: CreateDriveToolDefinitionsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof createSchema>, unknown>({
      id: "drive.create",
      description: "Create a new Drive folder, document, spreadsheet, or presentation.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const { orgId, id: actorId } = ctx.actor;
        const folderId = input.folderId ?? null;
        switch (input.kind) {
          case "folder": {
            const folder = await options.store.createFolder({
              orgId,
              actorId,
              name: input.name,
              ...(folderId !== null ? { parentFolderId: folderId } : {}),
            });
            return serializeEntry(folder);
          }
          case "document": {
            const docsStore = options.docsStore;
            if (docsStore === undefined) {
              throw new Error("drive.create: docsStore is required for kind='document'");
            }
            const doc = await docsStore.create({
              orgId,
              actorId,
              title: input.name,
              folderId,
            });
            return { id: doc.id, app: "docs" };
          }
          case "spreadsheet": {
            const sheetsStore = options.sheetsStore;
            if (sheetsStore === undefined) {
              throw new Error("drive.create: sheetsStore is required for kind='spreadsheet'");
            }
            const sheet = await sheetsStore.createSheet({
              orgId,
              actorId,
              title: input.name,
              folderId,
            });
            return { id: sheet.id, app: "sheets" };
          }
          case "presentation": {
            const slidesStore = options.slidesStore;
            if (slidesStore === undefined) {
              throw new Error("drive.create: slidesStore is required for kind='presentation'");
            }
            const deck = await slidesStore.createDeck({
              orgId,
              actorId,
              title: input.name,
              folderId,
            });
            return { id: deck.id, app: "slides" };
          }
        }
      },
    }),
    defineTool<z.output<typeof uploadSchema>, unknown>({
      id: "drive.upload",
      description:
        "Prepare a Drive file upload and return the target storage key and presigned upload URL when available.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(uploadSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const record = await options.store.prepareUpload({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          name: input.name,
          folderId: input.folderId ?? null,
          mimeType: input.mimeType,
          ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
          ...(input.sha256 === undefined ? {} : { sha256: input.sha256.toLowerCase() }),
          metadata: toJsonObject(input.metadata),
        });
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "drive.file",
          resourceId: record.objectId,
          derivation: { path: record.name },
        });
        return serializeUpload(record);
      },
    }),
    defineTool<z.output<typeof finalizeSchema>, unknown>({
      id: "drive.finalize",
      description: "Finalize a Drive upload by recording immutable version metadata.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(finalizeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeVersion(
          await options.store.finalizeUpload({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            byteSize: input.byteSize,
            sha256: input.sha256.toLowerCase(),
            ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
            ...(input.storageKey === undefined ? {} : { storageKey: input.storageKey }),
            ...(input.contentBase64 === undefined
              ? {}
              : { content: Buffer.from(input.contentBase64, "base64") }),
            metadata: toJsonObject(input.metadata),
          }),
        ),
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "drive.list",
      description: "List Drive files and folders visible to the current actor.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const entries = await options.store.list({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          folderId: input.folderId ?? null,
          includeTrashed: input.includeTrashed,
          limit: input.limit,
          ...(input.app === undefined ? {} : { app: input.app }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.acrossFolders === undefined ? {} : { acrossFolders: input.acrossFolders }),
        });
        const serialized = entries.map(serializeEntry);

        // Decorate each entry with the owner's display name so the UI
        // can render "Owned by Avery Park" instead of a raw UUID. Single
        // batched lookup per `drive.list` call.
        if (options.resolveActorNames === undefined) {
          return { entries: serialized };
        }
        const ownerIds = Array.from(
          new Set(
            serialized
              .map((e) => e.ownerActorId)
              .filter((id): id is string => typeof id === "string"),
          ),
        );
        if (ownerIds.length === 0) {
          return { entries: serialized };
        }
        const names = await options.resolveActorNames(ownerIds);
        const enriched = serialized.map((entry) => {
          const owner = entry.ownerActorId !== null ? names.get(entry.ownerActorId) : undefined;
          if (owner === undefined) return entry;
          return {
            ...entry,
            ownerDisplayName: owner.displayName,
            ...(owner.email === undefined ? {} : { ownerEmail: owner.email }),
          };
        });
        return { entries: enriched };
      },
    }),
    defineTool<z.output<typeof shareSchema>, unknown>({
      id: "drive.share",
      description: "Share a Drive object with actors by id, email, or display name.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(shareSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const resolvedActorIds =
          input.actorRefs.length === 0
            ? []
            : await resolveDriveShareActorRefs(options, ctx.actor.orgId, input.actorRefs);
        const actorIds = [...new Set([...input.actorIds, ...resolvedActorIds])];
        if (actorIds.length === 0) {
          throw new Error("Drive share requires at least one workspace user.");
        }
        return options.store.share({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          targetActorIds: actorIds,
          role: input.role,
          expiresAt:
            input.expiresAt === undefined || input.expiresAt === null
              ? null
              : new Date(input.expiresAt),
        });
      },
    }),
    defineTool<z.output<typeof moveSchema>, unknown>({
      id: "drive.move",
      description: "Move a Drive file into another folder.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(moveSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const entry = await options.store.move({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          folderId: input.folderId ?? null,
        });
        if (entry === null) {
          throw new Error(`Unknown movable Drive object: ${input.objectId}`);
        }
        return serializeEntry(entry);
      },
    }),
    defineTool<z.output<typeof objectIdSchema>, unknown>({
      id: "drive.trash",
      description: "Move a Drive file to trash.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const entry = await options.store.trash({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
        });
        if (entry === null) {
          throw new Error(`Unknown trashable Drive object: ${input.objectId}`);
        }
        return serializeEntry(entry);
      },
    }),
    defineTool<z.output<typeof restoreSchema>, unknown>({
      id: "drive.restore",
      description: "Restore a Drive file from trash.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(restoreSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const entry = await options.store.restore({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          folderId: input.folderId ?? null,
        });
        if (entry === null) {
          throw new Error(`Unknown restorable Drive object: ${input.objectId}`);
        }
        return serializeEntry(entry);
      },
    }),
    defineTool<z.output<typeof objectIdSchema>, unknown>({
      id: "drive.delete",
      description: "Permanently delete a Drive file and its stored versions.",
      permission: "drive.delete",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        deleted: await options.store.delete({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
        }),
      }),
    }),
    defineTool<z.output<typeof searchSchema>, unknown>({
      id: "drive.search",
      description: "Search Drive files visible to the current actor.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(searchSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const hits = (
          await options.store.search({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.query === undefined ? {} : { query: input.query }),
            folderId: input.folderId ?? null,
            limit: input.limit,
          })
        ).map(serializeSearchHit);
        if (options.resolveActorNames === undefined) {
          return { hits };
        }
        const ownerIds = Array.from(
          new Set(
            hits
              .map((hit) => hit.ownerActorId)
              .filter((id): id is string => typeof id === "string"),
          ),
        );
        if (ownerIds.length === 0) {
          return { hits };
        }
        const names = await options.resolveActorNames(ownerIds);
        return {
          hits: hits.map((hit) => {
            const owner = hit.ownerActorId !== null ? names.get(hit.ownerActorId) : undefined;
            if (owner === undefined) return hit;
            return {
              ...hit,
              ownerDisplayName: owner.displayName,
              ...(owner.email === undefined ? {} : { ownerEmail: owner.email }),
            };
          }),
        };
      },
    }),
    defineTool<z.output<typeof createCommentSchema>, unknown>({
      id: "drive.comment.create",
      description: "Create a page or object anchored comment on a Drive object.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.createComment === undefined) {
          throw new Error("drive.comment tools require DriveStore comment methods.");
        }
        return serializeComment(
          await options.store.createComment({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            ...(input.parentCommentId === undefined
              ? {}
              : { parentCommentId: input.parentCommentId }),
            body: input.body,
            anchor: toJsonObject(input.anchor),
            metadata: toJsonObject(input.metadata),
          }),
        );
      },
    }),
    defineTool<z.output<typeof listCommentsSchema>, unknown>({
      id: "drive.comment.list",
      description: "List comments on a Drive object.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listCommentsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.listComments === undefined) {
          throw new Error("drive.comment tools require DriveStore comment methods.");
        }
        return {
          comments: (
            await options.store.listComments({
              orgId: ctx.actor.orgId,
              actorId: ctx.actor.id,
              objectId: input.objectId,
              ...(input.status === undefined ? {} : { status: input.status }),
            })
          ).map(serializeComment),
        };
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "drive.comment.resolve",
      description: "Resolve a comment on a Drive object.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.resolveComment === undefined) {
          throw new Error("drive.comment tools require DriveStore comment methods.");
        }
        const comment = await options.store.resolveComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        });
        if (comment === null) {
          throw new Error(`Unknown Drive comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "drive.comment.reopen",
      description: "Reopen a resolved comment on a Drive object.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.reopenComment === undefined) {
          throw new Error("drive.comment tools require DriveStore comment methods.");
        }
        const comment = await options.store.reopenComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        });
        if (comment === null) {
          throw new Error(`Unknown Drive comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof updateCommentSchema>, unknown>({
      id: "drive.comment.update",
      description: "Update a Drive object comment body.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.updateComment === undefined) {
          throw new Error("drive.comment tools require DriveStore comment methods.");
        }
        const comment = await options.store.updateComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
          body: input.body,
        });
        if (comment === null) {
          throw new Error(`Unknown Drive comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "drive.comment.delete",
      description: "Delete a comment on a Drive object.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.deleteComment === undefined) {
          throw new Error("drive.comment tools require DriveStore comment methods.");
        }
        const comment = await options.store.deleteComment({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          commentId: input.commentId,
        });
        if (comment === null) {
          throw new Error(`Unknown Drive comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof objectIdSchema>, unknown>({
      id: "drive.pdfFormState.get",
      description: "Get the current actor's saved PDF form draft for a Drive object.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.getPdfFormState === undefined) {
          throw new Error("drive.pdfFormState tools require DriveStore PDF form state methods.");
        }
        const state = await options.store.getPdfFormState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
        });
        return { state: state === null ? null : serializePdfFormState(state) };
      },
    }),
    defineTool<z.output<typeof savePdfFormStateSchema>, unknown>({
      id: "drive.pdfFormState.save",
      description: "Save the current actor's PDF form draft for a Drive object.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(savePdfFormStateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.savePdfFormState === undefined) {
          throw new Error("drive.pdfFormState tools require DriveStore PDF form state methods.");
        }
        return serializePdfFormState(
          await options.store.savePdfFormState({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            fieldValues: input.fields.map((field) => toJsonObject(field)),
          }),
        );
      },
    }),
    defineTool<z.output<typeof objectIdSchema>, unknown>({
      id: "drive.pdfFormState.clear",
      description: "Clear the current actor's saved PDF form draft for a Drive object.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.clearPdfFormState === undefined) {
          throw new Error("drive.pdfFormState tools require DriveStore PDF form state methods.");
        }
        return {
          objectId: input.objectId,
          cleared: await options.store.clearPdfFormState({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
          }),
        };
      },
    }),
  ];
}

export function registerDriveTools(
  registry: RuntimeToolRegistry,
  options: CreateDriveToolDefinitionsOptions,
): void {
  for (const tool of createDriveToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

async function resolveDriveShareActorRefs(
  options: CreateDriveToolDefinitionsOptions,
  orgId: string,
  refs: readonly string[],
): Promise<readonly string[]> {
  if (options.resolveShareActorRefs === undefined) {
    throw new Error("Drive share by email or name is not configured.");
  }
  const result = await options.resolveShareActorRefs({ orgId, refs });
  if (result.unresolvedRefs.length > 0) {
    throw new Error(`Could not find workspace user(s): ${result.unresolvedRefs.join(", ")}`);
  }
  return result.actorIds;
}

function serializeUpload(record: DriveUploadRecord) {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function serializeVersion(version: DriveVersionRecord) {
  return {
    ...version,
    createdAt: version.createdAt.toISOString(),
  };
}

function serializeEntry(entry: DriveEntryRecord) {
  return {
    ...entry,
    deletedAt: entry.deletedAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

function serializeSearchHit(hit: DriveSearchHit) {
  return {
    ...hit,
    updatedAt: hit.updatedAt.toISOString(),
  };
}

function serializeComment(comment: DriveCommentRecord | DriveCommentListItem) {
  return {
    ...comment,
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt?.toISOString() ?? null,
  };
}

function serializePdfFormState(state: DrivePdfFormStateRecord) {
  return {
    ...state,
    createdAt: state.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
