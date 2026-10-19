import { z } from "zod";
import { mailAddressSchema, mailSendInputSchema } from "./mail.js";

export const pendingMailReviewSchema = mailSendInputSchema
  .pick({
    from: true,
    to: true,
    cc: true,
    bcc: true,
    subject: true,
    bodyText: true,
    bodyHtml: true,
    attachments: true,
  })
  .extend({
    replyTo: mailAddressSchema.optional(),
    sendAt: z.string().datetime().optional(),
  });

export const pendingMailReviewResultSchema = z.object({
  action: z.object({
    id: z.string().uuid(),
    toolId: z.literal("mail.send"),
    actorId: z.string().uuid(),
    status: z.enum([
      "pending_confirmation",
      "approved",
      "executing",
      "executed",
      "failed",
      "cancelled",
      "expired",
    ]),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  }),
  review: pendingMailReviewSchema,
});

export type PendingMailReviewResult = z.infer<typeof pendingMailReviewResultSchema>;

export const pendingActionQueueSchema = z.object({
  items: z
    .array(
      pendingMailReviewResultSchema.shape.action.extend({
        toolId: z.string(),
        preview: z.object({ consequence: z.string() }),
      }),
    )
    .max(50),
  total: z.number().int().nonnegative(),
});

export const pendingActionReviewResultSchema = z.union([
  pendingMailReviewResultSchema,
  z.object({
    action: pendingMailReviewResultSchema.shape.action.extend({ toolId: z.string() }),
    review: z.object({
      kind: z.literal("action"),
      preview: z.object({
        toolId: z.string(),
        action: z.string(),
        resourceIds: z.array(z.string()),
        recipients: z.array(z.string()),
        targets: z.array(z.string()),
        consequence: z.string(),
      }),
      input: z.unknown(),
      sourceIds: z.array(z.string()),
    }),
  }),
]);
