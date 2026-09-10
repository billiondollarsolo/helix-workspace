import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { outbox } from "./audit.js";
import { actors } from "./auth.js";
import {
  mailAttachmentIngestStatus,
  mailDeliveryEventKind,
  mailDeliveryEventSource,
  mailDeliveryRetryClass,
  mailOutboundProviderKind,
  mailOutboundStatus,
  mailSuppressionReason,
  timestamps,
} from "./common.js";
import { objects } from "./drive.js";
import { messages, threads } from "./messages.js";
import { orgs } from "./tenancy.js";

export const mailInboundDeliveries = pgTable(
  "mail_inbound_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    dedupKey: text("dedup_key").notNull(),
    normalizedMessageId: text("normalized_message_id"),
    rawSha256: text("raw_sha256").notNull(),
    envelopeFrom: text("envelope_from"),
    envelopeTo: text("envelope_to").array().notNull(),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => ({
    orgDedupIdx: uniqueIndex("mail_inbound_deliveries_org_dedup_idx").on(
      table.orgId,
      table.dedupKey,
    ),
    messageIdx: uniqueIndex("mail_inbound_deliveries_message_idx")
      .on(table.messageId)
      .where(sql`${table.messageId} is not null`),
    orgReceivedIdx: index("mail_inbound_deliveries_org_received_idx").on(
      table.orgId,
      table.receivedAt,
    ),
  }),
);

export const mailInboundRecipients = pgTable(
  "mail_inbound_recipients",
  {
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => mailInboundDeliveries.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id),
    address: text("address").notNull(),
    matchKind: text("match_kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.deliveryId, table.address] }),
    actorIdx: index("mail_inbound_recipients_actor_idx").on(
      table.orgId,
      table.actorId,
      table.createdAt,
    ),
  }),
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    orgId: uuid("org_id").notNull(),
    messageId: uuid("message_id").notNull(),
    objectId: uuid("object_id").notNull(),
    disposition: text("disposition").default("attachment").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.objectId] }),
    messageFk: foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [messages.orgId, messages.id],
      name: "message_attachments_message_org_fk",
    }).onDelete("cascade"),
    objectFk: foreignKey({
      columns: [table.orgId, table.objectId],
      foreignColumns: [objects.orgId, objects.id],
      name: "message_attachments_object_org_fk",
    }).onDelete("cascade"),
    orgObjectIdx: index("message_attachments_org_object_idx").on(table.orgId, table.objectId),
  }),
);

export const mailAttachmentIngestions = pgTable(
  "mail_attachment_ingestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id"),
    objectId: uuid("object_id").notNull(),
    messageId: uuid("message_id"),
    status: mailAttachmentIngestStatus("status").default("pending_upload").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename"),
    disposition: text("disposition").default("attachment").notNull(),
    declaredMimeType: text("declared_mime_type").notNull(),
    authoritativeMimeType: text("authoritative_mime_type"),
    expectedByteSize: bigint("expected_byte_size", { mode: "number" }).notNull(),
    actualByteSize: bigint("actual_byte_size", { mode: "number" }),
    expectedSha256: text("expected_sha256").notNull(),
    actualSha256: text("actual_sha256"),
    scanEvidence: jsonb("scan_evidence").default({}).notNull(),
    failureReason: text("failure_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
    cleanupAttemptCount: integer("cleanup_attempt_count").default(0).notNull(),
    lastCleanupError: text("last_cleanup_error"),
    ...timestamps,
  },
  (table) => ({
    ownerFk: foreignKey({
      columns: [table.orgId, table.ownerActorId],
      foreignColumns: [actors.orgId, actors.id],
    }).onDelete("restrict"),
    objectFk: foreignKey({
      columns: [table.orgId, table.objectId],
      foreignColumns: [objects.orgId, objects.id],
    }).onDelete("restrict"),
    messageFk: foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [messages.orgId, messages.id],
    }).onDelete("restrict"),
    orgIdIdx: uniqueIndex("mail_attachment_ingestions_org_id_idx").on(table.orgId, table.id),
    orgObjectIdx: uniqueIndex("mail_attachment_ingestions_org_object_idx").on(
      table.orgId,
      table.objectId,
    ),
    orgStorageKeyIdx: uniqueIndex("mail_attachment_ingestions_org_storage_key_idx").on(
      table.orgId,
      table.storageKey,
    ),
    cleanupIdx: index("mail_attachment_ingestions_cleanup_idx")
      .on(table.expiresAt, table.id)
      .where(sql`${table.status} <> 'attached' and ${table.cleanedAt} is null`),
  }),
);

