import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import type { DriveStore } from "./store.js";
import type { DriveEntryRecord, DriveSearchHit, DriveUploadRecord, DriveVersionRecord } from "./types.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});

const uploadSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: uuidSchema.nullable().optional(),
  mimeType: z.string().min(1).default("application/octet-stream"),
  byteSize: z.number().int().min(0).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
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
});

const shareSchema = z.object({
  objectId: uuidSchema,
  actorIds: z.array(uuidSchema).min(1),
  role: z.enum(["reader", "commenter", "editor", "owner"]).default("reader"),
  expiresAt: z.string().datetime().nullable().optional(),
});

const moveSchema = z.object({
  objectId: uuidSchema,
  folderId: uuidSchema.nullable().optional(),
});

const objectIdSchema = z.object({
  objectId: uuidSchema,
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
}

export function createDriveToolDefinitions(options: CreateDriveToolDefinitionsOptions): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof uploadSchema>, unknown>({
      id: "drive.upload",
      description: "Prepare a Drive file upload and return the target storage key and presigned upload URL when available.",
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
      handler: async (input, ctx) => serializeVersion(await options.store.finalizeUpload({
        orgId: ctx.actor.orgId,
        actorId: ctx.actor.id,
        objectId: input.objectId,
        byteSize: input.byteSize,
        sha256: input.sha256.toLowerCase(),
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        ...(input.storageKey === undefined ? {} : { storageKey: input.storageKey }),
        ...(input.contentBase64 === undefined ? {} : { content: Buffer.from(input.contentBase64, "base64") }),
        metadata: toJsonObject(input.metadata),
      })),
    }),
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "drive.list",
      description: "List Drive files and folders visible to the current actor.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        entries: (await options.store.list({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          folderId: input.folderId ?? null,
          includeTrashed: input.includeTrashed,
          limit: input.limit,
        })).map(serializeEntry),
      }),
    }),
    defineTool<z.output<typeof shareSchema>, unknown>({
      id: "drive.share",
      description: "Share a Drive object with actors by adding platform permission grants.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(shareSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => options.store.share({
        orgId: ctx.actor.orgId,
        actorId: ctx.actor.id,
        objectId: input.objectId,
        targetActorIds: input.actorIds,
        role: input.role,
        expiresAt: input.expiresAt === undefined || input.expiresAt === null ? null : new Date(input.expiresAt),
      }),
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
      handler: async (input, ctx) => ({
        hits: (await options.store.search({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          ...(input.query === undefined ? {} : { query: input.query }),
          folderId: input.folderId ?? null,
          limit: input.limit,
        })).map(serializeSearchHit),
      }),
    }),
  ];
}

export function registerDriveTools(registry: RuntimeToolRegistry, options: CreateDriveToolDefinitionsOptions): void {
  for (const tool of createDriveToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(tool: ToolDefinition<Input, Output>): ToolDefinition<Input, Output> {
  return tool;
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

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
