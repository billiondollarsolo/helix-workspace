import type { AIClassification, JsonObject } from "@helix/sdk-types";
import type { MailCategoryTab } from "./category.js";

export const mailPluginId = "com.helix.core.mail";

/**
 * Logical mail folders surfaced in the UI's left rail. These are *views* over
 * the per-actor thread state rather than physical containers — e.g. `starred`
 * is "threads with starred = true", `archive` is "threads with archived_at set".
 */
export type MailFolderId =
  "inbox" | "starred" | "snoozed" | "sent" | "drafts" | "archive" | "spam" | "trash";

export const MAIL_FOLDER_IDS = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "archive",
  "spam",
  "trash",
] as const satisfies readonly MailFolderId[];

export interface MailFolderSummary {
  readonly id: MailFolderId;
  /** Human-readable folder name. */
  readonly label: string;
  /** Threads in this folder (filtered to the active actor). */
  readonly total: number;
  /** Unread threads in this folder. */
  readonly unread: number;
}

export interface MailLabelRecord {
  readonly id: string;
  readonly orgId: string;
  /** `null` for a shared/org label, otherwise the owning actor. */
  readonly ownerActorId: string | null;
  /** Stable slug stored on `mail_thread_state.labels`. */
  readonly slug: string;
  readonly name: string;
  /** Hex display colour. */
  readonly color: string;
  readonly sortOrder: number;
  /** Threads visible to the actor currently carrying this label. */
  readonly threadCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A single row in the UI thread list — sender/subject/preview/time + flags. */
export interface MailThreadRowRecord {
  readonly threadId: string;
  /** Most-recent message in the thread. */
  readonly messageId: string;
  readonly subject: string;
  /** Display name of the most-recent sender, falling back to the address. */
  readonly from: string;
  readonly fromEmail: string;
  /** Truncated body preview of the most-recent message. */
  readonly preview: string;
  /** ISO timestamp of the last activity. */
  readonly time: string;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly hasAttachment: boolean;
  /** Number of messages in the thread. */
  readonly messageCount: number;
  /** Labels currently applied to the thread (slugs). */
  readonly labels: readonly string[];
  /** Derived category tab. */
  readonly category: MailCategoryTab;
  readonly folder: MailFolderId;
  readonly snoozedUntil: string | null;
  /** Who filed this thread into Spam (from message scan metadata). */
  readonly spamCatcher?: "spamd" | "ai" | "rules" | "user" | "virus" | "scanner-policy" | "auth-failure" | null;
}

export interface MailThreadListRequest {
  readonly orgId: string;
  readonly actorId: string;
  /** Folder view; defaults to `inbox`. */
  readonly folder?: MailFolderId | undefined;
  /** Category-tab filter; only meaningful for `inbox`. */
  readonly tab?: MailCategoryTab | undefined;
  /** Restrict to threads carrying this label slug. */
  readonly label?: string | undefined;
  /** Free-text query over subject + body. */
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** Evaluation "now" — controls snooze expiry. Defaults to the current time. */
  readonly now?: Date | undefined;
}

export interface MailThreadListResult {
  readonly threads: readonly MailThreadRowRecord[];
  /** Total matching threads before `limit`/`offset` were applied. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export type MailDirection = "inbound" | "outbound";

export type MailAddress = JsonObject & {
  readonly address: string;
  readonly email?: string;
  readonly name?: string;
};

export type MailEnvelopeAddress = MailAddress;

export interface MailAttachmentInput {
  readonly filename?: string | undefined;
  readonly mimeType: string;
  readonly contentType?: string | undefined;
  /** Inline bytes (legacy small attachments). Optional when `objectId` is set. */
  readonly content?: Buffer | undefined;
  /** Drive object reference — resolved to a stream/buffer at dispatch time. */
  readonly objectId?: string | undefined;
  readonly path?: string | undefined;
  readonly contentId?: string | undefined;
  readonly disposition?: string | undefined;
}

export interface MailMessageInput {
  readonly orgId: string;
  readonly actorId?: string | null | undefined;
  readonly threadId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly from: MailEnvelopeAddress;
  readonly to: readonly MailEnvelopeAddress[];
  readonly cc?: readonly MailEnvelopeAddress[] | undefined;
  readonly bcc?: readonly MailEnvelopeAddress[] | undefined;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: readonly string[] | undefined;
  readonly attachments?: readonly MailAttachmentInput[] | undefined;
  readonly receivedAt?: Date | undefined;
  readonly metadata?: JsonObject | undefined;
}

export type MailOutboundStatus = "queued" | "sending" | "sent" | "failed" | "cancelled";

export interface MailOutboundEnvelope {
  readonly from: MailEnvelopeAddress;
  readonly to: readonly MailEnvelopeAddress[];
  readonly cc: readonly MailEnvelopeAddress[];
  readonly bcc: readonly MailEnvelopeAddress[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
  readonly attachments: readonly MailAttachmentInput[];
}

export interface StoredMailMessage {
  readonly threadId: string;
  readonly messageId: string;
  readonly attachmentObjectIds: readonly string[];
}

export type MailFilterCriteria = JsonObject & {
  readonly fromContains?: string;
  readonly toContains?: string;
  readonly subjectContains?: string;
  readonly bodyContains?: string;
  readonly hasAttachment?: boolean;
};

export type MailFilterActions = JsonObject & {
  readonly applyLabels?: readonly string[];
  readonly archive?: boolean;
  readonly delete?: boolean;
  readonly snoozeUntil?: string;
};

export interface MailFilterRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly criteria: MailFilterCriteria;
  readonly actions: MailFilterActions;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MailThreadStatePatch {
  readonly addLabels?: readonly string[] | undefined;
  readonly removeLabels?: readonly string[] | undefined;
  readonly archivedAt?: Date | undefined;
  readonly deletedAt?: Date | undefined;
  readonly snoozedUntil?: Date | undefined;
  readonly readAt?: Date | null | undefined;
  readonly starred?: boolean | undefined;
  /** Stamps (or, when `null`, clears) the per-actor Spam-folder routing flag. */
  readonly spamAt?: Date | null | undefined;
}

export interface MailVacationRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly enabled: boolean;
  readonly subject: string;
  readonly body: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MailOutboundRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly outboxId: string | null;
  readonly status: MailOutboundStatus;
  readonly envelope: MailOutboundEnvelope;
  readonly undoUntil: Date;
  readonly sentAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly failedAt: Date | null;
  readonly lastError: string | null;
  readonly providerMessageId: string | null;
  /** Stable dispatch-time provider choice. Secrets are never persisted here. */
  readonly providerId?: string | null;
  readonly providerKind?: string | null;
  readonly providerDecisionSource?: "sending_domain" | "org_default" | "environment" | null;
  readonly providerDecidedAt?: Date | null;
  readonly deliveryMetadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Delivery attempt count (retry/dead-letter). */
  readonly attemptCount?: number;
  readonly nextAttemptAt?: Date | null;
  readonly deadLetteredAt?: Date | null;
}

/** Persisted draft envelope (first-class drafts, not undo-window outbox rows). */
export interface MailDraftRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly threadId: string | null;
  readonly envelope: JsonObject;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MailAliasRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: Date;
}

