import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actors } from "./auth.js";
import { messageKind, threadKind, timestamps } from "./common.js";

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
