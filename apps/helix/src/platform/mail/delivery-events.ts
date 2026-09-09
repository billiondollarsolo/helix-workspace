import { Readable } from "node:stream";
import type postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { verifyWebhookSignature } from "../webhooks/signatures.js";
import type { OutboundProviderStore } from "./admin-store.js";

const BODY_LIMIT = 256 * 1024;
const rawBodies = new WeakMap<object, Buffer>();
const routeParams = z.object({ orgId: z.string().uuid(), providerId: z.string().uuid() });
const eventSchema = z
  .object({
    providerEventId: z.string().trim().min(1).max(500),
    source: z.enum(["provider", "dsn"]),
    kind: z.enum(["accepted", "delivered", "deferred", "bounced", "complained"]),
    retryClass: z.enum(["none", "transient", "permanent"]),
    recipient: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
    providerMessageId: z.string().trim().min(1).max(1000).optional(),
    handoffKey: z.string().uuid().optional(),
    occurredAt: z.coerce.date(),
    diagnostic: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((value) => value.providerMessageId !== undefined || value.handoffKey !== undefined, {
    message: "providerMessageId or handoffKey is required",
  })
  .refine(
    (value) =>
      (value.kind === "deferred" && value.retryClass === "transient") ||
      (["bounced", "complained"].includes(value.kind) && value.retryClass === "permanent") ||
      (["accepted", "delivered"].includes(value.kind) && value.retryClass === "none"),
    { message: "retryClass does not match event kind" },
  );

export type MailDeliveryEventKind = z.infer<typeof eventSchema>["kind"];
export type MailDeliveryRetryClass = z.infer<typeof eventSchema>["retryClass"];

export interface MailDeliveryEventInput {
  readonly orgId: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly source: "provider" | "dsn";
  readonly kind: MailDeliveryEventKind;
  readonly retryClass: MailDeliveryRetryClass;
  readonly recipient: string;
  readonly providerMessageId?: string | undefined;
  readonly handoffKey?: string | undefined;
  readonly occurredAt: Date;
  readonly diagnostic?: string | undefined;
}

export interface MailDeliveryEventRecord {
  readonly id: string;
  readonly outboundId: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly source: "provider" | "dsn";
  readonly kind: MailDeliveryEventKind;
  readonly retryClass: MailDeliveryRetryClass;
  readonly recipient: string;
  readonly diagnostic: string | null;
  readonly occurredAt: Date;
  readonly duplicate: boolean;
}

export interface MailSuppressionRecord {
  readonly id: string;
  readonly address: string;
  readonly reason: "hard_bounce" | "complaint" | "manual";
  readonly createdAt: Date;
}

export interface MailDeliveryEventStore {
  record(input: MailDeliveryEventInput): Promise<MailDeliveryEventRecord | null>;
  listEvents(orgId: string, limit?: number): Promise<readonly MailDeliveryEventRecord[]>;
  listSuppressions(orgId: string, limit?: number): Promise<readonly MailSuppressionRecord[]>;
  removeSuppression(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<boolean>;
}

interface EventRow {
  readonly id: string;
  readonly outbound_id: string;
  readonly provider_id: string;
  readonly provider_event_id: string;
  readonly source: "provider" | "dsn";
  readonly kind: MailDeliveryEventKind;
  readonly retry_class: MailDeliveryRetryClass;
  readonly recipient: string;
  readonly diagnostic: string | null;
  readonly occurred_at: Date;
}

export class PostgresMailDeliveryEventStore implements MailDeliveryEventStore {
  constructor(private readonly sql: postgres.Sql) {}

  async record(input: MailDeliveryEventInput): Promise<MailDeliveryEventRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const outbound = await tx<{ readonly id: string }[]>`
        select outbound.id from mail_outbound_messages outbound
        join mail_outbound_providers provider
          on provider.org_id = outbound.org_id and provider.id = ${input.providerId}
        where outbound.org_id = ${input.orgId}
          and outbound.delivery_metadata->>'providerId' = provider.id::text
          and (
            (${input.providerMessageId ?? null}::text is not null and outbound.provider_message_id = ${input.providerMessageId ?? null})
            or (${input.handoffKey ?? null}::uuid is not null and outbound.handoff_key = ${input.handoffKey ?? null}::uuid)
          )
        limit 1 for update
      `;
      if (outbound[0] === undefined) return null;
      const inserted = await tx<EventRow[]>`
        insert into mail_delivery_events (
          org_id, provider_id, outbound_id, provider_event_id, source, kind, retry_class,
          recipient, diagnostic, occurred_at
        ) values (
          ${input.orgId}, ${input.providerId}, ${outbound[0].id}, ${input.providerEventId}, ${input.source},
          ${input.kind}, ${input.retryClass}, ${input.recipient}, ${input.diagnostic ?? null},
          ${input.occurredAt}
        )
        on conflict (org_id, provider_id, provider_event_id) do nothing
        returning *
      `;
      if (inserted[0] === undefined) {
        const prior = await tx<EventRow[]>`
          select * from mail_delivery_events
          where org_id = ${input.orgId} and provider_id = ${input.providerId}
            and provider_event_id = ${input.providerEventId}
        `;
        return prior[0] === undefined ? null : mapEvent(prior[0], true);
      }

      await tx`
        update mail_outbound_messages set
          status = case
            when ${input.kind}::text = 'complained' then 'complained'::mail_outbound_status
            when ${input.kind}::text = 'bounced' and status <> 'complained' then 'bounced'::mail_outbound_status
            when ${input.kind}::text = 'delivered' and status not in ('bounced', 'complained') then 'delivered'::mail_outbound_status
            when ${input.kind}::text = 'deferred' and status in ('accepted', 'deferred') then 'deferred'::mail_outbound_status
            when ${input.kind}::text = 'accepted' and status in ('sending', 'accepted') then 'accepted'::mail_outbound_status
            else status
          end,
          last_error = case when ${input.kind}::text in ('deferred', 'bounced', 'complained')
            then ${input.diagnostic ?? input.kind} else null end,
          delivery_metadata = delivery_metadata || ${tx.json({
            lastEvent: {
              kind: input.kind,
              retryClass: input.retryClass,
              recipient: input.recipient,
              source: input.source,
              occurredAt: input.occurredAt.toISOString(),
            },
          })},
          updated_at = now()
        where org_id = ${input.orgId} and id = ${outbound[0].id}
      `;
      if (input.kind === "bounced" || input.kind === "complained") {
        await tx`
          insert into mail_suppressions (org_id, address, reason, source_event_id)
          values (
            ${input.orgId}, ${input.recipient},
            ${input.kind === "bounced" ? "hard_bounce" : "complaint"}, ${inserted[0].id}
          ) on conflict (org_id, address) where removed_at is null do nothing
        `;
      }
      return mapEvent(inserted[0], false);
    });
  }

  async listEvents(orgId: string, limit = 100): Promise<readonly MailDeliveryEventRecord[]> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<EventRow[]>`
        select * from mail_delivery_events where org_id = ${orgId}
        order by occurred_at desc, id desc limit ${boundedLimit(limit)}
      `;
      return rows.map((row) => mapEvent(row, false));
    });
  }

  async listSuppressions(orgId: string, limit = 100): Promise<readonly MailSuppressionRecord[]> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<
        { readonly id: string; readonly address: string; readonly reason: MailSuppressionRecord["reason"]; readonly created_at: Date }[]
      >`
        select id, address, reason, created_at from mail_suppressions
        where org_id = ${orgId} and removed_at is null
        order by created_at desc, id desc limit ${boundedLimit(limit)}
      `;
      return rows.map((row) => ({
        id: row.id,
        address: row.address,
        reason: row.reason,
        createdAt: row.created_at,
      }));
    });
  }

  async removeSuppression(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId: string;
    readonly reason: string;
  }): Promise<boolean> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) =>
        (
          await tx<{ readonly id: string }[]>`
            update mail_suppressions set removed_at = now(), removed_by = ${input.actorId},
              remove_reason = ${input.reason}
            where org_id = ${input.orgId} and id = ${input.id} and removed_at is null returning id
          `
        ).length > 0,
    );
  }
}

