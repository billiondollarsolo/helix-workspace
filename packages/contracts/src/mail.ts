import { z } from "zod";

export const mailAddressSchema = z.object({
  address: z.string().email(),
  name: z.string().min(1).optional(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

export const mailAttachmentInputSchema = z.object({
  filename: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  objectId: z.string().uuid().optional(),
  path: z.string().min(1).optional(),
});
export type MailAttachmentInput = z.infer<typeof mailAttachmentInputSchema>;

export const mailSendInputSchema = z.object({
  from: mailAddressSchema.optional(),
  to: z.array(mailAddressSchema).min(1),
  cc: z.array(mailAddressSchema).default([]),
  bcc: z.array(mailAddressSchema).default([]),
  subject: z.string().max(998),
  bodyText: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z.array(mailAttachmentInputSchema).default([]),
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

export const mailThreadRowSchema = z.object({
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
  applyLabels: z.array(z.string().min(1)).optional(),
  archive: z.boolean().optional(),
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

export const mailLabelSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  sortOrder: z.number().int(),
  threadCount: z.number().int().nonnegative(),
  shared: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailLabel = z.infer<typeof mailLabelSchema>;

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
  to: z.array(mailAddressSchema).default([]),
  cc: z.array(mailAddressSchema).default([]),
  bcc: z.array(mailAddressSchema).default([]),
  subject: z.string().default(""),
  bodyText: z.string().default(""),
  bodyHtml: z.string().optional(),
  attachments: z.array(mailAttachmentInputSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MailDraft = z.infer<typeof mailDraftSchema>;

export const mailDraftSaveInputSchema = z.object({
  id: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  to: z.array(mailAddressSchema).default([]),
  cc: z.array(mailAddressSchema).default([]),
  bcc: z.array(mailAddressSchema).default([]),
  subject: z.string().default(""),
  bodyText: z.string().default(""),
  bodyHtml: z.string().optional(),
  attachments: z.array(mailAttachmentInputSchema).default([]),
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
  createdAt: z.string(),
});
export type MailAlias = z.infer<typeof mailAliasSchema>;

export const mailAliasCreateInputSchema = z.object({
  address: z.string().email(),
  targetActorId: z.string().uuid(),
  displayName: z.string().min(1).optional(),
  isPrimary: z.boolean().default(false),
});
export const mailAliasDeleteInputSchema = z.object({
  id: z.string().uuid(),
});
export const mailAliasListResultSchema = z.object({
  aliases: z.array(mailAliasSchema),
});

export const mailOutboundCancelInputSchema = z.object({
  outboundId: z.string().uuid(),
});
export const mailOutboundCancelResultSchema = z.object({
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
