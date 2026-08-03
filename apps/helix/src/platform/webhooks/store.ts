import { randomUUID } from "node:crypto";
import type { JsonValue } from "@helix/sdk-types";
import type postgres from "postgres";
import { randomBytes, sha256Hex } from "../crypto/index.js";
import type { WebhookDeliveryStatus, WebhookDirection } from "./types.js";

export interface OutboundWebhookRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly url: string;
  readonly eventSubjects: readonly string[];
  readonly secretRef: string | null;
  readonly headers: Record<string, string>;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InboundWebhookRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly source: string;
  readonly secretRef: string | null;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId: string | null;
  readonly lastReceivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly orgId: string;
  readonly direction: WebhookDirection;
  readonly outboundWebhookId: string | null;
  readonly inboundWebhookId: string | null;
  readonly eventSubject: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt: number;
  readonly payload: unknown;
  readonly payloadSha256: string | null;
  readonly signature: string | null;
  readonly requestHeaders: Record<string, string>;
  readonly responseStatus: number | null;
  readonly responseHeaders: Record<string, string>;
  readonly error: string | null;
  readonly nextAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateOutboundWebhookInput {
  readonly orgId: string;
  readonly name: string;
  readonly url: string;
  readonly eventSubjects: readonly string[];
  readonly secretRef?: string | null | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly enabled?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly createdByActorId?: string | null | undefined;
}

export interface CreateInboundWebhookInput {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly source: string;
  readonly secretRef?: string | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly createdByActorId?: string | null | undefined;
}

