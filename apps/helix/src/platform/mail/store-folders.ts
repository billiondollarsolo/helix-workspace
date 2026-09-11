import type postgres from "postgres";
import type { MailFolderId, MailFolderSummary, MailLabelRecord } from "./types.js";
import { MAIL_FOLDER_IDS } from "./types.js";

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

const MAIL_FOLDER_LABELS: Readonly<Record<MailFolderId, string>> = {
  inbox: "Inbox",
  starred: "Starred",
  snoozed: "Snoozed",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  spam: "Spam",
  held: "Held",
  trash: "Trash",
};

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
export class MailFolderStore {
  constructor(private readonly sql: postgres.Sql) {}

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
          case when helix_mailbox_sent_message(m.org_id, m.id, ${input.actorId}) then m.metadata else m.metadata - 'bcc' end as metadata,
          m.sent_at,
          t.archived_at as thread_archived_at,
          mts.archived_at,
          mts.deleted_at,
          mts.snoozed_until,
          mts.read_at,
          mts.starred,
          mts.spam_at,
          mts.held_at,
          (
            select bool_or(mo.metadata->>'direction' = 'outbound')
            from messages mo
            where mo.thread_id = m.thread_id and mo.kind = 'mail' and mo.deleted_at is null
              and helix_mailbox_sent_message(mo.org_id, mo.id, ${input.actorId})
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
      classified as (
        select
          unnest(folders) as folder,
          (read_at is null or read_at < sent_at) as unread
        from latest,
        lateral (
          select array_remove(array[
            case when deleted_at is null
              and spam_at is null
              and held_at is null
              and coalesce(archived_at, thread_archived_at) is null
              and (snoozed_until is null or snoozed_until <= ${now})
              and has_received then 'inbox' end,
            case when deleted_at is null and starred is true then 'starred' end,
            case when deleted_at is null and snoozed_until is not null
              and snoozed_until > ${now} then 'snoozed' end,
            case when deleted_at is null and has_outbound is true then 'sent' end,
            -- Queued outbound still contributes to Drafts totals (undo window).
            case when deleted_at is null and outbound_status = 'queued' then 'drafts' end,
            case when deleted_at is null and spam_at is null and held_at is null
              and coalesce(archived_at, thread_archived_at) is not null then 'archive' end,
            case when deleted_at is null and spam_at is not null then 'spam' end,
            case when deleted_at is null and spam_at is null and held_at is not null then 'held' end,
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
}
