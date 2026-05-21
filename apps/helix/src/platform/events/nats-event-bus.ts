import { connect, headers } from "@nats-io/transport-node";
import type { EventBus, EventEnvelope, JsonValue, TraceContext, Unsubscribe } from "@helix/sdk-types";
import type { MsgHdrs, NatsConnection, NodeConnectionOptions, Subscription } from "@nats-io/transport-node";

export interface NatsEventBusOptions {
  readonly subjectPrefix?: string;
  readonly onError?: (error: unknown) => void;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const traceparentPattern = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const traceIdPattern = /^[0-9a-f]{32}$/u;
const spanIdPattern = /^[0-9a-f]{16}$/u;
const emptyTraceId = "00000000000000000000000000000000";
const emptySpanId = "0000000000000000";

export class NatsEventBus implements EventBus {
  private readonly subjectPrefix: string;
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(
    private readonly connection: NatsConnection,
    options: NatsEventBusOptions = {},
  ) {
    this.subjectPrefix = normalizeSubjectPrefix(options.subjectPrefix);
    this.onError = options.onError;
  }

  static async connect(
    connectionOptions: NodeConnectionOptions = {},
    eventBusOptions: NatsEventBusOptions = {},
  ): Promise<NatsEventBus> {
    return new NatsEventBus(await connect(connectionOptions), eventBusOptions);
  }

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const messageHeaders = trace === undefined ? undefined : traceContextToNatsHeaders(trace);
    const publishOptions = messageHeaders === undefined ? undefined : { headers: messageHeaders };
    this.connection.publish(this.toNatsSubject(subject), encodeJson(payload), publishOptions);
    await this.connection.flush();
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    const subscription = this.connection.subscribe(this.toNatsSubject(subject));
    const pump = this.pumpSubscription(subscription, handler);

    return async () => {
      subscription.unsubscribe();
      await Promise.allSettled([subscription.closed, pump]);
    };
  }

  close(): Promise<void> {
    return this.connection.close();
  }

  drain(): Promise<void> {
    return this.connection.drain();
  }

  private async pumpSubscription<Payload extends JsonValue>(
    subscription: Subscription,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<void> {
    try {
      for await (const message of subscription) {
        try {
          const payload = decodeJson(message.data);
          if (!isJsonValue(payload)) {
            throw new TypeError(`NATS message ${message.subject} did not contain JSON payload`);
          }

          const trace = traceContextFromNatsHeaders(message.headers);
          await handler({
            subject: this.fromNatsSubject(message.subject),
            payload: payload as Payload,
            ...(trace === undefined ? {} : { trace }),
            occurredAt: new Date().toISOString(),
          });
        } catch (error) {
          this.onError?.(error);
        }
      }
    } catch (error) {
      if (!subscription.isClosed()) {
        subscription.unsubscribe();
      }
      this.onError?.(error);
    }
  }

  private toNatsSubject(subject: string): string {
    return this.subjectPrefix.length === 0 ? subject : `${this.subjectPrefix}.${subject}`;
  }

  private fromNatsSubject(subject: string): string {
    const prefix = `${this.subjectPrefix}.`;
    return this.subjectPrefix.length > 0 && subject.startsWith(prefix) ? subject.slice(prefix.length) : subject;
  }
}

export function traceContextToNatsHeaders(trace: TraceContext): MsgHdrs | undefined {
  const traceparent = normalizeTraceparent(trace);
  const tracestate = normalizeHeaderValue(trace.tracestate);

  if (traceparent === undefined && tracestate === undefined) {
    return undefined;
  }

  const messageHeaders = headers();
  if (traceparent !== undefined) {
    messageHeaders.set("traceparent", traceparent);
  }
  if (tracestate !== undefined) {
    messageHeaders.set("tracestate", tracestate);
  }
  return messageHeaders;
}

export function traceContextFromNatsHeaders(messageHeaders: MsgHdrs | undefined): TraceContext | undefined {
  const traceparent = normalizeHeaderValue(messageHeaders?.get("traceparent"));
  const tracestate = normalizeHeaderValue(messageHeaders?.get("tracestate"));

  if (traceparent === undefined) {
    return tracestate === undefined ? undefined : { tracestate };
  }

  const parsed = parseTraceparent(traceparent);
  if (parsed === undefined) {
    return tracestate === undefined ? undefined : { tracestate };
  }

  return {
    ...parsed,
    traceparent,
    ...(tracestate === undefined ? {} : { tracestate }),
  };
}

function normalizeTraceparent(trace: TraceContext): string | undefined {
  if (trace.traceparent !== undefined) {
    return parseTraceparent(trace.traceparent) === undefined ? undefined : trace.traceparent;
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

function parseTraceparent(traceparent: string): Pick<TraceContext, "traceId" | "spanId"> | undefined {
  const match = traceparentPattern.exec(traceparent);
  if (match === null) {
    return undefined;
  }

  const [, , traceId, spanId] = match;
  if (
    traceId === undefined ||
    spanId === undefined ||
    traceId === emptyTraceId ||
    spanId === emptySpanId
  ) {
    return undefined;
  }

  return { traceId, spanId };
}

function normalizeHeaderValue(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function normalizeSubjectPrefix(prefix: string | undefined): string {
  if (prefix === undefined) {
    return "";
  }

  return prefix
    .split(".")
    .filter((part) => part.length > 0)
    .join(".");
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }

  return false;
}

function encodeJson(payload: JsonValue): Uint8Array {
  return textEncoder.encode(JSON.stringify(payload));
}

function decodeJson(data: Uint8Array): unknown {
  return JSON.parse(textDecoder.decode(data));
}
