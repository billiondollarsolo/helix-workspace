import { createFileRoute } from "@tanstack/react-router";
import { ChatShell } from "@/features/chat/chat-shell";
import {
  optionalEnumSearchParam,
  optionalStringSearchParam,
  optionalUuidSearchParam,
} from "@/lib/search-params";

const chatInfoTabs = ["about", "members", "files", "pinned"] as const;

export interface ShellChatRouteSearch {
  readonly room?: string;
  readonly thread?: string;
  readonly tab?: (typeof chatInfoTabs)[number];
}

export const Route = createFileRoute("/_shell/chat/")({
  component: ChatShell,
  validateSearch: (search): ShellChatRouteSearch => {
    const room = optionalUuidSearchParam(search.room) ?? optionalStringSearchParam(search.room);
    const thread =
      optionalUuidSearchParam(search.thread) ?? optionalStringSearchParam(search.thread);
    const tab = optionalEnumSearchParam(search.tab, chatInfoTabs);
    return {
      ...(room === undefined ? {} : { room }),
      ...(thread === undefined ? {} : { thread }),
      ...(tab === undefined ? {} : { tab }),
    };
  },
});
