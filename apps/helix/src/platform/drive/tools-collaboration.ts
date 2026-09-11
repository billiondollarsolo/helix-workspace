import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { driveEntryOutputSchema } from "./tool-output-schemas.js";
import type { DriveStore } from "./store.js";
import type { DriveEntryRecord } from "./types.js";

const uuidSchema = z.string().uuid();
const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export function createDriveCollaborationTools(options: {
  readonly store: DriveStore;
}): readonly ToolDefinition[] {
  return [
    defineTool({
      id: "drive.hide.set",
      description: "Hide or unhide a shared Drive item in Shared with me. Does not revoke access.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: false,
      inputSchema: zodToolSchema(
        z.object({ objectId: uuidSchema, hidden: z.boolean() }),
        genericObjectJsonSchema,
      ),
      outputSchema: zodToolSchema(
        z.object({ objectId: uuidSchema, hidden: z.boolean() }),
        genericObjectJsonSchema,
      ),
      handler: async (input, ctx) => {
        if (options.store.setHiddenShare === undefined) {
          throw new Error("drive.hide.set requires DriveStore.setHiddenShare.");
        }
        return options.store.setHiddenShare({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          hidden: input.hidden,
        });
      },
    }),
    defineTool({
      id: "drive.access.request",
      description: "Ask the owner for access to a Drive file or folder.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: false,
      inputSchema: zodToolSchema(
        z.object({ objectId: uuidSchema, message: z.string().max(2000).optional() }),
        genericObjectJsonSchema,
      ),
      outputSchema: zodToolSchema(z.object({ requestId: uuidSchema }), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.requestAccess === undefined) {
          throw new Error("drive.access.request requires DriveStore.requestAccess.");
        }
        return options.store.requestAccess({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          message: input.message,
        });
      },
    }),
    defineTool({
      id: "drive.access.decide",
      description: "Approve or reject a pending Drive access request (owner only).",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(
        z.object({ requestId: uuidSchema, approve: z.boolean() }),
        genericObjectJsonSchema,
      ),
      outputSchema: zodToolSchema(
        z.object({ requestId: uuidSchema, approved: z.boolean() }),
        genericObjectJsonSchema,
      ),
      handler: async (input, ctx) => {
        if (options.store.decideAccessRequest === undefined) {
          throw new Error("drive.access.decide requires DriveStore.decideAccessRequest.");
        }
        return options.store.decideAccessRequest({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          requestId: input.requestId,
          approve: input.approve,
        });
      },
    }),
    defineTool({
      id: "drive.access.requests",
      description: "List open Drive access requests for the current owner.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z.object({ objectId: uuidSchema.optional() }),
        genericObjectJsonSchema,
      ),
      outputSchema: zodToolSchema(
        z.object({
          requests: z
            .object({
              id: uuidSchema,
              objectId: uuidSchema,
              requesterActorId: uuidSchema,
              requesterDisplayName: z.string().nullable(),
              requesterEmail: z.string().nullable(),
              objectName: z.string(),
              message: z.string().nullable(),
              createdAt: z.union([z.string(), z.date()]),
            })
            .array(),
        }),
        genericObjectJsonSchema,
      ),
      handler: async (input, ctx) => {
        if (options.store.listAccessRequests === undefined) {
          throw new Error("drive.access.requests requires DriveStore.listAccessRequests.");
        }
        return {
          requests: await options.store.listAccessRequests({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
          }),
        };
      },
    }),
    defineTool({
      id: "drive.copy",
      description: "Make a copy of a Drive file the current actor can read.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(
        z.object({ objectId: uuidSchema, folderId: uuidSchema.nullable().optional() }),
        genericObjectJsonSchema,
      ),
      outputSchema: zodToolSchema(driveEntryOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.copyObject === undefined) {
          throw new Error("drive.copy requires DriveStore.copyObject.");
        }
        return serializeEntry(
          await options.store.copyObject({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
            folderId: input.folderId,
          }),
        );
      },
    }),
  ];
}

function serializeEntry(entry: DriveEntryRecord) {
  return {
    ...entry,
    deletedAt: entry.deletedAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}
