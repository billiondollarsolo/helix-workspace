import {
  bigint,
  boolean,
  check,
  cidr,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
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
  "mail_source",
  "chat_attachment",
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
  "accepted",
  "delivered",
  "deferred",
  "bounced",
  "complained",
  "failed",
]);
export const mailOutboundProviderKind = pgEnum("mail_outbound_provider_kind", [
  "ses",
  "mailgun",
  "smtp",
  "postmark",
]);
export const mailDeliveryEventKind = pgEnum("mail_delivery_event_kind", [
  "accepted",
  "delivered",
  "deferred",
  "bounced",
  "complained",
]);
export const mailDeliveryEventSource = pgEnum("mail_delivery_event_source", ["provider", "dsn"]);
export const mailDeliveryRetryClass = pgEnum("mail_delivery_retry_class", [
  "none",
  "transient",
  "permanent",
]);
export const mailSuppressionReason = pgEnum("mail_suppression_reason", [
  "hard_bounce",
  "complaint",
  "manual",
]);
export const mailAttachmentIngestStatus = pgEnum("mail_attachment_ingest_status", [
  "pending_upload",
  "quarantined",
  "scanning",
  "clean",
  "attached",
  "rejected",
]);
export const mailDkimKeyStatus = pgEnum("mail_dkim_key_status", [
  "pending",
  "active",
  "retiring",
  "retired",
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
    regionCanonical: check(
      "orgs_region_canonical_check",
      sql`${table.region} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    byoStorageRegion: check(
      "orgs_byo_storage_region_check",
      sql`coalesce(${table.byoConfig}->'storage'->>'kind', '') <> 'byo' or ${table.byoConfig}->'storage'->>'region' = ${table.region}`,
    ),
    byoStorageSecretHandle: check(
      "orgs_byo_storage_secret_handle",
      sql`coalesce(${table.byoConfig}->'storage'->>'kind', '') <> 'byo' or coalesce(${table.byoConfig}->'storage'->>'credentials_secret_handle' ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$', false)`,
    ),
    byoConfigNoCredentials: check(
      "orgs_byo_config_no_credentials",
      sql`not jsonb_path_exists(${table.byoConfig}, '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")') and ${table.byoConfig}->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'`,
    ),
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
    orgIdIdIdx: uniqueIndex("actors_org_id_id_unique_idx").on(table.orgId, table.id),
    parentIdx: index("actors_parent_user_idx").on(table.parentUserId),
  }),
);

export const identitySubjects = pgTable(
  "identity_subjects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalEmail: text("canonical_email"),
    displayName: text("display_name").default("").notNull(),
    status: text("status").default("active").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    emailIdx: uniqueIndex("identity_subjects_email_idx")
      .on(sql`lower(${table.canonicalEmail})`)
      .where(sql`${table.canonicalEmail} is not null`),
    statusCheck: check(
      "identity_subjects_status_check",
      sql`${table.status} in ('active', 'suspended', 'deleted')`,
    ),
  }),
);

export const identityProviderSubjects = pgTable(
  "identity_provider_subjects",
  {
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => identitySubjects.id, { onDelete: "cascade" }),
    emailAtLink: text("email_at_link"),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.providerSubject] }),
    subjectIdx: index("identity_provider_subjects_subject_idx").on(table.subjectId),
  }),
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => identitySubjects.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").notNull(),
    status: text("status").default("active").notNull(),
    roles: text("roles").array().default([]).notNull(),
    orgUnitId: uuid("org_unit_id"),
    guestType: text("guest_type").default("member").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    subjectOrgIdx: uniqueIndex("organization_memberships_subject_org_unique").on(
      table.subjectId,
      table.orgId,
    ),
    actorIdx: uniqueIndex("organization_memberships_actor_unique").on(table.actorId),
    orgIdIdIdx: uniqueIndex("organization_memberships_org_id_id_unique_idx").on(
      table.orgId,
      table.id,
    ),
    actorOrgFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "organization_memberships_actor_org_fk",
    }).onDelete("cascade"),
    orgStatusIdx: index("organization_memberships_org_status_idx").on(
      table.orgId,
      table.status,
      table.subjectId,
    ),
    subjectIdx: index("organization_memberships_subject_idx").on(table.subjectId, table.status),
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
    valuesNoCredentials: check(
      "tenant_config_audit_values_no_credentials",
      sql`(${table.oldValue} is null or (not jsonb_path_exists(${table.oldValue}, '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")') and ${table.oldValue}->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@')) and (${table.newValue} is null or (not jsonb_path_exists(${table.newValue}, '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")') and ${table.newValue}->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))`,
    ),
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
    signingCertSecretHandle: text("signing_cert_secret_handle"),
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
    signingCertSecretHandleCheck: check(
      "tenant_idp_configs_signing_cert_secret_handle",
      sql`${table.signingCertSecretHandle} is null or ${table.signingCertSecretHandle} ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'`,
    ),
    publicConfigCheck: check(
      "tenant_idp_configs_public_config",
      sql`jsonb_typeof(${table.config}) = 'object' and case ${table.protocol}
        when 'saml' then ${table.config} - array['metadataUrl', 'entityId', 'ssoUrl', 'logoutUrl', 'nameIdFormat', 'signRequests'] = '{}'::jsonb
        when 'oidc' then ${table.config} - array['issuer', 'metadataUrl', 'clientId', 'scopes', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri'] = '{}'::jsonb
        else false end
        and (not (${table.config} ? 'metadataUrl') or (jsonb_typeof(${table.config}->'metadataUrl') = 'string' and ${table.config}->>'metadataUrl' ~ '^https://' and ${table.config}->>'metadataUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))
        and (not (${table.config} ? 'entityId') or jsonb_typeof(${table.config}->'entityId') = 'string')
        and (not (${table.config} ? 'ssoUrl') or (jsonb_typeof(${table.config}->'ssoUrl') = 'string' and ${table.config}->>'ssoUrl' ~ '^https://' and ${table.config}->>'ssoUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))
        and (not (${table.config} ? 'logoutUrl') or (jsonb_typeof(${table.config}->'logoutUrl') = 'string' and ${table.config}->>'logoutUrl' ~ '^https://' and ${table.config}->>'logoutUrl' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))
        and (not (${table.config} ? 'nameIdFormat') or jsonb_typeof(${table.config}->'nameIdFormat') = 'string')
        and (not (${table.config} ? 'signRequests') or jsonb_typeof(${table.config}->'signRequests') = 'boolean')
        and (not (${table.config} ? 'issuer') or (jsonb_typeof(${table.config}->'issuer') = 'string' and ${table.config}->>'issuer' ~ '^https://' and ${table.config}->>'issuer' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))
        and (not (${table.config} ? 'clientId') or jsonb_typeof(${table.config}->'clientId') = 'string')
        and (not (${table.config} ? 'scopes') or (jsonb_typeof(${table.config}->'scopes') = 'array' and not jsonb_path_exists(${table.config}, '$.scopes[*] ? (@.type() != "string")')))
        and (not (${table.config} ? 'authorizationEndpoint') or (jsonb_typeof(${table.config}->'authorizationEndpoint') = 'string' and ${table.config}->>'authorizationEndpoint' ~ '^https://' and ${table.config}->>'authorizationEndpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))
        and (not (${table.config} ? 'tokenEndpoint') or (jsonb_typeof(${table.config}->'tokenEndpoint') = 'string' and ${table.config}->>'tokenEndpoint' ~ '^https://' and ${table.config}->>'tokenEndpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))
        and (not (${table.config} ? 'jwksUri') or (jsonb_typeof(${table.config}->'jwksUri') = 'string' and ${table.config}->>'jwksUri' ~ '^https://' and ${table.config}->>'jwksUri' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@'))`,
    ),
    publicAttrMappingCheck: check(
      "tenant_idp_configs_public_attr_mapping",
      sql`jsonb_typeof(${table.attrMapping}) = 'object'
        and ${table.attrMapping} - array['email', 'displayName', 'givenName', 'familyName', 'groups', 'externalId'] = '{}'::jsonb
        and (not (${table.attrMapping} ? 'email') or ${table.attrMapping}->>'email' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
        and (not (${table.attrMapping} ? 'displayName') or ${table.attrMapping}->>'displayName' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
        and (not (${table.attrMapping} ? 'givenName') or ${table.attrMapping}->>'givenName' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
        and (not (${table.attrMapping} ? 'familyName') or ${table.attrMapping}->>'familyName' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
        and (not (${table.attrMapping} ? 'groups') or ${table.attrMapping}->>'groups' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')
        and (not (${table.attrMapping} ? 'externalId') or ${table.attrMapping}->>'externalId' ~ '^[$][.][A-Za-z0-9_-]+([.][A-Za-z0-9_-]+)*$')`,
    ),
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
    sourceNoCredentials: check(
      "tenant_storage_migration_jobs_source_no_credentials",
      sql`${table.sourceStorage} is null or (not jsonb_path_exists(${table.sourceStorage}, '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")') and ${table.sourceStorage}->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@')`,
    ),
    targetNoCredentials: check(
      "tenant_storage_migration_jobs_target_no_credentials",
      sql`${table.targetStorage} is null or (not jsonb_path_exists(${table.targetStorage}, '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^((aws[-_]?)?access[-_]?key([-_]?id)?|(aws[-_]?)?secret[-_]?access[-_]?key|secret[-_]?key|password|pass|token|access[-_]?token|refresh[-_]?token|id[-_]?token|(aws[-_]?)?session[-_]?token|api[-_]?key|client[-_]?secret|private[-_]?key|signing[-_]?(key|secret)|credential(s)?)$" flag "i")') and ${table.targetStorage}->'storage'->>'endpoint' !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*@')`,
    ),
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
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    classification: text("classification").default("internal").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    trashPurgeAfter: timestamp("trash_purge_after", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdIdIdx: uniqueIndex("objects_org_id_id_unique_idx").on(table.orgId, table.id),
    orgKindIdx: index("objects_org_kind_idx").on(table.orgId, table.kind),
    ownerIdx: index("objects_owner_actor_idx").on(table.ownerActorId),
    metadataNoStarred: check("objects_metadata_no_starred", sql`not ${table.metadata} ? 'starred'`),
  }),
);

