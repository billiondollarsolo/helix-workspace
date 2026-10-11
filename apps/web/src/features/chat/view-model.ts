/* Chat view model — adapts the backend room/message shapes (`api.ts`) onto
   the presentation shapes the Chat surface renders. Rooms are UUID-keyed
   `ChatRoomRecord`s; messages are flat `ChatMessageRecord`s. Unread counts,
   presence and read receipts are layered on from `chat.unread.list` and the
   realtime socket. */

import type { ChatRoomUnread } from "@helix/contracts";
import type {
  ChatAttachmentRecord,
  ChatMessageRecord,
  ChatPresenceEntry,
  ChatReactionRecord,
  ChatReadReceiptRecord,
  ChatRoomMemberRecord,
  ChatRoomRecord,
} from "./api";

/** A reaction pill — emoji glyph plus a running count and whether *you* reacted. */
export interface ChatReactionView {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

/** One conversation in the sidebar, Home feed and pickers. */
export interface ChatConversationView {
  readonly id: string;
  /** `dm` covers one-to-one and group conversations; `space` is a named room. */
  readonly kind: "dm" | "space";
  readonly name: string;
  readonly memberCount: number;
  readonly unread: number;
  readonly mentions: number;
  readonly lastMessageAt: string | null;
  /** A one-to-one conversation's other person; null for spaces and groups. */
  readonly peer: ChatRoomMemberRecord | null;
  readonly active: boolean;
}

/** A presentation-ready message row. */
export interface ChatMessageView {
  readonly id: string;
  readonly actorId: string | null;
  readonly authorName: string;
  readonly sentAt: string;
  readonly time: string;
  readonly body: string;
  readonly bodyFormat: string;
  readonly attachmentObjectIds: readonly string[];
  readonly attachments: readonly ChatAttachmentRecord[];
  readonly renderedBodyHtml?: string;
  readonly isMine: boolean;
  readonly editedAt: string | null;
  readonly reactions: readonly ChatReactionView[];
  readonly replyCount: number;
  readonly lastReplyAt: string | null;
  readonly pinned: boolean;
  readonly readBy: number;
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly clientMessageId?: string;
}

/** Boundary marker: "seen by …" after a message id. */
export interface ChatSeenMarker {
  readonly afterMessageId: string;
  readonly actorIds: readonly string[];
}

/** A member row for the details panel and @mention suggestions. */
export interface ChatMemberView {
  readonly actorId: string;
  readonly name: string;
  readonly email: string | null;
  readonly role: "owner" | "moderator" | "member";
}

/** Per-room "about" metadata for the details panel. */
export interface ChatAboutView {
  readonly description: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly memberCount: number;
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatChatTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : TIME_FORMAT.format(parsed);
}

function formatChatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : DATE_FORMAT.format(parsed);
}

