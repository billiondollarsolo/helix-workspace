import type { JsonObject } from "@helix/sdk-types";
import type { IndexDocument, SearchEventIndexer, SearchIndexer, SearchIndexerEvent } from "../../search/index.js";
import type {
  ChatActivityPayload,
  ChatParticipant,
  ChatSearchProjectionStore,
  ChatSearchReactionRecord,
  ChatSearchRecord,
} from "../types.js";

export const chatSearchIndexerId = "chat";
export const chatSearchSubjects = ["activity.chat.>", "com.helix.core.chat.>"] as const;

export function createChatSearchIndexer(store: ChatSearchProjectionStore): SearchIndexer<ChatActivityPayload> {
  return {
    id: chatSearchIndexerId,
    subjects: chatSearchSubjects,
    async route(event) {
      const messageId = chatMessageIdFromEvent(event);
      if (messageId === undefined) {
        return undefined;
      }

      if (isDeleteSubject(event.subject)) {
        return { delete: [chatDocumentId(messageId)] };
      }

      const record = await store.getChatSearchRecord(messageId);
      if (record === null || record.deletedAt !== undefined) {
        return { delete: [chatDocumentId(messageId)] };
      }

      return { upsert: [chatRecordToIndexDocument(record)] };
    },
  };
}

export function registerChatIndexer(indexer: SearchEventIndexer, store: ChatSearchProjectionStore): void {
  indexer.register(createChatSearchIndexer(store));
}

export function chatRecordToIndexDocument(record: ChatSearchRecord): IndexDocument {
  const mentions = record.mentions ?? [];
  const reactions = record.reactions ?? [];
  const title = record.roomName ?? `Chat ${record.roomId}`;
  const body = [
    title,
    participantSearchText(record.author),
    mentions.map(participantSearchText).join(", "),
    reactions.map(reactionSearchText).join(", "),
    record.body,
  ]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    id: chatDocumentId(record.id),
    type: "chat",
    title,
    body,
    url: `/chat/${record.roomId}?message=${record.id}`,
    attributes: compactJsonObject({
      orgId: record.orgId,
      roomId: record.roomId,
      roomName: record.roomName,
      roomKind: record.roomKind,
      messageId: record.id,
      authorId: record.author.id,
      authorName: record.author.displayName,
      authorEmail: record.author.email,
      mentions: mentions.map((mention) => mention.id),
      reactions: reactions.map((reaction) => reaction.emoji),
      classification: record.classification,
      createdAt: record.createdAt,
      editedAt: record.editedAt,
      metadata: record.metadata,
    }),
    updatedAt: record.updatedAt ?? record.editedAt ?? record.createdAt,
  };
}

export function chatDocumentId(messageId: string): string {
  return `chat:${messageId}`;
}

function chatMessageIdFromEvent(event: SearchIndexerEvent<ChatActivityPayload>): string | undefined {
  const id = event.payload.messageId ?? event.payload.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function isDeleteSubject(subject: string): boolean {
  return subject.endsWith(".deleted") || subject.endsWith(".delete");
}

function participantSearchText(participant: ChatParticipant): string {
  const name = participant.displayName;
  const email = participant.email;
  if (name !== undefined && email !== undefined) {
    return `${name} <${email}>`;
  }
  return name ?? email ?? participant.id;
}

function reactionSearchText(reaction: ChatSearchReactionRecord): string {
  return `${reaction.emoji} ${reaction.actorId}`;
}

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  const output: Record<string, JsonObject[keyof JsonObject]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value as JsonObject[keyof JsonObject];
    }
  }
  return output;
}
