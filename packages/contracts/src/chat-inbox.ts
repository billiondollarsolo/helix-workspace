import { z } from "zod";

/** Unread state for one conversation the actor belongs to. */
export const chatRoomUnreadSchema = z.object({
  roomId: z.string().uuid(),
  /** Messages from others after the actor's read marker, replies included. */
  unreadCount: z.number().int().nonnegative(),
  /** Unread messages that @mention the actor by name. */
  mentionCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
  lastReadAt: z.string().nullable(),
});
export type ChatRoomUnread = z.infer<typeof chatRoomUnreadSchema>;

export const chatUnreadListInputSchema = z.object({}).strict();
export const chatUnreadListResultSchema = z.object({
  rooms: z.array(chatRoomUnreadSchema),
  totalUnread: z.number().int().nonnegative(),
  totalMentions: z.number().int().nonnegative(),
});
export type ChatUnreadListResult = z.infer<typeof chatUnreadListResultSchema>;

export const chatMentionsListInputSchema = z
  .object({
    limit: z.number().int().positive().max(100).default(50),
    /** Cursor: only mentions sent before this instant (the previous page's `nextBefore`). */
    before: z.string().datetime().optional(),
  })
  .strict();
/** A message that @mentions the actor, newest first (the Mentions view). */
export const chatMentionSchema = z.object({
  roomId: z.string().uuid(),
  roomName: z.string(),
  messageId: z.string().uuid(),
  /** Set when the mention is a reply inside a thread. */
  parentMessageId: z.string().uuid().nullable(),
  actorId: z.string().uuid().nullable(),
  actorDisplayName: z.string().nullable(),
  preview: z.string(),
  sentAt: z.string(),
  unread: z.boolean(),
});
export type ChatMention = z.infer<typeof chatMentionSchema>;
export const chatMentionsListResultSchema = z.object({
  mentions: z.array(chatMentionSchema),
  nextBefore: z.string().nullable(),
});
export type ChatMentionsListResult = z.infer<typeof chatMentionsListResultSchema>;
