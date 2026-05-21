import type {
  JsonObject,
  JsonValue,
  OutboundWebhookEvent,
  RenderedWebhookRequest,
  WebhookFormatAdapter,
} from "./types.js";
import { createTemplateContext, renderTemplateString } from "./template.js";

export interface TeamsWebhookConfig {
  readonly titleTemplate?: string;
  readonly summaryTemplate?: string;
}

export interface TeamsWebhookPayload extends JsonObject {
  readonly type: "message";
  readonly attachments: readonly [
    {
      readonly contentType: "application/vnd.microsoft.card.adaptive";
      readonly content: JsonObject;
    },
  ];
}

export const teamsWebhookFormat: WebhookFormatAdapter<TeamsWebhookConfig> = {
  id: "teams",
  render: renderTeamsWebhookPayload,
};

export function renderTeamsWebhookPayload(
  event: OutboundWebhookEvent,
  config: TeamsWebhookConfig = {},
): RenderedWebhookRequest {
  const context = createTemplateContext(event);
  const title = renderTemplateString(config.titleTemplate ?? "Helix event {{event}}", context);
  const summary = renderTemplateString(
    config.summaryTemplate ?? "{{object.subject}}{{object.title}}{{object.name}}",
    context,
  );
  const facts = adaptiveFacts(event.payload);
  const body: TeamsWebhookPayload = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: title,
              weight: "Bolder",
              wrap: true,
            },
            ...(summary.length === 0
              ? []
              : [
                  {
                    type: "TextBlock",
                    text: summary,
                    wrap: true,
                  },
                ]),
            ...(facts.length === 0
              ? []
              : [
                  {
                    type: "FactSet",
                    facts,
                  },
                ]),
          ],
        },
      },
    ],
  };

  return { contentType: "application/json", body };
}

function adaptiveFacts(payload: JsonValue): readonly JsonObject[] {
  if (!isJsonObject(payload)) {
    return [];
  }

  return ["from", "sender", "subject", "title", "preview", "name"]
    .flatMap((key) => {
      const value = payload[key];
      return typeof value === "string" && value.length > 0 ? [{ title: key, value }] : [];
    })
    .slice(0, 6);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
