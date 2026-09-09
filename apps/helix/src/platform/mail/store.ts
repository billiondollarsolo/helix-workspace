import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject, StorageObject } from "@helix/sdk-types";
import { sensitivityClassificationFromMetadata } from "../ai/classification/index.js";
import {
  MAIL_ATTACHMENT_MAX_FILE_BYTES,
  MAIL_ATTACHMENT_MAX_FILES,
  MAIL_ATTACHMENT_MAX_TOTAL_BYTES,
} from "@helix/contracts";
import type { MailOutboundDeliveryHealth } from "./admin-config.js";
import type { TenantStorageClient, TenantStorageResolver } from "../storage/tenant-resolver.js";
import type {
  MailFilterActions,
  MailFilterCriteria,
  MailFilterRecord,
  MailClassificationWrite,
  MailEnrichmentProjectionStore,
  MailEnrichmentRecord,
  MailEnrichmentWrite,
  MailFolderId,
  MailFolderSummary,
  MailInboundAddressResolution,
  MailInboundRecipient,
  MailInboundRoutingAction,
  MailInboundRoutingRule,
  MailAttachmentInput,
  MailLabelRecord,
  MailMessageInput,
  MailRawSourceRecord,
  MailOutboundEnvelope,
  MailOutboundDeliveryResult,
  MailOutboundRecord,
  MailOutboundStatus,
  MailSearchHit,
  MailSearchProjectionStore,
  MailSearchRequest,
  MailSearchRecord,
  MailThreadDetail,
  MailThreadAttachment,
  MailThreadGetRequest,
  MailThreadListRequest,
  MailThreadListResult,
  MailThreadMessage,
  MailThreadRowRecord,
  MailAliasRecord,
  MailDraftRecord,
  MailThreadStatePatch,
  MailVacationRecord,
  MailUserSettings,
  StoredMailMessage,
} from "./types.js";
import { MAIL_FOLDER_IDS } from "./types.js";
import { classifyMailCategory, coerceMailCategory } from "./category.js";
import {
  MailInboundQuotaExceededError,
  MailAttachmentQuotaError,
  MailRawSourceIntegrityError,
  MailRecipientSuppressedError,
  MailThreadNotFoundError,
} from "./errors.js";
import { MAIL_RAW_SOURCE_MAX_BYTES, verifyMailRawSource } from "./raw-source.js";
import type {
  PostgresMailAttachmentIngestor,
  StagedMailAttachment,
} from "./attachment-ingestion.js";
import {
  normalizeMessageId,
  normalizeProviderDeliveryId,
  prepareOutboundEnvelope,
  threadReferenceIds,
} from "./threading.js";
// ponytail: store.ts is the mail IO adapter surface (~1700 LOC). Split list/folder
// projection into store-threads when next touching listThreads; keep god-file note
// until that extraction lands fully (G9).

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
  }): Promise<boolean>;
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
    | Pick<PostgresMailAttachmentIngestor, "stage" | "release">
    | undefined;
}

interface MailFilterRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly criteria: MailFilterCriteria;
  readonly actions: MailFilterActions;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MailVacationRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly enabled: boolean;
  readonly subject: string;
  readonly body: string;
  readonly starts_at: Date | null;
  readonly ends_at: Date | null;
  readonly metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MailUserSettingsRow {
  readonly signature_text: string;
  readonly signature_html: string | null;
  readonly include_signature_on_replies: boolean;
  readonly blocked_senders: string[];
  readonly updated_at: Date;
}

interface MailJournalSettingsRow {
  readonly enabled: boolean;
  readonly retention_days: number;
  readonly updated_at: Date;
}

interface MailOutboundRow {
  readonly id: string;
  readonly org_id: string;
  readonly idempotency_key: string | null;
  readonly actor_id: string;
  readonly message_id: string;
  readonly thread_id: string;
  readonly outbox_id: string | null;
  readonly status: MailOutboundStatus;
  readonly envelope: MailOutboundEnvelope;
  readonly undo_until: Date;
  readonly sent_at: Date | null;
  readonly cancelled_at: Date | null;
  readonly failed_at: Date | null;
  readonly last_error: string | null;
  readonly provider_message_id: string | null;
  readonly attempt_count?: number;
  readonly next_attempt_at?: Date | null;
  readonly dead_lettered_at?: Date | null;
  readonly handoff_key?: string;
  readonly lease_owner?: string | null;
  readonly lease_token?: string | null;
  readonly lease_expires_at?: Date | null;
  readonly delivery_metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MailSearchRow {
  readonly thread_id: string;
  readonly message_id: string;
  readonly subject: string | null;
  readonly body: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly labels: readonly string[] | null;
  readonly read_at: Date | null;
  readonly starred: boolean | null;
  readonly outbound_status: MailOutboundStatus | null;
  readonly provider_message_id: string | null;
  readonly delivery_metadata: JsonObject | null;
}

interface MailRawSourceRow {
  readonly message_id: string;
  readonly parser: string;
  readonly projection_version: number;
  readonly projection: JsonObject;
  readonly projection_sha256: string;
  readonly storage_key: string;
  readonly byte_size: number;
  readonly sha256: string;
}

interface MailIdentityRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly raw_sha256: string | null;
  readonly provider_delivery_id: string | null;
  readonly attachment_object_ids: readonly string[];
}

interface MailThreadRow {
  readonly thread_id: string;
  readonly subject: string | null;
  readonly thread_archived_at: Date | null;
  readonly labels: readonly string[] | null;
  readonly archived_at: Date | null;
  readonly deleted_at: Date | null;
  readonly snoozed_until: Date | null;
  readonly read_at: Date | null;
  readonly starred: boolean | null;
  readonly message_id: string;
  readonly body: string;
  readonly body_format: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly has_attachment: boolean;
  readonly attachments: readonly MailThreadAttachmentRow[] | null;
}

interface MailSearchRecordRow {
  readonly org_id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly subject: string | null;
  readonly body: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly updated_at: Date;
  readonly labels: readonly string[] | null;
  readonly actor_id: string;
}

interface MailThreadAttachmentRow {
  readonly objectId?: unknown;
  readonly filename?: unknown;
  readonly contentId?: unknown;
  readonly mimeType?: unknown;
  readonly byteSize?: unknown;
  readonly sha256?: unknown;
  readonly disposition?: unknown;
}

interface MailThreadListRow {
  readonly thread_id: string;
  readonly subject: string | null;
  readonly message_id: string;
  readonly body: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly message_count: number;
  readonly has_attachment: boolean;
  readonly labels: readonly string[] | null;
  readonly read_at: Date | null;
  readonly starred: boolean | null;
  readonly category: string | null;
  readonly snoozed_until: Date | null;
  readonly outbound_status: MailOutboundStatus | null;
  readonly total: number;
}

interface MailFolderCountRow {
  readonly folder: MailFolderId;
  readonly total: number;
  readonly unread: number;
}

interface MailLabelRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly slug: string;
  readonly name: string;
  readonly color: string;
  readonly sort_order: number;
  readonly thread_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MailboxDelegateRow {
  readonly id: string;
  readonly actor_id: string;
  readonly valid_from: Date;
  readonly expires_at: Date | null;
  readonly created_at: Date;
}

interface InboundRoutingRuleRow {
  readonly id: string;
  readonly org_id: string;
  readonly priority: number;
  readonly match: JsonObject;
  readonly action_kind: MailInboundRoutingAction;
  readonly action: JsonObject;
  readonly target_actor_id: string | null;
  readonly target_address: string | null;
  readonly target_quota_exceeded: boolean | null;
  readonly source_actor_id: string | null;
  readonly source_address: string | null;
}

