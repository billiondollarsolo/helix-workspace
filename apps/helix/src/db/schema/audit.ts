import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { actors } from "./auth.js";

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
