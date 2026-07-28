import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { normalizeMailboxAddress } from "./address-normalization.js";
import type { AdminConsoleAuditSink } from "../admin/console-shared.js";
import { auditAdminAction } from "../admin/console-shared.js";
import { verifyWebhookSignature } from "../webhooks/signatures.js";

export const MAIL_DELIVERY_EVENT_TYPES = [
  "delivered",
  "delayed",
  "soft_bounce",
  "hard_bounce",
  "complaint",
  "rejected",
] as const;

export type MailDeliveryEventType = (typeof MAIL_DELIVERY_EVENT_TYPES)[number];

export interface NormalizedMailDeliveryEvent {
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly recipient: string;
  readonly type: MailDeliveryEventType;
  readonly occurredAt: Date;
  /** Provider-safe diagnostics only. Raw webhook payloads are never stored. */
  readonly metadata: JsonObject;
}

export interface MailDeliveryEventRecord extends NormalizedMailDeliveryEvent {
  readonly id: string;
  readonly orgId: string;
  readonly providerId: string;
  readonly outboundId: string | null;
  readonly normalizedRecipient: string;
  readonly createdAt: Date;
}

export interface MailSuppressionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly normalizedRecipient: string;
  readonly reason: "hard_bounce" | "complaint";
  readonly sourceEventId: string;
  readonly createdAt: Date;
  readonly clearedAt: Date | null;
  readonly clearedBy: string | null;
  readonly clearReason: string | null;
}

export interface IngestMailDeliveryEventResult {
  readonly event: MailDeliveryEventRecord;
  readonly duplicate: boolean;
  readonly outboundMatched: boolean;
  readonly suppressed: boolean;
}

export interface MailDeliveryEventStore {
  ingestEvent(input: {
    readonly orgId: string;
    readonly providerId: string;
    readonly event: NormalizedMailDeliveryEvent;
  }): Promise<IngestMailDeliveryEventResult>;
  findActiveSuppressions(
    orgId: string,
    normalizedRecipients: readonly string[],
  ): Promise<readonly MailSuppressionRecord[]>;
  listEvents(input: {
    readonly orgId: string;
    readonly outboundId: string;
  }): Promise<readonly MailDeliveryEventRecord[]>;
  clearSuppression(input: {
    readonly orgId: string;
    readonly id: string;
    readonly clearedBy: string;
    readonly reason: string;
    readonly clearedAt?: Date;
  }): Promise<MailSuppressionRecord | null>;
  countEvents(input: {
    readonly orgId: string;
    readonly types: readonly MailDeliveryEventType[];
    readonly since: Date;
  }): Promise<number>;
}

interface DeliveryEventRow {
  readonly id: string;
  readonly org_id: string;
  readonly provider_id: string;
  readonly outbound_id: string | null;
  readonly provider_event_id: string;
  readonly provider_message_id: string;
  readonly normalized_recipient: string;
  readonly event_type: MailDeliveryEventType;
  readonly occurred_at: Date;
  readonly metadata: JsonObject;
  readonly created_at: Date;
}

interface SuppressionRow {
  readonly id: string;
  readonly org_id: string;
  readonly normalized_recipient: string;
  readonly reason: "hard_bounce" | "complaint";
  readonly source_event_id: string;
  readonly created_at: Date;
  readonly cleared_at: Date | null;
  readonly cleared_by: string | null;
  readonly clear_reason: string | null;
}

export class PostgresMailDeliveryEventStore implements MailDeliveryEventStore {
  constructor(private readonly sql: postgres.Sql) {}