export class PostgresMailStore
  implements
    MailStore,
    MailJournalStore,
    MailRawSourceStore,
    MailSearchProjectionStore,
    MailEnrichmentProjectionStore
{
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresMailStoreOptions = {},
  ) {}

  async resolveInboundRecipient(address: string): Promise<MailInboundRecipient | null> {
    const recipients = await this.resolveInboundRecipients(address);
    return recipients.length === 1 ? (recipients[0] ?? null) : null;
  }

  async resolveInboundRecipients(address: string): Promise<readonly MailInboundRecipient[]> {
    const normalized = normalizeAddress(address);
    const domain = emailDomain(normalized);
    if (domain === null) {
      return [];
    }
    const rows = await this.sql<
      {
        readonly org_id: string;
        readonly actor_id: string;
        readonly address: string;
        readonly quota_exceeded: boolean;
      }[]
    >`
      select org_id, actor_id, address, quota_exceeded
      from helix_resolve_inbound_mailboxes(${normalized}, ${domain})
    `;
    if (rows.some((recipient) => recipient.quota_exceeded)) {
      throw new MailInboundQuotaExceededError();
    }
    return rows.map((recipient) => ({
      orgId: recipient.org_id,
      actorId: recipient.actor_id,
      address: recipient.address,
    }));
  }

  async resolveInboundAddress(address: string): Promise<MailInboundAddressResolution> {
    const normalized = normalizeAddress(address);
    const domain = emailDomain(normalized);
    if (domain === null) return { address: normalized, recipients: [], rules: [] };

    const [recipients, rows] = await Promise.all([
      this.resolveInboundRecipients(normalized),
      this.sql<InboundRoutingRuleRow[]>`
        select * from helix_resolve_inbound_routing_rules(${normalized}, ${domain})
      `,
    ]);
    if (rows.some((row) => row.target_quota_exceeded === true)) {
      throw new MailInboundQuotaExceededError();
    }
    const rules = new Map<string, MailInboundRoutingRule>();
    for (const row of rows) {
      const current = rules.get(row.id);
      const targetRecipients = [
        ...(current?.targetRecipients ?? []),
        ...(row.target_actor_id === null || row.target_address === null
          ? []
          : [{ orgId: row.org_id, actorId: row.target_actor_id, address: row.target_address }]),
      ];
      rules.set(row.id, {
        id: row.id,
        orgId: row.org_id,
        priority: row.priority,
        match: row.match,
        actionKind: row.action_kind,
        action: row.action,
        targetRecipients,
        ...(row.source_actor_id === null || row.source_address === null
          ? {}
          : {
              sourceRecipient: {
                orgId: row.org_id,
                actorId: row.source_actor_id,
                address: row.source_address,
              },
            }),
      });
    }
    return { address: normalized, recipients, rules: [...rules.values()] };
  }

  async getJournalSettings(orgId: string): Promise<MailJournalSettings> {
    const [settings, status] = await Promise.all([
      this.sql<MailJournalSettingsRow[]>`
        select enabled, retention_days, updated_at
        from mail_journal_settings where org_id = ${orgId}
      `,
      this.sql<{ readonly entry_count: number; readonly last_journaled_at: Date | null }[]>`
        select count(*)::integer as entry_count, max(created_at) as last_journaled_at
        from mail_journal_entries where org_id = ${orgId}
      `,
    ]);
    return {
      enabled: settings[0]?.enabled ?? false,
      retentionDays: settings[0]?.retention_days ?? 2555,
      entryCount: status[0]?.entry_count ?? 0,
      lastJournaledAt: status[0]?.last_journaled_at ?? null,
      updatedAt: settings[0]?.updated_at ?? null,
    };
  }

  async setJournalSettings(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly enabled: boolean;
    readonly retentionDays: number;
  }): Promise<MailJournalSettings> {
    await this.sql`
      insert into mail_journal_settings (
        org_id, enabled, retention_days, updated_by_actor_id, updated_at
      ) values (
        ${input.orgId}, ${input.enabled}, ${input.retentionDays}, ${input.actorId}, statement_timestamp()
      ) on conflict (org_id) do update set
        enabled = excluded.enabled,
        retention_days = excluded.retention_days,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = excluded.updated_at
    `;
    return this.getJournalSettings(input.orgId);
  }

  async grantMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
    readonly expiresAt?: Date | null;
  }): Promise<MailboxDelegateRecord> {
    const rows = await this.sql<MailboxDelegateRow[]>`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id,
        valid_from, expires_at
      )
      values (
        ${input.orgId}, ${input.delegateActorId}, 'mailbox', ${input.ownerActorId},
        'manager', ${input.ownerActorId}, now(), ${input.expiresAt ?? null}
      )
      on conflict (org_id, resource_id, actor_id)
        where resource_type = 'mailbox' and status = 'active'
      do update set
        valid_from = now(),
        expires_at = excluded.expires_at,
        updated_at = now()
      returning id, actor_id, valid_from, expires_at, created_at
    `;
    return mapMailboxDelegate(rows[0]);
  }

  async listMailboxDelegates(
    orgId: string,
    ownerActorId: string,
  ): Promise<readonly MailboxDelegateRecord[]> {
    const rows = await this.sql<MailboxDelegateRow[]>`
      select id, actor_id, valid_from, expires_at, created_at
      from permissions
      where org_id = ${orgId}
        and resource_type = 'mailbox'
        and resource_id = ${ownerActorId}
        and role = 'manager'
        and status = 'active'
        and valid_from <= now()
        and (expires_at is null or expires_at > now())
        and revoked_at is null
      order by created_at, actor_id
    `;
    return rows.map(mapMailboxDelegate);
  }

  async revokeMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      update permissions
      set
        status = 'revoked',
        revoked_at = now(),
        revocation_epoch = revocation_epoch + 1,
        updated_at = now()
      where org_id = ${input.orgId}
        and resource_type = 'mailbox'
        and resource_id = ${input.ownerActorId}
        and actor_id = ${input.delegateActorId}
        and status = 'active'
      returning id
    `;
    return rows.length > 0;
  }

  async findActorByAddress(
    orgId: string,
    address: string,
  ): Promise<{ readonly actorId: string; readonly email: string } | null> {
    const normalized = normalizeAddress(address);
    const rows = await this.sql<{ readonly id: string; readonly email: string }[]>`
      with requested as (
        select ${normalized}::text as address,
               split_part(${normalized}, '@', 2) as domain,
               helix_canonical_login_email(${orgId}, ${normalized}) as canonical
      )
      select actor.id, actor.email
      from requested
      join admin_domains domain
        on domain.org_id = ${orgId} and domain.domain = requested.domain
      join actors actor on actor.org_id = ${orgId}
      join organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      where requested.canonical is not null
        and domain.status = 'verified' and domain.identity_enabled and domain.mail_enabled
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
        and lower(actor.email) = requested.canonical
      union all
      select alias.actor_id as id, alias.email
      from requested
      join mail_aliases alias
        on alias.org_id = ${orgId} and lower(alias.email) = requested.address
      join actors actor on actor.id = alias.actor_id and actor.org_id = alias.org_id
      join organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      join admin_domains domain
        on domain.org_id = alias.org_id and domain.domain = requested.domain
      where alias.enabled and alias.disabled_at is null and alias.receive_enabled
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
        and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
      limit 2
    `;
    const row = rows[0];
    return rows.length !== 1 || row === undefined ? null : { actorId: row.id, email: row.email };
  }

  async resolveAuthorizedSender(
    orgId: string,
    actorId: string,
    address: string,
  ): Promise<string | null> {
    const normalized = normalizeAddress(address);
    const rows = await this.sql<{ readonly address: string }[]>`
      with member as (
        select actor.email
        from actors actor
        join organization_memberships membership
          on membership.org_id = actor.org_id and membership.actor_id = actor.id
        where actor.org_id = ${orgId} and actor.id = ${actorId}
          and actor.type = 'user' and actor.disabled_at is null
          and membership.status = 'active' and membership.guest_type = 'member'
      )
      select ${normalized}::text as address
      from member
      where (
        lower(member.email) = ${normalized}
        and exists (
          select 1 from admin_domains domain
          where domain.org_id = ${orgId}
            and domain.domain = split_part(${normalized}, '@', 2)
            and domain.status = 'verified' and domain.identity_enabled and domain.mail_enabled
        )
      ) or exists (
        select 1 from mail_aliases alias
        left join admin_domains domain
          on domain.org_id = alias.org_id
         and domain.domain = split_part(lower(alias.email), '@', 2)
        where alias.org_id = ${orgId} and alias.actor_id = ${actorId}
          and alias.enabled and alias.disabled_at is null and alias.send_as_enabled
          and lower(alias.email) = ${normalized}
          and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
      ) or exists (
        select 1
        from admin_domains source
        join admin_domains target
          on target.id = source.alias_target_domain_id and target.org_id = source.org_id
        where source.org_id = ${orgId}
          and source.domain = split_part(${normalized}, '@', 2)
          and source.status = 'verified' and source.identity_mode = 'alias'
          and source.identity_enabled and source.mail_enabled and source.aliases_enabled
          and target.status = 'verified' and target.identity_enabled
          and target.domain = split_part(lower(member.email), '@', 2)
          and split_part(${normalized}, '@', 1) = split_part(lower(member.email), '@', 1)
      )
      limit 1
    `;
    return rows[0]?.address ?? null;
  }

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    const inbound = {
      ...input,
      metadata: { ...(input.metadata ?? {}), direction: "inbound" },
    } satisfies MailMessageInput;
    if (input.rawSource !== undefined) {
      await verifyMailRawSource(input.rawSource);
    }
    const normalizedMessageId = normalizeMessageId(input.messageId);
    const providerDeliveryId = normalizeProviderDeliveryId(input.providerDeliveryId);
    if (input.providerDeliveryId !== undefined && providerDeliveryId === null) {
      throw new TypeError("providerDeliveryId must be a bounded, non-empty opaque identifier.");
    }
    const rawSha256 = input.rawSource?.sha256 ?? null;
    const identityKeys = [
      ...(normalizedMessageId === null ? [] : [`rfc:${normalizedMessageId}`]),
      ...(rawSha256 === null ? [] : [`raw:${rawSha256}`]),
      ...(providerDeliveryId === null ? [] : [`provider:${providerDeliveryId}`]),
    ].sort();

    const staged = await stageInlineAttachments(inbound, this.options.attachmentIngestor);
    try {
      const result = await this.sql.begin(async (tx) => {
        if (identityKeys.length > 0) {
          await lockMailIdentities(tx, input.orgId, identityKeys);
          const existing = await findInboundIdentity(tx, {
            orgId: input.orgId,
            normalizedMessageId,
            rawSha256,
            providerDeliveryId,
          });
          if (existing.length > 0) {
            const canonical = resolveCanonicalIdentity(existing, rawSha256, providerDeliveryId);
            const deliveredActorIds = await deliverInboundMessage(tx, {
              input: staged.input,
              threadId: canonical.thread_id,
              messageId: canonical.message_id,
            });
            return {
              threadId: canonical.thread_id,
              messageId: canonical.message_id,
              attachmentObjectIds: canonical.attachment_object_ids,
              created: false,
              deliveredActorIds,
              authoritativeAttachments: [],
            };
          }
        }

        const referencedThreadId = await findReferencedThread(tx, staged.input);
        const sourceStorage =
          input.rawSource === undefined
            ? undefined
            : (await this.options.storageResolver?.({ orgId: input.orgId }))?.client;
        if (input.rawSource !== undefined && sourceStorage === undefined) {
          throw new Error("Tenant storage is required for inbound mail evidence.");
        }
        return insertMailMessage(
          tx,
          referencedThreadId === undefined
            ? staged.input
            : { ...staged.input, threadId: referencedThreadId },
          sourceStorage,
        );
      });
      if (!result.created) {
        await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      }
      const { authoritativeAttachments: _attachments, ...stored } = result;
      return stored;
    } catch (error) {
      await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      throw error;
    }
  }

  async readRawSource(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailRawSourceRecord | null> {
    const rows = await this.sql<MailRawSourceRow[]>`
      select
        source.message_id,
        source.parser,
        source.projection_version,
        source.projection,
        source.projection_sha256,
        objects.storage_key,
        objects.byte_size,
        objects.sha256
      from mail_raw_sources source
      join messages on messages.id = source.message_id and messages.org_id = source.org_id
      join objects on objects.id = source.object_id and objects.org_id = source.org_id
      join mail_message_deliveries mailbox
        on mailbox.message_id = messages.id
       and mailbox.org_id = source.org_id
       and mailbox.actor_id = ${input.actorId}
      where source.org_id = ${input.orgId}
        and source.message_id = ${input.messageId}
        and objects.kind = 'mail_source'
        and objects.deleted_at is null
      limit 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const storage = (await this.options.storageResolver?.({ orgId: input.orgId }))?.client;
    if (storage === undefined) {
      throw new Error("Tenant storage is required for inbound mail evidence.");
    }
    const object = await storage.get(row.storage_key);
    if (object === null || object.key !== row.storage_key) {
      throw new MailRawSourceIntegrityError();
    }
    const bytes = await boundedStorageBody(object.body, row.byte_size);
    const source: MailRawSourceRecord = {
      messageId: row.message_id,
      bytes,
      byteSize: row.byte_size,
      sha256: row.sha256,
      parser: row.parser,
      projectionVersion: row.projection_version,
      projection: row.projection,
      projectionSha256: row.projection_sha256,
    };
    await verifyMailRawSource(source);
    return source;
  }

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    if (input.idempotencyKey !== undefined && !/^.{1,512}$/u.test(input.idempotencyKey)) {
      throw new TypeError("idempotencyKey must contain 1 to 512 characters.");
    }
    const envelope = prepareOutboundEnvelope(input.envelope);
    const staged = await stageInlineAttachments(
      {
        orgId: input.orgId,
        actorId: input.actorId,
        from: envelope.from,
        to: envelope.to,
        cc: envelope.cc,
        bcc: envelope.bcc,
        subject: envelope.subject,
        bodyText: envelope.text,
        attachments: envelope.attachments,
      },
      this.options.attachmentIngestor,
    );
    try {
      const result = await this.sql.begin(async (tx) => {
        if (input.idempotencyKey !== undefined) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}:${input.idempotencyKey}`}, 0))`;
          const existing = await tx<MailOutboundRow[]>`
            select * from mail_outbound_messages
            where org_id = ${input.orgId} and idempotency_key = ${input.idempotencyKey}
            limit 1
          `;
          if (existing[0] !== undefined)
            return { outbound: mapOutbound(existing[0]), created: false };
        }
        const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc].map((recipient) =>
          normalizeAddress(recipient.address),
        );
        const suppressed =
          recipients.length === 0
            ? []
            : await tx<{ readonly address: string }[]>`
              select address from mail_suppressions
              where org_id = ${input.orgId} and removed_at is null and address in ${tx(recipients)}
            `;
        if (suppressed.length > 0) {
          throw new MailRecipientSuppressedError(suppressed.map((row) => row.address));
        }
        const message = await insertMailMessage(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          threadId: input.threadId,
          messageId: envelope.messageId,
          from: envelope.from,
          to: envelope.to,
          cc: envelope.cc,
          bcc: envelope.bcc,
          subject: envelope.subject,
          bodyText: envelope.text,
          ...(envelope.html === undefined ? {} : { bodyHtml: envelope.html }),
          ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
          ...(envelope.references === undefined ? {} : { references: envelope.references }),
          attachments: staged.input.attachments,
          metadata: { direction: "outbound" },
        });

        // Pre-generate the outbound id so the outbox payload is correct on first insert
        // (avoids a race where a worker picks up the outbox row before the follow-up UPDATE).
        const outboundId = randomUUID();

        const outboxRows = await tx<{ readonly id: string }[]>`
        insert into outbox (subject, payload, deliver_after)
        values (
          ${input.outboxSubject},
          ${tx.json(toSqlJson({ mailOutboundId: outboundId, orgId: input.orgId, actorId: input.actorId }))},
          ${input.undoUntil}
        )
        returning id
      `;
        const outboxId = outboxRows[0]?.id ?? null;

        const outboundRows = await tx<MailOutboundRow[]>`
        insert into mail_outbound_messages (
          id, org_id, actor_id, message_id, thread_id, outbox_id, status, envelope,
          undo_until, next_attempt_at, idempotency_key
        )
        values (
          ${outboundId},
          ${input.orgId},
          ${input.actorId},
          ${message.messageId},
          ${message.threadId},
          ${outboxId},
          'queued',
          ${tx.json(toSqlJson({ ...envelope, attachments: message.authoritativeAttachments }))},
          ${input.undoUntil},
          ${input.undoUntil},
          ${input.idempotencyKey ?? null}
        )
        returning *
      `;

        const outbound = mapOutbound(outboundRows[0]);
        return { outbound, created: true };
      });
      if (!result.created) {
        await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      }
      return result.outbound;
    } catch (error) {
      await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      throw error;
    }
  }

  async getOutbound(id: string): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      select * from mail_outbound_messages where id = ${id} limit 1
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async getOutboundDeliveryHealth(input: {
    readonly orgId: string;
    readonly since: Date;
  }): Promise<MailOutboundDeliveryHealth> {
    const rows = await this.sql<
      {
        readonly status: MailOutboundStatus;
        readonly count: number;
      }[]
    >`
      select status, count(*)::int as count
      from mail_outbound_messages
      where org_id = ${input.orgId}
        and created_at >= ${input.since}
      group by status
    `;
    const failures = await this.sql<
      {
        readonly failed_at: Date | null;
        readonly last_error: string | null;
      }[]
    >`
      select failed_at, last_error
      from mail_outbound_messages
      where org_id = ${input.orgId}
        and status = 'failed'
        and failed_at >= ${input.since}
      order by failed_at desc nulls last, updated_at desc
      limit 1
    `;
    const counts = outboundStatusCounts(rows);
    return {
      since: input.since.toISOString(),
      counts,
      failedLast24h: counts.failed,
      lastFailureAt: failures[0]?.failed_at?.toISOString() ?? null,
      lastError: failures[0]?.last_error ?? null,
    };
  }

  async claimDueOutbound(input: {
    readonly owner: string;
    readonly leaseMs: number;
    readonly now?: Date;
  }): Promise<ClaimedOutboundMail | null> {
    const claimedAt = input.now ?? new Date();
    const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseMs);
    const rows = await this.sql<MailOutboundRow[]>`
      with due as (
        select id
        from mail_outbound_messages
        where dead_lettered_at is null
          and (
            (status = 'queued' and next_attempt_at <= ${claimedAt})
            or (status = 'sending' and lease_expires_at <= ${claimedAt})
          )
        order by coalesce(next_attempt_at, lease_expires_at), created_at, id
        limit 1
        for update skip locked
      )
      update mail_outbound_messages outbound
      set
        status = 'sending',
        attempt_count = attempt_count + 1,
        next_attempt_at = null,
        lease_owner = ${input.owner},
        lease_token = gen_random_uuid(),
        lease_expires_at = ${leaseExpiresAt},
        updated_at = ${claimedAt}
      from due
      where outbound.id = due.id
      returning outbound.*
    `;
    const outbound = rows[0] === undefined ? null : mapOutbound(rows[0]);
    if (
      outbound === null ||
      outbound.handoffKey === undefined ||
      outbound.leaseOwner === null ||
      outbound.leaseOwner === undefined ||
      outbound.leaseToken === null ||
      outbound.leaseToken === undefined ||
      outbound.leaseExpiresAt === null ||
      outbound.leaseExpiresAt === undefined
    ) {
      return null;
    }
    return outbound as ClaimedOutboundMail;
  }

  async markOutboundSent(input: MarkOutboundSentInput): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'accepted',
        sent_at = ${input.sentAt ?? new Date()},
        last_error = null,
        provider_message_id = ${input.providerMessageId ?? null},
        delivery_metadata = ${this.sql.json(toSqlJson(input.deliveryMetadata ?? {}))},
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where id = ${input.id} and status = 'sending' and lease_token = ${input.leaseToken}
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set status = 'cancelled', cancelled_at = now(), updated_at = now()
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and id = ${input.id}
        and status = 'queued'
        and undo_until > now()
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundRetry(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'queued',
        next_attempt_at = ${input.nextAttemptAt},
        last_error = ${input.lastError},
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where id = ${input.id} and status = 'sending' and lease_token = ${input.leaseToken}
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundDeadLettered(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly lastError: string;
    readonly deadLetteredAt?: Date;
  }): Promise<MailOutboundRecord | null> {
    const deadAt = input.deadLetteredAt ?? new Date();
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'failed',
        failed_at = ${deadAt},
        dead_lettered_at = ${deadAt},
        last_error = ${input.lastError},
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where id = ${input.id} and status = 'sending' and lease_token = ${input.leaseToken}
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async replayOutbound(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'queued',
        attempt_count = 0,
        next_attempt_at = now(),
        dead_lettered_at = null,
        failed_at = null,
        last_error = null,
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id} and dead_lettered_at is not null
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async listDeadLetteredOutbound(
    orgId: string,
    limit = 100,
  ): Promise<readonly MailOutboundRecord[]> {
    const rows = await this.sql<MailOutboundRow[]>`
      select *
      from mail_outbound_messages
      where org_id = ${orgId} and dead_lettered_at is not null
      order by dead_lettered_at desc, id
      limit ${Math.min(Math.max(limit, 1), 500)}
    `;
    return rows.map(mapOutbound);
  }

  async updateThreadState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }): Promise<void> {
    const currentRows = await this.sql<{ readonly labels: readonly string[] }[]>`
      select labels from mail_thread_state
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and thread_id = ${input.threadId}
      limit 1
    `;
    const current = currentRows[0];
    if (current === undefined) {
      throw new MailThreadNotFoundError(input.threadId);
    }
    const currentLabels = current.labels;
    const labels = mergeLabels(
      currentLabels,
      input.patch.addLabels ?? [],
      input.patch.removeLabels ?? [],
    );
    const hasArchivedAtPatch = input.patch.archivedAt !== undefined;
    const archivedAtPatch = input.patch.archivedAt ?? null;
    const hasDeletedAtPatch = input.patch.deletedAt !== undefined;
    const deletedAtPatch = input.patch.deletedAt ?? null;
    const hasSnoozedUntilPatch = input.patch.snoozedUntil !== undefined;
    const snoozedUntilPatch = input.patch.snoozedUntil ?? null;
    const hasReadAtPatch = input.patch.readAt !== undefined;
    const readAtPatch = input.patch.readAt ?? null;
    const hasStarredPatch = input.patch.starred !== undefined;
    const starredPatch = input.patch.starred ?? false;
    const hasSpamAtPatch = input.patch.spamAt !== undefined;
    const spamAtPatch = input.patch.spamAt ?? null;

    await this.sql`
      update mail_thread_state
      set
        labels = ${this.sql.array([...labels])},
        archived_at = case
          when ${hasArchivedAtPatch} then ${archivedAtPatch}
          else mail_thread_state.archived_at
        end,
        deleted_at = case
          when ${hasDeletedAtPatch} then ${deletedAtPatch}
          else mail_thread_state.deleted_at
        end,
        snoozed_until = case
          when ${hasSnoozedUntilPatch} then ${snoozedUntilPatch}
          else mail_thread_state.snoozed_until
        end,
        read_at = case
          when ${hasReadAtPatch} then ${readAtPatch}
          else mail_thread_state.read_at
        end,
        starred = case
          when ${hasStarredPatch} then ${starredPatch}
          else mail_thread_state.starred
        end,
        spam_at = case
          when ${hasSpamAtPatch} then ${spamAtPatch}
          else mail_thread_state.spam_at
        end,
        updated_at = now()
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and thread_id = ${input.threadId}
    `;
  }

  async createFilter(input: CreateMailFilterInput): Promise<MailFilterRecord> {
    const rows = await this.sql<MailFilterRow[]>`
      insert into mail_filters (org_id, actor_id, name, enabled, priority, criteria, actions)
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.name},
        ${input.enabled ?? true},
        ${input.priority ?? 100},
        ${this.sql.json(toSqlJson(input.criteria))},
        ${this.sql.json(toSqlJson(input.actions))}
      )
      returning *
    `;
    return mapFilter(rows[0]);
  }

  async updateFilter(input: UpdateMailFilterInput): Promise<MailFilterRecord | null> {
    const currentRows = await this.sql<MailFilterRow[]>`
      select * from mail_filters
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.id} and deleted_at is null
      limit 1
    `;
    const current = currentRows[0];
    if (current === undefined) {
      return null;
    }

    const rows = await this.sql<MailFilterRow[]>`
      update mail_filters
      set
        name = ${input.patch.name ?? current.name},
        enabled = ${input.patch.enabled ?? current.enabled},
        priority = ${input.patch.priority ?? current.priority},
        criteria = ${this.sql.json(toSqlJson(input.patch.criteria ?? current.criteria))},
        actions = ${this.sql.json(toSqlJson(input.patch.actions ?? current.actions))},
        updated_at = now()
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.id} and deleted_at is null
      returning *
    `;
    return rows[0] === undefined ? null : mapFilter(rows[0]);
  }

  async deleteFilter(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<boolean> {
    const rows = await this.sql`
      update mail_filters
      set deleted_at = now(), enabled = false, updated_at = now()
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.id} and deleted_at is null
      returning id
    `;
    return rows.count > 0;
  }

  async listFilters(orgId: string, actorId: string): Promise<readonly MailFilterRecord[]> {
    const rows = await this.sql<MailFilterRow[]>`
      select * from mail_filters
      where org_id = ${orgId} and actor_id = ${actorId} and deleted_at is null
      order by priority asc, created_at asc
    `;
    return rows.map(mapFilter);
  }

  async getUserSettings(orgId: string, actorId: string): Promise<MailUserSettings> {
    const rows = await this.sql<MailUserSettingsRow[]>`
      select signature_text, signature_html, include_signature_on_replies,
        blocked_senders, updated_at
      from mail_user_settings
      where org_id = ${orgId} and actor_id = ${actorId}
    `;
    return rows[0] === undefined
      ? {
          signatureText: "",
          signatureHtml: null,
          includeSignatureOnReplies: true,
          blockedSenders: [],
          updatedAt: new Date(0),
        }
      : mapUserSettings(rows[0]);
  }

  async setUserSettings(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly signatureText: string;
    readonly signatureHtml: string | null;
    readonly includeSignatureOnReplies: boolean;
    readonly blockedSenders: readonly string[];
  }): Promise<MailUserSettings> {
    const blockedSenders = [...new Set(input.blockedSenders.map(normalizeAddress))].sort();
    const rows = await this.sql<MailUserSettingsRow[]>`
      insert into mail_user_settings (
        org_id, actor_id, signature_text, signature_html,
        include_signature_on_replies, blocked_senders
      ) values (
        ${input.orgId}, ${input.actorId}, ${input.signatureText}, ${input.signatureHtml},
        ${input.includeSignatureOnReplies}, ${blockedSenders}
      )
      on conflict (org_id, actor_id) do update set
        signature_text = excluded.signature_text,
        signature_html = excluded.signature_html,
        include_signature_on_replies = excluded.include_signature_on_replies,
        blocked_senders = excluded.blocked_senders,
        updated_at = now()
      returning signature_text, signature_html, include_signature_on_replies,
        blocked_senders, updated_at
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("Unable to save mail settings.");
    return mapUserSettings(row);
  }

  async getVacation(orgId: string, actorId: string): Promise<MailVacationRecord | null> {
    const rows = await this.sql<MailVacationRow[]>`
      select * from mail_vacation
      where org_id = ${orgId} and actor_id = ${actorId}
      limit 1
    `;
    return rows[0] === undefined ? null : mapVacation(rows[0]);
  }

  async setVacation(input: SetMailVacationInput): Promise<MailVacationRecord> {
    const rows = await this.sql<MailVacationRow[]>`
      insert into mail_vacation (
        org_id, actor_id, enabled, subject, body, starts_at, ends_at, metadata
      )
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.enabled},
        ${input.subject},
        ${input.body},
        ${input.startsAt},
        ${input.endsAt},
        ${this.sql.json(toSqlJson(input.metadata))}
      )
      on conflict (actor_id) do update
      set
        org_id = excluded.org_id,
        enabled = excluded.enabled,
        subject = excluded.subject,
        body = excluded.body,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        metadata = excluded.metadata,
        updated_at = now()
      returning *
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Unable to set mail vacation.");
    }
    return mapVacation(row);
  }

  async getActiveVacation(
    orgId: string,
    actorId: string,
    now: Date = new Date(),
  ): Promise<MailVacationRecord | null> {
    const rows = await this.sql<MailVacationRow[]>`
      select * from mail_vacation
      where org_id = ${orgId}
        and actor_id = ${actorId}
        and enabled = true
        and (starts_at is null or starts_at <= ${now})
        and (ends_at is null or ends_at >= ${now})
      limit 1
    `;
    return rows[0] === undefined ? null : mapVacation(rows[0]);
  }

  async hasVacationResponse(input: {
    readonly vacationId: string;
    readonly senderEmail: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      select exists(
        select 1 from mail_vacation_responses
        where vacation_id = ${input.vacationId} and lower(sender_email) = ${normalizeAddress(input.senderEmail)}
      ) as exists
    `;
    return rows[0]?.exists === true;
  }

  async recordVacationResponse(input: {
    readonly vacationId: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly senderEmail: string;
    readonly messageId?: string;
    readonly threadId?: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      insert into mail_vacation_responses (vacation_id, org_id, actor_id, sender_email, message_id, thread_id)
      values (
        ${input.vacationId},
        ${input.orgId},
        ${input.actorId},
        ${normalizeAddress(input.senderEmail)},
        ${input.messageId ?? null},
        ${input.threadId ?? null}
      )
      on conflict do nothing
      returning id
    `;
    return rows.length > 0;
  }

  async search(input: MailSearchRequest): Promise<readonly MailSearchHit[]> {
    const operators = parseMailSearchQuery(input.query ?? "");
    const query = escapeMailLike(operators.text);
    const from = escapeMailLike(operators.from ?? "");
    const labels = [...new Set([...(input.labels ?? []), ...operators.labels])];
    const hasAttachment = operators.hasAttachment ?? null;
    const rows = await this.sql<MailSearchRow[]>`
      select
        t.id as thread_id,
        m.id as message_id,
        t.subject,
        m.body,
        m.metadata,
        m.sent_at,
        mts.labels,
        mts.read_at,
        mts.starred,
        outbound.status as outbound_status,
        outbound.provider_message_id,
        outbound.delivery_metadata
      from messages m
      join threads t on t.id = m.thread_id
      join mail_thread_state mts
        on mts.thread_id = t.id
       and mts.actor_id = ${input.actorId}
       and mts.org_id = ${input.orgId}
      left join mail_outbound_messages outbound on outbound.message_id = m.id
      where m.org_id = ${input.orgId}
        and m.kind = 'mail'
        and m.deleted_at is null
        and coalesce(mts.deleted_at, t.archived_at) is null
        and (mts.snoozed_until is null or mts.snoozed_until <= now())
        and (${query} = '' or t.subject ilike ${`%${query}%`} or m.body ilike ${`%${query}%`})
        and (
          ${from} = ''
          or concat_ws(' ', m.metadata->'from'->>'name', m.metadata->'from'->>'address')
            ilike ${`%${from}%`}
        )
        and (
          cardinality(${this.sql.array(labels)}::text[]) = 0
          or coalesce(mts.labels, '{}'::text[]) && ${this.sql.array(labels)}::text[]
        )
        and (
          ${hasAttachment}::boolean is null
          or exists(select 1 from message_attachments ma where ma.message_id = m.id) = ${hasAttachment}
        )
      order by m.sent_at desc
      limit ${input.limit ?? 50}
    `;
    return rows.map(mapSearchHit);
  }

  async getMailSearchRecord(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailSearchRecord | null> {
    const rows = await this.sql<MailSearchRecordRow[]>`
      select
        m.org_id,
        m.thread_id,
        m.id as message_id,
        t.subject,
        m.body,
        m.metadata,
        m.sent_at,
        m.updated_at,
        mailbox.actor_id,
        mailbox.labels
      from messages m
      join threads t on t.id = m.thread_id
      join mail_thread_state mailbox
        on mailbox.thread_id = m.thread_id
       and mailbox.actor_id = ${input.actorId}
       and mailbox.org_id = ${input.orgId}
      where m.id = ${input.messageId}
        and m.org_id = ${input.orgId}
        and m.kind = 'mail'
        and m.deleted_at is null
        and mailbox.deleted_at is null
      limit 1
    `;
    return rows[0] === undefined ? null : mapMailSearchRecord(rows[0]);
  }

  /** Trusted reindex path: project the canonical message once for every owning mailbox. */
  async getMailSearchRecordsForIndexing(input: {
    readonly messageId: string;
    readonly orgId?: string | undefined;
  }): Promise<readonly MailSearchRecord[]> {
    const rows = await this.sql<MailSearchRecordRow[]>`
      select
        m.org_id,
        m.thread_id,
        m.id as message_id,
        t.subject,
        m.body,
        m.metadata,
        m.sent_at,
        m.updated_at,
        mailbox.actor_id,
        mailbox.labels
      from messages m
      join threads t on t.id = m.thread_id
      join mail_thread_state mailbox
        on mailbox.thread_id = m.thread_id
       and mailbox.org_id = m.org_id
      where m.id = ${input.messageId}
        and (${input.orgId ?? null}::uuid is null or m.org_id = ${input.orgId ?? null}::uuid)
        and m.kind = 'mail'
        and m.deleted_at is null
        and mailbox.deleted_at is null
      order by mailbox.actor_id
    `;
    return rows.map(mapMailSearchRecord);
  }

  getMailEnrichmentRecord(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly messageId: string;
  }): Promise<MailEnrichmentRecord | null> {
    return this.getMailSearchRecord(input);
  }

  async recordMailEnrichment(input: MailEnrichmentWrite): Promise<void> {
    await this.sql`
      update messages
      set
        metadata = jsonb_set(
          metadata,
          '{enrichments}',
          coalesce(metadata->'enrichments', '{}'::jsonb) ||
            jsonb_build_object(${input.feature}::text, ${this.sql.json(toSqlJson(input.data))}::jsonb),
          true
        ),
        updated_at = now()
      where id = ${input.messageId}
        and org_id = ${input.orgId}
        and exists (
          select 1 from mail_thread_state mailbox
          where mailbox.thread_id = messages.thread_id
            and mailbox.actor_id = ${input.actorId}
            and mailbox.org_id = ${input.orgId}
            and mailbox.deleted_at is null
        )
        and kind = 'mail'
    `;
  }

  async setMailClassification(input: MailClassificationWrite): Promise<void> {
    await this.sql`
      update messages
      set
        metadata = metadata || ${this.sql.json(
          toSqlJson({
            classification: input.classification,
            classificationSource: {
              source: input.source,
              reason: input.reason,
            },
          }),
        )}::jsonb,
        updated_at = now()
      where id = ${input.messageId}
        and org_id = ${input.orgId}
        and exists (
          select 1 from mail_thread_state mailbox
          where mailbox.thread_id = messages.thread_id
            and mailbox.actor_id = ${input.actorId}
            and mailbox.org_id = ${input.orgId}
            and mailbox.deleted_at is null
        )
        and kind = 'mail'
    `;
  }

  async getThread(input: MailThreadGetRequest): Promise<MailThreadDetail | null> {
    const rows = await this.sql<MailThreadRow[]>`
      select
        t.id as thread_id,
        t.subject,
        t.archived_at as thread_archived_at,
        mts.labels,
        mts.archived_at,
        mts.deleted_at,
        mts.snoozed_until,
        mts.read_at,
        mts.starred,
        m.id as message_id,
        m.body,
        m.body_format,
        m.metadata,
        m.sent_at,
        exists(select 1 from message_attachments ma where ma.message_id = m.id) as has_attachment,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'objectId', o.id::text,
                'filename', o.metadata->>'filename',
                'contentId', o.metadata->>'contentId',
                'mimeType', o.mime_type,
                'byteSize', o.byte_size,
                'sha256', o.sha256,
                'disposition', ma.disposition
              )
              order by o.created_at asc, o.id asc
            )
            from message_attachments ma
            join objects o on o.id = ma.object_id
            where ma.message_id = m.id
              and o.deleted_at is null
          ),
          '[]'::jsonb
        ) as attachments
      from threads t
      join messages m on m.thread_id = t.id
      join mail_thread_state mts
        on mts.thread_id = t.id
       and mts.actor_id = ${input.actorId}
       and mts.org_id = ${input.orgId}
      where t.org_id = ${input.orgId}
        and t.kind = 'mail'
        and t.id = ${input.threadId}
        and m.kind = 'mail'
        and m.deleted_at is null
      order by m.sent_at asc
    `;

    return rows.length === 0 ? null : mapThreadDetail(rows);
  }

  async listThreads(input: MailThreadListRequest): Promise<MailThreadListResult> {
    const folder: MailFolderId = input.folder ?? "inbox";
    const limit = clampLimit(input.limit, 50);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const now = input.now ?? new Date();
    const rawQuery = (input.query ?? "").trim();
    const operators = parseMailSearchQuery(rawQuery);
    // Escape LIKE metacharacters in user-supplied query so '%' / '_' are matched
    // literally (S8). Falls back to the FTS-backed search indexer for richer queries.
    const query = escapeMailLike(operators.text);
    const from = escapeMailLike(operators.from ?? "");
    const labels = [
      ...new Set([...(input.label === undefined ? [] : [input.label]), ...operators.labels]),
    ];
    const hasAttachment = operators.hasAttachment ?? null;
    // The tab filter only applies inside the inbox view; other folders are not
    // category-bucketed.
    const tab = folder === "inbox" ? (input.tab ?? null) : null;

    // True drafts live in mail_drafts (A2.1). Queued outbound (undo window) still
    // surfaces here until sent/cancelled so the Drafts folder is never empty of
    // in-progress compose work.
    if (folder === "drafts") {
      return this.listDraftFolderThreads({
        orgId: input.orgId,
        actorId: input.actorId,
        query: operators.text,
        ...(operators.from === undefined ? {} : { from: operators.from }),
        labels,
        ...(operators.hasAttachment === undefined
          ? {}
          : { hasAttachment: operators.hasAttachment }),
        limit,
        offset,
      });
    }

    const rows = await this.sql<MailThreadListRow[]>`
      with latest as (
        select distinct on (m.thread_id)
          m.thread_id,
          m.id as message_id,
          m.body,
          m.body_format,
          m.metadata,
          m.sent_at,
          t.subject,
          t.archived_at as thread_archived_at,
          mts.labels,
          mts.archived_at,
          mts.deleted_at,
          mts.snoozed_until,
          mts.read_at,
          mts.starred,
          mts.spam_at,
          mts.category,
          (
            select count(*)::int from messages mm
            where mm.thread_id = m.thread_id and mm.kind = 'mail' and mm.deleted_at is null
          ) as message_count,
          exists(
            select 1 from message_attachments ma
            join messages mm on mm.id = ma.message_id
            where mm.thread_id = m.thread_id
          ) as has_attachment,
          (
            select max((mo.metadata->>'direction'))
            from messages mo
            where mo.thread_id = m.thread_id and mo.kind = 'mail' and mo.deleted_at is null
              and mo.metadata->>'direction' = 'outbound'
          ) as has_outbound,
          (
            select ob.status from mail_outbound_messages ob
            where ob.thread_id = m.thread_id
            order by ob.created_at desc
            limit 1
          ) as outbound_status
        from messages m
        join threads t on t.id = m.thread_id
        join mail_thread_state mts
          on mts.thread_id = m.thread_id
         and mts.actor_id = ${input.actorId}
         and mts.org_id = ${input.orgId}
        where m.org_id = ${input.orgId}
          and m.kind = 'mail'
          and m.deleted_at is null
          and t.kind = 'mail'
        order by m.thread_id, m.sent_at desc, m.id desc
      ),
      filtered as (
        select * from latest
        where
          case ${folder}::text
            when 'trash' then deleted_at is not null
            when 'spam' then deleted_at is null and spam_at is not null
            when 'archive' then deleted_at is null and spam_at is null
              and coalesce(archived_at, thread_archived_at) is not null
            when 'starred' then deleted_at is null and starred is true
            when 'snoozed' then deleted_at is null
              and snoozed_until is not null and snoozed_until > ${now}
            when 'sent' then deleted_at is null and has_outbound = 'outbound'
            when 'drafts' then deleted_at is null and outbound_status = 'queued'
            else /* inbox */ deleted_at is null
              and spam_at is null
              and coalesce(archived_at, thread_archived_at) is null
              and (snoozed_until is null or snoozed_until <= ${now})
              and (has_outbound is null or has_outbound <> 'outbound')
          end
          and (${tab}::text is null or coalesce(category, 'primary') = ${tab})
          and (
            cardinality(${this.sql.array(labels)}::text[]) = 0
            or coalesce(labels, '{}'::text[]) @> ${this.sql.array(labels)}::text[]
          )
          and (
            ${from} = ''
            or concat_ws(' ', metadata->'from'->>'name', metadata->'from'->>'address')
              ilike ${`%${from}%`}
          )
          and (${hasAttachment}::boolean is null or has_attachment = ${hasAttachment})
          and (
            ${query} = ''
            or subject ilike ${`%${query}%`}
            or body ilike ${`%${query}%`}
          )
      )
      select
        thread_id, subject, message_id, body, metadata, sent_at,
        message_count, has_attachment, labels, read_at, starred, category,
        snoozed_until, outbound_status,
        0::int as total
      from filtered
      order by sent_at desc
      limit ${limit} offset ${offset}
    `;

    // Compute total via a separate aggregate query so the count is correct even
    // when the current page is empty (e.g. offset beyond the result set) (S6).
    const totalRows = await this.sql<{ readonly total: number }[]>`
      with latest as (
        select distinct on (m.thread_id)
          m.thread_id,
          m.metadata,
          m.sent_at,
          t.archived_at as thread_archived_at,
          mts.labels,
          mts.archived_at,
          mts.deleted_at,
          mts.snoozed_until,
          mts.read_at,
          mts.starred,
          mts.spam_at,
          mts.category,
          t.subject,
          m.body,
          exists(
            select 1 from message_attachments ma
            join messages mm on mm.id = ma.message_id
            where mm.thread_id = m.thread_id
          ) as has_attachment,
          (
            select max((mo.metadata->>'direction'))
            from messages mo
            where mo.thread_id = m.thread_id and mo.kind = 'mail' and mo.deleted_at is null
              and mo.metadata->>'direction' = 'outbound'
          ) as has_outbound,
          (
            select ob.status from mail_outbound_messages ob
            where ob.thread_id = m.thread_id
            order by ob.created_at desc
            limit 1
          ) as outbound_status
        from messages m
        join threads t on t.id = m.thread_id
        join mail_thread_state mts
          on mts.thread_id = m.thread_id
         and mts.actor_id = ${input.actorId}
         and mts.org_id = ${input.orgId}
        where m.org_id = ${input.orgId}
          and m.kind = 'mail'
          and m.deleted_at is null
          and t.kind = 'mail'
        order by m.thread_id, m.sent_at desc, m.id desc
      )
      select count(*)::int as total from latest
      where
        case ${folder}::text
          when 'trash' then deleted_at is not null
          when 'spam' then deleted_at is null and spam_at is not null
          when 'archive' then deleted_at is null and spam_at is null
            and coalesce(archived_at, thread_archived_at) is not null
          when 'starred' then deleted_at is null and starred is true
          when 'snoozed' then deleted_at is null
            and snoozed_until is not null and snoozed_until > ${now}
          when 'sent' then deleted_at is null and has_outbound = 'outbound'
          when 'drafts' then deleted_at is null and outbound_status = 'queued'
          else /* inbox */ deleted_at is null
            and spam_at is null
            and coalesce(archived_at, thread_archived_at) is null
            and (snoozed_until is null or snoozed_until <= ${now})
            and (has_outbound is null or has_outbound <> 'outbound')
        end
        and (${tab}::text is null or coalesce(category, 'primary') = ${tab})
        and (
          cardinality(${this.sql.array(labels)}::text[]) = 0
          or coalesce(labels, '{}'::text[]) @> ${this.sql.array(labels)}::text[]
        )
        and (
          ${from} = ''
          or concat_ws(' ', metadata->'from'->>'name', metadata->'from'->>'address')
            ilike ${`%${from}%`}
        )
        and (${hasAttachment}::boolean is null or has_attachment = ${hasAttachment})
        and (
          ${query} = ''
          or subject ilike ${`%${query}%`}
          or body ilike ${`%${query}%`}
        )
    `;

    return {
      threads: rows.map((row) => mapThreadRow(row, folder)),
      total: totalRows[0]?.total ?? 0,
      limit,
      offset,
    };
  }

  async listFolders(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly now?: Date | undefined;
  }): Promise<readonly MailFolderSummary[]> {
    const now = input.now ?? new Date();
    const rows = await this.sql<MailFolderCountRow[]>`
      with latest as (
        select distinct on (m.thread_id)
          m.thread_id,
          m.metadata,
          m.sent_at,
          t.archived_at as thread_archived_at,
          mts.archived_at,
          mts.deleted_at,
          mts.snoozed_until,
          mts.read_at,
          mts.starred,
          mts.spam_at,
          (
            select bool_or(mo.metadata->>'direction' = 'outbound')
            from messages mo
            where mo.thread_id = m.thread_id and mo.kind = 'mail' and mo.deleted_at is null
          ) as has_outbound,
          (
            select ob.status from mail_outbound_messages ob
            where ob.thread_id = m.thread_id
            order by ob.created_at desc
            limit 1
          ) as outbound_status
        from messages m
        join threads t on t.id = m.thread_id
        join mail_thread_state mts
          on mts.thread_id = m.thread_id
         and mts.actor_id = ${input.actorId}
         and mts.org_id = ${input.orgId}
        where m.org_id = ${input.orgId}
          and m.kind = 'mail'
          and m.deleted_at is null
          and t.kind = 'mail'
        order by m.thread_id, m.sent_at desc, m.id desc
      ),
      classified as (
        select
          unnest(folders) as folder,
          (read_at is null or read_at < sent_at) as unread
        from latest,
        lateral (
          select array_remove(array[
            case when deleted_at is null
              and spam_at is null
              and coalesce(archived_at, thread_archived_at) is null
              and (snoozed_until is null or snoozed_until <= ${now})
              and (has_outbound is not true) then 'inbox' end,
            case when deleted_at is null and starred is true then 'starred' end,
            case when deleted_at is null and snoozed_until is not null
              and snoozed_until > ${now} then 'snoozed' end,
            case when deleted_at is null and has_outbound is true then 'sent' end,
            -- Queued outbound still contributes to Drafts totals (undo window).
            case when deleted_at is null and outbound_status = 'queued' then 'drafts' end,
            case when deleted_at is null and spam_at is null
              and coalesce(archived_at, thread_archived_at) is not null then 'archive' end,
            case when deleted_at is null and spam_at is not null then 'spam' end,
            case when deleted_at is not null then 'trash' end
          ], null) as folders
        ) f
      )
      select folder, count(*)::int as total, count(*) filter (where unread)::int as unread
      from classified
      group by folder
    `;

    // First-class mail_drafts rows are not message-backed; fold their count into Drafts.
    const draftCountRows = await this.sql<{ readonly total: number }[]>`
      select count(*)::int as total
      from mail_drafts
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
    `;
    const trueDraftTotal = draftCountRows[0]?.total ?? 0;

    const byFolder = new Map(rows.map((row) => [row.folder, row]));
    return MAIL_FOLDER_IDS.map((id) => {
      const row = byFolder.get(id);
      const baseTotal = row?.total ?? 0;
      const total = id === "drafts" ? baseTotal + trueDraftTotal : baseTotal;
      return {
        id,
        label: MAIL_FOLDER_LABELS[id],
        total,
        unread: row?.unread ?? 0,
      };
    });
  }

  async listLabels(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailLabelRecord[]> {
    const rows = await this.sql<MailLabelRow[]>`
      select
        l.id,
        l.org_id,
        l.owner_actor_id,
        l.slug,
        l.name,
        l.color,
        l.sort_order,
        l.created_at,
        l.updated_at,
        coalesce((
          select count(*)::int
          from mail_thread_state mts
          where mts.actor_id = ${input.actorId}
            and mts.org_id = ${input.orgId}
            and mts.deleted_at is null
            and l.slug = any(mts.labels)
        ), 0) as thread_count
      from mail_labels l
      where l.org_id = ${input.orgId}
        and l.deleted_at is null
        and (l.owner_actor_id is null or l.owner_actor_id = ${input.actorId})
      order by l.sort_order asc, lower(l.name) asc
    `;
    return rows.map(mapLabel);
  }

  async saveDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id?: string;
    readonly threadId?: string | null;
    readonly envelope: JsonObject;
    readonly expectedRevision?: number;
    readonly idempotencyKey: string;
    readonly attachmentObjectIds: readonly string[];
  }): Promise<MailDraftRecord> {
    return this.sql.begin(async (tx) => {
      const replay = await tx<MailDraftRow[]>`
        select * from mail_drafts
        where org_id = ${input.orgId} and actor_id = ${input.actorId}
          and idempotency_key = ${input.idempotencyKey}
        limit 1
      `;
      if (replay[0] !== undefined) return mapDraft(replay[0]);

      if (input.attachmentObjectIds.length > 0) {
        const authorized = await tx<{ readonly id: string }[]>`
          select object.id from objects object
          where object.org_id = ${input.orgId}
            and object.id = any(${tx.array([...input.attachmentObjectIds])}::uuid[])
            and object.owner_actor_id = ${input.actorId}
            and object.deleted_at is null
            and coalesce(object.metadata->>'status', 'ready') = 'ready'
        `;
        if (authorized.length !== new Set(input.attachmentObjectIds).size) {
          throw new Error("A draft attachment is unavailable or inaccessible.");
        }
      }

      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
      let row: MailDraftRow | undefined;
      if (input.id !== undefined && input.expectedRevision !== undefined) {
        const updated = await tx<MailDraftRow[]>`
          update mail_drafts set
            thread_id = ${input.threadId ?? null}, envelope = ${tx.json(toSqlJson(input.envelope))},
            attachment_object_ids = ${tx.array([...input.attachmentObjectIds])}::uuid[],
            revision = revision + 1, idempotency_key = ${input.idempotencyKey},
            expires_at = ${expiresAt}, updated_at = now()
          where id = ${input.id} and org_id = ${input.orgId} and actor_id = ${input.actorId}
            and revision = ${input.expectedRevision}
          returning *
        `;
        row = updated[0];
        if (row === undefined) throw new MailDraftConflictError();
      } else {
        const inserted = await tx<MailDraftRow[]>`
          insert into mail_drafts (
            org_id, actor_id, thread_id, envelope, attachment_object_ids, idempotency_key, expires_at
          ) values (
            ${input.orgId}, ${input.actorId}, ${input.threadId ?? null},
            ${tx.json(toSqlJson(input.envelope))},
            ${tx.array([...input.attachmentObjectIds])}::uuid[], ${input.idempotencyKey}, ${expiresAt}
          ) returning *
        `;
        row = inserted[0];
        if (row === undefined) throw new Error("Failed to save mail draft.");
      }

      if (input.attachmentObjectIds.length > 0) {
        await tx`
          update mail_attachment_ingestions set expires_at = greatest(expires_at, ${expiresAt}),
            updated_at = now()
          where org_id = ${input.orgId} and owner_actor_id = ${input.actorId}
            and object_id = any(${tx.array([...input.attachmentObjectIds])}::uuid[])
            and status = 'clean' and cleaned_at is null
        `;
      }
      return mapDraft(row);
    });
  }

  async getDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailDraftRecord | null> {
    const rows = await this.sql<MailDraftRow[]>`
      select * from mail_drafts
      where id = ${input.id}
        and org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      limit 1
    `;
    return rows[0] === undefined ? null : mapDraft(rows[0]);
  }

  async listDrafts(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailDraftRecord[]> {
    const rows = await this.sql<MailDraftRow[]>`
      select * from mail_drafts
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      order by updated_at desc
    `;
    return rows.map(mapDraft);
  }

  /**
   * Drafts folder projection: first-class `mail_drafts` rows plus queued
   * outbound (undo-send window). Pure message-backed SQL cannot see drafts
   * that were never sent.
   */
  private async listDraftFolderThreads(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query: string;
    readonly from?: string;
    readonly labels: readonly string[];
    readonly hasAttachment?: boolean;
    readonly limit: number;
    readonly offset: number;
  }): Promise<MailThreadListResult> {
    const drafts = await this.listDrafts({
      orgId: input.orgId,
      actorId: input.actorId,
    });
    const draftRows: MailThreadRowRecord[] = drafts.map((draft) => {
      const envelope = draft.envelope as {
        readonly subject?: string;
        readonly text?: string;
        readonly html?: string;
        readonly to?: readonly { readonly address?: string; readonly name?: string }[];
        readonly attachments?: readonly unknown[];
      };
      const to = envelope.to?.[0];
      const subject = envelope.subject ?? "(no subject)";
      const preview = (envelope.text ?? envelope.html ?? "").slice(0, 240);
      return {
        threadId: draft.threadId ?? draft.id,
        messageId: draft.id,
        subject,
        from: "Draft",
        fromEmail: to?.address ?? "",
        preview,
        time: draft.updatedAt.toISOString(),
        unread: false,
        starred: false,
        hasAttachment: (envelope.attachments?.length ?? 0) > 0,
        messageCount: 0,
        labels: [],
        category: "primary",
        folder: "drafts",
        snoozedUntil: null,
      };
    });

    // Queued outbound still appears under Drafts until delivered/cancelled.
    const queuedRows = await this.sql<
      {
        readonly thread_id: string;
        readonly message_id: string;
        readonly subject: string;
        readonly from_email: string;
        readonly body: string;
        readonly has_attachment: boolean;
        readonly sent_at: Date;
      }[]
    >`
      select
        coalesce(ob.thread_id, ob.id) as thread_id,
        coalesce(ob.message_id, ob.id) as message_id,
        coalesce(ob.envelope->>'subject', '(no subject)') as subject,
        coalesce(ob.envelope->'to'->0->>'address', '') as from_email,
        coalesce(ob.envelope->>'text', '') as body,
        jsonb_array_length(coalesce(ob.envelope->'attachments', '[]'::jsonb)) > 0 as has_attachment,
        ob.updated_at as sent_at
      from mail_outbound_messages ob
      where ob.org_id = ${input.orgId}
        and ob.actor_id = ${input.actorId}
        and ob.status = 'queued'
      order by ob.updated_at desc
    `;

    const outboundRows: MailThreadRowRecord[] = queuedRows.map((row) => ({
      threadId: row.thread_id,
      messageId: row.message_id,
      subject: row.subject,
      from: "Outbox",
      fromEmail: row.from_email,
      preview: row.body.slice(0, 240),
      time: row.sent_at.toISOString(),
      unread: false,
      starred: false,
      hasAttachment: row.has_attachment,
      messageCount: 1,
      labels: [],
      category: "primary",
      folder: "drafts",
      snoozedUntil: null,
    }));

    const q = input.query.trim().toLowerCase();
    const merged = [...draftRows, ...outboundRows]
      .filter((row) => {
        const matchesText =
          q.length === 0 ||
          row.subject.toLowerCase().includes(q) ||
          row.preview.toLowerCase().includes(q);
        const matchesFrom =
          input.from === undefined ||
          row.fromEmail.toLowerCase().includes(input.from.toLowerCase());
        const matchesLabels = input.labels.every((label) => row.labels.includes(label));
        const matchesAttachment =
          input.hasAttachment === undefined || row.hasAttachment === input.hasAttachment;
        return matchesText && matchesFrom && matchesLabels && matchesAttachment;
      })
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

    const total = merged.length;
    const threads = merged.slice(input.offset, input.offset + input.limit);
    return { threads, total, limit: input.limit, offset: input.offset };
  }

  async discardDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      delete from mail_drafts
      where id = ${input.id}
        and org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      returning id
    `;
    return rows[0] !== undefined;
  }

  async listAliases(orgId: string, actorId?: string): Promise<readonly MailAliasRecord[]> {
    const rows =
      actorId === undefined
        ? await this.sql<MailAliasRow[]>`
            select * from mail_aliases
            where org_id = ${orgId}
              and disabled_at is null
            order by is_primary desc, lower(email) asc
          `
        : await this.sql<MailAliasRow[]>`
            select * from mail_aliases
            where org_id = ${orgId}
              and actor_id = ${actorId}
              and disabled_at is null
            order by is_primary desc, lower(email) asc
          `;
    return rows.map(mapAlias);
  }

  async createAlias(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly email: string;
    readonly displayName?: string | null;
    readonly isPrimary?: boolean;
    readonly receiveEnabled?: boolean;
    readonly sendAsEnabled?: boolean;
  }): Promise<MailAliasRecord> {
    const rows = await this.sql<MailAliasRow[]>`
      insert into mail_aliases (
        org_id, actor_id, email, display_name, is_primary, enabled,
        receive_enabled, send_as_enabled
      )
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.email},
        ${input.displayName ?? null},
        ${input.isPrimary ?? false},
        true,
        ${input.receiveEnabled ?? true},
        ${input.sendAsEnabled ?? true}
      )
      returning *
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to create mail alias.");
    }
    return mapAlias(row);
  }

  async deleteAlias(input: { readonly orgId: string; readonly id: string }): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      update mail_aliases
      set disabled_at = now(), enabled = false, updated_at = now()
      where id = ${input.id}
        and org_id = ${input.orgId}
        and disabled_at is null
      returning id
    `;
    return rows[0] !== undefined;
  }
}

interface MailDraftRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly thread_id: string | null;
  readonly envelope: JsonObject;
  readonly revision: string | number;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MailAliasRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly is_primary: boolean;
  readonly receive_enabled: boolean;
  readonly send_as_enabled: boolean;
  readonly created_at: Date;
}

function mapDraft(row: MailDraftRow): MailDraftRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    threadId: row.thread_id,
    envelope: row.envelope,
    revision: Number(row.revision),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MailDraftConflictError extends Error {
  constructor() {
    super("This draft changed elsewhere. Reload it before saving again.");
    this.name = "MailDraftConflictError";
  }
}

function mapAlias(row: MailAliasRow): MailAliasRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    email: row.email,
    displayName: row.display_name,
    isPrimary: row.is_primary,
    receiveEnabled: row.receive_enabled,
    sendAsEnabled: row.send_as_enabled,
    createdAt: row.created_at,
  };
}

function mapMailboxDelegate(row: MailboxDelegateRow | undefined): MailboxDelegateRecord {
  if (row === undefined) {
    throw new Error("Unable to persist mailbox delegate.");
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    validFrom: row.valid_from,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

const MAIL_FOLDER_LABELS: Readonly<Record<MailFolderId, string>> = {
  inbox: "Inbox",
  starred: "Starred",
  snoozed: "Snoozed",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash",
};

type SqlLike = postgres.Sql | postgres.TransactionSql;

async function lockMailIdentities(
  sql: SqlLike,
  orgId: string,
  identityKeys: readonly string[],
): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtextextended(identity_key, 0))
    from (
      select unnest(${sql.array(identityKeys.map((key) => `${orgId}:${key}`))}::text[]) as identity_key
      order by identity_key
    ) ordered_identities
  `;
}

