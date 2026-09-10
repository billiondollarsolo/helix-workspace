import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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
import {
  mailDkimKeyStatus,
  mailReceivingDomainStatus,
  mailRoutingActionKind,
  timestamps,
} from "./common.js";
import { adminDomains, orgs } from "./tenancy.js";

export const mailReceivingDomains = pgTable(
  "mail_receiving_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /* See mailSendingDomains.adminDomainId — same parent, same reason the
       reference is left to the database. */
    adminDomainId: uuid("admin_domain_id").notNull(),
    domain: text("domain").notNull(),
    status: mailReceivingDomainStatus("status").default("pending").notNull(),
    verificationTokenHash: text("verification_token_hash").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    catchAllActorId: uuid("catch_all_actor_id").references(() => actors.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (table) => ({
    orgDomainIdx: uniqueIndex("mail_receiving_domains_org_domain_idx").on(
      table.orgId,
      table.domain,
    ),
    activeDomainIdx: uniqueIndex("mail_receiving_domains_active_domain_idx")
      .on(table.domain)
      .where(sql`${table.status} = 'active'`),
    tokenHashIdx: uniqueIndex("mail_receiving_domains_token_hash_idx").on(
      table.verificationTokenHash,
    ),
    orgStatusIdx: index("mail_receiving_domains_org_status_idx").on(
      table.orgId,
      table.status,
      table.createdAt,
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
