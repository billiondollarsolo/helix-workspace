import {
  boolean,
  cidr,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const actorType = pgEnum("actor_type", ["user", "agent", "service_account", "system"]);
export const orgStatus = pgEnum("org_status", [
  "provisioning",
  "active",
  "suspended",
  "soft_deleted",
  "hard_deleted",
]);
export const objectKind = pgEnum("object_kind", [
  "file",
  "mail_attachment",
  "document",
  "recording",
  "other",
]);
export const driveUploadState = pgEnum("drive_upload_state", [
  "pending_upload",
  "uploaded",
  "scanning",
  "active",
  "quarantined",
  "scan_failed",
  "trashed",
]);
export const driveScanJobStatus = pgEnum("drive_scan_job_status", [
  "pending",
  "running",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
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
  "approved",
  "executing",
  "executed",
  "failed",
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
export const mailOutboundProviderKind = pgEnum("mail_outbound_provider_kind", [
  "ses",
  "mailgun",
  "smtp",
  "postmark",
]);
export const mailDkimKeyStatus = pgEnum("mail_dkim_key_status", ["active", "retiring", "retired"]);
export const mailReceivingDomainStatus = pgEnum("mail_receiving_domain_status", [
  "pending",
  "verified",
  "active",
  "disabled",
]);
export const mailRoutingActionKind = pgEnum("mail_routing_action_kind", [
  "forward",
  "alias",
  "drop",
  "tag",
  "mailbox",
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

export const plans = pgTable(
  "plans",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    pricing: jsonb("pricing").default({}).notNull(),
    featureFlagsDefault: jsonb("feature_flags_default").default({}).notNull(),
    quotasDefault: jsonb("quotas_default").default({}).notNull(),
    availableFor: text("available_for").array().default(["saas", "self-host"]).notNull(),
    stripeProductId: text("stripe_product_id"),
    stripePriceIds: jsonb("stripe_price_ids"),
    sortOrder: integer("sort_order").default(100).notNull(),
    available: boolean("available").default(true).notNull(),
    ...timestamps,
  },
  (table) => ({
    availableIdx: index("plans_available_idx").on(table.available, table.sortOrder),
  }),
);

export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    status: orgStatus("status").default("active").notNull(),
    tier: text("tier").default("personal").notNull(),
    planId: text("plan_id")
      .default("personal")
      .notNull()
      .references(() => plans.id),
    region: text("region").default("default").notNull(),
    byoConfig: jsonb("byo_config").default({}).notNull(),
    featureFlags: jsonb("feature_flags").default({}).notNull(),
    quotas: jsonb("quotas").default({}).notNull(),
    branding: jsonb("branding").default({}).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }),
    hardDeletedAt: timestamp("hard_deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    slugIdx: uniqueIndex("orgs_slug_idx").on(table.slug),
    statusIdx: index("orgs_status_idx").on(table.status),
    planIdx: index("orgs_plan_id_idx").on(table.planId),
  }),
);

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

export const tenantConfigAudit = pgTable(
  "tenant_config_audit",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    changedBy: uuid("changed_by").references(() => actors.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    reason: text("reason"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.key, table.changedAt] }),
  }),
);

export const tenantIdpConfigs = pgTable(
  "tenant_idp_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    protocol: text("protocol").notNull(),
    isPrimary: boolean("is_primary").default(true).notNull(),
    displayName: text("display_name").notNull(),
    config: jsonb("config").default({}).notNull(),
    signingCertVaultPath: text("signing_cert_vault_path"),
    attrMapping: jsonb("attr_mapping").default({}).notNull(),
    jitProvisioning: boolean("jit_provisioning").default(true).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    ...timestamps,
  },
  (table) => ({
    primaryIdx: uniqueIndex("tenant_idp_configs_primary_idx")
      .on(table.orgId)
      .where(sql`${table.isPrimary} and ${table.enabled}`),
    orgIdx: index("tenant_idp_configs_org_idx").on(table.orgId, table.enabled, table.isPrimary),
  }),
);

