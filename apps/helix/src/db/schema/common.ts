import { pgEnum, timestamp } from "drizzle-orm/pg-core";

export const actorType = pgEnum("actor_type", ["user", "agent", "service_account", "system"]);

export const orgStatus = pgEnum("org_status", [
  "provisioning",
  "active",
  "suspended",
  "soft_deleted",
  "hard_deleted",
]);

export const objectKind = pgEnum("object_kind", [
  "file",
  "mail_attachment",
  "document",
  "recording",
  "other",
  "mail_source",
  "chat_attachment",
]);

export const driveUploadState = pgEnum("drive_upload_state", [
  "pending_upload",
  "uploaded",
  "scanning",
  "active",
  "quarantined",
  "scan_failed",
  "trashed",
]);

export const driveScanJobStatus = pgEnum("drive_scan_job_status", [
  "pending",
  "running",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
]);

export const threadKind = pgEnum("thread_kind", [
  "mail",
  "chat_room",
  "chat_dm",
  "doc",
  "calendar",
  "call",
]);

export const messageKind = pgEnum("message_kind", ["mail", "chat", "comment", "system"]);

export const pendingActionStatus = pgEnum("pending_action_status", [
  "pending_confirmation",
  "approved",
  "executing",
  "executed",
  "failed",
  "cancelled",
  "expired",
]);

export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "pending",
  "in_progress",
  "delivered",
  "failed",
  "abandoned",
]);

export const webhookDirection = pgEnum("webhook_direction", ["outbound", "inbound"]);

export const mailOutboundStatus = pgEnum("mail_outbound_status", [
  "queued",
  "cancelled",
  "sending",
  "accepted",
  "delivered",
  "deferred",
  "bounced",
  "complained",
  "failed",
]);

export const mailOutboundProviderKind = pgEnum("mail_outbound_provider_kind", [
  "ses",
  "mailgun",
  "smtp",
  "postmark",
]);

export const mailDeliveryEventKind = pgEnum("mail_delivery_event_kind", [
  "accepted",
  "delivered",
  "deferred",
  "bounced",
  "complained",
]);

export const mailDeliveryEventSource = pgEnum("mail_delivery_event_source", ["provider", "dsn"]);

export const mailDeliveryRetryClass = pgEnum("mail_delivery_retry_class", [
  "none",
  "transient",
  "permanent",
]);

export const mailSuppressionReason = pgEnum("mail_suppression_reason", [
  "hard_bounce",
  "complaint",
  "manual",
]);

export const mailAttachmentIngestStatus = pgEnum("mail_attachment_ingest_status", [
  "pending_upload",
  "quarantined",
  "scanning",
  "clean",
  "attached",
  "rejected",
]);

export const mailDkimKeyStatus = pgEnum("mail_dkim_key_status", [
  "pending",
  "active",
  "retiring",
  "retired",
]);

export const mailReceivingDomainStatus = pgEnum("mail_receiving_domain_status", [
  "pending",
  "verified",
  "active",
  "disabled",
]);

export const mailRoutingActionKind = pgEnum("mail_routing_action_kind", [
  "forward",
  "alias",
  "drop",
  "tag",
  "mailbox",
]);

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const vectorMetric = pgEnum("vector_metric", ["cosine", "dot", "l2"]);
