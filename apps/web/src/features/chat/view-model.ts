/* Chat view model — adapts the backend room/message shapes (`api.ts`) onto
   the view shapes the handoff UI (`chat-shell.tsx`) expects. The handoff was
   hand-authored against a different shape; rather than force seed shapes onto
   the backend, we derive a presentation model here.

   Backend rooms are UUID-keyed `ChatRoomRecord`s; messages are flat
   `ChatMessageRecord`s with `actorId`/`body`/`sentAt`. Threading, reactions,
   and presence are layered on from realtime events and local interaction. */

import type {
  ChatMessageRecord,
  ChatPresenceEntry,
  ChatReadReceiptRecord,
  ChatRoomMemberRecord,
  ChatRoomRecord,
} from "./api";

/** Presence state for a sidebar entry — derived from the realtime roster. */
export type ChatPresenceState = "active" | "offline";

/** A reaction pill — emoji glyph plus a running count and whether *you* reacted. */
export interface ChatReactionView {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

/** A space (channel) row in the Spaces sidebar. */
export interface ChatSpaceView {
  readonly id: string;
  readonly name: string;
  readonly kind: "chat_room" | "chat_dm";
  readonly memberCount: number;
  readonly unread: number;
}

/** A direct-message peer row in the Direct messages sidebar. */
export interface ChatDirectView {
  readonly id: string;
  readonly name: string;
  readonly presence: ChatPresenceState;
  readonly unread: number;
}

/** A presentation-ready message row. */
export interface ChatMessageView {
  readonly id: string;
  readonly actorId: string | null;
  readonly authorName: string;
  readonly time: string;
  readonly body: string;
  readonly bodyFormat: "plain" | "markdown";
  readonly renderedBodyHtml?: string;
  readonly isMine: boolean;
  readonly editedAt: string | null;
  readonly reactions: readonly ChatReactionView[];
  readonly readBy: number;
  /** Actor ids (others) who have read through this message. */
  readonly seenByActorIds: readonly string[];
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly clientMessageId?: string;
}

/** Boundary marker: "seen by …" after a message id. */
export interface ChatSeenMarker {
  readonly afterMessageId: string;
  readonly actorIds: readonly string[];
}

/** A member row for the info panel's Members tab. */
export interface ChatMemberView {
  readonly actorId: string;
  readonly name: string;
  readonly role: string;
}

/** Per-room "about" metadata for the info panel's About tab. */
export interface ChatAboutView {
  readonly description: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly memberCount: number;
}

const ISO_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const ISO_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatChatTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : ISO_TIME.format(parsed);
}

export function formatChatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : ISO_DATE.format(parsed);
}

/** Resolve a room's display name — explicit subject/settings, else a member list. */
export function roomDisplayName(room: ChatRoomRecord, selfActorId: string | null): string {
  const named = room.settings?.name ?? room.subject;
  if (named !== null && named !== undefined && named.trim().length > 0) {
    return named;
  }
  const others = (room.members ?? []).filter((m) => m.actorId !== selfActorId);
  if (others.length > 0) {
    return others.map((m) => memberDisplayName(m)).join(", ");
  }
  return room.kind === "chat_dm" ? "Direct message" : "Untitled space";
}

export function memberDisplayName(member: ChatRoomMemberRecord): string {
  if (member.displayName !== null && member.displayName.trim().length > 0) {
    return member.displayName;
  }
  if (member.email !== null && member.email.trim().length > 0) {
    return member.email;
  }
  return shortActorId(member.actorId);
}

function shortActorId(actorId: string): string {
  return actorId.length > 8 ? `User ${actorId.slice(0, 6)}` : actorId;
}

