import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod3";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { AssistantOrchestrator } from "./orchestrator.js";
import type { AssistantConversation, AssistantStore } from "./types.js";
import { actorToolInvocationPrincipal } from "../auth/tool-invocation-principal.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.string(), z.unknown()).default({});
const classificationSchema = z
  .enum(["public", "standard", "confidential", "restricted"])
  .default("standard");

const createConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  memoryOptIn: z.boolean().optional(),
  metadata: metadataSchema,
});

const listConversationsSchema = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  pinnedOnly: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(50),
  cursor: z.string().datetime().optional(),
});

const pinConversationSchema = z.object({
  conversationId: uuidSchema,
});

const renameConversationSchema = z.object({
  conversationId: uuidSchema,
  title: z.string().trim().min(1).max(200),
});

const deleteConversationSchema = z.object({
  conversationId: uuidSchema,
});

const chatSchema = z.object({
  conversationId: uuidSchema.optional(),
  message: z.string().min(1).max(100_000),
  title: z.string().min(1).max(200).optional(),
  memoryOptIn: z.boolean().optional(),
  classification: classificationSchema,
  metadata: metadataSchema,
});

const forgetSchema = z.object({
  conversationId: uuidSchema.optional(),
  ids: z.array(z.string().min(1)).default([]),
  olderThan: z.string().datetime().optional(),
  all: z.boolean().default(true),
  disableMemory: z.boolean().default(true),
});

const approveConfirmationSchema = z.object({
  conversationId: uuidSchema,
  pendingId: uuidSchema,
  classification: classificationSchema,
  metadata: metadataSchema,
});

const cancelConfirmationSchema = z.object({
  conversationId: uuidSchema,
  pendingId: uuidSchema,
  classification: classificationSchema,
  metadata: metadataSchema,
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateAssistantToolDefinitionsOptions {
  readonly store: AssistantStore;
  readonly orchestrator: AssistantOrchestrator;
}

export function createAssistantToolDefinitions(
  options: CreateAssistantToolDefinitionsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof createConversationSchema>, unknown>({
      id: "assistant.conversation.create",
      description: "Create an assistant conversation.",
      permission: "assistant.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createConversationSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.store.createConversation({
          actor: ctx.actor,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.memoryOptIn === undefined ? {} : { memoryOptIn: input.memoryOptIn }),
          metadata: toJsonObject(input.metadata),
        }),
    }),
    defineTool<z.output<typeof listConversationsSchema>, unknown>({
      id: "assistant.conversations.list",
      description:
        "List the current actor's assistant conversations for the thread list: " +
        "pinned-first, with optional search and keyset pagination.",
      permission: "assistant.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listConversationsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.store.listConversations({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          ...(input.query === undefined ? {} : { query: input.query }),
          pinnedOnly: input.pinnedOnly,
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }),
    }),
    defineTool<z.output<typeof pinConversationSchema>, unknown>({
      id: "assistant.conversation.pin",
      description: "Pin an assistant conversation to the top of the thread list.",
      permission: "assistant.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(pinConversationSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const conversation = await options.store.setConversationPinned({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          conversationId: input.conversationId,
          pinned: true,
        });
        return requireConversation(conversation, input.conversationId);
      },
    }),
    defineTool<z.output<typeof pinConversationSchema>, unknown>({
      id: "assistant.conversation.unpin",
      description: "Unpin an assistant conversation.",
      permission: "assistant.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(pinConversationSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const conversation = await options.store.setConversationPinned({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          conversationId: input.conversationId,
          pinned: false,
        });
        return requireConversation(conversation, input.conversationId);
      },
    }),
    defineTool<z.output<typeof renameConversationSchema>, unknown>({
      id: "assistant.conversation.rename",
      description: "Rename an assistant conversation.",
      permission: "assistant.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(renameConversationSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const conversation = await options.store.renameConversation({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          conversationId: input.conversationId,
          title: input.title,
        });
        return requireConversation(conversation, input.conversationId);
      },
    }),
    defineTool<z.output<typeof deleteConversationSchema>, unknown>({
      id: "assistant.conversation.delete",
      description: "Delete (archive) an assistant conversation and remove it from the thread list.",
      permission: "assistant.write",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(deleteConversationSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const deleted = await options.store.deleteConversation({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          conversationId: input.conversationId,
        });
        if (!deleted) {
          throw new Error(`Unknown assistant conversation: ${input.conversationId}`);
        }
        return { conversationId: input.conversationId, deleted: true };
      },
    }),
    defineTool<z.output<typeof chatSchema>, unknown>({
      id: "assistant.chat",
      description:
        "Send a message to Helix Assistant with search, memory, and visible tool context.",
      permission: "assistant.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.orchestrator.sendMessage({
          actor: ctx.actor,
          principal: actorToolInvocationPrincipal(ctx.actor),
          content: input.message,
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.memoryOptIn === undefined ? {} : { memoryOptIn: input.memoryOptIn }),
          classification: input.classification,
          metadata: toJsonObject(input.metadata),
          ...(ctx.request === undefined ? {} : { request: ctx.request }),
        }),
    }),
    defineTool<z.output<typeof forgetSchema>, unknown>({
      id: "assistant.memory.forget",
      description: "Forget saved assistant memory for the current actor.",
      permission: "assistant.memory",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(forgetSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.orchestrator.forgetMemory({
          actor: ctx.actor,
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          criteria: {
            all: input.all,
            ...(input.ids.length === 0 ? {} : { ids: input.ids }),
            ...(input.olderThan === undefined ? {} : { olderThan: input.olderThan }),
          },
          disableMemory: input.disableMemory,
          ...(ctx.request === undefined ? {} : { request: ctx.request }),
        }),
    }),
    defineTool<z.output<typeof approveConfirmationSchema>, unknown>({
      id: "assistant.confirmation.approve",
      description:
        "Approve a pending assistant tool action, execute it, and resume the assistant turn.",
      permission: "assistant.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(approveConfirmationSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.orchestrator.approvePendingTool({
          actor: ctx.actor,
          principal: actorToolInvocationPrincipal(ctx.actor),
          conversationId: input.conversationId,
          pendingId: input.pendingId,
          classification: input.classification,
          metadata: toJsonObject(input.metadata),
          ...(ctx.request === undefined ? {} : { request: ctx.request }),
        }),
    }),
    defineTool<z.output<typeof cancelConfirmationSchema>, unknown>({
      id: "assistant.confirmation.cancel",
      description:
        "Cancel a pending assistant tool action without executing it, and resume the assistant turn.",
      permission: "assistant.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(cancelConfirmationSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.orchestrator.cancelPendingTool({
          actor: ctx.actor,
          principal: actorToolInvocationPrincipal(ctx.actor),
          conversationId: input.conversationId,
          pendingId: input.pendingId,
          classification: input.classification,
          metadata: toJsonObject(input.metadata),
          ...(ctx.request === undefined ? {} : { request: ctx.request }),
        }),
    }),
  ];
}

export function registerAssistantTools(
  registry: RuntimeToolRegistry,
  options: CreateAssistantToolDefinitionsOptions,
): void {
  for (const tool of createAssistantToolDefinitions(options)) {
    registry.register(tool);
  }
}

/** Narrows a store result that returns null for an unknown conversation. */
function requireConversation(
  conversation: AssistantConversation | null,
  conversationId: string,
): AssistantConversation {
  if (conversation === null) {
    throw new Error(`Unknown assistant conversation: ${conversationId}`);
  }
  return conversation;
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
