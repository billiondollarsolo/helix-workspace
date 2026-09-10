import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { actors } from "./auth.js";
import { timestamps, webhookDeliveryStatus, webhookDirection } from "./common.js";

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
