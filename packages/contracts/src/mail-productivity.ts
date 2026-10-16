import { z } from "zod";
import { mailFilterActionsSchema, mailFilterCriteriaSchema } from "./mail.js";

export const mailFollowUpStateSchema = z.enum(["automatic", "needs_reply", "waiting_on", "done"]);
export const mailFollowUpSetSchema = z
  .object({
    threadId: z.string().uuid(),
    messageId: z.string().uuid(),
    state: mailFollowUpStateSchema,
  })
  .strict();
export const mailFilingRuleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    folderId: z.string().uuid(),
    criteria: mailFilterCriteriaSchema.strict(),
  })
  .strict();
export const mailProductivityPreferencesSchema = z
  .object({
    preparedReplies: z.boolean().default(false),
    writingInstructions: z.string().max(2000).default(""),
    overdueDays: z.number().int().min(1).max(90).default(3),
    meetingBriefs: z.boolean().default(false),
    dailyDigest: z.boolean().default(false),
    digestHourUtc: z.number().int().min(0).max(23).default(8),
    filingRules: z.array(mailFilingRuleSchema).max(20).default([]),
  })
  .strict();
export type MailProductivityPreferences = z.infer<typeof mailProductivityPreferencesSchema>;
export const mailProductivityArtifactSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["reply", "brief", "digest", "filing"]),
  sourceKey: z.string(),
  status: z.enum(["working", "ready", "failed"]),
  text: z.string(),
  objectId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailProductivityArtifact = z.infer<typeof mailProductivityArtifactSchema>;
export const mailRuleProposalSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    criteria: mailFilterCriteriaSchema
      .strict()
      .refine(
        (value) => Object.keys(value).length > 0,
        "A proposed rule must have at least one matching criterion.",
      ),
    actions: mailFilterActionsSchema
      .omit({ delete: true, snoozeUntil: true })
      .strict()
      .refine(
        (value) =>
          value.archive === true ||
          value.markRead === true ||
          value.star === true ||
          (value.applyLabels?.length ?? 0) > 0,
        "Choose at least one action.",
      ),
  })
  .strict();
export type MailRuleProposal = z.infer<typeof mailRuleProposalSchema>;
export const mailMeetingBriefInputSchema = z
  .object({
    eventId: z.string().uuid(),
    threadIds: z.array(z.string().uuid()).max(5).default([]),
  })
  .strict();
