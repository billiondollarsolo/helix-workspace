import type { JsonObject, JsonValue } from "@helix/sdk-types";
import type { EventDirection, EventSchemaDefinition } from "../platform/events/schema-registry.js";
import { HELIX_SERVER_VERSION } from "./version.js";

type MutableAsyncApiObject = Record<string, unknown>;

export function buildAsyncApiDocument(
  baseDocument: unknown,
  events: readonly EventSchemaDefinition[],
): MutableAsyncApiObject {
  const document = isRecord(baseDocument) ? { ...baseDocument } : {};
  const servers = isRecord(document.servers) ? { ...document.servers } : {};
  const channels = isRecord(document.channels) ? { ...document.channels } : {};
  const operations = isRecord(document.operations) ? { ...document.operations } : {};
  const components = isRecord(document.components) ? { ...document.components } : {};
  const messages = isRecord(components.messages) ? { ...components.messages } : {};
  const securitySchemes = isRecord(components.securitySchemes)
    ? { ...components.securitySchemes }
    : {};

  document.asyncapi = typeof document.asyncapi === "string" ? document.asyncapi : "3.0.0";
  document.info = isRecord(document.info)
    ? document.info
    : { title: "Helix Platform Events", version: HELIX_SERVER_VERSION };

  for (const event of events) {
    const channelKey = channelKeyForSubject(event.subject);
    const messageKey = componentKeyForEvent(event.id);
    const directions = directionsForEvent(event.direction);

    messages[messageKey] = eventMessage(event);
    channels[channelKey] = {
      ...asChannel(channels[channelKey]),
      address: event.subject,
      messages: {
        ...asMessages(asChannel(channels[channelKey]).messages),
        [messageKey]: { $ref: `#/components/messages/${escapeJsonPointer(messageKey)}` },
      },
    };

    for (const direction of directions) {
      const operationId = operationIdForEvent(direction, event.id);
      operations[operationId] = {
        action: actionForDirection(direction),
        channel: { $ref: `#/channels/${escapeJsonPointer(channelKey)}` },
        messages: [
          {
            $ref: `#/channels/${escapeJsonPointer(channelKey)}/messages/${escapeJsonPointer(messageKey)}`,
          },
        ],
        security: [{ oauthClientCredentials: [] }],
        ...(event.description === undefined ? {} : { description: event.description }),
        "x-helix-event": {
          id: event.id,
          subject: event.subject,
          direction,
        },
        "x-helix-delivery": {
          websocket: {
            server: "eventsWebSocket",
            path: "/events/ws",
            subjectQueryParam: "subject",
          },
          webhook: {
            adminTool: "webhook.outbound.create",
            deliverySubject: event.subject,
          },
        },
      };
    }
  }

  servers.eventsWebSocket = {
    ...asServer(servers.eventsWebSocket),
    host: "{host}",
    pathname: "/events/ws",
    protocol: "wss",
    description: "OAuth-authenticated WebSocket event stream for agents.",
    security: [{ oauthClientCredentials: [] }],
    variables: {
      ...asVariables(asServer(servers.eventsWebSocket).variables),
      host: {
        default: "localhost",
        description: "Helix API host.",
      },
    },
  };
  servers.webhookDelivery = {
    ...asServer(servers.webhookDelivery),
    host: "{webhookHost}",
    protocol: "https",
    description: "Admin-configured outbound webhook delivery targets.",
    variables: {
      ...asVariables(asServer(servers.webhookDelivery).variables),
      webhookHost: {
        default: "example.invalid",
        description: "Webhook receiver host configured by an administrator.",
      },
    },
  };
  securitySchemes.oauthClientCredentials = {
    ...asSecurityScheme(securitySchemes.oauthClientCredentials),
    type: "oauth2",
    description: "OAuth 2.1 client credentials bearer token for agents and automation.",
    flows: {
      clientCredentials: {
        tokenUrl: "/oauth/token",
        scopes: {},
      },
    },
  };

  components.messages = messages;
  components.securitySchemes = securitySchemes;
  document.servers = servers;
  document.channels = channels;
  document.operations = operations;
  document.components = components;
  document.tags = mergeTags(document.tags, {
    name: "Events",
    description: "Platform event schema registry.",
  });

  return document;
}

function eventMessage(event: EventSchemaDefinition): MutableAsyncApiObject {
  return {
    name: event.id,
    ...(event.title === undefined ? {} : { title: event.title }),
    ...(event.description === undefined ? {} : { summary: event.description }),
    ...(event.tags === undefined ? {} : { tags: event.tags.map((name) => ({ name })) }),
    contentType: "application/json",
    payload: toSchema(event.payloadSchema),
    headers: traceContextHeaders(event.headersSchema),
  };
}

function directionsForEvent(
  direction: EventDirection | undefined,
): readonly Exclude<EventDirection, "both">[] {
  if (direction === "both") {
    return ["publish", "subscribe"];
  }
  return [direction ?? "publish"];
}

function actionForDirection(direction: Exclude<EventDirection, "both">): "send" | "receive" {
  return direction === "publish" ? "send" : "receive";
}

function mergeTags(
  existing: unknown,
  tag: MutableAsyncApiObject,
): readonly MutableAsyncApiObject[] {
  const tags = Array.isArray(existing) ? existing.filter(isRecord) : [];
  if (tags.some((entry) => entry.name === tag.name)) {
    return tags;
  }
  return [...tags, tag];
}

function asChannel(value: unknown): MutableAsyncApiObject {
  return isRecord(value) ? value : {};
}

function asMessages(value: unknown): MutableAsyncApiObject {
  return isRecord(value) ? value : {};
}

function asServer(value: unknown): MutableAsyncApiObject {
  return isRecord(value) ? value : {};
}

function asVariables(value: unknown): MutableAsyncApiObject {
  return isRecord(value) ? value : {};
}

function asSecurityScheme(value: unknown): MutableAsyncApiObject {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is MutableAsyncApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function channelKeyForSubject(subject: string): string {
  return subject.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function componentKeyForEvent(eventId: string): string {
  const suffix = eventId
    .split(/[^a-zA-Z0-9]+/gu)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");

  return suffix.length === 0 ? "EventMessage" : suffix;
}

function operationIdForEvent(direction: Exclude<EventDirection, "both">, eventId: string): string {
  return `${direction}Event_${eventId.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")}`;
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function toSchema(schema: JsonObject): JsonValue {
  return schema;
}

function traceContextHeaders(headersSchema: JsonObject | undefined): JsonValue {
  const existing = isRecord(headersSchema) ? headersSchema : {};
  const properties = isRecord(existing.properties) ? existing.properties : {};
  return {
    ...existing,
    type: existing.type ?? "object",
    properties: {
      traceparent: { type: "string" },
      tracestate: { type: "string" },
      ...properties,
    },
  };
}
