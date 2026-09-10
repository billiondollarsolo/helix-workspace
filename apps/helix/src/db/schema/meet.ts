import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actors } from "./auth.js";
import { timestamps } from "./common.js";
import { threads } from "./messages.js";

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