/** "12:40 PM" today, "Mon" this week, "Mar 3" this year, else "Mar 3, 2025". */
export function formatChatWhen(iso: string, now: Date = new Date()): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  if (parsed.toDateString() === now.toDateString()) return TIME_FORMAT.format(parsed);
  const ageDays = (now.getTime() - parsed.getTime()) / 86_400_000;
  if (ageDays >= 0 && ageDays < 6) {
    return parsed.toLocaleDateString(undefined, { weekday: "short" });
  }
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(parsed.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A conversation's title: DMs name the other people, spaces use their name. */
function roomDisplayName(room: ChatRoomRecord, selfActorId: string | null): string {
  const others = (room.members ?? []).filter((m) => m.actorId !== selfActorId);
  if (room.kind === "chat_dm") {
    return others.length > 0 ? joinNames(others.map(memberDisplayName)) : "Direct message";
  }
  const named = room.settings?.name ?? room.subject;
  if (named !== null && named !== undefined && named.trim().length > 0) {
    return named;
  }
  return others.length > 0 ? joinNames(others.map(memberDisplayName)) : "Untitled space";
}

function joinNames(names: readonly string[]): string {
  return new Intl.ListFormat(undefined, { style: "long", type: "conjunction" }).format(names);
}

export function memberDisplayName(member: ChatRoomMemberRecord): string {
  if (member.displayName !== null && member.displayName.trim().length > 0) {
    return member.displayName;
  }
  if (member.email !== null && member.email.trim().length > 0) {
    return member.email;
  }
  return "Unknown person";
}

/**
 * Sidebar rows for every room, with unread and mention counts from
 * `chat.unread.list`. The order follows the server's most-recent-first list.
 */
export function conversationViews(
  rooms: readonly ChatRoomRecord[],
  selfActorId: string | null,
  unread: readonly ChatRoomUnread[],
  presenceByActor: ReadonlyMap<string, boolean>,
): readonly ChatConversationView[] {
  const unreadById = new Map(unread.map((entry) => [entry.roomId, entry]));
  return rooms.map((room) => {
    const others = (room.members ?? []).filter((m) => m.actorId !== selfActorId);
    const peer = room.kind === "chat_dm" && others.length === 1 ? (others[0] ?? null) : null;
    const counts = unreadById.get(room.id);
    return {
      id: room.id,
      kind: room.kind === "chat_dm" ? "dm" : "space",
      name: roomDisplayName(room, selfActorId),
      memberCount: room.members?.length ?? 0,
      unread: counts?.unreadCount ?? 0,
      mentions: counts?.mentionCount ?? 0,
      lastMessageAt: counts?.lastMessageAt ?? null,
      peer,
      active: peer !== null && presenceByActor.get(peer.actorId) === true,
    };
  });
}

/** Home feed order: unread conversations first, then most recently active. */
export function homeFeed(
  conversations: readonly ChatConversationView[],
): readonly ChatConversationView[] {
  const recency = (view: ChatConversationView) =>
    view.lastMessageAt === null ? 0 : Date.parse(view.lastMessageAt);
  return [...conversations].sort(
    (a, b) => Number(b.unread > 0) - Number(a.unread > 0) || recency(b) - recency(a),
  );
}

/** Build the details panel "about" model from a room record. */
export function roomAbout(room: ChatRoomRecord): ChatAboutView {
  const creator = (room.members ?? []).find((m) => m.actorId === room.createdByActorId);
  const topic = room.settings?.topic ?? null;
  return {
    description:
      topic !== null && topic.trim().length > 0
        ? topic
        : room.kind === "chat_dm"
          ? "Direct message conversation."
          : "No description yet.",
    createdBy: creator !== undefined ? memberDisplayName(creator) : "",
    createdAt: formatChatDate(room.createdAt),
    memberCount: room.members?.length ?? 0,
  };
}

/** Members of a room for the details panel and @mention suggestions. */
export function roomMembers(room: ChatRoomRecord | undefined): readonly ChatMemberView[] {
  return (room?.members ?? []).map((m) => ({
    actorId: m.actorId,
    name: memberDisplayName(m),
    email: m.email,
    role: m.role,
  }));
}

/** Adapt a backend message and its shared projection to a presentation row. */
export function toMessageView(input: {
  readonly record: ChatMessageRecord;
  readonly selfActorId: string | null;
  readonly nameForActor: (actorId: string | null) => string;
  readonly readBy: number;
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly clientMessageId?: string;
}): ChatMessageView {
  const { record, selfActorId, nameForActor, readBy } = input;
  return {
    id: record.id,
    actorId: record.actorId,
    authorName: nameForActor(record.actorId),
    sentAt: record.sentAt,
    time: formatChatTime(record.sentAt),
    body: record.body,
    bodyFormat: record.bodyFormat,
    attachmentObjectIds: record.attachmentObjectIds,
    attachments: record.attachments ?? [],
    ...(record.renderedBodyHtml === undefined ? {} : { renderedBodyHtml: record.renderedBodyHtml }),
    isMine: record.actorId !== null && record.actorId === selfActorId,
    editedAt: record.editedAt,
    reactions: reactionViews(record.reactions ?? [], selfActorId),
    replyCount: record.replyCount ?? 0,
    lastReplyAt: record.lastReplyAt ?? null,
    pinned: record.pin !== null && record.pin !== undefined,
    readBy,
    ...(input.pending === undefined ? {} : { pending: input.pending }),
    ...(input.failed === undefined ? {} : { failed: input.failed }),
    ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
  };
}

export function reactionViews(
  reactions: readonly ChatReactionRecord[],
  selfActorId: string | null,
): readonly ChatReactionView[] {
  const grouped = new Map<string, ChatReactionView>();
  for (const reaction of reactions) {
    const current = grouped.get(reaction.emoji);
    grouped.set(reaction.emoji, {
      emoji: reaction.emoji,
      count: (current?.count ?? 0) + 1,
      mine: current?.mine === true || reaction.actorId === selfActorId,
    });
  }
  return [...grouped.values()];
}

/**
 * For each message, list other actors whose last-read marker is at-or-after it.
 * Self receipts are excluded (never "seen by me").
 */
export function seenByForMessage(
  messageId: string,
  orderedIds: readonly string[],
  receipts: readonly ChatReadReceiptRecord[],
  selfActorId: string | null,
): readonly string[] {
  const messageIndex = orderedIds.indexOf(messageId);
  if (messageIndex < 0) {
    return [];
  }
  const seen: string[] = [];
  for (const receipt of receipts) {
    if (receipt.actorId === selfActorId || receipt.lastReadMessageId === null) {
      continue;
    }
    const receiptIndex = orderedIds.indexOf(receipt.lastReadMessageId);
    if (receiptIndex >= messageIndex) {
      seen.push(receipt.actorId);
    }
  }
  return seen;
}

/**
 * Collapse read receipts into markers placed after the farthest message each
 * non-self actor has read. Multiple actors on the same message share a marker.
 */
export function seenMarkers(
  orderedIds: readonly string[],
  receipts: readonly ChatReadReceiptRecord[],
  selfActorId: string | null,
): readonly ChatSeenMarker[] {
  const byMessage = new Map<string, string[]>();
  for (const receipt of receipts) {
    if (receipt.actorId === selfActorId || receipt.lastReadMessageId === null) {
      continue;
    }
    if (!orderedIds.includes(receipt.lastReadMessageId)) {
      continue;
    }
    const list = byMessage.get(receipt.lastReadMessageId) ?? [];
    list.push(receipt.actorId);
    byMessage.set(receipt.lastReadMessageId, list);
  }
  return [...byMessage.entries()].map(([afterMessageId, actorIds]) => ({
    afterMessageId,
    actorIds,
  }));
}

/**
 * Count how many *other* members have a read receipt at-or-after a given
 * message. Receipts only carry the last-read message id, so this is a
 * coarse "seen" indicator keyed by message order.
 */
export function readCountFor(
  messageId: string,
  orderedIds: readonly string[],
  receipts: readonly ChatReadReceiptRecord[],
  selfActorId: string | null,
): number {
  return seenByForMessage(messageId, orderedIds, receipts, selfActorId).length;
}

/** Map a presence roster to a `actorId -> online` lookup. */
export function presenceMap(entries: readonly ChatPresenceEntry[]): ReadonlyMap<string, boolean> {
  const map = new Map<string, boolean>();
  for (const entry of entries) {
    map.set(entry.actorId, true);
  }
  return map;
}