async function findInboundIdentity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly normalizedMessageId: string | null;
    readonly rawSha256: string | null;
    readonly providerDeliveryId: string | null;
  },
): Promise<readonly MailIdentityRow[]> {
  return sql<MailIdentityRow[]>`
    select
      identity.message_id,
      messages.thread_id,
      identity.raw_sha256,
      identity.provider_delivery_id,
      coalesce(
        array_agg(attachments.object_id::text) filter (where attachments.object_id is not null),
        array[]::text[]
      ) as attachment_object_ids
    from mail_message_identities identity
    join messages
      on messages.id = identity.message_id
     and messages.org_id = identity.org_id
     and messages.kind = 'mail'
    left join message_attachments attachments on attachments.message_id = messages.id
    where identity.org_id = ${input.orgId}
      and (
        identity.normalized_message_id = ${input.normalizedMessageId ?? ""}
        or identity.raw_sha256 = ${input.rawSha256 ?? ""}
        or identity.provider_delivery_id = ${input.providerDeliveryId ?? ""}
      )
    group by
      identity.message_id,
      messages.thread_id,
      identity.raw_sha256,
      identity.provider_delivery_id
    order by identity.message_id
  `;
}

function resolveCanonicalIdentity(
  rows: readonly MailIdentityRow[],
  rawSha256: string | null,
  providerDeliveryId: string | null,
): MailIdentityRow {
  const canonical = rows[0];
  if (
    canonical === undefined ||
    rows.some((row) => row.message_id !== canonical.message_id) ||
    !(
      (rawSha256 !== null && canonical.raw_sha256 === rawSha256) ||
      (providerDeliveryId !== null && canonical.provider_delivery_id === providerDeliveryId)
    )
  ) {
    throw new Error("Inbound mail identity collision.");
  }
  return canonical;
}

