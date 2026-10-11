import type postgres from "postgres";
import { escapeMailLike, type ParsedMailSearchQuery } from "./store-search-query.js";

type Fragment = postgres.PendingQuery<postgres.Row[]>;

interface Mailbox {
  readonly orgId: string;
  readonly actorId: string;
}

/** Thread-state columns of the row being filtered, as SQL fragments. */
export interface MailThreadStateColumns {
  readonly labels: Fragment;
  readonly readAt: Fragment;
  readonly lastActivity: Fragment;
  readonly starred: Fragment;
  readonly category: Fragment;
}

function conjunction(sql: postgres.Sql, parts: readonly Fragment[]): Fragment {
  return parts.reduce<Fragment>((all, part) => sql`${all} and ${part}`, sql`true`);
}

function like(value: string): string {
  return `%${escapeMailLike(value)}%`;
}

/**
 * Message-level operators evaluated against a message aliased `mm` that the
 * caller has already scoped to the mailbox. Bcc is matched only on the
 * mailbox's own sent messages.
 */
export function mailMessageMatchSql(
  sql: postgres.Sql,
  query: ParsedMailSearchQuery,
  mailbox: Mailbox,
): Fragment {
  const sent = sql`helix_mailbox_sent_message(mm.org_id, mm.id, ${mailbox.actorId})`;
  const subject = sql`coalesce(mm.metadata->>'subject', (select st.subject from threads st where st.id = mm.thread_id), '')`;
  const sender = sql`concat_ws(' ', mm.metadata->'from'->>'name', mm.metadata->'from'->>'address')`;
  const recipients = sql`
    (case when jsonb_typeof(mm.metadata->'to') = 'array' then mm.metadata->'to' else '[]'::jsonb end
      || case when jsonb_typeof(mm.metadata->'cc') = 'array' then mm.metadata->'cc' else '[]'::jsonb end
      || case when ${sent} and jsonb_typeof(mm.metadata->'bcc') = 'array'
           then mm.metadata->'bcc' else '[]'::jsonb end)`;
  const parts: Fragment[] = [];
  for (const term of query.terms) {
    parts.push(
      sql`(${subject} ilike ${like(term)} or mm.body ilike ${like(term)} or ${sender} ilike ${like(term)})`,
    );
  }
  for (const value of query.from) {
    parts.push(value.toLowerCase() === "me" ? sent : sql`${sender} ilike ${like(value)}`);
  }
  for (const value of query.to) {
    parts.push(
      value.toLowerCase() === "me"
        ? sql`exists (
            select 1 from mail_message_deliveries mine
            where mine.org_id = ${mailbox.orgId} and mine.message_id = mm.id
              and mine.actor_id = ${mailbox.actorId}
          )`
        : sql`exists (
            select 1 from jsonb_array_elements(${recipients}) recipient
            where concat_ws(' ', recipient->>'name', recipient->>'address') ilike ${like(value)}
          )`,
    );
  }
  for (const value of query.subject) parts.push(sql`${subject} ilike ${like(value)}`);
  for (const value of query.filenames) {
    parts.push(sql`exists (
      select 1 from message_attachments named_attachment
      join objects named_object
        on named_object.id = named_attachment.object_id
       and named_object.org_id = named_attachment.org_id
      where named_attachment.message_id = mm.id
        and named_object.metadata->>'filename' ilike ${like(value)}
    )`);
  }
  if (query.hasAttachment !== undefined) {
    parts.push(
      sql`exists (select 1 from message_attachments any_attachment where any_attachment.message_id = mm.id) = ${query.hasAttachment}`,
    );
  }
  if (query.before !== undefined) parts.push(sql`mm.sent_at < ${query.before}`);
  if (query.after !== undefined) parts.push(sql`mm.sent_at >= ${query.after}`);
  return conjunction(sql, parts);
}

/** Per-mailbox thread state operators: is:, label:, category:. */
export function mailThreadStateMatchSql(
  sql: postgres.Sql,
  query: ParsedMailSearchQuery,
  mailbox: Mailbox,
  columns: MailThreadStateColumns,
): Fragment {
  const parts: Fragment[] = [];
  if (query.unread !== undefined) {
    parts.push(
      sql`(${columns.readAt} is null or ${columns.readAt} < ${columns.lastActivity}) = ${query.unread}`,
    );
  }
  if (query.starred !== undefined) {
    parts.push(sql`coalesce(${columns.starred}, false) = ${query.starred}`);
  }
  if (query.category !== undefined) {
    parts.push(sql`coalesce(${columns.category}, 'primary') = ${query.category}`);
  }
  for (const value of query.labels) {
    parts.push(sql`exists (
      select 1 from unnest(coalesce(${columns.labels}, '{}'::text[])) applied(slug)
      where lower(applied.slug) = ${value}
        or exists (
          select 1 from mail_labels named
          where named.org_id = ${mailbox.orgId}
            and named.deleted_at is null
            and (named.owner_actor_id is null or named.owner_actor_id = ${mailbox.actorId})
            and lower(named.slug) = lower(applied.slug)
            and lower(replace(named.name, ' ', '-')) = ${value.replaceAll(" ", "-")}
        )
    )`);
  }
  return conjunction(sql, parts);
}

/**
 * Excludes a message whose send was cancelled, and a scheduled send unless the
 * view is Scheduled: neither has left the mailbox, so it is not mail yet.
 */
export function sentOrReceivedSql(
  sql: postgres.Sql,
  messageId: Fragment,
  orgId: string,
  scheduledVisible: boolean,
): Fragment {
  return sql`not exists (
    select 1 from mail_outbound_messages unsent
    where unsent.org_id = ${orgId} and unsent.message_id = ${messageId}
      and (
        unsent.status = 'cancelled'
        or (unsent.status = 'queued' and unsent.scheduled_for is not null and not ${scheduledVisible})
      )
  )`;
}

/** True when the query has message-level operators that need a per-message match. */
export function hasMessageOperators(query: ParsedMailSearchQuery): boolean {
  return (
    query.terms.length > 0 ||
    query.from.length > 0 ||
    query.to.length > 0 ||
    query.subject.length > 0 ||
    query.filenames.length > 0 ||
    query.hasAttachment !== undefined ||
    query.before !== undefined ||
    query.after !== undefined
  );
}