export const mailRawSources = pgTable("mail_raw_sources", {
  messageId: uuid("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").notNull(),
  objectId: uuid("object_id")
    .notNull()
    .unique()
    .references(() => objects.id, { onDelete: "restrict" }),
  parser: text("parser").notNull(),
  projectionVersion: integer("projection_version").notNull(),
  projection: jsonb("projection").notNull(),
  projectionSha256: text("projection_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const mailMessageIdentities = pgTable(
  "mail_message_identities",
  {
    messageId: uuid("message_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    normalizedMessageId: text("normalized_message_id"),
    rawSha256: text("raw_sha256"),
    providerDeliveryId: text("provider_delivery_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    messageFk: foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [messages.orgId, messages.id],
      name: "mail_message_identities_message_fk",
    }).onDelete("cascade"),
    rfcIdx: uniqueIndex("mail_message_identities_rfc_uidx")
      .on(table.orgId, table.normalizedMessageId)
      .where(sql`${table.normalizedMessageId} is not null`),
    rawIdx: uniqueIndex("mail_message_identities_raw_uidx")
      .on(table.orgId, table.rawSha256)
      .where(sql`${table.rawSha256} is not null`),
    providerIdx: uniqueIndex("mail_message_identities_provider_uidx")
      .on(table.orgId, table.providerDeliveryId)
      .where(sql`${table.providerDeliveryId} is not null`),
  }),
);

export const mailMessageDeliveries = pgTable(
  "mail_message_deliveries",
  {
    orgId: uuid("org_id").notNull(),
    messageId: uuid("message_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.actorId] }),
    messageFk: foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [messages.orgId, messages.id],
      name: "mail_message_deliveries_message_fk",
    }).onDelete("cascade"),
    actorFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "mail_message_deliveries_actor_fk",
    }).onDelete("cascade"),
    actorIdx: index("mail_message_deliveries_actor_idx").on(
      table.orgId,
      table.actorId,
      table.deliveredAt,
    ),
  }),
);

export const mailFilters = pgTable(
  "mail_filters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    priority: integer("priority").default(100).notNull(),
    criteria: jsonb("criteria").default({}).notNull(),
    actions: jsonb("actions").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    actorEnabledIdx: index("mail_filters_actor_enabled_idx").on(table.actorId, table.enabled),
    orgPriorityIdx: index("mail_filters_org_priority_idx").on(table.orgId, table.priority),
  }),
);

export const mailUserSettings = pgTable(
  "mail_user_settings",
  {
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    signatureText: text("signature_text").default("").notNull(),
    signatureHtml: text("signature_html"),
    includeSignatureOnReplies: boolean("include_signature_on_replies").default(true).notNull(),
    blockedSenders: text("blocked_senders").array().default([]).notNull(),
    ...timestamps,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.actorId] }),
    actorFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "mail_user_settings_actor_fk",
    }).onDelete("cascade"),
  }),
);

export const mailAliases = pgTable(
  "mail_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    enabled: boolean("enabled").default(true).notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    receiveEnabled: boolean("receive_enabled").default(true).notNull(),
    sendAsEnabled: boolean("send_as_enabled").default(true).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    actorIdx: index("mail_aliases_actor_idx").on(table.actorId),
    emailActiveIdx: uniqueIndex("mail_aliases_org_email_active_idx")
      .on(table.orgId, table.email)
      .where(sql`${table.disabledAt} is null`),
  }),
);

