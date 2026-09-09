// ponytail: tool surface registry >400 LOC; split by domain (upload/access/comments/links) when next feature lands.
import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import type { DriveStore } from "./store.js";
import {
  driveAccessListOutputSchema,
  driveAccessRemoveOutputSchema,
  driveAccessUpdateOutputSchema,
  driveCommentListOutputSchema,
  driveCommentOutputSchema,
  driveCommentRevisionListOutputSchema,
  driveCreateOutputSchema,
  driveDeleteOutputSchema,
  driveDocumentSurfaceViewOutputSchema,
  driveEntryOutputSchema,
  driveFinalizeOutputSchema,
  driveListOutputSchema,
  drivePdfFormStateClearOutputSchema,
  drivePdfFormStateGetOutputSchema,
  drivePdfFormStateOutputSchema,
  driveSearchOutputSchema,
  driveShareLinkListOutputSchema,
  driveShareLinkOutputSchema,
  driveShareLinkRevokeOutputSchema,
  driveShareOutputSchema,
  driveUploadOutputSchema,
  driveVersionOutputSchema,
  driveVersionsListOutputSchema,
  driveWorkflowListOutputSchema,
  driveWorkflowSchema,
} from "./tool-output-schemas.js";
import { BadRequestError, NotFoundError } from "../../api/api-error.js";
import { actorHasScope } from "../../api/scopes.js";
import type {
  DriveAccessGrantRecord,
  DriveEntryRecord,
  DrivePdfFormStateRecord,
  DriveCommentListItem,
  DriveCommentRecord,
  DriveCommentRevisionRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveVersionRecord,
} from "./types.js";
import type { DocsStore } from "../docs/index.js";
import { HELIX_NATIVE_DOCUMENT_ENGINE } from "../docs/native-state.js";
import type { SheetsStore } from "../sheets/index.js";
import type { SlidesStore } from "../slides/index.js";
import {
  driveWorkflowKinds,
  type DriveWorkflowRecord,
  type DriveWorkflowStore,
} from "./workflows.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});

const uploadSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: uuidSchema.nullable().optional(),
  mimeType: z.string().min(1).default("application/octet-stream"),
  byteSize: z.number().int().min(0),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  metadata: metadataSchema,
});

const finalizeSchema = z
  .object({
    objectId: uuidSchema,
    byteSize: z.number().int().min(0),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    mimeType: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    metadata: metadataSchema,
  })
  .strict();

const uploadCompleteSchema = z.object({
  objectId: uuidSchema,
  uploadId: z.string().min(1),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      }),
    )
    .min(1),
  byteSize: z.number().int().min(0),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  mimeType: z.string().min(1).optional(),
  metadata: metadataSchema,
});

