import type { JsonObject } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { toSqlJson } from "../util/sql.js";
import type { MailOutboundDeliveryHealth } from "./admin-config.js";
import { MailRecipientSuppressedError } from "./errors.js";
import { normalizeAddress } from "./store-addresses.js";
import {
  type BindOutboundProviderDecisionInput,
  type ClaimedOutboundMail,
  type CreateOutboundMailInput,
  type MarkOutboundSentInput,
  type PostgresMailStoreOptions,
} from "./store-contracts.js";
import { insertMailMessage, stageInlineAttachments } from "./store-message-write.js";
import { prepareOutboundEnvelope } from "./threading.js";
import type { MailOutboundEnvelope, MailOutboundRecord, MailOutboundStatus } from "./types.js";

interface MailOutboundRow {
  readonly id: string;
  readonly org_id: string;
  readonly idempotency_key: string | null;
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
  readonly provider_id?: string | null;
  readonly provider_kind?: string | null;
  readonly provider_decision_source?: "sending_domain" | "org_default" | "environment" | null;
  readonly provider_decided_at?: Date | null;
  readonly attempt_count?: number;
  readonly next_attempt_at?: Date | null;
  readonly dead_lettered_at?: Date | null;
  readonly handoff_key?: string;
  readonly lease_owner?: string | null;
  readonly lease_token?: string | null;
  readonly lease_expires_at?: Date | null;
  readonly delivery_metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
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
    providerId: row.provider_id ?? null,
    providerKind: row.provider_kind ?? null,
    providerDecisionSource: row.provider_decision_source ?? null,
    providerDecidedAt: row.provider_decided_at ?? null,
    deliveryMetadata: row.delivery_metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attemptCount: row.attempt_count ?? 0,
    nextAttemptAt: row.next_attempt_at ?? null,
    deadLetteredAt: row.dead_lettered_at ?? null,
    ...(row.handoff_key === undefined ? {} : { handoffKey: row.handoff_key }),
    leaseOwner: row.lease_owner ?? null,
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
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
    cancelled: 0,
    sending: 0,
    accepted: 0,
    delivered: 0,
    deferred: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}
