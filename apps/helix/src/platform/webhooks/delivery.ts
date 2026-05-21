import type { TraceContext } from "@helix/sdk-types";
import { getCryptoProvider } from "../crypto/index.js";
import { signWebhookPayload, verifyWebhookSignature } from "./signatures.js";
import {
  resolveWebhookSecret,
  type CreateWebhookDeliveryInput,
  type OutboundWebhookRecord,
  type UpdateWebhookDeliveryStatusInput,
  type WebhookDeliveryRecord,
  type WebhookSecretResolver,
} from "./store.js";

export interface WebhookEvent {
  readonly subject: string;
  readonly payload: unknown;
  readonly occurredAt?: Date;
}

export interface WebhookHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface WebhookHttpClient {
  post(input: {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }): Promise<WebhookHttpResponse>;
}

export const fetchWebhookHttpClient: WebhookHttpClient = {
  async post(input) {
    const response = await fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
    };
  },
};

export interface WebhookRetryPolicy {
  readonly maxAttempts: number;
  readonly delaysMs: readonly number[];
}

export const defaultWebhookRetryPolicy: WebhookRetryPolicy = {
  maxAttempts: 3,
  delaysMs: [1_000, 30_000, 300_000],
};

const dataClassifications = ["public", "standard", "confidential", "restricted"] as const;
type DataClassification = (typeof dataClassifications)[number];
const traceparentPattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const traceIdPattern = /^[0-9a-f]{32}$/u;
const spanIdPattern = /^[0-9a-f]{16}$/u;
const emptyTraceId = "00000000000000000000000000000000";
const emptySpanId = "0000000000000000";

export interface WebhookDeliveryStore {
  createDelivery(input: CreateWebhookDeliveryInput): Promise<WebhookDeliveryRecord>;
  updateDeliveryStatus(
    input: UpdateWebhookDeliveryStatusInput,
  ): Promise<WebhookDeliveryRecord | null>;
}

export interface WebhookReplayStore extends WebhookDeliveryStore {
  getDelivery(orgId: string, id: string): Promise<WebhookDeliveryRecord | null>;
  getOutbound(orgId: string, id: string): Promise<OutboundWebhookRecord | null>;
}

export interface DeliverOutboundWebhookOptions {
  readonly store: WebhookDeliveryStore;
  readonly webhook: OutboundWebhookRecord;
  readonly event: WebhookEvent;
  readonly secretResolver?: WebhookSecretResolver;
  readonly trace?: TraceContext;
  readonly httpClient?: WebhookHttpClient;
  readonly now?: Date;
  readonly retryPolicy?: WebhookRetryPolicy;
}

export class WebhookDeliveryBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDeliveryBlockedError";
  }
}

export async function deliverOutboundWebhook(
  options: DeliverOutboundWebhookOptions,
): Promise<WebhookDeliveryRecord | null> {
  assertOutboundWebhookDeliverable({
    webhook: options.webhook,
    payload: options.event.payload,
  });

  const deliveryId = getCryptoProvider().randomUuid();
  const body = JSON.stringify({
    id: deliveryId,
    subject: options.event.subject,
    occurredAt: (options.event.occurredAt ?? options.now ?? new Date()).toISOString(),
    data: options.event.payload,
    webhook: {
      id: options.webhook.id,
      name: options.webhook.name,
    },
  });
  const { requestHeaders, signature } = await buildOutboundRequest({
    webhook: options.webhook,
    deliveryId,
    eventSubject: options.event.subject,
    body,
    ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    now: options.now,
  });
  const delivery = await options.store.createDelivery({
    id: deliveryId,
    orgId: options.webhook.orgId,
    direction: "outbound",
    outboundWebhookId: options.webhook.id,
    eventSubject: options.event.subject,
    status: "in_progress",
    attempt: 1,
    payload: JSON.parse(body) as unknown,
    signature: signature.header,
    requestHeaders,
  });

  return dispatchOutboundDelivery({
    store: options.store,
    webhook: options.webhook,
    delivery,
    body,
    requestHeaders,
    signature,
    attempt: 1,
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
  });
}