export const driveMemberStars = pgTable(
  "drive_member_stars",
  {
    orgId: uuid("org_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    objectId: uuid("object_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.membershipId, table.objectId] }),
    membershipFk: foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMemberships.orgId, organizationMemberships.id],
      name: "drive_member_stars_org_id_membership_id_fkey",
    }).onDelete("cascade"),
    objectFk: foreignKey({
      columns: [table.orgId, table.objectId],
      foreignColumns: [objects.orgId, objects.id],
      name: "drive_member_stars_org_id_object_id_fkey",
    }).onDelete("cascade"),
  }),
);

export const workspaceMemberPreferences = pgTable(
  "workspace_member_preferences",
  {
    orgId: uuid("org_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    documentSurfaceView: text("document_surface_view").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.membershipId] }),
    membershipFk: foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMemberships.orgId, organizationMemberships.id],
      name: "workspace_member_preferences_org_id_membership_id_fkey",
    }).onDelete("cascade"),
    viewCheck: check(
      "workspace_member_preferences_document_surface_view_check",
      sql`${table.documentSurfaceView} in ('grid', 'list')`,
    ),
  }),
);

export const driveScanJobs = pgTable(
  "drive_scan_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => actors.id, { onDelete: "set null" }),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    finalizeMetadata: jsonb("finalize_metadata").default({}).notNull(),
    overrideCount: integer("override_count").default(0).notNull(),
    lastOverrideReason: text("last_override_reason"),
    lastOverriddenByActorId: uuid("last_overridden_by_actor_id").references(() => actors.id, {
      onDelete: "set null",
    }),
    lastOverriddenAt: timestamp("last_overridden_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    objectUnique: uniqueIndex("drive_scan_jobs_org_object_idx").on(table.orgId, table.objectId),
    claimIdx: index("drive_scan_jobs_claim_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    stateCheck: check(
      "drive_scan_jobs_state_check",
      sql`(${table.status} = 'pending' and ${table.nextAttemptAt} is not null and ${table.leaseExpiresAt} is null)
          or (${table.status} = 'processing' and ${table.leaseExpiresAt} is not null)
          or (${table.status} = 'dead_lettered' and ${table.nextAttemptAt} is null and ${table.leaseExpiresAt} is null)`,
    ),
  }),
);

export const driveQuarantineDeletions = pgTable(
  "drive_quarantine_deletions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // Intentionally not an object FK: cleanup must survive hard object deletion.
    objectId: uuid("object_id").notNull(),
    actorId: uuid("actor_id").references(() => actors.id, { onDelete: "set null" }),
    storageKey: text("storage_key").notNull(),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    storageKeyUnique: uniqueIndex("drive_quarantine_deletions_org_key_idx").on(
      table.orgId,
      table.storageKey,
    ),
    claimIdx: index("drive_quarantine_deletions_claim_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    stateCheck: check(
      "drive_quarantine_deletions_state_check",
      sql`(${table.status} = 'pending' and ${table.leaseExpiresAt} is null and ${table.completedAt} is null)
          or (${table.status} = 'processing' and ${table.leaseExpiresAt} is not null and ${table.completedAt} is null)
          or (${table.status} = 'completed' and ${table.leaseExpiresAt} is null and ${table.completedAt} is not null)`,
    ),
  }),
);