export class MailOutboundStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresMailStoreOptions = {},
  ) {}

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    if (input.idempotencyKey !== undefined && !/^.{1,512}$/u.test(input.idempotencyKey)) {
      throw new TypeError("idempotencyKey must contain 1 to 512 characters.");
    }
    const envelope = prepareOutboundEnvelope(input.envelope);
    const staged = await stageInlineAttachments(
      {
        orgId: input.orgId,
        actorId: input.actorId,
        from: envelope.from,
        to: envelope.to,
        cc: envelope.cc,
        bcc: envelope.bcc,
        subject: envelope.subject,
        bodyText: envelope.text,
        attachments: envelope.attachments,
      },
      this.options.attachmentIngestor,
    );
    try {
      const result = await this.sql.begin(async (tx) => {
        if (input.idempotencyKey !== undefined) {
          await tx`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}:${input.actorId}:${input.idempotencyKey}`}, 0))`;
          const existing = await tx<MailOutboundRow[]>`
            select * from mail_outbound_messages
            where org_id = ${input.orgId} and actor_id = ${input.actorId}
              and idempotency_key = ${input.idempotencyKey}
            limit 1
          `;
          if (existing[0] !== undefined)
            return { outbound: mapOutbound(existing[0]), created: false };
        }
        const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc].map((recipient) =>
          normalizeAddress(recipient.address),
        );
        const suppressed =
          recipients.length === 0
            ? []
            : await tx<{ readonly address: string }[]>`
              select address from mail_suppressions
              where org_id = ${input.orgId} and removed_at is null and address in ${tx(recipients)}
            `;
        if (suppressed.length > 0) {
          throw new MailRecipientSuppressedError(suppressed.map((row) => row.address));
        }
        const message = await insertMailMessage(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          threadId: input.threadId,
          messageId: envelope.messageId,
          from: envelope.from,
          to: envelope.to,
          cc: envelope.cc,
          bcc: envelope.bcc,
          subject: envelope.subject,
          bodyText: envelope.text,
          ...(envelope.html === undefined ? {} : { bodyHtml: envelope.html }),
          ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
          ...(envelope.references === undefined ? {} : { references: envelope.references }),
          attachments: staged.input.attachments,
          metadata: { direction: "outbound" },
        });

        // Pre-generate the outbound id so the outbox payload is correct on first insert
        // (avoids a race where a worker picks up the outbox row before the follow-up UPDATE).
        const outboundId = randomUUID();

        const outboxRows = await tx<{ readonly id: string }[]>`
        insert into outbox (subject, payload, deliver_after)
        values (
          ${input.outboxSubject},
          ${tx.json(toSqlJson({ mailOutboundId: outboundId, orgId: input.orgId, actorId: input.actorId }))},
          ${input.undoUntil}
        )
        returning id
      `;
        const outboxId = outboxRows[0]?.id ?? null;

        const outboundRows = await tx<MailOutboundRow[]>`
        insert into mail_outbound_messages (
          id, org_id, actor_id, message_id, thread_id, outbox_id, status, envelope,
          undo_until, next_attempt_at, idempotency_key, delivery_metadata
        )
        values (
          ${outboundId},
          ${input.orgId},
          ${input.actorId},
          ${message.messageId},
          ${message.threadId},
          ${outboxId},
          'queued',
          ${tx.json(toSqlJson({ ...envelope, attachments: message.authoritativeAttachments }))},
          ${input.undoUntil},
          ${input.undoUntil},
          ${input.idempotencyKey ?? null},
          ${tx.json({ senderAuthenticated: input.senderAuthenticated === true })}
        )
        returning *
      `;

        // Consume only the revision sent; a newer edit on another device must survive.
        if (input.draft !== undefined) {
          await tx`delete from mail_drafts where id = ${input.draft.id}
            and org_id = ${input.orgId} and actor_id = ${input.actorId}
            and revision = ${input.draft.revision}`;
        }
        const outbound = mapOutbound(outboundRows[0]);
        return { outbound, created: true };
      });
      if (!result.created) {
        await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      }
      return result.outbound;
    } catch (error) {
      await this.options.attachmentIngestor?.release(staged.stages).catch(() => undefined);
      throw error;
    }
  }

  async getOutbound(id: string): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      select * from mail_outbound_messages where id = ${id} limit 1
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async getOutboundDeliveryHealth(input: {
    readonly orgId: string;
    readonly since: Date;
  }): Promise<MailOutboundDeliveryHealth> {
    const rows = await this.sql<
      {
        readonly status: MailOutboundStatus;
        readonly count: number;
      }[]
    >`
      select status, count(*)::int as count
      from mail_outbound_messages
      where org_id = ${input.orgId}
        and created_at >= ${input.since}
      group by status
    `;
    const failures = await this.sql<
      {
        readonly failed_at: Date | null;
        readonly last_error: string | null;
      }[]
    >`
      select failed_at, last_error
      from mail_outbound_messages
      where org_id = ${input.orgId}
        and status = 'failed'
        and failed_at >= ${input.since}
      order by failed_at desc nulls last, updated_at desc
      limit 1
    `;
    const counts = outboundStatusCounts(rows);
    return {
      since: input.since.toISOString(),
      counts,
      failedLast24h: counts.failed,
      lastFailureAt: failures[0]?.failed_at?.toISOString() ?? null,
      lastError: failures[0]?.last_error ?? null,
    };
  }

  async claimDueOutbound(input: {
    readonly owner: string;
    readonly leaseMs: number;
    readonly now?: Date;
  }): Promise<ClaimedOutboundMail | null> {
    const claimedAt = input.now ?? new Date();
    const leaseExpiresAt = new Date(claimedAt.getTime() + input.leaseMs);
    const rows = await this.sql<MailOutboundRow[]>`
      with due as (
        select id
        from mail_outbound_messages
        where dead_lettered_at is null
          and (
            (status = 'queued' and next_attempt_at <= ${claimedAt})
            or (status = 'sending' and lease_expires_at <= ${claimedAt})
          )
        order by coalesce(next_attempt_at, lease_expires_at), created_at, id
        limit 1
        for update skip locked
      )
      update mail_outbound_messages outbound
      set
        status = 'sending',
        attempt_count = attempt_count + 1,
        next_attempt_at = null,
        lease_owner = ${input.owner},
        lease_token = gen_random_uuid(),
        lease_expires_at = ${leaseExpiresAt},
        updated_at = ${claimedAt}
      from due
      where outbound.id = due.id
      returning outbound.*
    `;
    const outbound = rows[0] === undefined ? null : mapOutbound(rows[0]);
    if (
      outbound === null ||
      outbound.handoffKey === undefined ||
      outbound.leaseOwner === null ||
      outbound.leaseOwner === undefined ||
      outbound.leaseToken === null ||
      outbound.leaseToken === undefined ||
      outbound.leaseExpiresAt === null ||
      outbound.leaseExpiresAt === undefined
    ) {
      return null;
    }
    return outbound as ClaimedOutboundMail;
  }

  async bindOutboundProviderDecision(
    input: BindOutboundProviderDecisionInput,
  ): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<readonly MailOutboundRow[]>`
      update mail_outbound_messages
      set
        provider_id = ${input.providerId},
        provider_kind = ${input.providerKind},
        provider_decision_source = ${input.source},
        provider_decided_at = coalesce(provider_decided_at, ${input.decidedAt ?? new Date()}),
        updated_at = now()
      where id = ${input.id}
        and org_id = ${input.orgId}
        and status = 'sending' and lease_token = ${input.leaseToken}
        and lease_expires_at > now()
        and (provider_id is null or provider_id = ${input.providerId})
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundSent(input: MarkOutboundSentInput): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'accepted',
        sent_at = ${input.sentAt ?? new Date()},
        last_error = null,
        provider_message_id = ${input.providerMessageId ?? null},
        delivery_metadata = delivery_metadata || ${this.sql.json(toSqlJson(input.deliveryMetadata ?? {}))},
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where id = ${input.id} and status = 'sending' and lease_token = ${input.leaseToken}
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set status = 'cancelled', cancelled_at = now(), updated_at = now()
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and id = ${input.id}
        and status = 'queued'
        and undo_until > now()
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundRetry(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'queued',
        next_attempt_at = ${input.nextAttemptAt},
        last_error = ${input.lastError},
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where id = ${input.id} and status = 'sending' and lease_token = ${input.leaseToken}
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async markOutboundDeadLettered(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly lastError: string;
    readonly deadLetteredAt?: Date;
  }): Promise<MailOutboundRecord | null> {
    const deadAt = input.deadLetteredAt ?? new Date();
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'failed',
        failed_at = ${deadAt},
        dead_lettered_at = ${deadAt},
        last_error = ${input.lastError},
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where id = ${input.id} and status = 'sending' and lease_token = ${input.leaseToken}
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async replayOutbound(input: {
    readonly orgId: string;
    readonly id: string;
  }): Promise<MailOutboundRecord | null> {
    const rows = await this.sql<MailOutboundRow[]>`
      update mail_outbound_messages
      set
        status = 'queued',
        attempt_count = 0,
        next_attempt_at = now(),
        dead_lettered_at = null,
        failed_at = null,
        last_error = null,
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id} and dead_lettered_at is not null
      returning *
    `;
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async listDeadLetteredOutbound(
    orgId: string,
    limit = 100,
  ): Promise<readonly MailOutboundRecord[]> {
    const rows = await this.sql<MailOutboundRow[]>`
      select *
      from mail_outbound_messages
      where org_id = ${orgId} and dead_lettered_at is not null
      order by dead_lettered_at desc, id
      limit ${Math.min(Math.max(limit, 1), 500)}
    `;
    return rows.map(mapOutbound);
  }

  async retryOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly outboxSubject?: string;
  }): Promise<MailOutboundRecord | null> {
    return this.sql.begin(async (tx) => {
      const current = await tx<readonly { readonly id: string }[]>`
        select id from mail_outbound_messages
        where id = ${input.id}
          and org_id = ${input.orgId}
          and actor_id = ${input.actorId}
          and status = 'failed'
        for update
      `;
      if (current[0] === undefined) return null;
      const outbox = await tx<readonly { readonly id: string }[]>`
        insert into outbox (subject, payload, deliver_after)
        values (
          ${input.outboxSubject ?? "mail.send"},
          ${tx.json(
            toSqlJson({
              mailOutboundId: input.id,
              orgId: input.orgId,
              actorId: input.actorId,
            }),
          )},
          now()
        )
        returning id
      `;
      const rows = await tx<readonly MailOutboundRow[]>`
        update mail_outbound_messages
        set
          outbox_id = ${outbox[0]?.id ?? null},
          status = 'queued',
          failed_at = null,
          dead_lettered_at = null,
          last_error = null,
          attempt_count = 0,
          next_attempt_at = now(),
          updated_at = now()
        where id = ${input.id} and org_id = ${input.orgId} and actor_id = ${input.actorId}
        returning *
      `;
      return rows[0] === undefined ? null : mapOutbound(rows[0]);
    });
  }
}
