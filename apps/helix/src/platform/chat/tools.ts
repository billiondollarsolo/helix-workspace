import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import {
  chatCreateRoomInputSchema,
  chatBodyFormatSchema,
  chatDeleteInputSchema,
  chatEditInputSchema,
  chatExportInputSchema,
  chatInviteInputSchema,
  chatLegalHoldInputSchema,
  chatListMessagesInputSchema,
  chatMessageSchema,
  chatRemoveMemberInputSchema,
  chatPinInputSchema,
  chatReactInputSchema,
  chatReactionSchema,
  chatReplyInThreadInputSchema,
  chatRetentionPolicyInputSchema,
  chatRoomSchema,
  chatSearchHitSchema,
  chatSearchInputSchema,
  chatSendInputSchema,
} from "@helix/contracts";
import { z } from "zod3";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { ChatMessageNotFoundError } from "./errors.js";
import type { ChatStore } from "./store.js";
import type {
  ChatMessageRecord,
  ChatPinRecord,
  ChatReadReceiptRecord,
  ChatReactionRecord,
  ChatRoomRecord,
  ChatSearchHit,
} from "./types.js";

const listRoomsSchema = z.object({
  query: z.string().max(500).optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const listThreadSchema = z.object({
  roomId: z.string().uuid(),
  parentMessageId: z.string().uuid(),
  before: z.string().datetime().optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const listPinsSchema = z.object({
  roomId: z.string().uuid(),
});

const chatRoomsResultSchema = z.object({
  rooms: z.array(chatRoomSchema),
});

const chatMessagesResultSchema = z.object({
  messages: z.array(chatMessageSchema),
});

const chatReactResultSchema = z.object({
  reaction: chatReactionSchema.nullable(),
});

const chatSearchResultSchema = z.object({
  hits: z.array(chatSearchHitSchema),
});

const chatInviteResultSchema = z.object({
  roomId: z.string().uuid(),
  invitedActorIds: z.array(z.string()),
});

const chatRemoveMemberResultSchema = z.object({
  roomId: z.string().uuid(),
  removedActorId: z.string().uuid(),
  removed: z.literal(true),
});

const chatRetentionPolicyResultSchema = z.object({
  orgId: z.string().uuid(),
  roomId: z.string().uuid().nullable(),
  retentionDays: z.number().int(),
  editWindowSeconds: z.number().int(),
  deleteWindowSeconds: z.number().int(),
  legalHold: z.boolean(),
  updatedAt: z.string(),
});

const chatExportResultSchema = z.object({
  exportId: z.string().uuid(),
  orgId: z.string().uuid(),
  generatedAt: z.string(),
  truncated: z.boolean(),
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      roomId: z.string().uuid(),
      actorId: z.string().uuid().nullable(),
      body: z.string().nullable(),
      bodyFormat: chatBodyFormatSchema,
      sentAt: z.string(),
      editedAt: z.string().nullable(),
      deletedAt: z.string().nullable(),
    }),
  ),
});

const chatPinRecordSchema = z.object({
  roomId: z.string().uuid(),
  messageId: z.string().uuid(),
  orgId: z.string().uuid(),
  pinnedByActorId: z.string().uuid().nullable(),
  createdAt: z.string(),
});

const chatPinsResultSchema = z.object({
  pins: z.array(chatPinRecordSchema),
});

const chatUnpinResultSchema = z.object({ ok: z.literal(true) });

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
    defineTool<z.output<typeof chatSendInputSchema>, z.output<typeof chatMessageSchema>>({
      id: "chat.send",
      description: "Send a message to a chat room.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatSendInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatMessageSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const message = await options.store.sendMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          body: input.body,
          bodyFormat: input.bodyFormat,
          metadata: toJsonObject(input.metadata),
          attachmentObjectIds: input.attachmentObjectIds,
          ...(input.parentMessageId === undefined
            ? {}
            : { parentMessageId: input.parentMessageId }),
          ...(input.clientMessageId === undefined
            ? {}
            : { clientMessageId: input.clientMessageId }),
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
    defineTool<z.output<typeof chatReplyInThreadInputSchema>, z.output<typeof chatMessageSchema>>({
      id: "chat.reply_in_thread",
      description: "Reply to a chat message in a thread.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatReplyInThreadInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatMessageSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const message = await options.store.sendMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          body: input.body,
          bodyFormat: input.bodyFormat,
          attachmentObjectIds: input.attachmentObjectIds,
          parentMessageId: input.parentMessageId,
          ...(input.clientMessageId === undefined
            ? {}
            : { clientMessageId: input.clientMessageId }),
        });
        return serializeMessage(message);
      },
    }),
    defineTool<z.output<typeof listThreadSchema>, z.output<typeof chatMessagesResultSchema>>({
      id: "chat.thread.list",
      description: "List replies in a chat message thread.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listThreadSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatMessagesResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        messages: (
          await options.store.listThreadReplies({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
            parentMessageId: input.parentMessageId,
            ...(input.before === undefined ? {} : { before: new Date(input.before) }),
            limit: input.limit,
          })
        ).map(serializeMessage),
      }),
    }),
    defineTool<z.output<typeof chatPinInputSchema>, z.output<typeof chatPinRecordSchema>>({
      id: "chat.pin",
      description: "Pin a message in a chat room.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatPinInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatPinRecordSchema, genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializePin(
          await options.store.pinMessage({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
            messageId: input.messageId,
          }),
        ),
    }),
    defineTool<z.output<typeof chatPinInputSchema>, z.output<typeof chatUnpinResultSchema>>({
      id: "chat.unpin",
      description: "Unpin a message in a chat room.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatPinInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatUnpinResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) =>
        options.store.unpinMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          messageId: input.messageId,
        }),
    }),
    defineTool<z.output<typeof listPinsSchema>, z.output<typeof chatPinsResultSchema>>({
      id: "chat.pins.list",
      description: "List pinned messages in a chat room.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listPinsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatPinsResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        pins: (
          await options.store.listPins({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
          })
        ).map(serializePin),
      }),
    }),
    defineTool<z.output<typeof chatReactInputSchema>, z.output<typeof chatReactResultSchema>>({
      id: "chat.react",
      description: "Add or remove a reaction on a chat message.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatReactInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatReactResultSchema, genericObjectJsonSchema),
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
    defineTool<z.output<typeof listRoomsSchema>, z.output<typeof chatRoomsResultSchema>>({
      id: "chat.room.list",
      description: "List chat rooms visible to the current actor.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listRoomsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatRoomsResultSchema, genericObjectJsonSchema),
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
    defineTool<
      z.output<typeof chatListMessagesInputSchema>,
      z.output<typeof chatMessagesResultSchema>
    >({
      id: "chat.message.list",
      description: "List recent messages in a visible chat room.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(chatListMessagesInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatMessagesResultSchema, genericObjectJsonSchema),
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
    defineTool<z.output<typeof chatEditInputSchema>, z.output<typeof chatMessageSchema>>({
      id: "chat.edit",
      description: "Edit one of the current actor's chat messages.",
      permission: "chat.post",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatEditInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatMessageSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const message = await options.store.editMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          messageId: input.messageId,
          body: input.body,
          ...(input.bodyFormat === undefined ? {} : { bodyFormat: input.bodyFormat }),
        });
        if (message === null) {
          throw new ChatMessageNotFoundError(input.messageId);
        }
        return serializeMessage(message);
      },
    }),
    defineTool<z.output<typeof chatDeleteInputSchema>, z.output<typeof chatMessageSchema>>({
      id: "chat.delete",
      description: "Delete one of the current actor's chat messages.",
      permission: "chat.post",
      sideEffects: "destructive",
      inputSchema: zodToolSchema(chatDeleteInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatMessageSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const message = await options.store.deleteMessage({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          messageId: input.messageId,
        });
        if (message === null) {
          throw new ChatMessageNotFoundError(input.messageId);
        }
        return serializeMessage(message);
      },
    }),
    defineTool<z.output<typeof chatCreateRoomInputSchema>, z.output<typeof chatRoomSchema>>({
      id: "chat.create_room",
      description: "Create a chat room or direct message thread.",
      permission: "chat.create",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatCreateRoomInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatRoomSchema, genericObjectJsonSchema),
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
    defineTool<z.output<typeof chatInviteInputSchema>, z.output<typeof chatInviteResultSchema>>({
      id: "chat.invite",
      description: "Invite actors to a chat room.",
      permission: "chat.create",
      sideEffects: "write",
      inputSchema: zodToolSchema(chatInviteInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatInviteResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await options.store.invite({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          actorIds: input.actorIds,
          role: input.role,
        });
        return {
          roomId: result.roomId,
          invitedActorIds: [...result.invitedActorIds],
        };
      },
    }),
    defineTool<
      z.output<typeof chatRemoveMemberInputSchema>,
      z.output<typeof chatRemoveMemberResultSchema>
    >({
      id: "chat.member.remove",
      description: "Remove a member from a chat room.",
      permission: "chat.create",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(chatRemoveMemberInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatRemoveMemberResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.removeMember === undefined) {
          throw new Error("This Chat store does not support member removal.");
        }
        return options.store.removeMember({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          removedActorId: input.actorId,
        });
      },
    }),
    defineTool<z.output<typeof chatSearchInputSchema>, z.output<typeof chatSearchResultSchema>>({
      id: "chat.search",
      description: "Search chat messages visible to the current actor.",
      permission: "chat.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(chatSearchInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatSearchResultSchema, genericObjectJsonSchema),
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
    defineTool<
      z.output<typeof chatRetentionPolicyInputSchema>,
      z.output<typeof chatRetentionPolicyResultSchema>
    >({
      id: "chat.retention.set",
      description: "Set organization-default or room-specific Chat retention windows.",
      permission: "admin.chat",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(chatRetentionPolicyInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatRetentionPolicyResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.setRetentionPolicy === undefined) {
          throw new Error("This Chat store does not support retention policies.");
        }
        return serializeRetentionPolicy(
          await options.store.setRetentionPolicy({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
            retentionDays: input.retentionDays,
            editWindowSeconds: input.editWindowSeconds,
            deleteWindowSeconds: input.deleteWindowSeconds,
          }),
        );
      },
    }),
    defineTool<
      z.output<typeof chatLegalHoldInputSchema>,
      z.output<typeof chatRetentionPolicyResultSchema>
    >({
      id: "chat.legal_hold.set",
      description: "Enable or disable an organization or room Chat legal hold.",
      permission: "admin.chat",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(chatLegalHoldInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatRetentionPolicyResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.setLegalHold === undefined) {
          throw new Error("This Chat store does not support legal holds.");
        }
        return serializeRetentionPolicy(
          await options.store.setLegalHold({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
            enabled: input.enabled,
          }),
        );
      },
    }),
    defineTool<z.output<typeof chatExportInputSchema>, z.output<typeof chatExportResultSchema>>({
      id: "chat.export.organization",
      description: "Export stored Chat messages for the current organization.",
      permission: "admin.chat",
      sideEffects: "read",
      confirmationRequired: true,
      rateLimit: { perActor: { perHour: 2, perDay: 4 } },
      inputSchema: zodToolSchema(chatExportInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(chatExportResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.exportOrganization === undefined) {
          throw new Error("This Chat store does not support organization exports.");
        }
        const exported = await options.store.exportOrganization({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomIds: input.roomIds,
          ...(input.from === undefined ? {} : { from: new Date(input.from) }),
          ...(input.to === undefined ? {} : { to: new Date(input.to) }),
          limit: input.limit,
        });
        return {
          exportId: exported.exportId,
          orgId: exported.orgId,
          generatedAt: exported.generatedAt.toISOString(),
          truncated: exported.truncated,
          messages: exported.messages.map((message) => ({
            ...message,
            sentAt: message.sentAt.toISOString(),
            editedAt: message.editedAt?.toISOString() ?? null,
            deletedAt: message.deletedAt?.toISOString() ?? null,
          })),
        };
      },
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
    id: room.id,
    orgId: room.orgId,
    kind: room.kind,
    subject: room.subject,
    createdByActorId: room.createdByActorId,
    metadata: room.metadata,
    members: room.members.map((m) => ({
      actorId: m.actorId,
      role: m.role,
      displayName: m.displayName,
      email: m.email,
    })),
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    // Extra fields kept for web compatibility (not in chatRoomSchema strictly).
    settings:
      room.settings === null
        ? null
        : {
            ...room.settings,
            createdAt: room.settings.createdAt.toISOString(),
            updatedAt: room.settings.updatedAt.toISOString(),
          },
  };
}

function serializeMessage(message: ChatMessageRecord) {
  return {
    id: message.id,
    orgId: message.orgId,
    roomId: message.roomId,
    actorId: message.actorId,
    body: message.body,
    bodyFormat: chatBodyFormatSchema.parse(message.bodyFormat),
    renderedBodyHtml: message.renderedBodyHtml,
    metadata: message.metadata,
    attachmentObjectIds: [...message.attachmentObjectIds],
    parentMessageId: message.parentMessageId ?? null,
    ...(message.clientMessageId === undefined ? {} : { clientMessageId: message.clientMessageId }),
    sentAt: message.sentAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

function serializeReaction(reaction: ChatReactionRecord) {
  return {
    messageId: reaction.messageId,
    actorId: reaction.actorId,
    orgId: reaction.orgId,
    emoji: reaction.emoji,
    createdAt: reaction.createdAt.toISOString(),
  };
}

export function serializeReadReceipt(receipt: ChatReadReceiptRecord) {
  return {
    roomId: receipt.roomId,
    actorId: receipt.actorId,
    orgId: receipt.orgId,
    lastReadMessageId: receipt.lastReadMessageId,
    lastReadAt: receipt.lastReadAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
  };
}

function serializePin(pin: ChatPinRecord) {
  return {
    roomId: pin.roomId,
    messageId: pin.messageId,
    orgId: pin.orgId,
    pinnedByActorId: pin.pinnedByActorId,
    createdAt: pin.createdAt.toISOString(),
  };
}

function serializeSearchHit(hit: ChatSearchHit) {
  return {
    roomId: hit.roomId,
    messageId: hit.messageId,
    actorId: hit.actorId,
    subject: hit.subject,
    preview: hit.preview,
    sentAt: hit.sentAt.toISOString(),
  };
}

function serializeRetentionPolicy(
  policy: Awaited<ReturnType<NonNullable<ChatStore["setRetentionPolicy"]>>>,
) {
  return {
    ...policy,
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
