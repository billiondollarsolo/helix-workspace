import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { listChatMessages, listChatPins, listChatRooms, searchChat } from "./api";

export interface ChatSearchQueryInput {
  readonly query?: string;
  readonly roomId?: string;
  readonly limit?: number;
}

export const defaultChatSearchInput = {
  query: "",
  limit: 50,
} as const satisfies ChatSearchQueryInput;

export const CHAT_MESSAGE_PAGE_SIZE = 50;

export function isBackendChatRoomId(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export const chatQueryKeys = {
  search: (input: ChatSearchQueryInput = defaultChatSearchInput) =>
    ["chat", "search", input.query ?? "", input.roomId ?? "all", input.limit ?? 50] as const,
  rooms: (input: Pick<ChatSearchQueryInput, "query" | "limit"> = defaultChatSearchInput) =>
    ["chat", "rooms", input.query ?? "", input.limit ?? 50] as const,
  messages: (roomId: string | undefined, limit = CHAT_MESSAGE_PAGE_SIZE) =>
    ["chat", "messages", roomId ?? "none", limit] as const,
  messagesInfinite: (roomId: string | undefined) =>
    ["chat", "messages", "infinite", roomId ?? "none"] as const,
  pins: (roomId: string | undefined) => ["chat", "pins", roomId ?? "none"] as const,
};

export function chatSearchQueryOptions(input: ChatSearchQueryInput = defaultChatSearchInput) {
  return queryOptions({
    queryKey: chatQueryKeys.search(input),
    queryFn: () => searchChat(input),
    throwOnError: false,
  });
}

export function chatRoomListQueryOptions(
  input: Pick<ChatSearchQueryInput, "query" | "limit"> = defaultChatSearchInput,
) {
  return queryOptions({
    queryKey: chatQueryKeys.rooms(input),
    queryFn: () => listChatRooms(input),
    throwOnError: false,
  });
}

export function chatMessageListQueryOptions(roomId: string | undefined, limit = CHAT_MESSAGE_PAGE_SIZE) {
  return queryOptions({
    queryKey: chatQueryKeys.messages(roomId, limit),
    queryFn: () => {
      if (roomId === undefined) {
        return Promise.resolve([]);
      }
      return listChatMessages({ roomId, limit });
    },
    enabled: roomId !== undefined,
    throwOnError: false,
  });
}

/**
 * Infinite history: pages are newest-first from the API; `before` is the oldest
 * loaded message's `sentAt`. Stop when a page returns fewer than `limit` rows.
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
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => {
      if (lastPage.length < CHAT_MESSAGE_PAGE_SIZE) {
        return undefined;
      }
      const oldest = lastPage[lastPage.length - 1];
      return oldest?.sentAt;
    },
    enabled: roomId !== undefined,
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
