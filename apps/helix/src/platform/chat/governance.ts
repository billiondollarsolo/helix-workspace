import type { JsonObject } from "@helix/sdk-types";
import type {
  ChatExternalAccess,
  ChatHistoryPolicy,
  ChatNotificationPolicy,
  ChatRoomKind,
  ChatRoomRole,
  ChatSpaceType,
} from "./types.js";

export interface ChatGovernance {
  readonly spaceType: ChatSpaceType;
  readonly historyPolicy: ChatHistoryPolicy;
  readonly retentionDays: number | null;
  readonly legalHold: boolean;
  readonly notificationPolicy: ChatNotificationPolicy;
  readonly externalAccess: ChatExternalAccess;
}

const defaultChatGovernance: ChatGovernance = {
  spaceType: "conversation",
  historyPolicy: "full",
  retentionDays: null,
  legalHold: false,
  notificationPolicy: "all",
  externalAccess: "guests",
};

export function chatGovernanceMetadata(
  kind: ChatRoomKind,
  input: Partial<ChatGovernance>,
): JsonObject {
  const settings = { ...defaultChatGovernance, ...input };
  return {
    spaceType: kind === "chat_dm" ? "direct" : settings.spaceType,
    historyPolicy: settings.historyPolicy,
    retentionDays: settings.retentionDays,
    legalHold: settings.legalHold,
    notificationPolicy: settings.notificationPolicy,
    externalAccess: settings.externalAccess,
  };
}

export function readChatGovernance(kind: ChatRoomKind, metadata: JsonObject): ChatGovernance {
  return {
    spaceType:
      kind === "chat_dm"
        ? "direct"
        : isOneOf(metadata.spaceType, ["conversation", "announcement", "project"])
          ? metadata.spaceType
          : "conversation",
    historyPolicy: isOneOf(metadata.historyPolicy, ["full", "since_join", "off"])
      ? metadata.historyPolicy
      : "full",
    retentionDays:
      typeof metadata.retentionDays === "number" &&
      Number.isInteger(metadata.retentionDays) &&
      metadata.retentionDays >= 1 &&
      metadata.retentionDays <= 36_500
        ? metadata.retentionDays
        : null,
    legalHold: metadata.legalHold === true,
    notificationPolicy: isOneOf(metadata.notificationPolicy, ["all", "mentions", "none"])
      ? metadata.notificationPolicy
      : "all",
    externalAccess: isOneOf(metadata.externalAccess, ["internal", "guests", "federated"])
      ? metadata.externalAccess
      : "guests",
  };
}

export function canPostToChatSpace(spaceType: ChatSpaceType, role: ChatRoomRole): boolean {
  return spaceType !== "announcement" || role === "owner" || role === "moderator";
}

export function canInviteChatGuest(
  externalAccess: ChatExternalAccess,
  guestType: "member" | "external" | "partner",
): boolean {
  return (
    guestType === "member" ||
    (guestType === "external" && externalAccess !== "internal") ||
    (guestType === "partner" && externalAccess === "federated")
  );
}

export function shouldNotifyChatMember(
  policy: ChatNotificationPolicy,
  recipientActorId: string,
  senderActorId: string,
  mentions: readonly string[],
): boolean {
  return (
    recipientActorId !== senderActorId &&
    policy !== "none" &&
    (policy === "all" ||
      mentions.includes(recipientActorId) ||
      mentions.includes("@here") ||
      mentions.includes("@channel"))
  );
}

export function chatMessageIsInRetention(
  governance: Pick<ChatGovernance, "retentionDays" | "legalHold">,
  sentAt: Date,
  now: Date,
): boolean {
  return (
    governance.legalHold ||
    governance.retentionDays === null ||
    sentAt.getTime() >= now.getTime() - governance.retentionDays * 86_400_000
  );
}

function isOneOf<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
): value is Value {
  return typeof value === "string" && choices.includes(value as Value);
}