export const driveMultipartSessions = pgTable(
  "drive_multipart_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").notNull(),
    actorId: uuid("actor_id").references(() => actors.id, { onDelete: "set null" }),
    storageKey: text("storage_key").notNull(),
    uploadId: text("upload_id"),
    status: text("status").default("provisioning").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    partSize: integer("part_size").notNull(),
    partCount: integer("part_count").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completionHash: text("completion_hash"),
    versionId: uuid("version_id"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => ({
    objectUnique: uniqueIndex("drive_multipart_sessions_org_object_idx").on(
      table.orgId,
      table.objectId,
    ),
    uploadUnique: uniqueIndex("drive_multipart_sessions_org_upload_idx")
      .on(table.orgId, table.uploadId)
      .where(sql`${table.uploadId} is not null`),
    sweepIdx: index("drive_multipart_sessions_sweep_idx")
      .on(table.nextAttemptAt, table.expiresAt, table.createdAt)
      .where(
        sql`${table.status} in ('provisioning', 'pending', 'completing', 'uploaded', 'aborting')`,
      ),
    stateCheck: check(
      "drive_multipart_sessions_state_check",
      sql`(${table.status} in ('provisioning', 'pending', 'uploaded', 'completed') and ${table.leaseExpiresAt} is null)
          or (${table.status} in ('completing', 'aborting') and ${table.leaseExpiresAt} is not null)`,
    ),
  }),
);

export const drivePreviewJobs = pgTable(
  "drive_preview_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references((): AnyPgColumn => driveVersions.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => actors.id, { onDelete: "set null" }),
    status: text("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => ({
    versionUnique: uniqueIndex("drive_preview_jobs_org_version_key").on(
      table.orgId,
      table.versionId,
    ),
    claimIdx: index("drive_preview_jobs_claim_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    stateCheck: check(
      "drive_preview_jobs_state_check",
      sql`(${table.status} = 'pending' and ${table.leaseExpiresAt} is null)
          or (${table.status} = 'processing' and ${table.leaseExpiresAt} is not null)`,
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
    orgIdIdIdx: uniqueIndex("threads_org_id_id_unique_idx").on(table.orgId, table.id),
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
    clientMessageId: text("client_message_id"),
    chatRoomSequence: bigint("chat_room_sequence", { mode: "number" }),
    chatRevision: bigint("chat_revision", { mode: "number" }).default(1).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    threadSentIdx: index("messages_thread_sent_idx").on(table.threadId, table.sentAt),
    orgKindIdx: index("messages_org_kind_idx").on(table.orgId, table.kind),
    chatClientMessageIdx: uniqueIndex("messages_chat_client_message_uidx")
      .on(table.orgId, table.actorId, table.threadId, table.clientMessageId)
      .where(sql`${table.kind} = 'chat' and ${table.clientMessageId} is not null`),
    chatRoomSequenceIdx: uniqueIndex("messages_chat_room_sequence_uidx")
      .on(table.threadId, table.chatRoomSequence)
      .where(sql`${table.kind} = 'chat'`),
  }),
);