export interface DispatchClaimedOutboundDeliveryOptions {
  readonly store: WebhookDeliveryStore;
  readonly webhook: OutboundWebhookRecord;
  readonly delivery: WebhookDeliveryRecord;
  readonly secretResolver?: WebhookSecretResolver;
  readonly httpClient?: WebhookHttpClient;
  readonly now?: Date;
  readonly retryPolicy?: WebhookRetryPolicy;
}

export async function dispatchClaimedOutboundDelivery(
  options: DispatchClaimedOutboundDeliveryOptions,
): Promise<WebhookDeliveryRecord | null> {
  const blockReason = outboundWebhookBlockReason({
    webhook: options.webhook,
    payload: extractEventPayload(options.delivery.payload),
  });
  if (blockReason !== null) {
    return options.store.updateDeliveryStatus({
      id: options.delivery.id,
      status: "abandoned",
      attempt: options.delivery.attempt,
      error: blockReason,
      nextAttemptAt: null,
      deliveredAt: null,
    });
  }

  const body = JSON.stringify(options.delivery.payload);
  const trace = traceContextFromHeaders(options.delivery.requestHeaders);
  const { requestHeaders, signature } = await buildOutboundRequest({
    webhook: options.webhook,
    deliveryId: options.delivery.id,
    eventSubject: options.delivery.eventSubject,
    body,
    ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
    ...(trace === undefined ? {} : { trace }),
    now: options.now,
  });
  const preparedDelivery =
    (await options.store.updateDeliveryStatus({
      id: options.delivery.id,
      status: "in_progress",
      attempt: options.delivery.attempt,
      signature: signature.header,
      requestHeaders,
      responseStatus: null,
      responseHeaders: {},
      error: null,
      nextAttemptAt: null,
      deliveredAt: null,
    })) ?? options.delivery;

  return dispatchOutboundDelivery({
    store: options.store,
    webhook: options.webhook,
    delivery: preparedDelivery,
    body,
    requestHeaders,
    signature,
    attempt: preparedDelivery.attempt,
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
  });
}

export interface ReplayOutboundWebhookOptions {
  readonly store: WebhookReplayStore;
  readonly orgId: string;
  readonly deliveryId: string;
  readonly secretResolver?: WebhookSecretResolver;
  readonly httpClient?: WebhookHttpClient;
  readonly now?: Date;
  readonly retryPolicy?: WebhookRetryPolicy;
}

export async function replayOutboundWebhook(
  options: ReplayOutboundWebhookOptions,
): Promise<WebhookDeliveryRecord | null> {
  const original = await options.store.getDelivery(options.orgId, options.deliveryId);
  if (original === null) {
    throw new Error(`Unknown webhook delivery: ${options.deliveryId}`);
  }
  if (original.direction !== "outbound" || original.outboundWebhookId === null) {
    throw new Error(`Delivery is not an outbound webhook delivery: ${options.deliveryId}`);
  }
  if (original.status !== "failed" && original.status !== "abandoned") {
    throw new Error(`Delivery is not replayable: ${options.deliveryId}`);
  }

  const webhook = await options.store.getOutbound(options.orgId, original.outboundWebhookId);
  if (webhook === null) {
    throw new Error(`Unknown outbound webhook: ${original.outboundWebhookId}`);
  }
  if (!webhook.enabled) {
    throw new Error(`Outbound webhook is disabled: ${webhook.id}`);
  }
  assertOutboundWebhookDeliverable({
    webhook,
    payload: extractEventPayload(original.payload),
  });

  const occurredAt = extractOccurredAt(original.payload);
  const trace = traceContextFromHeaders(original.requestHeaders);
  return deliverOutboundWebhook({
    store: options.store,
    webhook,
    event: {
      subject: original.eventSubject,
      payload: extractEventPayload(original.payload),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    },
    ...(options.secretResolver === undefined ? {} : { secretResolver: options.secretResolver }),
    ...(trace === undefined ? {} : { trace }),
    ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
  });
}

export function assertOutboundWebhookDeliverable(input: {
  readonly webhook: OutboundWebhookRecord;
  readonly payload: unknown;
}): void {
  const blockReason = outboundWebhookBlockReason(input);
  if (blockReason !== null) {
    throw new WebhookDeliveryBlockedError(blockReason);
  }
}