export const tenantProvisioningState = pgTable(
  "tenant_provisioning_state",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => orgs.id, { onDelete: "cascade" }),
    status: text("status").default("pending").notNull(),
    requestedOwnerEmail: text("requested_owner_email").notNull(),
    currentStep: text("current_step").default("signup_received").notNull(),
    completedSteps: text("completed_steps").array().default([]).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    metadata: jsonb("metadata").default({}).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    statusIdx: index("tenant_provisioning_state_status_idx").on(table.status, table.updatedAt),
  }),
);

export const tenantStorageMigrationJobs = pgTable(
  "tenant_storage_migration_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    status: text("status").default("queued").notNull(),
    dryRun: boolean("dry_run").default(false).notNull(),
    requestedByActorId: uuid("requested_by_actor_id").references(() => actors.id),
    sourceStorage: jsonb("source_storage"),
    targetStorage: jsonb("target_storage"),
    plannedCount: integer("planned_count").default(0).notNull(),
    copiedCount: integer("copied_count").default(0).notNull(),
    verifiedCount: integer("verified_count").default(0).notNull(),
    failures: jsonb("failures").default([]).notNull(),
    lastError: text("last_error"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("tenant_storage_migration_jobs_org_idx").on(table.orgId, table.createdAt),
    claimIdx: index("tenant_storage_migration_jobs_claim_idx")
      .on(table.status, table.updatedAt)
      .where(sql`${table.status} in ('queued', 'failed')`),
  }),
);

export const signupEmailVerifications = pgTable(
  "signup_email_verifications",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    tokenHashIdx: index("signup_email_verifications_token_hash_idx").on(table.tokenHash),
    expiresAtIdx: index("signup_email_verifications_expires_at_idx").on(table.expiresAt),
  }),
);

export const signupOnboardingInvites = pgTable(
  "signup_onboarding_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    invitedByActorId: uuid("invited_by_actor_id")
      .notNull()
      .references(() => actors.id),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByActorId: uuid("accepted_by_actor_id").references(() => actors.id),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgEmailIdx: index("signup_onboarding_invites_org_email_idx").on(table.orgId, table.email),
    tokenHashIdx: index("signup_onboarding_invites_token_hash_idx").on(table.tokenHash),
    expiresAtIdx: index("signup_onboarding_invites_expires_at_idx").on(table.expiresAt),
  }),
);

export const meteringEvents = pgTable(
  "metering_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    quantity: numeric("quantity").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    rolledUpAt: timestamp("rolled_up_at", { withTimezone: true }),
  },
  (table) => ({
    orgTimeIdx: index("metering_events_org_time_idx").on(table.orgId, table.occurredAt),
    unrolledIdx: index("metering_events_unrolled_idx")
      .on(table.occurredAt)
      .where(sql`${table.rolledUpAt} is null`),
  }),
);

export const meteringRollups = pgTable(
  "metering_rollups",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    metricKey: text("metric_key").notNull(),
    quantity: numeric("quantity").notNull(),
    details: jsonb("details").default({}).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.periodStart, table.metricKey] }),
    orgMetricIdx: index("metering_rollups_org_metric_idx").on(
      table.orgId,
      table.metricKey,
      table.periodStart,
    ),
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
    uploadState: driveUploadState("upload_state").default("active").notNull(),
    uploadDeclaredByteSize: numeric("upload_declared_byte_size"),
    uploadDeclaredSha256: text("upload_declared_sha256"),
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