async function findReferencedThread(
  sql: SqlLike,
  input: MailMessageInput,
): Promise<string | undefined> {
  if (input.threadId !== undefined) {
    return input.threadId;
  }
  const references = threadReferenceIds(input);
  const mailboxActorIds = mailMailboxActorIds(input);
  if (references.length === 0 || mailboxActorIds.length === 0) {
    return undefined;
  }
  const rows = await sql<{ readonly thread_id: string }[]>`
    select messages.thread_id
    from mail_message_identities identity
    join messages
      on messages.id = identity.message_id
     and messages.org_id = identity.org_id
     and messages.kind = 'mail'
    where identity.org_id = ${input.orgId}
      and identity.normalized_message_id = any(${sql.array([...references])}::text[])
      and (
        select count(*)
        from mail_thread_state mailbox
        where mailbox.org_id = ${input.orgId}
          and mailbox.thread_id = messages.thread_id
          and mailbox.actor_id = any(${sql.array([...mailboxActorIds])}::uuid[])
      ) = ${mailboxActorIds.length}
    order by
      array_position(${sql.array([...references])}::text[], identity.normalized_message_id),
      messages.sent_at desc,
      messages.id
    limit 1
  `;
  return rows[0]?.thread_id;
}

async function deliverInboundMessage(
  sql: SqlLike,
  input: {
    readonly input: MailMessageInput;
    readonly threadId: string;
    readonly messageId: string;
  },
): Promise<readonly string[]> {
  const actorIds = mailMailboxActorIds(input.input);
  if (actorIds.length === 0) {
    throw new Error("Mail requires at least one mailbox owner.");
  }
  const rows = await sql<{ readonly actor_id: string }[]>`
    insert into mail_message_deliveries (org_id, message_id, actor_id)
    select ${input.input.orgId}, ${input.messageId}, actor_id
    from unnest(${sql.array([...actorIds])}::uuid[]) as actor_id
    on conflict (message_id, actor_id) do nothing
    returning actor_id
  `;
  const deliveredActorIds = rows.map((row) => row.actor_id);
  await writeMailboxStateAndEvents(sql, {
    input: input.input,
    threadId: input.threadId,
    messageId: input.messageId,
    actorIds: deliveredActorIds,
  });
  return deliveredActorIds;
}

