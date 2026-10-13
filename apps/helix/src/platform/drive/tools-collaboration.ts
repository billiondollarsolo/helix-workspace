import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { DriveCollaborationStore } from "./store.js";

/**
 * Drive tools for the people a file is shared with rather than its owner:
 * asking for access, the owner's answer, and hiding a shared item.
 */

const uuidSchema = z.string().uuid();
const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const hideSchema = z.object({ objectId: uuidSchema, hidden: z.boolean() });
const requestSchema = z.object({
  objectId: uuidSchema,
  message: z.string().trim().max(2000).optional(),
});
const decisionSchema = z.object({ requestId: uuidSchema, approve: z.boolean() });
const requestsSchema = z.object({ objectId: uuidSchema.optional() });

function createDriveCollaborationTools(store: DriveCollaborationStore): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof hideSchema>, unknown>({
      id: "drive.hide.set",
      description:
        "Hide a Drive item someone shared with you from Shared with me, or show it again. Access is unchanged.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: false,
      inputSchema: zodToolSchema(hideSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(hideSchema, genericObjectJsonSchema),
      handler: (input, ctx) =>
        store.setHiddenShare({ orgId: ctx.actor.orgId, actorId: ctx.actor.id, ...input }),
    }),
    defineTool<z.output<typeof requestSchema>, unknown>({
      id: "drive.access.request",
      description:
        "Ask the owner of a Drive file or folder you cannot open for access. The owner is notified and decides.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: false,
      // Each request notifies and emails the owner.
      rateLimit: { perActor: { perMinute: 10 } },
      inputSchema: zodToolSchema(requestSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.object({ requestId: uuidSchema }), genericObjectJsonSchema),
      handler: (input, ctx) =>
        store.requestAccess({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          objectId: input.objectId,
          message: input.message === "" ? undefined : input.message,
        }),
    }),
    defineTool<z.output<typeof decisionSchema>, unknown>({
      id: "drive.access.decide",
      description:
        "Answer a request for access to a Drive item you own. Approving gives the person view access.",
      permission: "drive.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(decisionSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(
        z.object({ requestId: uuidSchema, approved: z.boolean() }),
        genericObjectJsonSchema,
      ),
      handler: (input, ctx) =>
        store.decideAccessRequest({ orgId: ctx.actor.orgId, actorId: ctx.actor.id, ...input }),
    }),
    defineTool<z.output<typeof requestsSchema>, unknown>({
      id: "drive.access.requests",
      description: "List the open requests for access to Drive items you own.",
      permission: "drive.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(requestsSchema, genericObjectJsonSchema),
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
              createdAt: z.string(),
            })
            .array(),
        }),
        genericObjectJsonSchema,
      ),
      handler: async (input, ctx) => ({
        requests: (
          await store.listAccessRequests({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            objectId: input.objectId,
          })
        ).map((request) => ({ ...request, createdAt: request.createdAt.toISOString() })),
      }),
    }),
  ];
}

export function registerDriveCollaborationTools(
  registry: RuntimeToolRegistry,
  store: DriveCollaborationStore,
): void {
  for (const tool of createDriveCollaborationTools(store)) {
    registry.register(tool);
  }
}
