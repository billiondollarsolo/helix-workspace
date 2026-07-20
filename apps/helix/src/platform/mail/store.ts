import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import type { MailOutboundDeliveryHealth } from "./admin-config.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
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
  MailLabelRecord,
  MailMessageInput,
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
  StoredMailMessage,
} from "./types.js";
import { MAIL_FOLDER_IDS } from "./types.js";
import { classifyMailCategory, coerceMailCategory } from "./category.js";
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

export interface CreateOutboundMailInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly threadId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly envelope: MailOutboundEnvelope;
  readonly undoUntil: Date;
  readonly outboxSubject: string;
}

export type MarkOutboundSentInput = MailOutboundDeliveryResult & {
  readonly id: string;
  readonly sentAt?: Date | undefined;
};

export interface MailStore {
  findActorByAddress(
    orgId: string,
    address: string,
  ): Promise<{ readonly actorId: string; readonly email: string } | null>;
  insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage>;
  createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord>;
  getOutbound(id: string): Promise<MailOutboundRecord | null>;
  markOutboundSending(id: string): Promise<MailOutboundRecord | null>;
  markOutboundSent(input: MarkOutboundSentInput): Promise<MailOutboundRecord | null>;
  markOutboundFailed(
    id: string,
    error: string,
    failedAt?: Date,
  ): Promise<MailOutboundRecord | null>;
  cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null>;
  markOutboundRetry?(input: {
    readonly id: string;
    readonly attemptCount: number;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
  }): Promise<MailOutboundRecord | null>;
  markOutboundDeadLettered?(input: {
    readonly id: string;
    readonly lastError: string;
    readonly deadLetteredAt?: Date;
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
  }): Promise<MailAliasRecord>;
  deleteAlias?(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<boolean>;
}

export interface PostgresMailStoreOptions {
  readonly storageResolver?: TenantStorageResolver | undefined;
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

interface MailOutboundRow {
  readonly id: string;
  readonly org_id: string;
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
  readonly actor_id: string | null;
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

export class PostgresMailStore
  implements MailStore, MailSearchProjectionStore, MailEnrichmentProjectionStore
{
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresMailStoreOptions = {},
  ) {}

