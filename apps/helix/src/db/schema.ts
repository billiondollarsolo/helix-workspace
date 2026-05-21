import {
  boolean,
  cidr,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const actorType = pgEnum("actor_type", ["user", "agent", "service_account", "system"]);
export const objectKind = pgEnum("object_kind", [
  "file",
  "mail_attachment",
  "document",
  "recording",
  "other",
]);
export const threadKind = pgEnum("thread_kind", [
  "mail",
  "chat_room",
  "chat_dm",
  "doc",
  "calendar",
  "call",
]);
export const messageKind = pgEnum("message_kind", ["mail", "chat", "comment", "system"]);
export const pendingActionStatus = pgEnum("pending_action_status", [
  "pending_confirmation",
  "confirmed",
  "cancelled",
  "expired",
]);
export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "pending",
  "in_progress",
  "delivered",
  "failed",
  "abandoned",
]);
export const webhookDirection = pgEnum("webhook_direction", ["outbound", "inbound"]);
export const mailOutboundStatus = pgEnum("mail_outbound_status", [
  "queued",
  "cancelled",
  "sending",
  "sent",
  "failed",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const actors = pgTable(
  "actors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    type: actorType("type").notNull(),
    email: text("email"),
    displayName: text("display_name").notNull(),
    parentUserId: uuid("parent_user_id"),
    scopes: text("scopes").array().default([]).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgEmailIdx: uniqueIndex("actors_org_email_idx").on(table.orgId, table.email),
    parentIdx: index("actors_parent_user_idx").on(table.parentUserId),
  }),
);

export const objects = pgTable(
  "objects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id").references(() => actors.id),
    kind: objectKind("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256"),
    classification: text("classification").default("internal").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgKindIdx: index("objects_org_kind_idx").on(table.orgId, table.kind),
    ownerIdx: index("objects_owner_actor_idx").on(table.ownerActorId),
  }),
);

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    kind: threadKind("kind").notNull(),
    subject: text("subject"),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    metadata: jsonb("metadata").default({}).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgKindIdx: index("threads_org_kind_idx").on(table.orgId, table.kind),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    threadId: uuid("thread_id")
      .references(() => threads.id)
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    kind: messageKind("kind").notNull(),
    body: text("body").notNull(),
    bodyFormat: text("body_format").default("plain").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    threadSentIdx: index("messages_thread_sent_idx").on(table.threadId, table.sentAt),
    orgKindIdx: index("messages_org_kind_idx").on(table.orgId, table.kind),
  }),
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    messageId: uuid("message_id")
      .references(() => messages.id)
      .notNull(),
    objectId: uuid("object_id")
      .references(() => objects.id)
      .notNull(),
    disposition: text("disposition").default("attachment").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.objectId] }),
  }),
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    role: text("role").notNull(),
    grantedByActorId: uuid("granted_by_actor_id").references(() => actors.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    resourceIdx: index("permissions_resource_idx").on(table.resourceType, table.resourceId),
    actorIdx: index("permissions_actor_idx").on(table.actorId),
  }),
);

export const activity = pgTable(
  "activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    verb: text("verb").notNull(),
    objectType: text("object_type").notNull(),
    objectId: uuid("object_id"),
    traceId: text("trace_id"),
    payload: jsonb("payload").default({}).notNull(),
    prevHash: text("prev_hash"),
    thisHash: text("this_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgCreatedIdx: index("activity_org_created_idx").on(table.orgId, table.createdAt),
    hashIdx: uniqueIndex("activity_hash_idx").on(table.thisHash),
  }),
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subject: text("subject").notNull(),
    payload: jsonb("payload").notNull(),
    traceId: text("trace_id"),
    spanId: text("span_id"),
    traceparent: text("traceparent"),
    tracestate: text("tracestate"),
    deliverAfter: timestamp("deliver_after", { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pendingIdx: index("outbox_pending_idx").on(table.deliverAfter, table.deliveredAt),
  }),
);

export const aiArtifacts = pgTable("ai_artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull(),
  actorId: uuid("actor_id").references(() => actors.id),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  feature: text("feature").notNull(),
  inputHash: text("input_hash").notNull(),
  outputHash: text("output_hash").notNull(),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    source: text("source").default("assistant.conversation").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 768 }),
    metadata: jsonb("metadata").default({}).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    actorIdx: index("memory_items_actor_idx").on(table.actorId),
    actorCreatedIdx: index("memory_items_actor_created_idx").on(table.actorId, table.createdAt),
  }),
);

export const vectorMetric = pgEnum("vector_metric", ["cosine", "dot", "l2"]);

