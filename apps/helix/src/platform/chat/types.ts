import type { AIClassification, JsonObject } from "@helix/sdk-types";
import type { ChatBodyFormat } from "@helix/contracts";

export const chatPluginId = "com.helix.core.chat";

export type ChatRoomKind = "chat_room" | "chat_dm";
export type ChatPresenceStatus = "available" | "away" | "busy" | "offline";
export type ChatReactionOperation = "add" | "remove";

export type ChatParticipant = JsonObject & {
  readonly id: string;
  readonly displayName?: string;
  readonly email?: string;
};

export interface ChatRoomSettingsRecord {
  readonly threadId: string;
  readonly orgId: string;
  readonly name: string | null;
  readonly topic: string | null;
  readonly isPrivate: boolean;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ChatRoomMemberRecord {
  readonly actorId: string;
  readonly role: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

export interface ChatRoomRecord {
  readonly id: string;
  readonly orgId: string;
  readonly kind: ChatRoomKind;
  readonly subject: string | null;
  readonly createdByActorId: string | null;
  readonly metadata: JsonObject;
  readonly members: readonly ChatRoomMemberRecord[];
  readonly settings: ChatRoomSettingsRecord | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ChatMessageRecord {
  readonly id: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly actorId: string | null;
  readonly body: string;
  readonly bodyFormat: ChatBodyFormat;
  readonly renderedBodyHtml?: string;
  readonly metadata: JsonObject;
  readonly attachmentObjectIds: readonly string[];
  readonly parentMessageId?: string | null;
  readonly clientMessageId?: string | undefined;
  readonly sentAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ChatPinRecord {
  readonly roomId: string;
  readonly messageId: string;
  readonly orgId: string;
  readonly pinnedByActorId: string | null;
  readonly createdAt: Date;
}

export interface ChatReactionRecord {
  readonly messageId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly emoji: string;
  readonly createdAt: Date;
}

export interface ChatReadReceiptRecord {
  readonly roomId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly lastReadMessageId: string | null;
  readonly lastReadAt: Date;
  readonly updatedAt: Date;
}

export interface ChatRetentionPolicyRecord {
  readonly orgId: string;
  readonly roomId: string | null;
  readonly retentionDays: number;
  readonly editWindowSeconds: number;
  readonly deleteWindowSeconds: number;
  readonly legalHold: boolean;
  readonly updatedAt: Date;
}

/** Effective policy returned by get — platform defaults when no row exists. */
export interface ChatRetentionPolicyView {
  readonly orgId: string;
  readonly roomId: string | null;
  readonly retentionDays: number;
  readonly editWindowSeconds: number;
  readonly deleteWindowSeconds: number;
  readonly legalHold: boolean;
  /** Null when the organization has not configured a policy row. */
  readonly updatedAt: Date | null;
  readonly configured: boolean;
}

export interface ChatExportMessageRecord {
  readonly id: string;
  readonly roomId: string;
  readonly actorId: string | null;
  readonly body: string | null;
  readonly bodyFormat: "plain" | "markdown";
  readonly sentAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface ChatOrganizationExportRecord {
  readonly exportId: string;
  readonly orgId: string;
  readonly generatedAt: Date;
  readonly messages: readonly ChatExportMessageRecord[];
  readonly truncated: boolean;
}

export interface ChatSearchRequest {
  readonly orgId: string;
  readonly actorId: string;
  readonly query?: string | undefined;
  readonly roomId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ChatSearchHit {
  readonly roomId: string;
  readonly messageId: string;
  readonly actorId: string | null;
  readonly subject: string;
  readonly preview: string;
  readonly sentAt: Date;
}

export type ChatSearchReactionRecord = JsonObject & {
  readonly emoji: string;
  readonly actorId: string;
  readonly createdAt?: string;
};

export interface ChatSearchRecord {
  readonly id: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly roomName?: string | undefined;
  readonly roomKind?: ChatRoomKind | undefined;
  readonly body: string;
  readonly author: ChatParticipant;
  readonly mentions?: readonly ChatParticipant[] | undefined;
  readonly reactions?: readonly ChatSearchReactionRecord[] | undefined;
  readonly classification?: AIClassification | undefined;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly editedAt?: string | undefined;
  readonly deletedAt?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface ChatSearchProjectionStore {
  getChatSearchRecord(messageId: string): Promise<ChatSearchRecord | null>;
}

export type ChatEnrichmentRecord = ChatSearchRecord;

export interface ChatEnrichmentProjectionStore {
  getChatEnrichmentRecord(messageId: string): Promise<ChatEnrichmentRecord | null>;
  recordChatEnrichment?(input: ChatEnrichmentWrite): Promise<void>;
}

export interface ChatEnrichmentWrite {
  readonly messageId: string;
  readonly roomId: string;
  readonly feature: string;
  readonly data: JsonObject;
}

export type ChatActivityPayload = JsonObject;
