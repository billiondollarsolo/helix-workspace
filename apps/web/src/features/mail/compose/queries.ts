import { queryOptions } from "@tanstack/react-query";
import { getMailDraft } from "../api";

/** One saved draft, read fresh each time a compose window resumes it. */
export function mailDraftQueryOptions(draftId: string) {
  return queryOptions({
    queryKey: ["mail", "draft", draftId] as const,
    queryFn: () => getMailDraft(draftId),
    staleTime: 0,
    gcTime: 0,
    throwOnError: false,
  });
}
