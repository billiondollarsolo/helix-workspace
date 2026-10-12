import { createFileRoute } from "@tanstack/react-router";
import { AssistantRoute } from "@/features/assistant/assistant-route";
import { optionalStringSearchParam, optionalUuidSearchParam } from "@/lib/search-params";

export interface ShellAssistantRouteSearch {
  /** Backend conversation id to open. */
  readonly conversation?: string;
  /** A prompt to send as a new chat, e.g. from the side panel. */
  readonly prompt?: string;
}

export const Route = createFileRoute("/_shell/assistant/")({
  component: AssistantRoute,
  validateSearch: (search): ShellAssistantRouteSearch => {
    const conversation =
      optionalUuidSearchParam(search.conversation) ??
      optionalStringSearchParam(search.conversation);
    const prompt = optionalStringSearchParam(search.prompt)?.trim().slice(0, 4000);
    return {
      ...(conversation === undefined ? {} : { conversation }),
      ...(prompt === undefined || prompt.length === 0 ? {} : { prompt }),
    };
  },
});
