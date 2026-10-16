import { mailBodyMatches } from "./body-search.js";
import type { SearchEngine } from "../search/types.js";
import type postgres from "postgres";
import type { MailDraftStore } from "./store-drafts.js";
import { clampLimit, parseMailSearchQuery } from "./store-search-query.js";
import {
  hasMessageOperators,
  mailMessageMatchSql,
  mailThreadStateMatchSql,
  sentOrReceivedSql,
} from "./store-search-sql.js";
import { type MailThreadListRow, mapThreadRow } from "./store-thread-projection.js";
import type { MailFolderId, MailThreadListRequest, MailThreadListResult } from "./types.js";

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/**
 * The thread-row projection for one folder view. Gmail-style operators in the
 * query filter it, and an `in:` operator replaces the requested folder, so a
 * search over `all` behaves like searching All Mail.
 */
export async function listMailThreads(
  sql: postgres.Sql,
  drafts: MailDraftStore,
  input: MailThreadListRequest,
  searchEngine?: SearchEngine,
  externalBodies = false,
): Promise<MailThreadListResult> {
  const now = input.now ?? new Date();
  const limit = clampLimit(input.limit, 50);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const parsed = parseMailSearchQuery((input.query ?? "").trim(), now);
  const query = {
    ...parsed,
    // Label matching compares lower-case slugs and names, like `label:` in a query.
    labels: [
      ...new Set([
        ...parsed.labels,
        ...(input.label === undefined ? [] : [input.label.toLowerCase()]),
      ]),
    ],
  };
  const scope = query.scope ?? input.folder ?? "inbox";
  // Rows report the folder they were listed under; `anywhere` lists as All Mail.
  const folder: MailFolderId = scope === "anywhere" ? "all" : scope;
  if (folder === "drafts") {
    return drafts.listDraftFolderThreads({
      orgId: input.orgId,
      actorId: input.actorId,
      query,
      limit,
      offset,
    });
  }
  // Category tabs only bucket the Inbox.
  const tab = folder === "inbox" ? (input.tab ?? null) : null;
  const mailbox = { orgId: input.orgId, actorId: input.actorId };
  const delivered = (message: Fragment) => sql`exists (
    select 1 from mail_message_deliveries mailbox_delivery
    where mailbox_delivery.org_id = ${input.orgId}
      and mailbox_delivery.message_id = ${message}
      and mailbox_delivery.actor_id = ${input.actorId}
  )`;
  const scheduledVisible = scope === "scheduled";
  const mailboxMessage = (message: Fragment, owner: Fragment) =>
    sql`(${owner} = ${input.actorId} or ${delivered(message)})
      and ${sentOrReceivedSql(sql, message, input.orgId, scheduledVisible)}`;
  const visible = {
    m: mailboxMessage(sql`m.id`, sql`m.actor_id`),
    mm: mailboxMessage(sql`mm.id`, sql`mm.actor_id`),
    pm: mailboxMessage(sql`pm.id`, sql`pm.actor_id`),
    counted: mailboxMessage(sql`counted.id`, sql`counted.actor_id`),
  };
  const bodyMatches = await mailBodyMatches(searchEngine, input, query.terms, externalBodies);
  const messageMatch = hasMessageOperators(query)
    ? sql`exists (
        select 1 from messages mm
        where mm.thread_id = latest.thread_id and mm.org_id = ${input.orgId}
          and mm.kind = 'mail' and mm.deleted_at is null and ${visible.mm}
          and ${mailMessageMatchSql(sql, query, mailbox, bodyMatches)}
      )`
    : sql`true`;
  const stateMatch = mailThreadStateMatchSql(sql, query, mailbox, {
    labels: sql`latest.labels`,
    readAt: sql`latest.read_at`,
    lastActivity: sql`latest.sent_at`,
    starred: sql`latest.starred`,
    category: sql`latest.category`,
  });
  const followUpOnly = query.followUp !== undefined || query.overdue === true;
  const rows = await sql<(MailThreadListRow & { readonly total: number })[]>`
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
        mts.category,
        case when mts.follow_up_message_id = m.id and mts.follow_up_state <> 'automatic'
          then mts.follow_up_state
          when helix_mailbox_sent_message(m.org_id,m.id,${input.actorId}) then 'waiting_on'
          when m.metadata->'decision'->>'needsReply' = 'false' then 'done'
          when lower(coalesce(m.metadata->'from'->>'address','')) ~ '(no-?reply|mailer-daemon)@' then 'done'
          when coalesce(mts.category,'primary') in ('promotions','social','updates')
            and m.metadata->'decision'->>'needsReply' is distinct from 'true' then 'done'
          else 'needs_reply' end as follow_up
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
        and ${visible.m}
        and (not ${followUpOnly} or not exists (
          select 1 from mail_outbound_messages pending
          where pending.org_id=m.org_id and pending.message_id=m.id and pending.status not in ('accepted','delivered')
        ))
      order by m.thread_id, m.sent_at desc, m.id desc
    ),
    filtered as (
      select latest.*,
        exists (
          select 1 from mail_outbound_messages scheduled
          where scheduled.org_id = ${input.orgId} and scheduled.actor_id = ${input.actorId}
            and scheduled.thread_id = latest.thread_id and scheduled.status = 'queued'
            and scheduled.scheduled_for is not null
        ) as has_scheduled,
        exists (
          select 1 from messages mo
          where mo.thread_id = latest.thread_id and mo.kind = 'mail' and mo.deleted_at is null
            and helix_mailbox_sent_message(mo.org_id, mo.id, ${input.actorId})
            and mo.metadata->>'direction' = 'outbound'
        ) as has_outbound,
        exists (
          select 1 from mail_message_deliveries received
          join messages incoming on incoming.id = received.message_id and incoming.org_id = received.org_id
          where received.org_id = ${input.orgId} and received.actor_id = ${input.actorId}
            and received.received_at is not null and incoming.thread_id = latest.thread_id
            and incoming.deleted_at is null
        ) as has_received
      from latest
      where (${tab}::text is null or coalesce(latest.category, 'primary') = ${tab})
        and ${stateMatch}
        and ${messageMatch}
        and (${query.followUp ?? null}::text is null or latest.follow_up=${query.followUp ?? null})
        and (not ${followUpOnly} or (latest.deleted_at is null and latest.spam_at is null
          and (latest.snoozed_until is null or latest.snoozed_until <= ${now})))
        and (not ${query.overdue === true} or (latest.follow_up in ('needs_reply','waiting_on')
          and latest.sent_at <= ${now} - make_interval(days => coalesce((
            select (settings->>'overdueDays')::integer from mail_productivity_preferences
            where org_id=${input.orgId} and actor_id=${input.actorId}
          ),3))))
    ),
    in_folder as (
      select * from filtered
      where case ${scope}::text
        when 'anywhere' then true
        when 'trash' then deleted_at is not null
        when 'spam' then deleted_at is null and spam_at is not null
        when 'all' then deleted_at is null and spam_at is null
        when 'archive' then deleted_at is null and spam_at is null
          and coalesce(archived_at, thread_archived_at) is not null
        when 'starred' then deleted_at is null and starred is true
        when 'snoozed' then deleted_at is null
          and snoozed_until is not null and snoozed_until > ${now}
        when 'sent' then deleted_at is null and has_outbound
        when 'scheduled' then deleted_at is null and has_scheduled
        else /* inbox */ deleted_at is null
          and spam_at is null
          and coalesce(archived_at, thread_archived_at) is null
          and (snoozed_until is null or snoozed_until <= ${now})
          and has_received
      end
    )
    select
      thread_id, subject, message_id, body, body_format, metadata, sent_at, labels, read_at, starred,
      category, snoozed_until, follow_up,
      (
        select count(*)::int from messages counted
        where counted.thread_id = in_folder.thread_id and counted.org_id = ${input.orgId}
          and counted.kind = 'mail' and counted.deleted_at is null and ${visible.counted}
      ) as message_count,
      exists (
        select 1 from message_attachments ma
        join messages attached on attached.id = ma.message_id
        where attached.thread_id = in_folder.thread_id
          and (attached.actor_id = ${input.actorId} or exists (
            select 1 from mail_message_deliveries attached_delivery
            where attached_delivery.org_id = ${input.orgId}
              and attached_delivery.message_id = attached.id
              and attached_delivery.actor_id = ${input.actorId}
          ))
      ) as has_attachment,
      (
        select coalesce(jsonb_agg(
          jsonb_build_object('name', sender.name, 'email', sender.email, 'isMe', sender.is_me)
          order by sender.first_at
        ), '[]'::jsonb)
        from (
          select * from (
            select distinct on (candidate.sender_key)
              candidate.sender_key, candidate.name, candidate.email, candidate.is_me,
              candidate.sent_at as first_at
            from (
              select
                helix_mailbox_sent_message(pm.org_id, pm.id, ${input.actorId}) as is_me,
                case when helix_mailbox_sent_message(pm.org_id, pm.id, ${input.actorId})
                  then '' else lower(coalesce(pm.metadata->'from'->>'address', '')) end as sender_key,
                coalesce(
                  nullif(btrim(pm.metadata->'from'->>'name'), ''),
                  nullif(split_part(pm.metadata->'from'->>'address', '@', 1), ''),
                  ''
                ) as name,
                coalesce(pm.metadata->'from'->>'address', '') as email,
                pm.sent_at
              from messages pm
              where pm.thread_id = in_folder.thread_id and pm.org_id = ${input.orgId}
                and pm.kind = 'mail' and pm.deleted_at is null and ${visible.pm}
            ) candidate
            order by candidate.sender_key, candidate.sent_at
          ) distinct_sender
          order by distinct_sender.first_at
          limit 4
        ) sender
      ) as participants,
      (count(*) over ())::int as total
    from in_folder
    order by sent_at desc
    limit ${limit} offset ${offset}
  `;
  const total =
    rows[0]?.total ??
    (offset === 0
      ? 0
      : (
          await listMailThreads(
            sql,
            drafts,
            {
              ...input,
              folder,
              offset: 0,
              limit: 1,
            },
            searchEngine,
            externalBodies,
          )
        ).total);
  return {
    threads: rows.map((row) => mapThreadRow(row, folder)),
    total,
    limit,
    offset,
  };
}
