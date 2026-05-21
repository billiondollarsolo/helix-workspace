import type postgres from "postgres";
import type { JsonValue, OutboxMessage } from "@helix/sdk-types";
import type { OutboxStore, StoredOutboxMessage } from "./outbox.js";

interface OutboxRow {
  readonly id: string;
  readonly subject: string;
  readonly payload: JsonValue;
  readonly trace_id: string | null;
  readonly span_id: string | null;
  readonly traceparent: string | null;
  readonly tracestate: string | null;
  readonly attempts: number;
  readonly created_at: Date;
  readonly delivered_at: Date | null;
  readonly last_error: string | null;
}

export class PostgresOutboxStore implements OutboxStore {
  constructor(private readonly sql: postgres.Sql) {}

  async insert(message: OutboxMessage): Promise<string> {
    const insertedRows = await this.sql`
      insert into outbox (subject, payload, trace_id, span_id, traceparent, tracestate, deliver_after)
      values (
        ${message.subject},
        ${this.sql.json(message.payload)},
        ${message.trace?.traceId ?? null},
        ${message.trace?.spanId ?? null},
        ${message.trace?.traceparent ?? null},
        ${message.trace?.tracestate ?? null},
        ${message.delayUntil ? new Date(message.delayUntil) : new Date()}
      )
      returning id
    `;
    const rows = insertedRows as unknown as readonly { readonly id: string }[];
    return rows[0]?.id ?? "";
  }

  async claimUndelivered(limit: number): Promise<readonly StoredOutboxMessage[]> {
    const claimedRows = await this.sql`
      update outbox
      set attempts = attempts + 1
      where id in (
        select id from outbox
        where delivered_at is null and deliver_after <= now()
        order by created_at
        limit ${limit}
        for update skip locked
      )
      returning id, subject, payload, trace_id, span_id, traceparent, tracestate, attempts, created_at, delivered_at, last_error
    `;
    const rows = claimedRows as unknown as readonly OutboxRow[];
    return rows.map(toStoredMessage);
  }

  async markDelivered(id: string): Promise<void> {
    await this.sql`update outbox set delivered_at = now(), last_error = null where id = ${id}`;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.sql`
      update outbox
      set last_error = ${error}, deliver_after = now() + interval '1 minute'
      where id = ${id}
    `;
  }
}

function toStoredMessage(row: OutboxRow): StoredOutboxMessage {
  return {
    id: row.id,
    subject: row.subject,
    payload: row.payload,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    ...toStoredTrace(row),
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at.toISOString() }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function toStoredTrace(row: OutboxRow): Pick<StoredOutboxMessage, "trace"> {
  if (
    row.trace_id === null &&
    row.span_id === null &&
    row.traceparent === null &&
    row.tracestate === null
  ) {
    return {};
  }

  return {
    trace: {
      ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
      ...(row.span_id === null ? {} : { spanId: row.span_id }),
      ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
      ...(row.tracestate === null ? {} : { tracestate: row.tracestate }),
    },
  };
}
