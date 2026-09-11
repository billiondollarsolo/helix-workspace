import type postgres from "postgres";
import { MailThreadNotFoundError } from "./errors.js";
import type { MailDraftStore } from "./store-drafts.js";
import { clampLimit, escapeMailLike, parseMailSearchQuery } from "./store-search-query.js";
import {
  type MailThreadListRow,
  type MailThreadRow,
  mapThreadDetail,
  mapThreadRow,
} from "./store-thread-projection.js";
import type {
  MailFolderId,
  MailThreadDetail,
  MailThreadGetRequest,
  MailThreadListRequest,
  MailThreadListResult,
  MailThreadStatePatch,
} from "./types.js";

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
export class MailThreadStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly drafts: MailDraftStore,
  ) {}

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
    const hasHeldAtPatch = input.patch.heldAt !== undefined;
    const heldAtPatch = input.patch.heldAt ?? null;

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
        held_at = case
          when ${hasHeldAtPatch} then ${heldAtPatch}
          else mail_thread_state.held_at
        end,
        updated_at = now()
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and thread_id = ${input.threadId}
    `;
  }

  async getThread(input: MailThreadGetRequest): Promise<MailThreadDetail | null> {
    const rows = await this.sql<(MailThreadRow & { readonly held_at: Date | null })[]>`
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
        mts.held_at,
        m.id as message_id,
        m.body,
        m.body_format,
        case when helix_mailbox_sent_message(m.org_id, m.id, ${input.actorId}) then m.metadata else (m.metadata - 'bcc') || '{"direction":"inbound"}'::jsonb end as metadata,
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
        and (
          exists (
            select 1 from messages visible_message
            where visible_message.thread_id = t.id
              and visible_message.org_id = ${input.orgId}
              and visible_message.kind = 'mail'
              and visible_message.actor_id = ${input.actorId}
          )
          or exists (
            select 1
            from messages recipient_message
            join mail_message_deliveries visible_delivery
              on visible_delivery.message_id = recipient_message.id
              and visible_delivery.org_id = ${input.orgId}
              and visible_delivery.actor_id = ${input.actorId}
            where recipient_message.thread_id = t.id
              and recipient_message.org_id = ${input.orgId}
              and recipient_message.kind = 'mail'
          )
        )
        and m.kind = 'mail'
          and (m.actor_id = ${input.actorId} or exists (
            select 1 from mail_message_deliveries mailbox_delivery
            where mailbox_delivery.org_id = ${input.orgId}
              and mailbox_delivery.message_id = m.id and mailbox_delivery.actor_id = ${input.actorId}
          ))
        and m.deleted_at is null
      order by m.sent_at asc
    `;

    if (rows.length === 0) return null;
    if (input.excludeHeld === true && rows[0]?.held_at != null) return null;
    return mapThreadDetail(rows);
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
      return this.drafts.listDraftFolderThreads({
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
          case when helix_mailbox_sent_message(m.org_id, m.id, ${input.actorId}) then m.metadata else (m.metadata - 'bcc') || '{"direction":"inbound"}'::jsonb end as metadata,
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
          mts.held_at,
          mts.category,
          (
            select count(*)::int from messages mm
            where mm.thread_id = m.thread_id
              and (mm.actor_id = ${input.actorId} or exists (
                select 1 from mail_message_deliveries counted
                where counted.org_id = ${input.orgId} and counted.message_id = mm.id
                  and counted.actor_id = ${input.actorId}
              )) and mm.kind = 'mail' and mm.deleted_at is null
          ) as message_count,
          exists(
            select 1 from message_attachments ma
            join messages mm on mm.id = ma.message_id
            where mm.thread_id = m.thread_id
              and (mm.actor_id = ${input.actorId} or exists (
                select 1 from mail_message_deliveries counted
                where counted.org_id = ${input.orgId} and counted.message_id = mm.id
                  and counted.actor_id = ${input.actorId}
              ))
          ) as has_attachment,
          (
            select max((mo.metadata->>'direction'))
            from messages mo
            where mo.thread_id = m.thread_id and mo.kind = 'mail' and mo.deleted_at is null
              and helix_mailbox_sent_message(mo.org_id, mo.id, ${input.actorId})
              and mo.metadata->>'direction' = 'outbound'
          ) as has_outbound,
          exists (
            select 1 from mail_message_deliveries received
            join messages incoming on incoming.id = received.message_id and incoming.org_id = received.org_id
            where received.org_id = ${input.orgId} and received.actor_id = ${input.actorId}
              and received.received_at is not null and incoming.thread_id = m.thread_id
              and incoming.deleted_at is null
          ) as has_received,
          (
            select ob.status from mail_outbound_messages ob
            where ob.thread_id = m.thread_id and ob.actor_id = ${input.actorId}
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
          and (m.actor_id = ${input.actorId} or exists (
            select 1 from mail_message_deliveries mailbox_delivery
            where mailbox_delivery.org_id = ${input.orgId}
              and mailbox_delivery.message_id = m.id and mailbox_delivery.actor_id = ${input.actorId}
          ))
          and m.deleted_at is null
          and t.kind = 'mail'
          and (
            exists (
              select 1 from messages visible_message
              where visible_message.thread_id = t.id
                and visible_message.org_id = ${input.orgId}
                and visible_message.kind = 'mail'
                and visible_message.actor_id = ${input.actorId}
            )
            or exists (
              select 1
              from messages recipient_message
              join mail_message_deliveries visible_delivery
                on visible_delivery.message_id = recipient_message.id
                and visible_delivery.org_id = ${input.orgId}
                and visible_delivery.actor_id = ${input.actorId}
              where recipient_message.thread_id = t.id
                and recipient_message.org_id = ${input.orgId}
                and recipient_message.kind = 'mail'
            )
          )
        order by m.thread_id, m.sent_at desc, m.id desc
      ),
      filtered as (
        select * from latest
        where
          case ${folder}::text
            when 'trash' then deleted_at is not null
            when 'spam' then deleted_at is null and spam_at is not null
            when 'held' then deleted_at is null and spam_at is null and held_at is not null
            when 'archive' then deleted_at is null and spam_at is null and held_at is null
              and coalesce(archived_at, thread_archived_at) is not null
            when 'starred' then deleted_at is null and starred is true
            when 'snoozed' then deleted_at is null
              and snoozed_until is not null and snoozed_until > ${now}
            when 'sent' then deleted_at is null and has_outbound = 'outbound'
            when 'drafts' then deleted_at is null and outbound_status = 'queued'
            else /* inbox */ deleted_at is null
              and spam_at is null
              and held_at is null
              and coalesce(archived_at, thread_archived_at) is null
              and (snoozed_until is null or snoozed_until <= ${now})
              and has_received
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
          case when helix_mailbox_sent_message(m.org_id, m.id, ${input.actorId}) then m.metadata else (m.metadata - 'bcc') || '{"direction":"inbound"}'::jsonb end as metadata,
          m.sent_at,
          t.archived_at as thread_archived_at,
          mts.labels,
          mts.archived_at,
          mts.deleted_at,
          mts.snoozed_until,
          mts.read_at,
          mts.starred,
          mts.spam_at,
          mts.held_at,
          mts.category,
          t.subject,
          m.body,
          exists(
            select 1 from message_attachments ma
            join messages mm on mm.id = ma.message_id
            where mm.thread_id = m.thread_id
              and (mm.actor_id = ${input.actorId} or exists (
                select 1 from mail_message_deliveries counted
                where counted.org_id = ${input.orgId} and counted.message_id = mm.id
                  and counted.actor_id = ${input.actorId}
              ))
          ) as has_attachment,
          (
            select max((mo.metadata->>'direction'))
            from messages mo
            where mo.thread_id = m.thread_id and mo.kind = 'mail' and mo.deleted_at is null
              and helix_mailbox_sent_message(mo.org_id, mo.id, ${input.actorId})
              and mo.metadata->>'direction' = 'outbound'
          ) as has_outbound,
          exists (
            select 1 from mail_message_deliveries received
            join messages incoming on incoming.id = received.message_id and incoming.org_id = received.org_id
            where received.org_id = ${input.orgId} and received.actor_id = ${input.actorId}
              and received.received_at is not null and incoming.thread_id = m.thread_id
              and incoming.deleted_at is null
          ) as has_received,
          (
            select ob.status from mail_outbound_messages ob
            where ob.thread_id = m.thread_id and ob.actor_id = ${input.actorId}
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
          and (m.actor_id = ${input.actorId} or exists (
            select 1 from mail_message_deliveries mailbox_delivery
            where mailbox_delivery.org_id = ${input.orgId}
              and mailbox_delivery.message_id = m.id and mailbox_delivery.actor_id = ${input.actorId}
          ))
          and m.deleted_at is null
          and t.kind = 'mail'
          and (
            exists (
              select 1 from messages visible_message
              where visible_message.thread_id = t.id
                and visible_message.org_id = ${input.orgId}
                and visible_message.kind = 'mail'
                and visible_message.actor_id = ${input.actorId}
            )
            or exists (
              select 1
              from messages recipient_message
              join mail_message_deliveries visible_delivery
                on visible_delivery.message_id = recipient_message.id
                and visible_delivery.org_id = ${input.orgId}
                and visible_delivery.actor_id = ${input.actorId}
              where recipient_message.thread_id = t.id
                and recipient_message.org_id = ${input.orgId}
                and recipient_message.kind = 'mail'
            )
          )
        order by m.thread_id, m.sent_at desc, m.id desc
      )
      select count(*)::int as total from latest
      where
        case ${folder}::text
          when 'trash' then deleted_at is not null
          when 'spam' then deleted_at is null and spam_at is not null
          when 'held' then deleted_at is null and spam_at is null and held_at is not null
          when 'archive' then deleted_at is null and spam_at is null and held_at is null
            and coalesce(archived_at, thread_archived_at) is not null
          when 'starred' then deleted_at is null and starred is true
          when 'snoozed' then deleted_at is null
            and snoozed_until is not null and snoozed_until > ${now}
          when 'sent' then deleted_at is null and has_outbound = 'outbound'
          when 'drafts' then deleted_at is null and outbound_status = 'queued'
          else /* inbox */ deleted_at is null
            and spam_at is null
            and held_at is null
            and coalesce(archived_at, thread_archived_at) is null
            and (snoozed_until is null or snoozed_until <= ${now})
            and has_received
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
}
