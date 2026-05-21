import type { AICapability, JsonObject } from "@helix/sdk-types";
import type { EnrichmentEvent, EnrichmentHandler, EnrichmentWorker } from "../../ai/enrichment/index.js";
import type {
  ChatActivityPayload,
  ChatEnrichmentProjectionStore,
  ChatEnrichmentRecord,
  ChatEnrichmentWrite,
} from "../types.js";

export interface ChatActionItemsEnrichmentOptions {
  readonly store: ChatEnrichmentProjectionStore;
  readonly ai: AICapability;
}

export interface ChatEnrichmentRegistrationOptions {
  readonly store: ChatEnrichmentProjectionStore;
  readonly ai?: AICapability | undefined;
  readonly actionItems?: boolean | undefined;
}

export function registerChatEnrichments(
  worker: EnrichmentWorker,
  options: ChatEnrichmentRegistrationOptions,
): void {
  if (options.actionItems === true) {
    if (options.ai === undefined) {
      throw new TypeError("chat.action-items enrichment requires an AI capability");
    }
    worker.register(createChatActionItemsEnrichmentHandler({ store: options.store, ai: options.ai }));
  }
}

export function createChatActionItemsEnrichmentHandler(
  options: ChatActionItemsEnrichmentOptions,
): EnrichmentHandler<ChatActivityPayload> {
  return {
    id: "chat.action-items",
    feature: "chat.action-items",
    subjects: [
      "activity.chat.message.created",
      "activity.chat.message.updated",
      "com.helix.core.chat.message.created",
      "com.helix.core.chat.message.updated",
    ],
    async enrich(event) {
      const message = await messageForEnrichment(event, options.store);
      if (message === null) {
        return skipped("chat.action-items", event, "message not found");
      }
      if (message.deletedAt !== undefined) {
        return skipped("chat.action-items", event, "message deleted");
      }

      const classification = message.classification ?? "standard";
      const response = await options.ai.chat(
        {
          feature: "chat.action-items",
          classification,
          messages: [
            {
              role: "system",
              content:
                "Extract action items, owners, and due dates from this chat message. Return compact JSON and do not invent missing details.",
            },
            {
              role: "user",
              content: chatRecordText(message),
            },
          ],
        },
        {
          feature: "chat.action-items",
          classification,
        },
      );
      const data = parseJsonObject(response.message) ?? { text: response.message };
      await options.store.recordChatEnrichment?.({
        messageId: message.id,
        roomId: message.roomId,
        feature: "chat.action-items",
        data,
      });

      return {
        handlerId: "chat.action-items",
        feature: "chat.action-items",
        status: "applied",
        resourceType: "chat.message",
        resourceId: message.id,
        metadata: {
          data,
          providerId: response.providerId,
          model: response.model,
        },
      };
    },
  };
}

async function messageForEnrichment(
  event: EnrichmentEvent<ChatActivityPayload>,
  store: ChatEnrichmentProjectionStore,
): Promise<ChatEnrichmentRecord | null> {
  const messageId = event.payload.messageId ?? event.payload.id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return null;
  }
  return store.getChatEnrichmentRecord(messageId);
}

function skipped(feature: string, event: EnrichmentEvent<ChatActivityPayload>, reason: string) {
  return {
    handlerId: feature,
    feature,
    status: "skipped" as const,
    metadata: {
      subject: event.subject,
      reason,
    },
  };
}

function chatRecordText(message: ChatEnrichmentRecord): string {
  return [
    message.roomName === undefined ? `Room ID: ${message.roomId}` : `Room: ${message.roomName}`,
    `Author: ${participantText(message.author)}`,
    message.mentions === undefined || message.mentions.length === 0
      ? ""
      : `Mentions: ${message.mentions.map(participantText).join(", ")}`,
    `Message: ${message.body}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function participantText(participant: { readonly id: string; readonly displayName?: string; readonly email?: string }): string {
  return participant.displayName ?? participant.email ?? participant.id;
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
  } catch {
    return undefined;
  }
}

export type { ChatEnrichmentWrite };
