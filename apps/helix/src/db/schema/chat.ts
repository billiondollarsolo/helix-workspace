import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
import { actors } from "./auth.js";
import { timestamps } from "./common.js";
import { objects } from "./drive.js";
import { messages, threads } from "./messages.js";

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
