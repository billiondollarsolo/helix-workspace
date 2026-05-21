import type { JsonObject, JsonValue } from "./json.js";

export type ActorType = "user" | "agent" | "service_account" | "system";

export interface Actor {
  readonly id: string;
  readonly type: ActorType;
  readonly orgId: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly scopes?: readonly string[];
}

export interface RequestContext {
  readonly requestId: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

export interface TraceContext {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export interface ResourceRef {
  readonly type: string;
  readonly id?: string;
  readonly orgId?: string;
  readonly attributes?: JsonObject;
}

export interface Logger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
  child(bindings: JsonObject): Logger;
}

export interface Tracer {
  startSpan<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface MetricCounter {
  inc(value?: number, labels?: Record<string, string>): void;
}

export interface MetricHistogram {
  observe(value: number, labels?: Record<string, string>): void;
}

export interface MetricsClient {
  counter(name: string, help: string, labels?: readonly string[]): MetricCounter;
  histogram(name: string, help: string, labels?: readonly string[]): MetricHistogram;
}

export interface I18nClient {
  t(key: string, params?: Record<string, string | number>): string;
}

export interface DrizzleClient {
  execute(query: unknown): Promise<unknown>;
  transaction<T>(fn: (tx: DrizzleClient) => Promise<T>): Promise<T>;
}

export interface StorageObject {
  readonly key: string;
  readonly body: AsyncIterable<Uint8Array> | Uint8Array;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

export interface StorageClient {
  put(object: StorageObject): Promise<void>;
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<void>;
}

export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { readonly ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export type Unsubscribe = () => Promise<void> | void;

export interface EventEnvelope<Payload extends JsonValue = JsonValue> {
  readonly subject: string;
  readonly payload: Payload;
  readonly trace?: TraceContext;
  readonly occurredAt: string;
}

export interface EventBus {
  publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void>;
  subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe>;
}