export const driveScanJobs = pgTable(
  "drive_scan_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => driveVersions.id, { onDelete: "cascade" }),
    requestedByActorId: uuid("requested_by_actor_id").references(() => actors.id),
    status: driveScanJobStatus("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    scanEvidence: jsonb("scan_evidence").default({}).notNull(),
    lastErrorCode: text("last_error_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    versionIdx: uniqueIndex("drive_scan_jobs_version_unique").on(table.versionId),
    orgObjectIdx: index("drive_scan_jobs_org_object_idx").on(
      table.orgId,
      table.objectId,
      table.createdAt,
    ),
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

export const vectorCollections = pgTable(
  "vector_collections",
  {
    // org_id is nullable so the explicit system scope (cross-tenant
    // maintenance code paths) can address a row without owning a tenant.
    // Per-tenant callers always supply a non-null org_id; see VectorStore in
    // platform/ai/vector/types.ts.
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    dim: integer("dim").notNull(),
    metric: vectorMetric("metric").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.name] }),
  }),
);

export const vectorItems = pgTable(
  "vector_items",
  {
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    collectionName: text("collection_name").notNull(),
    id: text("id").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.collectionName, table.id] }),
    orgCollectionIdx: index("vector_items_org_collection_idx").on(
      table.orgId,
      table.collectionName,
    ),
    metadataIdx: index("vector_items_metadata_idx").using("gin", table.metadata),
  }),
);

export const pendingActions = pgTable("pending_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull(),
  actorId: uuid("actor_id")
    .references(() => actors.id)
    .notNull(),
  requesterCredentialId: uuid("requester_credential_id"),
  requesterPrincipal: jsonb("requester_principal").default({}).notNull(),
  requesterIp: text("requester_ip"),
  approvalOwnerActorId: uuid("approval_owner_actor_id").references(() => actors.id),
  approverActorId: uuid("approver_actor_id").references(() => actors.id),
  executionActorId: uuid("execution_actor_id").references(() => actors.id),
  toolId: text("tool_id").notNull(),
  input: jsonb("input").notNull(),
  inputHash: text("input_hash").notNull(),
  policySnapshot: jsonb("policy_snapshot").default({}).notNull(),
  policyVersion: text("policy_version").notNull(),
  preview: jsonb("preview").default({}).notNull(),
  status: pendingActionStatus("status").default("pending_confirmation").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  executionStartedAt: timestamp("execution_started_at", { withTimezone: true }),
  executionCompletedAt: timestamp("execution_completed_at", { withTimezone: true }),
  executionLeaseExpiresAt: timestamp("execution_lease_expires_at", { withTimezone: true }),
  executionAttempts: integer("execution_attempts").default(0).notNull(),
  executionIdempotencyKey: text("execution_idempotency_key").notNull(),
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
    // Per-client redirect-URI allowlist (CRITICAL-3). `/oauth/authorize`
    // requires an exact-string match against one of these entries.
    redirectUris: text("redirect_uris").array().default([]).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rateLimitOverrides: jsonb("rate_limit_overrides").default({}).notNull(),
    ipAllowlist: cidr("ip_allowlist").array(),
    allowedHours: jsonb("allowed_hours"),
    confirmationOverride: jsonb("confirmation_override"),
    approvalOwnerActorId: uuid("approval_owner_actor_id").references(() => actors.id),
    automationPolicy: jsonb("automation_policy"),
    policyVersion: text("policy_version").default("1").notNull(),
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
    deliveryStatus: text("delivery_status"),
    deliveryEventAt: timestamp("delivery_event_at", { withTimezone: true }),
    deliveryMetadata: jsonb("delivery_metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    actorStatusIdx: index("mail_outbound_actor_status_idx").on(table.actorId, table.status),
    outboxIdx: index("mail_outbound_outbox_idx").on(table.outboxId),
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
    orgNameIdx: uniqueIndex("mail_outbound_providers_org_name_idx").on(table.orgId, table.name),
    orgDefaultIdx: uniqueIndex("mail_outbound_providers_org_default_idx")
      .on(table.orgId)
      .where(sql`${table.isDefault}`),
  }),
);