async function writeMailboxStateAndEvents(
  sql: SqlLike,
  input: {
    readonly input: MailMessageInput;
    readonly threadId: string;
    readonly messageId: string;
    readonly actorIds: readonly string[];
  },
): Promise<void> {
  if (input.actorIds.length === 0) {
    return;
  }
  const category =
    input.input.metadata?.direction === "outbound"
      ? "primary"
      : classifyMailCategory({
          fromAddress: input.input.from.address,
          ...(input.input.from.name === undefined ? {} : { fromName: input.input.from.name }),
          subject: input.input.subject,
          hasListUnsubscribe: headerHasListUnsubscribe(input.input.metadata),
        });
  await sql`
    insert into mail_thread_state (actor_id, thread_id, org_id, category)
    select actor_id, ${input.threadId}, ${input.input.orgId}, ${category}
    from unnest(${sql.array([...input.actorIds])}::uuid[]) as actor_id
    on conflict (actor_id, thread_id) do update
    set category = excluded.category, updated_at = now()
  `;
  await sql`
    insert into outbox (subject, payload)
    select
      ${input.input.metadata?.direction === "outbound" ? "activity.mail.sent" : "activity.mail.received"},
      jsonb_build_object(
        'orgId', ${input.input.orgId}::text,
        'actorId', actor_id::text,
        'threadId', ${input.threadId}::text,
        'messageId', ${input.messageId}::text,
        'subject', ${input.input.subject}::text,
        'from', ${input.input.from.address}::text,
        'to', ${sql.json(toSqlJson(input.input.to.map((address) => address.address)))}::jsonb
      )
    from unnest(${sql.array([...input.actorIds])}::uuid[]) as actor_id
  `;
}

