import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { sensitivityClassificationFromMetadata } from "../ai/classification/index.js";
import { toSqlJson } from "../util/sql.js";
import { mailAddress, mailAddressArray, stringMetadata } from "./store-addresses.js";
import { escapeMailLike, parseMailSearchQuery } from "./store-search-query.js";
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
}