export const mailSendingDomains = pgTable(
  "mail_sending_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    domain: text("domain").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    providerId: uuid("provider_id").references(() => mailOutboundProviders.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (table) => ({
    orgDomainIdx: uniqueIndex("mail_sending_domains_org_domain_idx").on(table.orgId, table.domain),
    orgIdx: index("mail_sending_domains_org_idx").on(table.orgId, table.createdAt),
    orgDefaultIdx: uniqueIndex("mail_sending_domains_org_default_idx")
      .on(table.orgId)
      .where(sql`${table.isDefault}`),
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

export const mailSuppressions = pgTable(
  "mail_suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    normalizedRecipient: text("normalized_recipient").notNull(),
    reason: text("reason").notNull(),
    sourceEventId: uuid("source_event_id")
      .notNull()
      .references(() => mailProviderDeliveryEvents.id, { onDelete: "restrict" }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: uuid("cleared_by").references(() => actors.id),
    clearReason: text("clear_reason"),
    ...timestamps,
  },
  (table) => ({
    activeRecipientIdx: uniqueIndex("mail_suppressions_org_recipient_active_idx")
      .on(table.orgId, table.normalizedRecipient)
      .where(sql`${table.clearedAt} is null`),
    orgCreatedIdx: index("mail_suppressions_org_created_idx").on(table.orgId, table.createdAt),
  }),
);

export const mailReceivingDomains = pgTable(
  "mail_receiving_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: mailReceivingDomainStatus("status").default("pending").notNull(),
    verificationTokenHash: text("verification_token_hash").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    catchAllActorId: uuid("catch_all_actor_id").references(() => actors.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => ({
    orgDomainIdx: uniqueIndex("mail_receiving_domains_org_domain_idx").on(
      table.orgId,
      table.domain,
    ),
    activeDomainIdx: uniqueIndex("mail_receiving_domains_active_domain_idx")
      .on(table.domain)
      .where(sql`${table.status} = 'active'`),
    tokenHashIdx: uniqueIndex("mail_receiving_domains_token_hash_idx").on(
      table.verificationTokenHash,
    ),
    orgStatusIdx: index("mail_receiving_domains_org_status_idx").on(
      table.orgId,
      table.status,
      table.createdAt,
    ),
  }),
);

export const mailDkimKeys = pgTable(
  "mail_dkim_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    domainId: uuid("domain_id")
      .references(() => mailSendingDomains.id, { onDelete: "cascade" })
      .notNull(),
    selector: text("selector").notNull(),
    status: mailDkimKeyStatus("status").default("active").notNull(),
    algorithm: text("algorithm").default("rsa-sha256").notNull(),
    keyBits: integer("key_bits").default(2048).notNull(),
    privateKeyPem: text("private_key_pem").notNull(),
    publicKeyPem: text("public_key_pem").notNull(),
    dnsRecord: text("dns_record").notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (table) => ({
    domainSelectorIdx: uniqueIndex("mail_dkim_keys_domain_selector_idx").on(
      table.domainId,
      table.selector,
    ),
    orgIdx: index("mail_dkim_keys_org_idx").on(table.orgId, table.domainId, table.status),
    domainActiveIdx: uniqueIndex("mail_dkim_keys_domain_active_idx")
      .on(table.domainId)
      .where(sql`${table.status} = 'active'`),
  }),
);

export const mailDmarcReports = pgTable(
  "mail_dmarc_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    domain: text("domain").notNull(),
    orgName: text("org_name").default("").notNull(),
    reportId: text("report_id").notNull(),
    dateRangeBegin: timestamp("date_range_begin", { withTimezone: true }).notNull(),
    dateRangeEnd: timestamp("date_range_end", { withTimezone: true }).notNull(),
    policyP: text("policy_p").default("none").notNull(),
    policySp: text("policy_sp"),
    policyPct: integer("policy_pct"),
    totalMessages: integer("total_messages").default(0).notNull(),
    passMessages: integer("pass_messages").default(0).notNull(),
    failMessages: integer("fail_messages").default(0).notNull(),
    raw: jsonb("raw").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("mail_dmarc_reports_unique_idx").on(
      table.orgId,
      table.domain,
      table.orgName,
      table.reportId,
    ),
    orgDomainIdx: index("mail_dmarc_reports_org_domain_idx").on(
      table.orgId,
      table.domain,
      table.dateRangeEnd,
    ),
  }),
);

