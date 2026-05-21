import type {
  JsonObject,
  JsonValue,
  OutboundWebhookEvent,
  RenderedWebhookRequest,
  WebhookFormatAdapter,
} from "./types.js";
import { createTemplateContext, renderTemplateString } from "./template.js";

export interface SlackWebhookConfig {
  readonly textTemplate?: string;
  readonly blocks?: readonly JsonObject[];
  readonly username?: string;
  readonly iconEmoji?: string;
}

export interface SlackWebhookPayload extends JsonObject {
  readonly text: string;
  readonly blocks?: readonly JsonObject[];
  readonly username?: string;
  readonly icon_emoji?: string;
}

export const slackWebhookFormat: WebhookFormatAdapter<SlackWebhookConfig> = {
  id: "slack",
  render: renderSlackWebhookPayload,
};

export function renderSlackWebhookPayload(
  event: OutboundWebhookEvent,
  config: SlackWebhookConfig = {},
): RenderedWebhookRequest {
  const context = createTemplateContext(event);
  const text = renderTemplateString(
    config.textTemplate ?? defaultMessageTemplate(event.subject),
    context,
  );
  const blocks = config.blocks ?? defaultSlackBlocks(text, event.payload);
  const body: SlackWebhookPayload = {
    text,
    blocks,
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.iconEmoji === undefined ? {} : { icon_emoji: config.iconEmoji }),
  };

  return { contentType: "application/json", body };
}

function defaultSlackBlocks(text: string, payload: JsonValue): readonly JsonObject[] {
  const fields = summarizePayload(payload);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text,
      },
    },
    ...(fields.length === 0
      ? []
      : [
          {
            type: "section",
            fields,
          },
        ]),
  ];
}

function defaultMessageTemplate(subject: string): string {
  return `Helix event ${subject}: {{object.subject}}{{object.title}}{{object.name}}`;
}

function summarizePayload(payload: JsonValue): readonly JsonObject[] {
  if (!isJsonObject(payload)) {
    return [];
  }

  return ["from", "sender", "subject", "title", "preview", "room", "name"]
    .flatMap((key) => {
      const value = payload[key];
      return typeof value === "string" && value.length > 0
        ? [
            {
              type: "mrkdwn",
              text: `*${key}:* ${value}`,
            },
          ]
        : [];
    })
    .slice(0, 6);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
