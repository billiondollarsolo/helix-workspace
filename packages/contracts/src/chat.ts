import { z } from "zod";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});

export const chatRoomKindSchema = z.enum(["chat_room", "chat_dm"]);
export type ChatRoomKind = z.infer<typeof chatRoomKindSchema>;

export const chatPresenceStatusSchema = z.enum(["available", "away", "busy", "offline"]);
export type ChatPresenceStatus = z.infer<typeof chatPresenceStatusSchema>;

export const chatCreateRoomInputSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  kind: chatRoomKindSchema.default("chat_room"),
  memberActorIds: z.array(uuidSchema).default([]),
  topic: z.string().max(500).optional(),
  isPrivate: z.boolean().default(false),
  metadata: metadataSchema,
});
export type ChatCreateRoomInput = z.infer<typeof chatCreateRoomInputSchema>;

export const chatInviteInputSchema = z.object({
  roomId: uuidSchema,
  actorIds: z.array(uuidSchema).min(1),
  role: z.string().min(1).max(50).default("member"),
});
export type ChatInviteInput = z.infer<typeof chatInviteInputSchema>;

export const chatSendInputSchema = z.object({
  roomId: uuidSchema,
  body: z.string().min(1).max(50_000),
  bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
  attachmentObjectIds: z.array(uuidSchema).default([]),
  metadata: metadataSchema,
  clientMessageId: z.string().min(1).max(128).optional(),
  parentMessageId: uuidSchema.optional(),
});
export type ChatSendInput = z.infer<typeof chatSendInputSchema>;

export const chatListMessagesInputSchema = z.object({
  roomId: uuidSchema,
  before: z.string().datetime().optional(),
  limit: z.number().int().positive().max(100).default(50),
});
export type ChatListMessagesInput = z.infer<typeof chatListMessagesInputSchema>;

export const chatReactInputSchema = z.object({
  messageId: uuidSchema,
  emoji: z.string().min(1).max(64),
  op: z.enum(["add", "remove"]).default("add"),
});
export type ChatReactInput = z.infer<typeof chatReactInputSchema>;

export const chatEditInputSchema = z.object({
  messageId: uuidSchema,
  body: z.string().min(1).max(50_000),
});
export type ChatEditInput = z.infer<typeof chatEditInputSchema>;

export const chatDeleteInputSchema = z.object({
  messageId: uuidSchema,
});
export type ChatDeleteInput = z.infer<typeof chatDeleteInputSchema>;

export const chatSearchInputSchema = z.object({
  query: z.string().optional(),
  roomId: uuidSchema.optional(),
  limit: z.number().int().positive().max(100).default(50),
});
export type ChatSearchInput = z.infer<typeof chatSearchInputSchema>;

export const chatReplyInThreadInputSchema = z.object({
  roomId: uuidSchema,
  parentMessageId: uuidSchema,
  body: z.string().min(1).max(50_000),
  bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
  attachmentObjectIds: z.array(uuidSchema).default([]),
  clientMessageId: z.string().min(1).max(128).optional(),
});
export type ChatReplyInThreadInput = z.infer<typeof chatReplyInThreadInputSchema>;

export const chatPinInputSchema = z.object({
  roomId: uuidSchema,
  messageId: uuidSchema,
});
export type ChatPinInput = z.infer<typeof chatPinInputSchema>;

export const chatRoomMemberSchema = z.object({
  actorId: z.string(),
  role: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
});

export const chatRoomSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  kind: chatRoomKindSchema,
  subject: z.string().nullable(),
  createdByActorId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()).default({}),
  members: z.array(chatRoomMemberSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatRoom = z.infer<typeof chatRoomSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  roomId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  body: z.string(),
  bodyFormat: z.string(),
  metadata: z.record(z.unknown()).default({}),
  attachmentObjectIds: z.array(z.string()).default([]),
  parentMessageId: z.string().uuid().nullable().optional(),
  clientMessageId: z.string().optional(),
  sentAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatReactionSchema = z.object({
  messageId: z.string().uuid(),
  actorId: z.string().uuid(),
  orgId: z.string().uuid(),
  emoji: z.string(),
  createdAt: z.string(),
});
export type ChatReaction = z.infer<typeof chatReactionSchema>;

export const chatReadReceiptSchema = z.object({
  roomId: z.string().uuid(),
  actorId: z.string().uuid(),
  orgId: z.string().uuid(),
  lastReadMessageId: z.string().uuid().nullable(),
  lastReadAt: z.string(),
  updatedAt: z.string(),
});
export type ChatReadReceipt = z.infer<typeof chatReadReceiptSchema>;

export const chatSearchHitSchema = z.object({
  roomId: z.string().uuid(),
  messageId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  subject: z.string(),
  preview: z.string(),
  sentAt: z.string(),
});
export type ChatSearchHit = z.infer<typeof chatSearchHitSchema>;

export const chatInboundFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe"),
    roomId: uuidSchema,
  }),
  z.object({
    type: z.literal("send"),
    roomId: uuidSchema,
    body: z.string().min(1).max(50_000),
    bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
    attachmentObjectIds: z.array(uuidSchema).default([]),
    clientMessageId: z.string().min(1).max(128).optional(),
    parentMessageId: uuidSchema.optional(),
  }),
  z.object({
    type: z.literal("typing"),
    roomId: uuidSchema,
    isTyping: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("read"),
    roomId: uuidSchema,
    messageId: uuidSchema.optional(),
  }),
  z.object({
    type: z.literal("presence"),
    roomId: uuidSchema,
  }),
  z.object({
    type: z.literal("presence.set"),
    status: chatPresenceStatusSchema,
  }),
  z.object({
    type: z.literal("auth"),
    token: z.string().min(1),
  }),
]);
export type ChatInboundFrame = z.infer<typeof chatInboundFrameSchema>;

export const chatOutboundFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    actorId: z.string(),
  }),
  z.object({
    type: z.literal("subscribed"),
    roomId: z.string(),
    receipts: z.array(chatReadReceiptSchema).optional(),
  }),
  z.object({
    type: z.literal("message.created"),
    roomId: z.string(),
    message: chatMessageSchema,
  }),
  z.object({
    type: z.literal("typing"),
    roomId: z.string(),
    actorId: z.string(),
    isTyping: z.boolean(),
  }),
  z.object({
    type: z.literal("read"),
    roomId: z.string(),
    actorId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    type: z.literal("presence.joined"),
    roomId: z.string(),
    actorId: z.string(),
    status: chatPresenceStatusSchema.optional(),
  }),
  z.object({
    type: z.literal("presence.left"),
    roomId: z.string(),
    actorId: z.string(),
  }),
  z.object({
    type: z.literal("presence"),
    roomId: z.string(),
    members: z.array(
      z.object({
        actorId: z.string(),
        status: chatPresenceStatusSchema,
      }),
    ),
  }),
  z.object({
    type: z.literal("reconnect"),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    roomId: z.string().optional(),
  }),
]);
export type ChatOutboundFrame = z.infer<typeof chatOutboundFrameSchema>;