export const mailDmarcReportRecords = pgTable(
  "mail_dmarc_report_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportId: uuid("report_id")
      .references(() => mailDmarcReports.id, { onDelete: "cascade" })
      .notNull(),
    orgId: uuid("org_id").notNull(),
    sourceIp: text("source_ip").notNull(),
    messageCount: integer("message_count").default(0).notNull(),
    disposition: text("disposition").default("none").notNull(),
    dkimResult: text("dkim_result").default("fail").notNull(),
    spfResult: text("spf_result").default("fail").notNull(),
    headerFrom: text("header_from").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    reportIdx: index("mail_dmarc_report_records_report_idx").on(table.reportId),
    orgIdx: index("mail_dmarc_report_records_org_idx").on(table.orgId, table.sourceIp),
  }),
);

export const mailInboundRoutingRules = pgTable(
  "mail_inbound_routing_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    priority: integer("priority").default(100).notNull(),
    match: jsonb("match").default({}).notNull(),
    actionKind: mailRoutingActionKind("action_kind").notNull(),
    action: jsonb("action").default({}).notNull(),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("mail_inbound_routing_rules_org_idx").on(table.orgId, table.priority),
    orgNameIdx: uniqueIndex("mail_inbound_routing_rules_org_name_idx").on(table.orgId, table.name),
  }),
);

export const driveFolders = pgTable(
  "drive_folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    name: text("name").notNull(),
    parentFolderId: uuid("parent_folder_id").references((): AnyPgColumn => driveFolders.id, {
      onDelete: "set null",
    }),
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

export const drivePdfFormStates = pgTable(
  "drive_pdf_form_states",
  {
    orgId: uuid("org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    objectId: uuid("object_id")
      .references(() => objects.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id, { onDelete: "cascade" })
      .notNull(),
    fieldValues: jsonb("field_values").default([]).notNull(),
    sourceVersionNumber: integer("source_version_number"),
    sourceSha256: text("source_sha256"),
    sourceByteSize: integer("source_byte_size"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.objectId, table.actorId] }),
    actorUpdatedIdx: index("drive_pdf_form_states_actor_updated_idx").on(
      table.orgId,
      table.actorId,
      table.updatedAt,
    ),
    objectUpdatedIdx: index("drive_pdf_form_states_object_updated_idx").on(
      table.orgId,
      table.objectId,
      table.updatedAt,
    ),
  }),
);

export const driveShareLinks = pgTable(
  "drive_share_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    token: text("token").notNull(),
    objectId: uuid("object_id")
      .references(() => objects.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").default("reader").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tokenIdx: uniqueIndex("drive_share_links_token_idx").on(table.token),
    objectIdx: index("drive_share_links_object_idx").on(table.orgId, table.objectId),
  }),
);

/** Content-addressed blobs (optional dedup path; migration 0074). */
export const driveBlobs = pgTable(
  "drive_blobs",
  {
    orgId: uuid("org_id").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    refcount: integer("refcount").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.sha256] }),
    storageKeyIdx: index("drive_blobs_storage_key_idx").on(table.storageKey),
  }),
);

