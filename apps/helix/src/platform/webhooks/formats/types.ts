export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue | undefined };
export type JsonArray = readonly JsonValue[];

export interface WebhookActor extends JsonObject {
  readonly id: string;
  readonly type: string;
  readonly displayName?: string;
  readonly email?: string;
}

export interface OutboundWebhookEvent {
  readonly deliveryId: string;
  readonly subject: string;
  readonly createdAt: Date | string;
  readonly payload: JsonValue;
  readonly actor?: WebhookActor;
}

export interface RenderedWebhookRequest {
  readonly contentType: "application/json";
  readonly body: JsonValue;
}

export interface WebhookFormatAdapter<TConfig = undefined> {
  readonly id: string;
  readonly render: (event: OutboundWebhookEvent, config?: TConfig) => RenderedWebhookRequest;
}

export function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
