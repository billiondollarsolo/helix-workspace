import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { actors } from "./auth.js";
import { pendingActionStatus, timestamps, vectorMetric } from "./common.js";
import { orgs } from "./tenancy.js";

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
  approvalKind: text("approval_kind").default("self_confirmation").notNull(),
  approvedByActorId: uuid("approved_by_actor_id").references(() => actors.id),
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