export interface MailOutboundDeliveryResult {
  readonly providerMessageId?: string | undefined;
  readonly deliveryMetadata?: JsonObject | undefined;
}

export interface MailSearchRequest {
  readonly orgId: string;
  readonly actorId: string;
  readonly query?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface MailSearchHit {
  readonly threadId: string;
  readonly messageId: string;
  readonly subject: string;
  readonly from?: MailEnvelopeAddress | undefined;
  readonly preview: string;
  readonly sentAt: Date;
  readonly labels: readonly string[];
  readonly unread: boolean;
  readonly starred: boolean;
  /** True when metadata indicates at least one attachment (M13 has:attachment). */
  readonly hasAttachment?: boolean | undefined;
  readonly outboundStatus?: MailOutboundStatus | undefined;
  readonly providerMessageId?: string | undefined;
  readonly deliveryMetadata?: JsonObject | undefined;
}

export interface MailThreadGetRequest {
  readonly orgId: string;
  readonly actorId: string;
  readonly threadId: string;
}

export interface MailThreadMessage {
  readonly id: string;
  readonly from?: MailEnvelopeAddress | undefined;
  readonly to: readonly MailEnvelopeAddress[];
  readonly cc: readonly MailEnvelopeAddress[];
  readonly bcc: readonly MailEnvelopeAddress[];
  readonly sentAt: Date;
  readonly body: string;
  readonly bodyFormat: "plain" | "html";
  readonly hasAttachment: boolean;
  readonly attachments: readonly MailThreadAttachment[];
}

export interface MailThreadAttachment {
  readonly objectId: string;
  readonly filename?: string | undefined;
  readonly contentId?: string | undefined;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256?: string | undefined;
  readonly disposition: string;
}

export interface MailThreadDetail {
  readonly id: string;
  readonly subject: string;
  readonly preview: string;
  readonly participants: readonly MailEnvelopeAddress[];
  readonly messages: readonly MailThreadMessage[];
  readonly labels: readonly string[];
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly snoozedUntil: Date | null;
  readonly lastActivity: Date;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly direction: MailDirection | "mixed";
}

export interface MailSearchRecord {
  readonly id: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly subject: string;
  readonly body: string;
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc?: readonly MailAddress[] | undefined;
  readonly bcc?: readonly MailAddress[] | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly folder?: string | undefined;
  readonly direction: MailDirection;
  readonly classification?: AIClassification | undefined;
  readonly sentAt: string;
  readonly updatedAt?: string | undefined;
  readonly metadata?: JsonObject | undefined;
  /**
   * RAG owner — the actor whose mailbox owns this message copy. For outbound
   * mail this is the sender; for inbound, the recipient mailbox owner.
   * Indexed embeddings are scoped to this actor (visibility="private"); other
   * users in the org cannot retrieve this mail via RAG. Null only for system
   * mail (announcements, status notifications) which then index as
   * visibility="org".
   */
  readonly ownerActorId: string | null;
}

export interface MailSearchProjectionStore {
  getMailSearchRecord(messageId: string): Promise<MailSearchRecord | null>;
}

export type MailEnrichmentRecord = MailSearchRecord;

export interface MailEnrichmentProjectionStore {
  getMailEnrichmentRecord(messageId: string): Promise<MailEnrichmentRecord | null>;
  recordMailEnrichment?(input: MailEnrichmentWrite): Promise<void>;
  setMailClassification?(input: MailClassificationWrite): Promise<void>;
}

export interface MailEnrichmentWrite {
  readonly messageId: string;
  readonly feature: string;
  readonly data: JsonObject;
}

export interface MailClassificationWrite {
  readonly messageId: string;
  readonly classification: AIClassification;
  readonly source: string;
  readonly reason: string;
}

export type MailActivityPayload = JsonObject;
