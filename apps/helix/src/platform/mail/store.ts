import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import type { MailOutboundDeliveryHealth } from "./admin-config.js";
import type { MailJournalStore, MailRawSourceStore, MailStore } from "./store-contracts.js";
import {
  type BindOutboundProviderDecisionInput,
  type ClaimedOutboundMail,
  type CreateMailFilterInput,
  type CreateOutboundMailInput,
  type MailJournalSettings,
  type MailboxDelegateRecord,
  type MarkOutboundSentInput,
  type PostgresMailStoreOptions,
  type SetMailVacationInput,
  type UpdateMailFilterInput,
} from "./store-contracts.js";
import { MailDraftStore } from "./store-drafts.js";
import { MailFolderStore } from "./store-folders.js";
import { MailInboundStore } from "./store-inbound.js";
import { MailOutboundStore } from "./store-outbound.js";
import { MailPreferencesStore } from "./store-preferences.js";
import { MailRoutingStore } from "./store-routing.js";
import { MailSearchStore } from "./store-search.js";
import { MailThreadStore } from "./store-threads.js";
import type {
  MailAliasRecord,
  MailClassificationWrite,
  MailDraftRecord,
  MailEnrichmentProjectionStore,
  MailEnrichmentRecord,
  MailEnrichmentWrite,
  MailFilterRecord,
  MailFolderSummary,
  MailInboundAddressResolution,
  MailInboundRecipient,
  MailLabelRecord,
  MailMessageInput,
  MailOutboundRecord,
  MailRawSourceRecord,
  MailSearchHit,
  MailSearchProjectionStore,
  MailSearchRecord,
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
export {
  type BindOutboundProviderDecisionInput,
  type ClaimedOutboundMail,
  type CreateMailFilterInput,
  type CreateOutboundMailInput,
  type MailInboundDedupInput,
  type MailJournalSettings,
  type MailJournalStore,
  type MailRawSourceStore,
  type MailStore,
  type MailboxDelegateRecord,
  type MarkOutboundSentInput,
  type OutboundMailQueueStore,
  type PostgresMailStoreOptions,
  type SetMailVacationInput,
  type UpdateMailFilterInput,
} from "./store-contracts.js";
export { MailDraftConflictError } from "./store-drafts.js";
export { parseMailSearchQuery } from "./store-search-query.js";

/** Stable public adapter; aggregates own their SQL and transaction boundaries. */
export class PostgresMailStore
  implements
    MailStore,
    MailJournalStore,
    MailRawSourceStore,
    MailSearchProjectionStore,
    MailEnrichmentProjectionStore
{
  private readonly routing: MailRoutingStore;
  private readonly inbound: MailInboundStore;
  private readonly outbound: MailOutboundStore;
  private readonly preferences: MailPreferencesStore;
  private readonly threads: MailThreadStore;
  private readonly folders: MailFolderStore;
  private readonly drafts: MailDraftStore;
  private readonly searchProjection: MailSearchStore;

  constructor(sql: postgres.Sql, options: PostgresMailStoreOptions = {}) {
    this.drafts = new MailDraftStore(sql);
    this.routing = new MailRoutingStore(sql);
    this.inbound = new MailInboundStore(sql, options);
    this.outbound = new MailOutboundStore(sql, options);
    this.preferences = new MailPreferencesStore(sql);
    this.threads = new MailThreadStore(sql, this.drafts);
    this.folders = new MailFolderStore(sql);
    this.searchProjection = new MailSearchStore(sql);
  }

  resolveInboundRecipient(address: string): Promise<MailInboundRecipient | null> {
    return this.routing.resolveInboundRecipient(address);
  }

  resolveInboundRecipients(address: string): Promise<readonly MailInboundRecipient[]> {
    return this.routing.resolveInboundRecipients(address);
  }

  resolveInboundAddress(address: string): Promise<MailInboundAddressResolution> {
    return this.routing.resolveInboundAddress(address);
  }

  getJournalSettings(orgId: string): Promise<MailJournalSettings> {
    return this.preferences.getJournalSettings(orgId);
  }

  setJournalSettings(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly enabled: boolean;
    readonly retentionDays: number;
  }): Promise<MailJournalSettings> {
    return this.preferences.setJournalSettings(input);
  }

  grantMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
    readonly expiresAt?: Date | null;
  }): Promise<MailboxDelegateRecord> {
    return this.routing.grantMailboxDelegate(input);
  }

  listMailboxDelegates(
    orgId: string,
    ownerActorId: string,
  ): Promise<readonly MailboxDelegateRecord[]> {
    return this.routing.listMailboxDelegates(orgId, ownerActorId);
  }

  revokeMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
  }): Promise<boolean> {
    return this.routing.revokeMailboxDelegate(input);
  }

  findActorByAddress(
    orgId: string,
    address: string,
  ): Promise<{ readonly actorId: string; readonly email: string } | null> {
    return this.routing.findActorByAddress(orgId, address);
  }

  resolveAuthorizedSender(orgId: string, actorId: string, address: string): Promise<string | null> {
    return this.routing.resolveAuthorizedSender(orgId, actorId, address);
  }

  insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    return this.inbound.insertInboundMessage(input);
  }

  readRawSource(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailRawSourceRecord | null> {
    return this.inbound.readRawSource(input);
  }

  createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    return this.outbound.createOutbound(input);
  }

  getOutbound(id: string): Promise<MailOutboundRecord | null> {
    return this.outbound.getOutbound(id);
  }

  getOutboundDeliveryHealth(input: {
    readonly orgId: string;
    readonly since: Date;
  }): Promise<MailOutboundDeliveryHealth> {
    return this.outbound.getOutboundDeliveryHealth(input);
  }

  claimDueOutbound(input: {
    readonly owner: string;
    readonly leaseMs: number;
    readonly now?: Date;
  }): Promise<ClaimedOutboundMail | null> {
    return this.outbound.claimDueOutbound(input);
  }

  bindOutboundProviderDecision(
    input: BindOutboundProviderDecisionInput,
  ): Promise<MailOutboundRecord | null> {
    return this.outbound.bindOutboundProviderDecision(input);
  }

  markOutboundSent(input: MarkOutboundSentInput): Promise<MailOutboundRecord | null> {
    return this.outbound.markOutboundSent(input);
  }

  cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    return this.outbound.cancelOutbound(input);
  }

  markOutboundRetry(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
  }): Promise<MailOutboundRecord | null> {
    return this.outbound.markOutboundRetry(input);
  }

  markOutboundDeadLettered(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly lastError: string;
    readonly deadLetteredAt?: Date;
  }): Promise<MailOutboundRecord | null> {
    return this.outbound.markOutboundDeadLettered(input);
  }

  replayOutbound(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    return this.outbound.replayOutbound(input);
  }

  listDeadLetteredOutbound(orgId: string, limit = 100): Promise<readonly MailOutboundRecord[]> {
    return this.outbound.listDeadLetteredOutbound(orgId, limit);
  }

  updateThreadState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }): Promise<void> {
    return this.threads.updateThreadState(input);
  }

  recordSpamFeedback(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly messageId?: string | null;
    readonly label: "spam" | "ham";
    readonly source?: "user" | "auto_spamd" | "auto_ai" | "auto_rules";
    readonly evidence?: JsonObject;
  }): Promise<void> {
    return this.preferences.recordSpamFeedback(input);
  }

  createFilter(input: CreateMailFilterInput): Promise<MailFilterRecord> {
    return this.preferences.createFilter(input);
  }

  updateFilter(input: UpdateMailFilterInput): Promise<MailFilterRecord | null> {
    return this.preferences.updateFilter(input);
  }

  deleteFilter(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<boolean> {
    return this.preferences.deleteFilter(input);
  }

  listFilters(orgId: string, actorId: string): Promise<readonly MailFilterRecord[]> {
    return this.preferences.listFilters(orgId, actorId);
  }

  getUserSettings(orgId: string, actorId: string): Promise<MailUserSettings> {
    return this.preferences.getUserSettings(orgId, actorId);
  }

  setUserSettings(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly signatureText: string;
    readonly signatureHtml: string | null;
    readonly includeSignatureOnReplies: boolean;
    readonly blockedSenders: readonly string[];
  }): Promise<MailUserSettings> {
    return this.preferences.setUserSettings(input);
  }

  getVacation(orgId: string, actorId: string): Promise<MailVacationRecord | null> {
    return this.preferences.getVacation(orgId, actorId);
  }

  setVacation(input: SetMailVacationInput): Promise<MailVacationRecord> {
    return this.preferences.setVacation(input);
  }

  getActiveVacation(
    orgId: string,
    actorId: string,
    now: Date = new Date(),
  ): Promise<MailVacationRecord | null> {
    return this.preferences.getActiveVacation(orgId, actorId, now);
  }

  hasVacationResponse(input: {
    readonly vacationId: string;
    readonly senderEmail: string;
  }): Promise<boolean> {
    return this.preferences.hasVacationResponse(input);
  }

  recordVacationResponse(input: {
    readonly vacationId: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly senderEmail: string;
    readonly messageId?: string;
    readonly threadId?: string;
  }): Promise<boolean> {
    return this.preferences.recordVacationResponse(input);
  }

  search(input: MailSearchRequest): Promise<readonly MailSearchHit[]> {
    return this.searchProjection.search(input);
  }

  getMailSearchRecord(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailSearchRecord | null> {
    return this.searchProjection.getMailSearchRecord(input);
  }

  /** Trusted reindex path: project the canonical message once for every owning mailbox. */
  getMailSearchRecordsForIndexing(input: {
    readonly messageId: string;
    readonly orgId?: string | undefined;
  }): Promise<readonly MailSearchRecord[]> {
    return this.searchProjection.getMailSearchRecordsForIndexing(input);
  }

  getMailEnrichmentRecord(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailEnrichmentRecord | null> {
    return this.searchProjection.getMailEnrichmentRecord(input);
  }

  recordMailEnrichment(input: MailEnrichmentWrite): Promise<void> {
    return this.searchProjection.recordMailEnrichment(input);
  }

  setMailClassification(input: MailClassificationWrite): Promise<void> {
    return this.searchProjection.setMailClassification(input);
  }

  getThread(input: MailThreadGetRequest): Promise<MailThreadDetail | null> {
    return this.threads.getThread(input);
  }

  listThreads(input: MailThreadListRequest): Promise<MailThreadListResult> {
    return this.threads.listThreads(input);
  }

  listFolders(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly now?: Date | undefined;
  }): Promise<readonly MailFolderSummary[]> {
    return this.folders.listFolders(input);
  }

  listLabels(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailLabelRecord[]> {
    return this.folders.listLabels(input);
  }

  saveDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id?: string;
    readonly threadId?: string | null;
    readonly envelope: JsonObject;
    readonly expectedRevision?: number;
    readonly idempotencyKey: string;
    readonly attachmentObjectIds: readonly string[];
  }): Promise<MailDraftRecord> {
    return this.drafts.saveDraft(input);
  }

  getDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailDraftRecord | null> {
    return this.drafts.getDraft(input);
  }

  listDrafts(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailDraftRecord[]> {
    return this.drafts.listDrafts(input);
  }

  discardDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly expectedRevision?: number;
  }): Promise<boolean> {
    return this.drafts.discardDraft(input);
  }

  retryOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly outboxSubject?: string;
  }): Promise<MailOutboundRecord | null> {
    return this.outbound.retryOutbound(input);
  }

  listAliases(orgId: string, actorId?: string): Promise<readonly MailAliasRecord[]> {
    return this.routing.listAliases(orgId, actorId);
  }

  createAlias(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly email: string;
    readonly displayName?: string | null;
    readonly isPrimary?: boolean;
    readonly receiveEnabled?: boolean;
    readonly sendAsEnabled?: boolean;
  }): Promise<MailAliasRecord> {
    return this.routing.createAlias(input);
  }

  deleteAlias(input: { readonly orgId: string; readonly id: string }): Promise<boolean> {
    return this.routing.deleteAlias(input);
  }
}