export const vectorCollections = pgTable("vector_collections", {
  name: text("name").primaryKey(),
  dim: integer("dim").notNull(),
  metric: vectorMetric("metric").notNull(),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const vectorItems = pgTable(
  "vector_items",
  {
    collectionName: text("collection_name")
      .references(() => vectorCollections.name, { onDelete: "cascade" })
      .notNull(),
    id: text("id").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.collectionName, table.id] }),
    metadataIdx: index("vector_items_metadata_idx").using("gin", table.metadata),
  }),
);

export const pendingActions = pgTable("pending_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull(),
  actorId: uuid("actor_id")
    .references(() => actors.id)
    .notNull(),
  toolId: text("tool_id").notNull(),
  input: jsonb("input").notNull(),
  status: pendingActionStatus("status").default("pending_confirmation").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  traceId: text("trace_id"),
  result: jsonb("result"),
  error: text("error"),
});

export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    title: text("title"),
    memoryOptIn: boolean("memory_opt_in").default(false).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    actorUpdatedIdx: index("assistant_conversations_actor_updated_idx").on(
      table.actorId,
      table.updatedAt,
    ),
    orgUpdatedIdx: index("assistant_conversations_org_updated_idx").on(
      table.orgId,
      table.updatedAt,
    ),
  }),
);

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    conversationId: uuid("conversation_id")
      .references(() => assistantConversations.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    toolCallId: text("tool_call_id"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    conversationCreatedIdx: index("assistant_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    orgActorCreatedIdx: index("assistant_messages_org_actor_created_idx").on(
      table.orgId,
      table.actorId,
      table.createdAt,
    ),
  }),
);

export const assistantMemoryPreferences = pgTable(
  "assistant_memory_preferences",
  {
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id, { onDelete: "cascade" })
      .notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.actorId] }),
    actorIdx: index("assistant_memory_preferences_actor_idx").on(table.actorId),
  }),
);

export const appPasswords = pgTable(
  "app_passwords",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    label: text("label").notNull(),
    hash: text("hash").notNull(),
    scopes: text("scopes").array().default([]).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    actorIdx: index("app_passwords_actor_idx").on(table.actorId),
  }),
);

export const platformConfig = pgTable("platform_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  sensitive: boolean("sensitive").default(false).notNull(),
  updatedByActorId: uuid("updated_by_actor_id").references(() => actors.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const installedPlugins = pgTable("installed_plugins", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  manifest: jsonb("manifest").notNull(),
  state: text("state").default("discovered").notNull(),
  migrationsApplied: text("migrations_applied").array().default([]).notNull(),
  installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pluginMigrations = pgTable(
  "plugin_migrations",
  {
    pluginId: text("plugin_id")
      .references(() => installedPlugins.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pluginId, table.name] }),
  }),
);

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    credentialType: text("credential_type").default("oauth_client").notNull(),
    clientId: text("client_id").notNull(),
    secretHash: text("secret_hash"),
    certFingerprint: text("cert_fingerprint"),
    scopes: text("scopes").array().default([]).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rateLimitOverrides: jsonb("rate_limit_overrides").default({}).notNull(),
    ipAllowlist: cidr("ip_allowlist").array(),
    allowedHours: jsonb("allowed_hours"),
    confirmationOverride: jsonb("confirmation_override"),
    createdBy: uuid("created_by").references(() => actors.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).notNull(),
  },
  (table) => ({
    clientIdx: uniqueIndex("agent_credentials_client_active_idx")
      .on(table.clientId)
      .where(sql`${table.revokedAt} is null`),
    actorIdx: index("agent_credentials_actor_idx").on(table.actorId),
  }),
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id)
      .notNull(),
    orgId: uuid("org_id").notNull(),
    scopes: text("scopes").array().default([]).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    clientIdx: index("oauth_access_tokens_client_idx").on(table.clientId),
    actorIdx: index("oauth_access_tokens_actor_idx").on(table.actorId),
    expiresAtIdx: index("oauth_access_tokens_expires_at_idx").on(table.expiresAt),
  }),
);

export const outboundWebhooks = pgTable(
  "outbound_webhooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    eventSubjects: text("event_subjects").array().default([]).notNull(),
    secretRef: text("secret_ref"),
    headers: jsonb("headers").default({}).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgEnabledIdx: index("outbound_webhooks_org_enabled_idx").on(table.orgId, table.enabled),
    orgNameIdx: index("outbound_webhooks_org_name_idx").on(table.orgId, table.name),
  }),
);