// ponytail: 0047 owns the self-ref FK + status CHECK + partial index; Drizzle can't express them.
export const driveComments = pgTable(
  "drive_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id")
      .references(() => objects.id, { onDelete: "cascade" })
      .notNull(),
    parentCommentId: uuid("parent_comment_id"),
    actorId: uuid("actor_id").references(() => actors.id, { onDelete: "set null" }),
    anchor: jsonb("anchor").default({}).notNull(),
    body: text("body").notNull(),
    status: text("status").default("open").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => ({
    objectStatusCreatedIdx: index("drive_comments_object_status_created_idx").on(
      table.orgId,
      table.objectId,
      table.status,
      table.createdAt,
    ),
    parentCreatedIdx: index("drive_comments_parent_created_idx").on(
      table.parentCommentId,
      table.createdAt,
    ),
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
    editorEngine: text("editor_engine").default("legacy-yjs").notNull(),
    formatVersion: integer("format_version").default(1).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgUpdatedIdx: index("docs_documents_org_updated_idx").on(table.orgId, table.updatedAt),
    engineIdx: index("docs_documents_engine_idx").on(
      table.orgId,
      table.editorEngine,
      table.updatedAt,
    ),
    ownerIdx: index("docs_documents_owner_idx").on(table.ownerActorId),
    threadIdx: index("docs_documents_thread_idx").on(table.threadId),
  }),
);

export const docsStyles = pgTable(
  "docs_styles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id")
      .references(() => docsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").default({}).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    documentKindNameIdx: uniqueIndex("docs_styles_document_kind_name_idx").on(
      table.documentId,
      table.kind,
      table.name,
    ),
    orgDocumentIdx: index("docs_styles_org_document_idx").on(table.orgId, table.documentId),
  }),
);

export const docsThemes = pgTable(
  "docs_themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id").references(() => docsDocuments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokens: jsonb("tokens").default({}).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    documentNameIdx: uniqueIndex("docs_themes_document_name_idx").on(table.documentId, table.name),
    orgDocumentIdx: index("docs_themes_org_document_idx").on(table.orgId, table.documentId),
  }),
);

export const docsRevisions = pgTable(
  "docs_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id")
      .references(() => docsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title"),
    editorEngine: text("editor_engine").notNull(),
    formatVersion: integer("format_version").notNull(),
    updateSeq: integer("update_seq"),
    ydocState: bytea("ydoc_state"),
    ydocStateVector: bytea("ydoc_state_vector"),
    snapshot: jsonb("snapshot").default({}).notNull(),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    documentNumberIdx: uniqueIndex("docs_revisions_document_number_idx").on(
      table.documentId,
      table.revisionNumber,
    ),
    orgCreatedIdx: index("docs_revisions_org_created_idx").on(table.orgId, table.createdAt),
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
    parentCommentId: uuid("parent_comment_id").references((): AnyPgColumn => docsComments.id, {
      onDelete: "cascade",
    }),
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
    parentCommentId: uuid("parent_comment_id").references((): AnyPgColumn => docsComments.id, {
      onDelete: "cascade",
    }),
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
    parentCreatedIdx: index("docs_comments_parent_created_idx").on(
      table.parentCommentId,
      table.createdAt,
    ),
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

export const docsAskHistory = pgTable(
  "docs_ask_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id")
      .references(() => docsDocuments.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id")
      .references(() => actors.id, { onDelete: "cascade" })
      .notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    sourceScope: text("source_scope").default("document").notNull(),
    sourceExcerpt: text("source_excerpt").default("").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    actorDocumentCreatedIdx: index("docs_ask_history_actor_document_created_idx").on(
      table.orgId,
      table.actorId,
      table.documentId,
      table.createdAt,
    ),
    documentCreatedIdx: index("docs_ask_history_document_created_idx").on(
      table.orgId,
      table.documentId,
      table.createdAt,
    ),
  }),
);

export const sheets = pgTable(
  "sheets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id").references(() => actors.id),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    title: text("title").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgUpdatedIdx: index("sheets_org_updated_idx").on(table.orgId, table.updatedAt),
    ownerIdx: index("sheets_owner_idx").on(table.ownerActorId, table.deletedAt),
  }),
);

