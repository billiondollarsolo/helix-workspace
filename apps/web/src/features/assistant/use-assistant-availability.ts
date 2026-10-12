/* Whether Helix AI has a working model provider. Every Assistant entry point
 * (side rail, launcher, bottom bar, command palette) hides while it is
 * unavailable, and `/assistant` shows `message` instead of the composer. A
 * failed status read (the app is not served, or the person lacks access)
 * counts as unavailable. */

import { useQuery } from "@tanstack/react-query";
import { assistantStatusQueryOptions } from "./queries";

export interface AssistantAvailability {
  readonly isLoading: boolean;
  readonly available: boolean;
  readonly message: string | null;
}

export function useAssistantAvailability(): AssistantAvailability {
  const query = useQuery(assistantStatusQueryOptions());
  return {
    isLoading: query.isLoading,
    available: query.data?.available === true,
    message: query.data?.message ?? null,
  };
}