  async ingestEvent(input: {
    readonly orgId: string;
    readonly providerId: string;
    readonly event: NormalizedMailDeliveryEvent;
  }): Promise<IngestMailDeliveryEventResult> {
    const normalizedRecipient = normalizeMailboxAddress(input.event.recipient).address;
    return this.sql.begin(async (tx) => {
      const inserted = (await tx`
        insert into mail_provider_delivery_events (
          org_id, provider_id, outbound_id, provider_event_id, provider_message_id,
          normalized_recipient, event_type, occurred_at, metadata
        )
        select
          ${input.orgId},
          ${input.providerId},
          outbound.id,
          ${input.event.providerEventId},
          ${input.event.providerMessageId},
          ${normalizedRecipient},
          ${input.event.type},
          ${input.event.occurredAt},
          ${tx.json(toSqlJson(input.event.metadata))}
        from (values (1)) as seed(value)
        left join lateral (
          select id
          from mail_outbound_messages
          where org_id = ${input.orgId}
            and provider_id = ${input.providerId}
            and provider_message_id = ${input.event.providerMessageId}
          order by created_at desc
          limit 1
        ) outbound on true
        on conflict (org_id, provider_id, provider_event_id) do nothing
        returning *
      `) as unknown as readonly DeliveryEventRow[];

      let row = inserted[0];
      const duplicate = row === undefined;
      if (row === undefined) {
        const existing = (await tx`
          select *
          from mail_provider_delivery_events
          where org_id = ${input.orgId}
            and provider_id = ${input.providerId}
            and provider_event_id = ${input.event.providerEventId}
          limit 1
        `) as unknown as readonly DeliveryEventRow[];
        row = existing[0];
      }
      if (row === undefined) {
        throw new Error("Unable to persist provider delivery event.");
      }

      let suppressed = false;
      if (!duplicate && (input.event.type === "hard_bounce" || input.event.type === "complaint")) {
        await tx`
          insert into mail_suppressions (
            org_id, normalized_recipient, reason, source_event_id
          )
          values (
            ${input.orgId}, ${normalizedRecipient}, ${input.event.type}, ${row.id}
          )
          on conflict (org_id, normalized_recipient) where cleared_at is null
          do update set
            reason = excluded.reason,
            source_event_id = excluded.source_event_id,
            updated_at = now()
        `;
        suppressed = true;
      }

      if (!duplicate && row.outbound_id !== null) {
        await tx`
          update mail_outbound_messages
          set
            delivery_status = ${input.event.type},
            delivery_event_at = ${input.event.occurredAt},
            delivery_metadata = delivery_metadata || ${tx.json(
              toSqlJson({
                latestEvent: input.event.type,
                latestEventAt: input.event.occurredAt.toISOString(),
                latestRecipient: normalizedRecipient,
              }),
            )},
            updated_at = now()
          where id = ${row.outbound_id}
            and org_id = ${input.orgId}
            and provider_id = ${input.providerId}
            and (
              delivery_event_at is null
              or delivery_event_at <= ${input.event.occurredAt}
            )
        `;
      }

      return {
        event: mapEvent(row),
        duplicate,
        outboundMatched: row.outbound_id !== null,
        suppressed,
      };
    });
  }

  async findActiveSuppressions(
    orgId: string,
    normalizedRecipients: readonly string[],
  ): Promise<readonly MailSuppressionRecord[]> {
    if (normalizedRecipients.length === 0) return [];
    const recipients = normalizedRecipients.map(
      (recipient) => normalizeMailboxAddress(recipient).address,
    );
    const rows = (await this.sql`
      select *
      from mail_suppressions
      where org_id = ${orgId}
        and normalized_recipient = any(${recipients})
        and cleared_at is null
      order by created_at asc
    `) as unknown as readonly SuppressionRow[];
    return rows.map(mapSuppression);
  }

  async listEvents(input: {
    readonly orgId: string;
    readonly outboundId: string;
  }): Promise<readonly MailDeliveryEventRecord[]> {
    const rows = (await this.sql`
      select *
      from mail_provider_delivery_events
      where org_id = ${input.orgId} and outbound_id = ${input.outboundId}
      order by occurred_at asc, created_at asc, id asc
    `) as unknown as readonly DeliveryEventRow[];
    return rows.map(mapEvent);
  }

  async clearSuppression(input: {
    readonly orgId: string;
    readonly id: string;
    readonly clearedBy: string;
    readonly reason: string;
    readonly clearedAt?: Date;
  }): Promise<MailSuppressionRecord | null> {
    const rows = (await this.sql`
      update mail_suppressions
      set
        cleared_at = ${input.clearedAt ?? new Date()},
        cleared_by = ${input.clearedBy},
        clear_reason = ${input.reason},
        updated_at = now()
      where org_id = ${input.orgId}
        and id = ${input.id}
        and cleared_at is null
      returning *
    `) as unknown as readonly SuppressionRow[];
    return rows[0] === undefined ? null : mapSuppression(rows[0]);
  }

