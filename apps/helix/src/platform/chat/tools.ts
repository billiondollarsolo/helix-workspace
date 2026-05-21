import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import type { ChatStore } from "./store.js";
import type {
  ChatMessageRecord,
  ChatReadReceiptRecord,
  ChatReactionRecord,
  ChatRoomRecord,
  ChatSearchHit,
} from "./types.js";

const uuidSchema = z.string().uuid();

const metadataSchema = z.record(z.unknown()).default({});

const createRoomSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  kind: z.enum(["chat_room", "chat_dm"]).default("chat_room"),
  memberActorIds: z.array(uuidSchema).default([]),
  topic: z.string().max(500).optional(),
  isPrivate: z.boolean().default(false),
  metadata: metadataSchema,
});

const inviteSchema = z.object({
  roomId: uuidSchema,
  actorIds: z.array(uuidSchema).min(1),
  role: z.string().min(1).max(50).default("member"),
});

const sendSchema = z.object({
  roomId: uuidSchema,
  body: z.string().min(1).max(50_000),
  bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
  attachmentObjectIds: z.array(uuidSchema).default([]),
  metadata: metadataSchema,
});

const listRoomsSchema = z.object({
  query: z.string().max(500).optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const listMessagesSchema = z.object({
  roomId: uuidSchema,
  before: z.string().datetime().optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const reactSchema = z.object({
  messageId: uuidSchema,
  emoji: z.string().min(1).max(64),
  op: z.enum(["add", "remove"]).default("add"),
});

const editSchema = z.object({
  messageId: uuidSchema,
  body: z.string().min(1).max(50_000),
});

const deleteSchema = z.object({
  messageId: uuidSchema,
});

const searchSchema = z.object({
  query: z.string().optional(),
  roomId: uuidSchema.optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateChatToolDefinitionsOptions {
  readonly store: ChatStore;
  /**
   * Auto-classifies newly sent chat messages (PRD §8.4). When provided, the
   * `chat.send` handler classifies the resulting message from its body.
   * Best-effort: classification never fails the send.
   */
  readonly classifyResource?: ResourceClassifier;
}

export function createChatToolDefinitions(
  options: CreateChatToolDefinitionsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof sendSchema>, unknown>({
      id: "chat.send",
      description: "Send a message to a chat room.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(sendSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const message = await options.store.sendMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          body: input.body,
          bodyFormat: input.bodyFormat,
          metadata: toJsonObject(input.metadata),
          attachmentObjectIds: input.attachmentObjectIds,
        });
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "chat.message",
          resourceId: message.id,
          derivation: { content: input.body, scanContent: true },
        });
        return serializeMessage(message);
      },
    }),
    defineTool<z.output<typeof reactSchema>, unknown>({
      id: "chat.react",
      description: "Add or remove a reaction on a chat message.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(reactSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const reaction = await options.store.react({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          messageId: input.messageId,
          emoji: input.emoji,
          op: input.op,
        });
        return { reaction: reaction === null ? null : serializeReaction(reaction) };
      },
    }),
    defineTool<z.output<typeof listRoomsSchema>, unknown>({
      id: "chat.room.list",
      description: "List chat rooms visible to the current actor.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listRoomsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        rooms: (
          await options.store.listRooms({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            query: input.query,
            limit: input.limit,
          })
        ).map(serializeRoom),
      }),
    }),
    defineTool<z.output<typeof listMessagesSchema>, unknown>({
      id: "chat.message.list",
      description: "List recent messages in a visible chat room.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listMessagesSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        messages: (
          await options.store.listMessages({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
            ...(input.before === undefined ? {} : { before: new Date(input.before) }),
            limit: input.limit,
          })
        ).map(serializeMessage),
      }),
    }),
    defineTool<z.output<typeof editSchema>, unknown>({
      id: "chat.edit",
      description: "Edit one of the current actor's chat messages.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(editSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const message = await options.store.editMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          messageId: input.messageId,
          body: input.body,
        });
        if (message === null) {
          throw new Error(`Unknown editable chat message: ${input.messageId}`);
        }
        return serializeMessage(message);
      },
    }),
    defineTool<z.output<typeof deleteSchema>, unknown>({
      id: "chat.delete",
      description: "Delete one of the current actor's chat messages.",
      permission: "chat.post",
      sideEffects: "destructive",
      inputSchema: zodToolSchema(deleteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const message = await options.store.deleteMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          messageId: input.messageId,
        });
        if (message === null) {
          throw new Error(`Unknown deletable chat message: ${input.messageId}`);
        }
        return serializeMessage(message);
      },
    }),
    defineTool<z.output<typeof createRoomSchema>, unknown>({
      id: "chat.create_room",
      description: "Create a chat room or direct message thread.",
      permission: "chat.create",
      sideEffects: "write",
      inputSchema: zodToolSchema(createRoomSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeRoom(
          await options.store.createRoom({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            kind: input.kind,
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            memberActorIds: input.memberActorIds,
            ...(input.topic === undefined ? {} : { topic: input.topic }),
            isPrivate: input.isPrivate,
            metadata: toJsonObject(input.metadata),
          }),
        ),
    }),
    defineTool<z.output<typeof inviteSchema>, unknown>({
      id: "chat.invite",
      description: "Invite actors to a chat room.",
      permission: "chat.create",
      sideEffects: "write",
      inputSchema: zodToolSchema(inviteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.store.invite({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          actorIds: input.actorIds,
          role: input.role,
        }),
    }),
    defineTool<z.output<typeof searchSchema>, unknown>({
      id: "chat.search",
      description: "Search chat messages visible to the current actor.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(searchSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        hits: (
          await options.store.search({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            query: input.query,
            roomId: input.roomId,
            limit: input.limit,
          })
        ).map(serializeSearchHit),
      }),
    }),
  ];
}

export function registerChatTools(
  registry: RuntimeToolRegistry,
  options: CreateChatToolDefinitionsOptions,
): void {
  for (const tool of createChatToolDefinitions(options)) {
    registry.register(tool);
  }
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function serializeRoom(room: ChatRoomRecord) {
  return {
    ...room,
    settings:
      room.settings === null
        ? null
        : {
            ...room.settings,
            createdAt: room.settings.createdAt.toISOString(),
            updatedAt: room.settings.updatedAt.toISOString(),
          },
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  };
}

function serializeMessage(message: ChatMessageRecord) {
  return {
    ...message,
    sentAt: message.sentAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

function serializeReaction(reaction: ChatReactionRecord) {
  return {
    ...reaction,
    createdAt: reaction.createdAt.toISOString(),
  };
}

export function serializeReadReceipt(receipt: ChatReadReceiptRecord) {
  return {
    ...receipt,
    lastReadAt: receipt.lastReadAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
  };
}

function serializeSearchHit(hit: ChatSearchHit) {
  return {
    ...hit,
    sentAt: hit.sentAt.toISOString(),
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