function mailMailboxActorIds(input: MailMessageInput): readonly string[] {
  return [
    ...new Set(
      input.mailboxActorIds ??
        (input.actorId === undefined || input.actorId === null ? [] : [input.actorId]),
    ),
  ];
}

async function stageInlineAttachments(
  input: MailMessageInput,
  ingestor: PostgresMailStoreOptions["attachmentIngestor"],
): Promise<{ readonly input: MailMessageInput; readonly stages: readonly StagedMailAttachment[] }> {
  const stages: StagedMailAttachment[] = [];
  try {
    const attachments = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.content === undefined) {
        attachments.push(attachment);
        continue;
      }
      if (ingestor === undefined) {
        throw new Error("Mail attachment ingestion is unavailable.");
      }
      const stage = await ingestor.stage({
        orgId: input.orgId,
        ...(input.actorId == null ? {} : { ownerActorId: input.actorId }),
        attachment: { ...attachment, content: attachment.content },
      });
      stages.push(stage);
      attachments.push(stage.attachment);
    }
    return {
      input: input.attachments === undefined ? input : { ...input, attachments },
      stages,
    };
  } catch (error) {
    await ingestor?.release(stages).catch(() => undefined);
    throw error;
  }
}

async function insertMailMessage(
  sql: SqlLike,
  input: MailMessageInput,
  sourceStorage?: TenantStorageClient,
): Promise<
  StoredMailMessage & { readonly authoritativeAttachments: readonly MailAttachmentInput[] }
