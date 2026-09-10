import type { JsonObject } from "@helix/sdk-types";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import type { PostgresMailAttachmentIngestor } from "./attachment-ingestion.js";
import type {
  MailAliasRecord,
  MailDraftRecord,
  MailFilterActions,
  MailFilterCriteria,
  MailFilterRecord,
  MailFolderSummary,
  MailLabelRecord,
  MailMessageInput,
  MailOutboundDeliveryResult,
  MailOutboundEnvelope,
  MailOutboundRecord,
  MailRawSourceRecord,
  MailSearchHit,
  MailSearchRequest,
  MailThreadDetail,
  MailThreadGetRequest,
  MailThreadListRequest,
  MailThreadListResult,
  MailThreadStatePatch,
  MailUserSettings,
  MailVacationRecord,
  StoredMailMessage,
} from "./types.js";

export interface CreateMailFilterInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly priority?: number;
  readonly criteria: MailFilterCriteria;
  readonly actions: MailFilterActions;
}

export interface UpdateMailFilterInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly id: string;
  readonly patch: Partial<Omit<CreateMailFilterInput, "orgId" | "actorId">>;
}

export interface SetMailVacationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly enabled: boolean;
  readonly subject: string;
  readonly body: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly metadata: JsonObject;
}

export interface MailboxDelegateRecord {
  readonly id: string;
  readonly actorId: string;
  readonly validFrom: Date;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateOutboundMailInput {
  readonly draft?: { readonly id: string; readonly revision: number };
  readonly orgId: string;
  readonly actorId: string;
  readonly threadId?: string;
  readonly envelope: MailOutboundEnvelope;
  readonly undoUntil: Date;
  readonly outboxSubject: string;
  readonly idempotencyKey?: string | undefined;
}

export type MarkOutboundSentInput = MailOutboundDeliveryResult & {
  readonly id: string;
  readonly leaseToken: string;
  readonly sentAt?: Date | undefined;
};

export type ClaimedOutboundMail = MailOutboundRecord & {
  readonly handoffKey: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly attemptCount: number;
};

export interface MailJournalSettings {
  readonly enabled: boolean;
  readonly retentionDays: number;
  readonly entryCount: number;
  readonly lastJournaledAt: Date | null;
  readonly updatedAt: Date | null;
}

export interface MailJournalStore {
  getJournalSettings(orgId: string): Promise<MailJournalSettings>;
  setJournalSettings(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly enabled: boolean;
    readonly retentionDays: number;
  }): Promise<MailJournalSettings>;
}

export interface OutboundMailQueueStore {
  claimDueOutbound(input: {
    readonly owner: string;
    readonly leaseMs: number;
    readonly now?: Date;
  }): Promise<ClaimedOutboundMail | null>;
  markOutboundSent(input: MarkOutboundSentInput): Promise<MailOutboundRecord | null>;
  markOutboundRetry(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
  }): Promise<MailOutboundRecord | null>;
  markOutboundDeadLettered(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly lastError: string;
    readonly deadLetteredAt?: Date;
  }): Promise<MailOutboundRecord | null>;
  replayOutbound(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null>;
  listDeadLetteredOutbound(orgId: string, limit?: number): Promise<readonly MailOutboundRecord[]>;
}

export interface BindOutboundProviderDecisionInput {
  readonly leaseToken: string;
  readonly id: string;
  readonly orgId: string;
  readonly providerId: string;
  readonly providerKind: string;
  readonly source: "sending_domain" | "org_default" | "environment";
  readonly decidedAt?: Date;
}

export interface MailInboundDedupInput {
  readonly key: string;
  readonly normalizedMessageId: string | null;
  readonly rawSha256: string;
  readonly envelopeFrom: string | null;
  readonly envelopeTo: readonly string[];
  readonly receivedAt: Date;
}