export const sheetTabs = pgTable(
  "sheet_tabs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    sheetId: uuid("sheet_id")
      .references(() => sheets.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    position: integer("position").default(0).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    sheetPositionIdx: index("sheet_tabs_sheet_position_idx").on(table.sheetId, table.position),
    orgIdx: index("sheet_tabs_org_idx").on(table.orgId),
  }),
);

export const sheetCells = pgTable(
  "sheet_cells",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    sheetTabId: uuid("sheet_tab_id")
      .references(() => sheetTabs.id, { onDelete: "cascade" })
      .notNull(),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    value: text("value").default("").notNull(),
    formula: text("formula"),
    calcValue: text("calc_value"),
    dependencies: jsonb("dependencies").default([]).notNull(),
    formulaError: text("formula_error"),
    format: jsonb("format").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    tabCoordIdx: uniqueIndex("sheet_cells_tab_coord_idx").on(
      table.sheetTabId,
      table.row,
      table.col,
    ),
    orgIdx: index("sheet_cells_org_idx").on(table.orgId),
  }),
);

export const sheetOpLog = pgTable(
  "sheet_op_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    sheetId: uuid("sheet_id")
      .references(() => sheets.id, { onDelete: "cascade" })
      .notNull(),
    sheetTabId: uuid("sheet_tab_id")
      .references(() => sheetTabs.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    operationId: text("operation_id").notNull(),
    revision: integer("revision").notNull(),
    baseRevision: integer("base_revision").notNull(),
    operation: jsonb("operation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sheetRevisionIdx: uniqueIndex("sheet_op_log_sheet_revision_idx").on(
      table.sheetId,
      table.revision,
    ),
    sheetOperationIdx: uniqueIndex("sheet_op_log_sheet_operation_idx").on(
      table.sheetId,
      table.operationId,
    ),
    orgSheetRevisionIdx: index("sheet_op_log_org_sheet_revision_idx").on(
      table.orgId,
      table.sheetId,
      table.revision,
    ),
    orgCreatedIdx: index("sheet_op_log_org_created_idx").on(table.orgId, table.createdAt),
  }),
);

export const slideDecks = pgTable(
  "slide_decks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    title: text("title").notNull(),
    ownerActorId: uuid("owner_actor_id").references(() => actors.id),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgUpdatedIdx: index("slide_decks_org_updated_idx").on(table.orgId, table.updatedAt),
    ownerIdx: index("slide_decks_owner_idx").on(table.ownerActorId),
  }),
);

export const slides = pgTable(
  "slides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    deckId: uuid("deck_id")
      .references(() => slideDecks.id, { onDelete: "cascade" })
      .notNull(),
    position: integer("position").notNull(),
    layout: text("layout").notNull(),
    content: jsonb("content").default({}).notNull(),
    speakerNotes: text("speaker_notes").default("").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    deckPositionIdx: uniqueIndex("slides_deck_position_idx").on(table.deckId, table.position),
    orgDeckIdx: index("slides_org_deck_idx").on(table.orgId, table.deckId),
  }),
);

export const slidesOpLog = pgTable(
  "slides_op_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    deckId: uuid("deck_id")
      .references(() => slideDecks.id, { onDelete: "cascade" })
      .notNull(),
    actorId: uuid("actor_id").references(() => actors.id),
    operationId: text("operation_id").notNull(),
    revision: integer("revision").notNull(),
    baseRevision: integer("base_revision").notNull(),
    operation: jsonb("operation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    deckRevisionIdx: uniqueIndex("slides_op_log_deck_revision_idx").on(
      table.deckId,
      table.revision,
    ),
    deckOperationIdx: uniqueIndex("slides_op_log_deck_operation_idx").on(
      table.deckId,
      table.operationId,
    ),
    orgDeckRevisionIdx: index("slides_op_log_org_deck_revision_idx").on(
      table.orgId,
      table.deckId,
      table.revision,
    ),
    orgCreatedIdx: index("slides_op_log_org_created_idx").on(table.orgId, table.createdAt),
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
