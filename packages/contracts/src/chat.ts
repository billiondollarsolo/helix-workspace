import { z } from "zod";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});

export const chatRoomKindSchema = z.enum(["chat_room", "chat_dm"]);
export type ChatRoomKind = z.infer<typeof chatRoomKindSchema>;
export const chatRoomRoleSchema = z.enum(["owner", "moderator", "member"]);
export type ChatRoomRole = z.infer<typeof chatRoomRoleSchema>;
export const chatInvitableRoleSchema = z.enum(["moderator", "member"]);
export type ChatInvitableRole = z.infer<typeof chatInvitableRoleSchema>;

export const chatPresenceStatusSchema = z.enum(["available", "away", "busy", "dnd", "invisible"]);
export type ChatPresenceStatus = z.infer<typeof chatPresenceStatusSchema>;
export const chatRoomPrivacySchema = z.enum(["discoverable", "restricted", "private"]);
export type ChatRoomPrivacy = z.infer<typeof chatRoomPrivacySchema>;
export const chatSpaceTypeSchema = z.enum(["conversation", "announcement", "project"]);
export const chatHistoryPolicySchema = z.enum(["full", "since_join", "off"]);
export const chatNotificationPolicySchema = z.enum(["all", "mentions", "none"]);
export const chatExternalAccessSchema = z.enum(["internal", "guests", "federated"]);

export const chatCreateRoomInputSchema = z.object({
  subject: z.string().min(1).max(200).optional(),
  kind: chatRoomKindSchema.default("chat_room"),
  memberActorIds: z.array(uuidSchema).default([]),
  topic: z.string().max(500).optional(),
  privacy: chatRoomPrivacySchema.default("restricted"),
  readReceiptsEnabled: z.boolean().default(true),
  spaceType: chatSpaceTypeSchema.default("conversation"),
  historyPolicy: chatHistoryPolicySchema.default("full"),
  retentionDays: z.number().int().positive().max(36_500).nullable().default(null),
  legalHold: z.boolean().default(false),
  notificationPolicy: chatNotificationPolicySchema.default("all"),
  externalAccess: chatExternalAccessSchema.default("guests"),
  metadata: metadataSchema,
});
export type ChatCreateRoomInput = z.infer<typeof chatCreateRoomInputSchema>;

export const chatInviteInputSchema = z.object({
  roomId: uuidSchema,
  actorIds: z.array(uuidSchema).min(1),
  role: chatInvitableRoleSchema.default("member"),
});
export type ChatInviteInput = z.infer<typeof chatInviteInputSchema>;

export const chatSendInputSchema = z
  .object({
    roomId: uuidSchema,
    body: z.string().max(50_000),
    bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
    attachmentObjectIds: z.array(uuidSchema).max(10).default([]),
    metadata: metadataSchema,
    clientMessageId: z.string().min(1).max(128).optional(),
    parentMessageId: uuidSchema.optional(),
  })
  .refine(hasMessageContent, { message: "A message body or attachment is required." });
export type ChatSendInput = z.infer<typeof chatSendInputSchema>;

export const chatMessageCursorSchema = z.object({
  sentAt: z.string().datetime(),
  id: uuidSchema,
});
export type ChatMessageCursor = z.infer<typeof chatMessageCursorSchema>;