export const mailVacation = pgTable(
  "mail_vacation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    actorIdx: uniqueIndex("mail_vacation_actor_idx").on(table.actorId),
    orgEnabledIdx: index("mail_vacation_org_enabled_idx").on(table.orgId, table.enabled),
  }),
);

export const mailVacationResponses = pgTable(
  "mail_vacation_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vacationId: uuid("vacation_id")
      .references(() => mailVacation.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    senderEmail: text("sender_email").notNull(),
    messageId: uuid("message_id").references(() => messages.id),
    threadId: uuid("thread_id").references(() => threads.id),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    vacationSenderIdx: uniqueIndex("mail_vacation_responses_sender_idx").on(
      table.vacationId,
      table.senderEmail,
    ),
    actorIdx: index("mail_vacation_responses_actor_idx").on(table.actorId),
  }),
);

export const mailThreadState = pgTable(
  "mail_thread_state",
  {
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    threadId: uuid("thread_id")
      .references(() => threads.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id").notNull(),
    labels: text("labels").array().default([]).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    trashPurgeAfter: timestamp("trash_purge_after", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    starred: boolean("starred").default(false).notNull(),
    spamAt: timestamp("spam_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.actorId, table.threadId] }),
    orgLabelsIdx: index("mail_thread_state_org_labels_idx").on(table.orgId),
    snoozeIdx: index("mail_thread_state_snooze_idx").on(table.snoozedUntil),
    starredIdx: index("mail_thread_state_starred_idx").on(
      table.orgId,
      table.actorId,
      table.starred,
    ),
    spamIdx: index("mail_thread_state_spam_idx").on(table.orgId, table.actorId, table.spamAt),
    trashPurgeIdx: index("mail_thread_state_trash_purge_idx")
      .on(table.trashPurgeAfter, table.orgId, table.actorId, table.threadId)
      .where(sql`${table.trashPurgeAfter} is not null`),
    trashDeadlineCheck: check(
      "mail_thread_state_trash_deadline_check",
      sql`(${table.deletedAt} is null and ${table.trashPurgeAfter} is null)
          or (${table.deletedAt} is not null and ${table.trashPurgeAfter} is not null)`,
    ),
  }),
);

export const mailRetentionHolds = pgTable(
  "mail_retention_holds",
  {
    orgId: uuid("org_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByActorId: uuid("created_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.threadId] }),
    threadFk: foreignKey({
      columns: [table.orgId, table.threadId],
      foreignColumns: [threads.orgId, threads.id],
    }).onDelete("cascade"),
    actorFk: foreignKey({
      columns: [table.orgId, table.createdByActorId],
      foreignColumns: [actors.orgId, actors.id],
    }).onDelete("restrict"),
    expiryIdx: index("mail_retention_holds_expiry_idx").on(
      table.expiresAt,
      table.orgId,
      table.threadId,
    ),
    reasonCheck: check(
      "mail_retention_holds_reason_check",
      sql`char_length(btrim(${table.reason})) between 1 and 500`,
    ),
  }),
);