export interface MailStore {
  findActorByAddress(
    orgId: string,
    address: string,
  ): Promise<{ readonly actorId: string; readonly email: string } | null>;
  resolveAuthorizedSender?(orgId: string, actorId: string, address: string): Promise<string | null>;
  insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage>;
  createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord>;
  getOutbound(id: string): Promise<MailOutboundRecord | null>;
  cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null>;
  updateThreadState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }): Promise<void>;
  /**
   * Durable spam/ham feedback for user Report spam / Not spam and optional
   * auto classifiers. Best-effort when the table is not yet migrated.
   */
  recordSpamFeedback?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly messageId?: string | null;
    readonly label: "spam" | "ham";
    readonly source?: "user" | "auto_spamd" | "auto_ai" | "auto_rules";
    readonly evidence?: JsonObject;
  }): Promise<void>;
  createFilter(input: CreateMailFilterInput): Promise<MailFilterRecord>;
  updateFilter(input: UpdateMailFilterInput): Promise<MailFilterRecord | null>;
  deleteFilter(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<boolean>;
  listFilters(orgId: string, actorId: string): Promise<readonly MailFilterRecord[]>;
  getUserSettings?(orgId: string, actorId: string): Promise<MailUserSettings>;
  setUserSettings?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly signatureText: string;
    readonly signatureHtml: string | null;
    readonly includeSignatureOnReplies: boolean;
    readonly blockedSenders: readonly string[];
  }): Promise<MailUserSettings>;
  getVacation(orgId: string, actorId: string): Promise<MailVacationRecord | null>;
  setVacation(input: SetMailVacationInput): Promise<MailVacationRecord>;
  getActiveVacation(orgId: string, actorId: string, now?: Date): Promise<MailVacationRecord | null>;
  hasVacationResponse(input: {
    readonly vacationId: string;
    readonly senderEmail: string;
  }): Promise<boolean>;
  recordVacationResponse(input: {
    readonly vacationId: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly senderEmail: string;
    readonly messageId?: string;
    readonly threadId?: string;
  }): Promise<boolean>;
  search(input: MailSearchRequest): Promise<readonly MailSearchHit[]>;
  getThread(input: MailThreadGetRequest): Promise<MailThreadDetail | null>;
  /**
   * List the thread-row projection for one folder view, optionally filtered by
   * category tab, label, and free-text query. Paginated; returns `total` for
   * the matching set before `limit`/`offset`.
   */
  listThreads(input: MailThreadListRequest): Promise<MailThreadListResult>;
  /** Per-folder thread + unread counts for the active actor. */
  listFolders(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly now?: Date | undefined;
  }): Promise<readonly MailFolderSummary[]>;
  /** Org + actor labels with display colours and live thread counts. */
  listLabels(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailLabelRecord[]>;
  saveDraft?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id?: string;
    readonly threadId?: string | null;
    readonly envelope: JsonObject;
    readonly expectedRevision?: number;
    readonly idempotencyKey: string;
    readonly attachmentObjectIds: readonly string[];
  }): Promise<MailDraftRecord>;
  getDraft?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailDraftRecord | null>;
  listDrafts?(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailDraftRecord[]>;
  discardDraft?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly expectedRevision?: number;
  }): Promise<boolean>;
  retryOutbound?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly outboxSubject?: string;
  }): Promise<MailOutboundRecord | null>;
  listAliases?(orgId: string, actorId?: string): Promise<readonly MailAliasRecord[]>;
  createAlias?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly email: string;
    readonly displayName?: string | null;
    readonly isPrimary?: boolean;
    readonly receiveEnabled?: boolean;
    readonly sendAsEnabled?: boolean;
  }): Promise<MailAliasRecord>;
  deleteAlias?(input: { readonly orgId: string; readonly id: string }): Promise<boolean>;
  grantMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
    readonly expiresAt?: Date | null;
  }): Promise<MailboxDelegateRecord>;
  listMailboxDelegates(
    orgId: string,
    ownerActorId: string,
  ): Promise<readonly MailboxDelegateRecord[]>;
  revokeMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
  }): Promise<boolean>;
}

export interface MailRawSourceStore {
  readRawSource(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailRawSourceRecord | null>;
}

export interface PostgresMailStoreOptions {
  readonly storageResolver?: TenantStorageResolver | undefined;
  readonly attachmentIngestor?:
    Pick<PostgresMailAttachmentIngestor, "stage" | "release"> | undefined;
}