export const chatListMessagesInputSchema = z.object({
  roomId: uuidSchema,
  before: chatMessageCursorSchema.optional(),
  direction: z.enum(["older", "newer"]).default("older"),
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

export const chatReplyInThreadInputSchema = z
  .object({
    roomId: uuidSchema,
    parentMessageId: uuidSchema,
    body: z.string().max(50_000),
    bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
    attachmentObjectIds: z.array(uuidSchema).max(10).default([]),
    clientMessageId: z.string().min(1).max(128).optional(),
  })
  .refine(hasMessageContent, { message: "A message body or attachment is required." });
export type ChatReplyInThreadInput = z.infer<typeof chatReplyInThreadInputSchema>;

export const chatPinInputSchema = z.object({
  roomId: uuidSchema,
  messageId: uuidSchema,
});
export type ChatPinInput = z.infer<typeof chatPinInputSchema>;

export const chatRoomMemberSchema = z.object({
  actorId: z.string(),
  role: chatRoomRoleSchema,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
});

export const chatRoomSettingsSchema = z.object({
  threadId: uuidSchema,
  orgId: uuidSchema,
  name: z.string().nullable(),
  topic: z.string().nullable(),
  privacy: chatRoomPrivacySchema,
  readReceiptsEnabled: z.boolean(),
  spaceType: z.enum(["conversation", "direct", "announcement", "project"]).default("conversation"),
  historyPolicy: chatHistoryPolicySchema.default("full"),
  retentionDays: z.number().int().positive().max(36_500).nullable().default(null),
  legalHold: z.boolean().default(false),
  notificationPolicy: chatNotificationPolicySchema.default("all"),
  externalAccess: chatExternalAccessSchema.default("guests"),
  metadata: metadataSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const chatRoomSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  kind: chatRoomKindSchema,
  subject: z.string().nullable(),
  createdByActorId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()).default({}),
  members: z.array(chatRoomMemberSchema).default([]),
  settings: chatRoomSettingsSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatRoom = z.infer<typeof chatRoomSchema>;

export const chatAttachmentSchema = z.object({
  objectId: uuidSchema,
  source: z.enum(["chat", "drive"]),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive().safe(),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

export const chatMessageSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  roomId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  body: z.string(),
  bodyFormat: z.string(),
  metadata: z.record(z.unknown()).default({}),
  attachmentObjectIds: z.array(z.string()).default([]),
  attachments: z.array(chatAttachmentSchema).optional(),
  reactions: z
    .array(
      z.object({
        messageId: z.string().uuid(),
        actorId: z.string().uuid(),
        orgId: z.string().uuid(),
        emoji: z.string(),
        createdAt: z.string(),
      }),
    )
    .default([]),
  replyCount: z.number().int().nonnegative().safe().default(0),
  pin: z
    .object({
      roomId: z.string().uuid(),
      messageId: z.string().uuid(),
      orgId: z.string().uuid(),
      pinnedByActorId: z.string().uuid().nullable(),
      createdAt: z.string(),
    })
    .nullable()
    .default(null),
  parentMessageId: z.string().uuid().nullable().optional(),
  clientMessageId: z.string().optional(),
  revision: z.number().int().positive().safe().default(1),
  sentAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatExportInputSchema = z.object({ roomId: uuidSchema });
export const chatRoomExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  room: chatRoomSchema,
  messages: z.array(chatMessageSchema),
});

export const chatImportInputSchema = z.object({
  roomId: uuidSchema,
  messages: z
    .array(
      z.object({
        sourceMessageId: z.string().min(1).max(100),
        body: z.string().min(1).max(50_000),
        bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
        sentAt: z.string().datetime().optional(),
        metadata: metadataSchema,
      }),
    )
    .min(1)
    .max(1_000),
});
export const chatImportResultSchema = z.object({
  roomId: uuidSchema,
  messageIds: z.array(uuidSchema),
});

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

export const chatInboundFrameSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("subscribe"),
      roomId: uuidSchema,
      cursor: z.number().int().nonnegative().safe().optional(),
    }),
    z.object({
      type: z.literal("send"),
      roomId: uuidSchema,
      body: z.string().max(50_000),
      bodyFormat: z.enum(["plain", "markdown"]).default("plain"),
      attachmentObjectIds: z.array(uuidSchema).max(10).default([]),
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
      messageId: uuidSchema,
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
      type: z.literal("heartbeat"),
    }),
  ])
  .refine((frame) => frame.type !== "send" || hasMessageContent(frame), {
    message: "A message body or attachment is required.",
  });
export type ChatInboundFrame = z.infer<typeof chatInboundFrameSchema>;

function hasMessageContent(input: {
  readonly body: string;
  readonly attachmentObjectIds: readonly string[];
}): boolean {
  return input.body.trim().length > 0 || input.attachmentObjectIds.length > 0;
}

export const chatOutboundFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    actorId: z.string(),
  }),
  z.object({
    type: z.literal("subscribed"),
    roomId: z.string(),
    cursor: z.number().int().nonnegative().safe(),
    receipts: z.array(chatReadReceiptSchema).optional(),
  }),
  z.object({
    type: z.literal("message.created"),
    roomId: z.string(),
    cursor: z.number().int().positive().safe(),
    message: chatMessageSchema,
  }),
  z.object({
    type: z.literal("message.updated"),
    roomId: z.string(),
    cursor: z.number().int().positive().safe(),
    message: chatMessageSchema,
  }),
  z.object({
    type: z.literal("message.deleted"),
    roomId: z.string(),
    messageId: z.string(),
    revision: z.number().int().positive().safe(),
    deletedAt: z.string(),
    cursor: z.number().int().positive().safe(),
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
    messageId: z.string(),
    cursor: z.number().int().positive().safe(),
  }),
  z.object({
    type: z.literal("access.changed"),
    roomId: z.string(),
    actorId: z.string(),
    aclVersion: z.number().int().positive().safe(),
    cursor: z.number().int().positive().safe(),
  }),
  z.object({
    type: z.literal("resync.required"),
    roomId: z.string(),
    cursor: z.number().int().nonnegative().safe(),
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