  async findActorByAddress(
    orgId: string,
    address: string,
  ): Promise<{ readonly actorId: string; readonly email: string } | null> {
    const rows = (await this.sql`
      select id, email
      from actors
      where org_id = ${orgId}
        and disabled_at is null
        and lower(email) = ${normalizeAddress(address)}
      union all
      select actor_id as id, email
      from mail_aliases
      where org_id = ${orgId}
        and enabled = true
        and disabled_at is null
        and lower(email) = ${normalizeAddress(address)}
      limit 1
    `) as unknown as readonly { readonly id: string; readonly email: string }[];
    return rows[0] === undefined ? null : { actorId: rows[0].id, email: rows[0].email };
  }

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    return this.sql.begin(async (tx) => insertMailMessage(tx, input, this.options));
  }

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    return this.sql.begin(async (tx) => {
      const message = await insertMailMessage(
        tx,
        {
          orgId: input.orgId,
          actorId: input.actorId,
          threadId: input.threadId,
          from: input.envelope.from,
          to: input.envelope.to,
          cc: input.envelope.cc,
          bcc: input.envelope.bcc,
          subject: input.envelope.subject,
          bodyText: input.envelope.text,
          ...(input.envelope.html === undefined ? {} : { bodyHtml: input.envelope.html }),
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          ...(input.references === undefined ? {} : { references: input.references }),
          attachments: input.envelope.attachments,
          metadata: { direction: "outbound" },
        },
        this.options,
      );

      // Pre-generate the outbound id so the outbox payload is correct on first insert
      // (avoids a race where a worker picks up the outbox row before the follow-up UPDATE).
      const outboundId = randomUUID();

      const outboxRows = (await tx`
        insert into outbox (subject, payload, deliver_after)
        values (
          ${input.outboxSubject},
          ${tx.json(toSqlJson({ mailOutboundId: outboundId, orgId: input.orgId, actorId: input.actorId }))},
          ${input.undoUntil}
        )
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const outboxId = outboxRows[0]?.id ?? null;

      const outboundRows = (await tx`
        insert into mail_outbound_messages (
          id, org_id, actor_id, message_id, thread_id, outbox_id, status, envelope, undo_until
        )
        values (
          ${outboundId},
          ${input.orgId},
          ${input.actorId},
          ${message.messageId},
          ${message.threadId},
          ${outboxId},
          'queued',
          ${tx.json(toSqlJson(input.envelope))},
          ${input.undoUntil}
        )
        returning *
      `) as unknown as readonly MailOutboundRow[];

      const outbound = mapOutbound(outboundRows[0]);
      return outbound;
    });
  }

  async getOutbound(id: string): Promise<MailOutboundRecord | null> {
    const rows = (await this.sql`
      select * from mail_outbound_messages where id = ${id} limit 1
    `) as unknown as readonly MailOutboundRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async getOutboundDeliveryHealth(input: {
    readonly orgId: string;
    readonly since: Date;
  }): Promise<MailOutboundDeliveryHealth> {
    const rows = (await this.sql`
      select status, count(*)::int as count
      from mail_outbound_messages
      where org_id = ${input.orgId}
        and created_at >= ${input.since}
      group by status
    `) as unknown as readonly {
      readonly status: MailOutboundStatus;
      readonly count: number;
    }[];
    const failures = (await this.sql`
      select failed_at, last_error
      from mail_outbound_messages
      where org_id = ${input.orgId}
        and status = 'failed'
        and failed_at >= ${input.since}
      order by failed_at desc nulls last, updated_at desc
      limit 1
    `) as unknown as readonly {
      readonly failed_at: Date | null;
      readonly last_error: string | null;
    }[];
    const counts = outboundStatusCounts(rows);
    return {
      since: input.since.toISOString(),
      counts,
      failedLast24h: counts.failed,
      lastFailureAt: failures[0]?.failed_at?.toISOString() ?? null,
      lastError: failures[0]?.last_error ?? null,
    };
  }

  async markOutboundSending(id: string): Promise<MailOutboundRecord | null> {
    const rows = (await this.sql`
      update mail_outbound_messages
      set status = 'sending', updated_at = now()
      where id = ${id} and status = 'queued' and undo_until <= now()
      returning *
    `) as unknown as readonly MailOutboundRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundSent(input: MarkOutboundSentInput): Promise<MailOutboundRecord | null> {
    const rows = (await this.sql`
      update mail_outbound_messages
      set
        status = 'sent',
        sent_at = ${input.sentAt ?? new Date()},
        last_error = null,
        provider_message_id = ${input.providerMessageId ?? null},
        delivery_metadata = ${this.sql.json(toSqlJson(input.deliveryMetadata ?? {}))},
        updated_at = now()
      where id = ${input.id}
      returning *
    `) as unknown as readonly MailOutboundRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundFailed(
    id: string,
    error: string,
    failedAt: Date = new Date(),
  ): Promise<MailOutboundRecord | null> {
    const rows = (await this.sql`
      update mail_outbound_messages
      set status = 'failed', failed_at = ${failedAt}, last_error = ${error}, updated_at = now()
      where id = ${id}
      returning *
    `) as unknown as readonly MailOutboundRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = (await this.sql`
      update mail_outbound_messages
      set status = 'cancelled', cancelled_at = now(), updated_at = now()
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and id = ${input.id}
        and status = 'queued'
        and undo_until > now()
      returning *
    `) as unknown as readonly MailOutboundRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundRetry(input: {
    readonly id: string;
    readonly attemptCount: number;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = (await this.sql`
      update mail_outbound_messages
      set
        status = 'queued',
        attempt_count = ${input.attemptCount},
        next_attempt_at = ${input.nextAttemptAt},
        last_error = ${input.lastError},
        updated_at = now()
      where id = ${input.id}
      returning *
    `) as unknown as readonly MailOutboundRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundDeadLettered(input: {
    readonly id: string;
    readonly lastError: string;
    readonly deadLetteredAt?: Date;
  }): Promise<MailOutboundRecord | null> {
    const deadAt = input.deadLetteredAt ?? new Date();
    const rows = (await this.sql`
      update mail_outbound_messages
      set
        status = 'failed',
        failed_at = ${deadAt},
        dead_lettered_at = ${deadAt},
        last_error = ${input.lastError},
        updated_at = now()
      where id = ${input.id}
      returning *
    `) as unknown as readonly MailOutboundRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async updateThreadState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }): Promise<void> {
    const currentRows = (await this.sql`
      select labels from mail_thread_state
      where actor_id = ${input.actorId} and thread_id = ${input.threadId}
      limit 1
    `) as unknown as readonly { readonly labels: readonly string[] }[];
    const currentLabels = currentRows[0]?.labels ?? [];
    const labels = mergeLabels(
      currentLabels,
      input.patch.addLabels ?? [],
      input.patch.removeLabels ?? [],
    );
    const hasReadAtPatch = input.patch.readAt !== undefined;
    const readAtPatch = input.patch.readAt ?? null;
    const hasStarredPatch = input.patch.starred !== undefined;
    const starredPatch = input.patch.starred ?? false;
    const hasSpamAtPatch = input.patch.spamAt !== undefined;
    const spamAtPatch = input.patch.spamAt ?? null;

    await this.sql`
      insert into mail_thread_state (
        actor_id, thread_id, org_id, labels, archived_at, deleted_at, snoozed_until,
        read_at, starred, spam_at, updated_at
      )
      values (
        ${input.actorId},
        ${input.threadId},
        ${input.orgId},
        ${this.sql.array([...labels])},
        ${input.patch.archivedAt ?? null},
        ${input.patch.deletedAt ?? null},
        ${input.patch.snoozedUntil ?? null},
        ${readAtPatch},
        ${starredPatch},
        ${spamAtPatch},
        now()
      )
      on conflict (actor_id, thread_id) do update
      set
        labels = ${this.sql.array([...labels])},
        archived_at = coalesce(${input.patch.archivedAt ?? null}, mail_thread_state.archived_at),
        deleted_at = coalesce(${input.patch.deletedAt ?? null}, mail_thread_state.deleted_at),
        snoozed_until = coalesce(${input.patch.snoozedUntil ?? null}, mail_thread_state.snoozed_until),
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
    `;
  }

  async createFilter(input: CreateMailFilterInput): Promise<MailFilterRecord> {
    const rows = (await this.sql`
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
    `) as unknown as readonly MailFilterRow[];
    return mapFilter(rows[0]);
  }

  async updateFilter(input: UpdateMailFilterInput): Promise<MailFilterRecord | null> {
    const currentRows = (await this.sql`
      select * from mail_filters
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.id} and deleted_at is null
      limit 1
    `) as unknown as readonly MailFilterRow[];
    const current = currentRows[0];
    if (current === undefined) {
      return null;
    }

    const rows = (await this.sql`
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
    `) as unknown as readonly MailFilterRow[];
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
    const rows = (await this.sql`
      select * from mail_filters
      where org_id = ${orgId} and actor_id = ${actorId} and deleted_at is null
      order by priority asc, created_at asc
    `) as unknown as readonly MailFilterRow[];
    return rows.map(mapFilter);
  }

  async getVacation(orgId: string, actorId: string): Promise<MailVacationRecord | null> {
    const rows = (await this.sql`
      select * from mail_vacation
      where org_id = ${orgId} and actor_id = ${actorId}
      limit 1
    `) as unknown as readonly MailVacationRow[];
    return rows[0] === undefined ? null : mapVacation(rows[0]);
  }

  async setVacation(input: SetMailVacationInput): Promise<MailVacationRecord> {
    const rows = (await this.sql`
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
    `) as unknown as readonly MailVacationRow[];
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
    const rows = (await this.sql`
      select * from mail_vacation
      where org_id = ${orgId}
        and actor_id = ${actorId}
        and enabled = true
        and (starts_at is null or starts_at <= ${now})
        and (ends_at is null or ends_at >= ${now})
      limit 1
    `) as unknown as readonly MailVacationRow[];
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
    const rows = (await this.sql`
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
      left join mail_thread_state mts on mts.thread_id = t.id and mts.actor_id = ${input.actorId}
      left join mail_outbound_messages outbound on outbound.message_id = m.id
      where m.org_id = ${input.orgId}
        and m.kind = 'mail'
        and m.deleted_at is null
        and coalesce(mts.deleted_at, t.archived_at) is null
        and (mts.snoozed_until is null or mts.snoozed_until <= now())
        and (${input.query ?? ""} = '' or t.subject ilike ${`%${input.query ?? ""}%`} or m.body ilike ${`%${input.query ?? ""}%`})
      order by m.sent_at desc
      limit ${input.limit ?? 50}
    `) as unknown as readonly MailSearchRow[];
    const requestedLabels = new Set(input.labels ?? []);
    return rows
      .filter(
        (row) =>
          requestedLabels.size === 0 ||
          (row.labels ?? []).some((label) => requestedLabels.has(label)),
      )
      .map(mapSearchHit);
  }

  async getMailSearchRecord(messageId: string): Promise<MailSearchRecord | null> {
    const rows = (await this.sql`
      select
        m.org_id,
        m.thread_id,
        m.id as message_id,
        t.subject,
        m.body,
        m.metadata,
        m.sent_at,
        m.updated_at,
        m.actor_id,
        (
          select array_agg(distinct label order by label)
          from mail_thread_state mts
          cross join unnest(mts.labels) as label
          where mts.thread_id = m.thread_id
        ) as labels
      from messages m
      join threads t on t.id = m.thread_id
      where m.id = ${messageId}
        and m.kind = 'mail'
        and m.deleted_at is null
      limit 1
    `) as unknown as readonly MailSearchRecordRow[];
    return rows[0] === undefined ? null : mapMailSearchRecord(rows[0]);
  }

  getMailEnrichmentRecord(messageId: string): Promise<MailEnrichmentRecord | null> {
    return this.getMailSearchRecord(messageId);
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
        and kind = 'mail'
    `;
  }

  async getThread(input: MailThreadGetRequest): Promise<MailThreadDetail | null> {
    const rows = (await this.sql`
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
      left join mail_thread_state mts on mts.thread_id = t.id and mts.actor_id = ${input.actorId}
      where t.org_id = ${input.orgId}
        and t.kind = 'mail'
        and t.id = ${input.threadId}
        and m.kind = 'mail'
        and m.deleted_at is null
        and coalesce(mts.deleted_at, t.archived_at) is null
      order by m.sent_at asc
    `) as unknown as readonly MailThreadRow[];

    return rows.length === 0 ? null : mapThreadDetail(rows);
  }

  async listThreads(input: MailThreadListRequest): Promise<MailThreadListResult> {
    const folder: MailFolderId = input.folder ?? "inbox";
    const limit = clampLimit(input.limit, 50);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const now = input.now ?? new Date();
    const rawQuery = (input.query ?? "").trim();
    // Escape LIKE metacharacters in user-supplied query so '%' / '_' are matched
    // literally (S8). Falls back to the FTS-backed search indexer for richer queries.
    const query = escapeMailLike(rawQuery);
    const label = input.label ?? "";
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
        query: rawQuery,
        limit,
        offset,
      });
    }