export const mailOutboundMessages = pgTable(
  "mail_outbound_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    messageId: uuid("message_id")
      .references(() => messages.id)
      .notNull(),
    threadId: uuid("thread_id")
      .references(() => threads.id)
      .notNull(),
    outboxId: uuid("outbox_id").references(() => outbox.id),
    status: mailOutboundStatus("status").default("queued").notNull(),
    envelope: jsonb("envelope").notNull(),
    undoUntil: timestamp("undo_until", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    providerId: text("provider_id"),
    providerKind: text("provider_kind"),
    providerDecisionSource: text("provider_decision_source"),
    providerDecidedAt: timestamp("provider_decided_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    handoffKey: uuid("handoff_key").defaultRandom().notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveryStatus: text("delivery_status"),
    deliveryEventAt: timestamp("delivery_event_at", { withTimezone: true }),
    deliveryMetadata: jsonb("delivery_metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    actorStatusIdx: index("mail_outbound_actor_status_idx").on(table.actorId, table.status),
    outboxIdx: index("mail_outbound_outbox_idx").on(table.outboxId),
    handoffKeyIdx: uniqueIndex("mail_outbound_handoff_key_idx").on(table.handoffKey),
    dueIdx: index("mail_outbound_due_idx")
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.status} = 'queued' and ${table.deadLetteredAt} is null`),
    staleLeaseIdx: index("mail_outbound_stale_lease_idx")
      .on(table.leaseExpiresAt, table.id)
      .where(sql`${table.status} = 'sending'`),
    attemptCountCheck: check("mail_outbound_attempt_count_check", sql`${table.attemptCount} >= 0`),
    leaseStateCheck: check(
      "mail_outbound_lease_state_check",
      sql`(${table.status} = 'sending' and ${table.nextAttemptAt} is null and ${table.leaseOwner} is not null and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} = 'queued' and ${table.nextAttemptAt} is not null and ${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null) or (${table.status} not in ('sending', 'queued') and ${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
  }),
);

export const mailOutboundProviders = pgTable(
  "mail_outbound_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    kind: mailOutboundProviderKind("kind").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    config: jsonb("config").default({}).notNull(),
    secretRef: text("secret_ref"),
    webhookSecretRef: text("webhook_secret_ref"),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("mail_outbound_providers_org_idx").on(table.orgId, table.createdAt),
    orgIdIdx: uniqueIndex("mail_outbound_providers_org_id_idx").on(table.orgId, table.id),
    orgNameIdx: uniqueIndex("mail_outbound_providers_org_name_idx").on(table.orgId, table.name),
    orgDefaultIdx: uniqueIndex("mail_outbound_providers_org_default_idx")
      .on(table.orgId)
      .where(sql`${table.isDefault}`),
    secretHandleCheck: check(
      "mail_outbound_providers_secret_handle",
      sql`${table.secretRef} is null or ${table.secretRef} ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'`,
    ),
    webhookSecretHandleCheck: check(
      "mail_outbound_providers_webhook_secret_handle",
      sql`${table.webhookSecretRef} is null or ${table.webhookSecretRef} ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'`,
    ),
    publicConfigCheck: check(
      "mail_outbound_providers_public_config",
      sql`jsonb_typeof(${table.config}) = 'object' and case ${table.kind}
        when 'ses' then ${table.config} - array['host', 'port', 'secure', 'user', 'region'] = '{}'::jsonb
        when 'smtp' then ${table.config} - array['host', 'port', 'secure', 'user'] = '{}'::jsonb
        when 'mailgun' then ${table.config} - array['domain', 'baseUrl'] = '{}'::jsonb
        when 'postmark' then ${table.config} - array['baseUrl', 'messageStream'] = '{}'::jsonb
        else false end
        and (not (${table.config} ? 'host') or (jsonb_typeof(${table.config}->'host') = 'string' and ${table.config}->>'host' !~ '[@/]'))
        and (not (${table.config} ? 'port') or jsonb_typeof(${table.config}->'port') = 'number')
        and (not (${table.config} ? 'secure') or jsonb_typeof(${table.config}->'secure') = 'boolean')
        and (not (${table.config} ? 'user') or jsonb_typeof(${table.config}->'user') = 'string')
        and (not (${table.config} ? 'region') or jsonb_typeof(${table.config}->'region') = 'string')
        and (not (${table.config} ? 'domain') or (jsonb_typeof(${table.config}->'domain') = 'string' and ${table.config}->>'domain' !~ '[@/]'))
        and (not (${table.config} ? 'baseUrl') or (jsonb_typeof(${table.config}->'baseUrl') = 'string' and ${table.config}->>'baseUrl' ~ '^https://' and ${table.config}->>'baseUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))
        and (not (${table.config} ? 'messageStream') or jsonb_typeof(${table.config}->'messageStream') = 'string')`,
    ),
  }),
);