export function registerMailDeliveryEventRoutes(
  app: FastifyInstance,
  options: {
    readonly store: Pick<MailDeliveryEventStore, "record">;
    readonly providerStore: Pick<OutboundProviderStore, "getProvider">;
    readonly resolveSecret: (orgId: string, handle: string) => Promise<string | undefined>;
    readonly now?: (() => Date) | undefined;
  },
): void {
  app.post(
    "/internal/mail/delivery-events/:orgId/:providerId",
    {
      bodyLimit: BODY_LIMIT,
      preParsing: async (request, _reply, payload) => {
        const raw = await readBody(payload, BODY_LIMIT);
        rawBodies.set(request, raw);
        const replay = Readable.from(raw);
        (replay as Readable & { receivedEncodedLength?: number }).receivedEncodedLength = raw.length;
        return replay;
      },
    },
    async (request, reply) => {
      const params = routeParams.safeParse(request.params);
      const raw = rawBodies.get(request);
      if (!params.success) return reply.code(400).send({ error: "Invalid delivery event route." });
      const provider = await options.providerStore.getProvider(
        params.data.orgId,
        params.data.providerId,
      );
      if (provider === null || !provider.enabled || provider.webhookSecretRef === null) {
        return reply.code(401).send({ error: "Delivery feedback is not configured." });
      }
      const secret = await options.resolveSecret(params.data.orgId, provider.webhookSecretRef);
      const signature = request.headers["x-helix-signature"];
      if (
        raw === undefined ||
        secret === undefined ||
        secret.length === 0 ||
        typeof signature !== "string" ||
        !verifyWebhookSignature({
          payload: raw,
          secret,
          header: signature,
          now: options.now?.() ?? new Date(),
        })
      ) {
        return reply.code(401).send({ error: "Invalid delivery event signature." });
      }
      const body = eventSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid delivery event." });
      const event = await options.store.record({
        ...body.data,
        orgId: params.data.orgId,
        providerId: params.data.providerId,
      });
      if (event === null) return reply.code(404).send({ error: "Outbound message not found." });
      return reply.code(event.duplicate ? 200 : 202).send({ accepted: true, duplicate: event.duplicate });
    },
  );
}

function mapEvent(row: EventRow, duplicate: boolean): MailDeliveryEventRecord {
  return {
    id: row.id,
    outboundId: row.outbound_id,
    providerId: row.provider_id,
    providerEventId: row.provider_event_id,
    source: row.source,
    kind: row.kind,
    retryClass: row.retry_class,
    recipient: row.recipient,
    diagnostic: row.diagnostic,
    occurredAt: row.occurred_at,
    duplicate,
  };
}

function boundedLimit(limit: number): number {
  return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
}

async function readBody(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    length += bytes.length;
    if (length > limit) throw new Error("Delivery event body is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
