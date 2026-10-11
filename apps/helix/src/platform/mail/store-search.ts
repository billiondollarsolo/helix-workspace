import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { sensitivityClassificationFromMetadata } from "../ai/classification/index.js";
import { toSqlJson } from "../util/sql.js";
import { mailAddress, mailAddressArray, stringMetadata } from "./store-addresses.js";
import { parseMailSearchQuery } from "./store-search-query.js";
import {
  mailMessageMatchSql,
  mailThreadStateMatchSql,
  sentOrReceivedSql,
} from "./store-search-sql.js";
import type {
  MailClassificationWrite,
  MailEnrichmentRecord,
  MailEnrichmentWrite,
  MailOutboundStatus,
  MailSearchHit,
  MailSearchRecord,
  MailSearchRequest,
} from "./types.js";

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

function mapSearchHit(row: MailSearchRow): MailSearchHit {
  const from = row.metadata.from as MailSearchHit["from"] | undefined;
  const attachments = row.metadata.attachments;
  const hasAttachment =
    row.metadata.hasAttachment === true || (Array.isArray(attachments) && attachments.length > 0);
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
    ...(hasAttachment ? { hasAttachment: true } : {}),
    ...(row.outbound_status === null ? {} : { outboundStatus: row.outbound_status }),
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
    ...(row.delivery_metadata === null ? {} : { deliveryMetadata: row.delivery_metadata }),
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
export class MailSearchStore {
  constructor(private readonly sql: postgres.Sql) {}

  /**
   * Message hits for Gmail-style queries across every folder except Spam and
   * Trash; `in:` narrows to one folder view and `in:anywhere` includes both.
   */
  async search(input: MailSearchRequest): Promise<readonly MailSearchHit[]> {
    const parsed = parseMailSearchQuery((input.query ?? "").trim());
    const query = {
      ...parsed,
      labels: [
        ...new Set([...parsed.labels, ...(input.labels ?? []).map((label) => label.toLowerCase())]),
      ],
    };
    const mailbox = { orgId: input.orgId, actorId: input.actorId };
    const scope = query.scope ?? "all";
    const rows = await this.sql<MailSearchRow[]>`
      select
        t.id as thread_id,
        mm.id as message_id,
        t.subject,
        mm.body,
        case when helix_mailbox_sent_message(mm.org_id, mm.id, ${input.actorId}) then mm.metadata else (mm.metadata - 'bcc') || '{"direction":"inbound"}'::jsonb end as metadata,
        mm.sent_at,
        mts.labels,
        mts.read_at,
        mts.starred,
        outbound.status as outbound_status,
        outbound.provider_message_id,
        outbound.delivery_metadata
      from messages mm
      join threads t on t.id = mm.thread_id
      join mail_thread_state mts
        on mts.thread_id = t.id
       and mts.actor_id = ${input.actorId}
       and mts.org_id = ${input.orgId}
      left join mail_outbound_messages outbound on outbound.message_id = mm.id and outbound.org_id = ${input.orgId} and outbound.actor_id = ${input.actorId}
      where mm.org_id = ${input.orgId}
        and mm.kind = 'mail'
        and (mm.actor_id = ${input.actorId} or exists (select 1 from mail_message_deliveries visible where visible.org_id = ${input.orgId} and visible.message_id = mm.id and visible.actor_id = ${input.actorId}))
        and mm.deleted_at is null
        and ${sentOrReceivedSql(this.sql, this.sql`mm.id`, input.orgId, scope === "scheduled")}
        and case ${scope}::text
          when 'anywhere' then true
          when 'trash' then mts.deleted_at is not null
          when 'spam' then mts.deleted_at is null and mts.spam_at is not null
          when 'archive' then mts.deleted_at is null and mts.spam_at is null
            and coalesce(mts.archived_at, t.archived_at) is not null
          when 'starred' then mts.deleted_at is null and mts.starred is true
          when 'snoozed' then mts.deleted_at is null and mts.snoozed_until > now()
          when 'sent' then mts.deleted_at is null and mm.metadata->>'direction' = 'outbound'
            and helix_mailbox_sent_message(mm.org_id, mm.id, ${input.actorId})
          when 'scheduled' then outbound.status = 'queued' and outbound.scheduled_for is not null
          when 'drafts' then outbound.status = 'queued' and outbound.scheduled_for is null
          when 'inbox' then mts.deleted_at is null and mts.spam_at is null
            and coalesce(mts.archived_at, t.archived_at) is null
            and (mts.snoozed_until is null or mts.snoozed_until <= now())
            and exists (
              select 1 from mail_message_deliveries received
              where received.org_id = ${input.orgId} and received.message_id = mm.id
                and received.actor_id = ${input.actorId} and received.received_at is not null
            )
          else /* all */ mts.deleted_at is null and mts.spam_at is null
        end
        and ${mailMessageMatchSql(this.sql, query, mailbox)}
        and ${mailThreadStateMatchSql(this.sql, query, mailbox, {
          labels: this.sql`mts.labels`,
          readAt: this.sql`mts.read_at`,
          lastActivity: this.sql`mm.sent_at`,
          starred: this.sql`mts.starred`,
          category: this.sql`mts.category`,
        })}
      order by mm.sent_at desc
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
        case when helix_mailbox_sent_message(m.org_id, m.id, ${input.actorId}) then m.metadata else (m.metadata - 'bcc') || '{"direction":"inbound"}'::jsonb end as metadata,
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
        and (m.actor_id = ${input.actorId} or exists (select 1 from mail_message_deliveries visible where visible.org_id = ${input.orgId} and visible.message_id = m.id and visible.actor_id = ${input.actorId}))
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
        case when helix_mailbox_sent_message(m.org_id, m.id, mailbox.actor_id) then m.metadata else (m.metadata - 'bcc') || '{"direction":"inbound"}'::jsonb end as metadata,
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
        and (m.actor_id = mailbox.actor_id or exists (select 1 from mail_message_deliveries visible where visible.org_id = m.org_id and visible.message_id = m.id and visible.actor_id = mailbox.actor_id))
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
}