  async countEvents(input: {
    readonly orgId: string;
    readonly types: readonly MailDeliveryEventType[];
    readonly since: Date;
  }): Promise<number> {
    const rows = (await this.sql`
      select count(*)::int as count
      from mail_provider_delivery_events
      where org_id = ${input.orgId}
        and event_type = any(${input.types})
        and occurred_at >= ${input.since}
    `) as unknown as readonly { readonly count: number }[];
    return rows[0]?.count ?? 0;
  }
}

/** Deterministic tenant-safe adapter for focused routing/webhook tests. */
export class InMemoryMailDeliveryEventStore implements MailDeliveryEventStore {
  readonly #events = new Map<string, MailDeliveryEventRecord>();
  readonly #suppressions = new Map<string, MailSuppressionRecord>();
  readonly #latestByOutbound = new Map<
    string,
    { readonly type: MailDeliveryEventType; readonly occurredAt: Date }
  >();

  constructor(
    private readonly outboundBindings: readonly {
      readonly id: string;
      readonly orgId: string;
      readonly providerId: string;
      readonly providerMessageId: string;
    }[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {}

  async ingestEvent(input: {
    readonly orgId: string;
    readonly providerId: string;
    readonly event: NormalizedMailDeliveryEvent;
  }): Promise<IngestMailDeliveryEventResult> {
    const key = `${input.orgId}:${input.providerId}:${input.event.providerEventId}`;
    const existing = this.#events.get(key);
    if (existing !== undefined) {
      return {
        event: existing,
        duplicate: true,
        outboundMatched: existing.outboundId !== null,
        suppressed: false,
      };
    }
    const normalizedRecipient = normalizeMailboxAddress(input.event.recipient).address;
    const outbound =
      this.outboundBindings.find(
        (candidate) =>
          candidate.orgId === input.orgId &&
          candidate.providerId === input.providerId &&
          candidate.providerMessageId === input.event.providerMessageId,
      ) ?? null;
    const event: MailDeliveryEventRecord = {
      ...input.event,
      id: randomUUID(),
      orgId: input.orgId,
      providerId: input.providerId,
      outboundId: outbound?.id ?? null,
      recipient: normalizedRecipient,
      normalizedRecipient,
      createdAt: this.now(),
    };
    this.#events.set(key, event);
    if (event.outboundId !== null) {
      const outboundKey = `${event.orgId}:${event.outboundId}`;
      const latest = this.#latestByOutbound.get(outboundKey);
      if (latest === undefined || latest.occurredAt <= event.occurredAt) {
        this.#latestByOutbound.set(outboundKey, {
          type: event.type,
          occurredAt: event.occurredAt,
        });
      }
    }
    const suppressed = event.type === "hard_bounce" || event.type === "complaint";
    if (suppressed) {
      const suppressionKey = `${input.orgId}:${normalizedRecipient}`;
      const current = this.#suppressions.get(suppressionKey);
      if (current === undefined || current.clearedAt !== null) {
        this.#suppressions.set(suppressionKey, {
          id: randomUUID(),
          orgId: input.orgId,
          normalizedRecipient,
          reason: event.type,
          sourceEventId: event.id,
          createdAt: this.now(),
          clearedAt: null,
          clearedBy: null,
          clearReason: null,
        });
      }
    }
    return {
      event,
      duplicate: false,
      outboundMatched: outbound !== null,
      suppressed,
    };
  }

  async findActiveSuppressions(
    orgId: string,
    normalizedRecipients: readonly string[],
  ): Promise<readonly MailSuppressionRecord[]> {
    const wanted = new Set(
      normalizedRecipients.map((recipient) => normalizeMailboxAddress(recipient).address),
    );
    return [...this.#suppressions.values()].filter(
      (suppression) =>
        suppression.orgId === orgId &&
        suppression.clearedAt === null &&
        wanted.has(suppression.normalizedRecipient),
    );
  }

  async listEvents(input: {
    readonly orgId: string;
    readonly outboundId: string;
  }): Promise<readonly MailDeliveryEventRecord[]> {
    return [...this.#events.values()]
      .filter((event) => event.orgId === input.orgId && event.outboundId === input.outboundId)
      .sort(
        (left, right) =>
          left.occurredAt.getTime() - right.occurredAt.getTime() ||
          left.createdAt.getTime() - right.createdAt.getTime(),
      );
  }

  async clearSuppression(input: {
    readonly orgId: string;
    readonly id: string;
    readonly clearedBy: string;
    readonly reason: string;
    readonly clearedAt?: Date;
  }): Promise<MailSuppressionRecord | null> {
    const entry = [...this.#suppressions.entries()].find(
      ([, suppression]) =>
        suppression.orgId === input.orgId &&
        suppression.id === input.id &&
        suppression.clearedAt === null,
    );
    if (entry === undefined) return null;
    const [key, current] = entry;
    const cleared = {
      ...current,
      clearedAt: input.clearedAt ?? this.now(),
      clearedBy: input.clearedBy,
      clearReason: input.reason,
    };
    this.#suppressions.set(key, cleared);
    return cleared;
  }

  async countEvents(input: {
    readonly orgId: string;
    readonly types: readonly MailDeliveryEventType[];
    readonly since: Date;
  }): Promise<number> {
    return [...this.#events.values()].filter(
      (event) =>
        event.orgId === input.orgId &&
        input.types.includes(event.type) &&
        event.occurredAt >= input.since,
    ).length;
  }

  getLatestDeliveryStatus(orgId: string, outboundId: string): MailDeliveryEventType | null {
    return this.#latestByOutbound.get(`${orgId}:${outboundId}`)?.type ?? null;
  }
}

