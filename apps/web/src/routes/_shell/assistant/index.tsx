import { createFileRoute } from "@tanstack/react-router";
import { AssistantSurface } from "@/features/assistant/assistant-surface";
import { optionalStringSearchParam, optionalUuidSearchParam } from "@/lib/search-params";

export interface ShellAssistantRouteSearch {
  /** Backend conversation id to open. */
  readonly conversation?: string;
}

export const Route = createFileRoute("/_shell/assistant/")({
  component: AssistantSurface,
  validateSearch: (search): ShellAssistantRouteSearch => {
    const conversation =
      optionalUuidSearchParam(search.conversation) ??
      optionalStringSearchParam(search.conversation);
    return conversation === undefined ? {} : { conversation };
  },
});
