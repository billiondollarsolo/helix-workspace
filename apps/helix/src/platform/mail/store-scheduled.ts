import type { JsonObject } from "@helix/sdk-types";
import { readMailBody } from "./body-storage.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import type postgres from "postgres";
import { mailAddressArray } from "./store-addresses.js";
import type { MailScheduledSendRecord } from "./types.js";

interface ScheduledRow {
  readonly id: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly envelope: JsonObject;
  readonly scheduled_for: Date;
  readonly created_at: Date;
  readonly total: number;
}

interface Mailbox {
  readonly orgId: string;
  readonly actorId: string;
}

function mapScheduled(row: ScheduledRow): MailScheduledSendRecord {
  const envelope = row.envelope;
  const text = typeof envelope.text === "string" ? envelope.text : "";
  return {
    outboundId: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    subject: typeof envelope.subject === "string" ? envelope.subject : "",
    preview: text.slice(0, 240),
    to: mailAddressArray(envelope.to),
    cc: mailAddressArray(envelope.cc),
    bcc: mailAddressArray(envelope.bcc),
    hasAttachment: Array.isArray(envelope.attachments) && envelope.attachments.length > 0,
    sendAt: row.scheduled_for,
    createdAt: row.created_at,
    envelope,
  };
}

/** Sends the actor scheduled for later that have not been handed off yet. */
export class MailScheduledStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly storageResolver?: TenantStorageResolver,
  ) {}

  private async hydrate(orgId: string, row: ScheduledRow): Promise<MailScheduledSendRecord> {
    if (row.envelope.bodyStorage !== "object-v1") return mapScheduled(row);
    const body = await readMailBody(this.sql, this.storageResolver, orgId, row.message_id);
    const { bodyStorage: _marker, ...envelope } = row.envelope;
    return mapScheduled({
      ...row,
      envelope: {
        ...envelope,
        text: body.text,
        ...(body.html === undefined ? {} : { html: body.html }),
      },
    });
  }

  async listScheduledSends(
    input: Mailbox & { readonly limit: number; readonly offset: number },
  ): Promise<{ readonly scheduled: readonly MailScheduledSendRecord[]; readonly total: number }> {
    const rows = await this.sql<ScheduledRow[]>`
      select id, thread_id, message_id, envelope, scheduled_for, created_at,
        (count(*) over ())::int as total
      from mail_outbound_messages
      where org_id = ${input.orgId} and actor_id = ${input.actorId}
        and status = 'queued' and scheduled_for is not null and undo_until > now()
      order by scheduled_for asc, id asc
      limit ${input.limit} offset ${input.offset}
    `;
    const scheduled: MailScheduledSendRecord[] = [];
    for (const row of rows) scheduled.push(await this.hydrate(input.orgId, row));
    return { scheduled, total: rows[0]?.total ?? 0 };
  }

  /** Move a scheduled send that has not started sending; null when it is gone. */
  async rescheduleSend(
    input: Mailbox & { readonly outboundId: string; readonly sendAt: Date },
  ): Promise<MailScheduledSendRecord | null> {
    const rows = await this.sql<ScheduledRow[]>`
      with moved as (
        update mail_outbound_messages
        set undo_until = ${input.sendAt}, next_attempt_at = ${input.sendAt},
          scheduled_for = ${input.sendAt}, updated_at = now()
        where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.outboundId}
          and status = 'queued' and scheduled_for is not null and undo_until > now()
        returning id, thread_id, message_id, envelope, scheduled_for, created_at, outbox_id
      ), deferred as (
        update outbox set deliver_after = ${input.sendAt}
        where id in (select outbox_id from moved) and delivered_at is null
      )
      select id, thread_id, message_id, envelope, scheduled_for, created_at, 1 as total
      from moved
    `;
    return rows[0] === undefined ? null : this.hydrate(input.orgId, rows[0]);
  }
}
