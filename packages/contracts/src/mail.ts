import { z } from "zod";

export const MAIL_ATTACHMENT_MAX_FILES = 100;
export const MAIL_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAIL_ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export const mailAddressSchema = z.object({
  address: z.string().email(),
  name: z.string().min(1).optional(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

export const mailAttachmentInputSchema = z
  .object({
    filename: z.string().min(1).max(255).optional(),
    contentType: z.string().min(1).max(255).optional(),
    objectId: z.string().uuid(),
  })
  .strict();
export type MailAttachmentInput = z.infer<typeof mailAttachmentInputSchema>;

export const mailSendInputSchema = z.object({
  draft: z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).optional(),
  from: mailAddressSchema.optional(),
  to: z.array(mailAddressSchema).min(1),
  cc: z.array(mailAddressSchema).default([]),
  bcc: z.array(mailAddressSchema).default([]),
  subject: z.string().max(998),
  bodyText: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z.array(mailAttachmentInputSchema).max(MAIL_ATTACHMENT_MAX_FILES).default([]),
  undoWindowMs: z.number().int().min(0).max(300_000).optional(),
});
export type MailSendInput = z.infer<typeof mailSendInputSchema>;

export const mailReplyInputSchema = mailSendInputSchema.omit({ subject: true }).extend({
  threadId: z.string().uuid(),
  subject: z.string().max(998).optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
});
export type MailReplyInput = z.infer<typeof mailReplyInputSchema>;

export const mailSpamCatcherSchema = z.enum([
  "spamd",
  "ai",
  "rules",
  "user",
  "virus",
  "scanner-policy",
  "auth-failure",
  "decision-model",
]);
export type MailSpamCatcher = z.infer<typeof mailSpamCatcherSchema>;

/**
 * Evidence from the organization's AI decision model (Admin → Mail → Spam
 * filtering, enforce mode). `phishing` asks for a strong warning; `action` is
 * what Helix changed in the mailbox (`none` when nothing moved).
 */
export const mailDecisionEvidenceSchema = z.object({
  provider: z.string(),
  model: z.string(),
  verdict: z.enum(["legitimate", "spam", "phishing", "scam"]),
  confidence: z.number().min(0).max(1).nullable(),
  phishing: z.boolean(),
  action: z.enum(["none", "spam", "phishing", "category"]),
  category: z.enum(["primary", "updates", "promotions", "social"]).nullable(),
  needsReply: z.boolean().nullable(),
  urgency: z.enum(["can wait", "this week", "today"]).nullable(),
  decidedAt: z.string(),
});
export type MailDecisionEvidence = z.infer<typeof mailDecisionEvidenceSchema>;

export const mailThreadParticipantSchema = z.object({
  name: z.string(),
  email: z.string(),
  isMe: z.boolean(),
});
export type MailThreadParticipant = z.infer<typeof mailThreadParticipantSchema>;

export const mailThreadRowSchema = z.object({
  followUp: z.enum(["needs_reply", "waiting_on", "done"]).optional(),
  threadId: z.string(),
  messageId: z.string(),
  subject: z.string(),
  from: z.string(),
  fromEmail: z.string(),
  preview: z.string(),
  time: z.string(),
  unread: z.boolean(),
  starred: z.boolean(),
  hasAttachment: z.boolean(),
  messageCount: z.number().int().nonnegative(),
  labels: z.array(z.string()),
  category: z.string(),
  folder: z.string(),
  snoozedUntil: z.string().nullable(),
  /**
   * Up to four distinct senders, oldest first, for rows like "Samara, me (3)".
   * The actor's own messages carry `isMe` and the name "me". Drafts and
   * scheduled sends list their recipients instead.
   */
  participants: z.array(mailThreadParticipantSchema).max(4),
  /** Who put this in Spam (spamd / AI beta / decision model / user). Omitted when not spam. */
  spamCatcher: mailSpamCatcherSchema.nullable().optional(),
  /** Decision-model evidence for the latest message, when the org runs it in enforce mode. */
  decision: mailDecisionEvidenceSchema.optional(),
});
export type MailThreadRow = z.infer<typeof mailThreadRowSchema>;

export const mailThreadsListResultSchema = z.object({
  threads: z.array(mailThreadRowSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type MailThreadsListResult = z.infer<typeof mailThreadsListResultSchema>;

export const mailFilterCriteriaSchema = z.object({
  fromContains: z.string().min(1).optional(),
  toContains: z.string().min(1).optional(),
  subjectContains: z.string().min(1).optional(),
  bodyContains: z.string().min(1).optional(),
  hasAttachment: z.boolean().optional(),
});
export const mailFilterActionsSchema = z.object({
  /** Label slugs to apply. */
  applyLabels: z.array(z.string().min(1)).optional(),
  archive: z.boolean().optional(),
  markRead: z.boolean().optional(),
  star: z.boolean().optional(),
  delete: z.boolean().optional(),
  snoozeUntil: z.string().datetime().optional(),
});
export const mailFilterSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  criteria: mailFilterCriteriaSchema,
  actions: mailFilterActionsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailFilter = z.infer<typeof mailFilterSchema>;

export const mailFilterCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  criteria: mailFilterCriteriaSchema.default({}),
  actions: mailFilterActionsSchema.default({}),
});
export const mailFilterUpdateInputSchema = mailFilterCreateInputSchema.partial().extend({
  id: z.string().uuid(),
});

export const mailFolderSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
export type MailFolderSummary = z.infer<typeof mailFolderSummarySchema>;

/**
 * Fixed label palette; the name is the API value and matches the web `--label-<name>`
 * tokens, and the hex is that token's light-theme colour (oklch 50% lightness).
 */
export const MAIL_LABEL_COLOR_NAMES = [
  "red",
  "coral",
  "orange",
  "amber",
  "yellow",
  "olive",
  "lime",
  "green",
  "emerald",
  "mint",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "plum",
  "fuchsia",
  "pink",
  "rose",
  "brown",
  "slate",
  "gray",
] as const;
export type MailLabelColorName = (typeof MAIL_LABEL_COLOR_NAMES)[number];
export const mailLabelColorNameSchema = z.enum(MAIL_LABEL_COLOR_NAMES);
export const MAIL_LABEL_COLORS: Readonly<Record<MailLabelColorName, string>> = {
  red: "#a83634",
  coral: "#a73b15",
  orange: "#a14400",
  amber: "#935200",
  yellow: "#7e5f00",
  olive: "#6a6800",
  lime: "#457200",
  green: "#00792f",
  emerald: "#007c4d",
  mint: "#007d63",
  teal: "#007c76",
  cyan: "#007792",
  sky: "#006fa7",
  blue: "#1762b6",
  indigo: "#4d57b7",
  violet: "#6b4cae",
  purple: "#7d45a2",
  plum: "#8c3f91",
  fuchsia: "#943b84",
  pink: "#9e366f",
  rose: "#a6344f",
  brown: "#895436",
  slate: "#50667c",
  gray: "#636363",
};
export const MAIL_LABEL_DEFAULT_COLOR: MailLabelColorName = "gray";

/** Palette name for a stored hex colour; unknown colours read as the default. */
export function mailLabelColorName(hex: string): MailLabelColorName {
  const normalized = hex.toLowerCase();
  return (
    MAIL_LABEL_COLOR_NAMES.find((name) => MAIL_LABEL_COLORS[name] === normalized) ??
    MAIL_LABEL_DEFAULT_COLOR
  );
}

export const mailLabelSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  /** Display hex from the palette. */
  color: z.string(),
  colorName: mailLabelColorNameSchema,
  /** Parent label for nesting; `null` at the top level. */
  parentId: z.string().nullable(),
  sortOrder: z.number().int(),
  threadCount: z.number().int().nonnegative(),
  /** Unread threads carrying the label, outside Spam and Trash. */
  unreadCount: z.number().int().nonnegative(),
  /** Org-wide label; only personal labels can be edited. */
  shared: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailLabel = z.infer<typeof mailLabelSchema>;

const mailLabelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(225)
  .refine((name) => !/\p{Cc}/u.test(name), "Label names cannot contain control characters.");
const mailboxActorIdSchema = z.string().uuid().optional();

export const mailLabelCreateInputSchema = z
  .object({
    name: mailLabelNameSchema,
    color: mailLabelColorNameSchema.default(MAIL_LABEL_DEFAULT_COLOR),
    parentId: z.string().uuid().nullable().default(null),
    mailboxActorId: mailboxActorIdSchema,
  })
  .strict();
export const mailLabelUpdateInputSchema = z
  .object({
    id: z.string().uuid(),
    name: mailLabelNameSchema.optional(),
    color: mailLabelColorNameSchema.optional(),
    parentId: z.string().uuid().nullable().optional(),
    mailboxActorId: mailboxActorIdSchema,
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined || input.color !== undefined || input.parentId !== undefined,
    "Provide a new name, color or parentId.",
  );
export const mailLabelDeleteInputSchema = z
  .object({ id: z.string().uuid(), mailboxActorId: mailboxActorIdSchema })
  .strict();
export const mailLabelResultSchema = z.object({ label: mailLabelSchema });
export const mailLabelDeleteResultSchema = z.object({
  /** The label and every label nested under it. */
  deletedIds: z.array(z.string()),
});

/** A send scheduled for later (the Scheduled view). */
export const mailScheduledSendSchema = z.object({
  outboundId: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  subject: z.string(),
  preview: z.string(),
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  bcc: z.array(mailAddressSchema),
  hasAttachment: z.boolean(),
  sendAt: z.string(),
  createdAt: z.string(),
});
export type MailScheduledSend = z.infer<typeof mailScheduledSendSchema>;
export const mailScheduledListInputSchema = z
  .object({
    limit: z.number().int().positive().max(200).default(50),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();
export const mailScheduledListResultSchema = z.object({
  scheduled: z.array(mailScheduledSendSchema),
  total: z.number().int().nonnegative(),
});
export const mailScheduledRescheduleInputSchema = z
  .object({ outboundId: z.string().uuid(), sendAt: z.string().datetime() })
  .strict();
export const mailScheduledRescheduleResultSchema = z.object({
  scheduled: mailScheduledSendSchema.nullable(),
});
export const mailScheduledCancelInputSchema = z.object({ outboundId: z.string().uuid() }).strict();
export const mailScheduledCancelResultSchema = z.object({
  cancelled: z.boolean(),
  /** The cancelled message returned to Drafts for editing. */
  draftId: z.string().nullable(),
});

export const mailSearchInputSchema = z.object({
  query: z.string().optional(),
  labels: z.array(z.string().min(1)).default([]),
  limit: z.number().int().positive().max(100).default(50),
});
export const mailSearchHitSchema = z.object({
  threadId: z.string(),
  messageId: z.string(),
  subject: z.string(),
  snippet: z.string(),
  sentAt: z.string(),
});
export type MailSearchHit = z.infer<typeof mailSearchHitSchema>;

export const mailOutboundRecordSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  status: z.string(),
  undoUntil: z.string(),
  queuedAt: z.string(),
  sentAt: z.string().nullable().optional(),
  cancelledAt: z.string().nullable().optional(),
  failedAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  providerMessageId: z.string().nullable().optional(),
  deliveryStatus: z
    .enum(["queued", "sending", "sent", "delayed", "failed", "cancelled"])
    .optional(),
});
export type MailOutboundRecord = z.infer<typeof mailOutboundRecordSchema>;

export const mailSpamInputSchema = z.object({
  threadId: z.string().uuid(),
  spam: z.boolean().default(true),
});
export const mailSpamResultSchema = z.object({
  ok: z.literal(true),
  threadId: z.string(),
  spamAt: z.string().nullable(),
});
export type MailSpamResult = z.infer<typeof mailSpamResultSchema>;

export const mailDraftSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  actorId: z.string().uuid(),
  threadId: z.string().uuid().nullable(),
  from: mailAddressSchema.optional(),
  to: z.array(mailAddressSchema).default([]),
  cc: z.array(mailAddressSchema).default([]),
  bcc: z.array(mailAddressSchema).default([]),
  subject: z.string().default(""),
  bodyText: z.string().default(""),
  bodyHtml: z.string().optional(),
  attachments: z.array(mailAttachmentInputSchema).default([]),
  revision: z.number().int().positive(),
  expiresAt: z.string().datetime(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailDraft = z.infer<typeof mailDraftSchema>;

export const mailDraftSaveInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    expectedVersion: z.number().int().positive().optional(),
    threadId: z.string().uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
    idempotencyKey: z.string().uuid(),
    from: mailAddressSchema.optional(),
    to: z.array(mailAddressSchema).default([]),
    cc: z.array(mailAddressSchema).default([]),
    bcc: z.array(mailAddressSchema).default([]),
    subject: z.string().default(""),
    bodyText: z.string().default(""),
    bodyHtml: z.string().optional(),
    attachments: z.array(mailAttachmentInputSchema).max(MAIL_ATTACHMENT_MAX_FILES).default([]),
  })
  .superRefine((input, context) => {
    if ((input.id === undefined) !== (input.expectedRevision === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "id and expectedRevision must be supplied together.",
        path: input.id === undefined ? ["id"] : ["expectedRevision"],
      });
    }
  });
export type MailDraftSaveInput = z.infer<typeof mailDraftSaveInputSchema>;

export const mailDraftGetInputSchema = z.object({
  id: z.string().uuid(),
});
export const mailDraftListResultSchema = z.object({
  drafts: z.array(mailDraftSchema),
});
export const mailDraftDiscardInputSchema = z.object({
  id: z.string().uuid(),
  expectedRevision: z.number().int().positive().optional(),
});
export const mailDraftDiscardResultSchema = z.object({
  deleted: z.boolean(),
});

export const mailAliasSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  address: z.string().email(),
  displayName: z.string().nullable(),
  isPrimary: z.boolean(),
  receiveEnabled: z.boolean(),
  sendAsEnabled: z.boolean(),
  createdAt: z.string(),
});
export type MailAlias = z.infer<typeof mailAliasSchema>;

