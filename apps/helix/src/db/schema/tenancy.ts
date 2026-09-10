import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actors, organizationMemberships } from "./auth.js";
import { orgStatus, timestamps } from "./common.js";
import { mailOutboundProviders } from "./mail.js";

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

export const adminDomains = pgTable(
  "admin_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").notNull(),
    /* The domain identity this capability hangs off (admin_domains). Declared
       without a Drizzle .references() because admin_domains is managed in raw
       SQL and has no table definition here; the FK itself is enforced by the
       database (migration 0086). */
    adminDomainId: uuid("admin_domain_id").notNull(),
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
