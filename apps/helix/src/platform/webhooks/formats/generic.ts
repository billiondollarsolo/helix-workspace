import type {
  JsonObject,
  JsonValue,
  OutboundWebhookEvent,
  RenderedWebhookRequest,
  WebhookActor,
  WebhookFormatAdapter,
} from "./types.js";
import { toIsoTimestamp } from "./types.js";

export interface GenericWebhookEnvelope extends JsonObject {
  readonly id: string;
  readonly event: string;
  readonly createdAt: string;
  readonly object: JsonValue;
  readonly actor?: WebhookActor;
}

export const genericWebhookFormat: WebhookFormatAdapter = {
  id: "helix-json",
  render: renderGenericEnvelope,
};

export function renderGenericEnvelope(
  event: OutboundWebhookEvent,
): RenderedWebhookRequest & { readonly body: GenericWebhookEnvelope } {
  return {
    contentType: "application/json",
    body: {
      id: event.deliveryId,
      event: event.subject,
      createdAt: toIsoTimestamp(event.createdAt),
      object: event.payload,
      ...(event.actor === undefined ? {} : { actor: event.actor }),
    },
  };
}
