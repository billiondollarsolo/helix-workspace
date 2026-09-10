import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  cidr,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actorType, timestamps } from "./common.js";
import { orgs } from "./tenancy.js";

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
