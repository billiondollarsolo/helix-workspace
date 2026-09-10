import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { actors, organizationMemberships } from "./auth.js";
import { driveUploadState, objectKind, timestamps } from "./common.js";
import { orgs } from "./tenancy.js";

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
    uploadState: driveUploadState("upload_state").default("active").notNull(),
    uploadDeclaredByteSize: numeric("upload_declared_byte_size"),
    uploadDeclaredSha256: text("upload_declared_sha256"),
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
