import { queryOptions } from "@tanstack/react-query";
import { listChatMessages, listChatRooms, searchChat } from "./api";

export interface ChatSearchQueryInput {
  readonly query?: string;
  readonly roomId?: string;
  readonly limit?: number;
}

export const defaultChatSearchInput = {
  query: "",
  limit: 50,
} as const satisfies ChatSearchQueryInput;

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
  messages: (roomId: string | undefined, limit = 50) =>
    ["chat", "messages", roomId ?? "none", limit] as const,
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

export function chatMessageListQueryOptions(roomId: string | undefined, limit = 50) {
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