export const chatMessageRevisions = pgTable(
  "chat_message_revisions",
  {
    orgId: uuid("org_id").notNull(),
    messageId: uuid("message_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    body: text("body").notNull(),
    bodyFormat: text("body_format").notNull(),
    metadata: jsonb("metadata").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    changedByActorId: uuid("changed_by_actor_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.revision] }),
    messageFk: foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [messages.orgId, messages.id],
      name: "chat_message_revisions_message_org_fk",
    }).onDelete("cascade"),
    actorFk: foreignKey({
      columns: [table.orgId, table.changedByActorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "chat_message_revisions_actor_org_fk",
    }),
    orgTimeIdx: index("chat_message_revisions_org_time_idx").on(
      table.orgId,
      table.capturedAt,
      table.messageId,
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

export const chatAttachments = pgTable(
  "chat_attachments",
  {
    objectId: uuid("object_id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    roomId: uuid("room_id").notNull(),
    ownerActorId: uuid("owner_actor_id").notNull(),
    messageId: uuid("message_id"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgObjectUnique: uniqueIndex("chat_attachments_org_id_object_id_key").on(
      table.orgId,
      table.objectId,
    ),
    objectFk: foreignKey({
      columns: [table.orgId, table.objectId],
      foreignColumns: [objects.orgId, objects.id],
      name: "chat_attachments_org_id_object_id_fkey",
    }).onDelete("cascade"),
    roomFk: foreignKey({
      columns: [table.orgId, table.roomId],
      foreignColumns: [threads.orgId, threads.id],
      name: "chat_attachments_org_id_room_id_fkey",
    }).onDelete("cascade"),
    ownerFk: foreignKey({
      columns: [table.orgId, table.ownerActorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "chat_attachments_org_id_owner_actor_id_fkey",
    }).onDelete("restrict"),
    messageFk: foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [messages.orgId, messages.id],
      name: "chat_attachments_org_id_message_id_fkey",
    }).onDelete("cascade"),
    roomMessageIdx: index("chat_attachments_room_message_idx").on(
      table.orgId,
      table.roomId,
      table.messageId,
      table.createdAt,
    ),
    expiryIdx: index("chat_attachments_expiry_idx")
      .on(table.expiresAt, table.objectId)
      .where(sql`${table.messageId} is null and ${table.status} in ('staging', 'ready')`),
    filenameCheck: check(
      "chat_attachments_filename_check",
      sql`char_length(${table.filename}) between 1 and 255`,
    ),
    mimeCheck: check(
      "chat_attachments_mime_type_check",
      sql`${table.mimeType} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp')`,
    ),
    sizeCheck: check(
      "chat_attachments_byte_size_check",
      sql`${table.byteSize} between 1 and 10485760`,
    ),
    shaCheck: check("chat_attachments_sha256_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
    statusCheck: check(
      "chat_attachments_status_check",
      sql`${table.status} in ('staging', 'ready', 'rejected', 'purged')`,
    ),
    stateCheck: check(
      "chat_attachments_state_check",
      sql`(${table.status} = 'staging' and ${table.messageId} is null and ${table.failureReason} is null)
        or (${table.status} = 'ready' and ${table.failureReason} is null)
        or (${table.status} in ('rejected', 'purged') and ${table.messageId} is null
          and char_length(btrim(${table.failureReason})) > 0)`,
    ),
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

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    role: text("role").notNull(),
    grantedByActorId: uuid("granted_by_actor_id"),
    status: text("status").default("active").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationEpoch: bigint("revocation_epoch", { mode: "number" }).default(0).notNull(),
    ...timestamps,
  },
  (table) => ({
    resourceIdx: index("permissions_resource_idx").on(table.resourceType, table.resourceId),
    actorIdx: index("permissions_actor_idx").on(table.actorId),
    chatValidityIdx: index("permissions_chat_validity_idx")
      .on(table.orgId, table.actorId, table.resourceId)
      .where(sql`${table.resourceType} = 'thread' and ${table.status} = 'active'`),
    subjectOrgFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "permissions_subject_org_fk",
    }).onDelete("cascade"),
    grantorOrgFk: foreignKey({
      columns: [table.orgId, table.grantedByActorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "permissions_grantor_org_fk",
    }),
    statusCheck: check("permissions_status_check", sql`${table.status} in ('active', 'revoked')`),
    validWindowCheck: check(
      "permissions_valid_window_check",
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.validFrom}`,
    ),
    revocationStateCheck: check(
      "permissions_revocation_state_check",
      sql`(${table.status} = 'active' and ${table.revokedAt} is null and ${table.revocationEpoch} = 0) or (${table.status} = 'revoked' and ${table.revokedAt} is not null and ${table.revocationEpoch} > 0)`,
    ),
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
  toolId: text("tool_id").notNull(),
  input: jsonb("input").notNull(),
  status: pendingActionStatus("status").default("pending_confirmation").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  traceId: text("trace_id"),
  result: jsonb("result"),
  error: text("error"),
  approvalKind: text("approval_kind").default("self_confirmation").notNull(),
  approvedByActorId: uuid("approved_by_actor_id").references(() => actors.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
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

export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: text("id").primaryKey(),
    version: text("version").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    manifest: jsonb("manifest").notNull(),
    state: text("state").default("installed").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    stateCheck: check(
      "installed_plugins_state_check",
      sql`${table.state} in ('installed', 'enabled', 'disabled', 'degraded', 'uninstalled')`,
    ),
    enabledStateCheck: check(
      "installed_plugins_enabled_state_check",
      sql`${table.enabled} = (${table.state} = 'enabled')`,
    ),
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
    createdBy: uuid("created_by").references(() => actors.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revocationEpoch: bigint("revocation_epoch", { mode: "number" }).default(0).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
  },
  (table) => ({
    clientIdx: uniqueIndex("agent_credentials_oauth_client_id_uidx")
      .on(table.clientId)
      .where(sql`${table.credentialType} = 'oauth_client'`),
    actorIdx: index("agent_credentials_actor_idx").on(table.actorId),
    revocationEpochCheck: check(
      "agent_credentials_revocation_epoch_check",
      sql`${table.revocationEpoch} >= 0`,
    ),
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
    clientEpoch: bigint("client_epoch", { mode: "number" }).default(0).notNull(),
    refreshFamilyId: uuid("refresh_family_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    clientIdx: index("oauth_access_tokens_client_idx").on(table.clientId),
    actorIdx: index("oauth_access_tokens_actor_idx").on(table.actorId),
    expiresAtIdx: index("oauth_access_tokens_expires_at_idx").on(table.expiresAt),
    familyIdx: index("oauth_access_tokens_family_idx")
      .on(table.clientId, table.refreshFamilyId)
      .where(sql`${table.refreshFamilyId} is not null`),
    clientEpochCheck: check(
      "oauth_access_tokens_client_epoch_check",
      sql`${table.clientEpoch} >= 0`,
    ),
  }),
);

export const oauthConsentNonces = pgTable(
  "oauth_consent_nonces",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    orgId: uuid("org_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    actorFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "oauth_consent_nonces_actor_fk",
    }).onDelete("cascade"),
    expiryIdx: index("oauth_consent_nonces_expiry_idx").on(table.expiresAt),
    expiryCheck: check(
      "oauth_consent_nonces_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  }),
);

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    orgId: uuid("org_id").notNull(),
    scopes: text("scopes").array().default([]).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    actorFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "oauth_grants_actor_fk",
    }).onDelete("cascade"),
    clientIdx: index("oauth_grants_client_idx")
      .on(table.orgId, table.clientId)
      .where(sql`${table.revokedAt} is null`),
    orgActorClientIdx: uniqueIndex("oauth_grants_org_id_actor_id_client_id_key").on(
      table.orgId,
      table.actorId,
      table.clientId,
    ),
  }),
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    familyId: uuid("family_id").notNull(),
    clientId: text("client_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    orgId: uuid("org_id").notNull(),
    scopes: text("scopes").array().default([]).notNull(),
    clientEpoch: bigint("client_epoch", { mode: "number" }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedByHash: text("replaced_by_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    actorFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "oauth_refresh_tokens_actor_fk",
    }).onDelete("cascade"),
    familyIdx: index("oauth_refresh_tokens_family_idx").on(table.clientId, table.familyId),
    expiryIdx: index("oauth_refresh_tokens_expiry_idx").on(table.expiresAt),
    clientEpochCheck: check(
      "oauth_refresh_tokens_client_epoch_check",
      sql`${table.clientEpoch} >= 0`,
    ),
    expiryCheck: check(
      "oauth_refresh_tokens_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
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
    secretCiphertext: text("secret_ciphertext").notNull(),
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
    secretCiphertextCheck: check(
      "outbound_webhooks_secret_ciphertext_check",
      sql`${table.secretCiphertext} ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'`,
    ),
    headersNoCredentialsCheck: check(
      "outbound_webhooks_headers_no_credentials",
      sql`${table.headers}::text !~* '"[^"]*(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'`,
    ),
    metadataNoCredentialsCheck: check(
      "outbound_webhooks_metadata_no_credentials",
      sql`${table.metadata}::text !~* '"[^"]*(authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'`,
    ),
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
    secretCiphertext: text("secret_ciphertext").notNull(),
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
    secretCiphertextCheck: check(
      "inbound_webhooks_secret_ciphertext_check",
      sql`${table.secretCiphertext} ~ '^helix[$]1([$][A-Za-z0-9_-]+){6}$'`,
    ),
    metadataNoCredentialsCheck: check(
      "inbound_webhooks_metadata_no_credentials",
      sql`${table.metadata}::text !~* '"[^"]*(authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'`,
    ),
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
    requestHeadersNoCredentialsCheck: check(
      "webhook_deliveries_request_headers_no_credentials",
      sql`${table.requestHeaders}::text !~* '"[^"]*(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'`,
    ),
    responseHeadersNoCredentialsCheck: check(
      "webhook_deliveries_response_headers_no_credentials",
      sql`${table.responseHeaders}::text !~* '"[^"]*(authorization|authentication|x[-_]?auth|secret|password|token|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?(key|secret))[^"]*"[[:space:]]*:'`,
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
    providerMessageId: text("provider_message_id"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    handoffKey: uuid("handoff_key").defaultRandom().notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
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

export const adminDomains = pgTable(
  "admin_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    domain: text("domain").notNull(),
    status: text("status").default("pending").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    identityEnabled: boolean("identity_enabled").default(false).notNull(),
    mailEnabled: boolean("mail_enabled").default(false).notNull(),
    aliasesEnabled: boolean("aliases_enabled").default(false).notNull(),
    customHostEnabled: boolean("custom_host_enabled").default(false).notNull(),
    federationEnabled: boolean("federation_enabled").default(false).notNull(),
    providerId: uuid("provider_id"),
    identityMode: text("identity_mode").default("secondary").notNull(),
    aliasTargetDomainId: uuid("alias_target_domain_id"),
    verificationHost: text("verification_host").notNull(),
    verificationValue: text("verification_value").notNull(),
    verificationExpiresAt: timestamp("verification_expires_at", { withTimezone: true }).notNull(),
    verificationAttempts: integer("verification_attempts").default(0).notNull(),
    verificationLastAttemptAt: timestamp("verification_last_attempt_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    claimableAfter: timestamp("claimable_after", { withTimezone: true }),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (table) => ({
    activeDomainIdx: uniqueIndex("admin_domains_active_domain_idx")
      .on(table.domain)
      .where(sql`${table.status} <> 'released'`),
    orgIdx: index("admin_domains_org_idx").on(table.orgId, table.createdAt),
    orgPrimaryIdx: uniqueIndex("admin_domains_org_primary_idx")
      .on(table.orgId)
      .where(sql`${table.isPrimary}`),
    orgIdIdx: uniqueIndex("admin_domains_org_id_idx").on(table.orgId, table.id),
    providerOrgFk: foreignKey({
      columns: [table.orgId, table.providerId],
      foreignColumns: [mailOutboundProviders.orgId, mailOutboundProviders.id],
      name: "admin_domains_provider_org_fk",
    }),
    aliasTargetOrgFk: foreignKey({
      columns: [table.orgId, table.aliasTargetDomainId],
      foreignColumns: [table.orgId, table.id],
      name: "admin_domains_alias_target_org_fk",
    }).onDelete("restrict"),
    statusCheck: check(
      "admin_domains_status_check",
      sql`${table.status} in ('pending', 'verified', 'quarantined', 'released')`,
    ),
    normalizedCheck: check(
      "admin_domains_normalized_check",
      sql`${table.domain} = lower(btrim(${table.domain}))`,
    ),
    verificationStateCheck: check(
      "admin_domains_verification_state_check",
      sql`(${table.status} = 'verified' and ${table.verifiedAt} is not null and ${table.quarantinedAt} is null and ${table.releasedAt} is null and ${table.claimableAfter} is null)
        or (${table.status} = 'pending' and ${table.verifiedAt} is null and ${table.quarantinedAt} is null and ${table.releasedAt} is null and ${table.claimableAfter} is null)
        or (${table.status} = 'quarantined' and ${table.quarantinedAt} is not null and ${table.releasedAt} is null and ${table.claimableAfter} is null)
        or (${table.status} = 'released' and ${table.verifiedAt} is null and ${table.quarantinedAt} is null and ${table.releasedAt} is not null and ${table.claimableAfter} is not null)`,
    ),
    capabilityStateCheck: check(
      "admin_domains_capability_state_check",
      sql`(${table.status} = 'verified' and (not ${table.customHostEnabled} or ${table.identityEnabled}) and (not ${table.federationEnabled} or ${table.identityEnabled}) and (not ${table.aliasesEnabled} or ${table.identityEnabled} or ${table.mailEnabled}) and (${table.providerId} is null or ${table.mailEnabled}))
        or (${table.status} <> 'verified' and not (${table.identityEnabled} or ${table.mailEnabled} or ${table.aliasesEnabled} or ${table.customHostEnabled} or ${table.federationEnabled}) and ${table.providerId} is null)`,
    ),
    identityModeCheck: check(
      "admin_domains_identity_mode_check",
      sql`${table.identityMode} in ('secondary', 'alias')`,
    ),
    aliasShapeCheck: check(
      "admin_domains_alias_shape_check",
      sql`(${table.identityMode} = 'secondary' and ${table.aliasTargetDomainId} is null)
        or (${table.identityMode} = 'alias' and ${table.aliasTargetDomainId} is not null and (${table.status} <> 'verified' or (${table.identityEnabled} and ${table.aliasesEnabled})))`,
    ),
    primaryEligibleCheck: check(
      "admin_domains_primary_eligible_check",
      sql`not ${table.isPrimary} or (${table.status} = 'verified' and ${table.identityEnabled} and ${table.identityMode} = 'secondary')`,
    ),
  }),
);

export const adminDomainPrimaryTransitions = pgTable(
  "admin_domain_primary_transitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    fromDomainId: uuid("from_domain_id"),
    toDomainId: uuid("to_domain_id"),
    changedBy: uuid("changed_by"),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    rollbackUntil: timestamp("rollback_until", { withTimezone: true }).notNull(),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    rolledBackBy: uuid("rolled_back_by"),
  },
  (table) => ({
    orgTimeIdx: index("admin_domain_primary_transitions_org_time_idx").on(
      table.orgId,
      table.changedAt,
      table.id,
    ),
    fromDomainOrgFk: foreignKey({
      columns: [table.orgId, table.fromDomainId],
      foreignColumns: [adminDomains.orgId, adminDomains.id],
      name: "admin_domain_primary_transitions_from_org_fk",
    }).onDelete("restrict"),
    toDomainOrgFk: foreignKey({
      columns: [table.orgId, table.toDomainId],
      foreignColumns: [adminDomains.orgId, adminDomains.id],
      name: "admin_domain_primary_transitions_to_org_fk",
    }).onDelete("restrict"),
    changedByOrgFk: foreignKey({
      columns: [table.orgId, table.changedBy],
      foreignColumns: [actors.orgId, actors.id],
      name: "admin_domain_primary_transitions_changed_by_org_fk",
    }),
    rolledBackByOrgFk: foreignKey({
      columns: [table.orgId, table.rolledBackBy],
      foreignColumns: [actors.orgId, actors.id],
      name: "admin_domain_primary_transitions_rolled_back_by_org_fk",
    }),
    directionCheck: check(
      "admin_domain_primary_transition_direction",
      sql`${table.fromDomainId} is distinct from ${table.toDomainId}`,
    ),
    rollbackCheck: check(
      "admin_domain_primary_transition_rollback",
      sql`(${table.rolledBackAt} is null) = (${table.rolledBackBy} is null)`,
    ),
  }),
);

export const mailDkimKeys = pgTable(
  "mail_dkim_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    domainId: uuid("domain_id").notNull(),
    selector: text("selector").notNull(),
    status: mailDkimKeyStatus("status").default("pending").notNull(),
    algorithm: text("algorithm").default("rsa-sha256").notNull(),
    keyBits: integer("key_bits").default(2048).notNull(),
    privateKeyCiphertext: text("private_key_ciphertext").notNull(),
    kmsKeyId: text("kms_key_id").notNull(),
    publicKeyPem: text("public_key_pem").notNull(),
    dnsRecord: text("dns_record").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (table) => ({
    domainOrgFk: foreignKey({
      columns: [table.orgId, table.domainId],
      foreignColumns: [adminDomains.orgId, adminDomains.id],
      name: "mail_dkim_keys_domain_org_fk",
    }).onDelete("cascade"),
    domainSelectorIdx: uniqueIndex("mail_dkim_keys_domain_selector_idx").on(
      table.domainId,
      table.selector,
    ),
    orgIdx: index("mail_dkim_keys_org_idx").on(table.orgId, table.domainId, table.status),
    domainActiveIdx: uniqueIndex("mail_dkim_keys_domain_active_idx")
      .on(table.domainId)
      .where(sql`${table.status} = 'active'`),
    privateKeyCiphertextCheck: check(
      "mail_dkim_keys_private_key_ciphertext_check",
      sql`length(${table.privateKeyCiphertext}) >= 32 and ${table.privateKeyCiphertext} ~ '^[A-Za-z0-9+/]+={0,2}$'`,
    ),
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

export const mailJournalSettings = pgTable("mail_journal_settings", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => orgs.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(false).notNull(),
  retentionDays: integer("retention_days").default(2555).notNull(),
  updatedByActorId: uuid("updated_by_actor_id")
    .references(() => actors.id)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const mailJournalEntries = pgTable(
  "mail_journal_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .references(() => orgs.id, { onDelete: "cascade" })
      .notNull(),
    messageId: uuid("message_id").notNull(),
    direction: text("direction").notNull(),
    custodians: uuid("custodians").array().notNull(),
    snapshot: jsonb("snapshot").notNull(),
    contentSha256: text("content_sha256").notNull(),
    previousSha256: text("previous_sha256"),
    retentionUntil: timestamp("retention_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgMessageIdx: uniqueIndex("mail_journal_entries_org_id_message_id_key").on(
      table.orgId,
      table.messageId,
    ),
    orgHashIdx: uniqueIndex("mail_journal_entries_org_id_content_sha256_key").on(
      table.orgId,
      table.contentSha256,
    ),
    expiryIdx: index("mail_journal_expiry_idx").on(table.retentionUntil, table.orgId, table.id),
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
    trashPurgeAfter: timestamp("trash_purge_after", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgParentIdx: index("drive_folders_org_parent_idx").on(table.orgId, table.parentFolderId),
    ownerIdx: index("drive_folders_owner_idx").on(table.ownerActorId),
  }),
);

export const driveRetentionHolds = pgTable(
  "drive_retention_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    reason: text("reason").notNull(),
    createdByActorId: uuid("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedByActorId: uuid("released_by_actor_id"),
  },
  (table) => ({
    activeIdx: uniqueIndex("drive_retention_holds_active_idx")
      .on(table.orgId, table.resourceType, table.resourceId)
      .where(sql`${table.releasedAt} is null`),
    expiryIdx: index("drive_retention_holds_expiry_idx")
      .on(table.orgId, table.expiresAt)
      .where(sql`${table.releasedAt} is null`),
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
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    idempotencyKey: text("idempotency_key"),
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
    idempotencyIdx: uniqueIndex("drive_versions_idempotency_idx")
      .on(table.orgId, table.objectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    orgStorageIdx: index("drive_versions_org_storage_idx").on(table.orgId, table.storageKey),
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
    tokenHash: text("token_hash").notNull(),
    objectId: uuid("object_id")
      .references(() => objects.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").default("reader").notNull(),
    passwordHash: text("password_hash"),
    oneTime: boolean("one_time").default(false).notNull(),
    allowedDomains: text("allowed_domains")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    allowDownload: boolean("allow_download").default(true).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    accessCount: bigint("access_count", { mode: "number" }).default(0).notNull(),
    lastAccessAt: timestamp("last_access_at", { withTimezone: true }),
    classification: text("classification").default("standard").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("drive_share_links_token_hash_idx").on(table.tokenHash),
    objectIdx: index("drive_share_links_object_idx").on(table.orgId, table.objectId),
  }),
);

export const driveShareLinkEvents = pgTable(
  "drive_share_link_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    linkId: uuid("link_id").notNull(),
    eventType: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    actorId: uuid("actor_id"),
    clientKey: text("client_key"),
    details: jsonb("details")
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    linkIdx: index("drive_share_link_events_link_idx").on(
      table.orgId,
      table.linkId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const driveShareLinkRateLimits = pgTable(
  "drive_share_link_rate_limits",
  {
    scopeHash: text("scope_hash").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    updatedIdx: index("drive_share_link_rate_limits_updated_idx").on(table.updatedAt),
  }),
);

/** Content-addressed blobs (optional dedup path; migration 0074). */
export const driveBlobs = pgTable(
  "drive_blobs",
  {
    orgId: uuid("org_id").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    refcount: integer("refcount").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.sha256] }),
    storageKeyIdx: uniqueIndex("drive_blobs_org_storage_key_idx").on(table.orgId, table.storageKey),
  }),
);

export const driveBlobReservations = pgTable(
  "drive_blob_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    storageIdx: index("drive_blob_reservations_org_storage_idx").on(
      table.orgId,
      table.storageKey,
      table.expiresAt,
    ),
    objectIdx: uniqueIndex("drive_blob_reservations_object_idx").on(table.orgId, table.objectId),
  }),
);

export const driveComments = pgTable(
  "drive_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id").notNull(),
    parentCommentId: uuid("parent_comment_id"),
    actorId: uuid("actor_id"),
    anchor: jsonb("anchor").default({}).notNull(),
    body: text("body").notNull(),
    status: text("status").default("open").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "number" }).default(1).notNull(),
    changedByActorId: uuid("changed_by_actor_id"),
    resolvedByActorId: uuid("resolved_by_actor_id"),
    deletedByActorId: uuid("deleted_by_actor_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => ({
    orgObjectIdIdx: uniqueIndex("drive_comments_org_object_id_unique_idx").on(
      table.orgId,
      table.objectId,
      table.id,
    ),
    objectFk: foreignKey({
      columns: [table.orgId, table.objectId],
      foreignColumns: [objects.orgId, objects.id],
      name: "drive_comments_object_org_fk",
    }).onDelete("cascade"),
    parentFk: foreignKey({
      columns: [table.orgId, table.objectId, table.parentCommentId],
      foreignColumns: [table.orgId, table.objectId, table.id],
      name: "drive_comments_parent_same_object_fk",
    }).onDelete("cascade"),
    statusCheck: check("drive_comments_status_check", sql`${table.status} in ('open', 'resolved')`),
    revisionCheck: check("drive_comments_revision_positive", sql`${table.revision} > 0`),
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

export const driveCommentRevisions = pgTable(
  "drive_comment_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    objectId: uuid("object_id").notNull(),
    commentId: uuid("comment_id").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    changeKind: text("change_kind").notNull(),
    parentCommentId: uuid("parent_comment_id"),
    commentActorId: uuid("comment_actor_id"),
    anchor: jsonb("anchor").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    metadata: jsonb("metadata").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByActorId: uuid("resolved_by_actor_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByActorId: uuid("deleted_by_actor_id"),
    changedByActorId: uuid("changed_by_actor_id").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    commentRevisionIdx: uniqueIndex("drive_comment_revisions_comment_revision_unique").on(
      table.orgId,
      table.commentId,
      table.revision,
    ),
    objectCursorIdx: index("drive_comment_revisions_object_cursor_idx").on(
      table.orgId,
      table.objectId,
      table.capturedAt,
      table.id,
    ),
    commentFk: foreignKey({
      columns: [table.orgId, table.objectId, table.commentId],
      foreignColumns: [driveComments.orgId, driveComments.objectId, driveComments.id],
      name: "drive_comment_revisions_comment_fk",
    }).onDelete("cascade"),
    revisionCheck: check("drive_comment_revisions_revision_positive", sql`${table.revision} > 0`),
    changeKindCheck: check(
      "drive_comment_revisions_change_kind_check",
      sql`${table.changeKind} in ('created', 'edited', 'resolved', 'reopened', 'deleted')`,
    ),
    statusCheck: check(
      "drive_comment_revisions_status_check",
      sql`${table.status} in ('open', 'resolved')`,
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
    syncVersion: bigint("sync_version", { mode: "number" }).default(0).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    ownerIdx: index("cal_calendars_owner_idx").on(table.ownerActorId, table.deletedAt),
    orgIdx: index("cal_calendars_org_idx").on(table.orgId),
    syncVersionCheck: check(
      "cal_calendars_sync_version_nonnegative",
      sql`${table.syncVersion} >= 0`,
    ),
  }),
);

export const calEventChanges = pgTable(
  "cal_event_changes",
  {
    orgId: uuid("org_id").notNull(),
    calendarId: uuid("calendar_id").notNull(),
    syncVersion: bigint("sync_version", { mode: "number" }).notNull(),
    eventId: uuid("event_id").notNull(),
    deleted: boolean("deleted").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.calendarId, table.syncVersion] }),
    calendarFk: foreignKey({
      columns: [table.orgId, table.calendarId],
      foreignColumns: [calCalendars.orgId, calCalendars.id],
    }).onDelete("cascade"),
    orgCalendarVersionIdx: index("cal_event_changes_org_calendar_version_idx").on(
      table.orgId,
      table.calendarId,
      table.syncVersion,
    ),
    syncVersionCheck: check("cal_event_changes_sync_version_check", sql`${table.syncVersion} > 0`),
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
    timeSemantics: text("time_semantics").default("zoned").notNull(),
    startsLocal: text("starts_local").notNull(),
    endsLocal: text("ends_local").notNull(),
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

export const calEventRevisions = pgTable(
  "cal_event_revisions",
  {
    orgId: uuid("org_id").notNull(),
    eventId: uuid("event_id").notNull(),
    revision: integer("revision").notNull(),
    calendarId: uuid("calendar_id").notNull(),
    changeKind: text("change_kind").notNull(),
    changedByActorId: uuid("changed_by_actor_id"),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.eventId, table.revision] }),
    orgCalendarCreatedIdx: index("cal_event_revisions_org_calendar_created_idx").on(
      table.orgId,
      table.calendarId,
      table.createdAt,
      table.eventId,
      table.revision,
    ),
  }),
);