export const mailDeliveryEvents = pgTable(
  "mail_delivery_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    providerId: uuid("provider_id").notNull(),
    outboundId: uuid("outbound_id").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    source: mailDeliveryEventSource("source").notNull(),
    kind: mailDeliveryEventKind("kind").notNull(),
    retryClass: mailDeliveryRetryClass("retry_class").notNull(),
    recipient: text("recipient").notNull(),
    diagnostic: text("diagnostic"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerFk: foreignKey({
      columns: [table.orgId, table.providerId],
      foreignColumns: [mailOutboundProviders.orgId, mailOutboundProviders.id],
    }),
    outboundFk: foreignKey({
      columns: [table.orgId, table.outboundId],
      foreignColumns: [mailOutboundMessages.orgId, mailOutboundMessages.id],
    }).onDelete("cascade"),
    providerEventIdx: uniqueIndex("mail_delivery_events_provider_event_idx").on(
      table.orgId,
      table.providerId,
      table.providerEventId,
    ),
    outboundIdx: index("mail_delivery_events_outbound_idx").on(
      table.orgId,
      table.outboundId,
      table.occurredAt,
    ),
    recipientCheck: check(
      "mail_delivery_events_recipient_check",
      sql`${table.recipient} = lower(btrim(${table.recipient})) and length(${table.recipient}) between 3 and 320`,
    ),
  }),
);

export const mailSuppressions = pgTable(
  "mail_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    address: text("address").notNull(),
    reason: mailSuppressionReason("reason").notNull(),
    sourceEventId: uuid("source_event_id"),
    sourceEventPurgedAt: timestamp("source_event_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
    removeReason: text("remove_reason"),
  },
  (table) => ({
    eventFk: foreignKey({
      columns: [table.orgId, table.sourceEventId],
      foreignColumns: [mailDeliveryEvents.orgId, mailDeliveryEvents.id],
    }),
    removedByFk: foreignKey({
      columns: [table.orgId, table.removedBy],
      foreignColumns: [actors.orgId, actors.id],
    }),
    activeAddressIdx: uniqueIndex("mail_suppressions_active_address_idx")
      .on(table.orgId, table.address)
      .where(sql`${table.removedAt} is null`),
    orgCreatedIdx: index("mail_suppressions_org_created_idx").on(table.orgId, table.createdAt),
    addressCheck: check(
      "mail_suppressions_address_check",
      sql`${table.address} = lower(btrim(${table.address})) and length(${table.address}) between 3 and 320`,
    ),
    sourceEventPurgeCheck: check(
      "mail_suppressions_source_event_purge_check",
      sql`${table.sourceEventId} is null or ${table.sourceEventPurgedAt} is null`,
    ),
  }),
);

export const mailProviderDeliveryEvents = pgTable(
  "mail_provider_delivery_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => mailOutboundProviders.id, { onDelete: "restrict" }),
    outboundId: uuid("outbound_id").references(() => mailOutboundMessages.id, {
      onDelete: "set null",
    }),
    providerEventId: text("provider_event_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    normalizedRecipient: text("normalized_recipient").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex("mail_provider_delivery_events_idempotency_idx").on(
      table.orgId,
      table.providerId,
      table.providerEventId,
    ),
    outboundIdx: index("mail_provider_delivery_events_outbound_idx").on(
      table.orgId,
      table.outboundId,
      table.occurredAt,
      table.id,
    ),
    thresholdIdx: index("mail_provider_delivery_events_threshold_idx").on(
      table.orgId,
      table.eventType,
      table.occurredAt,
    ),
  }),
);
