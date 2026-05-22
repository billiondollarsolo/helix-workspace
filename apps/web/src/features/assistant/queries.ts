/* TanStack Query options for the Assistant thread list.

   The 240px thread list (Pinned + Recent sections, "Search chats" input) is
   driven by the real `assistant.conversations.list` tool. Chat itself keeps
   streaming through `streamAssistantChat`; only the conversation list uses
   TanStack Query here. */

import { queryOptions } from "@tanstack/react-query";
import {
  listAssistantConversations,
  type AssistantConversationListInput,
  type AssistantConversationListPage,
} from "./api";

/** Root key for every Assistant query cache entry. */
export const ASSISTANT_QUERY_ROOT = "assistant" as const;

/** Stable query key for a conversation-list request. */
export function assistantConversationsKey(input: AssistantConversationListInput) {
  return [
    ASSISTANT_QUERY_ROOT,
    "conversations",
    {
      query: input.query?.trim() ?? "",
      pinnedOnly: input.pinnedOnly ?? false,
      limit: input.limit ?? 50,
      cursor: input.cursor ?? null,
    },
  ] as const;
}

/** Query options for the Assistant thread list. */
export function assistantConversationsQueryOptions(input: AssistantConversationListInput = {}) {
  return queryOptions<AssistantConversationListPage>({
    queryKey: assistantConversationsKey(input),
    queryFn: () => listAssistantConversations(input),
    staleTime: 15_000,
  });
}