export const calSchedulingProfiles = pgTable(
  "cal_scheduling_profiles",
  {
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    timezone: text("timezone").default("UTC").notNull(),
    workDays: integer("work_days").array().default([1, 2, 3, 4, 5]).notNull(),
    workStart: time("work_start").default("09:00").notNull(),
    workEnd: time("work_end").default("17:00").notNull(),
    workLocation: text("work_location"),
    externalAvailability: text("external_availability").default("none").notNull(),
    holidayCalendarId: uuid("holiday_calendar_id").references(() => calCalendars.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.actorId] }),
  }),
);

export const calResources = pgTable(
  "cal_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calCalendars.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    capacity: integer("capacity"),
    approvalPolicy: text("approval_policy").default("auto").notNull(),
    approverActorId: uuid("approver_actor_id").references(() => actors.id, {
      onDelete: "restrict",
    }),
    active: boolean("active").default(true).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdIdIdx: uniqueIndex("cal_resources_org_id_id_idx").on(table.orgId, table.id),
    orgCalendarIdx: uniqueIndex("cal_resources_org_calendar_idx").on(table.orgId, table.calendarId),
    orgKindIdx: index("cal_resources_org_kind_idx").on(
      table.orgId,
      table.kind,
      table.active,
      table.name,
    ),
  }),
);