    const rows = (await this.sql`
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
        left join mail_thread_state mts on mts.thread_id = m.thread_id and mts.actor_id = ${input.actorId}
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
          and (${label}::text = '' or ${label} = any(coalesce(labels, '{}'::text[])))
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
    `) as unknown as readonly MailThreadListRow[];

    // Compute total via a separate aggregate query so the count is correct even
    // when the current page is empty (e.g. offset beyond the result set) (S6).
    const totalRows = (await this.sql`
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
        left join mail_thread_state mts on mts.thread_id = m.thread_id and mts.actor_id = ${input.actorId}
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
        and (${label}::text = '' or ${label} = any(coalesce(labels, '{}'::text[])))
        and (
          ${query} = ''
          or subject ilike ${`%${query}%`}
          or body ilike ${`%${query}%`}
        )
    `) as unknown as readonly { readonly total: number }[];

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
    const rows = (await this.sql`
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
        left join mail_thread_state mts on mts.thread_id = m.thread_id and mts.actor_id = ${input.actorId}
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
    `) as unknown as readonly MailFolderCountRow[];

    // First-class mail_drafts rows are not message-backed; fold their count into Drafts.
    const draftCountRows = (await this.sql`
      select count(*)::int as total
      from mail_drafts
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
    `) as unknown as readonly { readonly total: number }[];
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
    const rows = (await this.sql`
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
    `) as unknown as readonly MailLabelRow[];
    return rows.map(mapLabel);
  }

  async saveDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id?: string;
    readonly threadId?: string | null;
    readonly envelope: JsonObject;
  }): Promise<MailDraftRecord> {
    if (input.id !== undefined) {
      const updated = (await this.sql`
        update mail_drafts
        set
          thread_id = ${input.threadId ?? null},
          envelope = ${this.sql.json(toSqlJson(input.envelope))},
          updated_at = now()
        where id = ${input.id}
          and org_id = ${input.orgId}
          and actor_id = ${input.actorId}
        returning *
      `) as unknown as readonly MailDraftRow[];
      if (updated[0] !== undefined) {
        return mapDraft(updated[0]);
      }
    }
    const rows = (await this.sql`
      insert into mail_drafts (org_id, actor_id, thread_id, envelope)
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.threadId ?? null},
        ${this.sql.json(toSqlJson(input.envelope))}
      )
      returning *
    `) as unknown as readonly MailDraftRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to save mail draft.");
    }
    return mapDraft(row);
  }

  async getDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailDraftRecord | null> {
    const rows = (await this.sql`
      select * from mail_drafts
      where id = ${input.id}
        and org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      limit 1
    `) as unknown as readonly MailDraftRow[];
    return rows[0] === undefined ? null : mapDraft(rows[0]);
  }

  async listDrafts(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailDraftRecord[]> {
    const rows = (await this.sql`
      select * from mail_drafts
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      order by updated_at desc
    `) as unknown as readonly MailDraftRow[];
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
        hasAttachment: false,
        messageCount: 0,
        labels: [],
        category: "primary",
        folder: "drafts",
        snoozedUntil: null,
      };
    });

    // Queued outbound still appears under Drafts until delivered/cancelled.
    const queuedRows = (await this.sql`
      select
        coalesce(ob.thread_id, ob.id) as thread_id,
        coalesce(ob.message_id, ob.id) as message_id,
        coalesce(ob.envelope->>'subject', '(no subject)') as subject,
        coalesce(ob.envelope->'to'->0->>'address', '') as from_email,
        coalesce(ob.envelope->>'text', '') as body,
        ob.updated_at as sent_at
      from mail_outbound_messages ob
      where ob.org_id = ${input.orgId}
        and ob.actor_id = ${input.actorId}
        and ob.status = 'queued'
      order by ob.updated_at desc
    `) as unknown as readonly {
      readonly thread_id: string;
      readonly message_id: string;
      readonly subject: string;
      readonly from_email: string;
      readonly body: string;
      readonly sent_at: Date;
    }[];

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
      hasAttachment: false,
      messageCount: 1,
      labels: [],
      category: "primary",
      folder: "drafts",
      snoozedUntil: null,
    }));

    const q = input.query.trim().toLowerCase();
    const merged = [...draftRows, ...outboundRows]
      .filter((row) => {
        if (q.length === 0) return true;
        return (
          row.subject.toLowerCase().includes(q) ||
          row.preview.toLowerCase().includes(q) ||
          row.fromEmail.toLowerCase().includes(q)
        );
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
    const rows = (await this.sql`
      delete from mail_drafts
      where id = ${input.id}
        and org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows[0] !== undefined;
  }

  async listAliases(orgId: string, actorId?: string): Promise<readonly MailAliasRecord[]> {
    const rows =
      actorId === undefined
        ? ((await this.sql`
            select * from mail_aliases
            where org_id = ${orgId}
              and disabled_at is null
            order by is_primary desc, lower(email) asc
          `) as unknown as readonly MailAliasRow[])
        : ((await this.sql`
            select * from mail_aliases
            where org_id = ${orgId}
              and actor_id = ${actorId}
              and disabled_at is null
            order by is_primary desc, lower(email) asc
          `) as unknown as readonly MailAliasRow[]);
    return rows.map(mapAlias);
  }

  async createAlias(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly email: string;
    readonly displayName?: string | null;
    readonly isPrimary?: boolean;
  }): Promise<MailAliasRecord> {
    const rows = (await this.sql`
      insert into mail_aliases (org_id, actor_id, email, display_name, is_primary, enabled)
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.email},
        ${input.displayName ?? null},
        ${input.isPrimary ?? false},
        true
      )
      returning *
    `) as unknown as readonly MailAliasRow[];
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to create mail alias.");
    }
    return mapAlias(row);
  }

  async deleteAlias(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<boolean> {
    const rows = (await this.sql`
      update mail_aliases
      set disabled_at = now(), enabled = false, updated_at = now()
      where id = ${input.id}
        and org_id = ${input.orgId}
        and disabled_at is null
      returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows[0] !== undefined;
  }
}