> {
  const mailboxActorIds = mailMailboxActorIds(input);
  if (mailboxActorIds.length === 0) {
    throw new Error("Mail requires at least one mailbox owner.");
  }
  const authoritativeAttachments = await authorizeMailAttachments(sql, input);
  const normalizedMessageId = normalizeMessageId(input.messageId);
  const providerDeliveryId = normalizeProviderDeliveryId(input.providerDeliveryId);
  const normalizedReferences = [...threadReferenceIds({ references: input.references })].reverse();
  const normalizedInReplyTo = normalizeMessageId(input.inReplyTo);
  const threadRows =
    input.threadId === undefined
      ? await sql<{ readonly id: string }[]>`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (${input.orgId}, 'mail', ${input.subject}, ${input.actorId ?? null}, ${sql.json(toSqlJson({ messageId: normalizedMessageId }))})
        returning id
      `
      : await sql<{ readonly id: string }[]>`
        update threads
        set updated_at = now()
        where id = ${input.threadId} and org_id = ${input.orgId} and kind = 'mail'
        returning id
      `;
  const threadId = threadRows[0]?.id ?? input.threadId;
  if (threadId === undefined) {
    throw new Error("Unable to resolve mail thread.");
  }

  const metadata = {
    ...(input.metadata ?? {}),
    from: input.from,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    messageId: normalizedMessageId,
    inReplyTo: normalizedInReplyTo,
    references: normalizedReferences,
    ...(input.bodyHtml === undefined ? {} : { plainBody: input.bodyText }),
  } satisfies JsonObject;

  const messageRows = await sql<{ readonly id: string }[]>`
    with inserted_message as (
      insert into messages (org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
      values (
        ${input.orgId},
        ${threadId},
        ${input.actorId ?? null},
        'mail',
        ${input.bodyHtml ?? input.bodyText},
        ${input.bodyHtml === undefined ? "plain" : "html"},
        ${sql.json(toSqlJson(metadata))},
        ${input.receivedAt ?? new Date()}
      )
      returning id
    ), inserted_identity as (
      insert into mail_message_identities (
        message_id, org_id, normalized_message_id, raw_sha256, provider_delivery_id
      )
      select
        id,
        ${input.orgId},
        ${normalizedMessageId},
        ${input.rawSource?.sha256 ?? null},
        ${providerDeliveryId}
      from inserted_message
      where ${
        normalizedMessageId !== null || input.rawSource !== undefined || providerDeliveryId !== null
      }
      returning message_id
    )
    select id from inserted_message
  `;
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) {
    throw new Error("Unable to insert mail message.");
  }

  if (input.rawSource !== undefined) {
    if (sourceStorage === undefined) {
      throw new Error("Tenant storage is required for inbound mail evidence.");
    }
    await persistRawSource(sql, input.orgId, messageId, input.rawSource, sourceStorage);
  }

  const objectIds: string[] = [];
  for (const attachment of authoritativeAttachments) {
    const objectId = attachment.objectId;
    if (objectId === undefined) throw new Error("Authorized mail attachment lost its object ID.");
    await sql`
      insert into message_attachments (org_id, message_id, object_id, disposition)
      values (${input.orgId}, ${messageId}, ${objectId}, ${attachment.disposition ?? "attachment"})
    `;
    objectIds.push(objectId);
  }

  const deliveredActorIds =
    input.metadata?.direction === "inbound"
      ? await deliverInboundMessage(sql, { input, threadId, messageId })
      : mailboxActorIds;
  if (input.metadata?.direction !== "inbound") {
    await writeMailboxStateAndEvents(sql, {
      input,
      threadId,
      messageId,
      actorIds: mailboxActorIds,
    });
  }
  await sql`select helix_record_mail_journal(${input.orgId}, ${messageId})`;

  return {
    threadId,
    messageId,
    attachmentObjectIds: objectIds,
    created: true,
    deliveredActorIds,
    authoritativeAttachments,
  };
}

