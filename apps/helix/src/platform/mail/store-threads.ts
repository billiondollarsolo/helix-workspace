import type postgres from "postgres";
import { MailThreadNotFoundError } from "./errors.js";
import type { MailDraftStore } from "./store-drafts.js";
import { listMailThreads } from "./store-thread-list.js";
import { type MailThreadRow, mapThreadDetail } from "./store-thread-projection.js";
import type {
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

    return rows.length === 0 ? null : mapThreadDetail(rows);
  }

  listThreads(input: MailThreadListRequest): Promise<MailThreadListResult> {
    return listMailThreads(this.sql, this.drafts, input);
  }
}