export interface OutboundWebhookPatch {
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly eventSubjects?: readonly string[] | undefined;
  readonly secretRef?: string | null | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly enabled?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface InboundWebhookPatch {
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
  readonly source?: string | undefined;
  readonly secretRef?: string | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface CreateWebhookDeliveryInput {
  readonly id?: string | undefined;
  readonly orgId: string;
  readonly direction: WebhookDirection;
  readonly outboundWebhookId?: string | null;
  readonly inboundWebhookId?: string | null;
  readonly eventSubject: string;
  readonly status?: WebhookDeliveryStatus;
  readonly attempt?: number;
  readonly payload: unknown;
  readonly payloadSha256?: string | null;
  readonly signature?: string | null;
  readonly requestHeaders?: Record<string, string>;
  readonly responseStatus?: number | null;
  readonly responseHeaders?: Record<string, string>;
  readonly error?: string | null;
  readonly nextAttemptAt?: Date | null;
  readonly deliveredAt?: Date | null;
}

export interface UpdateWebhookDeliveryStatusInput {
  readonly id: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt?: number | undefined;
  readonly signature?: string | null | undefined;
  readonly requestHeaders?: Record<string, string> | undefined;
  readonly responseStatus?: number | null | undefined;
  readonly responseHeaders?: Record<string, string> | undefined;
  readonly error?: string | null | undefined;
  readonly nextAttemptAt?: Date | null | undefined;
  readonly deliveredAt?: Date | null | undefined;
}

interface OutboundWebhookRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly url: string;
  readonly event_subjects: readonly string[];
  readonly secret_ref: string | null;
  readonly headers: Record<string, string>;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface InboundWebhookRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly slug: string;
  readonly source: string;
  readonly secret_ref: string | null;
  readonly enabled: boolean;
  readonly metadata: Record<string, unknown>;
  readonly created_by_actor_id: string | null;
  readonly last_received_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface WebhookDeliveryRow {
  readonly id: string;
  readonly org_id: string;
  readonly direction: WebhookDirection;
  readonly outbound_webhook_id: string | null;
  readonly inbound_webhook_id: string | null;
  readonly event_subject: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt: number;
  readonly payload: unknown;
  readonly payload_sha256: string | null;
  readonly signature: string | null;
  readonly request_headers: Record<string, string>;
  readonly response_status: number | null;
  readonly response_headers: Record<string, string>;
  readonly error: string | null;
  readonly next_attempt_at: Date | null;
  readonly delivered_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface OutboundWebhookQuotaRow {
  readonly outbound_webhooks_limit: JsonValue | null;
  readonly active_outbound_webhook_count: string | number;
}

export class OutboundWebhookQuotaExceededError extends Error {
  constructor(
    readonly orgId: string,
    readonly limit: number,
    readonly used: number,
  ) {
    super(`Tenant outbound webhook quota exceeded: ${String(used)}/${String(limit)} endpoints.`);
    this.name = "OutboundWebhookQuotaExceededError";
  }
}

export class PostgresWebhookStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createOutbound(input: CreateOutboundWebhookInput): Promise<OutboundWebhookRecord> {
    return this.sql.begin(async (tx) => {
      await assertOutboundWebhookQuotaAvailable(tx, input.orgId);
      const rows = (await tx`
        insert into outbound_webhooks (
          org_id, name, url, event_subjects, secret_ref, headers, enabled, metadata, created_by_actor_id
        )
        values (
          ${input.orgId},
          ${input.name},
          ${input.url},
          ${tx.array([...input.eventSubjects])},
          ${input.secretRef ?? createInlineSecret()},
          ${tx.json(toSqlJson(input.headers ?? {}))},
          ${input.enabled ?? true},
          ${tx.json(toSqlJson(input.metadata ?? {}))},
          ${input.createdByActorId ?? null}
        )
        returning *
      `) as unknown as readonly OutboundWebhookRow[];
      return mapOutbound(rows[0]);
    });
  }

  async updateOutbound(input: {
    readonly orgId: string;
    readonly id: string;
    readonly patch: OutboundWebhookPatch;
  }): Promise<OutboundWebhookRecord | null> {
    const current = await this.getOutbound(input.orgId, input.id);
    if (current === null) {
      return null;
    }
    const rows = (await this.sql`
      update outbound_webhooks
      set
        name = ${input.patch.name ?? current.name},
        url = ${input.patch.url ?? current.url},
        event_subjects = ${this.sql.array([...(input.patch.eventSubjects ?? current.eventSubjects)])},
        secret_ref = ${input.patch.secretRef === undefined ? current.secretRef : input.patch.secretRef},
        headers = ${this.sql.json(toSqlJson(input.patch.headers ?? current.headers))},
        enabled = ${input.patch.enabled ?? current.enabled},
        metadata = ${this.sql.json(toSqlJson(input.patch.metadata ?? current.metadata))},
        updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id} and deleted_at is null
      returning *
    `) as unknown as readonly OutboundWebhookRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async deleteOutbound(orgId: string, id: string): Promise<boolean> {
    const rows = await this.sql`
      update outbound_webhooks
      set deleted_at = now(), enabled = false, updated_at = now()
      where org_id = ${orgId} and id = ${id} and deleted_at is null
      returning id
    `;
    return rows.count > 0;
  }

  async getOutbound(orgId: string, id: string): Promise<OutboundWebhookRecord | null> {
    const rows = (await this.sql`
      select * from outbound_webhooks
      where org_id = ${orgId} and id = ${id} and deleted_at is null
      limit 1
    `) as unknown as readonly OutboundWebhookRow[];
    return rows[0] === undefined ? null : mapOutbound(rows[0]);
  }

  async listOutbound(orgId: string): Promise<readonly OutboundWebhookRecord[]> {
    const rows = (await this.sql`
      select * from outbound_webhooks
      where org_id = ${orgId} and deleted_at is null
      order by created_at desc
    `) as unknown as readonly OutboundWebhookRow[];
    return rows.map(mapOutbound);
  }

  async listEnabledOutbound(): Promise<readonly OutboundWebhookRecord[]> {
    const rows = (await this.sql`
      select * from outbound_webhooks
      where enabled = true and deleted_at is null
      order by created_at desc
    `) as unknown as readonly OutboundWebhookRow[];
    return rows.map(mapOutbound);
  }

  async createInbound(input: CreateInboundWebhookInput): Promise<InboundWebhookRecord> {
    const rows = (await this.sql`
      insert into inbound_webhooks (
        org_id, name, slug, source, secret_ref, enabled, metadata, created_by_actor_id
      )
      values (
        ${input.orgId},
        ${input.name},
        ${input.slug},
        ${input.source},
        ${input.secretRef ?? createInlineSecret()},
        ${input.enabled ?? true},
        ${this.sql.json(toSqlJson(input.metadata ?? {}))},
        ${input.createdByActorId ?? null}
      )
      returning *
    `) as unknown as readonly InboundWebhookRow[];
    return mapInbound(rows[0]);
  }

  async updateInbound(input: {
    readonly orgId: string;
    readonly id: string;
    readonly patch: InboundWebhookPatch;
  }): Promise<InboundWebhookRecord | null> {
    const current = await this.getInbound(input.orgId, input.id);
    if (current === null) {
      return null;
    }
    const rows = (await this.sql`
      update inbound_webhooks
      set
        name = ${input.patch.name ?? current.name},
        slug = ${input.patch.slug ?? current.slug},
        source = ${input.patch.source ?? current.source},
        secret_ref = ${input.patch.secretRef === undefined ? current.secretRef : input.patch.secretRef},
        enabled = ${input.patch.enabled ?? current.enabled},
        metadata = ${this.sql.json(toSqlJson(input.patch.metadata ?? current.metadata))},
        updated_at = now()
      where org_id = ${input.orgId} and id = ${input.id} and disabled_at is null
      returning *
    `) as unknown as readonly InboundWebhookRow[];
    return rows[0] === undefined ? null : mapInbound(rows[0]);
  }

  async deleteInbound(orgId: string, id: string): Promise<boolean> {
    const rows = await this.sql`
      update inbound_webhooks
      set disabled_at = now(), enabled = false, updated_at = now()
      where org_id = ${orgId} and id = ${id} and disabled_at is null
      returning id
    `;
    return rows.count > 0;
  }

  async rotateInboundSecret(
    orgId: string,
    id: string,
  ): Promise<{ readonly webhook: InboundWebhookRecord; readonly secretRef: string } | null> {
    const secretRef = createInlineSecret();
    const rows = (await this.sql`
      update inbound_webhooks
      set secret_ref = ${secretRef}, updated_at = now()
      where org_id = ${orgId} and id = ${id} and disabled_at is null
      returning *
    `) as unknown as readonly InboundWebhookRow[];
    return rows[0] === undefined ? null : { webhook: mapInbound(rows[0]), secretRef };
  }

  async getInbound(orgId: string, id: string): Promise<InboundWebhookRecord | null> {
    const rows = (await this.sql`
      select * from inbound_webhooks
      where org_id = ${orgId} and id = ${id} and disabled_at is null
      limit 1
    `) as unknown as readonly InboundWebhookRow[];
    return rows[0] === undefined ? null : mapInbound(rows[0]);
  }

  async getInboundBySlug(slug: string): Promise<InboundWebhookRecord | null> {
    const rows = (await this.sql`
      select * from inbound_webhooks
      where slug = ${slug} and enabled = true and disabled_at is null
      limit 1
    `) as unknown as readonly InboundWebhookRow[];
    return rows[0] === undefined ? null : mapInbound(rows[0]);
  }

  async listInbound(orgId: string): Promise<readonly InboundWebhookRecord[]> {
    const rows = (await this.sql`
      select * from inbound_webhooks
      where org_id = ${orgId} and disabled_at is null
      order by created_at desc
    `) as unknown as readonly InboundWebhookRow[];
    return rows.map(mapInbound);
  }

  async createDelivery(input: CreateWebhookDeliveryInput): Promise<WebhookDeliveryRecord> {
    const rows = (await this.sql`
      insert into webhook_deliveries (
        id, org_id, direction, outbound_webhook_id, inbound_webhook_id, event_subject,
        status, attempt, payload, payload_sha256, signature, request_headers,
        response_status, response_headers, error, next_attempt_at, delivered_at
      )
      values (
        ${input.id ?? randomUUID()},
        ${input.orgId},
        ${input.direction},
        ${input.outboundWebhookId ?? null},
        ${input.inboundWebhookId ?? null},
        ${input.eventSubject},
        ${input.status ?? "pending"},
        ${input.attempt ?? 0},
        ${this.sql.json(toSqlJson(input.payload))},
        ${input.payloadSha256 ?? sha256Json(input.payload)},
        ${input.signature ?? null},
        ${this.sql.json(toSqlJson(input.requestHeaders ?? {}))},
        ${input.responseStatus ?? null},
        ${this.sql.json(toSqlJson(input.responseHeaders ?? {}))},
        ${input.error ?? null},
        ${input.nextAttemptAt ?? null},
        ${input.deliveredAt ?? null}
      )
      returning *
    `) as unknown as readonly WebhookDeliveryRow[];
    return mapDelivery(rows[0]);
  }

  async updateDeliveryStatus(
    input: UpdateWebhookDeliveryStatusInput,
  ): Promise<WebhookDeliveryRecord | null> {
    const rows = (await this.sql`
      update webhook_deliveries
      set
        status = ${input.status},
        attempt = coalesce(${input.attempt ?? null}, attempt),
        signature = case when ${input.signature === undefined} then signature else ${input.signature ?? null} end,
        request_headers = case
          when ${input.requestHeaders === undefined} then request_headers
          else ${this.sql.json(toSqlJson(input.requestHeaders ?? {}))}
        end,
        response_status = case when ${input.responseStatus === undefined} then response_status else ${input.responseStatus ?? null} end,
        response_headers = case
          when ${input.responseHeaders === undefined} then response_headers
          else ${this.sql.json(toSqlJson(input.responseHeaders ?? {}))}
        end,
        error = case when ${input.error === undefined} then error else ${input.error ?? null} end,
        next_attempt_at = case when ${input.nextAttemptAt === undefined} then next_attempt_at else ${input.nextAttemptAt ?? null} end,
        delivered_at = case when ${input.deliveredAt === undefined} then delivered_at else ${input.deliveredAt ?? null} end,
        updated_at = now()
      where id = ${input.id}
      returning *
    `) as unknown as readonly WebhookDeliveryRow[];
    return rows[0] === undefined ? null : mapDelivery(rows[0]);
  }

  async claimDueOutboundDeliveries(
    input: {
      readonly limit?: number | undefined;
      readonly now?: Date | undefined;
    } = {},
  ): Promise<readonly WebhookDeliveryRecord[]> {
    const rows = (await this.sql`
      update webhook_deliveries
      set
        status = 'in_progress',
        attempt = attempt + 1,
        response_status = null,
        response_headers = ${this.sql.json(toSqlJson({}))},
        error = null,
        next_attempt_at = null,
        updated_at = now()
      where id in (
        select id
        from webhook_deliveries
        where direction = 'outbound'
          and status in ('pending', 'failed')
          and next_attempt_at is not null
          and next_attempt_at <= ${input.now ?? new Date()}
        order by next_attempt_at asc, created_at asc
        limit ${input.limit ?? 100}
        for update skip locked
      )
      returning *
    `) as unknown as readonly WebhookDeliveryRow[];
    return rows.map(mapDelivery);
  }

  async markInboundReceived(inboundWebhookId: string, receivedAt: Date): Promise<void> {
    await this.sql`
      update inbound_webhooks
      set last_received_at = ${receivedAt}, updated_at = now()
      where id = ${inboundWebhookId}
    `;
  }

  async getDelivery(orgId: string, id: string): Promise<WebhookDeliveryRecord | null> {
    const rows = (await this.sql`
      select * from webhook_deliveries
      where org_id = ${orgId} and id = ${id}
      limit 1
    `) as unknown as readonly WebhookDeliveryRow[];
    return rows[0] === undefined ? null : mapDelivery(rows[0]);
  }

  /* `outboundWebhookId` / `inboundWebhookId` narrow the log to one endpoint.
     Without them the deliveries tab could only be read as one undifferentiated
     stream, so triaging "why is *this* endpoint failing" meant scrolling a list
     that mixes every endpoint in the workspace together. */
  async listDeliveries(input: {
    readonly orgId: string;
    readonly direction?: WebhookDirection | undefined;
    readonly status?: WebhookDeliveryStatus | undefined;
    readonly outboundWebhookId?: string | undefined;
    readonly inboundWebhookId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly WebhookDeliveryRecord[]> {
    const rows = (await this.sql`
      select * from webhook_deliveries
      where org_id = ${input.orgId}
        and (${input.direction ?? null}::webhook_direction is null or direction = ${input.direction ?? null}::webhook_direction)
        and (${input.status ?? null}::webhook_delivery_status is null or status = ${input.status ?? null}::webhook_delivery_status)
        and (${input.outboundWebhookId ?? null}::uuid is null or outbound_webhook_id = ${input.outboundWebhookId ?? null}::uuid)
        and (${input.inboundWebhookId ?? null}::uuid is null or inbound_webhook_id = ${input.inboundWebhookId ?? null}::uuid)
      order by created_at desc
      limit ${input.limit ?? 100}
    `) as unknown as readonly WebhookDeliveryRow[];
    return rows.map(mapDelivery);
  }
}

export interface WebhookSecretResolver {
  resolveSecretRef(secretRef: string): Promise<string | null> | string | null;
}

export async function resolveWebhookSecret(
  secretRef: string | null,
  resolver?: WebhookSecretResolver,
): Promise<string> {
  if (secretRef === null || secretRef.length === 0) {
    return "";
  }
  if (secretRef.startsWith("inline:")) {
    return secretRef.slice("inline:".length);
  }
  const secret = await resolver?.resolveSecretRef(secretRef);
  if (secret === undefined || secret === null) {
    throw new Error(`Unable to resolve webhook secret ref: ${secretRef}`);
  }
  return secret;
}

export function sha256Json(value: unknown): string {
  // Routed through the crypto adapter (PRD §14.4) — webhook payload digest.
  return sha256Hex(JSON.stringify(value));
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function createInlineSecret(): string {
  // Webhook signing secret minted via the crypto adapter (PRD §14.4).
  return `inline:${randomBytes(32).toString("base64url")}`;
}

async function assertOutboundWebhookQuotaAvailable(
  sql: postgres.Sql | postgres.TransactionSql,
  orgId: string,
): Promise<void> {
  const rows = (await sql`
    select
      case
        when o.quotas ? 'outbound_webhooks_limit' then o.quotas -> 'outbound_webhooks_limit'
        when p.quotas_default ? 'outbound_webhooks_limit' then p.quotas_default -> 'outbound_webhooks_limit'
        else '5'::jsonb
      end as outbound_webhooks_limit,
      (
        select count(*)::int
        from outbound_webhooks wh
        where wh.org_id = ${orgId}
          and wh.deleted_at is null
      ) as active_outbound_webhook_count
    from orgs o
    left join plans p on p.id = o.plan_id
    where o.id = ${orgId}
    limit 1
    for update of o
  `) as unknown as readonly OutboundWebhookQuotaRow[];
  const row = rows[0];
  if (row === undefined) {
    return;
  }

  const limit = outboundWebhookLimitFromJson(row.outbound_webhooks_limit);
  if (limit === null) {
    return;
  }

  const used = countFromDatabase(row.active_outbound_webhook_count);
  if (Number.isFinite(used) && used >= limit) {
    throw new OutboundWebhookQuotaExceededError(orgId, limit, used);
  }
}

function outboundWebhookLimitFromJson(value: JsonValue | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 5;
}

function countFromDatabase(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function mapOutbound(row: OutboundWebhookRow | undefined): OutboundWebhookRecord {
  if (row === undefined) {
    throw new Error("Expected outbound webhook row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    url: row.url,
    eventSubjects: row.event_subjects,
    secretRef: row.secret_ref,
    headers: row.headers,
    enabled: row.enabled,
    metadata: row.metadata,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInbound(row: InboundWebhookRow | undefined): InboundWebhookRecord {
  if (row === undefined) {
    throw new Error("Expected inbound webhook row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    source: row.source,
    secretRef: row.secret_ref,
    enabled: row.enabled,
    metadata: row.metadata,
    createdByActorId: row.created_by_actor_id,
    lastReceivedAt: row.last_received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDelivery(row: WebhookDeliveryRow | undefined): WebhookDeliveryRecord {
  if (row === undefined) {
    throw new Error("Expected webhook delivery row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    direction: row.direction,
    outboundWebhookId: row.outbound_webhook_id,
    inboundWebhookId: row.inbound_webhook_id,
    eventSubject: row.event_subject,
    status: row.status,
    attempt: row.attempt,
    payload: row.payload,
    payloadSha256: row.payload_sha256,
    signature: row.signature,
    requestHeaders: row.request_headers,
    responseStatus: row.response_status,
    responseHeaders: row.response_headers,
    error: row.error,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