export function outboundWebhookBlockReason(input: {
  readonly webhook: OutboundWebhookRecord;
  readonly payload: unknown;
}): string | null {
  if (!input.webhook.enabled) {
    return `Outbound webhook is disabled: ${input.webhook.id}`;
  }

  const blockedClassifications = blockedClassificationsFromMetadata(input.webhook.metadata);
  if (blockedClassifications.length === 0) {
    return null;
  }

  const classification = classificationFromPayload(input.payload);
  if (classification === undefined || !blockedClassifications.includes(classification)) {
    return null;
  }

  return `Outbound webhook policy blocks ${classification} payloads: ${input.webhook.id}`;
}

export async function verifyInboundWebhookPayload(input: {
  readonly payload: Buffer | string;
  readonly secretRef: string | null;
  readonly secretResolver?: WebhookSecretResolver;
  readonly signatureHeader: string | undefined;
  readonly now?: Date;
}): Promise<boolean> {
  if (input.signatureHeader === undefined) {
    return false;
  }
  return verifyWebhookSignature({
    payload: input.payload,
    secret: await resolveWebhookSecret(input.secretRef, input.secretResolver),
    header: input.signatureHeader,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

async function buildOutboundRequest(input: {
  readonly webhook: OutboundWebhookRecord;
  readonly deliveryId: string;
  readonly eventSubject: string;
  readonly body: string;
  readonly secretResolver?: WebhookSecretResolver | undefined;
  readonly trace?: TraceContext | undefined;
  readonly now?: Date | undefined;
}): Promise<{
  readonly requestHeaders: Record<string, string>;
  readonly signature: ReturnType<typeof signWebhookPayload>;
}> {
  const secret = await resolveWebhookSecret(input.webhook.secretRef, input.secretResolver);
  const signature = signWebhookPayload({
    payload: input.body,
    secret,
    timestamp: input.now ?? Date.now(),
  });
  return {
    signature,
    requestHeaders: {
      ...input.webhook.headers,
      "content-type": "application/json",
      "user-agent": "helix-webhooks/0.0.0",
      "x-helix-delivery": input.deliveryId,
      "x-helix-event": input.eventSubject,
      "x-helix-signature": signature.header,
      "x-helix-timestamp": String(signature.timestamp),
      ...traceHeaders(input.trace),
    },
  };
}

function traceHeaders(trace: TraceContext | undefined): Record<string, string> {
  if (trace === undefined) {
    return {};
  }

  const traceparent = normalizeTraceparent(trace);
  return {
    ...(traceparent === undefined ? {} : { traceparent }),
    ...(trace.tracestate === undefined || trace.tracestate.length === 0
      ? {}
      : { tracestate: trace.tracestate }),
  };
}

function traceContextFromHeaders(headers: Record<string, string>): TraceContext | undefined {
  const traceparent = headers.traceparent;
  const tracestate = headers.tracestate;
  if (
    (traceparent === undefined || traceparent.length === 0) &&
    (tracestate === undefined || tracestate.length === 0)
  ) {
    return undefined;
  }

  return {
    ...(traceparent === undefined || traceparent.length === 0 ? {} : { traceparent }),
    ...(tracestate === undefined || tracestate.length === 0 ? {} : { tracestate }),
  };
}

function normalizeTraceparent(trace: TraceContext): string | undefined {
  if (trace.traceparent !== undefined && trace.traceparent.length > 0) {
    return isValidTraceparent(trace.traceparent) ? trace.traceparent : undefined;
  }
  if (
    trace.traceId === undefined ||
    trace.spanId === undefined ||
    !traceIdPattern.test(trace.traceId) ||
    !spanIdPattern.test(trace.spanId) ||
    trace.traceId === emptyTraceId ||
    trace.spanId === emptySpanId
  ) {
    return undefined;
  }
  return `00-${trace.traceId}-${trace.spanId}-01`;
}

function isValidTraceparent(traceparent: string): boolean {
  const match = traceparentPattern.exec(traceparent);
  if (match === null) {
    return false;
  }
  const [, , traceId, spanId] = match;
  return (
    traceId !== undefined &&
    spanId !== undefined &&
    traceId !== emptyTraceId &&
    spanId !== emptySpanId
  );
}

async function dispatchOutboundDelivery(input: {
  readonly store: WebhookDeliveryStore;
  readonly webhook: OutboundWebhookRecord;
  readonly delivery: WebhookDeliveryRecord;
  readonly body: string;
  readonly requestHeaders: Record<string, string>;
  readonly signature: ReturnType<typeof signWebhookPayload>;
  readonly attempt: number;
  readonly httpClient?: WebhookHttpClient | undefined;
  readonly now?: Date | undefined;
  readonly retryPolicy?: WebhookRetryPolicy | undefined;
}): Promise<WebhookDeliveryRecord | null> {
  const now = input.now ?? new Date();
  const retryPolicy = input.retryPolicy ?? defaultWebhookRetryPolicy;
  try {
    const response = await (input.httpClient ?? fetchWebhookHttpClient).post({
      url: input.webhook.url,
      headers: input.requestHeaders,
      body: input.body,
    });
    const delivered = response.status >= 200 && response.status < 300;
    const retryable = isRetryableStatus(response.status);
    const nextAttemptAt = delivered
      ? null
      : nextAttemptAtFor(input.attempt, now, retryPolicy, retryable);
    return await input.store.updateDeliveryStatus({
      id: input.delivery.id,
      status: delivered ? "delivered" : nextAttemptAt === null ? "abandoned" : "failed",
      attempt: input.attempt,
      signature: input.signature.header,
      requestHeaders: input.requestHeaders,
      responseStatus: response.status,
      responseHeaders: response.headers,
      error: delivered ? null : response.body.slice(0, 1000),
      nextAttemptAt,
      deliveredAt: delivered ? now : null,
    });
  } catch (error) {
    const nextAttemptAt = nextAttemptAtFor(input.attempt, now, retryPolicy, true);
    return input.store.updateDeliveryStatus({
      id: input.delivery.id,
      status: nextAttemptAt === null ? "abandoned" : "failed",
      attempt: input.attempt,
      signature: input.signature.header,
      requestHeaders: input.requestHeaders,
      error: error instanceof Error ? error.message : "Webhook delivery failed",
      nextAttemptAt,
      deliveredAt: null,
    });
  }
}

function nextAttemptAtFor(
  attempt: number,
  now: Date,
  policy: WebhookRetryPolicy,
  retryable: boolean,
): Date | null {
  if (!retryable || attempt >= policy.maxAttempts) {
    return null;
  }
  const delayMs =
    policy.delaysMs[Math.max(0, attempt - 1)] ?? policy.delaysMs[policy.delaysMs.length - 1] ?? 0;
  return new Date(now.getTime() + delayMs);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function blockedClassificationsFromMetadata(
  metadata: Record<string, unknown>,
): readonly DataClassification[] {
  const policy = recordField(metadata, "classificationPolicy");
  if (policy === undefined) {
    return [];
  }
  const blocked = policy.blockedClassifications;
  if (!Array.isArray(blocked)) {
    return [];
  }
  return blocked.filter(isDataClassification);
}

function classificationFromPayload(
  payload: unknown,
  seen: WeakSet<object> = new WeakSet(),
): DataClassification | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (seen.has(payload)) {
    return undefined;
  }
  seen.add(payload);

  const direct = dataClassification(payload.classification);
  if (direct !== undefined) {
    return direct;
  }

  for (const key of ["metadata", "attributes", "resource", "data", "payload"]) {
    const nested = payload[key];
    const classification = classificationFromPayload(nested, seen);
    if (classification !== undefined) {
      return classification;
    }
  }

  return undefined;
}

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function dataClassification(value: unknown): DataClassification | undefined {
  return isDataClassification(value) ? value : undefined;
}

function isDataClassification(value: unknown): value is DataClassification {
  return dataClassifications.includes(value as DataClassification);
}

function extractEventPayload(payload: unknown): unknown {
  if (isRecord(payload) && "data" in payload) {
    return payload.data;
  }
  return payload;
}

function extractOccurredAt(payload: unknown): Date | undefined {
  if (!isRecord(payload) || typeof payload.occurredAt !== "string") {
    return undefined;
  }
  const occurredAt = new Date(payload.occurredAt);
  return Number.isNaN(occurredAt.getTime()) ? undefined : occurredAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
