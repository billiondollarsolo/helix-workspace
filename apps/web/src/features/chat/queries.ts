import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  discoverChatRooms,
  listChatMentions,
  listChatMessages,
  listChatPins,
  listChatRooms,
  listChatUnread,
  listThreadReplies,
  searchChat,
} from "./api";

export const CHAT_MESSAGE_PAGE_SIZE = 50;
/** Unread counts for rooms the socket is not subscribed to refresh on this cadence. */
const CHAT_UNREAD_REFRESH_MS = 30_000;

export const chatQueryKeys = {
  rooms: () => ["chat", "rooms"] as const,
  unread: () => ["chat", "unread"] as const,
  mentions: () => ["chat", "mentions"] as const,
  discover: (query: string) => ["chat", "discover", query] as const,
  search: (query: string, roomId: string | undefined) =>
    ["chat", "search", query, roomId ?? "all"] as const,
  messagesInfinite: (roomId: string | undefined) =>
    ["chat", "messages", "infinite", roomId ?? "none"] as const,
  thread: (roomId: string | undefined, parentMessageId: string | null) =>
    ["chat", "thread", roomId ?? "none", parentMessageId ?? "none"] as const,
  pins: (roomId: string | undefined) => ["chat", "pins", roomId ?? "none"] as const,
};

export function chatRoomListQueryOptions() {
  return queryOptions({
    queryKey: chatQueryKeys.rooms(),
    queryFn: () => listChatRooms({ limit: 100 }),
    throwOnError: false,
  });
}

export function chatUnreadQueryOptions() {
  return queryOptions({
    queryKey: chatQueryKeys.unread(),
    queryFn: () => listChatUnread(),
    refetchInterval: CHAT_UNREAD_REFRESH_MS,
    throwOnError: false,
  });
}

export function chatMentionsQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: chatQueryKeys.mentions(),
    queryFn: () => listChatMentions({ limit: 50 }),
    enabled,
    throwOnError: false,
  });
}

export function chatDiscoverQueryOptions(query: string) {
  return queryOptions({
    queryKey: chatQueryKeys.discover(query),
    queryFn: () => discoverChatRooms({ query }),
    throwOnError: false,
  });
}

export function chatSearchQueryOptions(query: string, roomId: string | undefined) {
  return queryOptions({
    queryKey: chatQueryKeys.search(query, roomId),
    queryFn: () => searchChat({ query, ...(roomId === undefined ? {} : { roomId }), limit: 50 }),
    enabled: query.trim().length > 0,
    throwOnError: false,
  });
}

/**
 * Infinite history: pages are newest-first from the API; the composite cursor
 * keeps equal-timestamp messages stable. Stop when a page has fewer than `limit` rows.
 */
export function chatMessageListInfiniteQueryOptions(roomId: string | undefined) {
  return infiniteQueryOptions({
    queryKey: chatQueryKeys.messagesInfinite(roomId),
    queryFn: ({ pageParam }) => {
      if (roomId === undefined) {
        return Promise.resolve([]);
      }
      return listChatMessages({
        roomId,
        limit: CHAT_MESSAGE_PAGE_SIZE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      });
    },
    initialPageParam: undefined as { readonly sentAt: string; readonly id: string } | undefined,
    getNextPageParam: (lastPage) => {
      if (lastPage.length < CHAT_MESSAGE_PAGE_SIZE) {
        return undefined;
      }
      const oldest = lastPage[lastPage.length - 1];
      return oldest === undefined ? undefined : { sentAt: oldest.sentAt, id: oldest.id };
    },
    enabled: roomId !== undefined,
    throwOnError: false,
  });
}

export function chatThreadQueryOptions(roomId: string | undefined, parentMessageId: string | null) {
  return queryOptions({
    queryKey: chatQueryKeys.thread(roomId, parentMessageId),
    queryFn: async () => {
      if (roomId === undefined || parentMessageId === null) return [];
      const replies = await listThreadReplies({ roomId, parentMessageId });
      return [...replies].reverse();
    },
    enabled: roomId !== undefined && parentMessageId !== null,
    throwOnError: false,
  });
}

export function chatPinsQueryOptions(roomId: string | undefined) {
  return queryOptions({
    queryKey: chatQueryKeys.pins(roomId),
    queryFn: () => {
      if (roomId === undefined) {
        return Promise.resolve([]);
      }
      return listChatPins({ roomId });
    },
    enabled: roomId !== undefined,
    throwOnError: false,
  });
}