export interface MailDeliveryAlert {
  readonly orgId: string;
  readonly category: "bounce" | "complaint";
  readonly count: number;
  readonly windowMinutes: number;
  readonly threshold: number;
}

export class MailDeliveryAlertMonitor {
  constructor(
    private readonly options: {
      readonly store: MailDeliveryEventStore;
      readonly emit: (alert: MailDeliveryAlert) => void | Promise<void>;
      readonly bounceThreshold?: number;
      readonly complaintThreshold?: number;
      readonly windowMinutes?: number;
      readonly now?: () => Date;
    },
  ) {}

  async observe(orgId: string, type: MailDeliveryEventType): Promise<void> {
    const category =
      type === "complaint"
        ? "complaint"
        : type === "hard_bounce" || type === "soft_bounce"
          ? "bounce"
          : null;
    if (category === null) return;
    const threshold =
      category === "complaint"
        ? (this.options.complaintThreshold ?? 1)
        : (this.options.bounceThreshold ?? 10);
    const windowMinutes = this.options.windowMinutes ?? 15;
    const now = this.options.now?.() ?? new Date();
    const types: readonly MailDeliveryEventType[] =
      category === "complaint" ? ["complaint"] : ["hard_bounce", "soft_bounce"];
    const count = await this.options.store.countEvents({
      orgId,
      types,
      since: new Date(now.getTime() - windowMinutes * 60_000),
    });
    if (count >= threshold) {
      await this.options.emit({ orgId, category, count, windowMinutes, threshold });
    }
  }
}

export async function clearMailSuppressionWithAudit(input: {
  readonly store: MailDeliveryEventStore;
  readonly auditSink: AdminConsoleAuditSink;
  readonly orgId: string;
  readonly actorId: string;
  readonly suppressionId: string;
  readonly reason: string;
}): Promise<MailSuppressionRecord | null> {
  const cleared = await input.store.clearSuppression({
    orgId: input.orgId,
    id: input.suppressionId,
    clearedBy: input.actorId,
    reason: input.reason,
  });
  if (cleared === null) return null;
  await auditAdminAction(input.auditSink, {
    orgId: input.orgId,
    actorId: input.actorId,
    verb: "mail.suppression.cleared",
    objectType: "mail_suppression",
    objectId: cleared.id,
    metadata: {
      recipient: cleared.normalizedRecipient,
      priorReason: cleared.reason,
      clearReason: input.reason,
    },
  });
  return cleared;
}

export interface VerifyAndIngestProviderWebhookInput {
  readonly orgId: string;
  readonly providerId: string;
  readonly providerKind: "mailgun";
  readonly rawBody: Buffer;
  readonly signatureHeader: string;
  readonly signingSecret: string;
  readonly store: MailDeliveryEventStore;
  readonly now?: Date | number;
  readonly replayToleranceSeconds?: number;
  readonly onSignatureFailure?: (input: {
    readonly orgId: string;
    readonly providerId: string;
  }) => void;
  readonly alertMonitor?: MailDeliveryAlertMonitor;
}