export const calResourceBookings = pgTable(
  "cal_resource_bookings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => calEvents.id, { onDelete: "cascade" }),
    recurrenceId: timestamp("recurrence_id", { withTimezone: true }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    requestedByActorId: uuid("requested_by_actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    decidedByActorId: uuid("decided_by_actor_id").references(() => actors.id, {
      onDelete: "restrict",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    resourceFk: foreignKey({
      columns: [table.orgId, table.resourceId],
      foreignColumns: [calResources.orgId, calResources.id],
      name: "cal_resource_bookings_resource_org_fk",
    }).onDelete("cascade"),
    occurrenceIdx: uniqueIndex("cal_resource_bookings_occurrence_idx").on(
      table.orgId,
      table.eventId,
      table.resourceId,
      table.startsAt,
    ),
    eventIdx: index("cal_resource_bookings_event_idx").on(table.orgId, table.eventId),
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

export const cardDavAddressBooks = pgTable(
  "carddav_addressbooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id")
      .notNull()
      .references(() => actors.id, {
        onDelete: "cascade",
      }),
    displayName: text("display_name").default("Contacts").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    ...timestamps,
  },
  (table) => ({
    ownerIdx: index("carddav_addressbooks_owner_idx").on(table.orgId, table.ownerActorId, table.id),
  }),
);

export const cardDavContacts = pgTable(
  "carddav_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    ownerActorId: uuid("owner_actor_id")
      .notNull()
      .references(() => actors.id, {
        onDelete: "cascade",
      }),
    addressBookId: uuid("addressbook_id")
      .notNull()
      .references(() => cardDavAddressBooks.id, {
        onDelete: "cascade",
      }),
    href: text("href").notNull(),
    uid: text("uid").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    favorite: boolean("favorite").default(false).notNull(),
    avatarDataUrl: text("avatar_data_url"),
    relationship: jsonb("relationship").default({}).notNull(),
    mergedIntoId: uuid("merged_into_id"),
    vcard: text("vcard").notNull(),
    etag: text("etag").notNull(),
    syncVersion: bigint("sync_version", { mode: "number" }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    retainUntil: timestamp("retain_until", { withTimezone: true }),
    legalHold: boolean("legal_hold").default(false).notNull(),
    ...timestamps,
  },
  (table) => ({
    ownerFavoriteIdx: index("carddav_contacts_owner_favorite_idx").on(
      table.orgId,
      table.ownerActorId,
      table.favorite,
      table.displayName,
    ),
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
    joinCode: text("join_code").notNull(),
    subject: text("subject").notNull(),
    jitsiDomain: text("jitsi_domain").notNull(),
    createdByActorId: uuid("created_by_actor_id").references(() => actors.id),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    scheduledStartAt: timestamp("scheduled_start_at", { withTimezone: true }),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }),
    status: text("status").default("active").notNull(),
    guestPolicy: text("guest_policy").default("disabled").notNull(),
    guestDomains: text("guest_domains").array().default([]).notNull(),
    lobbyEnabled: boolean("lobby_enabled").default(true).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    ...timestamps,
  },
  (table) => ({
    threadIdx: uniqueIndex("meet_rooms_thread_idx").on(table.threadId),
    orgIdIdx: uniqueIndex("meet_rooms_org_id_id_unique_idx").on(table.orgId, table.id),
    orgRoomIdx: uniqueIndex("meet_rooms_org_room_name_idx").on(table.orgId, table.roomName),
    orgJoinCodeIdx: uniqueIndex("meet_rooms_org_join_code_idx").on(table.orgId, table.joinCode),
    orgStatusIdx: index("meet_rooms_org_status_idx").on(table.orgId, table.status),
    createdByIdx: index("meet_rooms_created_by_idx").on(table.createdByActorId, table.status),
  }),
);

