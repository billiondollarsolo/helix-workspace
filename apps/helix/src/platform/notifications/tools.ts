import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod3";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { NotificationStore } from "./store.js";
import type { NotificationRecord } from "./types.js";

const listSchema = z.object({
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(50),
});

const markReadSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

const markAllReadSchema = z.object({});
const unreadCountSchema = z.object({});

const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;

export interface CreateNotificationToolsOptions {
  readonly store: NotificationStore;
}

export function createNotificationToolDefinitions(
  options: CreateNotificationToolsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof listSchema>, unknown>({
      id: "notifications.list",
      description: "List notifications for the current actor, newest first.",
      permission: "notifications.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        items: (
          await options.store.list({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            unreadOnly: input.unreadOnly,
            limit: input.limit,
          })
        ).map(serialize),
      }),
    }),
    defineTool<z.output<typeof unreadCountSchema>, unknown>({
      id: "notifications.unread-count",
      description: "Return the count of unread notifications for the current actor.",
      permission: "notifications.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(unreadCountSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (_input, ctx) => ({
        count: await options.store.countUnread(ctx.actor.orgId, ctx.actor.id),
      }),
    }),
    defineTool<z.output<typeof markReadSchema>, unknown>({
      id: "notifications.mark-read",
      description: "Mark a set of notifications as read.",
      permission: "notifications.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(markReadSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        updated: await options.store.markRead(ctx.actor.orgId, ctx.actor.id, input.ids),
      }),
    }),
    defineTool<z.output<typeof markAllReadSchema>, unknown>({
      id: "notifications.mark-all-read",
      description: "Mark every unread notification for the current actor as read.",
      permission: "notifications.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(markAllReadSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (_input, ctx) => ({
        updated: await options.store.markAllRead(ctx.actor.orgId, ctx.actor.id),
      }),
    }),
  ];
}

export function registerNotificationTools(
  registry: RuntimeToolRegistry,
  options: CreateNotificationToolsOptions,
): void {
  for (const tool of createNotificationToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function serialize(record: NotificationRecord) {
  return {
    id: record.id,
    orgId: record.orgId,
    actorId: record.actorId,
    verb: record.verb,
    objectType: record.objectType,
    objectId: record.objectId,
    summary: record.summary,
    body: record.body,
    payload: record.payload,
    createdAt: record.createdAt.toISOString(),
    readAt: record.readAt?.toISOString() ?? null,
    unread: record.readAt === null,
  };
}
