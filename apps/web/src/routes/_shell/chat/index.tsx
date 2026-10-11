import { createFileRoute } from "@tanstack/react-router";
import { ChatShell } from "@/features/chat/chat-shell";
import {
  chatDirectMessageHandoffFromSearch,
  type ChatDirectMessageHandoff,
} from "@/features/people/handoff";
import { optionalEnumSearchParam, optionalUuidSearchParam } from "@/lib/search-params";

export interface ShellChatRouteSearch extends ChatDirectMessageHandoff {
  /** The open conversation. */
  readonly room?: string;
  /** The open thread's parent message. */
  readonly thread?: string;
  /** A message to scroll to and highlight (copied message links). */
  readonly message?: string;
  /** The Mentions feed; Home when absent. */
  readonly view?: "mentions";
}

export const Route = createFileRoute("/_shell/chat/")({
  component: ChatShell,
  validateSearch: (search): ShellChatRouteSearch => {
    const room = optionalUuidSearchParam(search.room);
    const thread = optionalUuidSearchParam(search.thread);
    const message = optionalUuidSearchParam(search.message);
    const view = optionalEnumSearchParam(search.view, ["mentions"] as const);
    return {
      ...(room === undefined ? {} : { room }),
      ...(thread === undefined ? {} : { thread }),
      ...(message === undefined ? {} : { message }),
      ...(view === undefined ? {} : { view }),
      ...chatDirectMessageHandoffFromSearch(search),
    };
  },
});