async function authorizeMailAttachments(
  sql: SqlLike,
  input: MailMessageInput,
): Promise<readonly MailAttachmentInput[]> {
  const attachments = input.attachments ?? [];
  if (attachments.length > MAIL_ATTACHMENT_MAX_FILES) {
    throw new MailAttachmentQuotaError("Mail has too many attachments.");
  }
  const objectIds = attachments.map((attachment) => {
    if (attachment.objectId === undefined || attachment.content !== undefined) {
      throw new Error(`Mail attachment ${attachment.filename ?? "unnamed"} was not staged.`);
    }
    return attachment.objectId;
  });
  if (new Set(objectIds).size !== objectIds.length) {
    throw new MailAttachmentQuotaError("The same attachment cannot be added more than once.");
  }
  if (objectIds.length === 0) return attachments;
  const rows = await sql<
    {
      readonly id: string;
      readonly byte_size: string | number;
      readonly mime_type: string;
    }[]
  >`
    select objects.id, objects.byte_size, objects.mime_type
    from objects
    where objects.id = any(${objectIds})
      and objects.org_id = ${input.orgId}
      and objects.kind in ('file', 'recording', 'mail_attachment')
      and objects.deleted_at is null
      and (
        (objects.kind = 'mail_attachment' and exists (
          select 1 from mail_attachment_ingestions stage
          where stage.org_id = ${input.orgId} and stage.object_id = objects.id
            and stage.status = 'clean' and stage.cleaned_at is null
            and stage.owner_actor_id is not distinct from ${input.actorId ?? null}
        ))
        or (objects.kind in ('file', 'recording')
          and coalesce(objects.metadata->>'status', 'ready') = 'ready'
          and (
            objects.owner_actor_id = ${input.actorId ?? null}
            or exists (
              select 1 from permissions p
              where p.org_id = ${input.orgId}
                and p.actor_id = ${input.actorId ?? null}
                and p.resource_type = 'object' and p.resource_id = objects.id
                and (p.expires_at is null or p.expires_at > now())
            )
          ))
      )
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  let totalBytes = 0;
  const normalized = attachments.map((attachment, index) => {
    const objectId = objectIds[index] as string;
    const row = byId.get(objectId);
    if (row === undefined) throw new Error(`Unknown or inaccessible mail attachment: ${objectId}`);
    const byteSize = mailAttachmentByteSize(row.byte_size);
    if (byteSize > MAIL_ATTACHMENT_MAX_FILE_BYTES) {
      throw new MailAttachmentQuotaError("A mail attachment exceeds the 25 MiB per-file limit.");
    }
    totalBytes += byteSize;
    return { ...attachment, mimeType: row.mime_type, contentType: row.mime_type };
  });
  if (totalBytes > MAIL_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new MailAttachmentQuotaError("Mail attachments exceed the 25 MiB message limit.");
  }
  return normalized;
}

function mailAttachmentByteSize(value: string | number): number {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("Mail attachment has invalid authoritative byte size.");
  }
  return bytes;
}

async function persistRawSource(
  sql: SqlLike,
  orgId: string,
  messageId: string,
  source: NonNullable<MailMessageInput["rawSource"]>,
  storage: TenantStorageClient,
): Promise<void> {
  const storageKey = `mail/sources/${messageId}/${source.sha256}.eml`;
  const objectRows = await sql<{ readonly id: string }[]>`
    insert into objects (
      org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata
    )
    values (
      ${orgId},
      null,
      'mail_source',
      ${storageKey},
      'message/rfc822',
      ${source.byteSize},
      ${source.sha256},
      ${sql.json(
        toSqlJson({
          messageId,
          parser: source.parser,
          projectionVersion: source.projectionVersion,
          projectionSha256: source.projectionSha256,
        }),
      )}
    )
    returning id
  `;
  const objectId = objectRows[0]?.id;
  if (objectId === undefined) {
    throw new Error("Unable to insert raw mail source object.");
  }
  await storage.put({
    key: storageKey,
    body: source.bytes,
    contentType: "message/rfc822",
    metadata: {
      objectId,
      messageId,
      sha256: source.sha256,
      parser: source.parser,
      projectionVersion: String(source.projectionVersion),
      projectionSha256: source.projectionSha256,
    },
  });
  await sql`
    insert into mail_raw_sources (
      message_id, org_id, object_id, parser, projection_version, projection, projection_sha256
    )
    values (
      ${messageId},
      ${orgId},
      ${objectId},
      ${source.parser},
      ${source.projectionVersion},
      ${sql.json(source.projection)},
      ${source.projectionSha256}
    )
  `;
}

async function boundedStorageBody(
  body: StorageObject["body"],
  expectedSize: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > MAIL_RAW_SOURCE_MAX_BYTES
  ) {
    throw new MailRawSourceIntegrityError();
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength !== expectedSize) {
      throw new MailRawSourceIntegrityError();
    }
    return Buffer.from(body);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > expectedSize) {
      throw new MailRawSourceIntegrityError();
    }
    chunks.push(chunk);
  }
  if (total !== expectedSize) {
    throw new MailRawSourceIntegrityError();
  }
  return Buffer.concat(chunks);
}

function mapFilter(row: MailFilterRow | undefined): MailFilterRecord {
  if (row === undefined) {
    throw new Error("Expected mail filter row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    criteria: row.criteria,
    actions: row.actions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVacation(row: MailVacationRow): MailVacationRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    enabled: row.enabled,
    subject: row.subject,
    body: row.body,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUserSettings(row: MailUserSettingsRow): MailUserSettings {
  return {
    signatureText: row.signature_text,
    signatureHtml: row.signature_html,
    includeSignatureOnReplies: row.include_signature_on_replies,
    blockedSenders: row.blocked_senders,
    updatedAt: row.updated_at,
  };
}

function mapOutbound(row: MailOutboundRow | undefined): MailOutboundRecord {
  if (row === undefined) {
    throw new Error("Expected mail outbound row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    outboxId: row.outbox_id,
    status: row.status,
    envelope: row.envelope,
    undoUntil: row.undo_until,
    sentAt: row.sent_at,
    cancelledAt: row.cancelled_at,
    failedAt: row.failed_at,
    lastError: row.last_error,
    providerMessageId: row.provider_message_id,
    deliveryMetadata: row.delivery_metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attemptCount: row.attempt_count ?? 0,
    nextAttemptAt: row.next_attempt_at ?? null,
    deadLetteredAt: row.dead_lettered_at ?? null,
    ...(row.handoff_key === undefined ? {} : { handoffKey: row.handoff_key }),
    leaseOwner: row.lease_owner ?? null,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
  };
}

function outboundStatusCounts(
  rows: readonly {
    readonly status: MailOutboundStatus;
    readonly count: number;
  }[],
): Readonly<Record<MailOutboundStatus, number>> {
  const counts: Record<MailOutboundStatus, number> = {
    queued: 0,
    cancelled: 0,
    sending: 0,
    accepted: 0,
    delivered: 0,
    deferred: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

function mapSearchHit(row: MailSearchRow): MailSearchHit {
  const from = row.metadata.from as MailSearchHit["from"] | undefined;
  return {
    threadId: row.thread_id,
    messageId: row.message_id,
    subject: row.subject ?? "",
    ...(from === undefined ? {} : { from }),
    preview: row.body.slice(0, 240),
    sentAt: row.sent_at,
    labels: row.labels ?? [],
    unread: row.read_at === null || row.read_at < row.sent_at,
    starred: row.starred ?? false,
    ...(row.outbound_status === null ? {} : { outboundStatus: row.outbound_status }),
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
    ...(row.delivery_metadata === null ? {} : { deliveryMetadata: row.delivery_metadata }),
  };
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

function mapThreadRow(row: MailThreadListRow, folder: MailFolderId): MailThreadRowRecord {
  const from = mailAddress(row.metadata.from);
  const fromAddress = from?.address ?? "";
  // A category may be missing on legacy threads — derive it on the fly so the
  // tab filter and the row payload are always populated.
  const category =
    row.category === null
      ? classifyMailCategory({
          fromAddress,
          ...(from?.name === undefined ? {} : { fromName: from.name }),
          subject: row.subject ?? "",
        })
      : coerceMailCategory(row.category);
  return {
    threadId: row.thread_id,
    messageId: row.message_id,
    subject: row.subject ?? "",
    from: from?.name ?? fromAddress,
    fromEmail: fromAddress,
    preview: row.body.slice(0, 240),
    time: row.sent_at.toISOString(),
    unread: row.read_at === null || row.read_at < row.sent_at,
    starred: row.starred ?? false,
    hasAttachment: row.has_attachment,
    messageCount: row.message_count,
    labels: row.labels ?? [],
    category,
    folder,
    snoozedUntil: row.snoozed_until?.toISOString() ?? null,
  };
}

function mapLabel(row: MailLabelRow): MailLabelRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    threadCount: row.thread_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMailSearchRecord(row: MailSearchRecordRow): MailSearchRecord {
  const cc = mailAddressArray(row.metadata.cc);
  const bcc = mailAddressArray(row.metadata.bcc);
  const classification = mailClassification(sensitivityClassificationFromMetadata(row.metadata));
  return {
    id: row.message_id,
    orgId: row.org_id,
    threadId: row.thread_id,
    subject: row.subject ?? stringMetadata(row.metadata.subject),
    body: row.body,
    from: mailAddress(row.metadata.from) ?? { address: "" },
    to: mailAddressArray(row.metadata.to),
    ...(cc.length === 0 ? {} : { cc }),
    ...(bcc.length === 0 ? {} : { bcc }),
    labels: row.labels ?? [],
    direction: mailDirection(row.metadata.direction),
    ...(classification === undefined ? {} : { classification }),
    sentAt: row.sent_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    metadata: row.metadata,
    ownerActorId: row.actor_id,
  };
}

function mapThreadDetail(rows: readonly MailThreadRow[]): MailThreadDetail {
  const first = rows[0];
  if (first === undefined) {
    throw new Error("Expected mail thread rows.");
  }

  const messages = rows.map(mapThreadMessage);
  const participants = uniqueAddresses(
    messages.flatMap((message) => [
      ...(message.from === undefined ? [] : [message.from]),
      ...message.to,
      ...message.cc,
      ...message.bcc,
    ]),
  );
  const directions = new Set(
    rows
      .map((row) =>
        typeof row.metadata.direction === "string" ? row.metadata.direction : undefined,
      )
      .filter(
        (direction): direction is "inbound" | "outbound" =>
          direction === "inbound" || direction === "outbound",
      ),
  );
  const last = messages[messages.length - 1];
  const onlyDirection = directions.values().next().value;
  const lastActivity = last?.sentAt ?? first.thread_archived_at ?? new Date(0);

  return {
    id: first.thread_id,
    subject: first.subject ?? "",
    preview: last?.body.slice(0, 240) ?? "",
    participants,
    messages,
    labels: first.labels ?? [],
    archivedAt: first.archived_at ?? first.thread_archived_at,
    deletedAt: first.deleted_at,
    snoozedUntil: first.snoozed_until,
    lastActivity,
    unread: first.read_at === null || first.read_at < lastActivity,
    starred: first.starred ?? false,
    direction: directions.size === 1 && onlyDirection !== undefined ? onlyDirection : "mixed",
  };
}

function mapThreadMessage(row: MailThreadRow): MailThreadMessage {
  return {
    id: row.message_id,
    from: mailAddress(row.metadata.from),
    to: mailAddressArray(row.metadata.to),
    cc: mailAddressArray(row.metadata.cc),
    bcc: mailAddressArray(row.metadata.bcc),
    sentAt: row.sent_at,
    body: row.body,
    bodyFormat: row.body_format === "html" ? "html" : "plain",
    ...(typeof row.metadata.plainBody === "string" ? { plainBody: row.metadata.plainBody } : {}),
    hasAttachment: row.has_attachment,
    attachments: mailThreadAttachments(row.attachments),
  };
}

function mailThreadAttachments(
  attachments: readonly MailThreadAttachmentRow[] | null,
): MailThreadMessage["attachments"] {
  if (attachments === null) {
    return [];
  }
  const parsed: MailThreadAttachment[] = [];
  for (const attachment of attachments) {
    if (
      typeof attachment.objectId !== "string" ||
      typeof attachment.mimeType !== "string" ||
      typeof attachment.byteSize !== "number"
    ) {
      continue;
    }
    parsed.push({
      objectId: attachment.objectId,
      ...(typeof attachment.filename === "string" ? { filename: attachment.filename } : {}),
      ...(typeof attachment.contentId === "string" ? { contentId: attachment.contentId } : {}),
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      ...(typeof attachment.sha256 === "string" ? { sha256: attachment.sha256 } : {}),
      disposition:
        typeof attachment.disposition === "string" ? attachment.disposition : "attachment",
    });
  }
  return parsed;
}

function mailAddress(value: unknown): MailThreadMessage["from"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.address === "string"
    ? {
        address: record.address,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
      }
    : undefined;
}

function mailAddressArray(value: unknown): readonly NonNullable<MailThreadMessage["from"]>[] {
  return Array.isArray(value)
    ? value
        .map(mailAddress)
        .filter(
          (address): address is NonNullable<MailThreadMessage["from"]> => address !== undefined,
        )
    : [];
}

function uniqueAddresses(addresses: readonly NonNullable<MailThreadMessage["from"]>[]) {
  const byAddress = new Map<string, NonNullable<MailThreadMessage["from"]>>();
  for (const address of addresses) {
    byAddress.set(address.address.toLowerCase(), address);
  }
  return [...byAddress.values()];
}

function mergeLabels(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): readonly string[] {
  const labels = new Set(current);
  for (const label of add) {
    labels.add(label);
  }
  for (const label of remove) {
    labels.delete(label);
  }
  return [...labels].sort((left, right) => left.localeCompare(right));
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function emailDomain(address: string): string | null {
  const separator = address.lastIndexOf("@");
  return separator > 0 && separator < address.length - 1 ? address.slice(separator + 1) : null;
}

function stringMetadata(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mailDirection(value: unknown): MailSearchRecord["direction"] {
  return value === "outbound" ? "outbound" : "inbound";
}

function mailClassification(value: unknown): MailSearchRecord["classification"] {
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? value
    : undefined;
}

/**
 * Escape LIKE/ILIKE metacharacters so user-supplied search terms are matched
 * literally. The default backslash escape character is used.
 */
function escapeMailLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export interface ParsedMailSearchQuery {
  readonly text: string;
  readonly from?: string;
  readonly labels: readonly string[];
  readonly hasAttachment?: boolean;
}

/** Parse only the bounded operators advertised by the Mail search UI. */
export function parseMailSearchQuery(raw: string): ParsedMailSearchQuery {
  let from: string | undefined;
  let hasAttachment: boolean | undefined;
  const labels: string[] = [];
  const text = raw
    .replace(
      /(^|\s)(from|label|has):(?:"([^"]{1,320})"|([^\s"]{1,320}))/giu,
      (match, prefix: string, rawOperator: string, quoted?: string, bare?: string) => {
        const operator = rawOperator.toLowerCase();
        const value = (quoted ?? bare ?? "").trim();
        const normalizedValue = value.toLowerCase();
        if (
          operator === "has" &&
          normalizedValue !== "attachment" &&
          normalizedValue !== "noattachment"
        ) {
          return match;
        }
        if (operator === "from") from = value;
        if (operator === "label") labels.push(value);
        if (operator === "has") hasAttachment = normalizedValue === "attachment";
        return prefix;
      },
    )
    .trim()
    .replace(/\s+/gu, " ");
  return {
    text,
    ...(from === undefined ? {} : { from }),
    labels: [...new Set(labels)],
    ...(hasAttachment === undefined ? {} : { hasAttachment }),
  };
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

/**
 * True when a message's metadata carries a `List-Unsubscribe` signal. The
 * ingest pipeline may surface this either as an explicit boolean flag or under
 * a parsed-headers map; absence is treated as "no signal".
 */
function headerHasListUnsubscribe(metadata: JsonObject | undefined): boolean {
  if (metadata === undefined) {
    return false;
  }
  if (metadata.hasListUnsubscribe === true || metadata.listUnsubscribe != null) {
    return true;
  }
  const headers = metadata.headers;
  if (headers !== null && typeof headers === "object" && !Array.isArray(headers)) {
    const record = headers as Record<string, unknown>;
    return Object.keys(record).some((key) => key.toLowerCase() === "list-unsubscribe");
  }
  return false;
}