const listSchema = z.object({
  folderId: uuidSchema.nullable().optional(),
  includeTrashed: z.boolean().default(false),
  limit: z.number().int().positive().max(250).default(100),
  cursor: z.string().max(2_048).optional(),
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

const removeAccessSchema = z.object({
  objectId: uuidSchema,
  actorId: uuidSchema,
});

const updateAccessSchema = z.object({
  objectId: uuidSchema,
  actorId: uuidSchema,
  role: z.enum(["reader", "commenter", "editor"]),
  expiresAt: z.string().datetime().nullable().optional(),
});

const moveSchema = z.object({
  objectId: uuidSchema,
  folderId: uuidSchema.nullable().optional(),
});

const moveFolderSchema = z.object({
  folderId: uuidSchema,
  parentFolderId: uuidSchema.nullable().optional(),
});

const objectIdSchema = z.object({
  objectId: uuidSchema,
});

const starSchema = z.object({
  objectId: uuidSchema,
  starred: z.boolean(),
});

const documentSurfaceViewSchema = z.enum(["grid", "list"]);
const getDocumentSurfaceViewSchema = z.object({}).strict();
const setDocumentSurfaceViewSchema = z.object({ view: documentSurfaceViewSchema }).strict();

const renameSchema = z.object({
  objectId: uuidSchema,
  name: z.string().min(1).max(255),
});

const revertVersionSchema = z.object({
  objectId: uuidSchema,
  versionNumber: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const createShareLinkSchema = z.object({
  objectId: uuidSchema,
  password: z.string().min(12).max(256).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  oneTime: z.boolean().default(false),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(3).max(253)).max(50).default([]),
  allowDownload: z.boolean().default(true),
});

const revokeShareLinkSchema = z.object({
  linkId: uuidSchema,
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
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const listCommentRevisionsSchema = z.object({
  objectId: uuidSchema,
  cursor: z.string().min(1).max(2_000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
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

const workflowCreateSchema = z
  .object({
    kind: z.enum(driveWorkflowKinds),
    resourceType: z.enum(["object", "folder"]),
    resourceId: uuidSchema,
    assignedToActorId: uuidSchema.optional(),
    assignedToActorRef: z.string().trim().min(1).max(320).optional(),
    payload: metadataSchema,
    dueAt: z.string().datetime().optional(),
  })
  .refine(
    (input) => input.assignedToActorId === undefined || input.assignedToActorRef === undefined,
    {
      message: "Provide an assignee id or email/name, not both.",
      path: ["assignedToActorRef"],
    },
  );
const workflowListSchema = z.object({
  state: z.enum(["open", "approved", "rejected", "cancelled", "completed"]).optional(),
  limit: z.number().int().positive().max(250).default(100),
});
const workflowTransitionSchema = z.object({
  workflowId: uuidSchema,
  expectedVersion: z.string().regex(/^[1-9][0-9]{0,18}$/u),
  state: z.enum(["approved", "rejected", "cancelled", "completed"]),
  payload: metadataSchema,
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
  readonly workflows?: DriveWorkflowStore;
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
      outputSchema: zodToolSchema(driveCreateOutputSchema, genericObjectJsonSchema),
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
              editorEngine: HELIX_NATIVE_DOCUMENT_ENGINE,
              formatVersion: 1,
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
      outputSchema: zodToolSchema(driveUploadOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const record = await options.store.prepareUpload({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          name: input.name,
          folderId: input.folderId ?? null,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
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
      outputSchema: zodToolSchema(driveFinalizeOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeVersion(
          await options.store.finalizeUpload({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            byteSize: input.byteSize,
            ...(input.sha256 === undefined ? {} : { sha256: input.sha256.toLowerCase() }),
            ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            metadata: toJsonObject(input.metadata),
          }),
        ),
    }),
    defineTool<z.output<typeof uploadCompleteSchema>, unknown>({
      id: "drive.upload.complete",
      description:
        "Complete a multipart Drive upload (after PUTting all part URLs) and record the immutable version.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(uploadCompleteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveFinalizeOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.completeMultipartUpload === undefined) {
          throw new Error("drive.upload.complete requires DriveStore.completeMultipartUpload.");
        }
        return serializeVersion(
          await options.store.completeMultipartUpload({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            uploadId: input.uploadId,
            parts: input.parts,
            byteSize: input.byteSize,
            ...(input.sha256 === undefined ? {} : { sha256: input.sha256.toLowerCase() }),
            ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
            metadata: toJsonObject(input.metadata),
          }),
        );
      },
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "drive.list",
      description: "List Drive files and folders visible to the current actor.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveListOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const page = await options.store.list({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          folderId: input.folderId ?? null,
          includeTrashed: input.includeTrashed,
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.app === undefined ? {} : { app: input.app }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.acrossFolders === undefined ? {} : { acrossFolders: input.acrossFolders }),
        });
        const serialized = page.entries.map(serializeEntry);

        // Decorate each entry with the owner's display name so the UI
        // can render "Owned by Avery Park" instead of a raw UUID. Single
        // batched lookup per `drive.list` call.
        if (options.resolveActorNames === undefined) {
          return { entries: serialized, nextCursor: page.nextCursor };
        }
        const ownerIds = Array.from(
          new Set(
            serialized
              .map((e) => e.ownerActorId)
              .filter((id): id is string => typeof id === "string"),
          ),
        );
        if (ownerIds.length === 0) {
          return { entries: serialized, nextCursor: page.nextCursor };
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
        return { entries: enriched, nextCursor: page.nextCursor };
      },
    }),
    defineTool<z.output<typeof shareSchema>, unknown>({
      id: "drive.share",
      description: "Share a Drive object with actors by adding platform permission grants.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(shareSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveShareOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const resolvedActorIds =
          input.actorRefs.length === 0
            ? []
            : await resolveDriveShareActorRefs(options, ctx.actor.orgId, input.actorRefs);
        const actorIds = [...new Set([...input.actorIds, ...resolvedActorIds])];
        if (actorIds.length === 0) {
          throw new BadRequestError("Drive share requires at least one workspace user.");
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
    defineTool<z.output<typeof objectIdSchema>, unknown>({
      id: "drive.access.list",
      description: "List current actor grants for a Drive object.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveAccessListOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.listAccess === undefined) {
          throw new Error("drive.access.list requires DriveStore.listAccess.");
        }
        return {
          grants: (
            await options.store.listAccess({
              orgId: ctx.actor.orgId,
              actorId: ctx.actor.id,
              objectId: input.objectId,
            })
          ).map(serializeAccessGrant),
        };
      },
    }),
    defineTool<z.output<typeof removeAccessSchema>, unknown>({
      id: "drive.access.remove",
      description: "Remove an actor's Drive object access grant.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(removeAccessSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveAccessRemoveOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.removeAccess === undefined) {
          throw new Error("drive.access.remove requires DriveStore.removeAccess.");
        }
        return {
          objectId: input.objectId,
          actorId: input.actorId,
          removed: await options.store.removeAccess({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            targetActorId: input.actorId,
          }),
        };
      },
    }),
    defineTool<z.output<typeof updateAccessSchema>, unknown>({
      id: "drive.access.update",
      description: "Change an actor's Drive object access role.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateAccessSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveAccessUpdateOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.updateAccess === undefined) {
          throw new Error("drive.access.update requires DriveStore.updateAccess.");
        }
        const grant = await options.store.updateAccess({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          targetActorId: input.actorId,
          role: input.role,
          expiresAt:
            input.expiresAt === undefined || input.expiresAt === null
              ? null
              : new Date(input.expiresAt),
        });
        return {
          objectId: input.objectId,
          actorId: input.actorId,
          grant: serializeNullableGrant(grant),
        };
      },
    }),
    defineTool<z.output<typeof moveSchema>, unknown>({
      id: "drive.move",
      description: "Move a Drive file into another folder.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(moveSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveEntryOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const entry = await options.store.move({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          folderId: input.folderId ?? null,
        });
        if (entry === null) {
          throw new NotFoundError(`Unknown movable Drive object: ${input.objectId}`);
        }
        return serializeEntry(entry);
      },
    }),
    defineTool<z.output<typeof moveFolderSchema>, unknown>({
      id: "drive.folder.move",
      description: "Move a Drive folder and its descendants.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(moveFolderSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveEntryOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.moveFolder === undefined) {
          throw new Error("drive.folder.move requires DriveStore.moveFolder.");
        }
        const entry = await options.store.moveFolder({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          folderId: input.folderId,
          parentFolderId: input.parentFolderId ?? null,
        });
        if (entry === null) throw new NotFoundError(`Unknown Drive folder: ${input.folderId}`);
        return serializeEntry(entry);
      },
    }),
    defineTool<z.output<typeof starSchema>, unknown>({
      id: "drive.star.set",
      description: "Star or unstar a Drive file for filtered Drive and app-list views.",
      permission: "drive.read",
      sideEffects: "write",
      inputSchema: zodToolSchema(starSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveEntryOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.setStarred === undefined) {
          throw new Error("drive.star.set requires DriveStore.setStarred.");
        }
        const entry = await options.store.setStarred({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          starred: input.starred,
        });
        if (entry === null) {
          throw new NotFoundError(`Unknown starrable Drive object: ${input.objectId}`);
        }
        return serializeEntry(entry);
      },
    }),
    defineTool<z.output<typeof getDocumentSurfaceViewSchema>, unknown>({
      id: "drive.view.get",
      description: "Get the current member's shared Drive and editor-list layout.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(getDocumentSurfaceViewSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveDocumentSurfaceViewOutputSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => {
        if (options.store.getDocumentSurfaceView === undefined) {
          throw new Error("drive.view.get requires DriveStore.getDocumentSurfaceView.");
        }
        return {
          view: await options.store.getDocumentSurfaceView({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
          }),
        };
      },
    }),
    defineTool<z.output<typeof setDocumentSurfaceViewSchema>, unknown>({
      id: "drive.view.set",
      description: "Set the current member's shared Drive and editor-list layout.",
      permission: "drive.read",
      sideEffects: "write",
      inputSchema: zodToolSchema(setDocumentSurfaceViewSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveDocumentSurfaceViewOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.setDocumentSurfaceView === undefined) {
          throw new Error("drive.view.set requires DriveStore.setDocumentSurfaceView.");
        }
        return {
          view: await options.store.setDocumentSurfaceView({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            view: input.view,
          }),
        };
      },
    }),
    defineTool<z.output<typeof objectIdSchema>, unknown>({
      id: "drive.trash",
      description: "Move a Drive file to trash.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveEntryOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const entry = await options.store.trash({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
        });
        if (entry === null) {
          throw new NotFoundError(`Unknown trashable Drive object: ${input.objectId}`);
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
      outputSchema: zodToolSchema(driveEntryOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const entry = await options.store.restore({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          folderId: input.folderId ?? null,
        });
        if (entry === null) {
          throw new NotFoundError(`Unknown restorable Drive object: ${input.objectId}`);
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
      outputSchema: zodToolSchema(driveDeleteOutputSchema, genericObjectJsonSchema),
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
      outputSchema: zodToolSchema(driveSearchOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        hits: (
          await options.store.search({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.query === undefined ? {} : { query: input.query }),
            folderId: input.folderId ?? null,
            limit: input.limit,
          })
        ).map(serializeSearchHit),
      }),
    }),
    defineTool<z.output<typeof createCommentSchema>, unknown>({
      id: "drive.comment.create",
      description: "Create a page or object anchored comment on a Drive object.",
      permission: "drive.read",
      sideEffects: "write",
      inputSchema: zodToolSchema(createCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveCommentOutputSchema, genericObjectJsonSchema),
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
      outputSchema: zodToolSchema(driveCommentListOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.listComments === undefined) {
          throw new Error("drive.comment tools require DriveStore comment methods.");
        }
        const page = await options.store.listComments({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: input.limit,
        });
        return { comments: page.comments.map(serializeComment), nextCursor: page.nextCursor };
      },
    }),
    defineTool<z.output<typeof listCommentRevisionsSchema>, unknown>({
      id: "drive.comment.evidence.list",
      description: "List immutable Drive comment evidence for an editor.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listCommentRevisionsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveCommentRevisionListOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.listCommentRevisions === undefined) {
          throw new Error("drive.comment evidence requires DriveStore revision methods.");
        }
        const page = await options.store.listCommentRevisions({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          limit: input.limit,
        });
        return {
          revisions: page.revisions.map(serializeCommentRevision),
          nextCursor: page.nextCursor,
        };
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "drive.comment.resolve",
      description: "Resolve a comment on a Drive object.",
      permission: "drive.read",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveCommentOutputSchema, genericObjectJsonSchema),
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
          throw new NotFoundError(`Unknown Drive comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "drive.comment.reopen",
      description: "Reopen a resolved comment on a Drive object.",
      permission: "drive.read",
      sideEffects: "write",
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveCommentOutputSchema, genericObjectJsonSchema),
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
          throw new NotFoundError(`Unknown Drive comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof updateCommentSchema>, unknown>({
      id: "drive.comment.update",
      description: "Update a Drive object comment body.",
      permission: "drive.read",
      sideEffects: "write",
      inputSchema: zodToolSchema(updateCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveCommentOutputSchema, genericObjectJsonSchema),
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
          throw new NotFoundError(`Unknown Drive comment: ${input.commentId}`);
        }
        return serializeComment(comment);
      },
    }),
    defineTool<z.output<typeof resolveCommentSchema>, unknown>({
      id: "drive.comment.delete",
      description: "Delete a comment on a Drive object.",
      permission: "drive.read",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(resolveCommentSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveCommentOutputSchema, genericObjectJsonSchema),
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
          throw new NotFoundError(`Unknown Drive comment: ${input.commentId}`);
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
      outputSchema: zodToolSchema(drivePdfFormStateGetOutputSchema, genericObjectJsonSchema),
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
      outputSchema: zodToolSchema(drivePdfFormStateOutputSchema, genericObjectJsonSchema),
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
      outputSchema: zodToolSchema(drivePdfFormStateClearOutputSchema, genericObjectJsonSchema),
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

    defineTool<z.output<typeof renameSchema>, z.output<typeof driveEntryOutputSchema>>({
      id: "drive.rename",
      description: "Rename a Drive file (updates display name metadata).",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(renameSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveEntryOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.rename === undefined) {
          throw new Error("drive.rename requires DriveStore.rename.");
        }
        const entry = await options.store.rename({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          name: input.name,
        });
        if (entry === null) {
          throw new NotFoundError(`Unknown renamable Drive object: ${input.objectId}`);
        }
        return serializeEntry(entry);
      },
    }),
    defineTool<z.output<typeof objectIdSchema>, z.output<typeof driveVersionsListOutputSchema>>({
      id: "drive.versions.list",
      description: "List version history for a Drive object, newest first.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveVersionsListOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.listVersions === undefined) {
          throw new Error("drive.versions.list requires DriveStore.listVersions.");
        }
        return {
          versions: (
            await options.store.listVersions({
              orgId: ctx.actor.orgId,
              actorId: ctx.actor.id,
              objectId: input.objectId,
            })
          ).map(serializeVersion),
        };
      },
    }),
    defineTool<z.output<typeof revertVersionSchema>, z.output<typeof driveVersionOutputSchema>>({
      id: "drive.versions.revert",
      description:
        "Create a new version that restores bytes from a prior version (history is append-only).",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(revertVersionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveVersionOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.revertToVersion === undefined) {
          throw new Error("drive.versions.revert requires DriveStore.revertToVersion.");
        }
        return serializeVersion(
          await options.store.revertToVersion({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            versionNumber: input.versionNumber,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          }),
        );
      },
    }),
    defineTool<z.output<typeof createShareLinkSchema>, z.output<typeof driveShareLinkOutputSchema>>(
      {
        id: "drive.link.create",
        description: "Create a public/anonymous share link for a Drive object (owner only).",
        permission: "drive.write",
        sideEffects: "write",
        confirmationRequired: true,
        inputSchema: zodToolSchema(createShareLinkSchema, genericObjectJsonSchema),
        outputSchema: zodToolSchema(driveShareLinkOutputSchema, genericObjectJsonSchema),
        handler: async (input, ctx) => {
          if (options.store.createShareLink === undefined) {
            throw new Error("drive.link.create requires DriveStore.createShareLink.");
          }
          return serializeShareLink(
            await options.store.createShareLink({
              orgId: ctx.actor.orgId,
              actorId: ctx.actor.id,
              objectId: input.objectId,
              ...(input.password === undefined ? {} : { password: input.password }),
              expiresAt:
                input.expiresAt === undefined || input.expiresAt === null
                  ? null
                  : new Date(input.expiresAt),
              oneTime: input.oneTime,
              allowedDomains: input.allowedDomains,
              allowDownload: input.allowDownload,
            }),
          );
        },
      },
    ),
    defineTool<z.output<typeof objectIdSchema>, z.output<typeof driveShareLinkListOutputSchema>>({
      id: "drive.link.list",
      description: "List active public share links for a Drive object.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(objectIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveShareLinkListOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.listShareLinks === undefined) {
          throw new Error("drive.link.list requires DriveStore.listShareLinks.");
        }
        return {
          links: (
            await options.store.listShareLinks({
              orgId: ctx.actor.orgId,
              actorId: ctx.actor.id,
              objectId: input.objectId,
            })
          ).map(serializeShareLink),
        };
      },
    }),
    defineTool<
      z.output<typeof revokeShareLinkSchema>,
      z.output<typeof driveShareLinkRevokeOutputSchema>
    >({
      id: "drive.link.revoke",
      description: "Revoke a public share link.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(revokeShareLinkSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveShareLinkRevokeOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.revokeShareLink === undefined) {
          throw new Error("drive.link.revoke requires DriveStore.revokeShareLink.");
        }
        return {
          id: input.linkId,
          revoked: await options.store.revokeShareLink({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            linkId: input.linkId,
          }),
        };
      },
    }),
    defineTool<z.output<typeof workflowCreateSchema>, z.output<typeof driveWorkflowSchema>>({
      id: "drive.workflow.create",
      description:
        "Create a governed Drive shortcut, file request, approval, ownership transfer, shared drive, classification, hold, or investigation.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(workflowCreateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveWorkflowSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.workflows === undefined) throw new Error("Drive workflows are not configured.");
        const assignedToActorId =
          input.assignedToActorRef === undefined
            ? input.assignedToActorId
            : await resolveDriveWorkflowActorRef(
                options,
                ctx.actor.orgId,
                input.assignedToActorRef,
              );
        return serializeWorkflow(
          await options.workflows.create({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            kind: input.kind,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            ...(assignedToActorId === undefined ? {} : { assignedToActorId }),
            payload: toJsonObject(input.payload),
            ...(input.kind === "classification"
              ? { allowSensitivityDowngrade: actorHasScope(ctx.actor, "admin.security") }
              : {}),
            ...(input.dueAt === undefined ? {} : { dueAt: new Date(input.dueAt) }),
          }),
        );
      },
    }),
    defineTool<z.output<typeof workflowListSchema>, z.output<typeof driveWorkflowListOutputSchema>>(
      {
        id: "drive.workflow.list",
        description: "List Drive workflows assigned to or requested by the current user.",
        permission: "drive.read",
        sideEffects: "read",
        inputSchema: zodToolSchema(workflowListSchema, genericObjectJsonSchema),
        outputSchema: zodToolSchema(driveWorkflowListOutputSchema, genericObjectJsonSchema),
        handler: async (input, ctx) => {
          if (options.workflows === undefined)
            throw new Error("Drive workflows are not configured.");
          return {
            workflows: (
              await options.workflows.list({
                orgId: ctx.actor.orgId,
                actorId: ctx.actor.id,
                ...(input.state === undefined ? {} : { state: input.state }),
                limit: input.limit,
              })
            ).map(serializeWorkflow),
          };
        },
      },
    ),
    defineTool<z.output<typeof workflowTransitionSchema>, z.output<typeof driveWorkflowSchema>>({
      id: "drive.workflow.transition",
      description: "Approve, reject, cancel, or complete an assigned Drive workflow.",
      permission: "drive.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(workflowTransitionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(driveWorkflowSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.workflows === undefined) throw new Error("Drive workflows are not configured.");
        return serializeWorkflow(
          await options.workflows.transition({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            workflowId: input.workflowId,
            expectedVersion: input.expectedVersion,
            state: input.state,
            payload: toJsonObject(input.payload),
          }),
        );
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

function serializeWorkflow(workflow: DriveWorkflowRecord): z.output<typeof driveWorkflowSchema> {
  return {
    ...workflow,
    dueAt: workflow.dueAt?.toISOString() ?? null,
    decidedAt: workflow.decidedAt?.toISOString() ?? null,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

async function resolveDriveShareActorRefs(
  options: CreateDriveToolDefinitionsOptions,
  orgId: string,
  refs: readonly string[],
): Promise<readonly string[]> {
  if (options.resolveShareActorRefs === undefined) {
    throw new BadRequestError("Drive share by email or name is not configured.");
  }
  const result = await options.resolveShareActorRefs({ orgId, refs });
  if (result.unresolvedRefs.length > 0) {
    throw new BadRequestError(
      `Could not find workspace user(s): ${result.unresolvedRefs.join(", ")}`,
    );
  }
  return result.actorIds;
}

async function resolveDriveWorkflowActorRef(
  options: CreateDriveToolDefinitionsOptions,
  orgId: string,
  ref: string,
): Promise<string> {
  const actorIds = await resolveDriveShareActorRefs(options, orgId, [ref]);
  const actorId = actorIds[0];
  if (actorIds.length !== 1 || actorId === undefined) {
    throw new BadRequestError("Drive workflow assignee must identify exactly one workspace user.");
  }
  return actorId;
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

function serializeAccessGrant(grant: DriveAccessGrantRecord) {
  return {
    ...grant,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

function serializeNullableGrant(grant: DriveAccessGrantRecord | null) {
  return grant === null ? null : serializeAccessGrant(grant);
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

function serializeCommentRevision(revision: DriveCommentRevisionRecord) {
  return {
    ...revision,
    resolvedAt: revision.resolvedAt?.toISOString() ?? null,
    deletedAt: revision.deletedAt?.toISOString() ?? null,
    capturedAt: revision.capturedAt.toISOString(),
  };
}

function serializeShareLink(link: {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  readonly token: string | null;
  readonly role: "reader";
  readonly expiresAt: Date | null;
  readonly passwordProtected: boolean;
  readonly oneTime: boolean;
  readonly allowedDomains: readonly string[];
  readonly allowDownload: boolean;
  readonly consumedAt: Date | null;
  readonly createdByActorId: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}) {
  return {
    ...link,
    role: link.role,
    allowedDomains: [...link.allowedDomains],
    expiresAt: link.expiresAt?.toISOString() ?? null,
    consumedAt: link.consumedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
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