export const mailAliasCreateInputSchema = z.object({
  address: z.string().email(),
  targetActorId: z.string().uuid(),
  displayName: z.string().min(1).optional(),
  isPrimary: z.boolean().default(false),
  receiveEnabled: z.boolean().default(true),
  sendAsEnabled: z.boolean().default(true),
});
export const mailAliasDeleteInputSchema = z.object({
  id: z.string().uuid(),
});
export const mailAliasListResultSchema = z.object({
  aliases: z.array(mailAliasSchema),
});

export const mailReceivingDomainStatusSchema = z.enum([
  "pending",
  "verified",
  "active",
  "disabled",
]);
export type MailReceivingDomainStatus = z.infer<typeof mailReceivingDomainStatusSchema>;

/** Public admin projection. The persisted verification token hash is never serialized. */
export const mailReceivingDomainSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  domain: z.string().min(1).max(253),
  status: mailReceivingDomainStatusSchema,
  verifiedAt: z.string().datetime().nullable(),
  catchAllActorId: z.string().uuid().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MailReceivingDomain = z.infer<typeof mailReceivingDomainSchema>;

export const mailReceivingDomainCreateInputSchema = z
  .object({
    domain: z.string().min(1).max(253),
    catchAllActorId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type MailReceivingDomainCreateInput = z.infer<typeof mailReceivingDomainCreateInputSchema>;

export const mailReceivingDomainChallengeSchema = z.object({
  dnsName: z.string().min(1).max(300),
  dnsValue: z.string().min(1).max(400),
});
export type MailReceivingDomainChallenge = z.infer<typeof mailReceivingDomainChallengeSchema>;

export const mailReceivingDomainCreateResultSchema = z.object({
  domain: mailReceivingDomainSchema,
  verification: mailReceivingDomainChallengeSchema,
});
export const mailReceivingDomainListResultSchema = z.object({
  domains: z.array(mailReceivingDomainSchema),
});
export const mailReceivingDomainResultSchema = z.object({
  domain: mailReceivingDomainSchema,
});

export const mailOutboundCancelInputSchema = z.object({
  outboundId: z.string().uuid(),
});
export const mailOutboundCancelResultSchema = z.object({
  outbound: mailOutboundRecordSchema.nullable(),
});
export const mailOutboundRetryInputSchema = z.object({
  outboundId: z.string().uuid(),
});
export const mailOutboundRetryResultSchema = z.object({
  outbound: mailOutboundRecordSchema.nullable(),
});

export const mailFiltersListResultSchema = z.object({
  filters: z.array(mailFilterSchema),
});
export const mailFoldersListResultSchema = z.object({
  folders: z.array(mailFolderSummarySchema),
});
export const mailLabelsListResultSchema = z.object({
  labels: z.array(mailLabelSchema),
});
export const mailSearchResultSchema = z.object({
  hits: z.array(mailSearchHitSchema),
});
export const mailOkThreadResultSchema = z.object({
  ok: z.literal(true),
  threadId: z.string(),
});

/** Mail assistance produces reviewable text; it never sends or saves a message. */
export const mailAiSuggestionInputSchema = z
  .object({
    action: z.enum(["compose", "rewrite", "reply", "summarize"]),
    threadId: z.string().uuid().optional(),
    subject: z.string().max(998).default(""),
    body: z.string().max(24000).default(""),
    instructions: z.string().trim().max(2000).default(""),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.action === "reply" || input.action === "summarize") && input.threadId === undefined)
      ctx.addIssue({ code: "custom", path: ["threadId"], message: "Choose a conversation first." });
  });
export const mailAiSuggestionResultSchema = z.object({
  text: z.string().min(1).max(24000),
  classification: z.enum(["public", "standard", "confidential", "restricted"]),
});
export type MailAiSuggestionInput = z.input<typeof mailAiSuggestionInputSchema>;
export type MailAiSuggestionResult = z.output<typeof mailAiSuggestionResultSchema>;
