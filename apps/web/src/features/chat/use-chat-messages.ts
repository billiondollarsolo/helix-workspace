/* A conversation's messages: history pages, live socket messages and
   pending sends merged into presentation rows, thread replies kept out of
   the main log, and the room marked read as new messages are shown. */

import type { ChatRoomUnread, ChatUnreadListResult } from "@helix/contracts";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChatMessageRecord, ChatRoomRecord } from "./api";
import { chatMessageListInfiniteQueryOptions, chatQueryKeys } from "./queries";
import { firstUnreadMessageId } from "./timeline";
import type { ChatRealtimeState } from "./use-chat-realtime";
import { readCountFor, toMessageView, type ChatMessageView } from "./view-model";

/** Let the socket's read marker land before refreshing unread counts. */
const UNREAD_REFRESH_DELAY_MS = 1_500;

export function useChatMessages({
  room,
  realtime,
  nameForActor,
  unread,
}: {
  readonly room: ChatRoomRecord;
  readonly realtime: ChatRealtimeState;
  readonly nameForActor: (actorId: string | null) => string;
  readonly unread: ChatRoomUnread | undefined;
}) {
  const queryClient = useQueryClient();
  const selfActorId = realtime.selfActorId;
  const query = useInfiniteQuery(chatMessageListInfiniteQueryOptions(room.id));

  // Every record for the room, oldest first: history pages (newest-first
  // each), then live socket messages, without deleted ones.
  const records = useMemo<readonly ChatMessageRecord[]>(() => {
    const byId = new Map<string, ChatMessageRecord>();
    for (const page of [...(query.data?.pages ?? [])].reverse()) {
      for (const record of [...page].reverse()) byId.set(record.id, record);
    }
    for (const record of realtime.liveMessages) {
      if (record.roomId === room.id) byId.set(record.id, record);
    }
    return [...byId.values()]
      .filter((m) => m.deletedAt === null && !realtime.deletedMessageIds.has(m.id))
      .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  }, [query.data, realtime.liveMessages, realtime.deletedMessageIds, room.id]);

  const topLevel = useMemo(
    () => records.filter((record) => (record.parentMessageId ?? null) === null),
    [records],
  );

  const messages = useMemo<readonly ChatMessageView[]>(() => {
    const orderedIds = topLevel.map((record) => record.id);
    const confirmed = topLevel.map((record) =>
      toMessageView({
        record,
        selfActorId,
        nameForActor,
        readBy: readCountFor(record.id, orderedIds, realtime.receipts, selfActorId),
      }),
    );
    const pending = realtime.pendingMessages
      .filter((p) => p.roomId === room.id)
      .map((p) =>
        toMessageView({
          record: {
            id: `pending:${p.clientMessageId}`,
            orgId: room.orgId,
            roomId: p.roomId,
            actorId: selfActorId,
            body: p.body,
            bodyFormat: p.bodyFormat,
            metadata: {},
            attachmentObjectIds: p.attachmentObjectIds,
            attachments: p.attachments,
            sentAt: p.createdAt,
            editedAt: null,
            deletedAt: null,
            createdAt: p.createdAt,
            updatedAt: p.createdAt,
            clientMessageId: p.clientMessageId,
          },
          selfActorId,
          nameForActor,
          readBy: 0,
          pending: p.status === "pending",
          failed: p.status === "failed",
          clientMessageId: p.clientMessageId,
        }),
      );
    return [...confirmed, ...pending];
  }, [topLevel, selfActorId, nameForActor, realtime.receipts, realtime.pendingMessages, room]);

  // Where the "Unread" divider goes: fixed when the conversation opens, so
  // reading it does not move the divider out from under the reader.
  const readSnapshot = useRef<ChatRoomUnread | null>(null);
  if (readSnapshot.current === null && unread !== undefined) readSnapshot.current = unread;
  const snapshot = readSnapshot.current;
  const firstUnreadId = useMemo(
    () =>
      snapshot === null || snapshot.unreadCount === 0
        ? null
        : firstUnreadMessageId(messages, snapshot.lastReadAt),
    [messages, snapshot],
  );

  // A reply landed in a thread: refresh the parent's reply count and the thread.
  const seenReplies = useRef(new Set<string>());
  useEffect(() => {
    const fresh = realtime.liveMessages.filter(
      (m) => m.roomId === room.id && m.parentMessageId != null && !seenReplies.current.has(m.id),
    );
    if (fresh.length === 0) return;
    for (const reply of fresh) seenReplies.current.add(reply.id);
    void queryClient.invalidateQueries({ queryKey: chatQueryKeys.messagesInfinite(room.id) });
    for (const parentId of new Set(fresh.map((m) => m.parentMessageId ?? ""))) {
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.thread(room.id, parentId) });
    }
  }, [realtime.liveMessages, room.id, queryClient]);

  // Mark read once the socket is ready and whenever a newer message shows.
  const refreshUnread = useDebouncedCallback(
    () => void queryClient.invalidateQueries({ queryKey: chatQueryKeys.unread() }),
    { wait: UNREAD_REFRESH_DELAY_MS },
  );
  const newestId = records.at(-1)?.id;
  const markedRef = useRef<string | undefined>(undefined);
  const markRead = realtime.markRead;
  const open = realtime.connection === "open";
  useEffect(() => {
    if (!open || newestId === undefined || markedRef.current === newestId) return;
    markedRef.current = newestId;
    markRead(newestId);
    queryClient.setQueryData<ChatUnreadListResult>(chatQueryKeys.unread(), (current) =>
      current === undefined ? current : clearRoomUnread(current, room.id),
    );
    refreshUnread();
  }, [open, newestId, markRead, queryClient, refreshUnread, room.id]);

  const loadOlder = useCallback(() => void query.fetchNextPage(), [query]);

  return {
    query,
    messages,
    firstUnreadId,
    loadOlder,
    findMessage: (id: string) => messages.find((message) => message.id === id),
  };
}

function clearRoomUnread(current: ChatUnreadListResult, roomId: string): ChatUnreadListResult {
  const rooms = current.rooms.map((entry) =>
    entry.roomId === roomId ? { ...entry, unreadCount: 0, mentionCount: 0 } : entry,
  );
  return {
    rooms,
    totalUnread: rooms.reduce((total, entry) => total + entry.unreadCount, 0),
    totalMentions: rooms.reduce((total, entry) => total + entry.mentionCount, 0),
  };
}
