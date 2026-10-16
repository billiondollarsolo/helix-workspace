import { z } from "zod";
export const BOT_ACCOUNT_SCOPES = [
  "platform.read",
  "notifications.read",
  "chat.read",
  "chat.post",
  "chat.create",
  "mail.read",
  "mail.write",
  "mail.send",
  "mail.external",
  "drive.read",
  "drive.write",
  "calendar.read",
  "calendar.write",
  "meet.read",
  "meet.write",
  "notifications.write",
] as const;
export const botAccountRequestSchema = z
  .object({
    externalBotId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(1000),
    email: z.string().email().max(320).optional(),
    scopes: z.array(z.enum(BOT_ACCOUNT_SCOPES)).min(1).max(BOT_ACCOUNT_SCOPES.length),
    apiKeyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const botAccountApproveSchema = z
  .object({
    requestId: z.string().uuid(),
    ownerActorId: z.string().uuid(),
    scopes: z.array(z.enum(BOT_ACCOUNT_SCOPES)).min(1).max(BOT_ACCOUNT_SCOPES.length),
    email: z.string().email().max(320).nullable(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type BotAccountRequestInput = z.infer<typeof botAccountRequestSchema>;
export type BotAccountApproval = z.infer<typeof botAccountApproveSchema>;
export interface BotAccountRequest {
  id: string;
  externalBotId: string;
  displayName: string;
  purpose: string;
  requestedEmail: string | null;
  requestedScopes: readonly string[];
  status: "pending" | "approved" | "rejected" | "expired";
  actorId: string | null;
  credentialId: string | null;
  credentialExpiresAt: string | null;
  ownerActorId: string | null;
  approvedScopes: readonly string[];
  approvedEmail: string | null;
  reason: string | null;
  createdAt: string;
  expiresAt: string;
  reviewUrl: string;
}