export const inboundWebhooks = pgTable(
  "inbound_webhooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    source: text("source").notNull(),
    secretRef: text("secret_ref"),
    enabled: boolean("enabled").default(true).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgEnabledIdx: index("inbound_webhooks_org_enabled_idx").on(table.orgId, table.enabled),
    orgSlugIdx: index("inbound_webhooks_org_slug_idx").on(table.orgId, table.slug),
    orgSourceIdx: index("inbound_webhooks_org_source_idx").on(table.orgId, table.source),
  }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    direction: webhookDirection("direction").notNull(),
    outboundWebhookId: uuid("outbound_webhook_id").references(() => outboundWebhooks.id),
    inboundWebhookId: uuid("inbound_webhook_id").references(() => inboundWebhooks.id),
    eventSubject: text("event_subject").notNull(),
    status: webhookDeliveryStatus("status").default("pending").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    payload: jsonb("payload").notNull(),
    payloadSha256: text("payload_sha256"),
    signature: text("signature"),
    requestHeaders: jsonb("request_headers").default({}).notNull(),
    responseStatus: integer("response_status"),
    responseHeaders: jsonb("response_headers").default({}).notNull(),
    error: text("error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgStatusIdx: index("webhook_deliveries_org_status_idx").on(table.orgId, table.status),
    outboundIdx: index("webhook_deliveries_outbound_idx").on(table.outboundWebhookId),
    inboundIdx: index("webhook_deliveries_inbound_idx").on(table.inboundWebhookId),
    nextAttemptIdx: index("webhook_deliveries_next_attempt_idx").on(
      table.nextAttemptAt,
      table.status,
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
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    starred: boolean("starred").default(false).notNull(),
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
    providerMessageId: text("provider_message_id"),
    deliveryMetadata: jsonb("delivery_metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    actorStatusIdx: index("mail_outbound_actor_status_idx").on(table.actorId, table.status),
    outboxIdx: index("mail_outbound_outbox_idx").on(table.outboxId),
  }),
);

export const driveFolders = pgTable(
  "drive_folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    parentFolderId: uuid("parent_folder_id"),
    ownerActorId: uuid("owner_actor_id").references(() => actors.id),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgParentIdx: index("drive_folders_org_parent_idx").on(table.orgId, table.parentFolderId),
    ownerIdx: index("drive_folders_owner_idx").on(table.ownerActorId),
  }),
);

export const driveVersions = pgTable(
  "drive_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id")
      .references(() => objects.id, { onDelete: "cascade" })
      .notNull(),
    versionNumber: integer("version_number").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    objectVersionIdx: uniqueIndex("drive_versions_object_version_idx").on(
      table.objectId,
      table.versionNumber,
    ),
    objectCreatedIdx: index("drive_versions_object_created_idx").on(
      table.objectId,
      table.createdAt,
    ),
    orgObjectIdx: index("drive_versions_org_object_idx").on(table.orgId, table.objectId),
  }),
);

export const docsDocuments = pgTable(
  "docs_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    title: text("title").notNull(),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    ownerActorId: uuid("owner_actor_id").references(() => actors.id),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    ydocState: bytea("ydoc_state"),
    ydocStateVector: bytea("ydoc_state_vector"),
    updateSeq: integer("update_seq").default(0).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgUpdatedIdx: index("docs_documents_org_updated_idx").on(table.orgId, table.updatedAt),
    ownerIdx: index("docs_documents_owner_idx").on(table.ownerActorId),
    threadIdx: index("docs_documents_thread_idx").on(table.threadId),
  }),
);

export const docsUpdates = pgTable(
  "docs_updates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id")
      .references(() => docsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    seq: integer("seq").notNull(),
    update: bytea("update").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    documentSeqIdx: uniqueIndex("docs_updates_document_seq_idx").on(table.documentId, table.seq),
    documentCreatedIdx: index("docs_updates_document_created_idx").on(
      table.documentId,
      table.createdAt,
    ),
    orgCreatedIdx: index("docs_updates_org_created_idx").on(table.orgId, table.createdAt),
  }),
);

export const docsComments = pgTable(
  "docs_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id")
      .references(() => docsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    anchor: jsonb("anchor").default({}).notNull(),
    body: text("body").notNull(),
    status: text("status").default("open").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    documentStatusIdx: index("docs_comments_document_status_idx").on(
      table.documentId,
      table.status,
    ),
    orgCreatedIdx: index("docs_comments_org_created_idx").on(table.orgId, table.createdAt),
  }),
);