export const meetGuestInvites = pgTable(
  "meet_guest_invites",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    roomId: uuid("room_id").notNull(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByActorId: uuid("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    roomFk: foreignKey({
      columns: [table.orgId, table.roomId],
      foreignColumns: [meetRooms.orgId, meetRooms.id],
      name: "meet_guest_invites_room_org_fk",
    }).onDelete("cascade"),
    actorFk: foreignKey({
      columns: [table.orgId, table.createdByActorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "meet_guest_invites_actor_org_fk",
    }),
    activeIdx: index("meet_guest_invites_active_idx").on(
      table.orgId,
      table.roomId,
      table.expiresAt,
    ),
  }),
);

export const meetRecordingUploads = pgTable(
  "meet_recording_uploads",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    roomId: uuid("room_id").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    storageKeyIdx: uniqueIndex("meet_recording_uploads_org_id_storage_key_key").on(
      table.orgId,
      table.storageKey,
    ),
    roomFk: foreignKey({
      columns: [table.orgId, table.roomId],
      foreignColumns: [meetRooms.orgId, meetRooms.id],
      name: "meet_recording_uploads_org_id_room_id_meet_rooms_fk",
    }).onDelete("cascade"),
    expiryIdx: index("meet_recording_uploads_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.completedAt} is null`),
  }),
);

