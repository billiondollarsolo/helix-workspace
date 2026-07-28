import { z } from "zod";

const uuidSchema = z.string().uuid();
export const CHAT_BODY_MAX_BYTES = 32 * 1024;
export const CHAT_METADATA_MAX_BYTES = 8 * 1024;
export const CHAT_MAX_ATTACHMENTS = 20;
export const CHAT_METADATA_MAX_DEPTH = 12;

export const chatBodyFormatSchema = z.enum(["plain", "markdown"]);
export type ChatBodyFormat = z.infer<typeof chatBodyFormatSchema>;

export const chatBodySchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!hasWellFormedUnicode(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Text contains malformed Unicode.",
      });
    }
    if (new TextEncoder().encode(value).byteLength > CHAT_BODY_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Text exceeds ${String(CHAT_BODY_MAX_BYTES)} UTF-8 bytes.`,
      });
    }
  });

export const chatMetadataSchema = z
  .record(z.unknown())
  .superRefine((value, context) => {
    const validation = validateMetadata(value);
    if (validation !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: validation });
    }
  })
  .default({});

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
  metadata: chatMetadataSchema,
});
export type ChatCreateRoomInput = z.infer<typeof chatCreateRoomInputSchema>;

export const chatInviteInputSchema = z.object({
  roomId: uuidSchema,
  actorIds: z.array(uuidSchema).min(1),
  role: z.enum(["member", "admin"]).default("member"),
});
export type ChatInviteInput = z.infer<typeof chatInviteInputSchema>;

export const chatSendInputSchema = z.object({
  roomId: uuidSchema,
  body: chatBodySchema,
  bodyFormat: chatBodyFormatSchema.default("plain"),
  attachmentObjectIds: z.array(uuidSchema).max(CHAT_MAX_ATTACHMENTS).default([]),
  metadata: chatMetadataSchema,
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
  body: chatBodySchema,
  bodyFormat: chatBodyFormatSchema.optional(),
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
  body: chatBodySchema,
  bodyFormat: chatBodyFormatSchema.default("plain"),
  attachmentObjectIds: z.array(uuidSchema).max(CHAT_MAX_ATTACHMENTS).default([]),
  clientMessageId: z.string().min(1).max(128).optional(),
});
export type ChatReplyInThreadInput = z.infer<typeof chatReplyInThreadInputSchema>;

export const chatRemoveMemberInputSchema = z.object({
  roomId: uuidSchema,
  actorId: uuidSchema,
});
export type ChatRemoveMemberInput = z.infer<typeof chatRemoveMemberInputSchema>;

export const chatRetentionPolicyInputSchema = z.object({
  roomId: uuidSchema.optional(),
  retentionDays: z.number().int().min(1).max(36500),
  editWindowSeconds: z.number().int().min(0).max(31536000).default(86400),
  deleteWindowSeconds: z.number().int().min(0).max(31536000).default(86400),
});
export type ChatRetentionPolicyInput = z.infer<typeof chatRetentionPolicyInputSchema>;

export const chatLegalHoldInputSchema = z.object({
  roomId: uuidSchema.optional(),
  enabled: z.boolean(),
});
export type ChatLegalHoldInput = z.infer<typeof chatLegalHoldInputSchema>;

export const chatExportInputSchema = z
  .object({
    roomIds: z.array(uuidSchema).max(100).default([]),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(10000).default(10000),
  })
  .superRefine((value, context) => {
    if (
      value.from !== undefined &&
      value.to !== undefined &&
      Date.parse(value.from) > Date.parse(value.to)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Export start must not be after export end.",
      });
    }
  });
export type ChatExportInput = z.infer<typeof chatExportInputSchema>;

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
  bodyFormat: chatBodyFormatSchema,
  renderedBodyHtml: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
  attachmentObjectIds: z.array(uuidSchema).default([]),
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
    body: chatBodySchema,
    bodyFormat: chatBodyFormatSchema.default("plain"),
    attachmentObjectIds: z.array(uuidSchema).max(CHAT_MAX_ATTACHMENTS).default([]),
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

export function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateMetadata(value: Record<string, unknown>): string | null {
  try {
    if (validateJsonMetadata(value) > CHAT_METADATA_MAX_DEPTH) {
      return `Metadata exceeds maximum depth ${String(CHAT_METADATA_MAX_DEPTH)}.`;
    }
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    return encoded.byteLength > CHAT_METADATA_MAX_BYTES
      ? `Metadata exceeds ${String(CHAT_METADATA_MAX_BYTES)} UTF-8 bytes.`
      : null;
  } catch {
    return "Metadata must be JSON serializable.";
  }
}

function validateJsonMetadata(value: unknown, seen = new Set<object>()): number {
  if (value === null || typeof value === "boolean") return 0;
  if (typeof value === "string") {
    if (!hasWellFormedUnicode(value)) {
      throw new TypeError("Metadata contains malformed Unicode.");
    }
    return 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Metadata numbers must be finite.");
    return 0;
  }
  if (typeof value !== "object") {
    throw new TypeError("Metadata must contain only JSON values.");
  }
  if (seen.has(value)) throw new TypeError("Cyclic JSON metadata is not supported.");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new TypeError("Metadata objects must be plain JSON objects.");
  }
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((child) => ["", child] as const)
    : Object.entries(value);
  for (const [key] of entries) {
    if (!hasWellFormedUnicode(key)) throw new TypeError("Metadata key contains malformed Unicode.");
  }
  const depth = 1 + Math.max(0, ...entries.map(([, child]) => validateJsonMetadata(child, seen)));
  seen.delete(value);
  return depth;
}