interface MailDraftRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly thread_id: string | null;
  readonly envelope: JsonObject;
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
  readonly created_at: Date;
}

function mapDraft(row: MailDraftRow): MailDraftRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    threadId: row.thread_id,
    envelope: row.envelope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAlias(row: MailAliasRow): MailAliasRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    email: row.email,
    displayName: row.display_name,
    isPrimary: row.is_primary,
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

async function insertMailMessage(
  sql: SqlLike,
  input: MailMessageInput,
  options: PostgresMailStoreOptions = {},
): Promise<StoredMailMessage> {
  const threadRows =
    input.threadId === undefined
      ? await sql`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (${input.orgId}, 'mail', ${input.subject}, ${input.actorId ?? null}, ${sql.json(toSqlJson({ messageId: input.messageId ?? null }))})
        returning id
      `
      : await sql`
        update threads
        set updated_at = now()
        where id = ${input.threadId} and org_id = ${input.orgId} and kind = 'mail'
        returning id
      `;
  const threadId =
    (threadRows as unknown as readonly { readonly id: string }[])[0]?.id ?? input.threadId;
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
    messageId: input.messageId ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? [],
  } satisfies JsonObject;

  const messageRows = (await sql`
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
  `) as unknown as readonly { readonly id: string }[];
  const messageId = messageRows[0]?.id;
  if (messageId === undefined) {
    throw new Error("Unable to insert mail message.");
  }

  const objectIds: string[] = [];
  const storage =
    input.attachments === undefined || input.attachments.length === 0
      ? undefined
      : (await options.storageResolver?.({ orgId: input.orgId }))?.client;
  for (const attachment of input.attachments ?? []) {
    const content = attachment.content;
    if (content === undefined) {
      throw new Error(
        `Mail attachment ${attachment.filename ?? "unnamed"} is missing content bytes.`,
      );
    }
    const storageKey = `mail/${messageId}/${attachment.filename ?? randomUUID()}`;
    const sha256 = createHash("sha256").update(content).digest("hex");
    const objectRows = (await sql`
      insert into objects (org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
      values (
        ${input.orgId},
        ${input.actorId ?? null},
        'mail_attachment',
        ${storageKey},
        ${attachment.mimeType},
        ${content.byteLength},
        ${sha256},
        ${sql.json(
          toSqlJson({
            filename: attachment.filename ?? null,
            contentId: attachment.contentId ?? null,
          }),
        )}
      )
      returning id
    `) as unknown as readonly { readonly id: string }[];
    const objectId = objectRows[0]?.id;
    if (objectId !== undefined) {
      await storage?.put({
        key: storageKey,
        body: content,
        contentType: attachment.mimeType,
        metadata: {
          objectId,
          messageId,
          sha256,
          ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
          ...(attachment.contentId === undefined ? {} : { contentId: attachment.contentId }),
          disposition: attachment.disposition ?? "attachment",
        },
      });
      objectIds.push(objectId);
      await sql`
        insert into message_attachments (message_id, object_id, disposition)
        values (${messageId}, ${objectId}, ${attachment.disposition ?? "attachment"})
        on conflict do nothing
      `;
    }
  }

  // Category-tab classification (Primary/Updates/Promotions/Social). Derived
  // on ingest for inbound mail addressed to a known actor and cached on the
  // per-actor thread-state row so the thread-list projection stays a single
  // indexed query. Best-effort: outbound mail and unrouted inbound mail are
  // left unclassified and fall through to Primary in the projection.
  if (input.metadata?.direction !== "outbound" && input.actorId != null) {
    const headerUnsubscribe = headerHasListUnsubscribe(input.metadata);
    const category = classifyMailCategory({
      fromAddress: input.from.address,
      ...(input.from.name === undefined ? {} : { fromName: input.from.name }),
      subject: input.subject,
      hasListUnsubscribe: headerUnsubscribe,
    });
    await sql`
      insert into mail_thread_state (actor_id, thread_id, org_id, category)
      values (${input.actorId}, ${threadId}, ${input.orgId}, ${category})
      on conflict (actor_id, thread_id) do update
      set category = excluded.category, updated_at = now()
    `;
  }

  await sql`
    insert into outbox (subject, payload)
    values (${input.metadata?.direction === "outbound" ? "activity.mail.sent" : "activity.mail.received"}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId ?? null,
        threadId,
        messageId,
        subject: input.subject,
        from: input.from.address,
        to: input.to.map((address) => address.address),
      }),
    )})
  `;

  return { threadId, messageId, attachmentObjectIds: objectIds };
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
    sending: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
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
  const classification = mailClassification(row.metadata.classification);
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
