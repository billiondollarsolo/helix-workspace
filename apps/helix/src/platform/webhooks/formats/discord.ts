import type {
  JsonObject,
  JsonValue,
  OutboundWebhookEvent,
  RenderedWebhookRequest,
  WebhookFormatAdapter,
} from "./types.js";
import { createTemplateContext, renderTemplateString } from "./template.js";

export interface DiscordWebhookConfig {
  readonly contentTemplate?: string;
  readonly username?: string;
  readonly avatarUrl?: string;
}

export interface DiscordEmbedField extends JsonObject {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

export interface DiscordEmbed extends JsonObject {
  readonly title: string;
  readonly description?: string;
  readonly timestamp: string;
  readonly fields?: readonly DiscordEmbedField[];
}

export interface DiscordWebhookPayload extends JsonObject {
  readonly content: string;
  readonly embeds: readonly DiscordEmbed[];
  readonly username?: string;
  readonly avatar_url?: string;
}

export const discordWebhookFormat: WebhookFormatAdapter<DiscordWebhookConfig> = {
  id: "discord",
  render: renderDiscordWebhookPayload,
};

export function renderDiscordWebhookPayload(
  event: OutboundWebhookEvent,
  config: DiscordWebhookConfig = {},
): RenderedWebhookRequest {
  const context = createTemplateContext(event);
  const content = renderTemplateString(config.contentTemplate ?? "Helix event {{event}}", context);
  const embed: DiscordEmbed = {
    title: event.subject,
    timestamp: context.createdAt,
    ...descriptionFor(event.payload),
    ...fieldsFor(event.payload),
  };
  const body: DiscordWebhookPayload = {
    content,
    embeds: [embed],
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.avatarUrl === undefined ? {} : { avatar_url: config.avatarUrl }),
  };

  return { contentType: "application/json", body };
}

function descriptionFor(payload: JsonValue): Pick<DiscordEmbed, "description"> {
  if (!isJsonObject(payload)) {
    return {};
  }

  const preview =
    stringField(payload, "preview") ??
    stringField(payload, "description") ??
    stringField(payload, "body");
  return preview === undefined ? {} : { description: preview.slice(0, 4096) };
}

function fieldsFor(payload: JsonValue): Pick<DiscordEmbed, "fields"> {
  if (!isJsonObject(payload)) {
    return {};
  }

  const fields = ["from", "sender", "subject", "title", "name"]
    .flatMap((key): readonly DiscordEmbedField[] => {
      const value = stringField(payload, key);
      return value === undefined ? [] : [{ name: key, value: value.slice(0, 1024), inline: true }];
    })
    .slice(0, 8);

  return fields.length === 0 ? {} : { fields };
}

function stringField(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