export const meetMediaWebhookReceipts = pgTable(
  "meet_media_webhook_receipts",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    expiryIdx: index("meet_media_webhook_receipts_expiry_idx").on(table.expiresAt),
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
    privacy: text("privacy").default("restricted").notNull(),
    participantKey: text("participant_key"),
    readReceiptsEnabled: boolean("read_receipts_enabled").default(true).notNull(),
    nextMessageSequence: bigint("next_message_sequence", { mode: "number" }).default(0).notNull(),
    nextEventSequence: bigint("next_event_sequence", { mode: "number" }).default(0).notNull(),
    aclVersion: bigint("acl_version", { mode: "number" }).default(0).notNull(),
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
    lastReadSequence: bigint("last_read_sequence", { mode: "number" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.threadId, table.actorId] }),
    actorIdx: index("chat_read_receipts_actor_idx").on(table.actorId, table.updatedAt),
  }),
);

export const chatWebsocketTickets = pgTable(
  "chat_websocket_tickets",
  {
    tokenHash: text("token_hash").primaryKey(),
    orgId: uuid("org_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    roomId: uuid("room_id").notNull(),
    audience: text("audience").notNull(),
    path: text("path").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => ({
    actorOrgFk: foreignKey({
      columns: [table.orgId, table.actorId],
      foreignColumns: [actors.orgId, actors.id],
      name: "chat_websocket_tickets_actor_org_fk",
    }).onDelete("cascade"),
    roomOrgFk: foreignKey({
      columns: [table.orgId, table.roomId],
      foreignColumns: [threads.orgId, threads.id],
      name: "chat_websocket_tickets_room_org_fk",
    }).onDelete("cascade"),
    expiryIdx: index("chat_websocket_tickets_expiry_idx").on(table.expiresAt),
    tokenHashCheck: check(
      "chat_websocket_tickets_token_hash_check",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    audienceCheck: check(
      "chat_websocket_tickets_audience_check",
      sql`length(${table.audience}) > 0`,
    ),
    pathCheck: check("chat_websocket_tickets_path_check", sql`${table.path} like '/%'`),
    expiryCheck: check(
      "chat_websocket_tickets_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
  }),
);

export const chatRoomEvents = pgTable(
  "chat_room_events",
  {
    orgId: uuid("org_id").notNull(),
    roomId: uuid("room_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    event: jsonb("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roomId, table.sequence] }),
    roomOrgFk: foreignKey({
      columns: [table.orgId, table.roomId],
      foreignColumns: [threads.orgId, threads.id],
      name: "chat_room_events_room_org_fk",
    }).onDelete("cascade"),
    messageCreatedIdx: uniqueIndex("chat_room_events_message_created_idx")
      .on(table.roomId, sql`((${table.event}->'message'->>'id'))`)
      .where(sql`${table.event}->>'type' = 'message.created'`),
    sequenceCheck: check("chat_room_events_sequence_check", sql`${table.sequence} > 0`),
  }),
);