export const docsSuggestions = pgTable(
  "docs_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id")
      .references(() => docsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    anchor: jsonb("anchor").default({}).notNull(),
    beforeText: text("before_text").default("").notNull(),
    afterText: text("after_text").default("").notNull(),
    reason: text("reason").default("").notNull(),
    status: text("status").default("pending").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    resolvedByActorId: uuid("resolved_by_actor_id").references(() => actors.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    documentStatusIdx: index("docs_suggestions_document_status_idx").on(
      table.documentId,
      table.status,
    ),
    orgCreatedIdx: index("docs_suggestions_org_created_idx").on(table.orgId, table.createdAt),
  }),
);

export const calCalendars = pgTable(
  "cal_calendars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id")
      .references(() => actors.id)
      .notNull(),
    name: text("name").notNull(),
    color: text("color"),
    timezone: text("timezone").default("UTC").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    ownerIdx: index("cal_calendars_owner_idx").on(table.ownerActorId, table.deletedAt),
    orgIdx: index("cal_calendars_org_idx").on(table.orgId),
  }),
);

export const calEvents = pgTable(
  "cal_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    calendarId: uuid("calendar_id")
      .references(() => calCalendars.id, { onDelete: "cascade" })
      .notNull(),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    uid: text("uid").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    allDay: boolean("all_day").default(false).notNull(),
    status: text("status").default("confirmed").notNull(),
    recurrenceRule: text("recurrence_rule"),
    organizerActorId: uuid("organizer_actor_id").references(() => actors.id),
    organizerEmail: text("organizer_email"),
    icsSequence: integer("ics_sequence").default(0).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    calendarTimeIdx: index("cal_events_calendar_time_idx").on(
      table.calendarId,
      table.startsAt,
      table.endsAt,
    ),
    orgTimeIdx: index("cal_events_org_time_idx").on(table.orgId, table.startsAt, table.endsAt),
    organizerIdx: index("cal_events_organizer_idx").on(table.organizerActorId),
  }),
);

export const calAttendees = pgTable(
  "cal_attendees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    eventId: uuid("event_id")
      .references(() => calEvents.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: text("role").default("required").notNull(),
    responseStatus: text("response_status").default("needs_action").notNull(),
    isOrganizer: boolean("is_organizer").default(false).notNull(),
    rsvpToken: text("rsvp_token").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    rsvpTokenIdx: uniqueIndex("cal_attendees_rsvp_token_idx").on(table.rsvpToken),
    actorIdx: index("cal_attendees_actor_idx").on(table.actorId),
    eventIdx: index("cal_attendees_event_idx").on(table.eventId),
  }),
);

export const meetRooms = pgTable(
  "meet_rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    threadId: uuid("thread_id")
      .references(() => threads.id, { onDelete: "cascade" })
      .notNull(),
    roomName: text("room_name").notNull(),
    subject: text("subject").notNull(),
    jitsiDomain: text("jitsi_domain").notNull(),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    status: text("status").default("active").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    threadIdx: uniqueIndex("meet_rooms_thread_idx").on(table.threadId),
    orgRoomIdx: uniqueIndex("meet_rooms_org_room_name_idx").on(table.orgId, table.roomName),
    orgStatusIdx: index("meet_rooms_org_status_idx").on(table.orgId, table.status),
    createdByIdx: index("meet_rooms_created_by_idx").on(table.createdByActorId, table.status),
  }),
);

export const chatRoomSettings = pgTable(
  "chat_room_settings",
  {
    threadId: uuid("thread_id")
      .references(() => threads.id, { onDelete: "cascade" })
      .primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name"),
    topic: text("topic"),
    isPrivate: boolean("is_private").default(false).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("chat_room_settings_org_idx").on(table.orgId),
  }),
);

export const chatReactions = pgTable(
  "chat_reactions",
  {
    messageId: uuid("message_id")
      .references(() => messages.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.actorId, table.emoji] }),
    orgEmojiIdx: index("chat_reactions_org_emoji_idx").on(table.orgId, table.emoji),
  }),
);

export const chatPins = pgTable(
  "chat_pins",
  {
    messageId: uuid("message_id")
      .references(() => messages.id, { onDelete: "cascade" })
      .notNull(),
    threadId: uuid("thread_id")
      .references(() => threads.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id").notNull(),
    pinnedByActorId: uuid("pinned_by_actor_id").references(() => actors.id),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.threadId, table.messageId] }),
    orgThreadIdx: index("chat_pins_org_thread_idx").on(table.orgId, table.threadId),
  }),
);

export const chatReadReceipts = pgTable(
  "chat_read_receipts",
  {
    threadId: uuid("thread_id")
      .references(() => threads.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id").notNull(),
    lastReadMessageId: uuid("last_read_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.threadId, table.actorId] }),
    actorIdx: index("chat_read_receipts_actor_idx").on(table.actorId, table.updatedAt),
  }),
);