/** Split rooms into channels and DMs for the two sidebar sections. */
export function partitionRooms(
  rooms: readonly ChatRoomRecord[],
  selfActorId: string | null,
  presenceByActor: ReadonlyMap<string, boolean>,
): { readonly spaces: readonly ChatSpaceView[]; readonly directs: readonly ChatDirectView[] } {
  const spaces: ChatSpaceView[] = [];
  const directs: ChatDirectView[] = [];

  for (const room of rooms) {
    const memberCount = room.members?.length ?? 0;
    if (room.kind === "chat_dm") {
      const peer = (room.members ?? []).find((m) => m.actorId !== selfActorId);
      directs.push({
        id: room.id,
        name: roomDisplayName(room, selfActorId),
        presence:
          peer !== undefined && presenceByActor.get(peer.actorId) === true ? "active" : "offline",
        unread: 0,
      });
    } else {
      spaces.push({
        id: room.id,
        name: roomDisplayName(room, selfActorId),
        kind: room.kind,
        memberCount,
        unread: 0,
      });
    }
  }

  return { spaces, directs };
}

/** Build the info panel "about" model from a room record. */
export function roomAbout(room: ChatRoomRecord | undefined): ChatAboutView {
  if (room === undefined) {
    return {
      description: "A Helix space.",
      createdBy: "Helix",
      createdAt: "",
      memberCount: 0,
    };
  }
  const creator = (room.members ?? []).find((m) => m.actorId === room.createdByActorId);
  return {
    description:
      room.settings?.topic ??
      (room.kind === "chat_dm" ? "Direct message conversation." : "A Helix chat space."),
    createdBy: creator !== undefined ? memberDisplayName(creator) : "Helix",
    createdAt: formatChatDate(room.createdAt),
    memberCount: room.members?.length ?? 0,
  };
}

/** Build the Members-tab rows from a room's member list. */
export function roomMembers(room: ChatRoomRecord | undefined): readonly ChatMemberView[] {
  return (room?.members ?? []).map((m) => ({
    actorId: m.actorId,
    name: memberDisplayName(m),
    role: m.role,
  }));
}

/**
 * Adapt a backend message record to a presentation row. `reactions` are layered
 * in by the caller (the list endpoint does not return them — see REPORT) and
 * `readBy` is derived from realtime read receipts.
 */
export function toMessageView(input: {
  readonly record: ChatMessageRecord;
  readonly selfActorId: string | null;
  readonly nameForActor: (actorId: string | null) => string;
  readonly reactions: readonly ChatReactionView[];
  readonly readBy: number;
  readonly seenByActorIds?: readonly string[];
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly clientMessageId?: string;
}): ChatMessageView {
  const { record, selfActorId, nameForActor, reactions, readBy } = input;
  return {
    id: record.id,
    actorId: record.actorId,
    authorName: nameForActor(record.actorId),
    time: formatChatTime(record.sentAt),
    body: record.body,
    bodyFormat: record.bodyFormat,
    ...(record.renderedBodyHtml === undefined ? {} : { renderedBodyHtml: record.renderedBodyHtml }),
    isMine: record.actorId !== null && record.actorId === selfActorId,
    editedAt: record.editedAt,
    reactions,
    readBy,
    seenByActorIds: input.seenByActorIds ?? [],
    ...(input.pending === undefined ? {} : { pending: input.pending }),
    ...(input.failed === undefined ? {} : { failed: input.failed }),
    ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
  };
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
  const messageIndex = orderedIds.indexOf(messageId);
  if (messageIndex < 0) {
    return 0;
  }
  let count = 0;
  for (const receipt of receipts) {
    if (receipt.actorId === selfActorId || receipt.lastReadMessageId === null) {
      continue;
    }
    const receiptIndex = orderedIds.indexOf(receipt.lastReadMessageId);
    if (receiptIndex >= messageIndex) {
      count += 1;
    }
  }
  return count;
}

/** Map a presence roster to a `actorId -> online` lookup. */
export function presenceMap(entries: readonly ChatPresenceEntry[]): ReadonlyMap<string, boolean> {
  const map = new Map<string, boolean>();
  for (const entry of entries) {
    map.set(entry.actorId, true);
  }
  return map;
}