/**
 * Verify the exact request bytes before parsing, enforce the timestamp window,
 * normalize the provider payload, and rely on the durable event key for replay
 * idempotency inside that window.
 */
export async function verifyAndIngestProviderWebhook(
  input: VerifyAndIngestProviderWebhookInput,
): Promise<IngestMailDeliveryEventResult> {
  const verified = verifyWebhookSignature({
    payload: input.rawBody,
    secret: input.signingSecret,
    header: input.signatureHeader,
    toleranceSeconds: input.replayToleranceSeconds ?? 300,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!verified) {
    input.onSignatureFailure?.({ orgId: input.orgId, providerId: input.providerId });
    throw new ProviderWebhookVerificationError();
  }
  const raw: unknown = JSON.parse(input.rawBody.toString("utf8"));
  const event = normalizeMailgunDeliveryEvent(raw);
  const result = await input.store.ingestEvent({
    orgId: input.orgId,
    providerId: input.providerId,
    event,
  });
  await input.alertMonitor?.observe(input.orgId, event.type);
  return result;
}

export class ProviderWebhookVerificationError extends Error {
  constructor() {
    super("Provider webhook signature is invalid, expired, or malformed.");
    this.name = "ProviderWebhookVerificationError";
  }
}

export class ProviderWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderWebhookPayloadError";
  }
}

/** Normalize the Mailgun v3 event-data envelope without retaining raw data. */
export function normalizeMailgunDeliveryEvent(raw: unknown): NormalizedMailDeliveryEvent {
  const root = objectValue(raw, "Mailgun webhook");
  const data = objectValue(root["event-data"], "Mailgun event-data");
  const eventName = stringValue(data.event, "event");
  const severity = typeof data.severity === "string" ? data.severity : undefined;
  const type = mailgunEventType(eventName, severity);
  const recipient = stringValue(data.recipient, "recipient");
  const providerEventId = stringValue(data.id, "id");
  const message = objectValue(data.message, "message");
  const headers = objectValue(message.headers, "message.headers");
  const providerMessageId = stringValue(headers["message-id"], "message.headers.message-id");
  const timestamp = numberValue(data.timestamp, "timestamp");
  const deliveryStatus =
    data["delivery-status"] === undefined
      ? undefined
      : objectValue(data["delivery-status"], "delivery-status");
  return {
    providerEventId,
    providerMessageId,
    recipient,
    type,
    occurredAt: new Date(timestamp * 1000),
    metadata: compactJson({
      provider: "mailgun",
      event: eventName,
      severity: severity ?? null,
      code:
        deliveryStatus !== undefined && typeof deliveryStatus.code === "number"
          ? deliveryStatus.code
          : null,
      description:
        deliveryStatus !== undefined && typeof deliveryStatus.description === "string"
          ? deliveryStatus.description.slice(0, 500)
          : null,
    }),
  };
}

function mailgunEventType(event: string, severity: string | undefined): MailDeliveryEventType {
  switch (event) {
    case "delivered":
      return "delivered";
    case "complained":
      return "complaint";
    case "rejected":
      return "rejected";
    case "failed":
      return severity === "temporary" ? "soft_bounce" : "hard_bounce";
    case "accepted":
    case "stored":
      return "delayed";
    default:
      throw new ProviderWebhookPayloadError(`Unsupported Mailgun delivery event: ${event}`);
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderWebhookPayloadError(`Invalid ${field}.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderWebhookPayloadError(`Invalid ${field}.`);
  }
  return value;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProviderWebhookPayloadError(`Invalid ${field}.`);
  }
  return value;
}

function compactJson(value: Record<string, JsonObject[string] | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as JsonObject;
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function mapEvent(row: DeliveryEventRow): MailDeliveryEventRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    providerId: row.provider_id,
    outboundId: row.outbound_id,
    providerEventId: row.provider_event_id,
    providerMessageId: row.provider_message_id,
    recipient: row.normalized_recipient,
    normalizedRecipient: row.normalized_recipient,
    type: row.event_type,
    occurredAt: row.occurred_at,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function mapSuppression(row: SuppressionRow): MailSuppressionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    normalizedRecipient: row.normalized_recipient,
    reason: row.reason,
    sourceEventId: row.source_event_id,
    createdAt: row.created_at,
    clearedAt: row.cleared_at,
    clearedBy: row.cleared_by,
    clearReason: row.clear_reason,
  };
}
