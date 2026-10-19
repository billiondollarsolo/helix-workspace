import { z } from "zod";

export const liveEventTypes = [
  "chat.direct",
  "chat.mentioned",
  "chat.message",
  "mail.received",
  "mail.updated",
  "approval.requested",
  "approval.updated",
  "notification",
] as const;
export const liveEventSchema = z
  .object({
    id: z.string(),
    cursor: z.number().int().nonnegative().safe(),
    type: z.enum(liveEventTypes),
    resourceId: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const liveEventPageSchema = z.object({
  events: z.array(liveEventSchema).max(100),
  cursor: z.number().int().nonnegative().safe(),
  latestCursor: z.number().int().nonnegative().safe(),
  oldestCursor: z.number().int().positive().safe().optional(),
  resetRequired: z.boolean(),
  hasMore: z.boolean(),
});
export const liveEventQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().safe().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export const presenceStatusInputSchema = z
  .object({
    availability: z.enum(["available", "away", "dnd", "invisible"]),
    text: z.string().trim().max(100).default(""),
    emoji: z.string().trim().max(16).default(""),
    expiresAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export const presenceHeartbeatSchema = z
  .object({
    connectionId: z.string().uuid(),
    state: z.enum(["idle", "active", "working", "waiting_approval"]).default("idle"),
    disconnect: z.boolean().default(false),
  })
  .strict();
export const presenceRecordSchema = presenceStatusInputSchema.extend({
  actorId: z.string().uuid(),
  connected: z.boolean(),
  state: z.enum(["offline", "idle", "active", "working", "waiting_approval"]),
  lastSeenAt: z.string().datetime().nullable(),
});
export type LiveEvent = z.infer<typeof liveEventSchema>;
export type LiveEventPage = z.infer<typeof liveEventPageSchema>;
export type PresenceRecord = z.infer<typeof presenceRecordSchema>;
export type PresenceStatusInput = z.infer<typeof presenceStatusInputSchema>;
