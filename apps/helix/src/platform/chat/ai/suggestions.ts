import type {
  AICapability,
  AIClassification,
  ChatRequest,
  JsonObject,
  JsonValue,
  SuggestionChunk,
  SuggestionContext,
  SuggestionSlotProviderCapability,
} from "@helix/sdk-types";
import { chatPluginId } from "../types.js";

export const chatSuggestionSlotIds = ["chat.suggest-reply", "chat.summarize-room"] as const;

export type ChatSuggestionSlotId = (typeof chatSuggestionSlotIds)[number];

export interface ChatSuggestionSlotDescriptor {
  readonly id: ChatSuggestionSlotId;
  readonly pluginId: typeof chatPluginId;
  readonly label: string;
  readonly description: string;
  readonly order: number;
}

export const chatSuggestionSlots: readonly ChatSuggestionSlotDescriptor[] = [
  {
    id: "chat.suggest-reply",
    pluginId: chatPluginId,
    label: "Suggest reply",
    description: "Suggest a short reply for the current room",
    order: 10,
  },
  {
    id: "chat.summarize-room",
    pluginId: chatPluginId,
    label: "Summarize room",
    description: "Summarize recent room activity",
    order: 20,
  },
];

export interface ChatSuggestionProviderOptions {
  readonly ai: AICapability;
  readonly defaultClassification?: AIClassification | undefined;
}

export function createChatSuggestionSlotProviders(
  options: ChatSuggestionProviderOptions,
): readonly SuggestionSlotProviderCapability[] {
  return chatSuggestionSlotIds.map((slotId) => createProvider(slotId, options));
}

function createProvider(
  slotId: ChatSuggestionSlotId,
  options: ChatSuggestionProviderOptions,
): SuggestionSlotProviderCapability {
  return {
    slotId,
    available: async (ctx) => ctx.feature === slotId || ctx.feature.length === 0,
    generate: async function* generate(ctx): AsyncIterable<SuggestionChunk> {
      const classification = classificationFromInput(ctx.input) ?? options.defaultClassification ?? "standard";
      const response = await options.ai.chat(toChatRequest(slotId, ctx, classification), {
        actor: ctx.actor,
        feature: slotId,
        classification,
      });
      yield {
        text: response.message,
        done: true,
        metadata: {
          providerId: response.providerId,
          model: response.model,
          ...(response.metadata ?? {}),
        },
      };
    },
  };
}

function toChatRequest(
  slotId: ChatSuggestionSlotId,
  ctx: SuggestionContext,
  classification: AIClassification,
): ChatRequest {
  return {
    feature: slotId,
    classification,
    messages: [
      {
        role: "system",
        content: systemPrompt(slotId),
      },
      {
        role: "user",
        content: suggestionInputText(ctx),
      },
    ],
    metadata: {
      slotId,
      ...(ctx.resource === undefined
        ? {}
        : {
            resource: {
              type: ctx.resource.type,
              ...(ctx.resource.id === undefined ? {} : { id: ctx.resource.id }),
              ...(ctx.resource.orgId === undefined ? {} : { orgId: ctx.resource.orgId }),
              ...(ctx.resource.attributes === undefined ? {} : { attributes: ctx.resource.attributes }),
            },
          }),
    },
  };
}

function systemPrompt(slotId: ChatSuggestionSlotId): string {
  if (slotId === "chat.summarize-room") {
    return "Summarize the chat room with key decisions, open questions, owners, and action items. Do not invent facts.";
  }
  return "Suggest one concise, natural chat reply grounded in the room context. Avoid unsupported commitments.";
}

function suggestionInputText(ctx: SuggestionContext): string {
  const input = ctx.input ?? {};
  const roomName = stringInput(input, "roomName");
  const draft = stringInput(input, "draft");
  const lastMessage = stringInput(input, "lastMessage");
  const participants = arrayInput(input, "participants").map(formatJsonValue).filter(hasText).join(", ");
  const messages = arrayInput(input, "messages").map(formatMessage).filter(hasText).join("\n");

  return [
    roomName === undefined ? "" : `Room: ${roomName}`,
    participants.length === 0 ? "" : `Participants: ${participants}`,
    lastMessage === undefined ? "" : `Last message: ${lastMessage}`,
    messages.length === 0 ? "" : `Messages:\n${messages}`,
    draft === undefined ? "" : `Draft: ${draft}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function formatMessage(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isJsonObject(value)) {
    return "";
  }

  const author = stringInput(value, "author") ?? stringInput(value, "authorName") ?? stringInput(value, "sender") ?? "Unknown";
  const body = stringInput(value, "body") ?? stringInput(value, "text") ?? stringInput(value, "message");
  const createdAt = stringInput(value, "createdAt");
  if (body === undefined) {
    return "";
  }
  return createdAt === undefined ? `${author}: ${body}` : `${createdAt} ${author}: ${body}`;
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (isJsonObject(value)) {
    return stringInput(value, "displayName") ?? stringInput(value, "name") ?? stringInput(value, "email") ?? "";
  }
  return "";
}

function classificationFromInput(input: JsonObject | undefined): AIClassification | undefined {
  const value = input?.classification;
  return value === "public" || value === "standard" || value === "confidential" || value === "restricted"
    ? value
    : undefined;
}

function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function arrayInput(input: JsonObject, key: string): readonly JsonValue[] {
  const value = input[key];
  return isJsonArray(value) ? value : [];
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function hasText(value: string): boolean {
  return value.length > 0;
}
